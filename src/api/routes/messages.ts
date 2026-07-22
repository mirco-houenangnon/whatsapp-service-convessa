/**
 * messages.ts — Routes d'envoi et de suivi des messages.
 *
 * POST /api/v1/messages/send  — Ajoute un message à la file d'attente
 * GET  /api/v1/messages/:id   — Consulte le statut d'un message
 */

import { Router }          from 'express'
import { requireApiKey }   from '../middleware/auth.js'
import { rateLimit }       from '../middleware/rateLimit.js'
import { WhatsAppManager } from '../../whatsapp/WhatsAppManager.js'
import { enqueue, getById, getPosition } from '../../db/MessageQueue.js'
import { config }          from '../../config.js'
import { logger, maskPhone } from '../../services/logger.js'

// Regex numéro international — chiffres, +, espaces, tirets uniquement
const PHONE_REGEX = /^[+\d\s\-()]+$/

function sanitizePhone(raw: string): string {
    return raw.replace(/[\s\-()]/g, '').replace(/^\+/, '')
}

export function messagesRouter(waManager: WhatsAppManager): Router {
    const router = Router()

    // ── POST /api/v1/messages/send ────────────────────────────────────────────
    router.post('/messages/send', rateLimit, requireApiKey, async (req, res) => {

        const { to, message } = req.body as { to?: unknown; message?: unknown }

        // Validation du champ 'to'
        if (to === undefined || to === null) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'to' est requis" },
            })
            return
        }
        if (typeof to !== 'string') {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'to' doit être une chaîne de caractères" },
            })
            return
        }

        const toTrimmed = to.trim()
        if (!toTrimmed) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'to' ne peut pas être vide" },
            })
            return
        }
        if (!PHONE_REGEX.test(toTrimmed)) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Format de numéro invalide — chiffres uniquement, indicatif international requis' },
            })
            return
        }

        // Validation du champ 'message'
        if (message === undefined || message === null) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'message' est requis" },
            })
            return
        }
        if (typeof message !== 'string') {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'message' doit être une chaîne de caractères" },
            })
            return
        }

        const messageTrimmed = message.trim()
        if (!messageTrimmed) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Le message ne peut pas être vide' },
            })
            return
        }
        if (messageTrimmed.length > 4096) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Le message ne peut pas dépasser 4096 caractères' },
            })
            return
        }

        // Vérification de la connexion WhatsApp
        if (!waManager.isReady()) {
            res.status(503).json({
                success: false,
                error: { code: 'SERVICE_NOT_CONNECTED', message: "Le service WhatsApp n'est pas connecté" },
            })
            return
        }

        try {
            const recipient       = sanitizePhone(toTrimmed)
            const { id, position } = await enqueue(recipient, messageTrimmed)

            logger.info(
                { component: 'API', messageId: id, recipient: maskPhone(recipient), position },
                'Message mis en file'
            )

            res.status(202).json({
                success:   true,
                queued:    true,
                messageId: id,
                position,
            })

        } catch (err) {
            logger.error({ component: 'API', err }, 'Erreur enqueue')
            res.status(500).json({
                success: false,
                error: {
                    code:    'INTERNAL_ERROR',
                    message: config.isProd
                        ? 'Erreur interne'
                        : (err instanceof Error ? err.message : 'Erreur inconnue'),
                },
            })
        }
    })

    // ── GET /api/v1/messages/:id ──────────────────────────────────────────────
    router.get('/messages/:id', requireApiKey, async (req, res) => {
        const { id } = req.params

        if (!id || typeof id !== 'string') {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'ID de message invalide' },
            })
            return
        }

        try {
            const msg = await getById(id)

            if (!msg) {
                res.status(404).json({
                    success: false,
                    error: { code: 'MESSAGE_NOT_FOUND', message: 'Aucun message trouvé pour cet identifiant' },
                })
                return
            }

            // Masquer le numéro dans la réponse
            const masked = maskPhone(msg.recipient)

            const response: Record<string, unknown> = {
                success:   true,
                messageId: msg.id,
                status:    msg.status,
                to:        masked,
                attempts:  msg.attempts,
                queuedAt:  msg.queuedAt,
            }

            if (msg.status === 'queued' || msg.status === 'sending') {
                response['position'] = await getPosition(msg.id)
            }
            if (msg.sentAt) {
                response['sentAt'] = msg.sentAt
            }
            if (msg.lastError) {
                response['error'] = msg.lastError
            }

            res.json(response)

        } catch (err) {
            logger.error({ component: 'API', err }, 'Erreur get message')
            res.status(500).json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' },
            })
        }
    })

    return router
}
