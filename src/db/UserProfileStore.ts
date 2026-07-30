/**
 * UserProfileStore.ts — Vue « profil » agrégée pour l'admin : rassemble,
 * pour un utilisateur (auth_users.uid) OU un admin (convessa_admins.id),
 * toutes les lignes qui lui appartiennent dans les différentes tables, permet
 * d'éditer un champ précis et de tout supprimer d'un seul geste.
 *
 * Les profils admins utilisent le préfixe "admin:" devant leur id numérique
 * (ex: "admin:1") pour les distinguer des UIDs Firebase dans l'URL.
 *
 * Base de données : MySQL (mysql2) — placeholders `?`, IN (?) avec tableaux.
 */

import { getPool, query } from './connection.js'
import { maskSensitive, getTableMeta } from './schemaMeta.js'
import { updateRow, AdminDbError } from './AdminDbStore.js'

export interface ProfileSummary {
    uid:            string          // uid Firebase OU "admin:<id>"
    email:          string | null
    display_name:   string | null
    phone:          string | null
    provider:       string          // "firebase" / "google" / "phone" / "admin"
    active:         boolean
    created_at:     Date
    tenants_count:  number
    profile_type:   'user' | 'admin'
}

export async function listProfiles(opts: { page: number; limit: number; search?: string }) {
    const offset = (opts.page - 1) * opts.limit
    const params: unknown[] = []
    let userWhere  = ''
    let adminWhere = ''

    if (opts.search) {
        const like = `%${opts.search}%`
        userWhere  = 'WHERE u.uid LIKE ? OR u.email LIKE ? OR u.display_name LIKE ? OR u.phone LIKE ?'
        adminWhere = 'WHERE a.email LIKE ? OR a.display_name LIKE ?'
        // params pour le COUNT UNION et la requête principale
        params.push(like, like, like, like, like, like)
    }

    // Compter tenants + admins (UNION dans le COUNT)
    const countRows = await query<{ total: number }>(
        `SELECT (
            (SELECT COUNT(*) FROM auth_users u ${userWhere}) +
            (SELECT COUNT(*) FROM convessa_admins a ${adminWhere})
         ) AS total`,
        params
    )
    const total = Number(countRows[0]?.total ?? 0)

    // UNION : utilisateurs Firebase + administrateurs Convessa
    // MySQL ne supporte pas ILIKE → on utilise LIKE (insensible à la casse avec utf8mb4_unicode_ci)
    const rows = await query<ProfileSummary>(
        `SELECT uid, email, display_name, phone, provider, active, created_at, tenants_count, profile_type
         FROM (
           SELECT u.uid AS uid,
                  u.email,
                  u.display_name,
                  u.phone,
                  u.provider,
                  u.active,
                  u.created_at,
                  COUNT(t.id) AS tenants_count,
                  'user' AS profile_type
           FROM auth_users u
           LEFT JOIN wa_tenants t ON t.user_uid = u.uid
           ${userWhere}
           GROUP BY u.uid

           UNION ALL

           SELECT CONCAT('admin:', a.id) AS uid,
                  a.email,
                  a.display_name,
                  NULL AS phone,
                  'admin' AS provider,
                  a.active,
                  a.created_at,
                  0 AS tenants_count,
                  'admin' AS profile_type
           FROM convessa_admins a
           ${adminWhere}
         ) combined
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, opts.limit, offset]
    )

    return { total, profiles: rows }
}

export interface ProfileDetail {
    profile_type: 'user' | 'admin'
    account:  Record<string, unknown> | null
    tenants:  Record<string, unknown>[]
    sessions: Record<string, unknown>[]
    groups:   Record<string, unknown>[]
    messages: Record<string, unknown>[]
    payments: Record<string, unknown>[]
    devices:  Record<string, unknown>[]
    securityLogs: Record<string, unknown>[]
    /** Session Baileys de l'admin (id = 'admin') — uniquement pour profile_type='admin' */
    adminSession: Record<string, unknown> | null
}

export async function getProfile(uid: string): Promise<ProfileDetail | null> {
    // ── Profil admin Convessa : uid = "admin:<id>" ────────────────────────────
    if (uid.startsWith('admin:')) {
        const adminId = parseInt(uid.slice(6), 10)
        if (isNaN(adminId)) return null

        const adminRows = await query(
            `SELECT id, email, display_name, active, created_at, updated_at, last_login_at
             FROM convessa_admins WHERE id = ?`,
            [adminId]
        )
        if (!adminRows[0]) return null

        // Session Baileys de l'admin (id fixe = 'admin' dans wa_sessions)
        const sessionsTable = getTableMeta('wa_sessions')!
        const adminSessionRows = await query('SELECT * FROM wa_sessions WHERE id = ?', ['admin'])
        const adminSession = adminSessionRows[0]
            ? maskSensitive(sessionsTable, adminSessionRows[0] as Record<string, unknown>)
            : null

        return {
            profile_type: 'admin',
            account:      adminRows[0] as Record<string, unknown>,
            tenants:      [],
            sessions:     [],
            groups:       [],
            messages:     [],
            payments:     [],
            devices:      [],
            securityLogs: [],
            adminSession,
        }
    }

    // ── Profil utilisateur Firebase ───────────────────────────────────────────
    const accountRows = await query('SELECT * FROM auth_users WHERE uid = ?', [uid])
    if (!accountRows[0]) return null

    const usersTable    = getTableMeta('auth_users')!
    const tenantsTable  = getTableMeta('wa_tenants')!
    const sessionsTable = getTableMeta('wa_sessions')!
    const groupsTable   = getTableMeta('wa_groups')!
    const messagesTable = getTableMeta('wa_messages')!
    const paymentsTable = getTableMeta('subscription_payments')!
    const devicesTable  = getTableMeta('auth_devices')!
    const logsTable     = getTableMeta('auth_device_sessions')!

    const tenants   = await query('SELECT * FROM wa_tenants WHERE user_uid = ? ORDER BY created_at DESC', [uid])
    const tenantIds = tenants.map((t) => (t as { id: string }).id)

    // mysql2 : IN (?) avec un tableau — passer [tenantIds] directement
    const sessions = tenantIds.length
        ? await query('SELECT * FROM wa_sessions WHERE id IN (?)', [tenantIds])
        : []
    const groups = tenantIds.length
        ? await query('SELECT * FROM wa_groups WHERE tenant_id IN (?) ORDER BY created_at DESC', [tenantIds])
        : []
    const messages = tenantIds.length
        ? await query('SELECT * FROM wa_messages WHERE tenant_id IN (?) ORDER BY created_at DESC LIMIT 200', [tenantIds])
        : []
    const payments = tenantIds.length
        ? await query('SELECT * FROM subscription_payments WHERE tenant_id IN (?) ORDER BY created_at DESC', [tenantIds])
        : []
    const devices      = await query('SELECT * FROM auth_devices WHERE registered_uid = ? ORDER BY last_seen_at DESC', [uid])
    const securityLogs = await query('SELECT * FROM auth_device_sessions WHERE user_uid = ? ORDER BY created_at DESC LIMIT 100', [uid])

    return {
        profile_type: 'user',
        account:      maskSensitive(usersTable, accountRows[0] as Record<string, unknown>),
        tenants:      tenants.map((r) => maskSensitive(tenantsTable, r as Record<string, unknown>)),
        sessions:     sessions.map((r) => maskSensitive(sessionsTable, r as Record<string, unknown>)),
        groups:       groups.map((r) => maskSensitive(groupsTable, r as Record<string, unknown>)),
        messages:     messages.map((r) => maskSensitive(messagesTable, r as Record<string, unknown>)),
        payments:     payments.map((r) => maskSensitive(paymentsTable, r as Record<string, unknown>)),
        devices:      devices.map((r) => maskSensitive(devicesTable, r as Record<string, unknown>)),
        securityLogs: securityLogs.map((r) => maskSensitive(logsTable, r as Record<string, unknown>)),
        adminSession: null,
    }
}

/** Tables autorisées pour l'édition champ-par-champ depuis la vue Profil. */
const PROFILE_FAMILY: Record<string, { ownerColumn: string; viaTenants?: boolean }> = {
    auth_users:            { ownerColumn: 'uid' },
    wa_tenants:            { ownerColumn: 'user_uid' },
    wa_sessions:           { ownerColumn: 'id', viaTenants: true },  // id session = id tenant
    wa_groups:             { ownerColumn: 'tenant_id', viaTenants: true },
    wa_messages:           { ownerColumn: 'tenant_id', viaTenants: true },
    subscription_payments: { ownerColumn: 'tenant_id', viaTenants: true },
    auth_devices:          { ownerColumn: 'registered_uid' },
}

async function assertRowBelongsToUser(uid: string, table: string, pkValues: unknown[]): Promise<void> {
    const rule = PROFILE_FAMILY[table]
    if (!rule) throw new AdminDbError('FORBIDDEN_TABLE', `Table non éditable depuis un profil : ${table}`)
    const meta = getTableMeta(table)!

    if (!rule.viaTenants) {
        const clause = meta.pk.map(c => `${c} = ?`).join(' AND ')
        const rows = await query(`SELECT 1 FROM ${table} WHERE ${rule.ownerColumn} = ? AND ${clause}`, [uid, ...pkValues])
        if (!rows[0]) throw new AdminDbError('FORBIDDEN', "Cette ligne n'appartient pas à ce profil")
        return
    }

    // Table rattachée via les tenants du user
    const pkClause = meta.pk.map(c => `${c} = ?`).join(' AND ')
    const rows = await query(
        `SELECT 1 FROM ${table} t WHERE ${pkClause}
         AND EXISTS (SELECT 1 FROM wa_tenants wt WHERE wt.id = t.${rule.ownerColumn} AND wt.user_uid = ?)`,
        [...pkValues, uid]
    )
    if (!rows[0]) throw new AdminDbError('FORBIDDEN', "Cette ligne n'appartient pas à ce profil")
}

export async function updateProfileField(
    uid:      string,
    table:    string,
    pkValues: unknown[],
    column:   string,
    value:    unknown
) {
    // Pour un profil admin : seules convessa_admins et wa_sessions sont modifiables
    if (uid.startsWith('admin:')) {
        const adminId = parseInt(uid.slice(6), 10)
        if (isNaN(adminId)) throw new AdminDbError('NOT_FOUND', 'Admin introuvable')
        if (table !== 'convessa_admins' && table !== 'wa_sessions') {
            throw new AdminDbError('FORBIDDEN_TABLE', `Table non éditable depuis un profil admin : ${table}`)
        }
        if (table === 'convessa_admins') {
            const rows = await query('SELECT 1 FROM convessa_admins WHERE id = ?', [adminId])
            if (!rows[0]) throw new AdminDbError('NOT_FOUND', 'Admin introuvable')
        }
        if (table === 'wa_sessions' && pkValues[0] !== 'admin') {
            throw new AdminDbError('FORBIDDEN', "Seule la session 'admin' est modifiable depuis ce profil")
        }
        return updateRow(table, pkValues, { [column]: value })
    }

    await assertRowBelongsToUser(uid, table, pkValues)
    return updateRow(table, pkValues, { [column]: value })
}

/**
 * Supprime totalement un profil dans une transaction MySQL.
 */
export async function deleteProfile(uid: string): Promise<{ deletedTenants: number }> {
    // ── Suppression d'un admin Convessa ───────────────────────────────────────
    if (uid.startsWith('admin:')) {
        const adminId = parseInt(uid.slice(6), 10)
        if (isNaN(adminId)) throw new AdminDbError('NOT_FOUND', 'Admin introuvable')
        await query('DELETE FROM convessa_admins WHERE id = ?', [adminId])
        return { deletedTenants: 0 }
    }

    // ── Suppression d'un utilisateur Firebase — transaction MySQL ─────────────
    const pool   = getPool()
    const client = await pool.getConnection()
    try {
        await client.beginTransaction()

        const [tenantRows] = await client.execute<import('mysql2').RowDataPacket[]>(
            'SELECT id FROM wa_tenants WHERE user_uid = ?', [uid]
        )
        const tenantIds: string[] = tenantRows.map((r) => String(r['id']))

        if (tenantIds.length > 0) {
            await client.execute('DELETE FROM wa_session_keys WHERE session_id IN (?)', [tenantIds])
            await client.execute('DELETE FROM wa_sessions WHERE id IN (?)', [tenantIds])
            await client.execute('DELETE FROM wa_message_queue WHERE tenant_id IN (?)', [tenantIds])
            // wa_groups, wa_messages, subscription_payments → ON DELETE CASCADE
            await client.execute('DELETE FROM wa_tenants WHERE user_uid = ?', [uid])
        }

        await client.execute('DELETE FROM auth_device_sessions WHERE user_uid = ?', [uid])
        await client.execute('UPDATE auth_devices SET registered_uid = NULL WHERE registered_uid = ?', [uid])
        await client.execute(
            'DELETE FROM auth_otp_codes WHERE phone = (SELECT phone FROM auth_users WHERE uid = ?)', [uid]
        )
        await client.execute('DELETE FROM auth_users WHERE uid = ?', [uid])

        await client.commit()
        return { deletedTenants: tenantIds.length }
    } catch (err) {
        await client.rollback()
        throw err
    } finally {
        client.release()
    }
}
