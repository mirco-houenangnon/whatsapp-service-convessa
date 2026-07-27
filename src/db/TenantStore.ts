/**
 * TenantStore.ts — CRUD des tenants — PostgreSQL.
 */

import { v4 as uuidv4 }     from 'uuid'
import { query }             from './connection.js'
import { logger, maskPhone } from '../services/logger.js'
import { encrypt, decrypt }  from '../services/crypto.js'
import { config }            from '../config.js'

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
    await query(
        `INSERT INTO wa_tenants (id, phone, name, webhook_url, user_uid, status)
         VALUES ($1, NULL, $2, $3, $4, 'pending_qr')`,
        [id, data.name ?? null, data.webhookUrl ?? null, data.userUid ?? null]
    )
    logger.info({ component: 'TenantStore', tenantId: id }, 'Tenant créé')
    const tenant = await getTenantById(id)
    if (!tenant) throw new Error('Tenant introuvable après création')
    return tenant
}

export async function getTenantById(id: string): Promise<Tenant | null> {
    const rows = await query<TenantRow>('SELECT * FROM wa_tenants WHERE id = $1', [id])
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function getTenantApiKey(id: string): Promise<string | null> {
    const rows = await query<TenantRow>('SELECT api_key_enc, api_key_iv, api_key_tag FROM wa_tenants WHERE id = $1', [id])
    return rows[0] ? decryptApiKey(rows[0]) : null
}

export async function getTenantByPhone(phone: string): Promise<Tenant | null> {
    const rows = await query<TenantRow>('SELECT * FROM wa_tenants WHERE phone = $1', [phone])
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function getTenantByUserUid(userUid: string): Promise<Tenant | null> {
    const rows = await query<TenantRow>(
        `SELECT * FROM wa_tenants WHERE user_uid = $1 AND status IN ('pending_qr','connected')
         ORDER BY created_at DESC LIMIT 1`,
        [userUid]
    )
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function getTenantByPhoneForOtherUser(phone: string, userUid: string): Promise<Tenant | null> {
    const rows = await query<TenantRow>(
        `SELECT * FROM wa_tenants WHERE phone = $1 AND status IN ('pending_qr','connected')
         AND (user_uid IS NULL OR user_uid != $2) LIMIT 1`,
        [phone, userUid]
    )
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function getTenantByApiKeyHash(hash: string): Promise<Tenant | null> {
    const rows = await query<TenantRow>('SELECT * FROM wa_tenants WHERE api_key_hash = $1', [hash])
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function updateTenantStatus(id: string, status: TenantStatus): Promise<void> {
    await query(
        `UPDATE wa_tenants SET status = $1::varchar,
             connected_at = CASE WHEN $1::varchar = 'connected' THEN NOW() ELSE connected_at END,
             updated_at   = NOW()
         WHERE id = $2`,
        [status, id]
    )
}

export async function setTenantApiKey(id: string, hash: string, hint: string, token: string, expiresAt: Date): Promise<void> {
    const payload = encrypt(token, config.sessionEncryptionKey)
    await query(
        `UPDATE wa_tenants SET api_key_hash = $1, api_key_hint = $2, api_key_enc = $3,
             api_key_iv = $4, api_key_tag = $5, api_key_expires_at = $6,
             status = 'connected', connected_at = NOW(), updated_at = NOW()
         WHERE id = $7`,
        [hash, hint, payload.data, payload.iv, payload.tag, expiresAt, id]
    )
}

export async function setTenantApiKeyWithPrivileges(
    id: string, hash: string, hint: string, token: string,
    privileges: TenantPrivileges, referralCode: string | null = null
): Promise<void> {
    const payload = encrypt(token, config.sessionEncryptionKey)
    await query(
        `UPDATE wa_tenants
         SET api_key_hash = $1, api_key_hint = $2, api_key_enc = $3,
             api_key_iv = $4, api_key_tag = $5, api_key_expires_at = $6,
             usage_type = $7::varchar, messages_limit = $8, messages_sent = 0,
             referral_code = $9, status = 'connected', connected_at = NOW(), updated_at = NOW()
         WHERE id = $10`,
        [hash, hint, payload.data, payload.iv, payload.tag, privileges.expiresAt,
         privileges.usageType, privileges.messagesLimit, referralCode, id]
    )
    logger.info({ component: 'TenantStore', tenantId: id, usageType: privileges.usageType }, 'Clé API enregistrée')
}

export async function incrementMessagesSent(id: string): Promise<void> {
    await query(`UPDATE wa_tenants SET messages_sent = messages_sent + 1, updated_at = NOW() WHERE id = $1`, [id])
}

export async function getTenantByWhatsAppJid(jid: string, excludeId?: string): Promise<Tenant | null> {



    // Baileys JID format: "22990956919:19@s.whatsapp.net"
    // Le ":19" est le device ID — on doit l'ignorer pour avoir le vrai numéro
    const jidPart = jid.split('@')[0]                          // "22990956919:19"
    if (!jidPart) return null
    const phone   = jidPart.split(':')[0]?.replace(/[^0-9]/g, '') ?? ''  // "22990956919"

    if (!phone) return null

    const sql    = `SELECT * FROM wa_tenants WHERE phone = $1 AND status IN ('connected','pending_qr')${excludeId ? ' AND id != $2' : ''} LIMIT 1`
    const params = excludeId ? [phone, excludeId] : [phone]
    const rows   = await query<TenantRow>(sql, params)
    return rows[0] ? rowToTenant(rows[0]) : null
}

export async function updateTenantPhone(id: string, phone: string): Promise<void> {
    await query(`UPDATE wa_tenants SET phone = $1, updated_at = NOW() WHERE id = $2`, [phone, id])
}

export async function deleteTenant(id: string): Promise<void> {
    await query('DELETE FROM wa_session_keys WHERE session_id = $1', [id])
    await query('DELETE FROM wa_sessions WHERE id = $1', [id])
    await query('DELETE FROM wa_tenants WHERE id = $1', [id])
    logger.info({ component: 'TenantStore', tenantId: id }, 'Tenant supprimé')
}

export async function listTenants(): Promise<Tenant[]> {
    const rows = await query<TenantRow>('SELECT * FROM wa_tenants ORDER BY created_at DESC')
    return rows.map(rowToTenant)
}
