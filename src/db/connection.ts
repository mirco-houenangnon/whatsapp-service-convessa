/**
 * connection.ts — Pool de connexion MySQL.
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
            waitForConnections: true,
            connectionLimit:    10,
            queueLimit:         0,
            timezone:           'Z',          // UTC partout
            charset:            'utf8mb4',
        })

        logger.info({ component: 'DB' }, `Pool MySQL créé → ${config.db.host}:${config.db.port}/${config.db.name}`)
    }

    return pool
}

/**
 * Teste la connexion à la base de données.
 * Lève une erreur si la base est inaccessible.
 */
export async function testConnection(): Promise<void> {
    const conn = await getPool().getConnection()
    await conn.ping()
    conn.release()
    logger.info({ component: 'DB' }, 'Connexion MySQL OK')
}

/**
 * Ferme proprement le pool (utilisé à l'arrêt du service).
 */
export async function closePool(): Promise<void> {
    if (pool) {
        await pool.end()
        pool = null
        logger.info({ component: 'DB' }, 'Pool MySQL fermé')
    }
}
