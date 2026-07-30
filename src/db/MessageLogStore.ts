/**
 * MessageLogStore.ts — Journal des messages tenant — MySQL.
 */

import { v4 as uuidv4 }   from 'uuid'
import { query, execute }  from './connection.js'
import { logger }          from '../services/logger.js'
import type { MediaType }  from './MessageQueue.js'

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
    message: string | null; has_media: number; media_type: MediaType | null
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
    await execute(
        `INSERT INTO wa_messages (id, tenant_id, to_jid, to_type, message, has_media, media_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
        [id, data.tenantId, data.toJid, data.toType, data.message ?? null, data.hasMedia ? 1 : 0, data.mediaType ?? null]
    )
    return id
}

export async function markMessageSent(id: string, waMessageId: string | null): Promise<void> {
    await execute(
        `UPDATE wa_messages SET status='sent', wa_message_id=?, sent_at=NOW(), updated_at=NOW() WHERE id=?`,
        [waMessageId, id]
    )
}

export async function markMessageFailed(id: string, errorCode: string, errorMessage: string): Promise<void> {
    await execute(
        `UPDATE wa_messages SET status='failed', error_code=?, error_message=?, updated_at=NOW() WHERE id=?`,
        [errorCode, errorMessage, id]
    )
    logger.warn({ component: 'MessageLogStore', messageId: id, errorCode }, 'Message marqué en échec')
}

export async function getLoggedMessageById(id: string): Promise<LoggedMessage | null> {
    const rows = await query<MessageLogRow>('SELECT * FROM wa_messages WHERE id = ?', [id])
    return rows[0] ? rowToMessage(rows[0]) : null
}

export async function listLoggedMessagesForTenant(tenantId: string, limit = 50): Promise<LoggedMessage[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 50))
    const rows = await query<MessageLogRow>(
        `SELECT * FROM wa_messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ${safeLimit}`,
        [tenantId]
    )
    return rows.map(rowToMessage)
}
