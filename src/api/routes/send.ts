/**
 * send.ts — Route d'envoi de messages depuis la session WhatsApp d'un tenant.
 *
 * Authentification : clé API tenant (X-Api-Key: wag_live_...)
 * La clé identifie le tenant = l'émetteur WhatsApp.
 * Le développeur précise uniquement le destinataire (to) et le contenu.
 *
 * POST /api/v1/send
 * Body: { to: "22960000000", message?: "...", media?: { type, mime, url|base64, name? } }
 *
 * Différence avec /api/v1/messages/send :
 *   - Authentification par clé tenant (pas la clé Bridge globale)
 *   - Envoi depuis la session WhatsApp propre du tenant
 *   - Le destinataire `to` est obligatoire
 */

import { Router }              from 'express'
import { requireTenantApiKey } from '../middleware/tenantAuth.js'
import { rateLimit }           from '../middleware/rateLimit.js'
import { TenantManager }       from '../../whatsapp/TenantManager.js'
import { validateMedia, getMediaRules } from '../../services/mediaValidator.js'
import { logger, maskPhone }   from '../../services/logger.js'
import { config }              from '../../config.js'
import type { MediaPayload, MediaType } from '../../db/MessageQueue.js'

const PHONE_REGEX        = /^[+\d\s\-()]+$/
const VALID_MEDIA_TYPES: MediaType[] = ['image', 'video', 'audio', 'document']

function sanitizePhone(raw: string): string {
    return raw.replace(/[\s\-()]/g, '').replace(/^\+/, '')
}

export function sendRouter(tenantManager: TenantManager): Router {
    const router = Router()

    // ── POST /api/v1/send ──────────────────────────────────────────────────────
    /**
     * @swagger
     * /api/v1/send:
     *   post:
     *     tags: [Envoi Tenant]
     *     summary: Envoyer un message depuis votre compte WhatsApp
     *     description: |
     *       Authentifiez-vous avec votre clé API tenant (X-Api-Key).
     *       Le message sera envoyé depuis le numéro WhatsApp que vous avez scanné.
     *       Le champ `to` (destinataire) est toujours obligatoire.
     *     security:
     *       - tenantApiKey: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [to]
     *             properties:
     *               to:
     *                 type: string
     *                 description: Numéro du destinataire (indicatif international, sans +)
     *                 example: "22960000000"
     *               message:
     *                 type: string
     *                 description: Texte du message (max 4096 caractères)
     *               media:
     *                 type: object
     *                 properties:
     *                   type: { type: string, enum: [image, video, audio, document] }
     *                   mime: { type: string, example: "image/jpeg" }
     *                   url:  { type: string, description: "URL publique du média" }
     *                   base64: { type: string, description: "Données base64 du média" }
     *                   name:   { type: string, description: "Nom du fichier (documents)" }
     *     responses:
     *       202:
     *         description: Message mis en file d'attente
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success:   { type: boolean }
     *                 messageId: { type: string }
     *                 from:      { type: string, description: "Numéro émetteur masqué" }
     *                 to:        { type: string, description: "Numéro destinataire masqué" }
     *       401:
     *         description: Clé API invalide ou manquante
     *       403:
     *         description: Session WhatsApp déconnectée
     *       503:
     *         description: Session tenant non connectée
     */
    router.post('/send', rateLimit, requireTenantApiKey, async (req, res) => {
        const tenant = req.tenant!
        const body   = req.body as {
            to?:      unknown
            message?: unknown
            media?:   unknown
        }

        // ── Validation de 'to' ────────────────────────────────────────────────
        if (!body.to || typeof body.to !== 'string' || !body.to.trim()) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'to' (destinataire) est obligatoire" },
            })
            return
        }

        if (!PHONE_REGEX.test(body.to.trim())) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Format du numéro 'to' invalide — indicatif international requis (ex: 22960000000)" },
            })
            return
        }

        // ── Validation de 'message' ───────────────────────────────────────────
        let messageTrimmed: string | undefined

        if (body.message !== undefined && body.message !== null) {
            if (typeof body.message !== 'string') {
                res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: "'message' doit être une chaîne de caractères" },
                })
                return
            }
            messageTrimmed = body.message.trim()
            if (!messageTrimmed) {
                res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: "Le message ne peut pas être vide" },
                })
                return
            }
            if (messageTrimmed.length > 4096) {
                res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: "Le message ne peut pas dépasser 4096 caractères" },
                })
                return
            }
        }

        // ── Validation du média ───────────────────────────────────────────────
        let mediaPayload: MediaPayload | undefined

        if (body.media !== undefined && body.media !== null) {
            if (typeof body.media !== 'object' || Array.isArray(body.media)) {
                res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: "'media' doit être un objet" },
                })
                return
            }

            const m = body.media as Record<string, unknown>

            if (!m['type'] || !VALID_MEDIA_TYPES.includes(m['type'] as MediaType)) {
                res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: `'media.type' invalide. Valeurs acceptées : ${VALID_MEDIA_TYPES.join(', ')}` },
                })
                return
            }
            if (!m['mime'] || typeof m['mime'] !== 'string') {
                res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: "'media.mime' est requis (ex: 'image/jpeg')" },
                })
                return
            }

            const hasUrl    = typeof m['url']    === 'string' && (m['url'] as string).trim().length > 0
            const hasBase64 = typeof m['base64'] === 'string' && (m['base64'] as string).trim().length > 0

            if (!hasUrl && !hasBase64) {
                res.status(400).json({
                    success: false,
                    error: { code: 'VALIDATION_ERROR', message: "'media' doit contenir 'url' ou 'base64'" },
                })
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

        // ── Doit avoir au moins message ou média ──────────────────────────────
        if (!messageTrimmed && !mediaPayload) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "La requête doit contenir au moins 'message' ou 'media'" },
            })
            return
        }

        // ── Session tenant connectée ? ────────────────────────────────────────
        if (!tenantManager.isConnected(tenant.id)) {
            res.status(503).json({
                success: false,
                error: {
                    code:    'SESSION_NOT_CONNECTED',
                    message: 'Votre session WhatsApp n\'est pas connectée. Scannez le QR code depuis votre dashboard.',
                },
            })
            return
        }

        // ── Envoi ─────────────────────────────────────────────────────────────
        try {
            const recipient = sanitizePhone(body.to.trim())
            const remoteJid = `${recipient}@s.whatsapp.net`

            await tenantManager.sendMessageAsTenant(
                tenant.id,
                remoteJid,
                messageTrimmed ?? null,
                mediaPayload,
            )

            logger.info(
                {
                    component: 'SendRoute',
                    tenantId:  tenant.id,
                    from:      maskPhone(tenant.phone),
                    to:        maskPhone(recipient),
                    hasMedia:  !!mediaPayload,
                },
                'Message envoyé via session tenant'
            )

            res.status(202).json({
                success:  true,
                sent:     true,
                from:     maskPhone(tenant.phone),
                to:       maskPhone(recipient),
                message:  messageTrimmed ?? null,
                hasMedia: !!mediaPayload,
            })

        } catch (err) {
            logger.error({ component: 'SendRoute', tenantId: tenant.id, err }, 'Erreur envoi message tenant')
            res.status(500).json({
                success: false,
                error: {
                    code:    'SEND_ERROR',
                    message: config.isProd ? 'Erreur lors de l\'envoi' : (err instanceof Error ? err.message : String(err)),
                },
            })
        }
    })

    // ── GET /api/v1/send/info ─────────────────────────────────────────────────
    // Retourne les infos de la session liée à cette clé API
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

    return router
}
