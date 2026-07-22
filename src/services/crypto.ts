/**
 * crypto.ts — Chiffrement/déchiffrement AES-256-GCM.
 * Chaque opération utilise un IV aléatoire unique (16 bytes).
 * La clé de chiffrement provient de SESSION_ENCRYPTION_KEY (.env).
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'

const ALGORITHM = 'aes-256-gcm'

/**
 * Dérive une clé de 32 bytes depuis la clé brute du .env
 * (SHA-256 pour normaliser la longueur quelle que soit la source).
 */
function deriveKey(rawKey: string): Buffer {
    return createHash('sha256').update(rawKey).digest()
}

export interface EncryptedPayload {
    iv:   string  // hex — 16 bytes
    tag:  string  // hex — 16 bytes (GCM auth tag)
    data: string  // base64 — données chiffrées
}

/**
 * Chiffre un texte clair.
 * @param plaintext  Texte à chiffrer (ex: JSON stringify des creds Baileys)
 * @param rawKey     Clé brute depuis .env
 */
export function encrypt(plaintext: string, rawKey: string): EncryptedPayload {
    const key    = deriveKey(rawKey)
    const iv     = randomBytes(16)
    const cipher = createCipheriv(ALGORITHM, key, iv)

    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ])

    return {
        iv:   iv.toString('hex'),
        tag:  cipher.getAuthTag().toString('hex'),
        data: encrypted.toString('base64'),
    }
}

/**
 * Déchiffre un payload chiffré.
 * Lève une erreur si le tag d'authentification est invalide (données corrompues ou altérées).
 */
export function decrypt(payload: EncryptedPayload, rawKey: string): string {
    const key      = deriveKey(rawKey)
    const iv       = Buffer.from(payload.iv, 'hex')
    const tag      = Buffer.from(payload.tag, 'hex')
    const data     = Buffer.from(payload.data, 'base64')
    const decipher = createDecipheriv(ALGORITHM, key, iv)

    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([
        decipher.update(data),
        decipher.final(),
    ])

    return decrypted.toString('utf8')
}
