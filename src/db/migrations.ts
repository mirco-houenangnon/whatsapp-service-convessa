/**
 * migrations.ts — Création des tables au démarrage si elles n'existent pas.
 * Utilise CREATE TABLE IF NOT EXISTS — idempotent, sans destruction de données.
 */

import { getPool } from './connection.js'
import { logger }  from '../services/logger.js'

const TABLES = [

    // ── Utilisateurs authentifiés (Firebase Auth) ────────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_users (
        uid           VARCHAR(128)  NOT NULL,
        email         VARCHAR(255)  DEFAULT NULL,
        display_name  VARCHAR(255)  DEFAULT NULL,
        photo_url     VARCHAR(2048) DEFAULT NULL,
        provider      VARCHAR(50)   NOT NULL COMMENT 'google.com | github.com',
        active        TINYINT(1)    NOT NULL DEFAULT 1,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (uid),
        INDEX idx_email    (email),
        INDEX idx_provider (provider),
        INDEX idx_active   (active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Tenants (clients du service) ─────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_tenants (
        id            VARCHAR(36)   NOT NULL,
        phone         VARCHAR(30)   NOT NULL,
        name          VARCHAR(100)  DEFAULT NULL,
        api_key_hash  VARCHAR(64)   DEFAULT NULL,
        api_key_hint  VARCHAR(16)   DEFAULT NULL,
        webhook_url   VARCHAR(500)  DEFAULT NULL,
        status        ENUM('pending_qr','connected','disconnected','revoked') NOT NULL DEFAULT 'pending_qr',
        connected_at  DATETIME      DEFAULT NULL,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_phone (phone),
        INDEX idx_status       (status),
        INDEX idx_api_key_hash (api_key_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Sessions WhatsApp ─────────────────────────────────────────────────────
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

    // ── File d'attente des messages ───────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_message_queue (
        id          VARCHAR(36)   NOT NULL,
        recipient   VARCHAR(30)   NOT NULL,
        jid         VARCHAR(50)   DEFAULT NULL,
        message     TEXT          DEFAULT NULL,
        media_type  ENUM('image','video','audio','document') DEFAULT NULL,
        media_url   TEXT          DEFAULT NULL,
        media_b64   LONGTEXT      DEFAULT NULL,
        media_mime  VARCHAR(100)  DEFAULT NULL,
        media_name  VARCHAR(255)  DEFAULT NULL,
        tenant_id   VARCHAR(36)   DEFAULT NULL,
        status      ENUM('queued','sending','sent','failed') NOT NULL DEFAULT 'queued',
        attempts    TINYINT       NOT NULL DEFAULT 0,
        last_error  TEXT          DEFAULT NULL,
        queued_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at     DATETIME      DEFAULT NULL,
        PRIMARY KEY (id),
        INDEX idx_status    (status),
        INDEX idx_queued_at (queued_at),
        INDEX idx_tenant_id (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Journal d'activité ────────────────────────────────────────────────────
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

    // ── Clés Signal Baileys ───────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_session_keys (
        session_id  VARCHAR(64)   NOT NULL,
        key_type    VARCHAR(50)   NOT NULL,
        key_id      VARCHAR(255)  NOT NULL,
        key_value   MEDIUMTEXT    NOT NULL,
        created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id, key_type, key_id),
        INDEX idx_session (session_id)
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

    // ── Migrations ALTER TABLE (colonnes ajoutées progressivement) ────────────
    // Média sur les messages existants
    await pool.execute(`ALTER TABLE wa_message_queue MODIFY COLUMN message TEXT DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_type ENUM('image','video','audio','document') DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_url  TEXT DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_b64  LONGTEXT DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_mime VARCHAR(100) DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_name VARCHAR(255) DEFAULT NULL`).catch(() => {})
    // Tenant ID sur les messages existants
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(36) DEFAULT NULL`).catch(() => {})

    logger.info({ component: 'DB' }, 'Migrations OK — tables vérifiées')
}
