/**
 * auth.ts — Routes d'authentification multiplateforme via Firebase.
 *
 * Le flux OAuth (Google / GitHub) est géré entièrement côté client par le SDK
 * Firebase JS/Mobile. Une fois l'utilisateur connecté, le client envoie le
 * ID Token Firebase à ces endpoints pour :
 *
 *   POST /api/v1/auth/verify   — Vérifier un ID Token et retourner le profil
 *   POST /api/v1/auth/logout   — Révoquer le token (Firebase + côté serveur)
 *   GET  /api/v1/auth/me       — Retourner le profil de l'utilisateur connecté
 *   GET  /api/v1/auth/users    — [Admin] Lister les utilisateurs (clé API requise)
 *   DELETE /api/v1/auth/users/:uid — [Admin] Désactiver un compte
 *
 * Providers supportés : google.com | github.com
 */

import { Router }                  from 'express'
import { requireFirebaseAuth,
         requireFirebaseProvider } from '../middleware/firebaseAuth.js'
import { requireApiKey }           from '../middleware/auth.js'
import { firebaseAuth }            from '../../services/firebase.js'
import { upsertUser,
         getUserByUid,
         listUsers,
         deactivateUser,
         type UserRow }        from '../../db/UserStore.js'
import { logger }                  from '../../services/logger.js'
import { config }                  from '../../config.js'

const ALLOWED_PROVIDERS = ['google.com', 'github.com']

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
    /**
     * @swagger
     * /api/v1/auth/logout:
     *   post:
     *     tags: [Auth]
     *     summary: Déconnexion — révocation du token Firebase
     *     description: |
     *       Révoque tous les refresh tokens de l'utilisateur côté Firebase.
     *       Les ID tokens existants restent valides jusqu'à leur expiration naturelle
     *       (1h), mais les tentatives de rafraîchissement échoueront.
     *       Pour une révocation immédiate, activez `checkRevoked: true` dans verifyIdToken.
     *     security:
     *       - bearerAuth: []
     *     responses:
     *       200:
     *         description: Déconnexion effectuée
     *       401:
     *         $ref: '#/components/responses/Unauthorized'
     */
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

    return router
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
