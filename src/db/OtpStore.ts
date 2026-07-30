/**
 * OtpStore.ts — Codes OTP — MySQL.
 */

import { createHash, randomInt } from 'crypto'
import { query, execute }        from './connection.js'

const OTP_TTL_SECONDS  = 10 * 60
const OTP_MAX_ATTEMPTS = 5

export interface OtpRow { phone: string; code_hash: string; expires_at: Date; attempts: number; verified: boolean; created_at: Date }

export function generateOtpCode(): string { return String(randomInt(100_000, 999_999)) }
export function hashOtp(code: string): string { return createHash('sha256').update(code).digest('hex') }

export async function saveOtp(phone: string, code: string): Promise<void> {
    const codeHash  = hashOtp(code)
    const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000)
    await execute(
        `INSERT INTO auth_otp_codes (phone, code_hash, expires_at, attempts, verified) VALUES (?, ?, ?, 0, 0)
         ON DUPLICATE KEY UPDATE code_hash=VALUES(code_hash), expires_at=VALUES(expires_at), attempts=0, verified=0, created_at=NOW()`,
        [phone, codeHash, expiresAt]
    )
}

export async function verifyOtp(phone: string, code: string): Promise<'valid' | 'invalid' | 'expired' | 'exceeded' | 'not_found'> {
    const now  = new Date()
    const rows = await query<OtpRow>(`SELECT phone, code_hash, expires_at, attempts, verified FROM auth_otp_codes WHERE phone = ? LIMIT 1`, [phone])
    const otp  = rows[0]
    if (!otp) return 'not_found'
    if (otp.verified || Boolean(otp.verified)) return 'expired'
    if (now > new Date(otp.expires_at)) return 'expired'
    if (otp.attempts >= OTP_MAX_ATTEMPTS) return 'exceeded'

    await execute(`UPDATE auth_otp_codes SET attempts = attempts + 1 WHERE phone = ?`, [phone])
    if (hashOtp(code) !== otp.code_hash) return 'invalid'
    await execute(`UPDATE auth_otp_codes SET verified = 1 WHERE phone = ?`, [phone])
    return 'valid'
}

export async function deleteOtp(phone: string): Promise<void> {
    await execute(`DELETE FROM auth_otp_codes WHERE phone = ?`, [phone])
}

export async function isOtpVerified(phone: string): Promise<boolean> {
    const rows = await query(`SELECT verified FROM auth_otp_codes WHERE phone = ? AND verified = 1 AND expires_at > NOW() LIMIT 1`, [phone])
    return rows.length > 0
}
