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
import { getPool, query }    from '../../db/connection.js'
import { logger }            from '../../services/logger.js'
import { config }            from '../../config.js'
import {
    createReferralCode,
    getReferralCodeByCode,
    listReferralCodes,
    type UsageType as ReferralUsageType,
}                            from '../../db/ReferralCodeStore.js'
import {
    createSubscriptionPlan,
    listSubscriptionPlans,
    type UsageType as PlanUsageType,
}                            from '../../db/SubscriptionPlanStore.js'

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
            const [tenantStats] = await query<{
                total: string; connected: string; pending_qr: string; disconnected: string
            }>(
                `SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'connected'    THEN 1 ELSE 0 END) AS connected,
                    SUM(CASE WHEN status = 'pending_qr'   THEN 1 ELSE 0 END) AS pending_qr,
                    SUM(CASE WHEN status = 'disconnected' THEN 1 ELSE 0 END) AS disconnected
                 FROM wa_tenants`
            )

            const [userStats] = await query<{ total: string; active: string }>(
                `SELECT COUNT(*) AS total, SUM(CASE WHEN active = TRUE THEN 1 ELSE 0 END) AS active
                 FROM auth_users`
            )

            const [msgStats] = await query<{
                total: string; sent: string; failed: string; queued: string
            }>(
                `SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'sent'   THEN 1 ELSE 0 END) AS sent,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                    SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued
                 FROM wa_message_queue`
            )

            const [msgToday] = await query<{ count: string }>(
                `SELECT COUNT(*) AS count FROM wa_message_queue
                 WHERE DATE(queued_at) = CURRENT_DATE`
            )

            res.json({
                success: true,
                stats: {
                    tenants: {
                        total:        Number(tenantStats?.total        ?? 0),
                        connected:    Number(tenantStats?.connected    ?? 0),
                        pendingQr:    Number(tenantStats?.pending_qr   ?? 0),
                        disconnected: Number(tenantStats?.disconnected ?? 0),
                    },
                    users: {
                        total:  Number(userStats?.total  ?? 0),
                        active: Number(userStats?.active ?? 0),
                    },
                    messages: {
                        total:  Number(msgStats?.total  ?? 0),
                        sent:   Number(msgStats?.sent   ?? 0),
                        failed: Number(msgStats?.failed ?? 0),
                        queued: Number(msgStats?.queued ?? 0),
                        today:  Number(msgToday?.count  ?? 0),
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

    // ── Validation commune "usage" (durée en jours OU nombre de requêtes) ──────
    function parseUsage(body: Record<string, unknown>): {
        ok: true
        unlimited:  boolean
        usageType:  'duration' | 'requests' | null
        usageValue: number | null
    } | { ok: false; message: string } {
        const unlimited = body['unlimited']
        if (typeof unlimited !== 'boolean') {
            return { ok: false, message: 'Le champ "usage indéterminé" (Oui/Non) est requis' }
        }

        if (unlimited) {
            return { ok: true, unlimited: true, usageType: null, usageValue: null }
        }

        const usageType = body['usageType']
        if (usageType !== 'duration' && usageType !== 'requests') {
            return { ok: false, message: 'Le type d\'usage doit être "duration" ou "requests"' }
        }

        const usageValueRaw = body['usageValue']
        const usageValue = typeof usageValueRaw === 'number' ? usageValueRaw : Number(usageValueRaw)
        if (!Number.isInteger(usageValue) || usageValue < 1) {
            return {
                ok: false,
                message: usageType === 'duration'
                    ? 'La durée (en jours) doit être un nombre entier positif'
                    : 'Le nombre de requêtes doit être un nombre entier positif',
            }
        }

        return { ok: true, unlimited: false, usageType, usageValue }
    }

    // ── GET /api/admin/referral-codes ─────────────────────────────────────────
    router.get('/referral-codes', requireAdminAuth, async (_req, res) => {
        try {
            const codes = await listReferralCodes()
            res.json({ success: true, count: codes.length, codes })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur list referral codes')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── POST /api/admin/referral-codes ────────────────────────────────────────
    router.post('/referral-codes', requireAdminAuth, async (req, res) => {
        const body = req.body as Record<string, unknown>
        const codeRaw = body['code']

        if (typeof codeRaw !== 'string' || codeRaw.trim().length < 4 || codeRaw.trim().length > 12) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Le code doit contenir entre 4 et 12 caractères' },
            })
            return
        }
        const code = codeRaw.trim()

        const usage = parseUsage(body)
        if (!usage.ok) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: usage.message } })
            return
        }

        try {
            const existing = await getReferralCodeByCode(code)
            if (existing) {
                res.status(409).json({
                    success: false,
                    error: { code: 'CONFLICT', message: 'Ce code de parrainage existe déjà' },
                })
                return
            }

            const created = await createReferralCode({
                code,
                unlimited:  usage.unlimited,
                usageType:  usage.usageType as ReferralUsageType | null,
                usageValue: usage.usageValue,
            })

            res.status(201).json({ success: true, code: created })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur création code de parrainage')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── GET /api/admin/plans ──────────────────────────────────────────────────
    router.get('/plans', requireAdminAuth, async (_req, res) => {
        try {
            const plans = await listSubscriptionPlans()
            res.json({ success: true, count: plans.length, plans })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur list plans')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    // ── POST /api/admin/plans ─────────────────────────────────────────────────
    router.post('/plans', requireAdminAuth, async (req, res) => {
        const body    = req.body as Record<string, unknown>
        const nameRaw = body['name']

        if (typeof nameRaw !== 'string' || nameRaw.trim().length < 1 || nameRaw.trim().length > 100) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Le nom du plan est requis (100 caractères max)' },
            })
            return
        }
        const name = nameRaw.trim()

        const priceRaw = body['price']
        const price = typeof priceRaw === 'number' ? priceRaw : Number(priceRaw)
        if (!Number.isInteger(price) || price < 0 || price > 1000000) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Le prix doit être compris entre 0 et 1 000 000 Frs CFA' },
            })
            return
        }

        const usage = parseUsage(body)
        if (!usage.ok) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: usage.message } })
            return
        }

        try {
            const created = await createSubscriptionPlan({
                name,
                price,
                unlimited:  usage.unlimited,
                usageType:  usage.usageType as PlanUsageType | null,
                usageValue: usage.usageValue,
            })

            res.status(201).json({ success: true, plan: created })
        } catch (err) {
            logger.error({ component: 'Admin', err }, 'Erreur création plan')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    return router
}