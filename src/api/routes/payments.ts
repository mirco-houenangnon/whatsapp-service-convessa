/**
 * payments.ts — Routes de paiement d'abonnement Convessa.
 *
 * Flux FedaPay :
 *   1. POST /api/v1/payments/initiate  → crée une transaction FedaPay, retourne checkoutUrl
 *   2. FedaPay appelle GET /api/v1/payments/callback/fedapay?id=<tx_id>&status=approved
 *   3. Backend vérifie la transaction, active les privilèges du plan
 *
 * Flux KKiaPay :
 *   1. POST /api/v1/payments/initiate  → retourne les paramètres KKiaPay (public_key, amount…)
 *   2. Le widget KKiaPay côté frontend notifie POST /api/v1/payments/webhook/kkiapay
 *   3. Backend vérifie la signature, active les privilèges du plan
 */

import { Router }                  from 'express'
import https                       from 'https'
import { requireFirebaseAuth }     from '../middleware/firebaseAuth.js'
import { rateLimit }               from '../middleware/rateLimit.js'
import { getTenantByUserUid }      from '../../db/TenantStore.js'
import { getSubscriptionPlanById } from '../../db/SubscriptionPlanStore.js'
import {
    createPayment,
    getPaymentById,
    getPaymentByGatewayTxId,
    updatePaymentStatus,
}                                  from '../../db/PaymentStore.js'
import { TenantManager }           from '../../whatsapp/TenantManager.js'
import { config }                  from '../../config.js'
import { logger }                  from '../../services/logger.js'

// ── Helpers FedaPay ────────────────────────────────────────────────────────────

function fedapayRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const bodyStr  = body ? JSON.stringify(body) : ''
        const options = {
            hostname: 'api.fedapay.com',
            port:     443,
            path,
            method,
            headers: {
                'Authorization': `Bearer ${config.payments.fedapay.secretKey}`,
                'Content-Type':  'application/json',
                'Accept':        'application/json',
                ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
            },
        }

        const req = https.request(options, (res) => {
            let data = ''
            res.on('data', (chunk) => { data += chunk })
            res.on('end', () => {
                try { resolve(JSON.parse(data)) }
                catch { resolve(data) }
            })
        })
        req.on('error', reject)
        if (bodyStr) req.write(bodyStr)
        req.end()
    })
}

// ── Helpers KKiaPay (vérification webhook) ─────────────────────────────────────

function kkiapayVerifyRequest(transactionId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const path    = `/api/v1/transactions/${transactionId}/verify`
        const options = {
            hostname: 'api.kkiapay.me',
            port:     443,
            path,
            method:   'GET',
            headers: {
                'x-private-key': config.payments.kkiapay.privateKey,
                'Accept':        'application/json',
            },
        }

        const req = https.request(options, (res) => {
            let data = ''
            res.on('data', (chunk) => { data += chunk })
            res.on('end', () => {
                try { resolve(JSON.parse(data)) }
                catch { resolve(data) }
            })
        })
        req.on('error', reject)
        req.end()
    })
}

// ── Router ─────────────────────────────────────────────────────────────────────

export function paymentsRouter(tenantManager: TenantManager): Router {
    const router = Router()

    /**
     * POST /api/v1/payments/initiate
     * Body: { planId: string, gateway: 'fedapay' | 'kkiapay' }
     *
     * Pour FedaPay : retourne { checkoutUrl, paymentId }
     * Pour KKiaPay : retourne { publicKey, amount, paymentId, sandbox } (le widget s'ouvre côté frontend)
     */
    router.post('/payments/initiate', rateLimit, requireFirebaseAuth, async (req, res) => {
        const { planId, gateway } = req.body as { planId?: string; gateway?: string }

        if (!planId || !gateway || !['fedapay', 'kkiapay'].includes(gateway)) {
            res.status(400).json({ success: false, error: { code: 'INVALID_PARAMS', message: 'planId et gateway (fedapay|kkiapay) requis' } })
            return
        }

        try {
            const tenant = await getTenantByUserUid(req.firebaseUser!.uid)
            if (!tenant) {
                res.status(404).json({ success: false, error: { code: 'TENANT_NOT_FOUND', message: 'Aucune session WhatsApp trouvée' } })
                return
            }

            const plan = await getSubscriptionPlanById(planId)
            if (!plan) {
                res.status(404).json({ success: false, error: { code: 'PLAN_NOT_FOUND', message: 'Plan introuvable' } })
                return
            }

            if (plan.price === 0) {
                res.status(400).json({ success: false, error: { code: 'FREE_PLAN', message: 'Ce plan est gratuit — aucun paiement requis' } })
                return
            }

            // Créer l'enregistrement de paiement en base (statut pending)
            const payment = await createPayment({
                tenantId: tenant.id,
                planId:   plan.id,
                gateway:  gateway as 'fedapay' | 'kkiapay',
                amount:   plan.price,
            })

            if (gateway === 'fedapay') {
                // ── FedaPay ──────────────────────────────────────────────────
                // Format correct de l'API FedaPay v1 :
                // - Les champs de transaction sont dans l'objet racine (pas dans transaction[...])
                // - Le customer est dans { customer: { email } }
                // - La réponse contient { v1: { transaction: { id, token } } }
                const callbackUrl = `${config.payments.frontendUrl}/payment/callback?paymentId=${payment.id}`

                const fedaPayload = {
                    description:  `Abonnement Convessa — ${plan.name}`,
                    amount:       plan.price,
                    currency:     { iso: 'XOF' },
                    callback_url: callbackUrl,  // Redirection navigateur après paiement
                    customer:     { email: req.firebaseUser!.email ?? '' },
                }

                logger.info({ component: 'Payments', fedaPayload }, 'FedaPay: envoi payload')

                const fedaRes = await fedapayRequest('POST', '/v1/transactions', fedaPayload) as Record<string, unknown>

                logger.info({ component: 'Payments', fedaRes }, 'FedaPay: réponse brute')

                // La réponse FedaPay : { "v1/transaction": { id, payment_url, payment_token, ... } }
                const txData      = (fedaRes?.['v1/transaction'] as Record<string, unknown> | undefined) ?? fedaRes
                const txId        = txData?.['id'] ? String(txData['id']) : ''
                const checkoutUrl = txData?.['payment_url'] as string | undefined
                            ?? txData?.['payment_token']
                                ? `https://process.fedapay.com/${txData['payment_token']}`
                                : ''

                if (!txId || !checkoutUrl) {
                    logger.error({ component: 'Payments', fedaRes, txData }, 'FedaPay: id ou payment_url manquant')
                    await updatePaymentStatus(payment.id, 'failed')

                    const errDetail = (fedaRes?.['errors'] as Record<string, unknown>[] | undefined)?.[0]?.['message']
                                   ?? (fedaRes?.['error'] as string | undefined)
                                   ?? 'Réponse inattendue de FedaPay'
                    res.status(502).json({ success: false, error: { code: 'GATEWAY_ERROR', message: `Erreur FedaPay: ${errDetail}` } })
                    return
                }

                await updatePaymentStatus(payment.id, 'pending', txId)

                res.json({ success: true, paymentId: payment.id, gateway: 'fedapay', checkoutUrl })

            } else {
                // ── KKiaPay ──────────────────────────────────────────────────
                // Le widget KKiaPay est entièrement côté frontend — on retourne
                // juste les paramètres nécessaires pour l'ouvrir.
                res.json({
                    success:   true,
                    paymentId: payment.id,
                    gateway:   'kkiapay',
                    publicKey: config.payments.kkiapay.publicKey,
                    amount:    plan.price,
                    sandbox:   config.payments.kkiapay.sandbox,
                    data:      { paymentId: payment.id, tenantId: tenant.id, planId: plan.id },
                })
            }

        } catch (err) {
            logger.error({ component: 'Payments', err }, 'Erreur initiation paiement')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    /**
     * GET /api/v1/payments/callback/fedapay?paymentId=<id>&id=<fedapay_tx_id>
     * Appelé par le frontend après redirection FedaPay.
     * Vérifie la transaction et active le plan si succès.
     */
    router.get('/payments/callback/fedapay', requireFirebaseAuth, async (req, res) => {
        const raw       = req.query['paymentId']
        const paymentId = Array.isArray(raw) ? String(raw[0] ?? '') : typeof raw === 'string' ? raw : ''

        if (!paymentId) {
            res.status(400).json({ success: false, error: { code: 'MISSING_PAYMENT_ID', message: 'paymentId manquant' } })
            return
        }

        try {
            const payment = await getPaymentById(paymentId)
            if (!payment) {
                res.status(404).json({ success: false, error: { code: 'PAYMENT_NOT_FOUND', message: 'Paiement introuvable' } })
                return
            }

            if (payment.status === 'success') {
                res.json({ success: true, status: 'already_activated', message: 'Abonnement déjà actif' })
                return
            }

            // Vérifier la transaction FedaPay
            if (!payment.gatewayTxId) {
                res.status(400).json({ success: false, error: { code: 'NO_TX_ID', message: 'ID de transaction manquant' } })
                return
            }

            const fedaRes = await fedapayRequest('GET', `/v1/transactions/${payment.gatewayTxId}`) as Record<string, unknown>

            logger.info({ component: 'Payments', fedaRes }, 'FedaPay callback: réponse vérification')

            const txData   = (fedaRes?.['v1/transaction'] as Record<string, unknown> | undefined) ?? fedaRes
            const txStatus = txData?.['status'] as string | undefined

            if (txStatus !== 'approved') {
                await updatePaymentStatus(payment.id, 'failed')
                res.status(402).json({ success: false, error: { code: 'PAYMENT_NOT_APPROVED', message: `Transaction FedaPay non approuvée: ${txStatus ?? 'statut inconnu'}` } })
                return
            }

            // Activer le plan
            await _activatePlan(tenantManager, payment.tenantId, payment.planId, payment.id)

            res.json({ success: true, status: 'activated', message: 'Abonnement activé avec succès' })

        } catch (err) {
            logger.error({ component: 'Payments', err }, 'Erreur callback FedaPay')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    /**
     * POST /api/v1/payments/webhook/kkiapay
     * Webhook KKiaPay — appelé par le widget après paiement réussi.
     * Body: { transactionId: string, data: { paymentId: string } }
     */
    router.post('/payments/webhook/kkiapay', async (req, res) => {
        const { transactionId, data } = req.body as {
            transactionId?: string
            data?: { paymentId?: string }
        }

        const paymentId = data?.paymentId

        if (!transactionId || !paymentId) {
            res.status(400).json({ success: false, error: { code: 'INVALID_WEBHOOK', message: 'transactionId et data.paymentId requis' } })
            return
        }

        try {
            const payment = await getPaymentById(paymentId)
            if (!payment) {
                res.status(404).json({ success: false, error: { code: 'PAYMENT_NOT_FOUND', message: 'Paiement introuvable' } })
                return
            }

            if (payment.status === 'success') {
                res.json({ success: true, message: 'Déjà traité' })
                return
            }

            // Vérifier la transaction KKiaPay
            const kkiaRes = await kkiapayVerifyRequest(transactionId) as {
                status?: string
                state?:  string
            }

            const txStatus = kkiaRes?.status ?? kkiaRes?.state

            if (txStatus !== 'SUCCESS' && txStatus !== 'success') {
                await updatePaymentStatus(payment.id, 'failed', transactionId)
                res.status(402).json({ success: false, error: { code: 'PAYMENT_NOT_SUCCESS', message: `Transaction KKiaPay: ${txStatus}` } })
                return
            }

            await updatePaymentStatus(payment.id, 'pending', transactionId)

            // Activer le plan
            await _activatePlan(tenantManager, payment.tenantId, payment.planId, payment.id)

            res.json({ success: true, message: 'Paiement confirmé et abonnement activé' })

        } catch (err) {
            logger.error({ component: 'Payments', err }, 'Erreur webhook KKiaPay')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    /**
     * GET /api/v1/payments/:paymentId/status
     * Vérifie le statut d'un paiement (polling frontend).
     */
    router.get('/payments/:paymentId/status', requireFirebaseAuth, async (req, res) => {
        const paymentId = req.params['paymentId'] as string

        try {
            const payment = await getPaymentById(paymentId)
            if (!payment) {
                res.status(404).json({ success: false, error: { code: 'PAYMENT_NOT_FOUND', message: 'Paiement introuvable' } })
                return
            }

            res.json({ success: true, status: payment.status, paymentId: payment.id })

        } catch (err) {
            logger.error({ component: 'Payments', err }, 'Erreur statut paiement')
            res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
        }
    })

    return router
}

// ── Activation du plan après paiement confirmé ─────────────────────────────────

async function _activatePlan(
    tenantManager: TenantManager,
    tenantId:      string,
    planId:        string,
    paymentId:     string,
): Promise<void> {
    const { getSubscriptionPlanById }            = await import('../../db/SubscriptionPlanStore.js')
    const { setTenantApiKeyWithPrivileges,
            getTenantById }                      = await import('../../db/TenantStore.js')
    const { generateApiKey }                     = await import('../../services/apiKeyService.js')
    const { updatePaymentStatus: markSuccess }   = await import('../../db/PaymentStore.js')

    const plan = await getSubscriptionPlanById(planId)
    if (!plan) throw new Error(`Plan ${planId} introuvable`)

    // Calcul des privilèges selon le plan
    let privileges: import('../../db/TenantStore.js').TenantPrivileges

    if (plan.unlimited) {
        privileges = { usageType: 'unlimited', messagesLimit: null, expiresAt: null }
    } else if (plan.usageType === 'requests') {
        privileges = { usageType: 'requests', messagesLimit: plan.usageValue ?? 0, expiresAt: null }
    } else if (plan.usageType === 'duration') {
        const days = plan.usageValue ?? 30
        privileges = {
            usageType:     'duration',
            messagesLimit: null,
            expiresAt:     new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        }
    } else {
        privileges = { usageType: 'unlimited', messagesLimit: null, expiresAt: null }
    }

    const tenant = await getTenantById(tenantId)
    if (!tenant) throw new Error(`Tenant ${tenantId} introuvable`)

    // Générer une nouvelle clé API (ou renouveler si existante)
    const { token, hash, hint } = generateApiKey()
    await setTenantApiKeyWithPrivileges(tenantId, hash, hint, token, privileges, null)

    // Marquer le paiement comme réussi
    await markSuccess(paymentId, 'success')

    // Notifier le tenant via socket
    tenantManager.emit('subscription_activated', tenantId, {
        apiKey:          token,
        apiKeyHint:      hint,
        apiKeyExpiresAt: privileges.expiresAt?.toISOString() ?? null,
        usageType:       privileges.usageType,
        messagesLimit:   privileges.messagesLimit,
        planName:        plan.name,
    })

    logger.info(
        { component: 'Payments', tenantId, planId, paymentId, usageType: privileges.usageType },
        'Plan activé après paiement ✅'
    )
}
