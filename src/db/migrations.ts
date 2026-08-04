/**
 * migrations.ts — Création des tables MySQL au démarrage.
 * Idempotent : CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.
 * Seed admin automatique si la table convessa_admins est vide.
 */

import { query, execute } from './connection.js'
import { logger }         from '../services/logger.js'
import { scryptSync, randomBytes } from 'crypto'

// ── Helper hash mot de passe (même algo que AdminStore) ───────────────────────
function hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(password, salt, 64).toString('hex')
    return `${salt}:${hash}`
}

const TABLES = [

    // ── Utilisateurs authentifiés (Firebase Auth) ─────────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_users (
        uid           VARCHAR(128)  NOT NULL,
        email         VARCHAR(255)  DEFAULT NULL,
        display_name  VARCHAR(255)  DEFAULT NULL,
        photo_url     VARCHAR(2048) DEFAULT NULL,
        provider      VARCHAR(50)   NOT NULL,
        phone         VARCHAR(30)   DEFAULT NULL,
        active        TINYINT(1)    NOT NULL DEFAULT 1,
        created_at    DATETIME      NOT NULL DEFAULT NOW(),
        last_login_at DATETIME      NOT NULL DEFAULT NOW(),
        PRIMARY KEY (uid),
        INDEX idx_auth_users_email    (email),
        INDEX idx_auth_users_phone    (phone),
        INDEX idx_auth_users_provider (provider),
        INDEX idx_auth_users_active   (active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── OTP ───────────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_otp_codes (
        phone       VARCHAR(30)   NOT NULL,
        code_hash   VARCHAR(64)   NOT NULL,
        expires_at  DATETIME      NOT NULL,
        attempts    SMALLINT      NOT NULL DEFAULT 0,
        verified    TINYINT(1)    NOT NULL DEFAULT 0,
        created_at  DATETIME      NOT NULL DEFAULT NOW(),
        PRIMARY KEY (phone),
        INDEX idx_otp_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Tenants ───────────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_tenants (
        id                 VARCHAR(36)   NOT NULL,
        user_uid           VARCHAR(128)  DEFAULT NULL,
        phone              VARCHAR(30)   DEFAULT NULL,
        name               VARCHAR(100)  DEFAULT NULL,
        api_key_hash       VARCHAR(64)   DEFAULT NULL,
        api_key_hint       VARCHAR(60)   DEFAULT NULL,
        api_key_enc        TEXT          DEFAULT NULL,
        api_key_iv         VARCHAR(32)   DEFAULT NULL,
        api_key_tag        VARCHAR(32)   DEFAULT NULL,
        api_key_expires_at DATETIME      DEFAULT NULL,
        webhook_url        VARCHAR(500)  DEFAULT NULL,
        status             VARCHAR(20)   NOT NULL DEFAULT 'pending_qr',
        usage_type         VARCHAR(20)   NOT NULL DEFAULT 'unlimited',
        messages_limit     INT           DEFAULT NULL,
        messages_sent      INT           NOT NULL DEFAULT 0,
        referral_code      VARCHAR(12)   DEFAULT NULL,
        connected_at       DATETIME      DEFAULT NULL,
        created_at         DATETIME      NOT NULL DEFAULT NOW(),
        updated_at         DATETIME      NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_wa_tenants_phone (phone),
        INDEX idx_wa_tenants_status       (status),
        INDEX idx_wa_tenants_api_key_hash (api_key_hash),
        INDEX idx_wa_tenants_user_uid     (user_uid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Sessions WhatsApp (Baileys) ────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_sessions (
        id            VARCHAR(64)   NOT NULL,
        creds_iv      VARCHAR(32)   NOT NULL DEFAULT '',
        creds_tag     VARCHAR(32)   NOT NULL DEFAULT '',
        creds_data    TEXT          NOT NULL,
        phone         VARCHAR(50)   DEFAULT NULL,
        display_name  VARCHAR(100)  DEFAULT NULL,
        status        VARCHAR(20)   NOT NULL DEFAULT 'disconnected',
        connected_at  DATETIME      DEFAULT NULL,
        created_at    DATETIME      NOT NULL DEFAULT NOW(),
        updated_at    DATETIME      NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Clés Signal Baileys ────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_session_keys (
        session_id  VARCHAR(64)   NOT NULL,
        key_type    VARCHAR(50)   NOT NULL,
        key_id      VARCHAR(255)  NOT NULL,
        key_value   TEXT          NOT NULL,
        created_at  DATETIME      NOT NULL DEFAULT NOW(),
        updated_at  DATETIME      NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id, key_type, key_id),
        INDEX idx_wa_session_keys_session (session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── File d'attente des messages ────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_message_queue (
        id          VARCHAR(36)   NOT NULL,
        tenant_id   VARCHAR(36)   DEFAULT NULL,
        recipient   VARCHAR(30)   NOT NULL,
        jid         VARCHAR(50)   DEFAULT NULL,
        message     TEXT          DEFAULT NULL,
        media_type  VARCHAR(20)   DEFAULT NULL,
        media_url   TEXT          DEFAULT NULL,
        media_b64   TEXT          DEFAULT NULL,
        media_mime  VARCHAR(100)  DEFAULT NULL,
        media_name  VARCHAR(255)  DEFAULT NULL,
        status      VARCHAR(10)   NOT NULL DEFAULT 'queued',
        attempts    SMALLINT      NOT NULL DEFAULT 0,
        last_error  TEXT          DEFAULT NULL,
        queued_at   DATETIME      NOT NULL DEFAULT NOW(),
        sent_at     DATETIME      DEFAULT NULL,
        PRIMARY KEY (id),
        INDEX idx_wa_message_queue_status    (status),
        INDEX idx_wa_message_queue_queued_at (queued_at),
        INDEX idx_wa_message_queue_tenant_id (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Journal d'activité ─────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_logs (
        id          BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
        level       VARCHAR(10)   NOT NULL,
        component   VARCHAR(50)   NOT NULL,
        message     TEXT          NOT NULL,
        context     JSON          DEFAULT NULL,
        created_at  DATETIME      NOT NULL DEFAULT NOW(),
        INDEX idx_wa_logs_level      (level),
        INDEX idx_wa_logs_component  (component),
        INDEX idx_wa_logs_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Appareils (empreintes clients) ─────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_devices (
        id               INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
        fingerprint_hash VARCHAR(64)   NOT NULL,
        first_ip         VARCHAR(45)   NOT NULL,
        user_agent       VARCHAR(512)  DEFAULT NULL,
        accept_language  VARCHAR(128)  DEFAULT NULL,
        client_hints     JSON          DEFAULT NULL,
        first_seen_at    DATETIME      NOT NULL DEFAULT NOW(),
        last_seen_at     DATETIME      NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
        blocked          TINYINT(1)    NOT NULL DEFAULT 0,
        blocked_reason   VARCHAR(255)  DEFAULT NULL,
        registered_uid   VARCHAR(128)  DEFAULT NULL,
        UNIQUE KEY uq_auth_devices_fp (fingerprint_hash),
        INDEX idx_auth_devices_registered_uid (registered_uid),
        INDEX idx_auth_devices_blocked        (blocked)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Sessions par appareil ──────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_device_sessions (
        id          BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
        device_id   INT           NOT NULL,
        user_uid    VARCHAR(128)  DEFAULT NULL,
        ip          VARCHAR(45)   NOT NULL,
        action      VARCHAR(30)   NOT NULL,
        provider    VARCHAR(50)   NOT NULL,
        meta        JSON          DEFAULT NULL,
        created_at  DATETIME      NOT NULL DEFAULT NOW(),
        INDEX idx_auth_device_sessions_device_id  (device_id),
        INDEX idx_auth_device_sessions_user_uid   (user_uid),
        INDEX idx_auth_device_sessions_action     (action),
        INDEX idx_auth_device_sessions_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Groupes WhatsApp ───────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_groups (
        id                       VARCHAR(36)   NOT NULL,
        tenant_id                VARCHAR(36)   NOT NULL,
        wa_group_jid             VARCHAR(60)   NOT NULL,
        name                     VARCHAR(150)  NOT NULL,
        invite_code              VARCHAR(50)   DEFAULT NULL,
        invite_code_generated_at DATETIME      DEFAULT NULL,
        participants_count       INT           NOT NULL DEFAULT 0,
        status                   VARCHAR(10)   NOT NULL DEFAULT 'active',
        created_at               DATETIME      NOT NULL DEFAULT NOW(),
        updated_at               DATETIME      NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_wa_groups_tenant_name (tenant_id, name),
        UNIQUE KEY uq_wa_groups_tenant_jid  (tenant_id, wa_group_jid),
        INDEX idx_wa_groups_tenant (tenant_id),
        CONSTRAINT fk_wa_groups_tenant FOREIGN KEY (tenant_id) REFERENCES wa_tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Journal des messages tenant ────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_messages (
        id             VARCHAR(36)   NOT NULL,
        tenant_id      VARCHAR(36)   NOT NULL,
        to_jid         VARCHAR(60)   NOT NULL,
        to_type        VARCHAR(10)   NOT NULL DEFAULT 'contact',
        message        TEXT          DEFAULT NULL,
        has_media      TINYINT(1)    NOT NULL DEFAULT 0,
        media_type     VARCHAR(20)   DEFAULT NULL,
        status         VARCHAR(10)   NOT NULL DEFAULT 'queued',
        error_code     VARCHAR(50)   DEFAULT NULL,
        error_message  TEXT          DEFAULT NULL,
        wa_message_id  VARCHAR(100)  DEFAULT NULL,
        created_at     DATETIME      NOT NULL DEFAULT NOW(),
        sent_at        DATETIME      DEFAULT NULL,
        updated_at     DATETIME      NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_wa_messages_tenant     (tenant_id),
        INDEX idx_wa_messages_status     (status),
        INDEX idx_wa_messages_created_at (created_at),
        CONSTRAINT fk_wa_messages_tenant FOREIGN KEY (tenant_id) REFERENCES wa_tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Administrateurs Convessa ───────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS convessa_admins (
        id            INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email         VARCHAR(255)  NOT NULL,
        display_name  VARCHAR(100)  DEFAULT NULL,
        password_hash VARCHAR(200)  NOT NULL,
        active        TINYINT(1)    NOT NULL DEFAULT 1,
        created_at    DATETIME      NOT NULL DEFAULT NOW(),
        updated_at    DATETIME      NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
        last_login_at DATETIME      DEFAULT NULL,
        UNIQUE KEY uq_convessa_admins_email (email),
        INDEX idx_convessa_admins_active (active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Codes de parrainage ────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS referral_codes (
        id            VARCHAR(36)   NOT NULL,
        code          VARCHAR(12)   NOT NULL,
        unlimited     TINYINT(1)    NOT NULL DEFAULT 0,
        usage_type    VARCHAR(10)   DEFAULT NULL,
        usage_value   INT           DEFAULT NULL,
        created_at    DATETIME      NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        UNIQUE KEY uq_referral_codes_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Plans d'abonnement ─────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS subscription_plans (
        id            VARCHAR(36)   NOT NULL,
        name          VARCHAR(100)  NOT NULL,
        price         INT           NOT NULL DEFAULT 0,
        unlimited     TINYINT(1)    NOT NULL DEFAULT 0,
        usage_type    VARCHAR(10)   DEFAULT NULL,
        usage_value   INT           DEFAULT NULL,
        description   TEXT          DEFAULT NULL,
        features      JSON          DEFAULT NULL,
        is_popular    TINYINT(1)    NOT NULL DEFAULT 0,
        created_at    DATETIME      NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Paiements d'abonnement ─────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS subscription_payments (
        id              VARCHAR(36)   NOT NULL,
        tenant_id       VARCHAR(36)   NOT NULL,
        plan_id         VARCHAR(36)   NOT NULL,
        gateway         VARCHAR(10)   NOT NULL,
        gateway_tx_id   VARCHAR(255)  DEFAULT NULL,
        amount          INT           NOT NULL,
        currency        VARCHAR(10)   NOT NULL DEFAULT 'XOF',
        status          VARCHAR(10)   NOT NULL DEFAULT 'pending',
        created_at      DATETIME      NOT NULL DEFAULT NOW(),
        updated_at      DATETIME      NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_sub_payments_tenant     (tenant_id),
        INDEX idx_sub_payments_plan       (plan_id),
        INDEX idx_sub_payments_status     (status),
        INDEX idx_sub_payments_gateway_tx (gateway_tx_id),
        CONSTRAINT fk_payments_tenant FOREIGN KEY (tenant_id) REFERENCES wa_tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_payments_plan   FOREIGN KEY (plan_id)   REFERENCES subscription_plans(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Membres communauté Convessa ────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS community_members (
        id            VARCHAR(36)   NOT NULL,
        first_name    VARCHAR(100)  NOT NULL,
        last_name     VARCHAR(100)  NOT NULL,
        phone         VARCHAR(30)   NOT NULL,
        email         VARCHAR(255)  DEFAULT NULL,
        user_uid      VARCHAR(128)  DEFAULT NULL COMMENT 'FK auth_users.uid si connecté',
        joined_at     DATETIME      NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        UNIQUE KEY uq_community_phone (phone),
        INDEX idx_community_user_uid (user_uid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Messages de contact ────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS contact_messages (
        id                      VARCHAR(36)   NOT NULL,
        name                    VARCHAR(150)  NOT NULL,
        email                   VARCHAR(255)  NOT NULL,
        phone                   VARCHAR(30)   DEFAULT NULL,
        subject                 VARCHAR(255)  NOT NULL,
        message                 TEXT          NOT NULL,
        status                  VARCHAR(20)   NOT NULL DEFAULT 'unread'
                                    COMMENT 'unread | read | replied',
        user_notified_at        DATETIME      DEFAULT NULL COMMENT 'Confirmation WhatsApp envoyée au demandeur',
        admin_group_notified_at DATETIME      DEFAULT NULL COMMENT 'Notification WhatsApp envoyée au groupe admin',
        read_at                 DATETIME      DEFAULT NULL,
        created_at              DATETIME      NOT NULL DEFAULT NOW(),
        updated_at              DATETIME      NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_contact_status (status),
        INDEX idx_contact_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Réponses admin aux messages de contact (fil de discussion) ────────────
    `CREATE TABLE IF NOT EXISTS contact_message_replies (
        id                  VARCHAR(36)   NOT NULL,
        contact_message_id  VARCHAR(36)   NOT NULL,
        admin_id            INT           DEFAULT NULL,
        admin_name          VARCHAR(100)  DEFAULT NULL,
        body                TEXT          DEFAULT NULL,
        media_type          VARCHAR(20)   DEFAULT NULL,
        media_mime          VARCHAR(100)  DEFAULT NULL,
        media_name          VARCHAR(255)  DEFAULT NULL,
        wa_message_id       VARCHAR(255)  DEFAULT NULL,
        status              VARCHAR(20)   NOT NULL DEFAULT 'sent'
                                COMMENT 'sent | failed',
        error_message       VARCHAR(500)  DEFAULT NULL,
        created_at          DATETIME      NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        INDEX idx_replies_contact_message (contact_message_id),
        CONSTRAINT fk_replies_contact_message FOREIGN KEY (contact_message_id)
            REFERENCES contact_messages(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Paramètres applicatifs (clé/valeur) ────────────────────────────────────
    // Utilisé notamment pour stocker le JID du groupe WhatsApp admin
    // ("Messages depuis Contact") créé depuis le backoffice.
    `CREATE TABLE IF NOT EXISTS app_settings (
        setting_key    VARCHAR(100)  NOT NULL,
        setting_value  TEXT          DEFAULT NULL,
        updated_at     DATETIME      NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (setting_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
]

// ── Migrations idempotentes — colonnes ajoutées progressivement ───────────────
const ALTER_MIGRATIONS = [
    `ALTER TABLE wa_message_queue MODIFY COLUMN message TEXT DEFAULT NULL`,
    `ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_type VARCHAR(20) DEFAULT NULL`,
    `ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_url  TEXT DEFAULT NULL`,
    `ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_b64  TEXT DEFAULT NULL`,
    `ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_mime VARCHAR(100) DEFAULT NULL`,
    `ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_name VARCHAR(255) DEFAULT NULL`,
    `ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS tenant_id  VARCHAR(36) DEFAULT NULL`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS user_uid           VARCHAR(128) DEFAULT NULL`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS api_key_enc        TEXT DEFAULT NULL`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS api_key_iv         VARCHAR(32) DEFAULT NULL`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS api_key_tag        VARCHAR(32) DEFAULT NULL`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS api_key_expires_at DATETIME DEFAULT NULL`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS api_key_hint       VARCHAR(60) DEFAULT NULL`,
    `ALTER TABLE wa_tenants MODIFY COLUMN phone VARCHAR(30) DEFAULT NULL`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS usage_type     VARCHAR(20) NOT NULL DEFAULT 'unlimited'`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS messages_limit  INT DEFAULT NULL`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS messages_sent   INT NOT NULL DEFAULT 0`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS referral_code   VARCHAR(12) DEFAULT NULL`,
    `ALTER TABLE wa_sessions MODIFY COLUMN phone VARCHAR(50) DEFAULT NULL`,
    `ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS phone VARCHAR(30) DEFAULT NULL`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT DEFAULT NULL`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS features    JSON DEFAULT NULL`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_popular  TINYINT(1) NOT NULL DEFAULT 0`,
    // ── Suspension tenant par admin ────────────────────────────────────────────
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS suspended         TINYINT(1)  NOT NULL DEFAULT 0`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS suspension_reason VARCHAR(500) DEFAULT NULL`,
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS suspended_at      DATETIME    DEFAULT NULL`,
    // ── Suivi des notifications quota envoyées (anti-spam) ─────────────────────
    `ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS notif_sent JSON DEFAULT NULL`,
    // ── Messagerie "Contact" — espace admin (fil de discussion + suivi) ────────
    `ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS user_notified_at        DATETIME DEFAULT NULL`,
    `ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS admin_group_notified_at DATETIME DEFAULT NULL`,
    `ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS read_at                 DATETIME DEFAULT NULL`,
    `ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS updated_at              DATETIME NOT NULL DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP`,
]

export async function runMigrations(): Promise<void> {
    // 1. Créer toutes les tables
    for (const sql of TABLES) {
        await query(sql)
    }

    // 2. Migrations ALTER TABLE idempotentes
    for (const sql of ALTER_MIGRATIONS) {
        await query(sql).catch(() => { /* ignorer si déjà appliqué */ })
    }

    // 3. Remettre en file les messages bloqués en 'sending'
    const result = await execute(
        `UPDATE wa_message_queue SET status = 'queued' WHERE status = 'sending'`
    )
    if (result.affectedRows > 0) {
        logger.warn({ component: 'DB', count: result.affectedRows }, `${result.affectedRows} message(s) remis en file`)
    }

    // 4. Seed admin par défaut (une seule fois, si aucun admin n'existe)
    const countRows = await query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM convessa_admins`
    )
    const adminCount = Number(countRows[0]?.cnt ?? 0)

    if (adminCount === 0) {
        const ADMIN_EMAIL    = 'convessa@service.com'
        const ADMIN_PASSWORD = 'Convessa@Service_2026'
        const ADMIN_NAME     = 'Convessa Admin'
        const passwordHash   = hashPassword(ADMIN_PASSWORD)

        await execute(
            `INSERT INTO convessa_admins (email, display_name, password_hash) VALUES (?, ?, ?)`,
            [ADMIN_EMAIL, ADMIN_NAME, passwordHash]
        )
        logger.info(
            { component: 'DB', email: ADMIN_EMAIL },
            '🔐 Admin par défaut créé — CHANGEZ le mot de passe après la première connexion !'
        )
    }

    // ── Nettoyage des sessions dupliquées — garde seulement la plus récente par user ──
    // Supprime les anciens doublons 'disconnected' quand un user en a plusieurs
    await execute(
        `DELETE t1 FROM wa_tenants t1
         INNER JOIN wa_tenants t2
         WHERE t1.user_uid IS NOT NULL
           AND t1.user_uid = t2.user_uid
           AND t1.status = 'disconnected'
           AND t2.created_at > t1.created_at`
    ).catch(() => { /* ignorer si déjà nettoyé */ })

    logger.info({ component: 'DB' }, 'Migrations MySQL OK — tables vérifiées')
}

// helper exposé pour les stores
export { query }
