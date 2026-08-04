/**
 * auth.ts — Routes d'authentification multiplateforme.
 *
 * Providers supportés :
 *   - google.com  (Firebase OAuth)
 *   - github.com  (Firebase OAuth)
 *   - phone       (OTP WhatsApp maison)
 *
 * Règles métier fondamentales :
 *   1. Un seul compte par identité — email, téléphone OU empreinte d'appareil
 *   2. L'empreinte d'appareil est vérifiée à l'inscription — bloque si déjà liée
 *   3. La connexion est toujours possible — l'appareil est loggué mais jamais bloqué
 *   4. L'empreinte est collectée sur chaque requête (inscription + connexion)
 */

import { Router }                  from 'express'
import { requireFirebaseAuth,
         requireFirebaseProvider } from '../middleware/firebaseAuth.js'
import { requireApiKey }           from '../middleware/auth.js'
import { rateLimit }               from '../middleware/rateLimit.js'
import { firebaseAuth }            from '../../services/firebase.js'
import {
    createUser, loginUser, upsertUser,
    getUserByUid, getUserByPhone, getUserByEmail,
    listUsers, deactivateUser, type UserRow,
} from '../../db/UserStore.js'
import { generateOtpCode, saveOtp, verifyOtp, deleteOtp } from '../../db/OtpStore.js'
import {
    extractFingerprint, upsertDevice, linkDeviceToUser,
    isDeviceBlocked, getDeviceRegisteredUid, logDeviceSession,
} from '../../db/DeviceStore.js'
import { logger }  from '../../services/logger.js'
import { normalizePhone, toFirebaseE164 } from '../../services/phoneUtils.js'
import { config }  from '../../config.js'
import { WhatsAppManager } from '../../whatsapp/WhatsAppManager.js'
import { enqueue }         from '../../db/MessageQueue.js'

// ── Constants ──────────────────────────────────────────────────────────────────

const ALLOWED_PROVIDERS = ['google.com', 'github.com']
const PHONE_REGEX       = /^\d{7,15}$/

// ══════════════════════════════════════════════════════════════════════════════
// Router
// ══════════════════════════════════════════════════════════════════════════════

export function authRouter(waManager: WhatsAppManager): Router {
    const router = Router()

    // ── POST /api/v1/auth/verify ──────────────────────────────────────────────
    /**
     * Authentification OAuth Firebase (Google / GitHub).
     * Fonctionne aussi bien pour la première connexion (inscription) que pour
     * les connexions suivantes (upsert).
     *
     * Logique :
     *   1. Extraire l'empreinte de l'appareil
     *   2. Upsert device
     *   3. Bloquer si l'appareil est blacklisté
     *   4. Upsert utilisateur (créé si absent, mis à jour si présent)
     *   5. Logger la session (register_success ou login_success)
     *   6. Lier l'appareil à l'utilisateur
     */
    router.post(
        '/auth/verify',
        requireFirebaseAuth,
        requireFirebaseProvider(ALLOWED_PROVIDERS),
        async (req, res) => {
            const decoded = req.firebaseUser!

            // ── Device fingerprint — obligatoire, non contournable ─────────────
            let device: Awaited<ReturnType<typeof upsertDevice>>['device']
            try {
                const fp   = extractFingerprint(req)
                const { device: d } = await upsertDevice(fp)
                device = d

                // 1. Bloquer si l'appareil est blacklisté
                const blocked = await isDeviceBlocked(fp.fingerprintHash)
                if (blocked.blocked) {
                    logger.warn({ component: 'Auth', fingerprintHash: fp.fingerprintHash.slice(0, 12) }, 'Appareil bloqué')
                    res.status(403).json({ success: false, error: { code: 'DEVICE_BLOCKED', message: blocked.reason ?? 'Cet appareil a été bloqué.' } })
                    return
                }

                // 2. Bloquer si l'appareil est déjà lié à un autre compte
                const registeredUid = await getDeviceRegisteredUid(fp.fingerprintHash)
                if (registeredUid !== null && registeredUid !== decoded.uid) {
                    logger.warn({ component: 'Auth', registeredUid, requestedUid: decoded.uid }, 'Appareil lié à un autre compte')
                    res.status(409).json({ success: false, error: { code: 'DEVICE_BOUND_TO_ANOTHER_ACCOUNT', message: 'Cet appareil est déjà lié à un autre compte.' } })
                    return
                }
            } catch (deviceErr) {
                // Si le device ne peut pas être traité → on bloque (fail-secure)
                logger.error({ component: 'Auth', err: deviceErr }, 'Erreur device fingerprint — accès refusé')
                res.status(500).json({ success: false, error: { code: 'DEVICE_ERROR', message: 'Impossible de vérifier l\'appareil. Réessayez.' } })
                return
            }

            try {
                const signInProvider = (decoded['firebase']?.['sign_in_provider'] as string) ?? 'unknown'
                const isDev          = config.nodeEnv !== 'production'
                const provider       = (isDev && signInProvider === 'custom' && decoded['provider'])
                    ? (decoded['provider'] as string)
                    : signInProvider

                // Détecter si c'est une inscription ou une connexion
                // On cherche par UID ET par email (cross-provider)
                const existingByUid   = await getUserByUid(decoded.uid)
                const existingByEmail = decoded.email ? await getUserByEmail(decoded.email) : null
                const existingUser    = existingByUid ?? existingByEmail
                const isNewAccount    = !existingUser

                // Si un compte existe via l'email mais pas cet UID :
                // → un autre provider (téléphone ou autre OAuth) a ce même email
                // → vérifier que l'appareil courant est bien lié à CE compte et pas un autre
                if (!existingByUid && existingByEmail && device) {
                    const deviceUid = await getDeviceRegisteredUid(device.fingerprint_hash)
                    if (deviceUid !== null && deviceUid !== existingByEmail.uid) {
                        res.status(409).json({
                            success: false,
                            error: {
                                code:    'DEVICE_BOUND_TO_ANOTHER_ACCOUNT',
                                message: 'Cet appareil est déjà lié à un autre compte.',
                            },
                        })
                        return
                    }
                }

                const user = await upsertUser({
                    uid:         decoded.uid,
                    email:       decoded.email     ?? null,
                    displayName: decoded.name      ?? null,
                    photoUrl:    decoded.picture   ?? null,
                    provider,
                })

                if (device) {
                    try {
                        await logDeviceSession({
                            deviceId: device.id,
                            userUid:  user.uid,
                            ip:       device.first_ip,
                            action:   isNewAccount ? 'register_success' : 'login_success',
                            provider,
                        })
                        await linkDeviceToUser(device.id, user.uid)
                    } catch (sessionErr) {
                        logger.warn({ component: 'Auth', err: sessionErr }, 'Erreur log session — ignorée')
                    }
                }

                logger.info(
                    { component: 'Auth', uid: decoded.uid, provider, isNewAccount },
                    isNewAccount ? 'Nouveau compte OAuth créé' : 'Connexion OAuth réussie'
                )

                res.json({ success: true, user: sanitizeUser(user), isNewAccount })
            } catch (err) {
                logger.error({ component: 'Auth', err }, 'Erreur upsertUser')
                res.status(500).json({
                    success: false,
                    error: { code: 'INTERNAL_ERROR', message: config.isProd ? 'Erreur interne' : String(err) },
                })
            }
        }
    )

    // ── GET /api/v1/auth/me ───────────────────────────────────────────────────
    router.get(
        '/auth/me',
        requireFirebaseAuth,
        requireFirebaseProvider(ALLOWED_PROVIDERS),
        async (req, res) => {
            const { uid } = req.firebaseUser!

            try {
                const user = await getUserByUid(uid)

                if (!user) {
                    res.status(404).json({
                        success: false,
                        error: {
                            code:    'USER_NOT_FOUND',
                            message: "Utilisateur non trouvé — appelez POST /auth/verify d'abord",
                        },
                    })
                    return
                }

                res.json({ success: true, user: sanitizeUser(user) })
            } catch (err) {
                logger.error({ component: 'Auth', err }, 'Erreur /me')
                res.status(500).json({
                    success: false,
                    error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' },
                })
            }
        }
    )

    // ── POST /api/v1/auth/logout ──────────────────────────────────────────────
    router.post('/auth/logout', requireFirebaseAuth, async (req, res) => {
        const { uid } = req.firebaseUser!

        try {
            await firebaseAuth.revokeRefreshTokens(uid)
            logger.info({ component: 'Auth', uid }, 'Tokens révoqués')
            res.json({ success: true, message: 'Déconnexion effectuée' })
        } catch (err) {
            logger.error({ component: 'Auth', err }, 'Erreur logout')
            res.status(500).json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' },
            })
        }
    })

    // ── GET /api/v1/auth/users — Admin ────────────────────────────────────────
    router.get('/auth/users', requireApiKey, async (req, res) => {
        const page     = Math.max(1, parseInt(req.query['page']  as string, 10) || 1)
        const limit    = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string, 10) || 20))
        const provider = req.query['provider'] as string | undefined

        try {
            const { users, total } = await listUsers({ page, limit, provider })

            res.json({
                success: true,
                data:    users.map(sanitizeUser),
                meta: {
                    page,
                    limit,
                    total,
                    pages: Math.ceil(total / limit),
                },
            })
        } catch (err) {
            logger.error({ component: 'Auth', err }, 'Erreur list users')
            res.status(500).json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' },
            })
        }
    })

    // ── DELETE /api/v1/auth/users/:uid — Admin ────────────────────────────────
    router.delete('/auth/users/:uid', requireApiKey, async (req, res) => {
        const { uid } = req.params

        if (!uid || typeof uid !== 'string' || uid.length > 128) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'UID invalide' },
            })
            return
        }

        try {
            const user = await getUserByUid(uid)
            if (!user) {
                res.status(404).json({
                    success: false,
                    error: { code: 'USER_NOT_FOUND', message: 'Utilisateur introuvable' },
                })
                return
            }

            await Promise.all([
                deactivateUser(uid),
                firebaseAuth.revokeRefreshTokens(uid).catch(() => {
                    // Ne pas échouer si le compte Firebase n'existe plus
                }),
            ])

            logger.warn({ component: 'Auth', uid }, 'Compte désactivé par admin')
            res.json({ success: true, message: 'Compte désactivé' })
        } catch (err) {
            logger.error({ component: 'Auth', err }, 'Erreur deactivate user')
            res.status(500).json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' },
            })
        }
    })

    // ══════════════════════════════════════════════════════════════════════════
    // AUTH PAR NUMÉRO DE TÉLÉPHONE (OTP WhatsApp)
    // ══════════════════════════════════════════════════════════════════════════

    // ── POST /api/v1/auth/phone/register ──────────────────────────────────────
    /**
     * Inscription par numéro de téléphone.
     *
     * Règles :
     *   - Le numéro ne doit pas être déjà enregistré
     *   - L'appareil ne doit pas être bloqué
     *   - L'appareil ne doit pas être déjà lié à un compte
     */
    router.post('/auth/phone/register', rateLimit, async (req, res) => {
        const { phone: rawPhone } = req.body as {
            phone?:       unknown
        }

        // ── Validation ─────────────────────────────────────────────────────────
        if (!rawPhone || typeof rawPhone !== 'string') {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'phone' est requis" },
            })
            return
        }

        const phone = sanitizePhone(rawPhone)

        if (!PHONE_REGEX.test(phone)) {
            res.status(400).json({
                success: false,
                error: {
                    code:    'VALIDATION_ERROR',
                    message: 'Format de numéro invalide — chiffres uniquement, indicatif international (ex: 22960000000)',
                },
            })
            return
        }

        try {
            // ── Device fingerprint ─────────────────────────────────────────────
            let device: Awaited<ReturnType<typeof upsertDevice>>['device'] | null = null

            try {
                const fp       = extractFingerprint(req)
                const upserted = await upsertDevice(fp)
                device         = upserted.device

                // Vérifier si l'appareil est bloqué
                const blocked = await isDeviceBlocked(fp.fingerprintHash)
                if (blocked.blocked) {
                    logger.warn(
                        { component: 'Auth', fingerprintHash: fp.fingerprintHash.slice(0, 12) },
                        'Appareil bloqué — inscription refusée'
                    )
                    res.status(403).json({
                        success: false,
                        error: {
                            code:    'DEVICE_BLOCKED',
                            message: blocked.reason ?? 'Cet appareil a été bloqué.',
                        },
                    })
                    return
                }

                // Vérifier si l'appareil est déjà lié à un compte
                const registeredUid = await getDeviceRegisteredUid(fp.fingerprintHash)
                if (registeredUid !== null) {
                    logger.warn(
                        { component: 'Auth', fingerprintHash: fp.fingerprintHash.slice(0, 12), registeredUid },
                        'Appareil déjà enregistré — inscription bloquée'
                    )
                    res.status(409).json({
                        success: false,
                        error: {
                            code:    'DEVICE_ALREADY_REGISTERED',
                            message: 'Cet appareil a déjà un compte. Utilisez la connexion.',
                        },
                    })
                    return
                }
            } catch (deviceErr) {
                // Fail-secure : si le device ne peut pas être vérifié → bloquer l'inscription
                logger.error({ component: 'Auth', err: deviceErr }, 'Erreur device fingerprint — inscription bloquée')
                res.status(500).json({ success: false, error: { code: 'DEVICE_ERROR', message: 'Impossible de vérifier l\'appareil. Réessayez.' } })
                return
            }

            // 6. Vérifier unicité du numéro
            const existing = await getUserByPhone(phone)
            if (existing) {
                res.status(409).json({
                    success: false,
                    error: {
                        code:    'PHONE_ALREADY_REGISTERED',
                        message: 'Ce numéro est déjà associé à un compte. Utilisez /auth/phone/login.',
                    },
                })
                return
            }

            // 7. Logger la tentative
            if (device) {
                try {
                    await logDeviceSession({
                        deviceId: device.id,
                        userUid:  null,
                        ip:       device.first_ip,
                        action:   'register_attempt',
                        provider: 'phone',
                        meta:     { phone: maskPhone(phone) },
                    })
                } catch (sessionErr) {
                    logger.warn({ component: 'Auth', err: sessionErr }, 'Erreur log session — ignorée')
                }
            }

            // 8. Générer et sauvegarder l'OTP
            const otpCode = generateOtpCode()
            await saveOtp(phone, otpCode)

            // 9. Envoyer via WhatsApp
            const message = `Votre code de vérification : *${otpCode}*\n\nValable 10 minutes. Ne le partagez jamais.`
            const sent    = await sendOtpViaWhatsApp(waManager, phone, message)

            if (!sent) {
                logger.warn({ component: 'Auth/OTP', phone: maskPhone(phone) }, 'WhatsApp non connecté — OTP non envoyé')
                if (config.isProd) {
                    res.status(503).json({
                        success: false,
                        error: {
                            code:    'WHATSAPP_UNAVAILABLE',
                            message: "Impossible d'envoyer le code — service WhatsApp non connecté",
                        },
                    })
                    return
                }
                logger.info({ component: 'Auth/OTP', phone: maskPhone(phone), otpCode }, 'DEV — OTP généré (WhatsApp off)')
            }

            logger.info({ component: 'Auth/OTP', phone: maskPhone(phone) }, 'OTP inscription envoyé')

            // 10. Répondre 202
            res.status(202).json({
                success: true,
                message: `Code de vérification envoyé au ${maskPhone(phone)} via WhatsApp`,
                ...(config.nodeEnv === 'development' && { devOtp: otpCode }),
            })

        } catch (err) {
            logger.error({ component: 'Auth/OTP', err }, 'Erreur register phone')
            res.status(500).json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: config.isProd ? 'Erreur interne' : String(err) },
            })
        }
    })

    // ── POST /api/v1/auth/phone/verify-otp ───────────────────────────────────
    /**
     * Vérification OTP après inscription — crée le compte Firebase + profil DB.
     *
     * Utilise createUser (pas upsertUser) pour distinguer création vs existence.
     * Si status === 'exists' → c'est en réalité une connexion.
     */
    router.post('/auth/phone/verify-otp', rateLimit, async (req, res) => {
        const { phone: rawPhone, code } = req.body as {
            phone?: unknown
            code?:  unknown
        }

        // ── Validation ─────────────────────────────────────────────────────────
        if (!rawPhone || typeof rawPhone !== 'string') {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'phone' est requis" },
            })
            return
        }
        if (!code || typeof code !== 'string') {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'code' est requis" },
            })
            return
        }

        const phone    = sanitizePhone(rawPhone)
        const codeTrim = code.trim()

        if (!/^\d{6}$/.test(codeTrim)) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Le code doit être composé de 6 chiffres' },
            })
            return
        }

        try {
            // ── Device fingerprint ─────────────────────────────────────────────
            let device: Awaited<ReturnType<typeof upsertDevice>>['device'] | null = null

            try {
                const fp       = extractFingerprint(req)
                const upserted = await upsertDevice(fp)
                device         = upserted.device

                const blocked = await isDeviceBlocked(fp.fingerprintHash)
                if (blocked.blocked) {
                    res.status(403).json({
                        success: false,
                        error: {
                            code:    'DEVICE_BLOCKED',
                            message: blocked.reason ?? 'Cet appareil a été bloqué.',
                        },
                    })
                    return
                }
            } catch (deviceErr) {
                logger.error({ component: 'Auth/OTP', err: deviceErr }, 'Erreur device fingerprint — bloqué fail-secure')
                res.status(500).json({ success: false, error: { code: 'DEVICE_ERROR', message: 'Impossible de vérifier l\'appareil. Réessayez.' } })
                return
            }

            // ── Vérifier l'OTP ──────────────────────────────────────────────────
            const otpResult = await verifyOtp(phone, codeTrim)

            if (otpResult !== 'valid') {
                const messages: Record<string, string> = {
                    invalid:   'Code incorrect',
                    expired:   'Code expiré — demandez un nouveau code',
                    exceeded:  'Trop de tentatives — demandez un nouveau code',
                    not_found: 'Aucun code en attente pour ce numéro — commencez par /auth/phone/register',
                }
                res.status(otpResult === 'invalid' ? 400 : 410).json({
                    success: false,
                    error: { code: otpResult.toUpperCase(), message: messages[otpResult] },
                })
                return
            }

            // ── Créer ou récupérer l'utilisateur Firebase ───────────────────────
            let firebaseUid: string
            try {
                const fbUser = await firebaseAuth.getUserByPhoneNumber(toFirebaseE164(phone))
                firebaseUid  = fbUser.uid
            } catch {
                try {
                    const fbUser = await firebaseAuth.createUser({
                        phoneNumber:   toFirebaseE164(phone),
                        displayName:   `User ${maskPhone(phone)}`,
                        emailVerified: false,
                        disabled:      false,
                    })
                    firebaseUid = fbUser.uid
                } catch (createErr: unknown) {
                    // Firebase rejette les numéros invalides / courts (ex : numéros de test)
                    // En dev : UID déterministe basé sur SHA-256 du numéro
                    if (config.nodeEnv !== 'production') {
                        const { createHash } = await import('crypto')
                        const deterministicUid = 'phone_' + createHash('sha256').update(phone).digest('hex').slice(0, 20)
                        try {
                            await firebaseAuth.getUser(deterministicUid)
                            firebaseUid = deterministicUid
                        } catch {
                            const fbUser = await firebaseAuth.createUser({
                                uid:           deterministicUid,
                                displayName:   `User ${maskPhone(phone)}`,
                                emailVerified: false,
                                disabled:      false,
                            })
                            firebaseUid = fbUser.uid
                        }
                    } else {
                        throw createErr
                    }
                }
            }

            // ── createUser (inscription stricte) ───────────────────────────────
            const { status, user } = await createUser({
                uid:         firebaseUid,
                email:       null,
                displayName: null,
                photoUrl:    null,
                provider:    'phone',
                phone,
            })

            let isNewAccount: boolean

            if (status === 'exists') {
                // Ce numéro est déjà enregistré → traiter comme une connexion
                await loginUser(firebaseUid)
                isNewAccount = false

                if (device) {
                    try {
                        await logDeviceSession({
                            deviceId: device.id,
                            userUid:  user.uid,
                            ip:       device.first_ip,
                            action:   'login_success',
                            provider: 'phone',
                        })
                    } catch (sessionErr) {
                        logger.warn({ component: 'Auth/OTP', err: sessionErr }, 'Erreur log session — ignorée')
                    }
                }

                logger.info(
                    { component: 'Auth/OTP', uid: firebaseUid, phone: maskPhone(phone) },
                    'Connexion OTP (compte existant)'
                )
            } else {
                // Nouveau compte créé
                isNewAccount = true

                if (device) {
                    try {
                        // Lier l'appareil au nouvel utilisateur
                        await linkDeviceToUser(device.id, firebaseUid)
                        await logDeviceSession({
                            deviceId: device.id,
                            userUid:  user.uid,
                            ip:       device.first_ip,
                            action:   'register_success',
                            provider: 'phone',
                        })
                    } catch (sessionErr) {
                        logger.warn({ component: 'Auth/OTP', err: sessionErr }, 'Erreur log session — ignorée')
                    }
                }

                logger.info(
                    { component: 'Auth/OTP', uid: firebaseUid, phone: maskPhone(phone) },
                    'Compte créé par OTP'
                )
            }

            // ── Supprimer l'OTP utilisé ─────────────────────────────────────────
            await deleteOtp(phone)

            // ── Générer le custom token ─────────────────────────────────────────
            const customToken = await firebaseAuth.createCustomToken(firebaseUid, {
                provider: 'phone',
            })

            res.json({
                success:      true,
                customToken,
                user:         sanitizeUser(user),
                isNewAccount,
            })

        } catch (err) {
            logger.error({ component: 'Auth/OTP', err }, 'Erreur verify-otp inscription')
            res.status(500).json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: config.isProd ? 'Erreur interne' : String(err) },
            })
        }
    })

    // ── POST /api/v1/auth/phone/login ─────────────────────────────────────────
    /**
     * Connexion d'un compte existant par téléphone.
     * L'appareil est loggué mais jamais bloqué à cette étape.
     *
     * Body : { "phone": "22960000000" }
     */
    router.post('/auth/phone/login', rateLimit, async (req, res) => {
        const { phone: rawPhone } = req.body as { phone?: unknown }

        if (!rawPhone || typeof rawPhone !== 'string') {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'phone' est requis" },
            })
            return
        }

        const phone = sanitizePhone(rawPhone)

        if (!PHONE_REGEX.test(phone)) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Format de numéro invalide' },
            })
            return
        }

        try {
            // ── Device fingerprint ─────────────────────────────────────────────
            let device: Awaited<ReturnType<typeof upsertDevice>>['device'] | null = null
            let deviceRegisteredUid: string | null = null

            try {
                const fp       = extractFingerprint(req)
                const upserted = await upsertDevice(fp)
                device         = upserted.device

                // 1. Bloquer si l'appareil est blacklisté
                const blocked = await isDeviceBlocked(fp.fingerprintHash)
                if (blocked.blocked) {
                    res.status(403).json({
                        success: false,
                        error: { code: 'DEVICE_BLOCKED', message: blocked.reason ?? 'Cet appareil a été bloqué.' },
                    })
                    return
                }

                // 2. Récupérer le compte lié à cet appareil (s'il existe)
                deviceRegisteredUid = await getDeviceRegisteredUid(fp.fingerprintHash)
            } catch (deviceErr) {
                logger.error({ component: 'Auth/OTP', err: deviceErr }, 'Erreur device fingerprint — login bloqué fail-secure')
                res.status(500).json({ success: false, error: { code: 'DEVICE_ERROR', message: 'Impossible de vérifier l\'appareil. Réessayez.' } })
                return
            }

            // 3. Vérifier que le compte existe
            const existing = await getUserByPhone(phone)
            if (!existing) {
                res.status(404).json({
                    success: false,
                    error: { code: 'PHONE_NOT_REGISTERED', message: 'Aucun compte associé à ce numéro. Utilisez /auth/phone/register.' },
                })
                return
            }

            // 4. Vérifier que le compte est actif
            if (!existing.active) {
                res.status(403).json({
                    success: false,
                    error: { code: 'ACCOUNT_DISABLED', message: 'Ce compte est désactivé.' },
                })
                return
            }

            // 5. Vérifier la règle d'unicité appareil-compte :
            //    Si l'appareil est déjà lié à un autre compte → interdire la connexion
            if (deviceRegisteredUid !== null && deviceRegisteredUid !== existing.uid) {
                logger.warn(
                    { component: 'Auth/OTP', deviceRegisteredUid, requestedUid: existing.uid },
                    'Tentative de connexion depuis un appareil lié à un autre compte'
                )
                res.status(409).json({
                    success: false,
                    error: {
                        code:    'DEVICE_BOUND_TO_ANOTHER_ACCOUNT',
                        message: 'Cet appareil est déjà lié à un autre compte. Connexion refusée.',
                    },
                })
                return
            }
            // 6. Logger la tentative de connexion
            if (device) {
                try {
                    await logDeviceSession({
                        deviceId: device.id,
                        userUid:  existing.uid,
                        ip:       device.first_ip,
                        action:   'login_attempt',
                        provider: 'phone',
                        meta:     { phone: maskPhone(phone) },
                    })
                } catch (sessionErr) {
                    logger.warn({ component: 'Auth/OTP', err: sessionErr }, 'Erreur log session — ignorée')
                }
            }

            // 7. Générer et envoyer l'OTP
            const otpCode = generateOtpCode()
            await saveOtp(phone, otpCode)

            const message = `🔐 Votre code de connexion : *${otpCode}*\n\nValable 10 minutes.`
            const sent    = await sendOtpViaWhatsApp(waManager, phone, message)

            if (!sent && config.isProd) {
                res.status(503).json({
                    success: false,
                    error: { code: 'WHATSAPP_UNAVAILABLE', message: 'Service WhatsApp non connecté' },
                })
                return
            }

            if (!sent) {
                logger.info({ component: 'Auth/OTP', phone: maskPhone(phone), otpCode }, 'DEV — OTP login (WhatsApp off)')
            }

            logger.info({ component: 'Auth/OTP', phone: maskPhone(phone) }, 'OTP connexion envoyé')

            res.status(202).json({
                success: true,
                message: `Code de connexion envoyé au ${maskPhone(phone)} via WhatsApp`,
                ...(config.nodeEnv === 'development' && { devOtp: otpCode }),
            })

        } catch (err) {
            logger.error({ component: 'Auth/OTP', err }, 'Erreur phone login')
            res.status(500).json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: config.isProd ? 'Erreur interne' : String(err) },
            })
        }
    })

    // ── POST /api/v1/auth/phone/login/verify-otp ─────────────────────────────
    /**
     * Vérification OTP pour la connexion (pas l'inscription).
     * Le compte doit déjà exister.
     *
     * Body : { "phone": "22960000000", "code": "123456" }
     */
    router.post('/auth/phone/login/verify-otp', rateLimit, async (req, res) => {
        const { phone: rawPhone, code } = req.body as {
            phone?: unknown
            code?:  unknown
        }

        // ── Validation ─────────────────────────────────────────────────────────
        if (!rawPhone || typeof rawPhone !== 'string') {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'phone' est requis" },
            })
            return
        }
        if (!code || typeof code !== 'string') {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: "Le champ 'code' est requis" },
            })
            return
        }

        const phone    = sanitizePhone(rawPhone)
        const codeTrim = code.trim()

        if (!/^\d{6}$/.test(codeTrim)) {
            res.status(400).json({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Le code doit être composé de 6 chiffres' },
            })
            return
        }

        try {
            // ── Device fingerprint ─────────────────────────────────────────────
            let device: Awaited<ReturnType<typeof upsertDevice>>['device'] | null = null

            try {
                const fp       = extractFingerprint(req)
                const upserted = await upsertDevice(fp)
                device         = upserted.device

                const blocked = await isDeviceBlocked(fp.fingerprintHash)
                if (blocked.blocked) {
                    res.status(403).json({
                        success: false,
                        error: {
                            code:    'DEVICE_BLOCKED',
                            message: blocked.reason ?? 'Cet appareil a été bloqué.',
                        },
                    })
                    return
                }
            } catch (deviceErr) {
                logger.error({ component: 'Auth/OTP', err: deviceErr }, 'Erreur device fingerprint — login/verify bloqué fail-secure')
                res.status(500).json({ success: false, error: { code: 'DEVICE_ERROR', message: 'Impossible de vérifier l\'appareil. Réessayez.' } })
                return
            }

            // ── Vérifier l'OTP ──────────────────────────────────────────────────
            const otpResult = await verifyOtp(phone, codeTrim)

            if (otpResult !== 'valid') {
                const messages: Record<string, string> = {
                    invalid:   'Code incorrect',
                    expired:   'Code expiré — demandez un nouveau code',
                    exceeded:  'Trop de tentatives — demandez un nouveau code',
                    not_found: 'Aucun code en attente pour ce numéro',
                }
                res.status(otpResult === 'invalid' ? 400 : 410).json({
                    success: false,
                    error: { code: otpResult.toUpperCase(), message: messages[otpResult] },
                })
                return
            }

            // ── Vérifier que le compte existe ───────────────────────────────────
            const user = await getUserByPhone(phone)
            if (!user) {
                res.status(404).json({
                    success: false,
                    error: {
                        code:    'PHONE_NOT_REGISTERED',
                        message: 'Aucun compte associé à ce numéro.',
                    },
                })
                return
            }

            // ── Vérifier que le compte est actif ────────────────────────────────
            if (!user.active) {
                res.status(403).json({
                    success: false,
                    error: { code: 'ACCOUNT_DISABLED', message: 'Ce compte est désactivé.' },
                })
                return
            }

            // ── Générer le custom token ─────────────────────────────────────────
            const customToken = await firebaseAuth.createCustomToken(user.uid, {
                provider: 'phone',
            })

            // ── Mettre à jour last_login_at ─────────────────────────────────────
            await loginUser(user.uid)

            // ── Logger la session ──────────────────────────────────────────────
            if (device) {
                try {
                    await logDeviceSession({
                        deviceId: device.id,
                        userUid:  user.uid,
                        ip:       device.first_ip,
                        action:   'login_success',
                        provider: 'phone',
                    })
                } catch (sessionErr) {
                    logger.warn({ component: 'Auth/OTP', err: sessionErr }, 'Erreur log session — ignorée')
                }
            }

            // ── Supprimer l'OTP ─────────────────────────────────────────────────
            await deleteOtp(phone)

            logger.info(
                { component: 'Auth/OTP', uid: user.uid, phone: maskPhone(phone) },
                'Connexion OTP réussie'
            )

            res.json({
                success:     true,
                customToken,
                user:        sanitizeUser(user),
            })

        } catch (err) {
            logger.error({ component: 'Auth/OTP', err }, 'Erreur login verify-otp')
            res.status(500).json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: config.isProd ? 'Erreur interne' : String(err) },
            })
        }
    })

    return router
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers privés
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Envoie l'OTP en passant directement par la logique interne (waManager +
 * file d'attente), sans repasser par le réseau via un appel HTTP à soi-même.
 * Retourne true si mis en file d'attente, false si WhatsApp non connecté.
 */
async function sendOtpViaWhatsApp(
    waManager: WhatsAppManager,
    phone:     string,
    message:   string,
): Promise<boolean> {
    try {
        if (!waManager.isReady()) {
            return false  // WhatsApp non connecté
        }

        const { id, position } = await enqueue({ recipient: phone, message })

        logger.info(
            { component: 'Auth/OTP', messageId: id, position },
            'OTP mis en file (in-process, sans appel HTTP loopback)'
        )

        return true
    } catch (err) {
        logger.error({ component: 'Auth/OTP', err }, 'Erreur mise en file OTP (interne)')
        return false
    }
}

/** Masque un numéro pour les logs : 229****000 */
function maskPhone(phone: string): string {
    if (phone.length <= 6) return '***'
    return phone.slice(0, 3) + '****' + phone.slice(-3)
}

/** Nettoie tout numéro saisi → chiffres purs sans + (espaces, tirets, parenthèses, points, 01 béninois, etc.) */
function sanitizePhone(raw: string): string {
    return normalizePhone(raw)
}

/** Retourne un objet utilisateur sans champs sensibles */
function sanitizeUser(user: UserRow): object {
    return {
        uid:         user.uid,
        email:       user.email,
        displayName: user.display_name,
        photoUrl:    user.photo_url,
        provider:    user.provider,
        active:      Boolean(user.active),
        createdAt:   user.created_at,
        lastLoginAt: user.last_login_at,
    }
}