/**
 * contact.ts — Routes contact et communauté Convessa.
 *
 * POST /api/v1/contact       — Envoie un message de contact (notifie l'admin via WhatsApp)
 * POST /api/v1/community     — Rejoint la communauté Convessa (avec ou sans compte)
 * GET  /api/admin/contact    — Liste les messages de contact (admin)
 * GET  /api/admin/community  — Liste les membres communauté (admin)
 */

import { Router }          from 'express'
import { v4 as uuidv4 }   from 'uuid'
import { requireFirebaseAuth } from '../middleware/firebaseAuth.js'
import { requireAdminAuth }    from '../middleware/adminAuth.js'
import { rateLimit }           from '../middleware/rateLimit.js'
import { query, execute }      from '../../db/connection.js'
import { WhatsAppManager }     from '../../whatsapp/WhatsAppManager.js'
import { logger }              from '../../services/logger.js'
import { config }              from '../../config.js'

// ── Numéro WhatsApp admin qui reçoit les messages de contact ──────────────────
// Configuré via ADMIN_WHATSAPP_NUMBER dans .env (ex: 22990000000)
function getAdminJid(): string | null {
    const num = process.env['ADMIN_WHATSAPP_NUMBER']?.trim()
    if (!num) return null
    const clean = num.replace(/[^0-9]/g, '')
    return `${clean}@s.whatsapp.net`
}

export function contactRouter(waManager: WhatsAppManager): Router {
    const router = Router()

    // ── POST /api/v1/contact ──────────────────────────────────────────────────
    router.post('/contact', rateLimit, async (req, res) => {
        const { name, email, phone, subject, message } = req.body as {
            name?: string; email?: string; phone?: string; subject?: string; message?: string
        }

        if (!name?.trim() || !email?.trim() || !subject?.trim() || !message?.trim()) {
            res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'name, email, subject et message sont requis' } })
            return
        }

        try {
            const id = uuidv4()
            await execute(
                `INSERT INTO contact_messages (id, name, email, phone, subject, message, status) VALUES (?, ?, ?, ?, ?, ?, 'unread')`,
                [id, name.trim(), email.trim(), phone?.trim() ?? null, subject.trim(), message.trim()]
            )

            // Notifier l'admin via WhatsApp si le numéro admin est configuré et connecté
            const adminJid = getAdminJid()
            if (adminJid && waManager.isReady()) {
                const text = `📩 *Nouveau message de contact*\n\n` +
                    `*Nom :* ${name.trim()}\n` +
                    `*Email :* ${email.trim()}\n` +
                    (phone?.trim() ? `*Tél :* ${phone.trim()}\n` : '') +
                    `*Sujet :* ${subject.trim()}\n\n` +
                    `*Message :*\n${message.trim()}`

                waManager.sendMessage(adminJid, text).catch(err => {
                    logger.warn({ component: 'Contact', err }, 'Impossible de notifier l\'admin via WhatsApp')
                })
            }

            logger.info({ component: 'Contact', id, email: email.trim() }, 'Message de contact reçu')
            res.status(201).json({ success: true, message: 'Message envoyé avec succès. Nous vous répondrons bientôt !' })

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
            const adminJid = getAdminJid()
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

    // ── GET /api/admin/contact — messages de contact (admin) ──────────────────
    router.get('/admin-contact', requireAdminAuth, async (req, res) => {
        const page  = Math.max(1, parseInt(req.query['page'] as string || '1', 10))
        const limit = Math.min(50, parseInt(req.query['limit'] as string || '20', 10))
        const offset = (page - 1) * limit
        try {
            const messages = await query(
                `SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                [limit, offset]
            )
            const countRows = await query<{ total: number }>('SELECT COUNT(*) AS total FROM contact_messages')
            res.json({ success: true, messages, total: countRows[0]?.total ?? 0 })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur liste messages contact')
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
