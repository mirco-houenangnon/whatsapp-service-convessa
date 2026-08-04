/**
 * adminContact.ts — Espace admin « Messages depuis Contact ».
 *
 * Authentification : JWT admin (requireAdminAuth).
 *
 * GET    /api/admin/contact/messages              — liste paginée des demandes reçues
 * GET    /api/admin/contact/messages/:id          — détail d'une demande + fil de réponses
 * POST   /api/admin/contact/messages/:id/reply    — répondre au demandeur (texte et/ou fichier)
 *                                                     → envoyé depuis le numéro WhatsApp admin
 *                                                       vers le numéro renseigné dans le formulaire
 * PATCH  /api/admin/contact/messages/:id/read     — marquer comme lu
 * GET    /api/admin/contact/unread-count          — nombre de demandes non lues (badge)
 *
 * Gestion du groupe WhatsApp admin (notifications des nouvelles demandes) :
 * GET    /api/admin/contact/group                 — état du groupe (configuré ? connecté ? membres ?)
 * POST   /api/admin/contact/group                 — créer le groupe (1ère configuration)
 * PATCH  /api/admin/contact/group                 — renommer le groupe
 * POST   /api/admin/contact/group/participants    — ajouter des membres
 * DELETE /api/admin/contact/group/participants    — retirer des membres
 * GET    /api/admin/contact/group/invite-code     — lien d'invitation du groupe
 */

import { Router }              from 'express'
import { requireAdminAuth }    from '../middleware/adminAuth.js'
import { rateLimit }           from '../middleware/rateLimit.js'
import { validateMedia }       from '../../services/mediaValidator.js'
import { logger, maskPhone }   from '../../services/logger.js'
import { normalizePhone }      from '../../services/phoneUtils.js'
import { WhatsAppManager }     from '../../whatsapp/WhatsAppManager.js'
import { getAdminById }        from '../../db/AdminStore.js'
import { getSetting, setSetting, ADMIN_CONTACT_GROUP_KEY } from '../../db/SettingsStore.js'
import type { MediaPayload, MediaType } from '../../db/MessageQueue.js'
import {
    listContactMessages,
    getContactMessageById,
    listContactReplies,
    markContactMessageRead,
    markContactMessageReplied,
    createContactReply,
    markContactReplyStatus,
    countContactMessagesByStatus,
    type ContactStatus,
}                               from '../../db/ContactStore.js'

const VALID_MEDIA_TYPES: MediaType[] = ['image', 'video', 'audio', 'document']
const VALID_STATUSES: ContactStatus[] = ['unread', 'read', 'replied']
const MAX_REPLY_LENGTH = 4096
const PHONE_REGEX = /^[+\d\s\-().]+$/

function sanitizePhone(raw: string): string {
    return normalizePhone(raw)
}

export function adminContactRouter(waManager: WhatsAppManager): Router {
    const router = Router()

    // ── GET /messages — liste paginée ────────────────────────────────────────
    router.get('/messages', requireAdminAuth, async (req, res) => {
        const page  = Math.max(1, parseInt(req.query['page'] as string || '1', 10))
        const limit = Math.min(50, Math.max(1, parseInt(req.query['limit'] as string || '20', 10)))
        const statusParam = (req.query['status'] as string || 'all') as ContactStatus | 'all'
        const search = req.query['search'] as string | undefined

        if (statusParam !== 'all' && !VALID_STATUSES.includes(statusParam)) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Statut invalide' } })
            return
        }

        try {
            const { messages, total } = await listContactMessages({ page, limit, status: statusParam, search })
            res.json({
                success: true,
                messages: messages.map(m => ({
                    id:                   m.id,
                    name:                 m.name,
                    email:                m.email,
                    phone:                m.phone,
                    subject:              m.subject,
                    message:              m.message,
                    status:               m.status,
                    userNotified:         m.userNotifiedAt !== null,
                    adminGroupNotified:   m.adminGroupNotifiedAt !== null,
                    createdAt:            m.createdAt,
                    updatedAt:            m.updatedAt,
                })),
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            })
        } catch (err) {
            logger.error({ component: 'AdminContact', err }, 'Erreur liste messages contact')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── GET /unread-count — badge ─────────────────────────────────────────────
    router.get('/unread-count', requireAdminAuth, async (_req, res) => {
        try {
            const count = await countContactMessagesByStatus('unread')
            res.json({ success: true, count })
        } catch (err) {
            logger.error({ component: 'AdminContact', err }, 'Erreur comptage messages non lus')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── GET /messages/:id — détail + fil de réponses ─────────────────────────
    router.get('/messages/:id', requireAdminAuth, async (req, res) => {
        const id = req.params['id'] as string
        try {
            const contactMessage = await getContactMessageById(id)
            if (!contactMessage) {
                res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Demande introuvable' } })
                return
            }
            const replies = await listContactReplies(id)

            res.json({
                success: true,
                message: contactMessage,
                replies,
            })
        } catch (err) {
            logger.error({ component: 'AdminContact', id, err }, 'Erreur détail message contact')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── PATCH /messages/:id/read — marquer comme lu ──────────────────────────
    router.patch('/messages/:id/read', requireAdminAuth, async (req, res) => {
        const id = req.params['id'] as string
        try {
            const contactMessage = await getContactMessageById(id)
            if (!contactMessage) {
                res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Demande introuvable' } })
                return
            }
            await markContactMessageRead(id)
            res.json({ success: true })
        } catch (err) {
            logger.error({ component: 'AdminContact', id, err }, 'Erreur marquage lecture')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── POST /messages/:id/reply — répondre au demandeur via WhatsApp ────────
    router.post('/messages/:id/reply', rateLimit, requireAdminAuth, async (req, res) => {
        const id = req.params['id'] as string
        const body = req.body as { message?: unknown; media?: unknown }

        try {
            const contactMessage = await getContactMessageById(id)
            if (!contactMessage) {
                res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Demande introuvable' } })
                return
            }
            if (!contactMessage.phone) {
                res.status(422).json({
                    success: false,
                    error: { code: 'NO_PHONE', message: "Cette demande n'a pas de numéro de téléphone associé — impossible d'envoyer une réponse WhatsApp." },
                })
                return
            }

            // ── Validation du texte ───────────────────────────────────────────────
            let text: string | undefined
            if (body.message !== undefined && body.message !== null) {
                if (typeof body.message !== 'string') {
                    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'message' doit être une chaîne de caractères" } })
                    return
                }
                text = body.message.trim()
                if (text.length > MAX_REPLY_LENGTH) {
                    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Le message ne peut pas dépasser ${MAX_REPLY_LENGTH} caractères` } })
                    return
                }
            }

            // ── Validation du média (optionnel) ───────────────────────────────────
            let media: MediaPayload | undefined
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
                    hasUrl ? (m['url'] as string) : undefined,
                )
                if (validationError) {
                    res.status(400).json({ success: false, error: validationError })
                    return
                }

                media = {
                    type:   m['type'] as MediaType,
                    mime:   m['mime'] as string,
                    name:   typeof m['name'] === 'string' ? m['name'] : undefined,
                    url:    hasUrl    ? (m['url']    as string) : undefined,
                    base64: hasBase64 ? (m['base64'] as string) : undefined,
                }
            }

            if (!text && !media) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "La réponse doit contenir un message ou un fichier" } })
                return
            }

            if (!waManager.isReady()) {
                res.status(503).json({
                    success: false,
                    error: { code: 'WHATSAPP_NOT_CONNECTED', message: "Le numéro WhatsApp admin n'est pas connecté — impossible d'envoyer la réponse pour le moment." },
                })
                return
            }

            const adminRecord = req.adminUser?.sub ? await getAdminById(req.adminUser.sub) : null
            const adminName   = adminRecord?.display_name || adminRecord?.email || 'Administrateur'
            const jid         = `${sanitizePhone(contactMessage.phone)}@s.whatsapp.net`

            // On enregistre d'abord la réponse (statut 'sent' par défaut), puis on
            // corrige son statut si l'envoi WhatsApp échoue réellement — ceci pour
            // garder une trace de la tentative même en cas d'échec.
            const reply = await createContactReply({
                contactMessageId: contactMessage.id,
                adminId:          req.adminUser?.sub ?? null,
                adminName,
                body:             text || null,
                mediaType:        media?.type ?? null,
                mediaMime:        media?.mime ?? null,
                mediaName:        media?.name ?? null,
            })

            try {
                await waManager.sendMessage(jid, text || null, media)
                await markContactMessageReplied(contactMessage.id)

                logger.info(
                    { component: 'AdminContact', contactMessageId: contactMessage.id, replyId: reply.id, phone: maskPhone(contactMessage.phone) },
                    'Réponse admin envoyée via WhatsApp'
                )

                res.status(201).json({ success: true, reply })
            } catch (sendErr) {
                const errMsg = sendErr instanceof Error ? sendErr.message : 'Erreur inconnue'
                await markContactReplyStatus(reply.id, 'failed', { errorMessage: errMsg })

                logger.error(
                    { component: 'AdminContact', contactMessageId: contactMessage.id, replyId: reply.id, err: sendErr },
                    "Échec de l'envoi de la réponse WhatsApp"
                )

                res.status(502).json({
                    success: false,
                    error: { code: 'SEND_FAILED', message: "La réponse a été enregistrée mais l'envoi WhatsApp a échoué : " + errMsg },
                    reply: { ...reply, status: 'failed', errorMessage: errMsg },
                })
            }
        } catch (err) {
            logger.error({ component: 'AdminContact', id, err }, "Erreur lors de l'envoi de la réponse")
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── GET /group — état du groupe WhatsApp admin ("Messages depuis Contact") ─
    router.get('/group', requireAdminAuth, async (_req, res) => {
        try {
            const groupJid = await getSetting(ADMIN_CONTACT_GROUP_KEY)

            if (!groupJid) {
                res.json({ success: true, configured: false })
                return
            }

            if (!waManager.isReady()) {
                res.json({ success: true, configured: true, groupJid, connected: false })
                return
            }

            try {
                const metadata = await waManager.getGroupMetadata(groupJid)
                res.json({
                    success: true,
                    configured: true,
                    connected: true,
                    groupJid,
                    name: metadata.subject,
                    participants: metadata.participants.map(p => ({ jid: p.id, isAdmin: p.admin === 'admin' || p.admin === 'superadmin' })),
                })
            } catch (err) {
                logger.warn({ component: 'AdminContact', groupJid, err }, 'Impossible de récupérer les métadonnées du groupe admin')
                res.json({ success: true, configured: true, connected: true, groupJid, error: 'Groupe introuvable ou admin retiré du groupe' })
            }
        } catch (err) {
            logger.error({ component: 'AdminContact', err }, 'Erreur récupération état du groupe admin')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── POST /group — créer le groupe WhatsApp admin (première configuration) ─
    router.post('/group', rateLimit, requireAdminAuth, async (req, res) => {
        const body = req.body as { name?: unknown; participants?: unknown }

        const existing = await getSetting(ADMIN_CONTACT_GROUP_KEY).catch(() => null)
        if (existing) {
            res.status(409).json({
                success: false,
                error: { code: 'GROUP_ALREADY_EXISTS', message: 'Un groupe admin est déjà configuré. Renommez-le ou gérez ses participants depuis cet espace.' },
            })
            return
        }

        if (typeof body.name !== 'string' || !body.name.trim()) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'name' est requis" } })
            return
        }
        if (!Array.isArray(body.participants) || body.participants.length === 0) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "'participants' doit contenir au moins un numéro WhatsApp (en plus du numéro admin, ajouté automatiquement)" },
            })
            return
        }

        const participants: string[] = []
        for (const raw of body.participants) {
            const trimmed = String(raw).trim()
            if (!trimmed) continue
            if (!PHONE_REGEX.test(trimmed)) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Numéro invalide : '${trimmed}'` } })
                return
            }
            participants.push(`${sanitizePhone(trimmed)}@s.whatsapp.net`)
        }

        if (!waManager.isReady()) {
            res.status(503).json({
                success: false,
                error: { code: 'WHATSAPP_NOT_CONNECTED', message: "Le numéro WhatsApp admin n'est pas connecté — impossible de créer le groupe pour le moment." },
            })
            return
        }

        try {
            const { groupJid, addedJids, invitedByLinkJids } = await waManager.createGroup(body.name.trim(), participants)
            await setSetting(ADMIN_CONTACT_GROUP_KEY, groupJid)

            logger.info(
                { component: 'AdminContact', groupJid, added: addedJids.length, invitedByLink: invitedByLinkJids.length },
                'Groupe WhatsApp admin créé depuis le backoffice'
            )

            res.status(201).json({
                success: true,
                groupJid,
                addedCount: addedJids.length,
                invitedByLinkCount: invitedByLinkJids.length,
            })
        } catch (err) {
            logger.error({ component: 'AdminContact', err }, 'Erreur création du groupe admin')
            res.status(502).json({
                success: false,
                error: { code: 'GROUP_CREATE_FAILED', message: err instanceof Error ? err.message : 'Erreur lors de la création du groupe' },
            })
        }
    })

    // ── PATCH /group — renommer le groupe ────────────────────────────────────
    router.patch('/group', rateLimit, requireAdminAuth, async (req, res) => {
        const body = req.body as { name?: unknown }
        if (typeof body.name !== 'string' || !body.name.trim()) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'name' est requis" } })
            return
        }

        const groupJid = await getSetting(ADMIN_CONTACT_GROUP_KEY)
        if (!groupJid) {
            res.status(404).json({ success: false, error: { code: 'GROUP_NOT_CONFIGURED', message: 'Aucun groupe admin configuré' } })
            return
        }
        if (!waManager.isReady()) {
            res.status(503).json({ success: false, error: { code: 'WHATSAPP_NOT_CONNECTED', message: "Le numéro WhatsApp admin n'est pas connecté." } })
            return
        }

        try {
            await waManager.updateGroupSubject(groupJid, body.name.trim())
            res.json({ success: true })
        } catch (err) {
            logger.error({ component: 'AdminContact', groupJid, err }, 'Erreur renommage du groupe admin')
            res.status(502).json({ success: false, error: { code: 'GROUP_UPDATE_FAILED', message: err instanceof Error ? err.message : 'Erreur lors du renommage' } })
        }
    })

    // ── POST /group/participants — ajouter des participants ─────────────────
    router.post('/group/participants', rateLimit, requireAdminAuth, async (req, res) => {
        const body = req.body as { participants?: unknown }
        if (!Array.isArray(body.participants) || body.participants.length === 0) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'participants' doit contenir au moins un numéro" } })
            return
        }

        const groupJid = await getSetting(ADMIN_CONTACT_GROUP_KEY)
        if (!groupJid) {
            res.status(404).json({ success: false, error: { code: 'GROUP_NOT_CONFIGURED', message: 'Aucun groupe admin configuré' } })
            return
        }
        if (!waManager.isReady()) {
            res.status(503).json({ success: false, error: { code: 'WHATSAPP_NOT_CONNECTED', message: "Le numéro WhatsApp admin n'est pas connecté." } })
            return
        }

        const participants: string[] = []
        for (const raw of body.participants) {
            const trimmed = String(raw).trim()
            if (!trimmed) continue
            if (!PHONE_REGEX.test(trimmed)) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Numéro invalide : '${trimmed}'` } })
                return
            }
            participants.push(`${sanitizePhone(trimmed)}@s.whatsapp.net`)
        }

        try {
            const { addedJids, invitedByLinkJids } = await waManager.addGroupParticipants(groupJid, participants)
            res.json({ success: true, addedCount: addedJids.length, invitedByLinkCount: invitedByLinkJids.length })
        } catch (err) {
            logger.error({ component: 'AdminContact', groupJid, err }, 'Erreur ajout de participants au groupe admin')
            res.status(502).json({ success: false, error: { code: 'GROUP_UPDATE_FAILED', message: err instanceof Error ? err.message : "Erreur lors de l'ajout" } })
        }
    })

    // ── DELETE /group/participants — retirer des participants ───────────────
    router.delete('/group/participants', rateLimit, requireAdminAuth, async (req, res) => {
        const body = req.body as { participants?: unknown }
        if (!Array.isArray(body.participants) || body.participants.length === 0) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'participants' doit contenir au moins un numéro" } })
            return
        }

        const groupJid = await getSetting(ADMIN_CONTACT_GROUP_KEY)
        if (!groupJid) {
            res.status(404).json({ success: false, error: { code: 'GROUP_NOT_CONFIGURED', message: 'Aucun groupe admin configuré' } })
            return
        }
        if (!waManager.isReady()) {
            res.status(503).json({ success: false, error: { code: 'WHATSAPP_NOT_CONNECTED', message: "Le numéro WhatsApp admin n'est pas connecté." } })
            return
        }

        const participantJids: string[] = (body.participants as unknown[])
            .map(raw => {
                const trimmed = String(raw).trim()
                return trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@g.us')
                    ? trimmed
                    : `${sanitizePhone(trimmed)}@s.whatsapp.net`
            })
            .filter(Boolean)

        try {
            await waManager.removeGroupParticipants(groupJid, participantJids)
            res.json({ success: true })
        } catch (err) {
            logger.error({ component: 'AdminContact', groupJid, err }, 'Erreur retrait de participants du groupe admin')
            res.status(502).json({ success: false, error: { code: 'GROUP_UPDATE_FAILED', message: err instanceof Error ? err.message : 'Erreur lors du retrait' } })
        }
    })

    // ── GET /group/invite-code — lien d'invitation du groupe ────────────────
    router.get('/group/invite-code', requireAdminAuth, async (_req, res) => {
        const groupJid = await getSetting(ADMIN_CONTACT_GROUP_KEY)
        if (!groupJid) {
            res.status(404).json({ success: false, error: { code: 'GROUP_NOT_CONFIGURED', message: 'Aucun groupe admin configuré' } })
            return
        }
        if (!waManager.isReady()) {
            res.status(503).json({ success: false, error: { code: 'WHATSAPP_NOT_CONNECTED', message: "Le numéro WhatsApp admin n'est pas connecté." } })
            return
        }

        try {
            const code = await waManager.getGroupInviteCode(groupJid)
            res.json({ success: true, inviteLink: `https://chat.whatsapp.com/${code}` })
        } catch (err) {
            logger.error({ component: 'AdminContact', groupJid, err }, "Erreur récupération du lien d'invitation")
            res.status(502).json({ success: false, error: { code: 'GROUP_INVITE_FAILED', message: err instanceof Error ? err.message : 'Erreur lors de la récupération du lien' } })
        }
    })

    return router
}
