/**
 * messages.ts — Routes d'envoi et de suivi des messages.
 *
 * POST /api/v1/messages/send  — Texte seul, média seul, ou texte + média
 * GET  /api/v1/messages/:id   — Statut d'un message
 */

import { Router }          from 'express'
import { requireApiKey }   from '../middleware/auth.js'
import { rateLimit }       from '../middleware/rateLimit.js'
import { WhatsAppManager } from '../../whatsapp/WhatsAppManager.js'
import { enqueue, getById, getPosition } from '../../db/MessageQueue.js'
import type { MediaPayload, MediaType }  from '../../db/MessageQueue.js'
import { validateMedia, getMediaRules }  from '../../services/mediaValidator.js'
import { config }          from '../../config.js'
import { logger, maskPhone } from '../../services/logger.js'

const PHONE_REGEX = /^[+\d\s\-()]+$/
const VALID_MEDIA_TYPES: MediaType[] = ['image', 'video', 'audio', 'document']

function sanitizePhone(raw: string): string {
    return raw.replace(/[\s\-()]/g, '').replace(/^\+/, '')
}

export function messagesRouter(waManager: WhatsAppManager): Router {
    const router = Router()

    // ── POST /api/v1/messages/send ────────────────────────────────────────────
    router.post('/messages/send', rateLimit, requireApiKey, async (req, res) => {
        const body = req.body as {
            to?:      unknown
            message?: unknown
            media?:   unknown
        }

        // ── Validation de 'to' ────────────────────────────────────────────────
        if (body.to === undefined || body.to === null) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "Le champ 'to' est requis" } })
            return
        }
        if (typeof body.to !== 'string') {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "Le champ 'to' doit être une chaîne de caractères" } })
            return
        }
        const toTrimmed = body.to.trim()
        if (!toTrimmed) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "Le champ 'to' ne peut pas être vide" } })
            return
        }
        if (!PHONE_REGEX.test(toTrimmed)) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Format de numéro invalide — chiffres uniquement, indicatif international requis' } })
            return
        }

        // ── Validation de 'message' ───────────────────────────────────────────
        let messageTrimmed: string | undefined

        if (body.message !== undefined && body.message !== null) {
            if (typeof body.message !== 'string') {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "Le champ 'message' doit être une chaîne de caractères" } })
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

            // type
            if (!m['type'] || !VALID_MEDIA_TYPES.includes(m['type'] as MediaType)) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `'media.type' invalide. Valeurs acceptées : ${VALID_MEDIA_TYPES.join(', ')}` } })
                return
            }

            // mime
            if (!m['mime'] || typeof m['mime'] !== 'string') {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'media.mime' est requis (ex: 'image/jpeg', 'application/pdf')" } })
                return
            }

            // url ou base64
            const hasUrl    = typeof m['url']    === 'string' && (m['url'] as string).trim().length > 0
            const hasBase64 = typeof m['base64'] === 'string' && (m['base64'] as string).trim().length > 0

            if (!hasUrl && !hasBase64) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'media' doit contenir soit 'url' (URL publique) soit 'base64' (données encodées)" } })
                return
            }

            // Validation WhatsApp (type, mime, taille)
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

        // ── Doit avoir au moins message ou média ──────────────────────────────
        if (!messageTrimmed && !mediaPayload) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "La requête doit contenir au moins 'message' ou 'media'" } })
            return
        }

        // ── WhatsApp connecté ? ───────────────────────────────────────────────
        if (!waManager.isReady()) {
            res.status(503).json({ success: false, error: { code: 'SERVICE_NOT_CONNECTED', message: "Le service WhatsApp n'est pas connecté" } })
            return
        }

        try {
            const recipient        = sanitizePhone(toTrimmed)
            const { id, position } = await enqueue({
                recipient,
                message: messageTrimmed,
                media:   mediaPayload,
            })

            logger.info(
                { component: 'API', messageId: id, recipient: maskPhone(recipient), hasMedia: !!mediaPayload, position },
                'Message mis en file'
            )

            res.status(202).json({ success: true, queued: true, messageId: id, position })

        } catch (err) {
            logger.error({ component: 'API', err }, 'Erreur enqueue')
            res.status(500).json({
                success: false,
                error: {
                    code:    'INTERNAL_ERROR',
                    message: config.isProd ? 'Erreur interne' : (err instanceof Error ? err.message : 'Erreur inconnue'),
                },
            })
        }
    })

    // ── GET /api/v1/messages/:id ──────────────────────────────────────────────
    router.get('/messages/:id', requireApiKey, async (req, res) => {
        const { id } = req.params

        if (!id || typeof id !== 'string') {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'ID de message invalide' } })
            return
        }

        try {
            const msg = await getById(id)

            if (!msg) {
                res.status(404).json({ success: false, error: { code: 'MESSAGE_NOT_FOUND', message: 'Aucun message trouvé pour cet identifiant' } })
                return
            }

            const response: Record<string, unknown> = {
                success:   true,
                messageId: msg.id,
                status:    msg.status,
                to:        maskPhone(msg.recipient),
                hasMedia:  !!msg.media,
                mediaType: msg.media?.type ?? null,
                attempts:  msg.attempts,
                queuedAt:  msg.queuedAt,
            }

            if (msg.status === 'queued' || msg.status === 'sending') {
                response['position'] = await getPosition(msg.id)
            }
            if (msg.sentAt)    response['sentAt'] = msg.sentAt
            if (msg.lastError) response['error']  = msg.lastError

            res.json(response)

        } catch (err) {
            logger.error({ component: 'API', err }, 'Erreur get message')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── GET /api/v1/messages/media-limits ────────────────────────────────────
    // Endpoint utilitaire — permet à un service consommateur de connaître
    // les limites acceptées sans lire la documentation
    router.get('/messages/media-limits', requireApiKey, (_req, res) => {
        res.json({ success: true, limits: getMediaRules() })
    })

    return router
}
