/**
 * chatbotContext.ts — Route INTERNE consommée uniquement par le service IA.
 *
 * À placer dans : backend/src/api/routes/chatbotContext.ts
 *
 * Sécurité :
 *   1. Nécessite le Firebase ID Token du client (requireFirebaseAuth) — donc
 *      identifie forcément le VRAI propriétaire du compte, jamais un autre tenant.
 *   2. Nécessite EN PLUS un header interne partagé (X-Internal-Service-Key),
 *      pour qu'un client ne puisse jamais appeler cette route directement même
 *      avec un token Firebase valide — seul le service IA connaît cette clé.
 *   3. Whitelist stricte des champs renvoyés — jamais apiKeyHash, apiKeyHint,
 *      webhookUrl, ni aucune colonne marquée `sensitive` dans schemaMeta.ts.
 *
 * N'oublie pas d'enregistrer ce router dans index.ts :
 *   import { chatbotContextRouter } from './api/routes/chatbotContext.js'
 *   app.use('/api/v1/internal/chatbot-context', chatbotContextRouter())
 */

import { Router } from 'express'
import { requireFirebaseAuth } from '../middleware/firebaseAuth.js'
import { getTenantByUserUid } from '../../db/TenantStore.js'
import { config } from '../../config.js'
import { logger } from '../../services/logger.js'

function requireInternalServiceKey(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
    const key = req.headers['x-internal-service-key']
    if (!config.internalAiServiceKey || key !== config.internalAiServiceKey) {
        res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Service non autorisé' } })
        return
    }
    next()
}

export function chatbotContextRouter(): Router {
    const router = Router()
    router.use(requireInternalServiceKey)
    router.use(requireFirebaseAuth)

    router.get('/', async (req, res) => {
        try {
            const uid = req.firebaseUser?.uid
            if (!uid) {
                res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Utilisateur inconnu' } })
                return
            }

            const tenant = await getTenantByUserUid(uid)
            if (!tenant) {
                res.json({ success: true, context: 'Ce client n\'a pas encore créé de session WhatsApp sur la plateforme.' })
                return
            }

            // ── Whitelist stricte : uniquement des champs non sensibles ──────
            const remaining = tenant.messagesLimit != null
                ? Math.max(0, tenant.messagesLimit - tenant.messagesSent)
                : 'Illimité'

            const statusText: Record<string, string> = {
                pending_qr: 'En attente de connexion (le QR code est généré dans le tableau de bord mais n\'a PAS encore été scanné sur le téléphone).',
                connected: `Session WhatsApp ACTIVE et connectée${tenant.connectedAt ? ' depuis le ' + tenant.connectedAt.toISOString().slice(0, 10) : ''}.`,
                disconnected: 'Session DÉCONNECTÉE (le client doit cliquer sur Reconnecter et scanner un nouveau QR code).',
                revoked: 'Session révoquée.',
            }

            const usageLabel: Record<string, string> = {
                unlimited: 'Illimité',
                duration: 'Abonnement par durée',
                requests: 'Quota de messages',
            }

            const summaryLines = [
                tenant.name ? `Nom / Compte : ${tenant.name}` : null,
                tenant.phone ? `Numéro WhatsApp relié : +${tenant.phone}` : null,
                `Statut de la session : ${statusText[tenant.status] ?? tenant.status}`,
                `Formule / Forfait : ${usageLabel[tenant.usageType] ?? tenant.usageType}`,
                `Messages envoyés : ${tenant.messagesSent}`,
                `Messages restants sur le forfait : ${remaining}`,
                tenant.apiKeyExpiresAt ? `Date d'expiration de la clé API / abonnement : ${tenant.apiKeyExpiresAt.toISOString().slice(0, 10)}` : null,
                tenant.apiKeyHint ? `Indice de clé API : active (se termine par ...${tenant.apiKeyHint})` : 'Clé API : Aucune clé générée pour le moment',
                tenant.webhookUrl ? `Webhook configuré : Oui (${tenant.webhookUrl})` : 'Webhook : Aucun webhook configuré',
                `Compte créé le : ${tenant.createdAt.toISOString().slice(0, 10)}`,
            ]

            const summary = summaryLines.filter(Boolean).join('\n')

            res.json({ success: true, context: summary })
        } catch (err) {
            logger.error({ component: 'ChatbotContext', err }, 'Erreur récupération contexte tenant')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    return router
}