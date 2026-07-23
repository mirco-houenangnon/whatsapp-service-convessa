/**
 * UserStore.ts — Accès aux données utilisateurs (table `auth_users`).
 *
 * Fonctions :
 *   upsertUser    — Créer ou mettre à jour un utilisateur après auth Firebase
 *   getUserByUid  — Récupérer un utilisateur par son Firebase UID
 *   listUsers     — Lister les utilisateurs avec pagination et filtre provider
 *   deactivateUser — Désactiver un compte
 */

import { getPool } from './connection.js'

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

interface UpsertInput {
    uid:         string
    email:       string | null
    displayName: string | null
    photoUrl:    string | null
    provider:    string
    phone?:      string | null
}

// ── Upsert ─────────────────────────────────────────────────────────────────────

export async function upsertUser(input: UpsertInput): Promise<UserRow> {
    const pool = getPool()

    await pool.execute(
        `INSERT INTO auth_users (uid, email, display_name, photo_url, provider, phone, active, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, NOW())
         ON DUPLICATE KEY UPDATE
             email         = VALUES(email),
             display_name  = VALUES(display_name),
             photo_url     = VALUES(photo_url),
             phone         = COALESCE(VALUES(phone), phone),
             last_login_at = NOW()`,
        [input.uid, input.email, input.displayName, input.photoUrl, input.provider, input.phone ?? null]
    )

    const user = await getUserByUid(input.uid)
    if (!user) throw new Error(`upsertUser: impossible de relire l'utilisateur ${input.uid}`)
    return user
}

// ── Get by UID ─────────────────────────────────────────────────────────────────

export async function getUserByUid(uid: string): Promise<UserRow | null> {
    const pool = getPool()

    const [rows] = await pool.execute(
        `SELECT uid, email, display_name, photo_url, provider, phone, active, created_at, last_login_at
         FROM auth_users
         WHERE uid = ?
         LIMIT 1`,
        [uid]
    )

    const list = rows as UserRow[]
    return list[0] ?? null
}

// ── Get by phone ───────────────────────────────────────────────────────────────

export async function getUserByPhone(phone: string): Promise<UserRow | null> {
    const pool = getPool()

    const [rows] = await pool.execute(
        `SELECT uid, email, display_name, photo_url, provider, phone, active, created_at, last_login_at
         FROM auth_users
         WHERE phone = ?
         LIMIT 1`,
        [phone]
    )

    const list = rows as UserRow[]
    return list[0] ?? null
}

// ── List (admin) ───────────────────────────────────────────────────────────────

interface ListOptions {
    page:      number
    limit:     number
    provider?: string
}

export async function listUsers(
    opts: ListOptions
): Promise<{ users: UserRow[]; total: number }> {
    const pool   = getPool()
    const offset = (opts.page - 1) * opts.limit

    const conditions: string[] = []
    const params: unknown[]    = []

    if (opts.provider) {
        conditions.push('provider = ?')
        params.push(opts.provider)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const [[countResult]] = await pool.execute(
        `SELECT COUNT(*) AS total FROM auth_users ${where}`,
        params
    ) as unknown as [[{ total: number }]]

    const [rows] = await pool.execute(
        `SELECT uid, email, display_name, photo_url, provider, phone, active, created_at, last_login_at
         FROM auth_users ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, opts.limit, offset]
    )

    return {
        users: rows as UserRow[],
        total: countResult.total,
    }
}

// ── Deactivate ─────────────────────────────────────────────────────────────────

export async function deactivateUser(uid: string): Promise<void> {
    const pool = getPool()

    await pool.execute(
        `UPDATE auth_users SET active = FALSE WHERE uid = ?`,
        [uid]
    )
}
