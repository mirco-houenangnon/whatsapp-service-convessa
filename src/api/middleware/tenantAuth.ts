/**
 * tenantAuth.ts — Authentification par clé API tenant (pk_convessa_...).
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

// Préfixes valides — on accepte pk_convessa_ (nouveau) et wag_live_ (legacy)
const VALID_PREFIXES = ['pk_convessa_', 'wag_live_']

export const requireTenantApiKey: RequestHandler = async (req, res, next) => {
    const raw = (req.headers['x-api-key'] as string | undefined)?.trim()

    if (!raw) {
        res.status(401).json({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Clé API manquante (header X-Api-Key requis)' },
        })
        return
    }

    // Vérifier le format : doit commencer par un préfixe connu
    const hasValidPrefix = VALID_PREFIXES.some(prefix => raw.startsWith(prefix))
    if (!hasValidPrefix) {
        res.status(401).json({
            success: false,
            error: { code: 'INVALID_API_KEY_FORMAT', message: 'Format de clé API invalide. La clé doit commencer par pk_convessa_' },
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
