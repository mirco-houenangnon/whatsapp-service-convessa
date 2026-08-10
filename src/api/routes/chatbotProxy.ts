/**
 * chatbotProxy.ts — Route PUBLIQUE appelée par le frontend (widget de chat).
 *
 * CORRECTIF (santé) : la route /health ne fait plus qu'un ping léger vers
 * ia-service (/health), sans déclencher une génération complète du LLM.
 * L'ancienne version appelait /chat avec un vrai message "ping", ce qui
 * attend une réponse complète du modèle (10-60s sur CPU) — largement plus
 * long que le timeout de 4s côté widget, donc le bouton ne s'affichait jamais.
 *
 * Le service ia-service ne devient "healthy" côté FastAPI qu'une fois
 * l'indexation terminée (le lifespan startup bloque avant d'accepter des
 * requêtes) — /health suffit donc déjà comme signal de disponibilité réelle.
 *
 * CORRECTIF (sécurité) : POST / exige désormais un token Firebase valide
 * (requireFirebaseAuth), comme demandé — le chatbot reste réservé aux
 * clients connectés, exactement comme prévu. Avant ce correctif, rien
 * n'empêchait un appelant de contourner le widget et d'appeler cette route
 * directement sans être authentifié (le widget ne masquait le bouton que
 * côté client, ce qui ne protège rien côté serveur).
 */

import { Router } from 'express'
import { config } from '../../config.js'
import { logger } from '../../services/logger.js'
import { requireFirebaseAuth } from '../middleware/firebaseAuth.js'

const ALLOWED_LANGS = ['fr', 'en', 'es']
const MAX_MESSAGE_LENGTH = 2000
const MAX_HISTORY_ITEMS = 12
const MAX_HISTORY_ITEM_CHARS = 2000

// Rate Limiter en mémoire : 10 requêtes / minute par utilisateur authentifié.
// Pas de Redis pour l'instant (mono-instance) — si le backend est scalé
// horizontalement un jour, cette limite deviendra "10 x nb d'instances" et
// il faudra migrer vers un store partagé (Redis) à ce moment-là.
const rateLimitMap = new Map<string, { count: number, resetTime: number }>()
const MAX_REQUESTS = 10
const WINDOW_MS = 60 * 1000

// CORRECTIF : purge périodique des entrées expirées. Sans ça, le Map
// grossissait indéfiniment (fuite mémoire) puisqu'une entrée n'était jamais
// retirée une fois son resetTime dépassé si l'appelant ne refaisait jamais
// de requête. .unref() pour ne jamais bloquer un arrêt propre du process.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
setInterval(() => {
    const now = Date.now()
    for (const [key, record] of rateLimitMap.entries()) {
        if (now > record.resetTime) {
            rateLimitMap.delete(key)
        }
    }
}, CLEANUP_INTERVAL_MS).unref()

function checkRateLimit(key: string): boolean {
    const now = Date.now()
    const record = rateLimitMap.get(key)

    if (!record || now > record.resetTime) {
        rateLimitMap.set(key, { count: 1, resetTime: now + WINDOW_MS })
        return true
    }

    if (record.count >= MAX_REQUESTS) {
        return false
    }

    record.count += 1
    return true
}

// CORRECTIF : borne la taille de l'historique envoyé par le client — sans ça,
// rien n'empêchait un appelant de contourner le widget et d'envoyer un
// historique arbitrairement long, gonflant le coût de chaque appel LLM.
function sanitizeHistory(raw: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(raw)) return []
    return raw.slice(-MAX_HISTORY_ITEMS).map((item) => {
        if (item && typeof item === 'object') {
            const clone: Record<string, unknown> = { ...(item as Record<string, unknown>) }
            if (typeof clone.text === 'string') clone.text = clone.text.slice(0, MAX_HISTORY_ITEM_CHARS)
            if (typeof clone.content === 'string') clone.content = clone.content.slice(0, MAX_HISTORY_ITEM_CHARS)
            return clone
        }
        return {}
    })
}

export function chatbotProxyRouter(): Router {
    const router = Router()

    // ── GET /health — vérifié par le frontend pour afficher/masquer le widget ──
    // Reste public : ne renvoie qu'un booléen de disponibilité, aucune donnée.
    router.get('/health', async (_req, res) => {
        if (!config.iaServiceUrl) {
            res.status(503).json({ available: false })
            return
        }
        try {
            const response = await fetch(`${config.iaServiceUrl}/health`, {
                signal: AbortSignal.timeout(3000),
            })
            res.status(response.ok ? 200 : 503).json({ available: response.ok })
        } catch {
            res.status(503).json({ available: false })
        }
    })

    router.post('/', requireFirebaseAuth, async (req, res) => {
        const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
        const lang    = ALLOWED_LANGS.includes(req.body?.lang) ? req.body.lang : 'fr'
        const history = sanitizeHistory(req.body?.history)
        const stream  = Boolean(req.body?.stream || req.query?.stream === 'true')
        const authHeader = req.headers['authorization']

        // Clé de rate-limit stable : l'uid Firebase déjà vérifié par
        // requireFirebaseAuth, plutôt que le token brut (qui change à chaque
        // refresh et ferait sauter la limite à chaque fois).
        const limitKey = req.firebaseUser?.uid ?? req.ip ?? 'anonymous'
        if (!checkRateLimit(limitKey)) {
            res.status(429).json({
                success: false,
                error: { code: 'TOO_MANY_REQUESTS', message: 'Vous avez dépassé la limite de requêtes (10/min). Veuillez patienter.' },
            })
            return
        }

        if (!message || message.length > MAX_MESSAGE_LENGTH) {
            res.status(400).json({
                success: false,
                error: { code: 'INVALID_MESSAGE', message: 'Message vide ou trop long' },
            })
            return
        }

        if (!config.iaServiceUrl) {
            res.status(503).json({
                success: false,
                error: { code: 'AI_SERVICE_NOT_CONFIGURED', message: 'Le chatbot n\'est pas disponible' },
            })
            return
        }

        try {
            const response = await fetch(`${config.iaServiceUrl}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Service-Key': config.internalAiServiceKey,
                    ...(authHeader ? { Authorization: authHeader as string } : {}),
                },
                body: JSON.stringify({ message, lang, history, stream }),
                signal: AbortSignal.timeout(185_000),
            })

            if (!response.ok) {
                logger.error({ component: 'ChatbotProxy', status: response.status }, 'Le service IA a répondu une erreur')
                res.status(502).json({
                    success: false,
                    error: { code: 'AI_SERVICE_ERROR', message: 'Le chatbot est momentanément indisponible' },
                })
                return
            }

            if (stream && response.body) {
                res.setHeader('Content-Type', 'text/event-stream')
                res.setHeader('Cache-Control', 'no-cache')
                res.setHeader('Connection', 'keep-alive')

                // Node.js Web Stream to Express Response Pipe
                const reader = response.body.getReader()
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    res.write(value)
                }
                res.end()
                return
            }

            // CORRECTIF : les sources calculées par le RAG étaient reçues du
            // service IA puis silencieusement jetées ici — elles sont
            // maintenant transmises au frontend.
            const data = await response.json() as { answer: string; sources?: string[] }
            res.json({ success: true, answer: data.answer, sources: data.sources ?? [] })
        } catch (err) {
            logger.error({ component: 'ChatbotProxy', err }, 'Erreur appel service IA')
            res.status(502).json({
                success: false,
                error: { code: 'AI_SERVICE_UNREACHABLE', message: 'Le chatbot est momentanément indisponible' },
            })
        }
    })

    return router
}