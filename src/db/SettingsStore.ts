/**
 * SettingsStore.ts — Paramètres applicatifs clé/valeur — MySQL.
 *
 * Utilisé notamment pour stocker le JID du groupe WhatsApp admin dédié aux
 * notifications "Messages depuis Contact", créé depuis le backoffice.
 */

import { query, execute } from './connection.js'

/** Clé app_settings pour le JID du groupe WhatsApp admin "Messages depuis Contact". */
export const ADMIN_CONTACT_GROUP_KEY = 'admin_contact_group_jid'

interface SettingRow { setting_key: string; setting_value: string | null; updated_at: Date }

export async function getSetting(key: string): Promise<string | null> {
    const rows = await query<SettingRow>('SELECT setting_value FROM app_settings WHERE setting_key = ?', [key])
    return rows[0]?.setting_value ?? null
}

export async function setSetting(key: string, value: string | null): Promise<void> {
    await execute(
        `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, value]
    )
}

export async function deleteSetting(key: string): Promise<void> {
    await execute('DELETE FROM app_settings WHERE setting_key = ?', [key])
}
