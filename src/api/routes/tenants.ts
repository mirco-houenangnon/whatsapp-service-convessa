

import { Router }        from 'express'
import qrcode            from 'qrcode'
import { requireApiKey } from '../middleware/auth.js'
import { rateLimit }     from '../middleware/rateLimit.js'
import {
    createTenant,
    getTenantById,
    getTenantApiKey,
    getTenantByUserUid,
    getTenantByPhoneForOtherUser,
    deleteTenant,
    listTenants,
}                        from '../../db/TenantStore.js'
import { TenantManager } from '../../whatsapp/TenantManager.js'
import { config }        from '../../config.js'
import { logger, maskPhone } from '../../services/logger.js'

export function tenantsRouter(tenantManager: TenantManager): Router {
    const router = Router()

    // ── POST /api/v1/tenants ──────────────────────────────────────────────────
    // Crée un tenant et démarre sa session WhatsApp (génère un QR)
    router.post('/tenants', rateLimit, requireApiKey, async (req, res) => {
        const { phone, name, webhookUrl, userUid } = req.body as {
            phone?:      unknown
            name?:       unknown
            webhookUrl?: unknown
            userUid?:    unknown
        }

        if (!phone || typeof phone !== 'string' || !phone.trim()) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "Le champ 'phone' est requis (numéro international)" } })
            return
        }

        // Nettoyage du numéro — support international
        const cleanPhone = phone.trim().replace(/[\s\-()]/g, '').replace(/^\+/, '')

        if (!/^\d{7,15}$/.test(cleanPhone)) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "Format de numéro invalide — indicatif international requis (ex: 22994119476)" } })
            return
        }

        const cleanUserUid = typeof userUid === 'string' && userUid.trim() ? userUid.trim() : undefined

        try {
            // ── Règle : un utilisateur = une seule session WhatsApp ────────────────
            if (cleanUserUid) {
                const existingForUser = await getTenantByUserUid(cleanUserUid)
                if (existingForUser) {
                    res.status(409).json({
                        success: false,
                        error: {
                            code:    'USER_ALREADY_HAS_SESSION',
                            message: "Cet utilisateur possède déjà une session WhatsApp. Supprimez-la avant d'en créer une nouvelle.",
                        },
                        tenantId: existingForUser.id,
                        status:   existingForUser.status,
                    })
                    return
                }

                // ── Règle : un numéro WhatsApp = un seul utilisateur ────────────────
                const usedByOtherUser = await getTenantByPhoneForOtherUser(cleanPhone, cleanUserUid)
                if (usedByOtherUser) {
                    res.status(409).json({
                        success: false,
                        error: {
                            code:    'PHONE_ALREADY_USED',
                            message: 'Ce numéro WhatsApp est déjà utilisé par un autre compte.',
                        },
                    })
                    return
                }
            }

            const tenant = await createTenant({
                phone:      cleanPhone,
                name:       typeof name === 'string' ? name.trim() : undefined,
                webhookUrl: typeof webhookUrl === 'string' ? webhookUrl.trim() : undefined,
                userUid:    cleanUserUid,
            })

            // Démarrer la session WhatsApp pour ce tenant
            // C'est async — le QR sera disponible dans quelques secondes
            tenantManager.createSession(tenant.id).catch((err) => {
                logger.error({ component: 'API', tenantId: tenant.id, err }, 'Erreur création session tenant')
            })

            logger.info({ component: 'API', tenantId: tenant.id, phone: maskPhone(cleanPhone) }, 'Tenant créé')

            res.status(201).json({
                success:  true,
                tenantId: tenant.id,
                status:   'pending_qr',
                message:  'Session en cours de démarrage. Appelez GET /api/v1/tenants/:id/qr dans 3-5 secondes pour récupérer le QR code.',
            })

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : ''
            // Duplicate phone
            if (msg.includes('Duplicate') || msg.includes('uq_phone')) {
                res.status(409).json({ success: false, error: { code: 'TENANT_ALREADY_EXISTS', message: 'Un tenant avec ce numéro existe déjà' } })
                return
            }
            logger.error({ component: 'API', err }, 'Erreur création tenant')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: config.isProd ? 'Erreur interne' : msg } })
        }
    })

    // ── GET /api/v1/tenants/:id/qr ────────────────────────────────────────────
    // Retourne le QR code courant en base64 PNG
    router.get('/tenants/:id/qr', rateLimit, requireApiKey, async (req, res) => {
        const { id } = req.params

        const tenant = await getTenantById(id as string)
        if (!tenant) {
            res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Tenant introuvable' } })
            return
        }

        if (tenant.status === 'connected') {
            res.status(200).json({ success: true, status: 'connected', message: 'Ce tenant est déjà connecté' })
            return
        }

        const rawQr = tenantManager.getLastQr(id as string)
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
                success:    true,
                status:     'pending_qr',
                tenantId:   id,
                qrCode:     qrBase64,
                expiresIn:  60,  // secondes — WhatsApp invalide le QR après ~60s
                instructions: "Afficher ce QR code à l'utilisateur. Il doit le scanner avec WhatsApp → Appareils liés → Lier un appareil.",
            })
        } catch (err) {
            logger.error({ component: 'API', err }, 'Erreur génération QR')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur génération QR' } })
        }
    })

    // ── GET /api/v1/tenants/:id/api-key ──────────────────────────────────────
    // Retourne la clé API complète déchiffrée — pour affichage dans le dashboard
    router.get('/tenants/:id/api-key', requireApiKey, async (req, res) => {
        const id = req.params['id'] as string

        const tenant = await getTenantById(id)
        if (!tenant) {
            res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Tenant introuvable' } })
            return
        }

        const apiKey = await getTenantApiKey(id)
        if (!apiKey) {
            res.status(404).json({
                success: false,
                error: { code: 'API_KEY_NOT_FOUND', message: 'Aucune clé API — le tenant n\'a pas encore scanné son QR code' },
            })
            return
        }

        res.json({
            success:    true,
            tenantId:   id,
            apiKey,
            apiKeyHint: tenant.apiKeyHint,
        })
    })

    // ── GET /api/v1/tenants/:id ───────────────────────────────────────────────
    router.get('/tenants/:id', requireApiKey, async (req, res) => {        const tenant = await getTenantById(req.params['id'] as string)

        if (!tenant) {
            res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Tenant introuvable' } })
            return
        }

        res.json({
            success:     true,
            tenantId:    tenant.id,
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

    // ── GET /api/v1/tenants ───────────────────────────────────────────────────
    router.get('/tenants', requireApiKey, async (_req, res) => {
        const tenants = await listTenants()
        res.json({
            success: true,
            count:   tenants.length,
            tenants: tenants.map(t => ({
                tenantId:    t.id,
                userUid:     t.userUid,
                phone:       maskPhone(t.phone),
                name:        t.name,
                status:      t.status,
                apiKeyHint:  t.apiKeyHint,
                connectedAt: t.connectedAt,
                createdAt:   t.createdAt,
            })),
        })
    })

    return router
}