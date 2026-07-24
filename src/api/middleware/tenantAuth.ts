/**
 * tenantAuth.ts — Authentification par clé API tenant (wag_live_...).
 *
 * Le développeur inclut sa clé dans le header X-Api-Key.
 * On vérifie le hash SHA-256 contre la table wa_tenants.
 * On attache req.tenant au request pour les handlers suivants.
 */

import { createHash } from 'crypto'
import type { RequestHandler } from 'express'
import { getTenantByApiKeyHash } from '../../db/TenantStore.js'
import type { Tenant } from '../../db/TenantStore.js'

declare global {
    namespace Express {
        interface Request {
            tenant?: Tenant
        }
    }
}

export const requireTenantApiKey: RequestHandler = async (req, res, next) => {
    const raw = (req.headers['x-api-key'] as string | undefined)?.trim()

    if (!raw) {
        res.status(401).json({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Clé API manquante (header X-Api-Key requis)' },
        })
        return
    }

    // Format de base : doit commencer par "wag_live_"
    if (!raw.startsWith('wag_live_')) {
        res.status(401).json({
            success: false,
            error: { code: 'INVALID_API_KEY_FORMAT', message: 'Format de clé API invalide' },
        })
        return
    }

    const hash = createHash('sha256').update(raw).digest('hex')

    const tenant = await getTenantByApiKeyHash(hash).catch(() => null)

    if (!tenant) {
        res.status(401).json({
            success: false,
            error: { code: 'INVALID_API_KEY', message: 'Clé API invalide ou révoquée' },
        })
        return
    }

    if (tenant.status === 'revoked' || tenant.status === 'disconnected') {
        res.status(403).json({
            success: false,
            error: {
                code:    'SESSION_NOT_ACTIVE',
                message: `Session WhatsApp ${tenant.status === 'revoked' ? 'révoquée' : 'déconnectée'}. Reconnectez votre compte.`,
            },
        })
        return
    }

    req.tenant = tenant
    next()
}
