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
            const authHeader = req.headers['authorization']

            const response = await fetch(`${config.iaServiceUrl}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Service-Key': config.internalAiServiceKey,
                    ...(authHeader ? { Authorization: authHeader as string } : {}),
                },
                body: JSON.stringify({ message, lang }),
                // Aligné sur le timeout de 180s côté ia-service (llm.py). Sur GPU,
                // les réponses reviennent en quelques secondes ; cette marge ne sert
                // que de garde-fou si jamais on retombe en CPU.
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