/**
 * migrations.ts — Création des tables PostgreSQL au démarrage.
 * Idempotent via CREATE TABLE IF NOT EXISTS et ADD COLUMN IF NOT EXISTS.
 */

import { query } from './connection.js'
import { logger } from '../services/logger.js'

const TABLES = [

    // ── Utilisateurs authentifiés (Firebase Auth) ─────────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_users (
        uid           VARCHAR(128)  NOT NULL,
        email         VARCHAR(255)  DEFAULT NULL,
        display_name  VARCHAR(255)  DEFAULT NULL,
        photo_url     VARCHAR(2048) DEFAULT NULL,
        provider      VARCHAR(50)   NOT NULL,
        phone         VARCHAR(30)   DEFAULT NULL,
        active        BOOLEAN       NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (uid)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_auth_users_email    ON auth_users (email)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_users_phone    ON auth_users (phone)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_users_provider ON auth_users (provider)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_users_active   ON auth_users (active)`,

    // ── OTP — codes de vérification téléphone ─────────────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_otp_codes (
        phone       VARCHAR(30)   NOT NULL,
        code_hash   VARCHAR(64)   NOT NULL,
        expires_at  TIMESTAMPTZ   NOT NULL,
        attempts    SMALLINT      NOT NULL DEFAULT 0,
        verified    BOOLEAN       NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (phone)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_otp_expires_at ON auth_otp_codes (expires_at)`,

    // ── Tenants (clients du service WhatsApp Gateway) ─────────────────────────
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
        api_key_expires_at TIMESTAMPTZ   DEFAULT NULL,
        webhook_url        VARCHAR(500)  DEFAULT NULL,
        status             VARCHAR(20)   NOT NULL DEFAULT 'pending_qr'
                               CHECK (status IN ('pending_qr','connected','disconnected','revoked')),
        usage_type         VARCHAR(20)   NOT NULL DEFAULT 'unlimited'
                               CHECK (usage_type IN ('unlimited','duration','requests')),
        messages_limit     INTEGER       DEFAULT NULL,
        messages_sent      INTEGER       NOT NULL DEFAULT 0,
        referral_code      VARCHAR(12)   DEFAULT NULL,
        connected_at       TIMESTAMPTZ   DEFAULT NULL,
        created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        UNIQUE (phone)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_wa_tenants_status       ON wa_tenants (status)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_tenants_api_key_hash ON wa_tenants (api_key_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_tenants_user_uid     ON wa_tenants (user_uid)`,

    // ── Sessions WhatsApp (Baileys credentials chiffrés) ──────────────────────
    `CREATE TABLE IF NOT EXISTS wa_sessions (
        id            VARCHAR(64)   NOT NULL,
        creds_iv      VARCHAR(32)   NOT NULL DEFAULT '',
        creds_tag     VARCHAR(32)   NOT NULL DEFAULT '',
        creds_data    TEXT          NOT NULL DEFAULT '',
        phone         VARCHAR(50)   DEFAULT NULL,
        display_name  VARCHAR(100)  DEFAULT NULL,
        status        VARCHAR(20)   NOT NULL DEFAULT 'disconnected'
                          CHECK (status IN ('active','disconnected','revoked')),
        connected_at  TIMESTAMPTZ   DEFAULT NULL,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id)
    )`,

    // ── Clés Signal Baileys ───────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_session_keys (
        session_id  VARCHAR(64)   NOT NULL,
        key_type    VARCHAR(50)   NOT NULL,
        key_id      VARCHAR(255)  NOT NULL,
        key_value   TEXT          NOT NULL,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, key_type, key_id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_wa_session_keys_session ON wa_session_keys (session_id)`,

    // ── File d'attente des messages ───────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_message_queue (
        id          VARCHAR(36)   NOT NULL,
        tenant_id   VARCHAR(36)   DEFAULT NULL,
        recipient   VARCHAR(30)   NOT NULL,
        jid         VARCHAR(50)   DEFAULT NULL,
        message     TEXT          DEFAULT NULL,
        media_type  VARCHAR(20)   DEFAULT NULL
                        CHECK (media_type IS NULL OR media_type IN ('image','video','audio','document')),
        media_url   TEXT          DEFAULT NULL,
        media_b64   TEXT          DEFAULT NULL,
        media_mime  VARCHAR(100)  DEFAULT NULL,
        media_name  VARCHAR(255)  DEFAULT NULL,
        status      VARCHAR(10)   NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sending','sent','failed')),
        attempts    SMALLINT      NOT NULL DEFAULT 0,
        last_error  TEXT          DEFAULT NULL,
        queued_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        sent_at     TIMESTAMPTZ   DEFAULT NULL,
        PRIMARY KEY (id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_wa_message_queue_status    ON wa_message_queue (status)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_message_queue_queued_at ON wa_message_queue (queued_at)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_message_queue_tenant_id ON wa_message_queue (tenant_id)`,

    // ── Journal d'activité ────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_logs (
        id          BIGSERIAL     PRIMARY KEY,
        level       VARCHAR(10)   NOT NULL CHECK (level IN ('debug','info','warn','error')),
        component   VARCHAR(50)   NOT NULL,
        message     TEXT          NOT NULL,
        context     JSONB         DEFAULT NULL,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_wa_logs_level      ON wa_logs (level)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_logs_component  ON wa_logs (component)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_logs_created_at ON wa_logs (created_at)`,

    // ── Appareils (empreintes clients) ────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_devices (
        id               SERIAL        PRIMARY KEY,
        fingerprint_hash VARCHAR(64)   NOT NULL,
        first_ip         VARCHAR(45)   NOT NULL,
        user_agent       VARCHAR(512)  DEFAULT NULL,
        accept_language  VARCHAR(128)  DEFAULT NULL,
        client_hints     JSONB         DEFAULT NULL,
        first_seen_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        last_seen_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        blocked          BOOLEAN       NOT NULL DEFAULT FALSE,
        blocked_reason   VARCHAR(255)  DEFAULT NULL,
        registered_uid   VARCHAR(128)  DEFAULT NULL,
        UNIQUE (fingerprint_hash)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_auth_devices_registered_uid ON auth_devices (registered_uid)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_devices_blocked        ON auth_devices (blocked)`,

    // ── Sessions par appareil (journal de sécurité) ───────────────────────────
    `CREATE TABLE IF NOT EXISTS auth_device_sessions (
        id          BIGSERIAL     PRIMARY KEY,
        device_id   INTEGER       NOT NULL,
        user_uid    VARCHAR(128)  DEFAULT NULL,
        ip          VARCHAR(45)   NOT NULL,
        action      VARCHAR(30)   NOT NULL
                        CHECK (action IN ('register_attempt','register_success','login_attempt','login_success','login_blocked')),
        provider    VARCHAR(50)   NOT NULL,
        meta        JSONB         DEFAULT NULL,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_auth_device_sessions_device_id  ON auth_device_sessions (device_id)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_device_sessions_user_uid   ON auth_device_sessions (user_uid)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_device_sessions_action     ON auth_device_sessions (action)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_device_sessions_created_at ON auth_device_sessions (created_at)`,

    // ── Groupes WhatsApp créés par les tenants ────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_groups (
        id                       VARCHAR(36)   NOT NULL,
        tenant_id                VARCHAR(36)   NOT NULL,
        wa_group_jid             VARCHAR(60)   NOT NULL,
        name                     VARCHAR(150)  NOT NULL,
        invite_code              VARCHAR(50)   DEFAULT NULL,
        invite_code_generated_at TIMESTAMPTZ   DEFAULT NULL,
        participants_count       INTEGER       NOT NULL DEFAULT 0,
        status                   VARCHAR(10)   NOT NULL DEFAULT 'active'
                                     CHECK (status IN ('active','deleted')),
        created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, name),
        UNIQUE (tenant_id, wa_group_jid),
        CONSTRAINT fk_wa_groups_tenant FOREIGN KEY (tenant_id) REFERENCES wa_tenants(id) ON DELETE CASCADE
    )`,

    `CREATE INDEX IF NOT EXISTS idx_wa_groups_tenant ON wa_groups (tenant_id)`,

    // ── Journal des messages envoyés par les tenants ──────────────────────────
    `CREATE TABLE IF NOT EXISTS wa_messages (
        id             VARCHAR(36)   NOT NULL,
        tenant_id      VARCHAR(36)   NOT NULL,
        to_jid         VARCHAR(60)   NOT NULL,
        to_type        VARCHAR(10)   NOT NULL DEFAULT 'contact'
                           CHECK (to_type IN ('contact','group')),
        message        TEXT          DEFAULT NULL,
        has_media      BOOLEAN       NOT NULL DEFAULT FALSE,
        media_type     VARCHAR(20)   DEFAULT NULL
                           CHECK (media_type IS NULL OR media_type IN ('image','video','audio','document')),
        status         VARCHAR(10)   NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','sent','delivered','failed')),
        error_code     VARCHAR(50)   DEFAULT NULL,
        error_message  TEXT          DEFAULT NULL,
        wa_message_id  VARCHAR(100)  DEFAULT NULL,
        created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        sent_at        TIMESTAMPTZ   DEFAULT NULL,
        updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        CONSTRAINT fk_wa_messages_tenant FOREIGN KEY (tenant_id) REFERENCES wa_tenants(id) ON DELETE CASCADE
    )`,

    `CREATE INDEX IF NOT EXISTS idx_wa_messages_tenant     ON wa_messages (tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_messages_status     ON wa_messages (status)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_messages_created_at ON wa_messages (created_at)`,

    // ── Administrateurs Convessa (backoffice) ─────────────────────────────────
    `CREATE TABLE IF NOT EXISTS convessa_admins (
        id            SERIAL        PRIMARY KEY,
        email         VARCHAR(255)  NOT NULL,
        display_name  VARCHAR(100)  DEFAULT NULL,
        password_hash VARCHAR(200)  NOT NULL,
        active        BOOLEAN       NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ   DEFAULT NULL,
        UNIQUE (email)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_convessa_admins_active ON convessa_admins (active)`,

    // ── Codes de parrainage ───────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS referral_codes (
        id            VARCHAR(36)   NOT NULL,
        code          VARCHAR(12)   NOT NULL,
        unlimited     BOOLEAN       NOT NULL DEFAULT FALSE,
        usage_type    VARCHAR(10)   DEFAULT NULL
                          CHECK (usage_type IS NULL OR usage_type IN ('duration','requests')),
        usage_value   INTEGER       DEFAULT NULL,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        UNIQUE (code)
    )`,

    // ── Plans d'abonnement ────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS subscription_plans (
        id            VARCHAR(36)   NOT NULL,
        name          VARCHAR(100)  NOT NULL,
        price         INTEGER       NOT NULL DEFAULT 0,
        unlimited     BOOLEAN       NOT NULL DEFAULT FALSE,
        usage_type    VARCHAR(10)   DEFAULT NULL
                          CHECK (usage_type IS NULL OR usage_type IN ('duration','requests')),
        usage_value   INTEGER       DEFAULT NULL,
        description   TEXT          DEFAULT NULL,
        features      JSONB         DEFAULT NULL,
        is_popular    BOOLEAN       NOT NULL DEFAULT FALSE,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id)
    )`,

    // ── Paiements d'abonnement ────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS subscription_payments (
        id              VARCHAR(36)   NOT NULL,
        tenant_id       VARCHAR(36)   NOT NULL,
        plan_id         VARCHAR(36)   NOT NULL,
        gateway         VARCHAR(10)   NOT NULL CHECK (gateway IN ('fedapay','kkiapay')),
        gateway_tx_id   VARCHAR(255)  DEFAULT NULL,
        amount          INTEGER       NOT NULL,
        currency        VARCHAR(10)   NOT NULL DEFAULT 'XOF',
        status          VARCHAR(10)   NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','success','failed','cancelled')),
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        CONSTRAINT fk_payments_tenant FOREIGN KEY (tenant_id) REFERENCES wa_tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_payments_plan   FOREIGN KEY (plan_id)   REFERENCES subscription_plans(id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_sub_payments_tenant     ON subscription_payments (tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_payments_plan       ON subscription_payments (plan_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_payments_status     ON subscription_payments (status)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_payments_gateway_tx ON subscription_payments (gateway_tx_id)`,
]

export async function runMigrations(): Promise<void> {
    for (const sql of TABLES) {
        await query(sql)
    }

    // Au redémarrage : tout message bloqué en 'sending' → remis en 'queued'
    const result = await query<{ count: string }>(
        `UPDATE wa_message_queue SET status = 'queued' WHERE status = 'sending' RETURNING id`
    )
    if (result.length > 0) {
        logger.warn({ component: 'DB', count: result.length }, `${result.length} message(s) remis en file`)
    }

    logger.info({ component: 'DB' }, 'Migrations PostgreSQL OK — tables vérifiées')
}

// helper exposé pour les stores
export { query }
