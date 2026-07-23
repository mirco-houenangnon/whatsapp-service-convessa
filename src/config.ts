/**
 * config.ts — Lecture et validation de toutes les variables d'environnement.
 * Le processus s'arrête au démarrage si une variable obligatoire est absente.
 */

import dotenv from 'dotenv'
dotenv.config()

function required(name: string): string {
    const val = process.env[name]?.trim()
    if (!val) {
        console.error(`[Config] ❌ Variable obligatoire manquante : ${name}`)
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
const corsOrigin = optional('CORS_ORIGIN', '*')
if (IS_PROD && corsOrigin === '*') {
    console.warn('[Config] ⚠️  CORS_ORIGIN=* en production — restreignez à votre domaine')
}

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
        host:     optional('DB_HOST', '127.0.0.1'),
        port:     optionalInt('DB_PORT', 3306),
        name:     optional('DB_NAME', 'whatsapp_service'),
        user:     optional('DB_USER', 'root'),
        pass:     process.env['DB_PASS'] ?? '',
    },

    queue: {
        delayMs:    optionalInt('MESSAGE_DELAY_MS', 1500),
        delayMaxMs: optionalInt('MESSAGE_DELAY_MAX_MS', 3000),
        maxRetry:   optionalInt('MAX_RETRY_ATTEMPTS', 3),
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
} as const

export type AppConfig = typeof config
