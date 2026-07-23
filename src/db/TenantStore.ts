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

export interface Tenant {
    id:          string
    userUid:     string | null
    phone:       string
    name:        string | null
    apiKeyHash:  string | null
    apiKeyHint:  string | null
    webhookUrl:  string | null
    status:      TenantStatus
    connectedAt: Date | null
    createdAt:   Date
}

interface TenantRow {
    id:           string
    user_uid:     string | null
    phone:        string
    name:         string | null
    api_key_hash: string | null
    api_key_hint: string | null
    api_key_enc:  string | null
    api_key_iv:   string | null
    api_key_tag:  string | null
    webhook_url:  string | null
    status:       TenantStatus
    connected_at: Date | null
    created_at:   Date
}

function rowToTenant(row: TenantRow): Tenant {
    return {
        id:          row.id,
        userUid:     row.user_uid,
        phone:       row.phone,
        name:        row.name,
        apiKeyHash:  row.api_key_hash,
        apiKeyHint:  row.api_key_hint,
        webhookUrl:  row.webhook_url,
        status:      row.status,
        connectedAt: row.connected_at,
        createdAt:   row.created_at,
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
 */
export async function createTenant(data: {
    phone:       string
    name?:       string
    webhookUrl?: string
    userUid?:    string   // FK vers auth_users.uid
}): Promise<Tenant> {
    const pool = getPool()
    const id   = uuidv4()

    await pool.execute(
        `INSERT INTO wa_tenants (id, phone, name, webhook_url, user_uid, status)
         VALUES (?, ?, ?, ?, ?, 'pending_qr')`,
        [id, data.phone, data.name ?? null, data.webhookUrl ?? null, data.userUid ?? null]
    )

    logger.info(
        { component: 'TenantStore', tenantId: id, phone: maskPhone(data.phone) },
        'Tenant créé'
    )

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
    id:      string,
    hash:    string,
    hint:    string,
    token:   string   // clé brute — sera chiffrée avant stockage
): Promise<void> {
    const pool    = getPool()
    const payload = encrypt(token, config.sessionEncryptionKey)

    await pool.execute(
        `UPDATE wa_tenants
         SET api_key_hash = ?,
             api_key_hint = ?,
             api_key_enc  = ?,
             api_key_iv   = ?,
             api_key_tag  = ?,
             status       = 'connected',
             connected_at = CURRENT_TIMESTAMP,
             updated_at   = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [hash, hint, payload.data, payload.iv, payload.tag, id]
    )
    logger.info({ component: 'TenantStore', tenantId: id }, 'Clé API enregistrée (chiffrée)')
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
