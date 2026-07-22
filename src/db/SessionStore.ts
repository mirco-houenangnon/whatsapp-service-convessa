/**
 * SessionStore.ts — Persistance des sessions Baileys en MySQL.
 *
 * Remplace useMultiFileAuthState (stockage fichiers) par un stockage
 * chiffré en base de données. Les credentials sont chiffrés avec AES-256-GCM
 * avant insertion et déchiffrés à la lecture.
 */

import type {
    AuthenticationCreds,
    AuthenticationState,
    SignalDataTypeMap,
} from '@whiskeysockets/baileys'
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys'
import { getPool }  from './connection.js'
import { encrypt, decrypt } from '../services/crypto.js'
import { config }   from '../config.js'
import { logger }   from '../services/logger.js'
import { maskPhone } from '../services/logger.js'

export type SessionStatus = 'active' | 'disconnected' | 'revoked'

export interface SessionMeta {
    phone?:       string
    displayName?: string
    connectedAt?: Date
}

interface SessionRow {
    id:           string
    creds_iv:     string
    creds_tag:    string
    creds_data:   string
    phone:        string | null
    display_name: string | null
    status:       SessionStatus
    connected_at: Date | null
}

/**
 * Retourne un objet AuthState compatible Baileys, qui lit/écrit en MySQL.
 */
export async function useDbAuthState(sessionId: string): Promise<{
    state:     AuthenticationState
    saveCreds: () => Promise<void>
}> {
    const pool = getPool()

    // ── Lecture initiale des credentials ──────────────────────────────────────
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
            return JSON.parse(json, BufferJSON.reviver) as AuthenticationCreds
        } catch (err) {
            logger.error({ component: 'SessionStore', err }, 'Credentials corrompus — réinitialisation')
            return initAuthCreds()
        }
    }

    // ── Sauvegarde des credentials ────────────────────────────────────────────
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

    // ── Keys store (clés de chiffrement Signal) ───────────────────────────────
    // Baileys utilise un store de clés Signal pour le chiffrement de bout en bout.
    // On stocke ces clés dans les credentials eux-mêmes (simplification acceptable
    // pour un usage mono-session).

    const keys: AuthenticationState['keys'] = {
        get: async <T extends keyof SignalDataTypeMap>(
            type: T,
            ids: string[]
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
            const data = (state.creds as unknown as Record<string, unknown>)[`key_${type}`] as
                | Record<string, unknown>
                | undefined

            const result: Record<string, SignalDataTypeMap[T]> = {}
            if (data) {
                for (const id of ids) {
                    const val = data[id]
                    if (val !== undefined) {
                        // proto.Message n'a pas besoin de conversion spéciale ici
                        result[id] = val as SignalDataTypeMap[T]
                    }
                }
            }
            return result
        },

        set: async (data: Record<string, unknown>) => {
            const creds = state.creds as unknown as Record<string, unknown>
            for (const [type, typeData] of Object.entries(data)) {
                if (!creds[`key_${type}`]) {
                    creds[`key_${type}`] = {}
                }
                const keyStore = creds[`key_${type}`] as Record<string, unknown>
                for (const [id, val] of Object.entries(typeData as Record<string, unknown>)) {
                    if (val !== null && val !== undefined) {
                        keyStore[id] = val
                    } else {
                        delete keyStore[id]
                    }
                }
            }
            await saveCreds()
        },
    }

    const creds = await readCreds()
    const state: AuthenticationState = { creds, keys }

    return { state, saveCreds }
}

/**
 * Met à jour le statut et les métadonnées d'une session.
 */
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

/**
 * Supprime complètement une session de la base.
 */
export async function deleteSession(sessionId: string): Promise<void> {
    const pool = getPool()
    await pool.execute('DELETE FROM wa_sessions WHERE id = ?', [sessionId])
    logger.info({ component: 'SessionStore', sessionId }, 'Session supprimée')
}

/**
 * Vérifie si une session active existe en base.
 */
export async function hasActiveSession(sessionId: string): Promise<boolean> {
    const pool = getPool()
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        "SELECT id FROM wa_sessions WHERE id = ? AND status = 'active' LIMIT 1",
        [sessionId]
    )
    return (rows as unknown[]).length > 0
}

import type mysql from 'mysql2/promise'
