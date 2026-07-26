/**
 * AdminStore.ts — Gestion des administrateurs Convessa — PostgreSQL.
 */

import { query }  from './connection.js'
import { logger } from '../services/logger.js'
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
         FROM convessa_admins WHERE email = $1 AND active = TRUE LIMIT 1`,
        [email.toLowerCase().trim()]
    )
    return rows[0] ?? null
}

export async function getAdminById(id: number): Promise<AdminRow | null> {
    const rows = await query<AdminRow>(
        `SELECT id, email, display_name, password_hash, active, created_at, last_login_at
         FROM convessa_admins WHERE id = $1 AND active = TRUE LIMIT 1`,
        [id]
    )
    return rows[0] ?? null
}

export async function updateAdminLastLogin(id: number): Promise<void> {
    await query(`UPDATE convessa_admins SET last_login_at = NOW() WHERE id = $1`, [id])
}

export async function createAdmin(data: { email: string; password: string; displayName?: string }): Promise<AdminRow> {
    const passwordHash = hashPassword(data.password)
    const rows = await query<{ id: number }>(
        `INSERT INTO convessa_admins (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [data.email.toLowerCase().trim(), data.displayName ?? null, passwordHash]
    )
    const id    = rows[0]!.id
    const admin = await getAdminById(id)
    if (!admin) throw new Error('Admin introuvable après création')
    logger.info({ component: 'AdminStore', email: data.email }, 'Admin créé')
    return admin
}

export async function updateAdminPassword(id: number, newPassword: string): Promise<void> {
    const passwordHash = hashPassword(newPassword)
    await query(`UPDATE convessa_admins SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [passwordHash, id])
    logger.info({ component: 'AdminStore', adminId: id }, 'Mot de passe admin mis à jour')
}

export async function updateAdminProfile(id: number, data: { displayName?: string; email?: string }): Promise<void> {
    if (data.displayName !== undefined) {
        await query(`UPDATE convessa_admins SET display_name = $1, updated_at = NOW() WHERE id = $2`, [data.displayName, id])
    }
    if (data.email !== undefined) {
        await query(`UPDATE convessa_admins SET email = $1, updated_at = NOW() WHERE id = $2`, [data.email.toLowerCase().trim(), id])
    }
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
