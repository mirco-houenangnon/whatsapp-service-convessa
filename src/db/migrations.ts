/**
 * migrations.ts — Création des tables au démarrage si elles n'existent pas.
 * Utilise CREATE TABLE IF NOT EXISTS — idempotent, sans destruction de données.
 */

import { getPool } from './connection.js'
import { logger }  from '../services/logger.js'

const TABLES = [

    // ── Utilisateurs authentifiés (Firebase Auth) ─────────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_users (
        uid           VARCHAR(128)  NOT NULL,
        email         VARCHAR(255)  DEFAULT NULL,
        display_name  VARCHAR(255)  DEFAULT NULL,
        photo_url     VARCHAR(2048) DEFAULT NULL,
        provider      VARCHAR(50)   NOT NULL COMMENT 'google.com | github.com | phone',
        phone         VARCHAR(30)   DEFAULT NULL,
        active        TINYINT(1)    NOT NULL DEFAULT 1,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (uid),
        INDEX idx_email    (email),
        INDEX idx_phone    (phone),
        INDEX idx_provider (provider),
        INDEX idx_active   (active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── OTP — codes de vérification téléphone ─────────────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_otp_codes (
        phone       VARCHAR(30)   NOT NULL,
        code_hash   VARCHAR(64)   NOT NULL COMMENT 'SHA-256 du code OTP',
        expires_at  DATETIME      NOT NULL,
        attempts    TINYINT       NOT NULL DEFAULT 0,
        verified    TINYINT(1)    NOT NULL DEFAULT 0,
        created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (phone),
        INDEX idx_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Tenants (clients du service WhatsApp Gateway) ─────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_tenants (
        id            VARCHAR(36)   NOT NULL,
        user_uid      VARCHAR(128)  DEFAULT NULL COMMENT 'FK vers auth_users.uid',
        phone         VARCHAR(30)   DEFAULT NULL COMMENT 'Rempli automatiquement depuis le JID Baileys apres scan du QR - jamais saisi par l utilisateur',
        name          VARCHAR(100)  DEFAULT NULL,
        api_key_hash  VARCHAR(64)   DEFAULT NULL   COMMENT 'SHA-256 pour vérification',
        api_key_hint  VARCHAR(60)   DEFAULT NULL   COMMENT 'Préfixe visible ex: pk_convessa_a3f8...',
        api_key_enc   TEXT          DEFAULT NULL   COMMENT 'Clé chiffrée AES-256-GCM pour affichage',
        api_key_iv    VARCHAR(32)   DEFAULT NULL   COMMENT 'IV du chiffrement',
        api_key_tag   VARCHAR(32)   DEFAULT NULL   COMMENT 'Tag GCM du chiffrement',
        api_key_expires_at DATETIME DEFAULT NULL   COMMENT 'Date expiration clé API (30 jours)',
        webhook_url   VARCHAR(500)  DEFAULT NULL,
        status        ENUM('pending_qr','connected','disconnected','revoked') NOT NULL DEFAULT 'pending_qr',
        connected_at  DATETIME      DEFAULT NULL,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_phone    (phone),
        INDEX idx_status       (status),
        INDEX idx_api_key_hash (api_key_hash),
        INDEX idx_user_uid     (user_uid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Sessions WhatsApp (Baileys credentials chiffrés) ──────────────────────
    `CREATE TABLE IF NOT EXISTS wa_sessions (
        id            VARCHAR(64)   NOT NULL,
        creds_iv      VARCHAR(32)   NOT NULL,
        creds_tag     VARCHAR(32)   NOT NULL,
        creds_data    LONGTEXT      NOT NULL,
        phone         VARCHAR(50)   DEFAULT NULL,
        display_name  VARCHAR(100)  DEFAULT NULL,
        status        ENUM('active','disconnected','revoked') NOT NULL DEFAULT 'disconnected',
        connected_at  DATETIME      DEFAULT NULL,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Clés Signal Baileys (in-memory mais persistées pour multi-restart) ────
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

    // ── File d'attente des messages ───────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_message_queue (
        id          VARCHAR(36)   NOT NULL,
        tenant_id   VARCHAR(36)   DEFAULT NULL,
        recipient   VARCHAR(30)   NOT NULL,
        jid         VARCHAR(50)   DEFAULT NULL,
        message     TEXT          DEFAULT NULL,
        media_type  ENUM('image','video','audio','document') DEFAULT NULL,
        media_url   TEXT          DEFAULT NULL,
        media_b64   LONGTEXT      DEFAULT NULL,
        media_mime  VARCHAR(100)  DEFAULT NULL,
        media_name  VARCHAR(255)  DEFAULT NULL,
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

    // ── Appareils (empreintes clients) ───────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_devices (
        id               INT           NOT NULL AUTO_INCREMENT,
        fingerprint_hash VARCHAR(64)   NOT NULL COMMENT 'SHA-256 des champs stables du client',
        first_ip         VARCHAR(45)   NOT NULL,
        user_agent       VARCHAR(512)  DEFAULT NULL,
        accept_language  VARCHAR(128)  DEFAULT NULL,
        client_hints     JSON          DEFAULT NULL COMMENT 'Sec-CH-UA et autres hints navigateur',
        first_seen_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        blocked          TINYINT(1)    NOT NULL DEFAULT 0,
        blocked_reason   VARCHAR(255)  DEFAULT NULL,
        registered_uid   VARCHAR(128)  DEFAULT NULL COMMENT 'FK auth_users.uid — null si pas encore inscrit',
        PRIMARY KEY (id),
        UNIQUE KEY uq_fingerprint (fingerprint_hash),
        INDEX idx_registered_uid (registered_uid),
        INDEX idx_blocked        (blocked)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Sessions par appareil (journal de sécurité) ───────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_device_sessions (
        id          BIGINT        NOT NULL AUTO_INCREMENT,
        device_id   INT           NOT NULL,
        user_uid    VARCHAR(128)  DEFAULT NULL,
        ip          VARCHAR(45)   NOT NULL,
        action      ENUM('register_attempt','register_success','login_attempt','login_success','login_blocked') NOT NULL,
        provider    VARCHAR(50)   NOT NULL,
        meta        JSON          DEFAULT NULL,
        created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_device_id  (device_id),
        INDEX idx_user_uid   (user_uid),
        INDEX idx_action     (action),
        INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Groupes WhatsApp créés par les tenants ────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_groups (
        id                       VARCHAR(36)   NOT NULL,
        tenant_id                VARCHAR(36)   NOT NULL,
        wa_group_jid             VARCHAR(60)   NOT NULL COMMENT 'ex: 120363...@g.us',
        name                     VARCHAR(150)  NOT NULL,
        invite_code              VARCHAR(50)   DEFAULT NULL,
        invite_code_generated_at DATETIME      DEFAULT NULL,
        participants_count       INT           NOT NULL DEFAULT 0,
        status                   ENUM('active','deleted') NOT NULL DEFAULT 'active',
        created_at               DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at               DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_tenant_group_name (tenant_id, name),
        UNIQUE KEY uq_tenant_group_jid  (tenant_id, wa_group_jid),
        INDEX idx_tenant (tenant_id),
        CONSTRAINT fk_wa_groups_tenant FOREIGN KEY (tenant_id) REFERENCES wa_tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Journal des messages envoyés par les tenants (self-service /send) ─────
    `CREATE TABLE IF NOT EXISTS wa_messages (
        id             VARCHAR(36)   NOT NULL,
        tenant_id      VARCHAR(36)   NOT NULL,
        to_jid         VARCHAR(60)   NOT NULL,
        to_type        ENUM('contact','group') NOT NULL DEFAULT 'contact',
        message        TEXT          DEFAULT NULL,
        has_media      TINYINT(1)    NOT NULL DEFAULT 0,
        media_type     ENUM('image','video','audio','document') DEFAULT NULL,
        status         ENUM('queued','sent','delivered','failed') NOT NULL DEFAULT 'queued',
        error_code     VARCHAR(50)   DEFAULT NULL,
        error_message  TEXT          DEFAULT NULL,
        wa_message_id  VARCHAR(100)  DEFAULT NULL COMMENT 'ID retourné par Baileys (key.id) une fois réellement transmis',
        created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at        DATETIME      DEFAULT NULL,
        updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_tenant (tenant_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at),
        CONSTRAINT fk_wa_messages_tenant FOREIGN KEY (tenant_id) REFERENCES wa_tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Administrateurs Convessa (backoffice) ─────────────────────────────────
    `CREATE TABLE IF NOT EXISTS convessa_admins (
        id            INT           NOT NULL AUTO_INCREMENT,
        email         VARCHAR(255)  NOT NULL,
        display_name  VARCHAR(100)  DEFAULT NULL,
        password_hash VARCHAR(200)  NOT NULL COMMENT 'scrypt salt:hash',
        active        TINYINT(1)    NOT NULL DEFAULT 1,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        last_login_at DATETIME      DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_email (email),
        INDEX idx_active (active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Codes de parrainage ────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS referral_codes (
        id            VARCHAR(36)   NOT NULL,
        code          VARCHAR(12)   NOT NULL,
        unlimited     TINYINT(1)    NOT NULL DEFAULT 0,
        usage_type    ENUM('duration','requests') DEFAULT NULL,
        usage_value   INT           DEFAULT NULL,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Plans d'abonnement ─────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS subscription_plans (
        id            VARCHAR(36)   NOT NULL,
        name          VARCHAR(100)  NOT NULL,
        price         INT           NOT NULL DEFAULT 0,
        unlimited     TINYINT(1)    NOT NULL DEFAULT 0,
        usage_type    ENUM('duration','requests') DEFAULT NULL,
        usage_value   INT           DEFAULT NULL,
        description   TEXT          DEFAULT NULL,
        features      JSON          DEFAULT NULL  COMMENT 'Liste des fonctionnalités du plan',
        is_popular    TINYINT(1)    NOT NULL DEFAULT 0,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    // ── Paiements d'abonnement ─────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS subscription_payments (
        id              VARCHAR(36)   NOT NULL,
        tenant_id       VARCHAR(36)   NOT NULL,
        plan_id         VARCHAR(36)   NOT NULL,
        gateway         ENUM('fedapay','kkiapay') NOT NULL,
        gateway_tx_id   VARCHAR(255)  DEFAULT NULL COMMENT 'ID de transaction côté passerelle',
        amount          INT           NOT NULL     COMMENT 'Montant en FCFA',
        currency        VARCHAR(10)   NOT NULL DEFAULT 'XOF',
        status          ENUM('pending','success','failed','cancelled') NOT NULL DEFAULT 'pending',
        created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_tenant (tenant_id),
        INDEX idx_plan   (plan_id),
        INDEX idx_status (status),
        INDEX idx_gateway_tx (gateway_tx_id),
        CONSTRAINT fk_payments_tenant FOREIGN KEY (tenant_id) REFERENCES wa_tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_payments_plan   FOREIGN KEY (plan_id)   REFERENCES subscription_plans(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
]

export async function runMigrations(): Promise<void> {
    const pool = getPool()

    for (const sql of TABLES) {
        await pool.execute(sql)
    }

    // Au redémarrage : tout message bloqué en 'sending' → remis en 'queued'
    const [updateResult] = await pool.execute(
        `UPDATE wa_message_queue SET status = 'queued' WHERE status = 'sending'`
    )
    const affected = (updateResult as { affectedRows?: number }).affectedRows ?? 0
    if (affected > 0) {
        logger.warn({ component: 'DB', count: affected }, `${affected} message(s) remis en file`)
    }

    // ── Migrations ALTER TABLE (idempotentes — colonnes ajoutées progressivement)
    await pool.execute(`ALTER TABLE wa_message_queue MODIFY COLUMN message TEXT DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_type ENUM('image','video','audio','document') DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_url  TEXT DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_b64  LONGTEXT DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_mime VARCHAR(100) DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS media_name VARCHAR(255) DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_message_queue ADD COLUMN IF NOT EXISTS tenant_id  VARCHAR(36) DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS user_uid VARCHAR(128) DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS api_key_enc TEXT DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS api_key_iv  VARCHAR(32) DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS api_key_tag VARCHAR(32) DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS phone VARCHAR(30) DEFAULT NULL`).catch(() => {})

    // Agrandir le champ phone de wa_sessions pour les JID complets Baileys (ex: 2508479037570@s.whatsapp.net)
    await pool.execute(`ALTER TABLE wa_sessions MODIFY COLUMN phone VARCHAR(50) DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_tenants MODIFY COLUMN api_key_hint VARCHAR(60) DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS api_key_expires_at DATETIME DEFAULT NULL`).catch(() => {})

    // ── Téléphone désormais optionnel à la création — rempli automatiquement après
    // le scan du QR (le tenant ne saisit plus jamais de numéro manuellement).
    await pool.execute(`ALTER TABLE wa_tenants MODIFY COLUMN phone VARCHAR(30) DEFAULT NULL`).catch(() => {})

    // ── Privilèges d'utilisation (code de parrainage ou plan gratuit) ─────────
    // usage_type      : 'unlimited' (aucune limite), 'duration' (expire à une date —
    //                    stockée dans api_key_expires_at) ou 'requests' (quota de messages).
    // messages_limit  : nombre de messages autorisés si usage_type = 'requests' (sinon NULL).
    // messages_sent   : compteur de messages déjà envoyés (incrémenté à chaque /send).
    // referral_code   : code de parrainage utilisé à l'activation, pour traçabilité (sinon NULL).
    await pool.execute(`ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS usage_type ENUM('unlimited','duration','requests') NOT NULL DEFAULT 'unlimited'`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS messages_limit INT DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS messages_sent INT NOT NULL DEFAULT 0`).catch(() => {})
    await pool.execute(`ALTER TABLE wa_tenants ADD COLUMN IF NOT EXISTS referral_code VARCHAR(12) DEFAULT NULL`).catch(() => {})

    // ── Colonnes supplémentaires pour les plans (description, features, is_popular) ─
    await pool.execute(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS features JSON DEFAULT NULL`).catch(() => {})
    await pool.execute(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_popular TINYINT(1) NOT NULL DEFAULT 0`).catch(() => {})

    logger.info({ component: 'DB' }, 'Migrations OK — tables vérifiées')
}