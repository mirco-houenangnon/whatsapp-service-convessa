/**
 * auth.ts — Middleware d'authentification par clé API.
 * Comparaison en temps constant pour éviter les timing attacks.
 */

import type { RequestHandler } from 'express'
import { config } from '../../config.js'

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }
    return diff === 0
}

export const requireApiKey: RequestHandler = (req, res, next) => {
    // Mode développement sans clé définie → on laisse passer
    if (!config.bridgeApiKey) {
        next()
        return
    }

    const provided = (req.headers['x-api-key'] as string | undefined)?.trim()

    if (!provided) {
        res.status(401).json({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Clé API manquante ou invalide' },
        })
        return
    }

    if (!timingSafeEqual(provided, config.bridgeApiKey)) {
        res.status(401).json({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Clé API manquante ou invalide' },
        })
        return
    }

    next()
}
