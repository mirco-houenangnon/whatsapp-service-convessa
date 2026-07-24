/**
 * apiKeyService.ts — Génération et vérification des clés API tenants.
 *
 * Format : pk_convessa_{64 bytes hex} = 128 chars après le préfixe
 * - Préfixe "pk_convessa_" identifie clairement Convessa
 * - 64 bytes (512 bits) de crypto.randomBytes → 128 chars hex
 * - Stockage : SHA-256 du token en base (jamais le token brut)
 * - Durée de validité : 30 jours
 */

import { randomBytes, createHash } from 'crypto'

const PREFIX       = 'pk_convessa_'
const VALIDITY_MS  = 30 * 24 * 60 * 60 * 1000 // 30 jours

export function generateApiKey(): {
    token:     string   // ex: pk_convessa_a3f8c2d1...128chars
    hash:      string   // SHA-256 du token — à stocker en base
    hint:      string   // ex: "pk_convessa_a3f8..." — pour affichage partiel
    expiresAt: Date     // date d'expiration (maintenant + 30 jours)
} {
    const raw      = randomBytes(64).toString('hex')  // 128 chars
    const token    = `${PREFIX}${raw}`
    const hash     = createHash('sha256').update(token).digest('hex')
    const hint     = `${PREFIX}${raw.slice(0, 12)}...`
    const expiresAt = new Date(Date.now() + VALIDITY_MS)

    return { token, hash, hint, expiresAt }
}

export function verifyApiKey(token: string, storedHash: string): boolean {
    const hash = createHash('sha256').update(token).digest('hex')
    if (hash.length !== storedHash.length) return false
    let diff = 0
    for (let i = 0; i < hash.length; i++) {
        diff |= hash.charCodeAt(i) ^ storedHash.charCodeAt(i)
    }
    return diff === 0
}

export function isValidApiKeyFormat(token: string): boolean {
    return token.startsWith(PREFIX) && token.length === PREFIX.length + 128
}
