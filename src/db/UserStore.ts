/**
 * UserStore.ts — Utilisateurs Firebase — MySQL.
 */

import { query, execute } from './connection.js'
import { logger }         from '../services/logger.js'

export interface UserRow {
    uid:           string
    email:         string | null
    display_name:  string | null
    photo_url:     string | null
    provider:      string
    phone:         string | null
    active:        boolean
    created_at:    Date
    last_login_at: Date
}

interface CreateUserInput { uid: string; email: string | null; displayName: string | null; photoUrl: string | null; provider: string; phone?: string | null }

export async function createUser(input: CreateUserInput): Promise<{ status: 'created' | 'exists'; user: UserRow }> {
    const byUid = await getUserByUid(input.uid)
    if (byUid) { await touchLastLogin(input.uid); return { status: 'exists', user: byUid } }
    if (input.email) { const byEmail = await getUserByEmail(input.email); if (byEmail) return { status: 'exists', user: byEmail } }
    if (input.phone) { const byPhone = await getUserByPhone(input.phone); if (byPhone) return { status: 'exists', user: byPhone } }

    await execute(
        `INSERT INTO auth_users (uid, email, display_name, photo_url, provider, phone, active, last_login_at) VALUES (?, ?, ?, ?, ?, ?, 1, NOW())`,
        [input.uid, input.email, input.displayName, input.photoUrl, input.provider, input.phone ?? null]
    )
    const user = await getUserByUid(input.uid)
    if (!user) throw new Error(`createUser: impossible de relire ${input.uid}`)
    logger.info({ component: 'UserStore', uid: input.uid, provider: input.provider }, 'Nouveau compte créé')
    return { status: 'created', user }
}

export async function loginUser(uid: string): Promise<UserRow | null> {
    const user = await getUserByUid(uid)
    if (!user) return null
    await touchLastLogin(uid)
    return getUserByUid(uid)
}

export async function touchLastLogin(uid: string): Promise<void> {
    await execute(`UPDATE auth_users SET last_login_at = NOW() WHERE uid = ?`, [uid])
}

export async function upsertUser(input: CreateUserInput): Promise<UserRow> {
    const byUid = await getUserByUid(input.uid)
    if (byUid) {
        await execute(
            `UPDATE auth_users SET email=COALESCE(?,email), display_name=COALESCE(?,display_name), photo_url=COALESCE(?,photo_url), last_login_at=NOW() WHERE uid=?`,
            [input.email, input.displayName, input.photoUrl, input.uid]
        )
        return (await getUserByUid(input.uid))!
    }
    if (input.email) {
        const byEmail = await getUserByEmail(input.email)
        if (byEmail) {
            await execute(`UPDATE auth_users SET photo_url=COALESCE(?,photo_url), display_name=COALESCE(?,display_name), last_login_at=NOW() WHERE uid=?`, [input.photoUrl, input.displayName, byEmail.uid])
            return (await getUserByUid(byEmail.uid))!
        }
    }
    await execute(
        `INSERT INTO auth_users (uid, email, display_name, photo_url, provider, phone, active, last_login_at) VALUES (?, ?, ?, ?, ?, ?, 1, NOW())`,
        [input.uid, input.email, input.displayName, input.photoUrl, input.provider, input.phone ?? null]
    )
    const user = await getUserByUid(input.uid)
    if (!user) throw new Error(`upsertUser: impossible de relire ${input.uid}`)
    logger.info({ component: 'UserStore', uid: input.uid, provider: input.provider }, 'Compte OAuth créé')
    return user
}

const SELECT_FIELDS = `SELECT uid, email, display_name, photo_url, provider, phone, active, created_at, last_login_at FROM auth_users`

export async function getUserByUid(uid: string): Promise<UserRow | null> {
    const rows = await query<UserRow>(`${SELECT_FIELDS} WHERE uid = ? LIMIT 1`, [uid])
    const row  = rows[0]
    return row ? { ...row, active: Boolean(row.active) } : null
}

export async function getUserByPhone(phone: string): Promise<UserRow | null> {
    const rows = await query<UserRow>(`${SELECT_FIELDS} WHERE phone = ? LIMIT 1`, [phone])
    const row  = rows[0]
    return row ? { ...row, active: Boolean(row.active) } : null
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
    const rows = await query<UserRow>(`${SELECT_FIELDS} WHERE email = ? LIMIT 1`, [email])
    const row  = rows[0]
    return row ? { ...row, active: Boolean(row.active) } : null
}

interface ListOptions { page: number; limit: number; provider?: string }

export async function listUsers(opts: ListOptions): Promise<{ users: UserRow[]; total: number }> {
    const offset     = (opts.page - 1) * opts.limit
    const conditions: string[] = []
    const params: unknown[]    = []
    if (opts.provider) { conditions.push('provider = ?'); params.push(opts.provider) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countRows = await query<{ total: number }>(`SELECT COUNT(*) AS total FROM auth_users ${where}`, params)
    const total = Number(countRows[0]?.total ?? 0)

    const rows = await query<UserRow>(`${SELECT_FIELDS} ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, opts.limit, offset])
    return { users: rows.map(r => ({ ...r, active: Boolean(r.active) })), total }
}

export async function deactivateUser(uid: string): Promise<void> {
    await execute(`UPDATE auth_users SET active = 0 WHERE uid = ?`, [uid])
}
