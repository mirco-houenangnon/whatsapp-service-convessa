/**
 * ContactStore.ts — Messages de contact (formulaire du site) et fil de
 * réponses admin associé — MySQL.
 *
 * Un "ContactMessage" est la demande initiale envoyée par un visiteur.
 * Chaque "ContactReply" est une réponse envoyée par un administrateur,
 * depuis le numéro WhatsApp admin, vers le numéro renseigné par le
 * demandeur dans le formulaire.
 */

import { v4 as uuidv4 }   from 'uuid'
import { query, execute } from './connection.js'

export type ContactStatus = 'unread' | 'read' | 'replied'
export type ReplyStatus   = 'sent' | 'failed'

export interface ContactMessage {
    id:                   string
    name:                 string
    email:                string
    phone:                string | null
    subject:              string
    message:              string
    status:               ContactStatus
    userNotifiedAt:       Date | null
    adminGroupNotifiedAt: Date | null
    readAt:               Date | null
    createdAt:            Date
    updatedAt:            Date
}

export interface ContactReply {
    id:                string
    contactMessageId:  string
    adminId:           number | null
    adminName:         string | null
    body:              string | null
    mediaType:         string | null
    mediaMime:         string | null
    mediaName:         string | null
    waMessageId:       string | null
    status:            ReplyStatus
    errorMessage:      string | null
    createdAt:         Date
}

interface ContactMessageRow {
    id: string; name: string; email: string; phone: string | null
    subject: string; message: string; status: ContactStatus
    user_notified_at: Date | null; admin_group_notified_at: Date | null
    read_at: Date | null; created_at: Date; updated_at: Date
}

interface ContactReplyRow {
    id: string; contact_message_id: string; admin_id: number | null; admin_name: string | null
    body: string | null; media_type: string | null; media_mime: string | null; media_name: string | null
    wa_message_id: string | null; status: ReplyStatus; error_message: string | null; created_at: Date
}

function rowToMessage(row: ContactMessageRow): ContactMessage {
    return {
        id:                   row.id,
        name:                 row.name,
        email:                row.email,
        phone:                row.phone,
        subject:              row.subject,
        message:              row.message,
        status:               row.status,
        userNotifiedAt:       row.user_notified_at,
        adminGroupNotifiedAt: row.admin_group_notified_at,
        readAt:               row.read_at,
        createdAt:            row.created_at,
        updatedAt:            row.updated_at,
    }
}

function rowToReply(row: ContactReplyRow): ContactReply {
    return {
        id:               row.id,
        contactMessageId: row.contact_message_id,
        adminId:          row.admin_id,
        adminName:        row.admin_name,
        body:             row.body,
        mediaType:        row.media_type,
        mediaMime:        row.media_mime,
        mediaName:        row.media_name,
        waMessageId:      row.wa_message_id,
        status:           row.status,
        errorMessage:     row.error_message,
        createdAt:        row.created_at,
    }
}

// ── Messages ────────────────────────────────────────────────────────────────

export async function createContactMessage(data: {
    name: string; email: string; phone: string | null; subject: string; message: string
}): Promise<ContactMessage> {
    const id = uuidv4()
    await execute(
        `INSERT INTO contact_messages (id, name, email, phone, subject, message, status)
         VALUES (?, ?, ?, ?, ?, ?, 'unread')`,
        [id, data.name, data.email, data.phone, data.subject, data.message]
    )
    const created = await getContactMessageById(id)
    if (!created) throw new Error('Message de contact introuvable après création')
    return created
}

export async function getContactMessageById(id: string): Promise<ContactMessage | null> {
    const rows = await query<ContactMessageRow>('SELECT * FROM contact_messages WHERE id = ?', [id])
    return rows[0] ? rowToMessage(rows[0]) : null
}

export async function listContactMessages(opts: {
    page: number; limit: number; status?: ContactStatus | 'all'; search?: string
}): Promise<{ messages: ContactMessage[]; total: number }> {
    const offset = (opts.page - 1) * opts.limit
    const where: string[]  = []
    const params: unknown[] = []

    if (opts.status && opts.status !== 'all') {
        where.push('status = ?')
        params.push(opts.status)
    }
    if (opts.search?.trim()) {
        const term = `%${opts.search.trim()}%`
        where.push('(name LIKE ? OR email LIKE ? OR phone LIKE ? OR subject LIKE ? OR message LIKE ?)')
        params.push(term, term, term, term, term)
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const rows = await query<ContactMessageRow>(
        `SELECT * FROM contact_messages ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, Number(opts.limit), Number(offset)]
    )
    const countRows = await query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM contact_messages ${whereSql}`,
        params
    )

    return { messages: rows.map(rowToMessage), total: Number(countRows[0]?.total ?? 0) }
}

export async function countContactMessagesByStatus(status: ContactStatus): Promise<number> {
    const rows = await query<{ total: number }>(
        'SELECT COUNT(*) AS total FROM contact_messages WHERE status = ?',
        [status]
    )
    return Number(rows[0]?.total ?? 0)
}

export async function markContactMessageRead(id: string): Promise<void> {
    await execute(
        `UPDATE contact_messages SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
             read_at = COALESCE(read_at, NOW())
         WHERE id = ?`,
        [id]
    )
}

export async function markContactMessageReplied(id: string): Promise<void> {
    await execute(`UPDATE contact_messages SET status = 'replied' WHERE id = ?`, [id])
}

export async function markContactMessageUserNotified(id: string): Promise<void> {
    await execute(`UPDATE contact_messages SET user_notified_at = NOW() WHERE id = ?`, [id])
}

export async function markContactMessageGroupNotified(id: string): Promise<void> {
    await execute(`UPDATE contact_messages SET admin_group_notified_at = NOW() WHERE id = ?`, [id])
}

// ── Réponses (fil de discussion) ───────────────────────────────────────────

export async function createContactReply(data: {
    contactMessageId: string
    adminId:          number | null
    adminName:        string | null
    body:             string | null
    mediaType?:       string | null
    mediaMime?:       string | null
    mediaName?:       string | null
}): Promise<ContactReply> {
    const id = uuidv4()
    await execute(
        `INSERT INTO contact_message_replies
            (id, contact_message_id, admin_id, admin_name, body, media_type, media_mime, media_name, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent')`,
        [
            id, data.contactMessageId, data.adminId, data.adminName, data.body,
            data.mediaType ?? null, data.mediaMime ?? null, data.mediaName ?? null,
        ]
    )
    const created = await getContactReplyById(id)
    if (!created) throw new Error('Réponse introuvable après création')
    return created
}

export async function getContactReplyById(id: string): Promise<ContactReply | null> {
    const rows = await query<ContactReplyRow>('SELECT * FROM contact_message_replies WHERE id = ?', [id])
    return rows[0] ? rowToReply(rows[0]) : null
}

export async function listContactReplies(contactMessageId: string): Promise<ContactReply[]> {
    const rows = await query<ContactReplyRow>(
        `SELECT * FROM contact_message_replies WHERE contact_message_id = ? ORDER BY created_at ASC`,
        [contactMessageId]
    )
    return rows.map(rowToReply)
}

export async function markContactReplyStatus(
    id: string,
    status: ReplyStatus,
    opts?: { waMessageId?: string | null; errorMessage?: string | null }
): Promise<void> {
    await execute(
        `UPDATE contact_message_replies SET status = ?, wa_message_id = ?, error_message = ? WHERE id = ?`,
        [status, opts?.waMessageId ?? null, opts?.errorMessage ?? null, id]
    )
}
