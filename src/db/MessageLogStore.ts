/**
 * MessageLogStore.ts — Journal des messages tenant — PostgreSQL.
 */

import { v4 as uuidv4 } from 'uuid'
import { query }        from './connection.js'
import { logger }       from '../services/logger.js'
import type { MediaType } from './MessageQueue.js'

export type LoggedMessageStatus = 'queued' | 'sent' | 'delivered' | 'failed'
export type RecipientType       = 'contact' | 'group'

export interface LoggedMessage {
    id: string; tenantId: string; toJid: string; toType: RecipientType
    message: string | null; hasMedia: boolean; mediaType: MediaType | null
    status: LoggedMessageStatus; errorCode: string | null; errorMessage: string | null
    waMessageId: string | null; createdAt: Date; sentAt: Date | null
}

interface MessageLogRow {
    id: string; tenant_id: string; to_jid: string; to_type: RecipientType
    message: string | null; has_media: boolean; media_type: MediaType | null
    status: LoggedMessageStatus; error_code: string | null; error_message: string | null
    wa_message_id: string | null; created_at: Date; sent_at: Date | null
}

function rowToMessage(row: MessageLogRow): LoggedMessage {
    return {
        id: row.id, tenantId: row.tenant_id, toJid: row.to_jid, toType: row.to_type,
        message: row.message, hasMedia: Boolean(row.has_media), mediaType: row.media_type,
        status: row.status, errorCode: row.error_code, errorMessage: row.error_message,
        waMessageId: row.wa_message_id, createdAt: row.created_at, sentAt: row.sent_at,
    }
}

export async function createLoggedMessage(data: {
    tenantId: string; toJid: string; toType: RecipientType
    message?: string | null; hasMedia: boolean; mediaType?: MediaType | null
}): Promise<string> {
    const id = uuidv4()
    await query(
        `INSERT INTO wa_messages (id, tenant_id, to_jid, to_type, message, has_media, media_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')`,
        [id, data.tenantId, data.toJid, data.toType, data.message ?? null, data.hasMedia, data.mediaType ?? null]
    )
    return id
}

export async function markMessageSent(id: string, waMessageId: string | null): Promise<void> {
    await query(
        `UPDATE wa_messages SET status = 'sent', wa_message_id = $1, sent_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [waMessageId, id]
    )
}

export async function markMessageFailed(id: string, errorCode: string, errorMessage: string): Promise<void> {
    await query(
        `UPDATE wa_messages SET status = 'failed', error_code = $1, error_message = $2, updated_at = NOW() WHERE id = $3`,
        [errorCode, errorMessage, id]
    )
    logger.warn({ component: 'MessageLogStore', messageId: id, errorCode }, 'Message marqué en échec')
}

export async function getLoggedMessageById(id: string): Promise<LoggedMessage | null> {
    const rows = await query<MessageLogRow>('SELECT * FROM wa_messages WHERE id = $1', [id])
    return rows[0] ? rowToMessage(rows[0]) : null
}

export async function listLoggedMessagesForTenant(tenantId: string, limit = 50): Promise<LoggedMessage[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 50))
    const rows = await query<MessageLogRow>(
        `SELECT * FROM wa_messages WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [tenantId, safeLimit]
    )
    return rows.map(rowToMessage)
}
