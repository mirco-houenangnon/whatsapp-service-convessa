/**
 * GET /api/v1/status — État courant de la connexion WhatsApp.
 */

import { Router }          from 'express'
import { requireApiKey }   from '../middleware/auth.js'
import { WhatsAppManager } from '../../whatsapp/WhatsAppManager.js'
import { getQueueStats }   from '../../db/MessageQueue.js'

export function statusRouter(waManager: WhatsAppManager): Router {
    const router = Router()

    router.get('/status', requireApiKey, async (_req, res) => {
        const connectionStatus = waManager.getStatus()

        if (connectionStatus.status === 'connected') {
            const queueStats = await getQueueStats()
            res.json({
                success: true,
                ...connectionStatus,
                queue: queueStats,
            })
        } else {
            res.json({ success: true, ...connectionStatus })
        }
    })

    return router
}
