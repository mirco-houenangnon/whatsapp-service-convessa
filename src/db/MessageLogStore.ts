/**
 * MessageLogStore.ts — Journal des messages envoyés par les tenants via /api/v1/send.
 *
 * Contrairement à wa_message_queue (file d'attente du numéro ADMIN), cette
 * table trace CHAQUE message tenant, quel que soit son statut final. C'est
 * ce qui permet de répondre immédiatement au client (202 + messageId) puis
 * de mettre à jour le statut réel de façon asynchrone (Socket.io + webhook),
 * sans jamais perdre la trace d'un envoi — y compris ceux qui dépassent le
 * délai habituel (gros médias) mais aboutissent malgré tout.
 */

import { v4 as uuidv4 } from 'uuid'
import { getPool }      from './connection.js'
import { logger }       from '../services/logger.js'
import type mysql from 'mysql2/promise'
import type { MediaType } from './MessageQueue.js'

export type LoggedMessageStatus = 'queued' | 'sent' | 'delivered' | 'failed'
export type RecipientType       = 'contact' | 'group'

export interface LoggedMessage {
    id:           string
    tenantId:     string
    toJid:        string
    toType:       RecipientType
    message:      string | null
    hasMedia:     boolean
    mediaType:    MediaType | null
    status:       LoggedMessageStatus
    errorCode:    string | null
    errorMessage: string | null
    waMessageId:  string | null
    createdAt:    Date
    sentAt:       Date | null
}

interface MessageLogRow {
    id:            string
    tenant_id:     string
    to_jid:        string
    to_type:       RecipientType
    message:       string | null
    has_media:     number
    media_type:    MediaType | null
    status:        LoggedMessageStatus
    error_code:    string | null
    error_message: string | null
    wa_message_id: string | null
    created_at:    Date
    sent_at:       Date | null
}

function rowToMessage(row: MessageLogRow): LoggedMessage {
    return {
        id:           row.id,
        tenantId:     row.tenant_id,
        toJid:        row.to_jid,
        toType:       row.to_type,
        message:      row.message,
        hasMedia:     !!row.has_media,
        mediaType:    row.media_type,
        status:       row.status,
        errorCode:    row.error_code,
        errorMessage: row.error_message,
        waMessageId:  row.wa_message_id,
        createdAt:    row.created_at,
        sentAt:       row.sent_at,
    }
}

/**
 * Crée l'entrée initiale (status='queued') — appelé AVANT de tenter l'envoi
 * réel, pour garantir qu'un messageId existe toujours, même si l'envoi échoue.
 */
export async function createLoggedMessage(data: {
    tenantId:  string
    toJid:     string
    toType:    RecipientType
    message?:  string | null
    hasMedia:  boolean
    mediaType?: MediaType | null
}): Promise<string> {
    const pool = getPool()
    const id   = uuidv4()

    await pool.execute(
        `INSERT INTO wa_messages (id, tenant_id, to_jid, to_type, message, has_media, media_type, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
        [id, data.tenantId, data.toJid, data.toType, data.message ?? null, data.hasMedia ? 1 : 0, data.mediaType ?? null]
    )

    return id
}

/**
 * Marque un message comme réellement envoyé (Baileys a résolu la promesse).
 */
export async function markMessageSent(id: string, waMessageId: string | null): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE wa_messages SET status = 'sent', wa_message_id = ?, sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [waMessageId, id]
    )
}

/**
 * Marque un message comme définitivement en échec.
 */
export async function markMessageFailed(id: string, errorCode: string, errorMessage: string): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE wa_messages SET status = 'failed', error_code = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [errorCode, errorMessage, id]
    )
    logger.warn({ component: 'MessageLogStore', messageId: id, errorCode }, 'Message tenant marqué en échec')
}

/**
 * Récupère un message par son ID — utilisé par GET /api/v1/messages/:id
 * (polling de statut côté développeur, en complément de Socket.io/webhook).
 */
export async function getLoggedMessageById(id: string): Promise<LoggedMessage | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<MessageLogRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM wa_messages WHERE id = ?',
        [id]
    )
    const row = rows[0]
    return row ? rowToMessage(row) : null
}

/**
 * Historique des messages d'un tenant (le plus récent en premier).
 */
export async function listLoggedMessagesForTenant(tenantId: string, limit = 50): Promise<LoggedMessage[]> {
    const pool     = getPool()
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 50))
    const [rows] = await pool.execute<MessageLogRow[] & mysql.RowDataPacket[]>(
        `SELECT * FROM wa_messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
        [tenantId]
    )
    return (rows as MessageLogRow[]).map(rowToMessage)
}
