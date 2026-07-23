/**
 * SessionStore.ts — Persistance des sessions Baileys en MySQL.
 *
 * Stratégie :
 * - Les credentials (creds) sont stockés chiffrés en base — ils suffisent
 *   pour restaurer une session existante après redémarrage.
 * - Les clés Signal (pre-keys, sessions Signal) sont gérées en mémoire
 *   par Baileys lui-même via un Map interne. Elles sont régénérées
 *   automatiquement si absentes (premier démarrage ou session expirée).
 * - Cette approche est identique à useMultiFileAuthState mais sans fichiers.
 */

import type {
    AuthenticationCreds,
    AuthenticationState,
    SignalDataTypeMap,
    SignalDataSet,
} from '@whiskeysockets/baileys'
import { initAuthCreds, BufferJSON, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys'
import { getPool }           from './connection.js'
import { encrypt, decrypt }  from '../services/crypto.js'
import { config }            from '../config.js'
import { logger, maskPhone } from '../services/logger.js'
import type mysql from 'mysql2/promise'

export type SessionStatus = 'active' | 'disconnected' | 'revoked'

export interface SessionMeta {
    phone?:       string
    displayName?: string
}

interface SessionRow {
    creds_iv:   string
    creds_tag:  string
    creds_data: string
    status:     SessionStatus
}

// ── Auth State compatible Baileys ──────────────────────────────────────────────

export async function useDbAuthState(sessionId: string): Promise<{
    state:     AuthenticationState
    saveCreds: () => Promise<void>
}> {
    const pool = getPool()

    // ── Lecture des credentials ────────────────────────────────────────────────
    async function readCreds(): Promise<AuthenticationCreds> {
        const [rows] = await pool.execute<SessionRow[] & mysql.RowDataPacket[]>(
            'SELECT creds_iv, creds_tag, creds_data FROM wa_sessions WHERE id = ?',
            [sessionId]
        )

        const row = rows[0]
        if (!row) {
            logger.info({ component: 'SessionStore', sessionId }, 'Aucune session — initialisation')
            return initAuthCreds()
        }

        try {
            const json = decrypt(
                { iv: row.creds_iv, tag: row.creds_tag, data: row.creds_data },
                config.sessionEncryptionKey
            )
            const creds = JSON.parse(json, BufferJSON.reviver) as AuthenticationCreds
            logger.info({ component: 'SessionStore', sessionId, registered: creds.registered }, 'Session restaurée depuis la base')
            return creds
        } catch (err) {
            logger.error({ component: 'SessionStore', err }, 'Credentials corrompus — réinitialisation')
            return initAuthCreds()
        }
    }

    // ── Sauvegarde des credentials ─────────────────────────────────────────────
    async function saveCreds(): Promise<void> {
        const json    = JSON.stringify(state.creds, BufferJSON.replacer)
        const payload = encrypt(json, config.sessionEncryptionKey)

        await pool.execute(
            `INSERT INTO wa_sessions (id, creds_iv, creds_tag, creds_data, status)
             VALUES (?, ?, ?, ?, 'disconnected')
             ON DUPLICATE KEY UPDATE
               creds_iv   = VALUES(creds_iv),
               creds_tag  = VALUES(creds_tag),
               creds_data = VALUES(creds_data),
               updated_at = CURRENT_TIMESTAMP`,
            [sessionId, payload.iv, payload.tag, payload.data]
        )
    }

    // ── Keys store — géré en mémoire (Map) ────────────────────────────────────
    // Baileys régénère les pre-keys Signal automatiquement.
    // On utilise un Map en mémoire exactement comme useMultiFileAuthState.
    const KEY_MAP: Map<string, Record<string, unknown>> = new Map()

    const keys: AuthenticationState['keys'] = {
        get: async <T extends keyof SignalDataTypeMap>(
            type: T,
            ids: string[]
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
            const store = KEY_MAP.get(type) ?? {}
            const result: Record<string, SignalDataTypeMap[T]> = {}
            for (const id of ids) {
                const val = store[id]
                if (val !== undefined) {
                    result[id] = val as SignalDataTypeMap[T]
                }
            }
            return result
        },

        set: async (data: SignalDataSet) => {
            for (const [type, typeData] of Object.entries(data)) {
                const store = KEY_MAP.get(type) ?? {}
                for (const [id, val] of Object.entries(typeData as Record<string, unknown>)) {
                    if (val !== null && val !== undefined) {
                        store[id] = val
                    } else {
                        delete store[id]
                    }
                }
                KEY_MAP.set(type, store)
            }
        },
    }

    const creds = await readCreds()
    const state: AuthenticationState = { creds, keys }

    return { state, saveCreds }
}

// ── Fonctions utilitaires ──────────────────────────────────────────────────────

export async function updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    meta?: SessionMeta
): Promise<void> {
    const pool = getPool()

    await pool.execute(
        `UPDATE wa_sessions
         SET status       = ?,
             phone        = COALESCE(?, phone),
             display_name = COALESCE(?, display_name),
             connected_at = CASE WHEN ? = 'active' THEN CURRENT_TIMESTAMP ELSE connected_at END,
             updated_at   = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, meta?.phone ?? null, meta?.displayName ?? null, status, sessionId]
    )

    if (meta?.phone) {
        logger.info(
            { component: 'SessionStore', sessionId, status, phone: maskPhone(meta.phone) },
            `Session ${status}`
        )
    }
}

export async function deleteSession(sessionId: string): Promise<void> {
    const pool = getPool()
    await pool.execute('DELETE FROM wa_session_keys WHERE session_id = ?', [sessionId])
    await pool.execute('DELETE FROM wa_sessions WHERE id = ?', [sessionId])
    logger.info({ component: 'SessionStore', sessionId }, 'Session supprimée')
}

export async function hasActiveSession(sessionId: string): Promise<boolean> {
    const pool   = getPool()
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        "SELECT id FROM wa_sessions WHERE id = ? AND status = 'active' LIMIT 1",
        [sessionId]
    )
    return (rows as unknown[]).length > 0
}
