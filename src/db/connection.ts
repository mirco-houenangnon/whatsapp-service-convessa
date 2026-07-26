/**
 * connection.ts — Pool de connexion PostgreSQL (Neon).
 * Un pool unique partagé dans tout le service.
 */

import pg from 'pg'
import { config } from '../config.js'
import { logger } from '../services/logger.js'

const { Pool } = pg

let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
    if (!pool) {
        pool = new Pool({
            connectionString: config.db.url,
            ssl: { rejectUnauthorized: false },
            max:              10,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
        })

        pool.on('error', (err) => {
            logger.error({ component: 'DB', err }, 'Erreur pool PostgreSQL inattendue')
        })

        logger.info({ component: 'DB' }, 'Pool PostgreSQL (Neon) créé')
    }
    return pool
}

/**
 * Exécute une requête paramétrée.
 * Remplace mysql2 pool.execute() — les placeholders sont $1, $2, ...
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql:    string,
    params?: unknown[]
): Promise<T[]> {
    const result = await getPool().query<T>(sql, params)
    return result.rows
}

/**
 * Teste la connexion à la base de données.
 */
export async function testConnection(): Promise<void> {
    await query('SELECT 1')
    logger.info({ component: 'DB' }, 'Connexion PostgreSQL (Neon) OK')
}

/**
 * Ferme proprement le pool.
 */
export async function closePool(): Promise<void> {
    if (pool) {
        await pool.end()
        pool = null
        logger.info({ component: 'DB' }, 'Pool PostgreSQL fermé')
    }
}
