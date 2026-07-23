/**
 * TenantStore.ts — CRUD des tenants (clients du service).
 */

import { v4 as uuidv4 }    from 'uuid'
import { getPool }          from './connection.js'
import { logger, maskPhone } from '../services/logger.js'
import type mysql from 'mysql2/promise'

export type TenantStatus = 'pending_qr' | 'connected' | 'disconnected' | 'revoked'

export interface Tenant {
    id:          string
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
    phone:        string
    name:         string | null
    api_key_hash: string | null
    api_key_hint: string | null
    webhook_url:  string | null
    status:       TenantStatus
    connected_at: Date | null
    created_at:   Date
}

function rowToTenant(row: TenantRow): Tenant {
    return {
        id:          row.id,
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
 * Crée un nouveau tenant.
 * Retourne le tenant créé.
 */
export async function createTenant(data: {
    phone:      string
    name?:      string
    webhookUrl?: string
}): Promise<Tenant> {
    const pool = getPool()
    const id   = uuidv4()

    await pool.execute(
        `INSERT INTO wa_tenants (id, phone, name, webhook_url, status)
         VALUES (?, ?, ?, ?, 'pending_qr')`,
        [id, data.phone, data.name ?? null, data.webhookUrl ?? null]
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
 * Enregistre la clé API d'un tenant (hash + hint, jamais le token brut).
 */
export async function setTenantApiKey(
    id:      string,
    hash:    string,
    hint:    string
): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE wa_tenants
         SET api_key_hash = ?,
             api_key_hint = ?,
             status       = 'connected',
             connected_at = CURRENT_TIMESTAMP,
             updated_at   = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [hash, hint, id]
    )
    logger.info({ component: 'TenantStore', tenantId: id }, 'Clé API enregistrée')
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
