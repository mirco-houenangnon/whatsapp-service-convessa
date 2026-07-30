/**
 * AdminStore.ts — Administrateurs Convessa — MySQL.
 */

import { query, execute }  from './connection.js'
import { logger }          from '../services/logger.js'
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'

export interface AdminRow {
    id:            number
    email:         string
    display_name:  string | null
    password_hash: string
    active:        boolean
    created_at:    Date
    last_login_at: Date | null
}

export function hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(password, salt, 64).toString('hex')
    return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
    const [salt, storedHash] = stored.split(':')
    if (!salt || !storedHash) return false
    try {
        const hash      = scryptSync(password, salt, 64)
        const storedBuf = Buffer.from(storedHash, 'hex')
        return timingSafeEqual(hash, storedBuf)
    } catch { return false }
}

export async function getAdminByEmail(email: string): Promise<AdminRow | null> {
    const rows = await query<AdminRow>(
        `SELECT id, email, display_name, password_hash, active, created_at, last_login_at
         FROM convessa_admins WHERE email = ? AND active = 1 LIMIT 1`,
        [email.toLowerCase().trim()]
    )
    const row = rows[0]
    if (!row) return null
    return { ...row, active: Boolean(row.active) }
}

export async function getAdminById(id: number): Promise<AdminRow | null> {
    const rows = await query<AdminRow>(
        `SELECT id, email, display_name, password_hash, active, created_at, last_login_at
         FROM convessa_admins WHERE id = ? AND active = 1 LIMIT 1`,
        [id]
    )
    const row = rows[0]
    if (!row) return null
    return { ...row, active: Boolean(row.active) }
}

export async function updateAdminLastLogin(id: number): Promise<void> {
    await execute(`UPDATE convessa_admins SET last_login_at = NOW() WHERE id = ?`, [id])
}

export async function createAdmin(data: { email: string; password: string; displayName?: string }): Promise<AdminRow> {
    const passwordHash = hashPassword(data.password)
    const result = await execute(
        `INSERT INTO convessa_admins (email, display_name, password_hash) VALUES (?, ?, ?)`,
        [data.email.toLowerCase().trim(), data.displayName ?? null, passwordHash]
    )
    const admin = await getAdminById(result.insertId)
    if (!admin) throw new Error('Admin introuvable après création')
    logger.info({ component: 'AdminStore', email: data.email }, 'Admin créé')
    return admin
}

export async function updateAdminPassword(id: number, newPassword: string): Promise<void> {
    const passwordHash = hashPassword(newPassword)
    await execute(`UPDATE convessa_admins SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [passwordHash, id])
    logger.info({ component: 'AdminStore', adminId: id }, 'Mot de passe admin mis à jour')
}

export async function updateAdminProfile(id: number, data: { displayName?: string; email?: string }): Promise<void> {
    if (data.displayName !== undefined)
        await execute(`UPDATE convessa_admins SET display_name = ?, updated_at = NOW() WHERE id = ?`, [data.displayName, id])
    if (data.email !== undefined)
        await execute(`UPDATE convessa_admins SET email = ?, updated_at = NOW() WHERE id = ?`, [data.email.toLowerCase().trim(), id])
}

export function sanitizeAdmin(admin: AdminRow) {
    return {
        id:          admin.id,
        email:       admin.email,
        displayName: admin.display_name,
        active:      Boolean(admin.active),
        createdAt:   admin.created_at,
        lastLoginAt: admin.last_login_at,
    }
}
