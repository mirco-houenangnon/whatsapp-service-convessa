/**
 * OtpStore.ts — Gestion des codes OTP pour l'auth par numéro de téléphone.
 *
 * Table : auth_otp_codes
 *   - Un seul OTP actif par numéro à la fois (ON DUPLICATE KEY UPDATE)
 *   - Expiration configurable (défaut : 10 minutes)
 *   - Code stocké haché (SHA-256) — jamais en clair en DB
 *   - Compteur de tentatives pour limiter le brute-force
 */

import { createHash, randomInt } from 'crypto'
import { getPool }               from './connection.js'

const OTP_TTL_SECONDS  = 10 * 60   // 10 minutes
const OTP_MAX_ATTEMPTS = 5         // tentatives avant invalidation

export interface OtpRow {
    phone:       string
    code_hash:   string
    expires_at:  Date
    attempts:    number
    verified:    boolean
    created_at:  Date
}

// ── Génération ─────────────────────────────────────────────────────────────────

/** Génère un code OTP numérique à 6 chiffres (cryptographiquement aléatoire) */
export function generateOtpCode(): string {
    return String(randomInt(100_000, 999_999))
}

/** Hache un code OTP en SHA-256 (hex) */
export function hashOtp(code: string): string {
    return createHash('sha256').update(code).digest('hex')
}

// ── Persistance ────────────────────────────────────────────────────────────────

/**
 * Crée ou remplace l'OTP pour un numéro.
 * Un seul OTP actif à la fois par numéro.
 */
export async function saveOtp(phone: string, code: string): Promise<void> {
    const pool     = getPool()
    const codeHash = hashOtp(code)
    const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000)

    await pool.execute(
        `INSERT INTO auth_otp_codes (phone, code_hash, expires_at, attempts, verified)
         VALUES (?, ?, ?, 0, FALSE)
         ON DUPLICATE KEY UPDATE
             code_hash  = VALUES(code_hash),
             expires_at = VALUES(expires_at),
             attempts   = 0,
             verified   = FALSE,
             created_at = NOW()`,
        [phone, codeHash, expiresAt]
    )
}

/**
 * Vérifie un OTP soumis par l'utilisateur.
 *
 * Retourne :
 *   'valid'     — code correct, non expiré, non dépassé
 *   'invalid'   — code incorrect
 *   'expired'   — OTP expiré
 *   'exceeded'  — trop de tentatives
 *   'not_found' — aucun OTP pour ce numéro
 */
export async function verifyOtp(
    phone: string,
    code: string
): Promise<'valid' | 'invalid' | 'expired' | 'exceeded' | 'not_found'> {
    const pool = getPool()
    const now  = new Date()

    const [rows] = await pool.execute(
        `SELECT phone, code_hash, expires_at, attempts, verified
         FROM auth_otp_codes
         WHERE phone = ?
         LIMIT 1`,
        [phone]
    )

    const list = rows as OtpRow[]
    const otp  = list[0]

    if (!otp) return 'not_found'

    // OTP déjà utilisé (vérifié)
    if (otp.verified) return 'expired'

    // Expiré
    if (now > new Date(otp.expires_at)) return 'expired'

    // Trop de tentatives
    if (otp.attempts >= OTP_MAX_ATTEMPTS) return 'exceeded'

    // Incrémenter le compteur de tentatives
    await pool.execute(
        `UPDATE auth_otp_codes SET attempts = attempts + 1 WHERE phone = ?`,
        [phone]
    )

    // Vérifier le code
    const submittedHash = hashOtp(code)
    if (submittedHash !== otp.code_hash) return 'invalid'

    // Marquer comme vérifié
    await pool.execute(
        `UPDATE auth_otp_codes SET verified = TRUE WHERE phone = ?`,
        [phone]
    )

    return 'valid'
}

/**
 * Supprime l'OTP d'un numéro (nettoyage après account creation).
 */
export async function deleteOtp(phone: string): Promise<void> {
    const pool = getPool()
    await pool.execute(`DELETE FROM auth_otp_codes WHERE phone = ?`, [phone])
}

/**
 * Vérifie si un OTP a bien été validé pour ce numéro
 * (utilisé comme guard avant création de compte).
 */
export async function isOtpVerified(phone: string): Promise<boolean> {
    const pool = getPool()

    const [rows] = await pool.execute(
        `SELECT verified FROM auth_otp_codes
         WHERE phone = ? AND verified = TRUE AND expires_at > NOW()
         LIMIT 1`,
        [phone]
    )

    return (rows as { verified: boolean }[]).length > 0
}
