

import { Router }            from 'express'
import { listPublicPlans }   from '../../db/SubscriptionPlanStore.js'
import { logger }            from '../../services/logger.js'

export function plansRouter(): Router {
    const router = Router()

    // ── GET /api/v1/plans ─────────────────────────────────────────────────────
    router.get('/', async (_req, res) => {
        try {
            const plans = await listPublicPlans()
            res.json({ success: true, count: plans.length, plans })
        } catch (err) {
            logger.error({ component: 'Plans', err }, 'Erreur récupération plans (public)')
            res.status(500).json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' },
            })
        }
    })

    return router
}