/**
 * send.ts — Route d'envoi de messages depuis la session WhatsApp d'un tenant.
 *
 * Authentification : clé API tenant (X-Api-Key: pk_convessa_...)
 * La clé identifie le tenant = l'émetteur WhatsApp.
 *
 * POST /api/v1/send
 * Body: {
 *   to: "22960000000" | ["22960000000", "22961111111"] | "<groupId>",
 *   message?: "...",
 *   media?: { type, mime, url|base64, name? }
 * }
 *
 * ── Comportement (important) ──────────────────────────────────────────────
 * La route répond IMMÉDIATEMENT (202, statut "queued") sans attendre la fin
 * réelle de l'envoi Baileys. Pour un média volumineux (vidéo, document),
 * l'upload vers WhatsApp peut prendre plus de temps qu'un aller-retour HTTP
 * raisonnable — attendre ce délai avant de répondre provoquait de faux
 * signalements d'échec ("timeout") alors que le message finissait par partir.
 *
 * Le statut réel (sent / failed) est ensuite notifié de façon fiable par :
 *   - Socket.io : événement `message_status` { tenantId, messageId, status, ... }
 *   - Webhook   : si le tenant en a configuré un (event: "message.sent" / "message.failed")
 *   - Polling   : GET /api/v1/messages/:id (self-service, clé tenant)
 *
 * `to` peut être :
 *   - un numéro (contact)
 *   - un tableau de numéros → un message indépendant est envoyé à chacun (broadcast)
 *   - un `groupId` (celui renvoyé par POST /api/v1/groups) → envoi dans le groupe
 */

import { Router }              from 'express'
import { requireTenantApiKey } from '../middleware/tenantAuth.js'
import { rateLimit }           from '../middleware/rateLimit.js'
import { TenantManager }       from '../../whatsapp/TenantManager.js'
import { validateMedia, getMediaRules } from '../../services/mediaValidator.js'
import { logger, maskPhone }   from '../../services/logger.js'
import { normalizePhone }      from '../../services/phoneUtils.js'
import {
    createLoggedMessage,
    markMessageSent,
    markMessageFailed,
    getLoggedMessageById,
    listLoggedMessagesForTenant,
}                               from '../../db/MessageLogStore.js'
import { getTenantGroupById }  from '../../db/GroupStore.js'
import { incrementMessagesSent } from '../../db/TenantStore.js'
import { isTenantSendingAllowed } from '../../services/tenantPrivileges.js'
import type { MediaPayload, MediaType } from '../../db/MessageQueue.js'

const PHONE_REGEX        = /^[+\d\s\-().]+$/
const VALID_MEDIA_TYPES: MediaType[] = ['image', 'video', 'audio', 'document']
const MAX_BROADCAST_RECIPIENTS = 50

/**
 * Nettoie tout numéro saisi → chiffres purs sans +
 * Gère : espaces, tirets, parenthèses, points, +, 01 béninois, etc.
 */
function sanitizePhone(raw: string): string {
    return normalizePhone(raw)
}

// Un groupId interne est un UUID v4 (jamais un numéro de téléphone)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function _checkAndNotifyQuota(
    tenantManager: TenantManager,
    tenantId: string,
    phone: string | null
): Promise<void> {
    if (!phone) return
    try {
        const { getTenantById } = await import('../../db/TenantStore.js')
        const updated = await getTenantById(tenantId)
        if (!updated) return

        if (updated.usageType === 'requests' && updated.messagesLimit !== null) {
            const remaining = updated.messagesLimit - updated.messagesSent
            const pct = updated.messagesSent / updated.messagesLimit

            let notifMsg: string | null = null

            if (remaining === 0) {
                notifMsg = `⚠️ *Convessa — Quota épuisé*\n\nVous avez utilisé la totalité de vos ${updated.messagesLimit.toLocaleString('fr-FR')} messages.\n\nPassez à un abonnement supérieur pour continuer :\nhttps://convessa.dev/pricing`
            } else if (remaining <= 10 || pct >= 0.9) {
                notifMsg = `📊 *Convessa — Quota presque épuisé*\n\nIl vous reste *${remaining} message${remaining > 1 ? 's' : ''}* sur ${updated.messagesLimit.toLocaleString('fr-FR')}.\n\nPensez à renouveler votre abonnement :\nhttps://convessa.dev/pricing`
            } else if (remaining === 50 || remaining === 100) {
                notifMsg = `📊 *Convessa — Rappel quota*\n\nIl vous reste *${remaining} messages* sur votre forfait de ${updated.messagesLimit.toLocaleString('fr-FR')}.\n\nVoir les offres : https://convessa.dev/pricing`
            }

            if (notifMsg) {
                await tenantManager.sendMessageAsTenantViaAdmin(phone, notifMsg).catch(() => {})
            }
        } else if (updated.usageType === 'duration' && updated.apiKeyExpiresAt) {
            const daysLeft = Math.ceil((updated.apiKeyExpiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))

            if (daysLeft === 3 || daysLeft === 1) {
                const msg = daysLeft === 1
                    ? `⚠️ *Convessa — Abonnement expire demain !*\n\nVotre accès expire dans *1 jour*.\n\nRenouvelez maintenant pour ne pas perdre l'accès :\nhttps://convessa.dev/pricing`
                    : `📅 *Convessa — Abonnement bientôt expiré*\n\nVotre accès expire dans *3 jours*.\n\nRenouvelez ici : https://convessa.dev/pricing`
                await tenantManager.sendMessageAsTenantViaAdmin(phone, msg).catch(() => {})
            }
        }
    } catch { /* notifications non bloquantes */ }
}

export function sendRouter(tenantManager: TenantManager): Router {
    const router = Router()

    // ── Callback commun : exécute réellement l'envoi en arrière-plan ──────────
    // et met à jour le journal + notifie Socket.io/webhook une fois résolu.
    function dispatchInBackground(
        messageId: string,
        tenantId:  string,
        tenantPhone: string | null,
        remoteJid: string,
        text:      string | null,
        media:     MediaPayload | undefined,
        webhookUrl: string | null,
    ): void {
        tenantManager.sendMessageAsTenant(tenantId, remoteJid, text, media)
            .then(async ({ waMessageId }) => {
                await markMessageSent(messageId, waMessageId)
                logger.info(
                    { component: 'SendRoute', tenantId, messageId, from: maskPhone(tenantPhone), to: maskPhone(remoteJid) },
                    'Message tenant envoyé (confirmé)'
                )
                tenantManager.emit('message_status', tenantId, {
                    messageId, status: 'sent', to: remoteJid, waMessageId,
                })
                notifyWebhook(webhookUrl, { event: 'message.sent', messageId, tenantId, to: remoteJid, waMessageId })
            })
            .catch(async (err) => {
                const message = err instanceof Error ? err.message : String(err)
                await markMessageFailed(messageId, 'SEND_ERROR', message)
                logger.error({ component: 'SendRoute', tenantId, messageId, err }, 'Échec envoi message tenant (confirmé)')
                tenantManager.emit('message_status', tenantId, {
                    messageId, status: 'failed', to: remoteJid, error: message,
                })
                notifyWebhook(webhookUrl, { event: 'message.failed', messageId, tenantId, to: remoteJid, error: message })
            })
    }

    function notifyWebhook(url: string | null, payload: unknown): void {
        if (!url) return
        import('https').then(({ request }) => {
            try {
                const body   = JSON.stringify(payload)
                const urlObj = new URL(url)
                const req = request({
                    hostname: urlObj.hostname,
                    port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                    path:     urlObj.pathname + urlObj.search,
                    method:   'POST',
                    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                    timeout:  10_000,
                }, () => { /* réponse ignorée — fire and forget */ })
                req.on('error', (err) => logger.warn({ component: 'SendRoute', url, err }, 'Erreur webhook message'))
                req.write(body)
                req.end()
            } catch { /* ignoré */ }
        }).catch(() => {})
    }

    // ── POST /api/v1/send ──────────────────────────────────────────────────────
    router.post('/send', rateLimit, requireTenantApiKey, async (req, res) => {
        const tenant = req.tenant!
        const body   = req.body as {
            to?:      unknown
            message?: unknown
            media?:   unknown
        }

        // ── Validation de 'to' — contact, tableau de contacts, ou groupId ───────
        if (!body.to || (typeof body.to !== 'string' && !Array.isArray(body.to))) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'to' est obligatoire (numéro, tableau de numéros, ou groupId)" },
            })
            return
        }

        const toList: string[] = Array.isArray(body.to) ? body.to.map(String) : [body.to]

        if (toList.length === 0) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'to' ne peut pas être vide" } })
            return
        }
        if (toList.length > MAX_BROADCAST_RECIPIENTS) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: `Maximum ${MAX_BROADCAST_RECIPIENTS} destinataires par envoi. Espacez vos appels pour des volumes plus importants.` },
            })
            return
        }

        // Résoudre chaque entrée de `to` en JID réel (contact ou groupe)
        const resolved: { jid: string; toType: 'contact' | 'group' }[] = []
        for (const raw of toList) {
            const trimmed = String(raw).trim()
            if (UUID_REGEX.test(trimmed)) {
                const group = await getTenantGroupById(tenant.id, trimmed)
                if (!group) {
                    res.status(404).json({ success: false, error: { code: 'GROUP_NOT_FOUND', message: `Groupe '${trimmed}' introuvable ou n'appartenant pas à ce compte` } })
                    return
                }
                resolved.push({ jid: group.waGroupJid, toType: 'group' })
            } else {
                if (!PHONE_REGEX.test(trimmed)) {
                    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Numéro invalide : '${trimmed}' — indicatif international requis` } })
                    return
                }
                resolved.push({ jid: `${sanitizePhone(trimmed)}@s.whatsapp.net`, toType: 'contact' })
            }
        }

        // ── Validation de 'message' ───────────────────────────────────────────
        let messageTrimmed: string | undefined

        if (body.message !== undefined && body.message !== null) {
            if (typeof body.message !== 'string') {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'message' doit être une chaîne de caractères" } })
                return
            }
            messageTrimmed = body.message.trim()
            if (!messageTrimmed) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Le message ne peut pas être vide' } })
                return
            }
            if (messageTrimmed.length > 4096) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Le message ne peut pas dépasser 4096 caractères' } })
                return
            }
        }

        // ── Validation du média ───────────────────────────────────────────────
        let mediaPayload: MediaPayload | undefined

        if (body.media !== undefined && body.media !== null) {
            if (typeof body.media !== 'object' || Array.isArray(body.media)) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'media' doit être un objet" } })
                return
            }

            const m = body.media as Record<string, unknown>

            if (!m['type'] || !VALID_MEDIA_TYPES.includes(m['type'] as MediaType)) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `'media.type' invalide. Valeurs acceptées : ${VALID_MEDIA_TYPES.join(', ')}` } })
                return
            }
            if (!m['mime'] || typeof m['mime'] !== 'string') {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'media.mime' est requis (ex: 'image/jpeg')" } })
                return
            }

            const hasUrl    = typeof m['url']    === 'string' && (m['url'] as string).trim().length > 0
            const hasBase64 = typeof m['base64'] === 'string' && (m['base64'] as string).trim().length > 0

            if (!hasUrl && !hasBase64) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'media' doit contenir 'url' ou 'base64'" } })
                return
            }

            const validationError = validateMedia(
                m['type'] as MediaType,
                m['mime'] as string,
                hasBase64 ? (m['base64'] as string) : undefined,
                hasUrl    ? (m['url'] as string)    : undefined,
            )
            if (validationError) {
                res.status(400).json({ success: false, error: validationError })
                return
            }

            mediaPayload = {
                type:   m['type']  as MediaType,
                mime:   m['mime']  as string,
                name:   typeof m['name'] === 'string' ? m['name'] : undefined,
                url:    hasUrl    ? (m['url'] as string)    : undefined,
                base64: hasBase64 ? (m['base64'] as string) : undefined,
            }
        }

        if (!messageTrimmed && !mediaPayload) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "La requête doit contenir au moins 'message' ou 'media'" } })
            return
        }

        // ── Session tenant connectée ? ────────────────────────────────────────
        if (!tenantManager.isConnected(tenant.id)) {
            res.status(503).json({
                success: false,
                error: { code: 'SESSION_NOT_CONNECTED', message: "Votre session WhatsApp n'est pas connectée. Scannez le QR code depuis votre dashboard." },
            })
            return
        }

        // ── Privilèges d'utilisation (durée ou quota de messages) ────────────
        // Bloque tout envoi dès que la clé est expirée (usage_type = 'duration')
        // ou que le quota de messages est atteint (usage_type = 'requests').
        const access = isTenantSendingAllowed(tenant)
        if (!access.allowed) {
            res.status(403).json({
                success: false,
                error: {
                    code:    access.code ?? 'ACCESS_DENIED',
                    message: access.message ?? "Envoi de messages non autorisé pour cette session. Renouvelez votre abonnement.",
                },
            })
            return
        }

        // ── Créer le journal + lancer l'envoi en arrière-plan pour chaque destinataire ──
        const results: { to: string; messageId: string; toType: 'contact' | 'group' }[] = []

        for (const { jid, toType } of resolved) {
            const messageId = await createLoggedMessage({
                tenantId:  tenant.id,
                toJid:     jid,
                toType,
                message:   messageTrimmed ?? null,
                hasMedia:  !!mediaPayload,
                mediaType: mediaPayload?.type ?? null,
            })

            // Compteur uniquement pertinent pour les privilèges basés sur un
            // quota de messages ('requests') — inoffensif dans les autres cas,
            // mais on évite l'écriture DB inutile pour 'unlimited'/'duration'.
            if (tenant.usageType === 'requests') {
                await incrementMessagesSent(tenant.id)
                // Notifier le tenant si son quota approche ou est expiré
                await _checkAndNotifyQuota(tenantManager, tenant.id, tenant.phone)
            }

            // Vérifier aussi l'expiration pour les abonnements durée
            if (tenant.usageType === 'duration') {
                await _checkAndNotifyQuota(tenantManager, tenant.id, tenant.phone)
            }

            dispatchInBackground(messageId, tenant.id, tenant.phone, jid, messageTrimmed ?? null, mediaPayload, tenant.webhookUrl)
            results.push({ to: jid, messageId, toType })
        }

        logger.info(
            { component: 'SendRoute', tenantId: tenant.id, from: maskPhone(tenant.phone), count: results.length, hasMedia: !!mediaPayload },
            'Message(s) tenant accepté(s) — envoi en cours'
        )

        // ── Réponse immédiate — ne dépend jamais de la durée réelle de l'envoi ──
        res.status(202).json({
            success:  true,
            status:   'queued',
            from:     maskPhone(tenant.phone),
            messages: results,
            // Rétro-compatibilité pour un envoi simple à un seul destinataire
            ...(results.length === 1 ? { messageId: results[0]?.messageId, to: results[0]?.to } : {}),
        })
    })

    // ── GET /api/v1/send/info ─────────────────────────────────────────────────
    router.get('/send/info', requireTenantApiKey, async (req, res) => {
        const tenant = req.tenant!
        res.json({
            success:     true,
            tenantId:    tenant.id,
            from:        maskPhone(tenant.phone),
            status:      tenant.status,
            connected:   tenantManager.isConnected(tenant.id),
            connectedAt: tenant.connectedAt,
            mediaLimits: getMediaRules(),
        })
    })

    // ── GET /api/v1/send/status/:id — statut d'un message précis (polling) ────
    // (chemin distinct de GET /api/v1/messages/:id, réservé à l'admin dans messages.ts)
    router.get('/send/status/:id', requireTenantApiKey, async (req, res) => {
        const tenant = req.tenant!
        const msg    = await getLoggedMessageById(req.params['id'] as string)

        if (!msg || msg.tenantId !== tenant.id) {
            res.status(404).json({ success: false, error: { code: 'MESSAGE_NOT_FOUND', message: 'Message introuvable' } })
            return
        }

        res.json({
            success:      true,
            messageId:    msg.id,
            status:       msg.status,
            to:           msg.toJid,
            toType:       msg.toType,
            hasMedia:     msg.hasMedia,
            errorCode:    msg.errorCode,
            errorMessage: msg.errorMessage,
            waMessageId:  msg.waMessageId,
            createdAt:    msg.createdAt,
            sentAt:       msg.sentAt,
        })
    })

    // ── GET /api/v1/send/history — historique des messages du tenant ──────────
    router.get('/send/history', requireTenantApiKey, async (req, res) => {
        const tenant  = req.tenant!
        const limit   = parseInt(String(req.query['limit'] ?? '50'), 10)
        const history = await listLoggedMessagesForTenant(tenant.id, isNaN(limit) ? 50 : limit)

        res.json({
            success: true,
            count:   history.length,
            messages: history.map(m => ({
                messageId: m.id,
                to:        m.toJid,
                toType:    m.toType,
                status:    m.status,
                hasMedia:  m.hasMedia,
                errorCode: m.errorCode,
                createdAt: m.createdAt,
                sentAt:    m.sentAt,
            })),
        })
    })

    return router
}