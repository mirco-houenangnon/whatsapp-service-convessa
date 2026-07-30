/**
 * config.ts — Lecture et validation de toutes les variables d'environnement.
 * Le processus s'arrête au démarrage si une variable obligatoire est absente.
 */

import dotenv from 'dotenv'
dotenv.config()

function required(name: string): string {
    const val = process.env[name]?.trim()
    if (!val) {
        console.error(`[Config] Variable obligatoire manquante : ${name}`)
        process.exit(1)
    }
    return val
}

function optional(name: string, defaultValue: string): string {
    return process.env[name]?.trim() || defaultValue
}

function optionalInt(name: string, defaultValue: number): number {
    const val = process.env[name]?.trim()
    if (!val) return defaultValue
    const parsed = parseInt(val, 10)
    return isNaN(parsed) ? defaultValue : parsed
}

const IS_PROD = process.env['NODE_ENV'] === 'production'

// ── Clé API ────────────────────────────────────────────────────────────────────
const bridgeApiKey = process.env['BRIDGE_API_KEY']?.trim() ?? ''
if (IS_PROD && !bridgeApiKey) {
    console.error('[Config] ❌ BRIDGE_API_KEY est obligatoire en production.')
    process.exit(1)
}
if (!IS_PROD && !bridgeApiKey) {
    console.warn('[Config] ⚠️  BRIDGE_API_KEY non définie — API non protégée (mode local uniquement)')
}

// ── Clé de chiffrement ────────────────────────────────────────────────────────
const sessionEncryptionKey = IS_PROD
    ? required('SESSION_ENCRYPTION_KEY')
    : optional('SESSION_ENCRYPTION_KEY', 'dev-encryption-key-do-not-use-in-prod-32x')

// ── CORS ──────────────────────────────────────────────────────────────────────
const corsOriginRaw = optional('CORS_ORIGIN', '*')
if (IS_PROD && corsOriginRaw === '*') {
    console.warn('[Config] ⚠️  CORS_ORIGIN=* en production — restreignez à votre domaine')
}
// Supporte plusieurs origines séparées par une virgule : "https://a.com,https://b.com"
// Supporte aussi le wildcard "*.vercel.app" pour les previews Vercel
const _corsOrigins = corsOriginRaw === '*'
    ? ['*']
    : corsOriginRaw.split(',').map(s => s.trim()).filter(Boolean)

// Fonction de validation CORS — accepte les wildcards "*.domain.com"
function buildCorsOrigin(origins: string[]): string | string[] | ((origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void) {
    if (origins.includes('*')) return '*'

    // Sépare les patterns wildcard des URLs exactes
    const wildcards = origins.filter(o => o.startsWith('*.'))
    const exact     = origins.filter(o => !o.startsWith('*.'))

    if (wildcards.length === 0) return exact

    // Retourne une fonction de validation pour les wildcards
    return (origin, cb) => {
        if (!origin) { cb(null, true); return }
        if (exact.includes(origin)) { cb(null, true); return }
        const allowed = wildcards.some(pattern => {
            const suffix = pattern.slice(1) // "*.vercel.app" → ".vercel.app"
            return origin.endsWith(suffix)
        })
        cb(null, allowed)
    }
}

const corsOrigin = buildCorsOrigin(_corsOrigins)

// ── Alerte e-mail ─────────────────────────────────────────────────────────────
const alertEmail = process.env['ALERT_EMAIL']?.trim() ?? ''
const smtpHost   = process.env['SMTP_HOST']?.trim() ?? ''

if (alertEmail && !smtpHost) {
    console.warn('[Config] ⚠️  ALERT_EMAIL définie mais SMTP_HOST manquant — alertes désactivées')
}

const alertConfig = alertEmail && smtpHost
    ? {
        email:    alertEmail,
        smtpHost,
        smtpPort: optionalInt('SMTP_PORT', 587),
        smtpUser: process.env['SMTP_USER']?.trim() ?? '',
        smtpPass: process.env['SMTP_PASS']?.trim() ?? '',
        smtpFrom: optional('SMTP_FROM', 'whatsapp-service@localhost'),
    }
    : null

// ── Firebase ──────────────────────────────────────────────────────────────────
const firebaseServiceAccountJson = process.env['FIREBASE_SERVICE_ACCOUNT_JSON']?.trim() ?? ''
const firebaseServiceAccountPath = process.env['FIREBASE_SERVICE_ACCOUNT_PATH']?.trim() ?? ''
const firebaseProjectId          = process.env['FIREBASE_PROJECT_ID']?.trim() ?? ''

if (IS_PROD && !firebaseServiceAccountJson && !firebaseServiceAccountPath) {
    console.error(
        '[Config] ❌ Firebase non configuré en production. Définissez FIREBASE_SERVICE_ACCOUNT_JSON ou FIREBASE_SERVICE_ACCOUNT_PATH'
    )
    process.exit(1)
}

export const config = {
    port:                  optionalInt('PORT', 3005),
    nodeEnv:               optional('NODE_ENV', 'development') as 'development' | 'production',
    isProd:                IS_PROD,
    bridgeApiKey,
    corsOrigin,
    enableDashboard:       process.env['ENABLE_DASHBOARD'] === 'true',
    sessionEncryptionKey,

    db: {
        host: optional('DB_HOST', '127.0.0.1'),
        port: optionalInt('DB_PORT', 3306),
        name: optional('DB_NAME', 'convessa'),
        user: optional('DB_USER', 'root'),
        pass: process.env['DB_PASS'] ?? '',
    },

    queue: {
        delayMs:    optionalInt('MESSAGE_DELAY_MS', 1500),
        delayMaxMs: optionalInt('MESSAGE_DELAY_MAX_MS', 3000),
        maxRetry:   optionalInt('MAX_RETRY_ATTEMPTS', 3),
    },

    // ── URL publique du service (utilisée dans la doc Swagger, les liens, etc.) ──
    publicUrl: optional('PUBLIC_URL', `http://127.0.0.1:${optionalInt('PORT', 3005)}`),

    // ── Rate limiting ──────────────────────────────────────────────────────────
    rateLimit: {
        max:      optionalInt('RATE_LIMIT_MAX', 60),        // requêtes max / fenêtre
        windowMs: optionalInt('RATE_LIMIT_WINDOW_MS', 60_000), // fenêtre en ms
    },

    // ── Clé API tenant ─────────────────────────────────────────────────────────
    apiKey: {
        validityDays: optionalInt('API_KEY_VALIDITY_DAYS', 30),
    },

    // ── Envoi de messages tenant (/api/v1/send) ───────────────────────────────
    send: {
        // Filet de sécurité interne — n'est PLUS renvoyé comme erreur au client :
        // /send répond immédiatement, ce timeout ne fait qu'éviter qu'une
        // promesse Baileys bloquée ne reste ouverte indéfiniment en mémoire.
        safetyTimeoutMs: optionalInt('SEND_SAFETY_TIMEOUT_MS', 120_000),
    },

    // ── QR code tenant ─────────────────────────────────────────────────────────
    qr: {
        expiresInSec: optionalInt('QR_EXPIRES_IN_SEC', 60),
    },

    alert: alertConfig,

    // ── Firebase Auth ──────────────────────────────────────────────────────────
    firebase: {
        /** Contenu JSON de la clé de service Firebase (prioritaire sur PATH) */
        serviceAccountJson: firebaseServiceAccountJson,
        /** Chemin local vers le fichier JSON de la clé de service */
        serviceAccountPath: firebaseServiceAccountPath,
        /** ID du projet Firebase (optionnel — déduit depuis la clé de service) */
        projectId:          firebaseProjectId,
    },

    logLevel: optional('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',

    // ── Admin Backoffice ───────────────────────────────────────────────────────
    adminJwtSecret: optional('ADMIN_JWT_SECRET', 'convessa-admin-dev-secret-change-in-prod'),

    // ── Passerelles de paiement ────────────────────────────────────────────────
    payments: {
        fedapay: {
            secretKey:   optional('FEDAPAY_SECRET_KEY', ''),
            callbackUrl: optional('FEDAPAY_CALLBACK_URL', ''),
            environment: optional('FEDAPAY_ENV', 'live') as 'live' | 'sandbox',
        },
        kkiapay: {
            privateKey:  optional('KKIAPAY_PRIVATE_KEY', ''),
            publicKey:   optional('KKIAPAY_PUBLIC_KEY', ''),
            secretKey:   optional('KKIAPAY_SECRET_KEY', ''),
            sandbox:     process.env['KKIAPAY_SANDBOX'] === 'true',
        },
        // URL du frontend — pour construire les URLs de retour après paiement
        frontendUrl: optional('FRONTEND_URL', 'http://localhost:5173'),
    },
} as const

export type AppConfig = typeof config
