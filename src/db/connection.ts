/**
 * connection.ts — Pool de connexion MySQL (mysql2).
 * Un pool unique partagé dans tout le service.
 */

import mysql from 'mysql2/promise'
import { config } from '../config.js'
import { logger } from '../services/logger.js'

let pool: mysql.Pool | null = null

export function getPool(): mysql.Pool {
    if (!pool) {
        pool = mysql.createPool({
            host:               config.db.host,
            port:               config.db.port,
            database:           config.db.name,
            user:               config.db.user,
            password:           config.db.pass,
            charset:            'utf8mb4',
            timezone:           'Z',
            waitForConnections: true,
            connectionLimit:    10,
            queueLimit:         0,
            connectTimeout:     10_000,
        })

        logger.info({ component: 'DB' }, `Pool MySQL créé → ${config.db.host}:${config.db.port}/${config.db.name}`)
    }
    return pool
}

/**
 * Exécute une requête SELECT paramétrée (placeholders `?`).
 * Retourne les lignes sous forme T[].
 */
export async function query<T = Record<string, unknown>>(
    sql:     string,
    params?: unknown[]
): Promise<T[]> {
    const [rows] = await getPool().execute<mysql.RowDataPacket[]>(sql, params)
    return rows as unknown as T[]
}

/**
 * Exécute une requête INSERT / UPDATE / DELETE.
 * Retourne le OkPacket (insertId, affectedRows, etc.).
 */
export async function execute(
    sql:     string,
    params?: unknown[]
): Promise<mysql.OkPacket> {
    const [result] = await getPool().execute<mysql.OkPacket>(sql, params)
    return result
}

/**
 * Teste la connexion à la base de données.
 */
export async function testConnection(): Promise<void> {
    await query('SELECT 1')
    logger.info({ component: 'DB' }, 'Connexion MySQL OK')
}

/**
 * Ferme proprement le pool.
 */
export async function closePool(): Promise<void> {
    if (pool) {
        await pool.end()
        pool = null
        logger.info({ component: 'DB' }, 'Pool MySQL fermé')
    }
}
