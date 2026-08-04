/**
 * contact.ts — Routes contact et communauté Convessa.
 *
 * POST /api/v1/contact       — Envoie un message de contact :
 *                                1) enregistre la demande en base
 *                                2) confirme au demandeur par WhatsApp (numéro admin → son numéro)
 *                                3) transmet la demande au groupe WhatsApp admin (ou, à défaut,
 *                                   au numéro admin personnel si le groupe n'est pas configuré)
 * POST /api/v1/community     — Rejoint la communauté Convessa (avec ou sans compte)
 * GET  /api/admin/community  — Liste les membres communauté (admin)
 *
 * Les routes de gestion des messages de contact côté admin (liste, réponse,
 * fil de discussion) vivent dans adminContact.ts (/api/admin/contact/*).
 */

import { Router }          from 'express'
import { v4 as uuidv4 }   from 'uuid'
import { requireAdminAuth }    from '../middleware/adminAuth.js'
import { rateLimit }           from '../middleware/rateLimit.js'
import { query, execute }      from '../../db/connection.js'
import { WhatsAppManager }     from '../../whatsapp/WhatsAppManager.js'
import { logger, maskPhone }   from '../../services/logger.js'
import { normalizePhone }      from '../../services/phoneUtils.js'
import {
    createContactMessage,
    markContactMessageUserNotified,
    markContactMessageGroupNotified,
}                               from '../../db/ContactStore.js'
import { getSetting, ADMIN_CONTACT_GROUP_KEY } from '../../db/SettingsStore.js'

const PHONE_REGEX = /^[+\d\s\-().]+$/
const MAX_MESSAGE_LENGTH = 2000

function sanitizePhone(raw: string): string {
    return normalizePhone(raw)
}

// ── Groupe WhatsApp dédié à l'administration ──────────────────────────────────
// Résolu dans cet ordre :
//   1) Groupe créé depuis le backoffice ("Messages depuis Contact") — stocké
//      en base (app_settings) via ADMIN_CONTACT_GROUP_KEY.
//   2) Variable d'environnement ADMIN_WHATSAPP_GROUP_ID (repli de configuration
//      manuelle), avec ou sans le suffixe "@g.us".
async function getAdminGroupJid(): Promise<string | null> {
    const stored = await getSetting(ADMIN_CONTACT_GROUP_KEY)
    if (stored?.trim()) return stored.trim()

    const raw = process.env['ADMIN_WHATSAPP_GROUP_ID']?.trim()
    if (!raw) return null
    return raw.endsWith('@g.us') ? raw : `${raw}@g.us`
}

export function contactRouter(waManager: WhatsAppManager): Router {
    const router = Router()

    // ── POST /api/v1/contact ──────────────────────────────────────────────────
    router.post('/contact', rateLimit, async (req, res) => {
        const { name, email, phone, subject, message } = req.body as {
            name?: string; email?: string; phone?: string; subject?: string; message?: string
        }

        if (!name?.trim() || !email?.trim() || !phone?.trim() || !subject?.trim() || !message?.trim()) {
            res.status(400).json({
                success: false,
                error: { code: 'MISSING_FIELDS', message: 'name, email, phone, subject et message sont requis' },
            })
            return
        }

        if (!PHONE_REGEX.test(phone.trim())) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Numéro de téléphone invalide' },
            })
            return
        }

        if (message.trim().length > MAX_MESSAGE_LENGTH) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: `Le message ne peut pas dépasser ${MAX_MESSAGE_LENGTH} caractères` },
            })
            return
        }

        const trimmedName    = name.trim()
        const trimmedEmail   = email.trim()
        const trimmedPhone   = phone.trim()
        const trimmedSubject = subject.trim()
        const trimmedMessage = message.trim()
        const submitterJid   = `${sanitizePhone(trimmedPhone)}@s.whatsapp.net`

        try {
            const created = await createContactMessage({
                name:    trimmedName,
                email:   trimmedEmail,
                phone:   trimmedPhone,
                subject: trimmedSubject,
                message: trimmedMessage,
            })

            // ── 1) Confirmation personnalisée au demandeur (depuis le numéro admin) ──
            if (waManager.isReady()) {
                const firstName  = trimmedName.split(/\s+/)[0]
                const userText =
                    `Bonjour ${firstName},\n\n` +
                    `Nous avons bien reçu votre demande concernant : "${trimmedSubject}".\n` +
                    `Notre équipe la prend en charge et vous répondra directement sur ce numéro WhatsApp dans les plus brefs délais.\n\n` +
                    `Merci de votre confiance.\n` +
                    `— L'équipe Convessa`

                waManager.sendMessage(submitterJid, userText)
                    .then(() => markContactMessageUserNotified(created.id))
                    .catch(err => {
                        logger.warn(
                            { component: 'Contact', id: created.id, phone: maskPhone(trimmedPhone), err },
                            "Impossible d'envoyer la confirmation WhatsApp au demandeur"
                        )
                    })
            } else {
                logger.warn({ component: 'Contact', id: created.id }, 'WhatsApp admin non connecté — confirmation au demandeur non envoyée')
            }

            // ── 2) Transmission au groupe WhatsApp admin ────────────────────────────
            const groupJid = await getAdminGroupJid()
            const adminJid = waManager.getConnectedJid()
            const destinationJid = groupJid ?? adminJid

            if (destinationJid && waManager.isReady()) {
                const text =
                    `*Nouvelle demande reçue via le formulaire de contact*\n\n` +
                    `Nom : ${trimmedName}\n\n` +
                    `Email : ${trimmedEmail}\n\n` +
                    `Téléphone : ${trimmedPhone}\n\n` +
                    `Sujet : ${trimmedSubject}\n\n` +
                    `Message :\n_${trimmedMessage}_\n\n` +
                    `Répondez depuis l'espace "Messages depuis Contact" du backoffice admin.`

                waManager.sendMessage(destinationJid, text)
                    .then(() => {
                        if (groupJid) markContactMessageGroupNotified(created.id)
                    })
                    .catch(err => {
                        logger.warn(
                            { component: 'Contact', id: created.id, err },
                            "Impossible de notifier l'administration via WhatsApp"
                        )
                    })
            } else if (!destinationJid) {
                logger.warn(
                    { component: 'Contact', id: created.id },
                    'Aucun groupe admin configuré et compte admin non connecté — notification admin non envoyée'
                )
            }

            logger.info({ component: 'Contact', id: created.id, email: trimmedEmail }, 'Message de contact reçu')
            res.status(201).json({
                success: true,
                id:      created.id,
                message: 'Message envoyé avec succès. Vous recevrez une confirmation sur WhatsApp et nous vous répondrons bientôt !',
            })

        } catch (err) {
            logger.error({ component: 'Contact', err }, 'Erreur enregistrement message contact')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── POST /api/v1/community ────────────────────────────────────────────────
    router.post('/community', rateLimit, async (req, res) => {
        const { firstName, lastName, phone, email, userUid } = req.body as {
            firstName?: string; lastName?: string; phone?: string; email?: string; userUid?: string
        }

        if (!firstName?.trim() || !lastName?.trim() || !phone?.trim()) {
            res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'firstName, lastName et phone sont requis' } })
            return
        }

        try {
            // Vérifier si déjà membre
            const existing = await query<{ id: string }>(
                'SELECT id FROM community_members WHERE phone = ? LIMIT 1',
                [phone.trim()]
            )
            if (existing.length > 0) {
                res.json({ success: true, alreadyMember: true, message: 'Vous faites déjà partie de la communauté !' })
                return
            }

            const id = uuidv4()
            await execute(
                `INSERT INTO community_members (id, first_name, last_name, phone, email, user_uid) VALUES (?, ?, ?, ?, ?, ?)`,
                [id, firstName.trim(), lastName.trim(), phone.trim(), email?.trim() ?? null, userUid ?? null]
            )

            // Notifier l'admin
            const adminJid = waManager.getConnectedJid()
            if (adminJid && waManager.isReady()) {
                const text = `🎉 *Nouveau membre Communauté Convessa*\n\n` +
                    `*Nom :* ${firstName.trim()} ${lastName.trim()}\n` +
                    `*Tél :* ${phone.trim()}\n` +
                    (email?.trim() ? `*Email :* ${email.trim()}\n` : '')

                waManager.sendMessage(adminJid, text).catch(() => {})
            }

            logger.info({ component: 'Community', id, phone: phone.trim() }, 'Nouveau membre communauté')
            res.status(201).json({ success: true, message: 'Bienvenue dans la communauté Convessa ! 🎉' })

        } catch (err) {
            logger.error({ component: 'Community', err }, 'Erreur inscription communauté')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── GET /api/admin/community — membres communauté (admin) ─────────────────
    router.get('/admin-community', requireAdminAuth, async (req, res) => {
        const page  = Math.max(1, parseInt(req.query['page'] as string || '1', 10))
        const limit = Math.min(100, parseInt(req.query['limit'] as string || '50', 10))
        const offset = (page - 1) * limit
        try {
            const members = await query(
                `SELECT * FROM community_members ORDER BY joined_at DESC LIMIT ? OFFSET ?`,
                [limit, offset]
            )
            const countRows = await query<{ total: number }>('SELECT COUNT(*) AS total FROM community_members')
            res.json({ success: true, members, total: countRows[0]?.total ?? 0 })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur liste membres communauté')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    return router
}
