/**
 * firebaseAuth.ts — Middleware de vérification du Firebase ID Token.
 *
 * Le client (frontend / app mobile) échange ses credentials OAuth (Google, GitHub)
 * directement avec Firebase Authentication, puis envoie le ID Token résultant
 * dans l'en-tête Authorization : "Bearer <idToken>"
 *
 * Ce middleware :
 *   1. Extrait le token de l'en-tête Authorization
 *   2. Le vérifie cryptographiquement via Firebase Admin SDK
 *   3. Attache `req.firebaseUser` (DecodedIdToken) pour les handlers suivants
 *   4. Optionnellement restreint l'accès à certains providers (Google, GitHub)
 */

import type { RequestHandler } from 'express'
import type { DecodedIdToken }  from 'firebase-admin/auth'
import { firebaseAuth }         from '../../services/firebase.js'
import { logger }               from '../../services/logger.js'

// Extension du type Request Express pour y attacher l'utilisateur Firebase
declare global {
    namespace Express {
        interface Request {
            firebaseUser?: DecodedIdToken
        }
    }
}

/**
 * Middleware principal — vérifie le Bearer token Firebase.
 */
export const requireFirebaseAuth: RequestHandler = async (req, res, next) => {
    const authHeader = req.headers['authorization']

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({
            success: false,
            error: {
                code:    'UNAUTHORIZED',
                message: "Token d'authentification manquant (Authorization: Bearer <idToken>)",
            },
        })
        return
    }

    const idToken = authHeader.slice(7).trim()

    if (!idToken) {
        res.status(401).json({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Token vide' },
        })
        return
    }

    try {
        const decoded = await firebaseAuth.verifyIdToken(idToken, /* checkRevoked */ true)
        req.firebaseUser = decoded
        next()
    } catch (err: unknown) {
        const firebaseErr = err as { code?: string; message?: string }

        logger.warn(
            { component: 'FirebaseAuth', code: firebaseErr.code },
            `Token Firebase rejeté : ${firebaseErr.code}`
        )

        const statusCode = firebaseErr.code === 'auth/id-token-expired' ? 401 : 403

        res.status(statusCode).json({
            success: false,
            error: {
                code:    mapFirebaseErrorCode(firebaseErr.code),
                message: mapFirebaseErrorMessage(firebaseErr.code),
            },
        })
    }
}

/**
 * Factory — restreint l'accès à une liste de providers OAuth autorisés.
 *
 * En mode development, le provider "custom" (Custom Token SDK Admin, utilisé
 * pour les tests scripts) est accepté si le claim `provider` custom est dans
 * la liste des providers autorisés.
 *
 * @example requireFirebaseProvider(['google.com', 'github.com'])
 */
export function requireFirebaseProvider(allowedProviders: string[]): RequestHandler {
    return (req, res, next) => {
        const user = req.firebaseUser

        if (!user) {
            res.status(401).json({
                success: false,
                error: { code: 'UNAUTHORIZED', message: 'Non authentifié' },
            })
            return
        }

        // Provider standard OAuth (google.com, github.com, password, etc.)
        const signInProvider = (user['firebase']?.['sign_in_provider'] as string | undefined) ?? ''

        // En dev : les Custom Tokens du SDK Admin ont sign_in_provider = "custom"
        // On lit le claim custom `provider` injecté lors de createCustomToken()
        const isDev          = process.env['NODE_ENV'] !== 'production'
        const customClaim    = (user['provider'] as string | undefined) ?? ''
        const effectiveProvider = (isDev && signInProvider === 'custom' && customClaim)
            ? customClaim
            : signInProvider

        if (!allowedProviders.includes(effectiveProvider)) {
            res.status(403).json({
                success: false,
                error: {
                    code:    'FORBIDDEN_PROVIDER',
                    message: `Provider non autorisé. Acceptés : ${allowedProviders.join(', ')}`,
                },
            })
            return
        }

        next()
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function mapFirebaseErrorCode(code?: string): string {
    switch (code) {
        case 'auth/id-token-expired':    return 'TOKEN_EXPIRED'
        case 'auth/id-token-revoked':    return 'TOKEN_REVOKED'
        case 'auth/invalid-id-token':    return 'TOKEN_INVALID'
        case 'auth/user-disabled':       return 'USER_DISABLED'
        case 'auth/argument-error':      return 'TOKEN_MALFORMED'
        default:                          return 'AUTH_ERROR'
    }
}

function mapFirebaseErrorMessage(code?: string): string {
    switch (code) {
        case 'auth/id-token-expired':  return 'Token expiré — veuillez vous reconnecter'
        case 'auth/id-token-revoked':  return 'Token révoqué — veuillez vous reconnecter'
        case 'auth/invalid-id-token':  return 'Token invalide'
        case 'auth/user-disabled':     return 'Compte désactivé'
        case 'auth/argument-error':    return 'Token malformé'
        default:                        return "Erreur d'authentification"
    }
}
