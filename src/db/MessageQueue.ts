/**
 * MessageQueue.ts — File d'attente des messages — MySQL.
 */

import { v4 as uuidv4 }       from 'uuid'
import { query, execute }      from './connection.js'
import { logger, maskPhone }   from '../services/logger.js'

export type MessageStatus = 'queued' | 'sending' | 'sent' | 'failed'
export type MediaType     = 'image' | 'video' | 'audio' | 'document'

export interface MediaPayload { type: MediaType; mime: string; name?: string; url?: string; base64?: string }
export interface EnqueuePayload { recipient: string; message?: string; media?: MediaPayload }

export interface QueuedMessage {
    id: string; recipient: string; jid: string | null; message: string | null
    media: MediaPayload | null; status: MessageStatus; attempts: number
    lastError: string | null; queuedAt: Date; sentAt: Date | null
}

interface MessageRow {
    id: string; recipient: string; jid: string | null; message: string | null
    media_type: MediaType | null; media_url: string | null; media_b64: string | null
    media_mime: string | null; media_name: string | null; status: MessageStatus
    attempts: number; last_error: string | null; queued_at: Date; sent_at: Date | null
}

function rowToMessage(row: MessageRow): QueuedMessage {
    const media: MediaPayload | null = row.media_type
        ? { type: row.media_type, mime: row.media_mime ?? 'application/octet-stream', name: row.media_name ?? undefined, url: row.media_url ?? undefined, base64: row.media_b64 ?? undefined }
        : null
    return { id: row.id, recipient: row.recipient, jid: row.jid, message: row.message, media, status: row.status, attempts: row.attempts, lastError: row.last_error, queuedAt: row.queued_at, sentAt: row.sent_at }
}

export async function enqueue(payload: EnqueuePayload): Promise<{ id: string; position: number }> {
    const id = uuidv4()
    await execute(
        `INSERT INTO wa_message_queue (id, recipient, message, media_type, media_url, media_b64, media_mime, media_name, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
        [id, payload.recipient, payload.message ?? null, payload.media?.type ?? null, payload.media?.url ?? null, payload.media?.base64 ?? null, payload.media?.mime ?? null, payload.media?.name ?? null]
    )
    const position = await getPosition(id)
    logger.info({ component: 'MessageQueue', messageId: id, recipient: maskPhone(payload.recipient), position }, 'Message ajouté à la file')
    return { id, position }
}

export async function dequeueNext(): Promise<QueuedMessage | null> {
    const rows = await query<MessageRow>(`SELECT * FROM wa_message_queue WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 1`)
    return rows[0] ? rowToMessage(rows[0]) : null
}

export async function updateStatus(id: string, status: MessageStatus, extra?: { jid?: string; lastError?: string; sentAt?: Date }): Promise<void> {
    await execute(
        `UPDATE wa_message_queue SET status=?, jid=COALESCE(?,jid), last_error=COALESCE(?,last_error), sent_at=COALESCE(?,sent_at),
             attempts=CASE WHEN ? IN ('sending','failed') THEN attempts+1 ELSE attempts END
         WHERE id=?`,
        [status, extra?.jid ?? null, extra?.lastError ?? null, extra?.sentAt ?? null, status, id]
    )
}

export async function requeueWithDelay(id: string, delayMs: number): Promise<void> {
    const newTime = new Date(Date.now() + delayMs)
    await execute(`UPDATE wa_message_queue SET status='queued', queued_at=? WHERE id=?`, [newTime, id])
    logger.info({ component: 'MessageQueue', messageId: id, delayMs }, 'Message remis en file')
}

export async function getById(id: string): Promise<QueuedMessage | null> {
    const rows = await query<MessageRow>('SELECT * FROM wa_message_queue WHERE id = ?', [id])
    return rows[0] ? rowToMessage(rows[0]) : null
}

export async function getPosition(id: string): Promise<number> {
    const rows = await query<{ pos: number }>(
        `SELECT COUNT(*) AS pos FROM wa_message_queue WHERE status='queued' AND queued_at <= (SELECT queued_at FROM wa_message_queue WHERE id=?)`, [id]
    )
    return Number(rows[0]?.pos ?? 0)
}

export async function getQueueStats(): Promise<{ pending: number; failed: number }> {
    const rows = await query<{ pending: number; failed: number }>(
        `SELECT SUM(status IN ('queued','sending')) AS pending, SUM(status='failed') AS failed FROM wa_message_queue`
    )
    return { pending: Number(rows[0]?.pending ?? 0), failed: Number(rows[0]?.failed ?? 0) }
}
