/**
 * tenants.ts — Gestion des tenants (sessions WhatsApp des clients Convessa).
 *
 * ── Self-service (le tenant lui-même) — Authentification : Firebase Bearer token ──
 *   POST   /api/v1/tenants           → Créer sa propre session (userUid = req.firebaseUser.uid)
 *   GET    /api/v1/tenants/me        → Ma session
 *   GET    /api/v1/tenants/me/qr     → Mon QR code courant
 *   GET    /api/v1/tenants/me/api-key→ Ma clé API complète déchiffrée
 *   DELETE /api/v1/tenants/me        → Déconnecter / supprimer ma session
 *
 * ── Backoffice (les devs Convessa) — Authentification : clé Bridge (X-Api-Key) ──
 *   GET    /api/v1/tenants           → Lister tous les tenants (téléphone masqué)
 *   GET    /api/v1/tenants/:id       → Détail d'un tenant
 *   DELETE /api/v1/tenants/:id       → Supprimer un tenant
 *
 * IMPORTANT — Aucune route self-service ne doit jamais accepter un tenantId
 * ou userUid fourni par le client : l'identité vient exclusivement du token
 * Firebase vérifié (req.firebaseUser.uid). C'est ce qui garantit qu'un tenant
 * ne peut jamais lire, modifier ou récupérer la clé d'un autre tenant.
 */

import { Router }              from 'express'
import qrcode                  from 'qrcode'
import { requireApiKey }       from '../middleware/auth.js'
import { requireFirebaseAuth } from '../middleware/firebaseAuth.js'
import { rateLimit }           from '../middleware/rateLimit.js'
import {
    createTenant,
    getTenantById,
    getTenantApiKey,
    getTenantByUserUid,
    deleteTenant,
    listTenants,
}                               from '../../db/TenantStore.js'
import { TenantManager }       from '../../whatsapp/TenantManager.js'
import { config }              from '../../config.js'
import { logger, maskPhone }   from '../../services/logger.js'

export function tenantsRouter(tenantManager: TenantManager): Router {
    const router = Router()

    // ═══════════════════════════════════════════════════════════════════════
    // SELF-SERVICE — le tenant gère sa propre session (Firebase Bearer token)
    // ═══════════════════════════════════════════════════════════════════════

    // ── POST /api/v1/tenants — créer SA session ───────────────────────────────
    // Aucun numéro n'est demandé ici : le tenant scanne directement son QR,
    // le vrai numéro WhatsApp est déduit automatiquement du compte scanné
    // (voir TenantManager._initSession → updateTenantPhone).
    router.post('/tenants', rateLimit, requireFirebaseAuth, async (req, res) => {
        const userUid = req.firebaseUser!.uid

        const { name, webhookUrl } = req.body as {
            name?:       unknown
            webhookUrl?: unknown
        }

        try {
            // ── Règle : un utilisateur = une seule session WhatsApp ────────────
            const existingForUser = await getTenantByUserUid(userUid)
            if (existingForUser) {
                res.status(409).json({
                    success: false,
                    error: {
                        code:    'USER_ALREADY_HAS_SESSION',
                        message: 'Vous possédez déjà une session WhatsApp. Supprimez-la avant d\'en créer une nouvelle.',
                    },
                    tenantId: existingForUser.id,
                    status:   existingForUser.status,
                })
                return
            }

            const tenant = await createTenant({
                name:       typeof name === 'string' ? name.trim() : undefined,
                webhookUrl: typeof webhookUrl === 'string' ? webhookUrl.trim() : undefined,
                userUid,
            })

            // Démarrer la session WhatsApp — async, le QR sera dispo dans quelques secondes
            tenantManager.createSession(tenant.id).catch((err) => {
                logger.error({ component: 'API', tenantId: tenant.id, err }, 'Erreur création session tenant')
            })

            logger.info({ component: 'API', tenantId: tenant.id, userUid }, 'Tenant créé (self-service) — téléphone en attente de scan')

            res.status(201).json({
                success:  true,
                tenantId: tenant.id,
                status:   'pending_qr',
                message:  'Session en cours de démarrage. Appelez GET /api/v1/tenants/me/qr dans 3-5 secondes.',
            })

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : ''
            if (msg.includes('Duplicate') || msg.includes('uq_phone')) {
                res.status(409).json({ success: false, error: { code: 'TENANT_ALREADY_EXISTS', message: 'Un tenant avec ce numéro existe déjà' } })
                return
            }
            logger.error({ component: 'API', err }, 'Erreur création tenant')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: config.isProd ? 'Erreur interne' : msg } })
        }
    })

    // ── GET /api/v1/tenants/me — MA session ────────────────────────────────────
    router.get('/tenants/me', requireFirebaseAuth, async (req, res) => {
        const tenant = await getTenantByUserUid(req.firebaseUser!.uid)

        if (!tenant) {
            res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Aucune session WhatsApp liée à ce compte' } })
            return
        }

        res.json({
            success:         true,
            tenantId:        tenant.id,
            phone:           maskPhone(tenant.phone),
            name:            tenant.name,
            status:          tenant.status,
            apiKeyHint:      tenant.apiKeyHint,
            apiKeyExpiresAt: tenant.apiKeyExpiresAt,
            connectedAt:     tenant.connectedAt,
            createdAt:       tenant.createdAt,
            usageType:       tenant.usageType,
            messagesLimit:   tenant.messagesLimit,
            messagesSent:    tenant.messagesSent,
            referralCode:    tenant.referralCode,
        })
    })

    // ── GET /api/v1/tenants/me/qr — MON QR code courant ────────────────────────
    router.get('/tenants/me/qr', rateLimit, requireFirebaseAuth, async (req, res) => {
        const tenant = await getTenantByUserUid(req.firebaseUser!.uid)

        if (!tenant) {
            res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Aucune session WhatsApp liée à ce compte' } })
            return
        }

        if (tenant.status === 'connected') {
            res.status(200).json({ success: true, status: 'connected', message: 'Votre session est déjà connectée' })
            return
        }

        let rawQr = tenantManager.getLastQr(tenant.id)

        // Si pas de QR en mémoire et la session n'est pas active, la (re)lancer.
        // Cela couvre : redémarrage du serveur, session pending_qr non restaurée,
        // ou premier appel trop rapide après POST /tenants.
        if (!rawQr && !tenantManager.isConnected(tenant.id)) {
            tenantManager.createSession(tenant.id).catch((err) => {
                logger.error({ component: 'API', tenantId: tenant.id, err }, 'Erreur (re)lancement session tenant depuis /me/qr')
            })
            res.status(202).json({
                success: false,
                status:  'pending_qr',
                message: 'Session en cours de démarrage — le QR arrivera via Socket.io dans 2-5 secondes.',
            })
            return
        }

        if (!rawQr) {
            res.status(202).json({
                success: false,
                status:  'pending_qr',
                message: 'QR code pas encore disponible — réessayez dans 2-3 secondes',
            })
            return
        }

        try {
            const qrBase64 = await qrcode.toDataURL(rawQr)
            res.json({
                success:      true,
                status:       'pending_qr',
                tenantId:     tenant.id,
                qrCode:       qrBase64,
                expiresIn:    60,
                instructions: 'Scannez avec WhatsApp → Appareils liés → Lier un appareil.',
            })
        } catch (err) {
            logger.error({ component: 'API', err }, 'Erreur génération QR')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur génération QR' } })
        }
    })

    // ── POST /api/v1/tenants/me/activate — génère MA clé API (après QR scanné) ─
    // Appelée par le frontend juste après que l'utilisateur ait répondu au
    // prompt "possédez-vous un code de parrainage ?" (avec ou sans code).
    // Sans code → les privilèges du plan gratuit (price = 0) sont appliqués.
    router.post('/tenants/me/activate', rateLimit, requireFirebaseAuth, async (req, res) => {
        const tenant = await getTenantByUserUid(req.firebaseUser!.uid)

        if (!tenant) {
            res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Aucune session WhatsApp liée à ce compte' } })
            return
        }

        if (tenant.status !== 'connected') {
            res.status(409).json({
                success: false,
                error: { code: 'SESSION_NOT_CONNECTED', message: 'Scannez d\'abord votre QR code avant d\'activer votre session' },
            })
            return
        }

        const { referralCode } = req.body as { referralCode?: unknown }
        const code = typeof referralCode === 'string' && referralCode.trim() ? referralCode.trim() : null

        try {
            const { token, hint, expiresAt } = await tenantManager.activateTenant(tenant.id, code)
            res.json({
                success:         true,
                tenantId:        tenant.id,
                apiKey:          token,
                apiKeyHint:      hint,
                apiKeyExpiresAt: expiresAt ? expiresAt.toISOString() : null,
            })
        } catch (err: unknown) {
            const e = err as { code?: string; message?: string }

            if (e.code === 'INVALID_REFERRAL_CODE') {
                res.status(400).json({ success: false, error: { code: 'INVALID_REFERRAL_CODE', message: 'Code de parrainage invalide ou introuvable' } })
                return
            }
            if (e.code === 'ALREADY_ACTIVATED') {
                res.status(409).json({ success: false, error: { code: 'ALREADY_ACTIVATED', message: 'Cette session possède déjà une clé API' } })
                return
            }
            logger.error({ component: 'API', err }, 'Erreur activation tenant (code de parrainage)')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur lors de l\'activation de la session' } })
        }
    })

    // ── GET /api/v1/tenants/me/api-key — MA clé API complète ───────────────────
    router.get('/tenants/me/api-key', requireFirebaseAuth, async (req, res) => {
        const tenant = await getTenantByUserUid(req.firebaseUser!.uid)

        if (!tenant) {
            res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Aucune session WhatsApp liée à ce compte' } })
            return
        }

        const apiKey = await getTenantApiKey(tenant.id)
        if (!apiKey) {
            res.status(404).json({
                success: false,
                error: { code: 'API_KEY_NOT_FOUND', message: 'Aucune clé API — scannez d\'abord votre QR code' },
            })
            return
        }

        res.json({
            success:         true,
            tenantId:        tenant.id,
            apiKey,
            apiKeyHint:      tenant.apiKeyHint,
            apiKeyExpiresAt: tenant.apiKeyExpiresAt,
        })
    })

    // ── DELETE /api/v1/tenants/me — déconnecter MA session ──────────────────────
    router.delete('/tenants/me', requireFirebaseAuth, async (req, res) => {
        const tenant = await getTenantByUserUid(req.firebaseUser!.uid)

        if (!tenant) {
            res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Aucune session WhatsApp liée à ce compte' } })
            return
        }

        try {
            await tenantManager.closeSession(tenant.id)
            await deleteTenant(tenant.id)
            logger.warn({ component: 'API', tenantId: tenant.id, userUid: req.firebaseUser!.uid }, 'Session tenant supprimée (self-service)')
            res.json({ success: true, message: 'Session supprimée' })
        } catch (err) {
            logger.error({ component: 'API', err }, 'Erreur suppression tenant (self-service)')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur lors de la suppression' } })
        }
    })

    // ═══════════════════════════════════════════════════════════════════════
    // BACKOFFICE ADMIN — clé Bridge (X-Api-Key), jamais utilisé par le frontend tenant
    // ═══════════════════════════════════════════════════════════════════════

    // ── GET /api/v1/tenants/:id ───────────────────────────────────────────────
    router.get('/tenants/:id', requireApiKey, async (req, res) => {
        const tenant = await getTenantById(req.params['id'] as string)

        if (!tenant) {
            res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Tenant introuvable' } })
            return
        }

        res.json({
            success:     true,
            tenantId:    tenant.id,
            userUid:     tenant.userUid,
            phone:       maskPhone(tenant.phone),
            name:        tenant.name,
            status:      tenant.status,
            apiKeyHint:  tenant.apiKeyHint,
            connectedAt: tenant.connectedAt,
            createdAt:   tenant.createdAt,
        })
    })

    // ── DELETE /api/v1/tenants/:id ────────────────────────────────────────────
    router.delete('/tenants/:id', requireApiKey, async (req, res) => {
        const id = req.params['id'] as string

        const tenant = await getTenantById(id)
        if (!tenant) {
            res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Tenant introuvable' } })
            return
        }

        try {
            await tenantManager.closeSession(id)
            await deleteTenant(id)
            res.json({ success: true, message: 'Tenant supprimé' })
        } catch (err) {
            logger.error({ component: 'API', err }, 'Erreur suppression tenant')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur lors de la suppression' } })
        }
    })

    // ── GET /api/v1/tenants — liste complète (admin uniquement) ─────────────────
    router.get('/tenants', requireApiKey, async (_req, res) => {
        const tenants = await listTenants()
        res.json({
            success: true,
            count:   tenants.length,
            tenants: tenants.map(t => ({
                tenantId:        t.id,
                userUid:         t.userUid,
                phone:           maskPhone(t.phone),
                name:            t.name,
                status:          t.status,
                apiKeyHint:      t.apiKeyHint,
                apiKeyExpiresAt: t.apiKeyExpiresAt,
                connectedAt:     t.connectedAt,
                createdAt:       t.createdAt,
            })),
        })
    })

    return router
}