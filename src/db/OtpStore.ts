/**
 * OtpStore.ts — Gestion des codes OTP — PostgreSQL.
 */

import { createHash, randomInt } from 'crypto'
import { query } from './connection.js'

const OTP_TTL_SECONDS  = 10 * 60
const OTP_MAX_ATTEMPTS = 5

export interface OtpRow {
    phone:      string
    code_hash:  string
    expires_at: Date
    attempts:   number
    verified:   boolean
    created_at: Date
}

export function generateOtpCode(): string { return String(randomInt(100_000, 999_999)) }
export function hashOtp(code: string): string { return createHash('sha256').update(code).digest('hex') }

export async function saveOtp(phone: string, code: string): Promise<void> {
    const codeHash  = hashOtp(code)
    const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000)

    await query(
        `INSERT INTO auth_otp_codes (phone, code_hash, expires_at, attempts, verified)
         VALUES ($1, $2, $3, 0, FALSE)
         ON CONFLICT (phone) DO UPDATE
             SET code_hash  = EXCLUDED.code_hash,
                 expires_at = EXCLUDED.expires_at,
                 attempts   = 0,
                 verified   = FALSE,
                 created_at = NOW()`,
        [phone, codeHash, expiresAt]
    )
}

export async function verifyOtp(
    phone: string,
    code: string
): Promise<'valid' | 'invalid' | 'expired' | 'exceeded' | 'not_found'> {
    const now  = new Date()
    const rows = await query<OtpRow>(
        `SELECT phone, code_hash, expires_at, attempts, verified FROM auth_otp_codes WHERE phone = $1 LIMIT 1`,
        [phone]
    )
    const otp = rows[0]
    if (!otp)          return 'not_found'
    if (otp.verified)  return 'expired'
    if (now > new Date(otp.expires_at)) return 'expired'
    if (otp.attempts >= OTP_MAX_ATTEMPTS) return 'exceeded'

    await query(`UPDATE auth_otp_codes SET attempts = attempts + 1 WHERE phone = $1`, [phone])

    if (hashOtp(code) !== otp.code_hash) return 'invalid'

    await query(`UPDATE auth_otp_codes SET verified = TRUE WHERE phone = $1`, [phone])
    return 'valid'
}

export async function deleteOtp(phone: string): Promise<void> {
    await query(`DELETE FROM auth_otp_codes WHERE phone = $1`, [phone])
}

export async function isOtpVerified(phone: string): Promise<boolean> {
    const rows = await query<{ verified: boolean }>(
        `SELECT verified FROM auth_otp_codes WHERE phone = $1 AND verified = TRUE AND expires_at > NOW() LIMIT 1`,
        [phone]
    )
    return rows.length > 0
}
