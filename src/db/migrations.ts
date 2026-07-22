/**
 * migrations.ts — Création des tables au démarrage si elles n'existent pas.
 * Utilise CREATE TABLE IF NOT EXISTS — idempotent, sans destruction de données.
 */

import { getPool } from './connection.js'
import { logger }  from '../services/logger.js'

const TABLES = [

    // ── Sessions WhatsApp ────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_sessions (
        id            VARCHAR(64)   NOT NULL,
        creds_iv      VARCHAR(32)   NOT NULL,
        creds_tag     VARCHAR(32)   NOT NULL,
        creds_data    LONGTEXT      NOT NULL,
        phone         VARCHAR(20)   DEFAULT NULL,
        display_name  VARCHAR(100)  DEFAULT NULL,
        status        ENUM('active','disconnected','revoked') NOT NULL DEFAULT 'disconnected',
        connected_at  DATETIME      DEFAULT NULL,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── File d'attente des messages ──────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_message_queue (
        id          VARCHAR(36)   NOT NULL,
        recipient   VARCHAR(30)   NOT NULL,
        jid         VARCHAR(50)   DEFAULT NULL,
        message     TEXT          NOT NULL,
        status      ENUM('queued','sending','sent','failed') NOT NULL DEFAULT 'queued',
        attempts    TINYINT       NOT NULL DEFAULT 0,
        last_error  TEXT          DEFAULT NULL,
        queued_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at     DATETIME      DEFAULT NULL,
        PRIMARY KEY (id),
        INDEX idx_status   (status),
        INDEX idx_queued_at (queued_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Journal d'activité ───────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_logs (
        id          BIGINT        NOT NULL AUTO_INCREMENT,
        level       ENUM('debug','info','warn','error') NOT NULL,
        component   VARCHAR(50)   NOT NULL,
        message     TEXT          NOT NULL,
        context     JSON          DEFAULT NULL,
        created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_level      (level),
        INDEX idx_component  (component),
        INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
]

export async function runMigrations(): Promise<void> {
    const pool = getPool()

    for (const sql of TABLES) {
        await pool.execute(sql)
    }

    // Au redémarrage : tout message bloqué en 'sending' → remis en 'queued'
    // (garantie d'idempotence après un crash)
    const [updateResult] = await pool.execute(
        `UPDATE wa_message_queue SET status = 'queued' WHERE status = 'sending'`
    )
    const affected = (updateResult as { affectedRows?: number }).affectedRows ?? 0

    if (affected > 0) {
        logger.warn(
            { component: 'DB', count: affected },
            `${affected} message(s) remis en file après redémarrage`
        )
    }

    logger.info({ component: 'DB' }, 'Migrations OK — tables vérifiées')
}
