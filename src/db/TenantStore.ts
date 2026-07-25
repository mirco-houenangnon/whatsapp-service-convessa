/**
 * TenantStore.ts — CRUD des tenants (clients du service).
 */

import { v4 as uuidv4 }    from 'uuid'
import { getPool }          from './connection.js'
import { logger, maskPhone } from '../services/logger.js'
import { encrypt, decrypt } from '../services/crypto.js'
import { config }           from '../config.js'
import type mysql from 'mysql2/promise'

export type TenantStatus = 'pending_qr' | 'connected' | 'disconnected' | 'revoked'

/**
 * Type de privilège d'utilisation accordé au tenant (code de parrainage ou
 * plan gratuit) au moment de l'activation :
 *   - unlimited : aucune limite, ni durée ni quota
 *   - duration  : la clé expire à apiKeyExpiresAt
 *   - requests  : la clé est valable pour messagesLimit messages (voir messagesSent)
 */
export type TenantUsageType = 'unlimited' | 'duration' | 'requests'

export interface Tenant {
    id:             string
    userUid:        string | null
    /** null tant que le tenant n'a pas encore scanné son QR code */
    phone:          string | null
    name:           string | null
    apiKeyHash:     string | null
    apiKeyHint:     string | null
    webhookUrl:     string | null
    status:         TenantStatus
    connectedAt:    Date | null
    createdAt:      Date
    apiKeyExpiresAt: Date | null
    usageType:      TenantUsageType
    messagesLimit:  number | null
    messagesSent:   number
    referralCode:   string | null
}

interface TenantRow {
    id:                string
    user_uid:          string | null
    phone:             string | null
    name:              string | null
    api_key_hash:      string | null
    api_key_hint:      string | null
    api_key_enc:       string | null
    api_key_iv:        string | null
    api_key_tag:       string | null
    webhook_url:       string | null
    status:            TenantStatus
    connected_at:      Date | null
    created_at:        Date
    api_key_expires_at: Date | null
    usage_type:        TenantUsageType
    messages_limit:    number | null
    messages_sent:     number
    referral_code:     string | null
}

function rowToTenant(row: TenantRow): Tenant {
    return {
        id:              row.id,
        userUid:         row.user_uid,
        phone:           row.phone,
        name:            row.name,
        apiKeyHash:      row.api_key_hash,
        apiKeyHint:      row.api_key_hint,
        webhookUrl:      row.webhook_url,
        status:          row.status,
        connectedAt:     row.connected_at,
        createdAt:       row.created_at,
        apiKeyExpiresAt: row.api_key_expires_at,
        usageType:       row.usage_type ?? 'unlimited',
        messagesLimit:   row.messages_limit,
        messagesSent:    row.messages_sent ?? 0,
        referralCode:    row.referral_code,
    }
}

/**
 * Déchiffre et retourne la clé API complète d'un tenant.
 * Retourne null si pas de clé ou si données de chiffrement absentes.
 */
export function decryptApiKey(row: TenantRow): string | null {
    if (!row.api_key_enc || !row.api_key_iv || !row.api_key_tag) return null
    try {
        return decrypt(
            { iv: row.api_key_iv, tag: row.api_key_tag, data: row.api_key_enc },
            config.sessionEncryptionKey
        )
    } catch {
        return null
    }
}

/**
 * Crée un nouveau tenant lié optionnellement à un user Firebase.
 *
 * Le téléphone n'est JAMAIS fourni ici : il est inconnu jusqu'au scan du QR.
 * `TenantManager` le renseigne automatiquement (via `updateTenantPhone`) en
 * lisant le JID réel renvoyé par Baileys à la connexion.
 */
export async function createTenant(data: {
    name?:       string
    webhookUrl?: string
    userUid?:    string   // FK vers auth_users.uid
}): Promise<Tenant> {
    const pool = getPool()
    const id   = uuidv4()

    await pool.execute(
        `INSERT INTO wa_tenants (id, phone, name, webhook_url, user_uid, status)
         VALUES (?, NULL, ?, ?, ?, 'pending_qr')`,
        [id, data.name ?? null, data.webhookUrl ?? null, data.userUid ?? null]
    )

    logger.info({ component: 'TenantStore', tenantId: id }, 'Tenant créé (sans numéro — en attente de scan)')

    const tenant = await getTenantById(id)
    if (!tenant) throw new Error('Tenant introuvable après création')
    return tenant
}

/**
 * Récupère un tenant par son ID.
 */
export async function getTenantById(id: string): Promise<Tenant | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<TenantRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM wa_tenants WHERE id = ?',
        [id]
    )
    const row = rows[0]
    return row ? rowToTenant(row) : null
}

/**
 * Récupère la clé API déchiffrée d'un tenant.
 * Retourne null si le tenant n'existe pas ou n'a pas de clé.
 */
export async function getTenantApiKey(id: string): Promise<string | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<TenantRow[] & mysql.RowDataPacket[]>(
        'SELECT api_key_enc, api_key_iv, api_key_tag FROM wa_tenants WHERE id = ?',
        [id]
    )
    const row = rows[0]
    if (!row) return null
    return decryptApiKey(row)
}

/**
 * Récupère un tenant par son numéro de téléphone.
 */
export async function getTenantByPhone(phone: string): Promise<Tenant | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<TenantRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM wa_tenants WHERE phone = ?',
        [phone]
    )
    const row = rows[0]
    return row ? rowToTenant(row) : null
}

/**
 * Récupère la session WhatsApp active (ou en attente) d'un utilisateur.
 *
 * Règle de sécurité : UN utilisateur ne peut avoir qu'UNE seule session
 * WhatsApp (donc une seule clé API) à la fois.
 */
export async function getTenantByUserUid(userUid: string): Promise<Tenant | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<TenantRow[] & mysql.RowDataPacket[]>(
        `SELECT * FROM wa_tenants
         WHERE user_uid = ?
           AND status IN ('pending_qr', 'connected')
         ORDER BY created_at DESC
         LIMIT 1`,
        [userUid]
    )
    const row = rows[0]
    return row ? rowToTenant(row) : null
}

/**
 * Vérifie si un numéro WhatsApp est déjà rattaché à un tenant appartenant
 * à un AUTRE utilisateur que celui fourni.
 *
 * Règle de sécurité : UN numéro WhatsApp ne peut être utilisé que par UN
 * seul utilisateur — il ne peut pas être réutilisé par un autre compte
 * tant que le tenant existant est actif (pending_qr ou connected).
 */
export async function getTenantByPhoneForOtherUser(phone: string, userUid: string): Promise<Tenant | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<TenantRow[] & mysql.RowDataPacket[]>(
        `SELECT * FROM wa_tenants
         WHERE phone = ?
           AND status IN ('pending_qr', 'connected')
           AND (user_uid IS NULL OR user_uid != ?)
         LIMIT 1`,
        [phone, userUid]
    )
    const row = rows[0]
    return row ? rowToTenant(row) : null
}

/**
 * Récupère un tenant par le hash de sa clé API.
 */
export async function getTenantByApiKeyHash(hash: string): Promise<Tenant | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<TenantRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM wa_tenants WHERE api_key_hash = ?',
        [hash]
    )
    const row = rows[0]
    return row ? rowToTenant(row) : null
}

/**
 * Met à jour le statut d'un tenant.
 */
export async function updateTenantStatus(
    id:     string,
    status: TenantStatus
): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE wa_tenants
         SET status       = ?,
             connected_at = CASE WHEN ? = 'connected' THEN CURRENT_TIMESTAMP ELSE connected_at END,
             updated_at   = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, status, id]
    )
}

/**
 * Enregistre la clé API d'un tenant.
 * - Hash SHA-256 pour la vérification des requêtes
 * - Chiffrement AES-256-GCM pour pouvoir la réafficher au tenant
 * - Hint pour l'identification visuelle
 */
export async function setTenantApiKey(
    id:        string,
    hash:      string,
    hint:      string,
    token:     string,
    expiresAt: Date
): Promise<void> {
    const pool    = getPool()
    const payload = encrypt(token, config.sessionEncryptionKey)

    await pool.execute(
        `UPDATE wa_tenants
         SET api_key_hash       = ?,
             api_key_hint       = ?,
             api_key_enc        = ?,
             api_key_iv         = ?,
             api_key_tag        = ?,
             api_key_expires_at = ?,
             status             = 'connected',
             connected_at       = CURRENT_TIMESTAMP,
             updated_at         = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [hash, hint, payload.data, payload.iv, payload.tag, expiresAt, id]
    )
    logger.info({ component: 'TenantStore', tenantId: id }, 'Clé API enregistrée (chiffrée, expire dans 30 jours)')
}

/**
 * Privilèges d'utilisation à appliquer lors de la génération de la clé API
 * (calculés depuis un code de parrainage ou le plan gratuit — voir
 * services/tenantPrivileges.ts).
 */
export interface TenantPrivileges {
    usageType:     TenantUsageType
    /** Nombre de messages autorisés — uniquement si usageType = 'requests' */
    messagesLimit: number | null
    /** Date d'expiration de la clé — uniquement si usageType = 'duration' */
    expiresAt:     Date | null
}

/**
 * Enregistre la clé API d'un tenant AVEC ses privilèges d'utilisation
 * (code de parrainage ou plan gratuit). Remplace l'ancien comportement où
 * la date d'expiration était toujours fixée à 30 jours : désormais,
 * `expiresAt` ne représente une expiration réelle que pour usageType = 'duration'
 * (NULL pour 'unlimited' et 'requests', ce dernier étant borné par messagesLimit).
 * - Hash SHA-256 pour la vérification des requêtes
 * - Chiffrement AES-256-GCM pour pouvoir la réafficher au tenant
 * - Hint pour l'identification visuelle
 */
export async function setTenantApiKeyWithPrivileges(
    id:          string,
    hash:        string,
    hint:        string,
    token:       string,
    privileges:  TenantPrivileges,
    referralCode: string | null = null,
): Promise<void> {
    const pool    = getPool()
    const payload = encrypt(token, config.sessionEncryptionKey)

    await pool.execute(
        `UPDATE wa_tenants
         SET api_key_hash       = ?,
             api_key_hint       = ?,
             api_key_enc        = ?,
             api_key_iv         = ?,
             api_key_tag        = ?,
             api_key_expires_at = ?,
             usage_type         = ?,
             messages_limit     = ?,
             messages_sent      = 0,
             referral_code      = ?,
             status             = 'connected',
             connected_at       = CURRENT_TIMESTAMP,
             updated_at         = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
            hash, hint, payload.data, payload.iv, payload.tag,
            privileges.expiresAt,
            privileges.usageType,
            privileges.messagesLimit,
            referralCode,
            id,
        ]
    )
    logger.info(
        { component: 'TenantStore', tenantId: id, usageType: privileges.usageType, expiresAt: privileges.expiresAt, messagesLimit: privileges.messagesLimit },
        'Clé API enregistrée avec privilèges d\'utilisation'
    )
}

/**
 * Incrémente le compteur de messages envoyés par un tenant (uniquement
 * pertinent pour usageType = 'requests', mais inoffensif dans les autres cas).
 */
export async function incrementMessagesSent(id: string): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE wa_tenants SET messages_sent = messages_sent + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [id]
    )
}

/**
 * Vérifie si un numéro WhatsApp (JID ou numéro brut) est déjà actif sur un AUTRE tenant.
 * Retourne le tenant qui l'utilise, ou null.
 *
 * @param jid       - JID Baileys (ex: "33612345678@s.whatsapp.net") ou numéro brut
 * @param excludeId - tenantId à exclure de la recherche (le tenant courant)
 */
export async function getTenantByWhatsAppJid(jid: string, excludeId?: string): Promise<Tenant | null> {
    const pool  = getPool()
    // Baileys JID format: "22990956919:19@s.whatsapp.net"
    // Le ":19" est le device ID — on doit l'ignorer pour avoir le vrai numéro
    const jidPart = jid.split('@')[0]                          // "22990956919:19"
    const phone   = jidPart.split(':')[0]?.replace(/[^0-9]/g, '') ?? ''  // "22990956919"
    if (!phone) return null

    const [rows] = await pool.execute<TenantRow[] & mysql.RowDataPacket[]>(
        `SELECT * FROM wa_tenants
         WHERE phone = ?
           AND status IN ('connected', 'pending_qr')
           ${excludeId ? 'AND id != ?' : ''}
         LIMIT 1`,
        excludeId ? [phone, excludeId] : [phone]
    )
    const row = rows[0]
    return row ? rowToTenant(row) : null
}

/**
 * Met à jour le numéro WhatsApp réel d'un tenant après connexion.
 * (Le numéro fourni lors de la création peut être fictif si OAuth)
 */
export async function updateTenantPhone(id: string, phone: string): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE wa_tenants SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [phone, id]
    )
}

/**
 * Supprime un tenant et sa session associée.
 */
export async function deleteTenant(id: string): Promise<void> {
    const pool = getPool()
    await pool.execute('DELETE FROM wa_session_keys WHERE session_id = ?', [id])
    await pool.execute('DELETE FROM wa_sessions WHERE id = ?', [id])
    await pool.execute('DELETE FROM wa_tenants WHERE id = ?', [id])
    logger.info({ component: 'TenantStore', tenantId: id }, 'Tenant supprimé')
}

/**
 * Liste tous les tenants (pour l'admin).
 */
export async function listTenants(): Promise<Tenant[]> {
    const pool   = getPool()
    const [rows] = await pool.execute<TenantRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM wa_tenants ORDER BY created_at DESC'
    )
    return (rows as TenantRow[]).map(rowToTenant)
}