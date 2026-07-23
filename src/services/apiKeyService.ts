/**
 * apiKeyService.ts — Génération et vérification des clés API tenants.
 *
 * Format : wag_live_{32 bytes hex} (64 chars après le préfixe)
 * - Préfixe "wag_live_" identifie le service et l'environnement
 * - 32 bytes (256 bits) de crypto.randomBytes → 64 chars hex
 * - 256 bits d'entropie = impossible à bruteforcer
 * - Stockage : SHA-256 du token en base (jamais le token brut)
 * - Hint : 8 premiers chars après le préfixe pour identification visuelle
 *
 * Référence : bonnes pratiques Stripe, GitHub, Zuplo (prefix + entropy + hash storage)
 */

import { randomBytes, createHash } from 'crypto'

const PREFIX = 'wag_live_'

/**
 * Génère une nouvelle clé API.
 * Retourne le token brut (à envoyer au client UNE SEULE FOIS) et le hash à stocker.
 */
export function generateApiKey(): {
    token:     string   // ex: wag_live_a3f8c2d1e9b4f7a0c5e2d8b1f6a3c9e4d7b0f2a5c8e1d4b7f0a3c6e9d2b5f8a1
    hash:      string   // SHA-256 du token — à stocker en base
    hint:      string   // ex: "wag_live_a3f8..." — pour affichage partiel
} {
    const raw   = randomBytes(32).toString('hex')  // 64 chars
    const token = `${PREFIX}${raw}`
    const hash  = createHash('sha256').update(token).digest('hex')
    const hint  = `${PREFIX}${raw.slice(0, 8)}...`

    return { token, hash, hint }
}

/**
 * Vérifie si un token fourni correspond au hash stocké.
 */
export function verifyApiKey(token: string, storedHash: string): boolean {
    const hash = createHash('sha256').update(token).digest('hex')
    // Comparaison en temps constant
    if (hash.length !== storedHash.length) return false
    let diff = 0
    for (let i = 0; i < hash.length; i++) {
        diff |= hash.charCodeAt(i) ^ storedHash.charCodeAt(i)
    }
    return diff === 0
}

/**
 * Extrait le tenantId depuis un token API.
 * Retourne null si le format est invalide.
 */
export function isValidApiKeyFormat(token: string): boolean {
    return token.startsWith(PREFIX) && token.length === PREFIX.length + 64
}
