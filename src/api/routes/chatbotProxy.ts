/**
 * chatbotProxy.ts — Route PUBLIQUE appelée par le frontend (widget de chat).
 *
 * CORRECTIF : la route /health ne fait plus qu'un ping léger vers ia-service
 * (/health), sans déclencher une génération complète du LLM. L'ancienne
 * version appelait /chat avec un vrai message "ping", ce qui attend une
 * réponse complète du modèle (10-60s sur CPU) — largement plus long que le
 * timeout de 4s côté widget, donc le bouton ne s'affichait jamais.
 *
 * Le service ia-service ne devient "healthy" côté FastAPI qu'une fois
 * l'indexation terminée (le lifespan startup bloque avant d'accepter des
 * requêtes) — /health suffit donc déjà comme signal de disponibilité réelle.
 */

import { Router } from 'express'
import { config } from '../../config.js'
import { logger } from '../../services/logger.js'

const ALLOWED_LANGS = ['fr', 'en', 'es']

// Rate Limiter en mémoire : 10 requêtes / minute par utilisateur
const rateLimitMap = new Map<string, { count: number, resetTime: number }>()
const MAX_REQUESTS = 10
const WINDOW_MS = 60 * 1000

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

export function chatbotProxyRouter(): Router {
    const router = Router()

    // ── GET /health — vérifié par le frontend pour afficher/masquer le widget ──
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

    router.post('/', async (req, res) => {
        const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
        const lang    = ALLOWED_LANGS.includes(req.body?.lang) ? req.body.lang : 'fr'
        const history = Array.isArray(req.body?.history) ? req.body.history : []
        const stream  = Boolean(req.body?.stream || req.query?.stream === 'true')
        const authHeader = req.headers['authorization']

        // Anti-Spam (Rate Limiter) : basé sur l'Auth (personne connectée) ou l'IP
        const limitKey = authHeader || req.ip || 'anonymous'
        if (!checkRateLimit(limitKey)) {
            res.status(429).json({
                success: false,
                error: { code: 'TOO_MANY_REQUESTS', message: 'Vous avez dépassé la limite de requêtes (10/min). Veuillez patienter.' },
            })
            return
        }

        if (!message || message.length > 2000) {
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

            const data = await response.json() as { answer: string; sources: string[] }
            res.json({ success: true, answer: data.answer })
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