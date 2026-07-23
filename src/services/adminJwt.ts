/**
 * adminJwt.ts — Génération et vérification des JWT admin Convessa.
 *
 * Implémentation manuelle HMAC-SHA256 sans dépendance externe.
 * Format : header.payload.signature (JWT standard)
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '../config.js'

export interface AdminTokenPayload {
    sub:  number   // admin id
    iat:  number   // issued at
    exp:  number   // expiration
    type: 'admin'
}

const EXPIRY_SECONDS = 24 * 60 * 60  // 24h

function b64url(input: string | Buffer): string {
    const buf = typeof input === 'string' ? Buffer.from(input) : input
    return buf.toString('base64url')
}

function sign(header: string, payload: string, secret: string): string {
    return createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url')
}

export function createAdminToken(adminId: number): string {
    const secret  = config.adminJwtSecret
    const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const now     = Math.floor(Date.now() / 1000)
    const payload = b64url(JSON.stringify({
        sub:  adminId,
        iat:  now,
        exp:  now + EXPIRY_SECONDS,
        type: 'admin',
    } satisfies AdminTokenPayload))

    const sig = sign(header, payload, secret)
    return `${header}.${payload}.${sig}`
}

export function verifyAdminToken(token: string): AdminTokenPayload | null {
    try {
        const parts = token.split('.')
        if (parts.length !== 3) return null

        const [header, payload, sig] = parts as [string, string, string]
        const secret   = config.adminJwtSecret
        const expected = sign(header, payload, secret)

        // Timing-safe compare
        const sigBuf = Buffer.from(sig,      'base64url')
        const expBuf = Buffer.from(expected, 'base64url')

        if (sigBuf.length !== expBuf.length) return null
        if (!timingSafeEqual(sigBuf, expBuf)) return null

        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as AdminTokenPayload

        if (decoded.type !== 'admin') return null
        if (decoded.exp < Math.floor(Date.now() / 1000)) return null

        return decoded
    } catch {
        return null
    }
}
