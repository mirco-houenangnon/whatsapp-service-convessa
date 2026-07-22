/**
 * MessageQueue.ts — CRUD de la file d'attente des messages.
 * Toutes les opérations sont atomiques via des requêtes SQL préparées.
 */

import { v4 as uuidv4 } from 'uuid'
import { getPool }      from './connection.js'
import { logger }       from '../services/logger.js'
import { maskPhone }    from '../services/logger.js'
import type mysql from 'mysql2/promise'

export type MessageStatus = 'queued' | 'sending' | 'sent' | 'failed'

export interface QueuedMessage {
    id:        string
    recipient: string
    jid:       string | null
    message:   string
    status:    MessageStatus
    attempts:  number
    lastError: string | null
    queuedAt:  Date
    sentAt:    Date | null
}

interface MessageRow {
    id:         string
    recipient:  string
    jid:        string | null
    message:    string
    status:     MessageStatus
    attempts:   number
    last_error: string | null
    queued_at:  Date
    sent_at:    Date | null
}

function rowToMessage(row: MessageRow): QueuedMessage {
    return {
        id:        row.id,
        recipient: row.recipient,
        jid:       row.jid,
        message:   row.message,
        status:    row.status,
        attempts:  row.attempts,
        lastError: row.last_error,
        queuedAt:  row.queued_at,
        sentAt:    row.sent_at,
    }
}

/**
 * Ajoute un message à la file d'attente.
 * Retourne l'UUID et la position dans la file.
 */
export async function enqueue(
    recipient: string,
    message: string
): Promise<{ id: string; position: number }> {
    const pool = getPool()
    const id   = uuidv4()

    await pool.execute(
        `INSERT INTO wa_message_queue (id, recipient, message, status)
         VALUES (?, ?, ?, 'queued')`,
        [id, recipient, message]
    )

    const position = await getPosition(id)

    logger.info(
        { component: 'MessageQueue', messageId: id, recipient: maskPhone(recipient), position },
        'Message ajouté à la file'
    )

    return { id, position }
}

/**
 * Récupère le prochain message à traiter (FIFO — le plus ancien 'queued').
 * Retourne null si la file est vide.
 */
export async function dequeueNext(): Promise<QueuedMessage | null> {
    const pool  = getPool()
    const [rows] = await pool.execute<MessageRow[] & mysql.RowDataPacket[]>(
        `SELECT * FROM wa_message_queue
         WHERE status = 'queued'
         ORDER BY queued_at ASC
         LIMIT 1`
    )

    const row = rows[0]
    return row ? rowToMessage(row) : null
}

/**
 * Met à jour le statut d'un message.
 */
export async function updateStatus(
    id: string,
    status: MessageStatus,
    extra?: { jid?: string; lastError?: string; sentAt?: Date }
): Promise<void> {
    const pool = getPool()

    await pool.execute(
        `UPDATE wa_message_queue
         SET status     = ?,
             jid        = COALESCE(?, jid),
             last_error = COALESCE(?, last_error),
             sent_at    = COALESCE(?, sent_at),
             attempts   = CASE WHEN ? IN ('sending','failed') THEN attempts + 1 ELSE attempts END
         WHERE id = ?`,
        [
            status,
            extra?.jid        ?? null,
            extra?.lastError  ?? null,
            extra?.sentAt     ?? null,
            status,
            id,
        ]
    )
}

/**
 * Remet un message en file avec un délai (pour les retries).
 */
export async function requeueWithDelay(id: string, delayMs: number): Promise<void> {
    const pool     = getPool()
    const newTime  = new Date(Date.now() + delayMs)

    await pool.execute(
        `UPDATE wa_message_queue
         SET status    = 'queued',
             queued_at = ?
         WHERE id = ?`,
        [newTime, id]
    )

    logger.info({ component: 'MessageQueue', messageId: id, delayMs }, 'Message remis en file')
}

/**
 * Récupère un message par son ID.
 */
export async function getById(id: string): Promise<QueuedMessage | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<MessageRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM wa_message_queue WHERE id = ?',
        [id]
    )
    const row = rows[0]
    return row ? rowToMessage(row) : null
}

/**
 * Retourne la position d'un message dans la file (1-indexé).
 * Position 0 = message non trouvé ou déjà traité.
 */
export async function getPosition(id: string): Promise<number> {
    const pool   = getPool()
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS pos
         FROM wa_message_queue
         WHERE status = 'queued'
           AND queued_at <= (
               SELECT queued_at FROM wa_message_queue WHERE id = ?
           )`,
        [id]
    )
    const row = rows[0] as { pos: number } | undefined
    return row?.pos ?? 0
}

/**
 * Compte les messages en attente et en échec.
 */
export async function getQueueStats(): Promise<{ pending: number; failed: number }> {
    const pool   = getPool()
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT
            SUM(status IN ('queued','sending')) AS pending,
            SUM(status = 'failed')              AS failed
         FROM wa_message_queue`
    )
    const row = rows[0] as { pending: number; failed: number } | undefined
    return {
        pending: Number(row?.pending ?? 0),
        failed:  Number(row?.failed  ?? 0),
    }
}
