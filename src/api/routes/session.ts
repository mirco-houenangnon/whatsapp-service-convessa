/**
 * DELETE /api/v1/session — Déconnexion et suppression de session.
 */

import { Router }          from 'express'
import { requireApiKey }   from '../middleware/auth.js'
import { rateLimit }       from '../middleware/rateLimit.js'
import { WhatsAppManager } from '../../whatsapp/WhatsAppManager.js'
import { config }          from '../../config.js'
import { logger }          from '../../services/logger.js'

export function sessionRouter(waManager: WhatsAppManager): Router {
    const router = Router()

    router.delete('/session', rateLimit, requireApiKey, async (_req, res) => {
        try {
            await waManager.logout()
            res.json({
                success: true,
                message: 'Session supprimée. Un nouveau QR code sera généré.',
            })
        } catch (err) {
            logger.error({ component: 'API', err }, 'Erreur logout')
            res.status(500).json({
                success: false,
                error: {
                    code:    'INTERNAL_ERROR',
                    message: config.isProd
                        ? 'Erreur lors de la déconnexion'
                        : (err instanceof Error ? err.message : 'Erreur inconnue'),
                },
            })
        }
    })

    return router
}
