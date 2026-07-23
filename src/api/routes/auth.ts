/**
 * auth.ts — Routes d'authentification multiplateforme.
 *
 * Providers supportés :
 *   - google.com  (Firebase OAuth)
 *   - github.com  (Firebase OAuth)
 *   - phone       (OTP WhatsApp maison)
 *
 * Routes OAuth Firebase (Google / GitHub) :
 *   POST /api/v1/auth/verify   — Vérifier un ID Token Firebase
 *   POST /api/v1/auth/logout   — Révoquer le token Firebase
 *   GET  /api/v1/auth/me       — Profil de l'utilisateur connecté
 *
 * Routes Auth par téléphone (OTP) :
 *   POST /api/v1/auth/phone/register    — Vérif unicité + envoi OTP via WhatsApp
 *   POST /api/v1/auth/phone/verify-otp  — Vérif OTP → Firebase Custom Token → ID Token
 *   POST /api/v1/auth/phone/login       — Connexion (renvoi OTP si compte existant)
 *
 * Routes Admin (X-Api-Key) :
 *   GET    /api/v1/auth/users        — Lister les utilisateurs
 *   DELETE /api/v1/auth/users/:uid   — Désactiver un compte
 */

import { Router }                  from 'express'
import { requireFirebaseAuth,
         requireFirebaseProvider } from '../middleware/firebaseAuth.js'
import { requireApiKey }           from '../middleware/auth.js'
import { rateLimit }               from '../middleware/rateLimit.js'
import { firebaseAuth }            from '../../services/firebase.js'
import { upsertUser,
         getUserByUid,
         getUserByPhone,
         listUsers,
         deactivateUser,
         type UserRow }            from '../../db/UserStore.js'
import { generateOtpCode,
         saveOtp,
         verifyOtp,
         deleteOtp }               from '../../db/OtpStore.js'
import { logger }                  from '../../services/logger.js'
import { config }                  from '../../config.js'

const ALLOWED_PROVIDERS = ['google.com', 'github.com']

// Regex numéro international : chiffres uniquement, sans +, 7-15 chiffres
const PHONE_REGEX = /^\d{7,15}$/

function sanitizePhone(raw: string): string {
    return raw.replace(/[\s\-().+]/g, '')
}

export function authRouter(): Router {
    const router = Router()

    // ── POST /api/v1/auth/verify ──────────────────────────────────────────────
    /**
     * @swagger
     * /api/v1/auth/verify:
     *   post:
     *     tags: [Auth]
     *     summary: Vérifier un Firebase ID Token et créer/mettre à jour le profil
     *     description: |
     *       Endpoint principal d'authentification. Le client envoie le ID Token
     *       obtenu après connexion OAuth (Google ou GitHub) via le SDK Firebase.
     *       Le serveur vérifie le token, crée ou met à jour le compte en base,
     *       et retourne le profil utilisateur.
     *     security:
     *       - bearerAuth: []
     *     responses:
     *       200:
     *         description: Token valide — profil retourné
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/AuthProfile'
     *       401:
     *         $ref: '#/components/responses/Unauthorized'
     *       403:
     *         $ref: '#/components/responses/ForbiddenProvider'
     */

    
    router.post(
        '/auth/verify',
        requireFirebaseAuth,
        requireFirebaseProvider(ALLOWED_PROVIDERS),
        async (req, res) => {
            const decoded = req.firebaseUser!

            try {
                // En dev avec Custom Token, lire le claim custom `provider`
                const signInProvider = (decoded['firebase']?.['sign_in_provider'] as string) ?? 'unknown'
                const isDev          = config.nodeEnv !== 'production'
                const provider       = (isDev && signInProvider === 'custom' && decoded['provider'])
                    ? (decoded['provider'] as string)
                    : signInProvider

                const user = await upsertUser({
                    uid:          decoded.uid,
                    email:        decoded.email ?? null,
                    displayName:  decoded.name  ?? null,
                    photoUrl:     decoded.picture ?? null,
                    provider,
                })

                logger.info(
                    { component: 'Auth', uid: decoded.uid, provider },
                    'Utilisateur authentifié'
                )

                res.json({
                    success: true,
                    user:    sanitizeUser(user),
                })
            } catch (err) {
                logger.error({ component: 'Auth', err }, 'Erreur upsertUser')
                res.status(500).json({
                    success: false,
                    error: {
                        code:    'INTERNAL_ERROR',
                        message: config.isProd ? 'Erreur interne' : String(err),
                    },
                })
            }
        }
    )

    // ── GET /api/v1/auth/me ───────────────────────────────────────────────────
    /**
     * @swagger
     * /api/v1/auth/me:
     *   get:
     *     tags: [Auth]
     *     summary: Profil de l'utilisateur connecté
     *     description: Retourne le profil complet de l'utilisateur dont le token est fourni.
     *     security:
     *       - bearerAuth: []
     *     responses:
     *       200:
     *         description: Profil utilisateur
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/AuthProfile'
     *       401:
     *         $ref: '#/components/responses/Unauthorized'
     *       404:
     *         description: Utilisateur non trouvé en base (appeler /verify d'abord)
     */
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
  
    router.post(
        '/auth/logout',
        requireFirebaseAuth,
        async (req, res) => {
            const { uid } = req.firebaseUser!

            try {
                // Révoque tous les refresh tokens Firebase de cet utilisateur
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
        }
    )

    // ── GET /api/v1/auth/users — Admin ────────────────────────────────────────
    /**
     * @swagger
     * /api/v1/auth/users:
     *   get:
     *     tags: [Auth - Admin]
     *     summary: Lister les utilisateurs enregistrés
     *     description: Endpoint admin — nécessite la clé API Bridge.
     *     security:
     *       - apiKeyAuth: []
     *     parameters:
     *       - in: query
     *         name: page
     *         schema:
     *           type: integer
     *           default: 1
     *       - in: query
     *         name: limit
     *         schema:
     *           type: integer
     *           default: 20
     *           maximum: 100
     *       - in: query
     *         name: provider
     *         schema:
     *           type: string
     *           enum: [google.com, github.com]
     *         description: Filtrer par provider OAuth
     *     responses:
     *       200:
     *         description: Liste paginée des utilisateurs
     *       401:
     *         $ref: '#/components/responses/Unauthorized'
     */
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
    /**
     * @swagger
     * /api/v1/auth/users/{uid}:
     *   delete:
     *     tags: [Auth - Admin]
     *     summary: Désactiver un compte utilisateur
     *     description: Désactive le compte en base ET révoque les tokens Firebase.
     *     security:
     *       - apiKeyAuth: []
     *     parameters:
     *       - in: path
     *         name: uid
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Compte désactivé
     *       404:
     *         description: Utilisateur introuvable
     *       401:
     *         $ref: '#/components/responses/Unauthorized'
     */
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

            // Désactiver en base + révoquer les tokens Firebase en parallèle
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
     * 1. Valide le format du numéro
     * 2. Vérifie que le numéro n'est pas déjà utilisé
     * 3. Génère un OTP 6 chiffres, le stocke haché en DB
     * 4. L'envoie via POST /api/v1/messages/send (WhatsApp interne)
     *
     * Body : { "phone": "22960000000", "displayName": "Jean" }
     */
    router.post('/auth/phone/register', rateLimit, async (req, res) => {
        const { phone: rawPhone, displayName } = req.body as {
            phone?: unknown
            displayName?: unknown
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

        const name = typeof displayName === 'string' ? displayName.trim().slice(0, 100) : null

        try {
            // ── Vérifier unicité ────────────────────────────────────────────────
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

            // ── Générer et sauvegarder l'OTP ───────────────────────────────────
            const otpCode = generateOtpCode()
            await saveOtp(phone, otpCode)

            // ── Envoyer via WhatsApp (appel interne à messages/send) ────────────
            const message = `Votre code de vérification : *${otpCode}*\n\nValable 10 minutes. Ne le partagez jamais.`
            const sent    = await sendOtpViaWhatsApp(phone, message)

            if (!sent) {
                logger.warn({ component: 'Auth/OTP', phone: maskPhone(phone) }, 'WhatsApp non connecté — OTP non envoyé')
                // En dev on continue (le code est loggué), en prod on bloque
                if (config.isProd) {
                    res.status(503).json({
                        success: false,
                        error: {
                            code:    'WHATSAPP_UNAVAILABLE',
                            message: 'Impossible d\'envoyer le code — service WhatsApp non connecté',
                        },
                    })
                    return
                }
                // Dev : logger le code pour faciliter les tests
                logger.info({ component: 'Auth/OTP', phone: maskPhone(phone), otpCode }, 'DEV — OTP généré (WhatsApp off)')
            }

            logger.info({ component: 'Auth/OTP', phone: maskPhone(phone) }, 'OTP envoyé')

            res.status(202).json({
                success: true,
                message: `Code de vérification envoyé au ${maskPhone(phone)} via WhatsApp`,
                // En dev uniquement : exposer le code dans la réponse pour les tests
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
     * Vérification de l'OTP après inscription.
     *
     * 1. Vérifie le code OTP (expiration, tentatives, hash)
     * 2. Crée le compte Firebase + profil en DB
     * 3. Retourne un Firebase ID Token prêt à l'emploi
     *    → le frontend peut appeler /auth/me directement avec ce token
     *
     * Body : { "phone": "22960000000", "code": "123456" }
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
            // ── Vérifier l'OTP ──────────────────────────────────────────────────
            const result = await verifyOtp(phone, codeTrim)

            if (result !== 'valid') {
                const messages: Record<string, string> = {
                    invalid:   'Code incorrect',
                    expired:   'Code expiré — demandez un nouveau code',
                    exceeded:  'Trop de tentatives — demandez un nouveau code',
                    not_found: 'Aucun code en attente pour ce numéro — commencez par /auth/phone/register',
                }
                res.status(result === 'invalid' ? 400 : 410).json({
                    success: false,
                    error: { code: result.toUpperCase(), message: messages[result] },
                })
                return
            }

            // ── Créer ou récupérer l'utilisateur Firebase ───────────────────────
            let firebaseUid: string
            try {
                // Tenter de récupérer un user Firebase existant avec ce numéro
                const fbUser = await firebaseAuth.getUserByPhoneNumber(`+${phone}`)
                firebaseUid  = fbUser.uid
            } catch {
                try {
                    // Créer un nouveau compte Firebase avec ce numéro
                    const fbUser = await firebaseAuth.createUser({
                        phoneNumber:   `+${phone}`,
                        displayName:   `User ${maskPhone(phone)}`,
                        emailVerified: false,
                        disabled:      false,
                    })
                    firebaseUid = fbUser.uid
                } catch (createErr: unknown) {
                    // Firebase rejette les numéros invalides (ex: numéros de test courts)
                    // En dev : créer un compte Firebase sans numéro et stocker le numéro uniquement en DB
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

            // ── Upsert profil en DB ─────────────────────────────────────────────
            const user = await upsertUser({
                uid:         firebaseUid,
                email:       null,
                displayName: null,
                photoUrl:    null,
                provider:    'phone',
                phone,
            })

            // ── Générer un Custom Token → échangeable contre un ID Token ────────
            const customToken = await firebaseAuth.createCustomToken(firebaseUid, {
                provider: 'phone',
            })

            // Nettoyer l'OTP utilisé
            await deleteOtp(phone)

            logger.info(
                { component: 'Auth/OTP', uid: firebaseUid, phone: maskPhone(phone) },
                'Compte activé par OTP'
            )

            res.json({
                success:     true,
                customToken,   // Le frontend échange ce token contre un ID Token via Firebase SDK
                user:        sanitizeUser(user),
                message:     'Compte activé. Échangez le customToken contre un ID Token via le SDK Firebase.',
            })

        } catch (err) {
            logger.error({ component: 'Auth/OTP', err }, 'Erreur verify-otp')
            res.status(500).json({
                success: false,
                error: { code: 'INTERNAL_ERROR', message: config.isProd ? 'Erreur interne' : String(err) },
            })
        }
    })

    // ── POST /api/v1/auth/phone/login ─────────────────────────────────────────
    /**
     * Connexion d'un compte existant par numéro de téléphone.
     * Renvoi d'un OTP si le compte existe déjà.
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
            // Vérifier que le compte existe
            const existing = await getUserByPhone(phone)
            if (!existing) {
                res.status(404).json({
                    success: false,
                    error: {
                        code:    'PHONE_NOT_REGISTERED',
                        message: 'Aucun compte associé à ce numéro. Utilisez /auth/phone/register.',
                    },
                })
                return
            }

            if (!existing.active) {
                res.status(403).json({
                    success: false,
                    error: { code: 'ACCOUNT_DISABLED', message: 'Ce compte est désactivé' },
                })
                return
            }

            // Générer et envoyer un OTP
            const otpCode = generateOtpCode()
            await saveOtp(phone, otpCode)

            const message = `🔐 Votre code de connexion : *${otpCode}*\n\nValable 10 minutes.`
            const sent    = await sendOtpViaWhatsApp(phone, message)

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

    return router
}

// ── Helpers privés ─────────────────────────────────────────────────────────────

/**
 * Envoie l'OTP via le endpoint interne /api/v1/messages/send.
 * Retourne true si mis en file, false si WhatsApp non connecté.
 */
async function sendOtpViaWhatsApp(phone: string, message: string): Promise<boolean> {
    try {
        const url  = `http://127.0.0.1:${config.port}/api/v1/messages/send`
        const resp = await fetch(url, {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(config.bridgeApiKey ? { 'X-Api-Key': config.bridgeApiKey } : {}),
            },
            body: JSON.stringify({ to: phone, message }),
        })

        if (resp.status === 503) return false  // WhatsApp non connecté
        return resp.ok || resp.status === 202
    } catch {
        return false
    }
}

/** Masque un numéro pour les logs (ex: 229****000) */
function maskPhone(phone: string): string {
    if (phone.length <= 6) return '***'
    return phone.slice(0, 3) + '****' + phone.slice(-3)
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sanitizeUser(user: UserRow) {
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
