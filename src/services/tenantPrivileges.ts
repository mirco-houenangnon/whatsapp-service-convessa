
import { getReferralCodeByCode }         from '../db/ReferralCodeStore.js'
import { getFreePlan }                   from '../db/SubscriptionPlanStore.js'
import type { Tenant, TenantPrivileges } from '../db/TenantStore.js'
import { logger }                        from './logger.js'

export class ReferralCodeError extends Error {
    code = 'INVALID_REFERRAL_CODE'
    constructor(message = 'Code de parrainage invalide ou introuvable') {
        super(message)
    }
}

function privilegesFromUsage(
    unlimited:  boolean,
    usageType:  'duration' | 'requests' | null,
    usageValue: number | null,
): TenantPrivileges {
    if (unlimited) {
        return { usageType: 'unlimited', messagesLimit: null, expiresAt: null }
    }

    if (usageType === 'requests') {
        return { usageType: 'requests', messagesLimit: Math.max(0, usageValue ?? 0), expiresAt: null }
    }

    if (usageType === 'duration') {
        const days      = Math.max(0, usageValue ?? 0)
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
        return { usageType: 'duration', messagesLimit: null, expiresAt }
    }

    // Ni durée ni quota précisé (donnée incomplète) → traiter comme illimité
    // plutôt que de bloquer arbitrairement le tenant.
    return { usageType: 'unlimited', messagesLimit: null, expiresAt: null }
}

/**
 * Résout les privilèges d'utilisation à appliquer à un tenant qui s'active.
 *
 * @param referralCode  Code saisi par l'utilisateur (optionnel). S'il est
 *                       fourni mais invalide, lève une ReferralCodeError.
 *                       S'il est absent, retombe sur le plan gratuit.
 */
export async function resolveTenantPrivileges(referralCode?: string | null): Promise<TenantPrivileges> {
    const trimmed = referralCode?.trim()

    if (trimmed) {
        const found = await getReferralCodeByCode(trimmed)
        if (!found) {
            throw new ReferralCodeError()
        }
        logger.info({ component: 'TenantPrivileges', code: trimmed, unlimited: found.unlimited, usageType: found.usageType }, 'Code de parrainage appliqué')
        return privilegesFromUsage(found.unlimited, found.usageType, found.usageValue)
    }

    // Pas de code fourni → privilèges du plan gratuit (price = 0)
    const freePlan = await getFreePlan()
    if (!freePlan) {
        logger.warn({ component: 'TenantPrivileges' }, 'Aucun plan gratuit configuré (price = 0) — accès illimité accordé par défaut')
        return { usageType: 'unlimited', messagesLimit: null, expiresAt: null }
    }
    return privilegesFromUsage(freePlan.unlimited, freePlan.usageType, freePlan.usageValue)
}

/**
 * Vérifie si un tenant est autorisé à envoyer un message MAINTENANT, selon
 * ses privilèges (illimité / durée / quota de messages). Utilisé par
 * POST /api/v1/send avant de mettre le message en file.
 */
export function isTenantSendingAllowed(tenant: Tenant): { allowed: boolean; code?: string; message?: string } {
    switch (tenant.usageType) {
        case 'unlimited':
            return { allowed: true }

        case 'duration':
            if (tenant.apiKeyExpiresAt && tenant.apiKeyExpiresAt.getTime() <= Date.now()) {
                return {
                    allowed: false,
                    code:    'SUBSCRIPTION_EXPIRED',
                    message: 'Votre période d\'utilisation est expirée. Renouvelez votre abonnement pour continuer à envoyer des messages.',
                }
            }
            return { allowed: true }

        case 'requests':
            if (tenant.messagesLimit !== null && tenant.messagesSent >= tenant.messagesLimit) {
                return {
                    allowed: false,
                    code:    'MESSAGE_QUOTA_EXCEEDED',
                    message: `Quota de ${tenant.messagesLimit} message(s) atteint. Renouvelez votre abonnement pour continuer à envoyer des messages.`,
                }
            }
            return { allowed: true }

        default:
            return { allowed: true }
    }
}