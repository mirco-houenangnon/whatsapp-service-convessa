/**
 * UserStore.ts — Accès aux données utilisateurs (table `auth_users`).
 *
 * Logique métier claire :
 *   createUser     — Inscription stricte : échoue si l'identité existe déjà (quel que soit le provider)
 *   loginUser      — Connexion : met à jour last_login_at, retourne le profil existant
 *   upsertUser     — Utilisé uniquement par le flux OAuth Firebase (Google/GitHub)
 *                    → créé si absent, met à jour si présent
 *   getUserByUid   — Récupération par Firebase UID
 *   getUserByPhone — Récupération par numéro de téléphone
 *   getUserByEmail — Récupération par email (cross-provider)
 *   listUsers      — Listing paginé (admin)
 *   deactivateUser — Désactivation d'un compte
 */

import { getPool } from './connection.js'
import { logger }  from '../services/logger.js'

export interface UserRow {
    uid:              string
    email:            string | null
    display_name:     string | null
    photo_url:        string | null
    provider:         string
    phone:            string | null
    active:           boolean
    created_at:       Date
    last_login_at:    Date
}

interface CreateUserInput {
    uid:         string
    email:       string | null
    displayName: string | null
    photoUrl:    string | null
    provider:    string
    phone?:      string | null
}

interface UpsertInput extends CreateUserInput {}

// ── Inscription stricte ────────────────────────────────────────────────────────

/**
 * Crée un nouveau compte.
 *
 * Règle : un seul compte par identité unique, quel que soit le provider.
 * L'unicité est vérifiée sur :
 *   - l'email (cross-provider : si Google/GitHub a le même email → même compte)
 *   - le numéro de téléphone
 *   - l'uid Firebase
 *
 * Retourne :
 *   { status: 'created', user } — nouveau compte créé
 *   { status: 'exists',  user } — compte existant retrouvé (même identité)
 */
export async function createUser(input: CreateUserInput): Promise<{
    status: 'created' | 'exists'
    user:   UserRow
}> {
    // 1. Vérifier par UID Firebase (le plus fort — déjà géré par Firebase)
    const byUid = await getUserByUid(input.uid)
    if (byUid) {
        await touchLastLogin(input.uid)
        return { status: 'exists', user: byUid }
    }

    // 2. Vérifier par email (cross-provider)
    if (input.email) {
        const byEmail = await getUserByEmail(input.email)
        if (byEmail) {
            logger.warn(
                { component: 'UserStore', email: input.email, existingUid: byEmail.uid, newUid: input.uid },
                'Tentative d\'inscription avec un email déjà associé à un autre compte'
            )
            return { status: 'exists', user: byEmail }
        }
    }

    // 3. Vérifier par téléphone
    if (input.phone) {
        const byPhone = await getUserByPhone(input.phone)
        if (byPhone) {
            logger.warn(
                { component: 'UserStore', phone: input.phone, existingUid: byPhone.uid, newUid: input.uid },
                'Tentative d\'inscription avec un téléphone déjà associé à un autre compte'
            )
            return { status: 'exists', user: byPhone }
        }
    }

    // 4. Créer le compte
    const pool = getPool()
    await pool.execute(
        `INSERT INTO auth_users
            (uid, email, display_name, photo_url, provider, phone, active, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, NOW())`,
        [
            input.uid,
            input.email,
            input.displayName,
            input.photoUrl,
            input.provider,
            input.phone ?? null,
        ]
    )

    const user = await getUserByUid(input.uid)
    if (!user) throw new Error(`createUser: impossible de relire l'utilisateur ${input.uid}`)

    logger.info(
        { component: 'UserStore', uid: input.uid, provider: input.provider },
        'Nouveau compte créé'
    )

    return { status: 'created', user }
}

// ── Connexion ──────────────────────────────────────────────────────────────────

/**
 * Connexion d'un utilisateur existant.
 * Met à jour `last_login_at` et retourne le profil.
 *
 * Retourne null si aucun compte ne correspond.
 */
export async function loginUser(uid: string): Promise<UserRow | null> {
    const user = await getUserByUid(uid)
    if (!user) return null

    await touchLastLogin(uid)

    // Relire après update pour avoir last_login_at à jour
    return getUserByUid(uid)
}

/**
 * Met à jour la date de dernière connexion.
 */
export async function touchLastLogin(uid: string): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE auth_users SET last_login_at = NOW() WHERE uid = ?`,
        [uid]
    )
}

// ── Upsert OAuth (Google / GitHub) ─────────────────────────────────────────────

/**
 * Upsert utilisé pour le flux OAuth Firebase.
 *
 * Logique :
 *   - Si l'UID existe → connexion (mise à jour)
 *   - Si email existe sous un autre UID → lie le provider OAuth au compte existant
 *     (un utilisateur peut se connecter via Google ET GitHub s'il a le même email)
 *   - Sinon → création
 */
export async function upsertUser(input: UpsertInput): Promise<UserRow> {
    const pool = getPool()

    // Chercher par UID d'abord
    const byUid = await getUserByUid(input.uid)
    if (byUid) {
        // Mise à jour des infos OAuth (photo, displayName peuvent changer)
        await pool.execute(
            `UPDATE auth_users
             SET email         = COALESCE(?, email),
                 display_name  = COALESCE(?, display_name),
                 photo_url     = COALESCE(?, photo_url),
                 last_login_at = NOW()
             WHERE uid = ?`,
            [input.email, input.displayName, input.photoUrl, input.uid]
        )
        return (await getUserByUid(input.uid))!
    }

    // Chercher par email — lier le provider OAuth au compte existant
    if (input.email) {
        const byEmail = await getUserByEmail(input.email)
        if (byEmail) {
            // Mettre à jour last_login_at et infos
            await pool.execute(
                `UPDATE auth_users
                 SET photo_url     = COALESCE(?, photo_url),
                     display_name  = COALESCE(?, display_name),
                     last_login_at = NOW()
                 WHERE uid = ?`,
                [input.photoUrl, input.displayName, byEmail.uid]
            )
            logger.info(
                { component: 'UserStore', email: input.email, uid: byEmail.uid, provider: input.provider },
                'Provider OAuth lié à un compte existant via email'
            )
            return (await getUserByUid(byEmail.uid))!
        }
    }

    // Créer
    await pool.execute(
        `INSERT INTO auth_users
            (uid, email, display_name, photo_url, provider, phone, active, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, TRUE, NOW())`,
        [input.uid, input.email, input.displayName, input.photoUrl, input.provider, input.phone ?? null]
    )

    const user = await getUserByUid(input.uid)
    if (!user) throw new Error(`upsertUser: impossible de relire l'utilisateur ${input.uid}`)

    logger.info(
        { component: 'UserStore', uid: input.uid, provider: input.provider },
        'Compte OAuth créé'
    )

    return user
}

// ── Getters ────────────────────────────────────────────────────────────────────

export async function getUserByUid(uid: string): Promise<UserRow | null> {
    const pool = getPool()
    const [rows] = await pool.execute(
        `SELECT uid, email, display_name, photo_url, provider, phone, active, created_at, last_login_at
         FROM auth_users WHERE uid = ? LIMIT 1`,
        [uid]
    )
    return (rows as UserRow[])[0] ?? null
}

export async function getUserByPhone(phone: string): Promise<UserRow | null> {
    const pool = getPool()
    const [rows] = await pool.execute(
        `SELECT uid, email, display_name, photo_url, provider, phone, active, created_at, last_login_at
         FROM auth_users WHERE phone = ? LIMIT 1`,
        [phone]
    )
    return (rows as UserRow[])[0] ?? null
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
    const pool = getPool()
    const [rows] = await pool.execute(
        `SELECT uid, email, display_name, photo_url, provider, phone, active, created_at, last_login_at
         FROM auth_users WHERE email = ? LIMIT 1`,
        [email]
    )
    return (rows as UserRow[])[0] ?? null
}

// ── Admin ──────────────────────────────────────────────────────────────────────

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

    return { users: rows as UserRow[], total: countResult.total }
}

export async function deactivateUser(uid: string): Promise<void> {
    const pool = getPool()
    await pool.execute(`UPDATE auth_users SET active = FALSE WHERE uid = ?`, [uid])
}
