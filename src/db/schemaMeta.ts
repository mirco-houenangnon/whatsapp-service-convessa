/**
 * schemaMeta.ts — Whitelist des tables/colonnes exposées au DB Browser admin.
 *
 * IMPORTANT SÉCURITÉ : AdminDbStore n'exécute jamais de SQL avec un nom de
 * table/colonne venant directement de la requête HTTP. Tout identifiant est
 * validé contre ce dictionnaire avant d'être interpolé dans une requête.
 * Les valeurs sont toujours passées en paramètres préparés (placeholders `?`).
 */

export type ColType = 'text' | 'number' | 'boolean' | 'date' | 'json'

export interface ColumnMeta {
    name:       string
    type:       ColType
    /** Colonne sensible : jamais renvoyée en clair, jamais éditable via l'UI générique. */
    sensitive?: boolean
    /** Valeur générée par la base (AUTO_INCREMENT/DEFAULT) — masquée à la création. */
    generated?: boolean
    /** Colonne obligatoire à la création. */
    required?:  boolean
}

export interface TableMeta {
    name:    string
    label:   string
    /** Colonnes formant la clé primaire (ordre important pour les PK composites). */
    pk:      string[]
    columns: ColumnMeta[]
    /** Colonne utilisée pour la recherche texte libre. */
    searchable?: string[]
    /** Colonne de tri par défaut. */
    defaultSort?: string
}

export const SCHEMA: Record<string, TableMeta> = {
    auth_users: {
        name: 'auth_users', label: 'Utilisateurs (auth)', pk: ['uid'],
        searchable: ['uid', 'email', 'display_name', 'phone'], defaultSort: 'created_at',
        columns: [
            { name: 'uid', type: 'text', required: true },
            { name: 'email', type: 'text' },
            { name: 'display_name', type: 'text' },
            { name: 'photo_url', type: 'text' },
            { name: 'provider', type: 'text', required: true },
            { name: 'phone', type: 'text' },
            { name: 'active', type: 'boolean' },
            { name: 'created_at', type: 'date', generated: true },
            { name: 'last_login_at', type: 'date' },
        ],
    },
    auth_otp_codes: {
        name: 'auth_otp_codes', label: 'Codes OTP', pk: ['phone'],
        searchable: ['phone'], defaultSort: 'created_at',
        columns: [
            { name: 'phone', type: 'text', required: true },
            { name: 'code_hash', type: 'text', sensitive: true },
            { name: 'expires_at', type: 'date', required: true },
            { name: 'attempts', type: 'number' },
            { name: 'verified', type: 'boolean' },
            { name: 'created_at', type: 'date', generated: true },
        ],
    },
    wa_tenants: {
        name: 'wa_tenants', label: 'Tenants WhatsApp', pk: ['id'],
        searchable: ['id', 'user_uid', 'phone', 'name'], defaultSort: 'created_at',
        columns: [
            { name: 'id', type: 'text', required: true },
            { name: 'user_uid', type: 'text' },
            { name: 'phone', type: 'text' },
            { name: 'name', type: 'text' },
            { name: 'api_key_hash', type: 'text', sensitive: true },
            { name: 'api_key_hint', type: 'text' },
            { name: 'api_key_enc', type: 'text', sensitive: true },
            { name: 'api_key_iv', type: 'text', sensitive: true },
            { name: 'api_key_tag', type: 'text', sensitive: true },
            { name: 'api_key_expires_at', type: 'date' },
            { name: 'webhook_url', type: 'text' },
            { name: 'status', type: 'text' },
            { name: 'usage_type', type: 'text' },
            { name: 'messages_limit', type: 'number' },
            { name: 'messages_sent', type: 'number' },
            { name: 'referral_code', type: 'text' },
            { name: 'connected_at', type: 'date' },
            { name: 'created_at', type: 'date', generated: true },
            { name: 'updated_at', type: 'date', generated: true },
        ],
    },
    wa_sessions: {
        name: 'wa_sessions', label: 'Sessions Baileys', pk: ['id'],
        searchable: ['id', 'phone', 'display_name'], defaultSort: 'created_at',
        columns: [
            { name: 'id', type: 'text', required: true },
            { name: 'creds_iv', type: 'text', sensitive: true },
            { name: 'creds_tag', type: 'text', sensitive: true },
            { name: 'creds_data', type: 'text', sensitive: true },
            { name: 'phone', type: 'text' },
            { name: 'display_name', type: 'text' },
            { name: 'status', type: 'text' },
            { name: 'connected_at', type: 'date' },
            { name: 'created_at', type: 'date', generated: true },
            { name: 'updated_at', type: 'date', generated: true },
        ],
    },
    wa_session_keys: {
        name: 'wa_session_keys', label: 'Clés Signal (sessions)', pk: ['session_id', 'key_type', 'key_id'],
        searchable: ['session_id', 'key_type', 'key_id'], defaultSort: 'updated_at',
        columns: [
            { name: 'session_id', type: 'text', required: true },
            { name: 'key_type', type: 'text', required: true },
            { name: 'key_id', type: 'text', required: true },
            { name: 'key_value', type: 'text', sensitive: true },
            { name: 'created_at', type: 'date', generated: true },
            { name: 'updated_at', type: 'date', generated: true },
        ],
    },
    wa_message_queue: {
        name: 'wa_message_queue', label: "File d'attente messages", pk: ['id'],
        searchable: ['id', 'tenant_id', 'recipient'], defaultSort: 'queued_at',
        columns: [
            { name: 'id', type: 'text', required: true },
            { name: 'tenant_id', type: 'text' },
            { name: 'recipient', type: 'text', required: true },
            { name: 'jid', type: 'text' },
            { name: 'message', type: 'text' },
            { name: 'media_type', type: 'text' },
            { name: 'media_url', type: 'text' },
            { name: 'media_b64', type: 'text', sensitive: true },
            { name: 'media_mime', type: 'text' },
            { name: 'media_name', type: 'text' },
            { name: 'status', type: 'text' },
            { name: 'attempts', type: 'number' },
            { name: 'last_error', type: 'text' },
            { name: 'queued_at', type: 'date', generated: true },
            { name: 'sent_at', type: 'date' },
        ],
    },
    wa_logs: {
        name: 'wa_logs', label: "Journal d'activité", pk: ['id'],
        searchable: ['component', 'message'], defaultSort: 'created_at',
        columns: [
            { name: 'id', type: 'number', generated: true },
            { name: 'level', type: 'text', required: true },
            { name: 'component', type: 'text', required: true },
            { name: 'message', type: 'text', required: true },
            { name: 'context', type: 'json' },
            { name: 'created_at', type: 'date', generated: true },
        ],
    },
    auth_devices: {
        name: 'auth_devices', label: 'Appareils', pk: ['id'],
        searchable: ['fingerprint_hash', 'first_ip', 'registered_uid'], defaultSort: 'last_seen_at',
        columns: [
            { name: 'id', type: 'number', generated: true },
            { name: 'fingerprint_hash', type: 'text', required: true },
            { name: 'first_ip', type: 'text', required: true },
            { name: 'user_agent', type: 'text' },
            { name: 'accept_language', type: 'text' },
            { name: 'client_hints', type: 'json' },
            { name: 'first_seen_at', type: 'date', generated: true },
            { name: 'last_seen_at', type: 'date' },
            { name: 'blocked', type: 'boolean' },
            { name: 'blocked_reason', type: 'text' },
            { name: 'registered_uid', type: 'text' },
        ],
    },
    auth_device_sessions: {
        name: 'auth_device_sessions', label: 'Journal de sécurité', pk: ['id'],
        searchable: ['user_uid', 'ip', 'action'], defaultSort: 'created_at',
        columns: [
            { name: 'id', type: 'number', generated: true },
            { name: 'device_id', type: 'number', required: true },
            { name: 'user_uid', type: 'text' },
            { name: 'ip', type: 'text', required: true },
            { name: 'action', type: 'text', required: true },
            { name: 'provider', type: 'text', required: true },
            { name: 'meta', type: 'json' },
            { name: 'created_at', type: 'date', generated: true },
        ],
    },
    wa_groups: {
        name: 'wa_groups', label: 'Groupes WhatsApp', pk: ['id'],
        searchable: ['id', 'tenant_id', 'name', 'wa_group_jid'], defaultSort: 'created_at',
        columns: [
            { name: 'id', type: 'text', required: true },
            { name: 'tenant_id', type: 'text', required: true },
            { name: 'wa_group_jid', type: 'text', required: true },
            { name: 'name', type: 'text', required: true },
            { name: 'invite_code', type: 'text' },
            { name: 'invite_code_generated_at', type: 'date' },
            { name: 'participants_count', type: 'number' },
            { name: 'status', type: 'text' },
            { name: 'created_at', type: 'date', generated: true },
            { name: 'updated_at', type: 'date', generated: true },
        ],
    },
    wa_messages: {
        name: 'wa_messages', label: 'Messages envoyés', pk: ['id'],
        searchable: ['id', 'tenant_id', 'to_jid', 'wa_message_id'], defaultSort: 'created_at',
        columns: [
            { name: 'id', type: 'text', required: true },
            { name: 'tenant_id', type: 'text', required: true },
            { name: 'to_jid', type: 'text', required: true },
            { name: 'to_type', type: 'text' },
            { name: 'message', type: 'text' },
            { name: 'has_media', type: 'boolean' },
            { name: 'media_type', type: 'text' },
            { name: 'status', type: 'text' },
            { name: 'error_code', type: 'text' },
            { name: 'error_message', type: 'text' },
            { name: 'wa_message_id', type: 'text' },
            { name: 'created_at', type: 'date', generated: true },
            { name: 'sent_at', type: 'date' },
            { name: 'updated_at', type: 'date', generated: true },
        ],
    },
    convessa_admins: {
        name: 'convessa_admins', label: 'Administrateurs', pk: ['id'],
        searchable: ['email', 'display_name'], defaultSort: 'created_at',
        columns: [
            { name: 'id', type: 'number', generated: true },
            { name: 'email', type: 'text', required: true },
            { name: 'display_name', type: 'text' },
            { name: 'password_hash', type: 'text', sensitive: true },
            { name: 'active', type: 'boolean' },
            { name: 'created_at', type: 'date', generated: true },
            { name: 'updated_at', type: 'date', generated: true },
            { name: 'last_login_at', type: 'date' },
        ],
    },
    referral_codes: {
        name: 'referral_codes', label: 'Codes de parrainage', pk: ['id'],
        searchable: ['id', 'code'], defaultSort: 'created_at',
        columns: [
            { name: 'id', type: 'text', required: true },
            { name: 'code', type: 'text', required: true },
            { name: 'unlimited', type: 'boolean' },
            { name: 'usage_type', type: 'text' },
            { name: 'usage_value', type: 'number' },
            { name: 'created_at', type: 'date', generated: true },
        ],
    },
    subscription_plans: {
        name: 'subscription_plans', label: "Plans d'abonnement", pk: ['id'],
        searchable: ['id', 'name'], defaultSort: 'created_at',
        columns: [
            { name: 'id', type: 'text', required: true },
            { name: 'name', type: 'text', required: true },
            { name: 'price', type: 'number' },
            { name: 'unlimited', type: 'boolean' },
            { name: 'usage_type', type: 'text' },
            { name: 'usage_value', type: 'number' },
            { name: 'description', type: 'text' },
            { name: 'features', type: 'json' },
            { name: 'is_popular', type: 'boolean' },
            { name: 'created_at', type: 'date', generated: true },
        ],
    },
    subscription_payments: {
        name: 'subscription_payments', label: 'Paiements', pk: ['id'],
        searchable: ['id', 'tenant_id', 'plan_id', 'gateway_tx_id'], defaultSort: 'created_at',
        columns: [
            { name: 'id', type: 'text', required: true },
            { name: 'tenant_id', type: 'text', required: true },
            { name: 'plan_id', type: 'text', required: true },
            { name: 'gateway', type: 'text', required: true },
            { name: 'gateway_tx_id', type: 'text' },
            { name: 'amount', type: 'number', required: true },
            { name: 'currency', type: 'text' },
            { name: 'status', type: 'text' },
            { name: 'created_at', type: 'date', generated: true },
            { name: 'updated_at', type: 'date', generated: true },
        ],
    },
}

export function getTableMeta(name: string): TableMeta | null {
    return Object.prototype.hasOwnProperty.call(SCHEMA, name) ? SCHEMA[name]! : null
}

export function listTablesMeta(): TableMeta[] {
    return Object.values(SCHEMA)
}

/** Masque les colonnes sensibles d'une ligne avant de la renvoyer au client. */
export function maskSensitive<T extends Record<string, unknown>>(table: TableMeta, row: T): T {
    const out = { ...row }
    for (const col of table.columns) {
        if (col.sensitive && out[col.name] !== undefined && out[col.name] !== null) {
            ;(out as Record<string, unknown>)[col.name] = '••••••••'
        }
    }
    return out
}
