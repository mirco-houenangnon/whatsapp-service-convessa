/**
 * AdminStore.ts — Gestion des administrateurs Convessa.
 *
 * Table : convessa_admins
 * Auth  : email + mot de passe hashé (bcrypt-like via Node crypto — scrypt)
 * Sessions : JWT signés avec ADMIN_JWT_SECRET
 */

import { getPool }  from './connection.js'
import { logger }   from '../services/logger.js'
import { createHash, scryptSync, randomBytes, timingSafeEqual } from 'crypto'
import type mysql from 'mysql2/promise'

export interface AdminRow {
    id:           number
    email:        string
    display_name: string | null
    password_hash: string
    active:       boolean
    created_at:   Date
    last_login_at: Date | null
}

// ── Hash / verify password (scrypt — pas besoin de bcrypt) ────────────────────

/**
 * Hash un mot de passe avec scrypt + sel aléatoire.
 * Format stocké : "<salt_hex>:<hash_hex>"
 */
export function hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(password, salt, 64).toString('hex')
    return `${salt}:${hash}`
}

/**
 * Vérifie un mot de passe contre son hash stocké.
 * Utilise timingSafeEqual pour éviter les timing attacks.
 */
export function verifyPassword(password: string, stored: string): boolean {
    const [salt, storedHash] = stored.split(':')
    if (!salt || !storedHash) return false

    try {
        const hash       = scryptSync(password, salt, 64)
        const storedBuf  = Buffer.from(storedHash, 'hex')
        return timingSafeEqual(hash, storedBuf)
    } catch {
        return false
    }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function getAdminByEmail(email: string): Promise<AdminRow | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<AdminRow[] & mysql.RowDataPacket[]>(
        `SELECT id, email, display_name, password_hash, active, created_at, last_login_at
         FROM convessa_admins
         WHERE email = ? AND active = TRUE
         LIMIT 1`,
        [email.toLowerCase().trim()]
    )
    return rows[0] ?? null
}

export async function getAdminById(id: number): Promise<AdminRow | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<AdminRow[] & mysql.RowDataPacket[]>(
        `SELECT id, email, display_name, password_hash, active, created_at, last_login_at
         FROM convessa_admins
         WHERE id = ? AND active = TRUE
         LIMIT 1`,
        [id]
    )
    return rows[0] ?? null
}

export async function updateAdminLastLogin(id: number): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE convessa_admins SET last_login_at = NOW() WHERE id = ?`,
        [id]
    )
}

export async function createAdmin(data: {
    email:       string
    password:    string
    displayName?: string
}): Promise<AdminRow> {
    const pool         = getPool()
    const passwordHash = hashPassword(data.password)

    const [result] = await pool.execute<mysql.OkPacket>(
        `INSERT INTO convessa_admins (email, display_name, password_hash)
         VALUES (?, ?, ?)`,
        [data.email.toLowerCase().trim(), data.displayName ?? null, passwordHash]
    )

    const id    = (result as { insertId: number }).insertId
    const admin = await getAdminById(id)
    if (!admin) throw new Error('Admin introuvable après création')

    logger.info({ component: 'AdminStore', email: data.email }, 'Admin créé')
    return admin
}

export async function updateAdminPassword(id: number, newPassword: string): Promise<void> {
    const pool         = getPool()
    const passwordHash = hashPassword(newPassword)

    await pool.execute(
        `UPDATE convessa_admins SET password_hash = ?, updated_at = NOW() WHERE id = ?`,
        [passwordHash, id]
    )
    logger.info({ component: 'AdminStore', adminId: id }, 'Mot de passe admin mis à jour')
}

export async function updateAdminProfile(id: number, data: {
    displayName?: string
    email?:       string
}): Promise<void> {
    const pool = getPool()

    if (data.displayName !== undefined) {
        await pool.execute(
            `UPDATE convessa_admins SET display_name = ?, updated_at = NOW() WHERE id = ?`,
            [data.displayName, id]
        )
    }
    if (data.email !== undefined) {
        await pool.execute(
            `UPDATE convessa_admins SET email = ?, updated_at = NOW() WHERE id = ?`,
            [data.email.toLowerCase().trim(), id]
        )
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
