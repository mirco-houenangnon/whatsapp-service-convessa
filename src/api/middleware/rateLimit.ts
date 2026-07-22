/**
 * rateLimit.ts — Rate limiting en mémoire.
 * L'IP est extraite depuis req.socket uniquement (X-Forwarded-For non utilisé
 * pour éviter la manipulation). Configurable via .env.
 */

import type { RequestHandler } from 'express'
import { config }              from '../../config.js'

const RATE_LIMIT_MAX    = 60    // requêtes max par fenêtre
const RATE_LIMIT_WINDOW = 60_000 // fenêtre de 60 secondes

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

// Nettoyage périodique des entrées expirées (anti memory leak)
setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of rateLimitMap) {
        if (now > entry.resetAt) rateLimitMap.delete(ip)
    }
}, 5 * 60_000)

export const rateLimit: RequestHandler = (req, res, next) => {
    const ip  = req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()

    const entry = rateLimitMap.get(ip)

    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
        next()
        return
    }

    if (entry.count >= RATE_LIMIT_MAX) {
        res.status(429).json({
            success: false,
            error: {
                code:    'RATE_LIMIT_EXCEEDED',
                message: 'Trop de requêtes — réessayez dans un moment',
            },
        })
        return
    }

    entry.count++
    next()
}
