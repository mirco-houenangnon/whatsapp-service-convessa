/**
 * admin.ts — Routes du backoffice administrateur Convessa.
 *
 * POST   /api/admin/login           — Connexion (email + password → JWT)
 * POST   /api/admin/logout          — Déconnexion (invalide le cookie)
 * GET    /api/admin/me              — Profil de l'admin connecté
 * PUT    /api/admin/me              — Mettre à jour son profil
 * PUT    /api/admin/me/password     — Changer son mot de passe
 *
 * GET    /api/admin/stats           — Statistiques globales
 * GET    /api/admin/tenants         — Liste des tenants
 * GET    /api/admin/users           — Liste des utilisateurs Firebase
 */

import { Router }            from 'express'
import { requireAdminAuth }  from '../middleware/adminAuth.js'
import {
    getAdminByEmail,
    getAdminById,
    updateAdminLastLogin,
    updateAdminPassword,
    updateAdminProfile,
    verifyPassword,
    sanitizeAdmin,
}                            from '../../db/AdminStore.js'
import { createAdminToken }  from '../../services/adminJwt.js'
import { listTenants }       from '../../db/TenantStore.js'
import { listUsers }         from '../../db/UserStore.js'
import { getPool }           from '../../db/connection.js'
import { logger }            from '../../services/logger.js'
import { config }            from '../../config.js'

// Durée du cookie : 24h
const COOKIE_MAX_AGE = 24 * 60 * 60 * 1000

export function adminRouter(): Router {
    const router = Router()

    // ── POST /api/admin/login ─────────────────────────────────────────────────
    router.post('/login', async (req, res) => {
        const { email, password } = req.body as { email?: unknown; password?: unknown }

        if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Email et mot de passe requis' },
            })
            return
        }

        try {
            const admin = await getAdminByEmail(email)

            if (!admin || !verifyPassword(password, admin.password_hash)) {
                // Délai anti-bruteforce
                await new Promise(r => setTimeout(r, 300))
                res.status(401).json({
                    success: false,
                    error: { code: 'INVALID_CREDENTIALS', message: 'Email ou mot de passe incorrect' },
                })
                return
            }

            await updateAdminLastLogin(admin.id)

            const token = createAdminToken(admin.id)

            // Cookie HTTP-only pour le dashboard HTML
            res.cookie('admin_token', token, {
                httpOnly: true,
                secure:   config.isProd,
                sameSite: 'strict',
                maxAge:   COOKIE_MAX_AGE,
                path:     '/',
            })

            logger.info({ component: 'Admin', adminId: admin.id, email: admin.email }, 'Admin connecté')

            res.json({
                success: true,
                token,
                admin:   sanitizeAdmin(admin),
            })

        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur login admin')
            res.status(500).json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' },
            })
        }
    })

    // ── POST /api/admin/logout ────────────────────────────────────────────────
    router.post('/logout', (req, res) => {
        res.clearCookie('admin_token', { path: '/' })
        res.json({ success: true, message: 'Déconnecté' })
    })

    // ── GET /api/admin/me ─────────────────────────────────────────────────────
    router.get('/me', requireAdminAuth, async (req, res) => {
        try {
            const admin = await getAdminById(req.adminUser!.sub)
            if (!admin) {
                res.status(404).json({
                    success: false,
                    error: { code: 'NOT_FOUND', message: 'Compte introuvable' },
                })
                return
            }
            res.json({ success: true, admin: sanitizeAdmin(admin) })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur /me')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── PUT /api/admin/me ─────────────────────────────────────────────────────
    router.put('/me', requireAdminAuth, async (req, res) => {
        const { displayName, email } = req.body as { displayName?: unknown; email?: unknown }

        const updates: { displayName?: string; email?: string } = {}

        if (typeof displayName === 'string') updates.displayName = displayName.trim().slice(0, 100)
        if (typeof email === 'string') {
            const e = email.trim().toLowerCase()
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Email invalide' } })
                return
            }
            updates.email = e
        }

        try {
            await updateAdminProfile(req.adminUser!.sub, updates)
            const admin = await getAdminById(req.adminUser!.sub)
            res.json({ success: true, admin: sanitizeAdmin(admin!) })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur update profile')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── PUT /api/admin/me/password ────────────────────────────────────────────
    router.put('/me/password', requireAdminAuth, async (req, res) => {
        const { currentPassword, newPassword } = req.body as {
            currentPassword?: unknown
            newPassword?:     unknown
        }

        if (!currentPassword || typeof currentPassword !== 'string' ||
            !newPassword     || typeof newPassword     !== 'string') {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'currentPassword et newPassword requis' },
            })
            return
        }

        if (newPassword.length < 8) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Le nouveau mot de passe doit faire au moins 8 caractères' },
            })
            return
        }

        try {
            const admin = await getAdminById(req.adminUser!.sub)
            if (!admin || !verifyPassword(currentPassword, admin.password_hash)) {
                res.status(401).json({
                    success: false,
                    error: { code: 'INVALID_PASSWORD', message: 'Mot de passe actuel incorrect' },
                })
                return
            }

            await updateAdminPassword(req.adminUser!.sub, newPassword)
            res.json({ success: true, message: 'Mot de passe mis à jour' })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur change password')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── GET /api/admin/stats ──────────────────────────────────────────────────
    router.get('/stats', requireAdminAuth, async (_req, res) => {
        try {
            const pool = getPool()

            const [[tenantStats]] = await pool.execute(
                `SELECT
                    COUNT(*) AS total,
                    SUM(status = 'connected')    AS connected,
                    SUM(status = 'pending_qr')   AS pending_qr,
                    SUM(status = 'disconnected') AS disconnected
                 FROM wa_tenants`
            ) as unknown as [[{
                total: number; connected: number; pending_qr: number; disconnected: number
            }]]

            const [[userStats]] = await pool.execute(
                `SELECT COUNT(*) AS total, SUM(active = TRUE) AS active
                 FROM auth_users`
            ) as unknown as [[{ total: number; active: number }]]

            const [[msgStats]] = await pool.execute(
                `SELECT
                    COUNT(*) AS total,
                    SUM(status = 'sent')   AS sent,
                    SUM(status = 'failed') AS failed,
                    SUM(status = 'queued') AS queued
                 FROM wa_message_queue`
            ) as unknown as [[{
                total: number; sent: number; failed: number; queued: number
            }]]

            const [[msgToday]] = await pool.execute(
                `SELECT COUNT(*) AS count
                 FROM wa_message_queue
                 WHERE DATE(queued_at) = CURDATE()`
            ) as unknown as [[{ count: number }]]

            res.json({
                success: true,
                stats: {
                    tenants: {
                        total:        Number(tenantStats.total        ?? 0),
                        connected:    Number(tenantStats.connected    ?? 0),
                        pendingQr:    Number(tenantStats.pending_qr   ?? 0),
                        disconnected: Number(tenantStats.disconnected ?? 0),
                    },
                    users: {
                        total:  Number(userStats.total  ?? 0),
                        active: Number(userStats.active ?? 0),
                    },
                    messages: {
                        total:  Number(msgStats.total  ?? 0),
                        sent:   Number(msgStats.sent   ?? 0),
                        failed: Number(msgStats.failed ?? 0),
                        queued: Number(msgStats.queued ?? 0),
                        today:  Number(msgToday.count  ?? 0),
                    },
                },
            })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur stats')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── GET /api/admin/tenants ────────────────────────────────────────────────
    router.get('/tenants', requireAdminAuth, async (_req, res) => {
        try {
            const tenants = await listTenants()
            res.json({ success: true, count: tenants.length, tenants })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur list tenants')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── GET /api/admin/users ──────────────────────────────────────────────────
    router.get('/users', requireAdminAuth, async (req, res) => {
        const page  = Math.max(1, parseInt(req.query['page'] as string, 10) || 1)
        const limit = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string, 10) || 20))

        try {
            const { users, total } = await listUsers({ page, limit })
            res.json({
                success: true,
                data:    users,
                meta:    { page, limit, total, pages: Math.ceil(total / limit) },
            })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur list users')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    return router
}
