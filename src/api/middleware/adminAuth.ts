/**
 * adminAuth.ts — Middleware de protection des routes admin Convessa.
 * Vérifie le JWT admin dans le header Authorization ou le cookie.
 */

import type { RequestHandler } from 'express'
import { verifyAdminToken, type AdminTokenPayload } from '../../services/adminJwt.js'

// Augmentation du type Express Request
declare global {
    namespace Express {
        interface Request {
            adminUser?: AdminTokenPayload
        }
    }
}

export const requireAdminAuth: RequestHandler = (req, res, next) => {
    // Support : Authorization: Bearer <token>  OU  Cookie: admin_token=<token>
    let token: string | undefined

    const authHeader = req.headers['authorization']
    if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.slice(7)
    }

    // Fallback : cookie (pour les requêtes depuis le dashboard HTML)
    if (!token) {
        const cookieHeader = req.headers['cookie'] ?? ''
        const match        = cookieHeader.match(/(?:^|;\s*)admin_token=([^;]+)/)
        if (match?.[1]) token = decodeURIComponent(match[1])
    }

    if (!token) {
        res.status(401).json({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Token admin manquant' },
        })
        return
    }

    const payload = verifyAdminToken(token)
    if (!payload) {
        res.status(401).json({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Token admin invalide ou expiré' },
        })
        return
    }

    req.adminUser = payload
    next()
}
