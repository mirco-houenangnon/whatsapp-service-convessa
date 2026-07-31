/**
 * TenantStore.ts — CRUD des tenants — MySQL.
 */

import { v4 as uuidv4 }      from 'uuid'
import { query, execute }     from './connection.js'
import { logger, maskPhone }  from '../services/logger.js'
import { encrypt, decrypt }   from '../services/crypto.js'
import { config }             from '../config.js'
import type mysql             from 'mysql2/promise'

export type TenantStatus    = 'pending_qr' | 'connected' | 'disconnected' | 'revoked'
export type TenantUsageType = 'unlimited' | 'duration' | 'requests'

export interface Tenant {
    id:              string
    userUid:         string | null
    phone:           string | null
    name:            string | null
    apiKeyHash:      string | null
    apiKeyHint:      string | null
    webhookUrl:      string | null
    status:          TenantStatus
    connectedAt:     Date | null
    createdAt:       Date
    apiKeyExpiresAt: Date | null
    usageType:       TenantUsageType
    messagesLimit:   number | null
    messagesSent:    number
    referralCode:    string | null
}

export interface TenantPrivileges {
    usageType:     TenantUsageType
    messagesLimit: number | null
    expiresAt:     Date | null
}

interface TenantRow {
    id:                 string
    user_uid:           string | null
    phone:              string | null
    name:               string | null
    api_key_hash:       string | null
    api_key_hint:       string | null
    api_key_enc:        string | null
    api_key_iv:         string | null
    api_key_tag:        string | null
    webhook_url:        string | null
    status:             TenantStatus
    connected_at:       Date | null
    created_at:         Date
    api_key_expires_at: Date | null
    usage_type:         TenantUsageType
    messages_limit:     number | null
    messages_sent:      number
    referral_code:      string | null
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

export function decryptApiKey(row: TenantRow): string | null {
    if (!row.api_key_enc || !row.api_key_iv || !row.api_key_tag) return null
    try {
        return decrypt({ iv: row.api_key_iv, tag: row.api_key_tag, data: row.api_key_enc }, config.sessionEncryptionKey)
    } catch { return null }
}

export async function createTenant(data: { name?: string; webhookUrl?: string; userUid?: string }): Promise<Tenant> {
    const id = uuidv4()
    await execute(
        `INSERT INTO wa_tenants (id, phone, name, webhook_url, user_uid, status) VALUES (?, NULL, ?, ?, ?, 'pending_qr')`,
        [id, data.name ?? null, data.webhookUrl ?? null, data.userUid ?? null]
    )
    logger.info({ component: 'TenantStore', tenantId: id }, 'Tenant créé')
    const tenant = await getTenantById(id)
    if (!tenant) throw new Error('Tenant introuvable après création')
    return tenant
}

export async function getTenantById(id: string): Promise<Tenant | null> {
    const rows = await query<TenantRow>('SELECT * FROM wa_tenants WHERE id = ?', [id])
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function getTenantApiKey(id: string): Promise<string | null> {
    const rows = await query<TenantRow>('SELECT api_key_enc, api_key_iv, api_key_tag FROM wa_tenants WHERE id = ?', [id])
    return rows[0] ? decryptApiKey(rows[0]) : null
}

export async function getTenantByPhone(phone: string): Promise<Tenant | null> {
    const rows = await query<TenantRow>('SELECT * FROM wa_tenants WHERE phone = ?', [phone])
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function getTenantByUserUid(userUid: string): Promise<Tenant | null> {
    const rows = await query<TenantRow>(
        `SELECT * FROM wa_tenants WHERE user_uid = ? AND status IN ('pending_qr','connected','disconnected') ORDER BY created_at DESC LIMIT 1`,
        [userUid]
    )
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function getTenantByPhoneForOtherUser(phone: string, userUid: string): Promise<Tenant | null> {
    const rows = await query<TenantRow>(
        `SELECT * FROM wa_tenants WHERE phone = ? AND status IN ('pending_qr','connected') AND (user_uid IS NULL OR user_uid != ?) LIMIT 1`,
        [phone, userUid]
    )
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function getTenantByApiKeyHash(hash: string): Promise<Tenant | null> {
    const rows = await query<TenantRow>('SELECT * FROM wa_tenants WHERE api_key_hash = ?', [hash])
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function updateTenantStatus(id: string, status: TenantStatus): Promise<void> {
    await execute(
        `UPDATE wa_tenants SET status = ?,
             connected_at = CASE WHEN ? = 'connected' THEN CURRENT_TIMESTAMP ELSE connected_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, status, id]
    )
}

export async function setTenantApiKey(id: string, hash: string, hint: string, token: string, expiresAt: Date): Promise<void> {
    const payload = encrypt(token, config.sessionEncryptionKey)
    await execute(
        `UPDATE wa_tenants SET api_key_hash=?, api_key_hint=?, api_key_enc=?, api_key_iv=?, api_key_tag=?,
             api_key_expires_at=?, status='connected', connected_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [hash, hint, payload.data, payload.iv, payload.tag, expiresAt, id]
    )
}

export async function setTenantApiKeyWithPrivileges(
    id: string, hash: string, hint: string, token: string,
    privileges: TenantPrivileges, referralCode: string | null = null
): Promise<void> {
    const payload = encrypt(token, config.sessionEncryptionKey)
    await execute(
        `UPDATE wa_tenants SET api_key_hash=?, api_key_hint=?, api_key_enc=?, api_key_iv=?, api_key_tag=?,
             api_key_expires_at=?, usage_type=?, messages_limit=?, messages_sent=0, referral_code=?,
             status='connected', connected_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [hash, hint, payload.data, payload.iv, payload.tag, privileges.expiresAt,
         privileges.usageType, privileges.messagesLimit, referralCode, id]
    )
    logger.info({ component: 'TenantStore', tenantId: id, usageType: privileges.usageType }, 'Clé API enregistrée')
}

export async function incrementMessagesSent(id: string): Promise<void> {
    await execute(`UPDATE wa_tenants SET messages_sent = messages_sent + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id])
}

export async function getTenantByWhatsAppJid(jid: string, excludeId?: string): Promise<Tenant | null> {
    const jidPart = jid.split('@')[0] ?? ''
    const phone   = jidPart.split(':')[0]?.replace(/[^0-9]/g, '') ?? ''
    if (!phone) return null
    const sql    = `SELECT * FROM wa_tenants WHERE phone = ? AND status IN ('connected','pending_qr')${excludeId ? ' AND id != ?' : ''} LIMIT 1`
    const params = excludeId ? [phone, excludeId] : [phone]
    const rows   = await query<TenantRow>(sql, params)
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function updateTenantPhone(id: string, phone: string): Promise<void> {
    await execute(`UPDATE wa_tenants SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [phone, id])
}

export async function deleteTenant(id: string): Promise<void> {
    await execute('DELETE FROM wa_session_keys WHERE session_id = ?', [id])
    await execute('DELETE FROM wa_sessions WHERE id = ?', [id])
    await execute('DELETE FROM wa_tenants WHERE id = ?', [id])
    logger.info({ component: 'TenantStore', tenantId: id }, 'Tenant supprimé')
}

export async function listTenants(): Promise<Tenant[]> {
    const rows = await query<TenantRow>('SELECT * FROM wa_tenants ORDER BY created_at DESC')
    return rows.map(rowToTenant)
}
