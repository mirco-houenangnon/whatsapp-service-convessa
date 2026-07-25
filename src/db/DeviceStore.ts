

import { getPool }  from './connection.js'
import { logger }   from '../services/logger.js'
import { createHash } from 'crypto'
import type mysql   from 'mysql2/promise'
import type { Request } from 'express'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DeviceFingerprint {
    /** Hash SHA-256 de la combinaison des champs stables */
    fingerprintHash: string
    /** IP du client (v4 ou v6) */
    ip:              string
    /** User-Agent complet */
    userAgent:       string | null
    /** Langue navigateur (Accept-Language header) */
    acceptLanguage:  string | null
    /** Informations complémentaires passées par le client (optionnel) */
    clientHints?:    Record<string, string>
}

export interface DeviceRow {
    id:               number
    fingerprint_hash: string
    first_ip:         string
    user_agent:       string | null
    accept_language:  string | null
    client_hints:     string | null   // JSON string
    first_seen_at:    Date
    last_seen_at:     Date
    blocked:          boolean
    blocked_reason:   string | null
    registered_uid:   string | null   // FK auth_users.uid si inscrit
}

export interface DeviceSessionRow {
    id:              number
    device_id:       number
    user_uid:        string | null
    ip:              string
    action:          'register_attempt' | 'register_success' | 'login_attempt' | 'login_success' | 'login_blocked'
    provider:        string
    meta:            string | null   // JSON string
    created_at:      Date
}

// ── Extraction de l'empreinte depuis la requête Express ───────────────────────

/**
 * Extrait le maximum d'informations depuis la requête HTTP.
 * Calcule un hash stable basé sur les champs les plus discriminants.
 */
export function extractFingerprint(req: Request, extraClientData?: Record<string, string>): DeviceFingerprint {

    // Machine hash envoyé par le frontend (canvas + WebGL + screen + timezone + GPU)
    // Stable entre navigateurs sur la même machine
    const machineHash = req.headers['x-machine-hash']?.toString()?.trim() ?? null

    const ip            = getClientIp(req)
    const userAgent     = req.headers['user-agent']?.slice(0, 512)     ?? null
    const acceptLang    = req.headers['accept-language']?.slice(0, 128) ?? null
    const acceptEnc     = req.headers['accept-encoding']?.slice(0, 128) ?? null

    // Sec-CH headers (client hints — navigateurs modernes)
    const chPlatform    = req.headers['sec-ch-ua-platform']?.toString()          ?? null
    const chMobile      = req.headers['sec-ch-ua-mobile']?.toString()            ?? null
    const chBrowser     = req.headers['sec-ch-ua']?.toString()?.slice(0, 256)    ?? null
    const chArch        = req.headers['sec-ch-ua-arch']?.toString()              ?? null

    const clientHints: Record<string, string> = {}
    if (chPlatform) clientHints['platform'] = chPlatform
    if (chMobile)   clientHints['mobile']   = chMobile
    if (chBrowser)  clientHints['browser']  = chBrowser
    if (chArch)     clientHints['arch']     = chArch
    if (machineHash) clientHints['machineHash'] = machineHash
    if (extraClientData) Object.assign(clientHints, extraClientData)

    // Si le frontend a envoyé un machine hash (cross-browser fingerprint),
    // on l'utilise directement comme fingerprintHash — c'est le signal le plus
    // fiable car basé sur GPU/canvas/écran/timezone, stable entre navigateurs.
    // Sinon, fallback sur les headers HTTP (moins stable entre navigateurs).
    let fingerprintHash: string
    if (machineHash && /^[0-9a-f]{16,}$/i.test(machineHash)) {
        fingerprintHash = machineHash
    } else {
        const fingerprintSource = [
            userAgent  ?? '',
            acceptLang ?? '',
            acceptEnc  ?? '',
            chPlatform ?? '',
            chMobile   ?? '',
            chBrowser  ?? '',
            chArch     ?? '',
        ].join('|')

        fingerprintHash = createHash('sha256')
            .update(fingerprintSource)
            .digest('hex')
    }

    return {
        fingerprintHash,
        ip,
        userAgent,
        acceptLanguage: acceptLang,
        clientHints: Object.keys(clientHints).length > 0 ? clientHints : undefined,
    }
}

/** Résout l'IP réelle du client (supporte reverse proxy) */
function getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string') {
        return forwarded.split(',')[0]?.trim() ?? req.ip ?? '0.0.0.0'
    }
    return req.ip ?? req.socket?.remoteAddress ?? '0.0.0.0'
}

// ── Lookup / création de l'appareil ──────────────────────────────────────────

/**
 * Récupère ou crée un enregistrement d'appareil.
 * Retourne l'appareil et un flag `isNew`.
 */
export async function upsertDevice(fp: DeviceFingerprint): Promise<{ device: DeviceRow; isNew: boolean }> {
    const pool = getPool()

    // Chercher par fingerprint hash
    const [existing] = await pool.execute<DeviceRow[] & mysql.RowDataPacket[]>(
        `SELECT * FROM auth_devices WHERE fingerprint_hash = ? LIMIT 1`,
        [fp.fingerprintHash]
    )

    if (existing[0]) {
        // Mettre à jour last_seen_at et IP
        await pool.execute(
            `UPDATE auth_devices SET last_seen_at = NOW(), first_ip = ? WHERE fingerprint_hash = ?`,
            [fp.ip, fp.fingerprintHash]
        )
        return { device: existing[0], isNew: false }
    }

    // Créer l'appareil
    const hintsJson = fp.clientHints ? JSON.stringify(fp.clientHints) : null

    const [result] = await pool.execute<mysql.OkPacket>(
        `INSERT INTO auth_devices
            (fingerprint_hash, first_ip, user_agent, accept_language, client_hints, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
        [fp.fingerprintHash, fp.ip, fp.userAgent, fp.acceptLanguage, hintsJson]
    )

    const insertId = (result as { insertId: number }).insertId

    const [newRow] = await pool.execute<DeviceRow[] & mysql.RowDataPacket[]>(
        `SELECT * FROM auth_devices WHERE id = ? LIMIT 1`,
        [insertId]
    )

    logger.info(
        { component: 'DeviceStore', fingerprintHash: fp.fingerprintHash.slice(0, 12) + '...', ip: fp.ip },
        'Nouvel appareil enregistré'
    )

    return { device: newRow[0]!, isNew: true }
}

/**
 * Lie un appareil à un utilisateur inscrit.
 */
export async function linkDeviceToUser(deviceId: number, userUid: string): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE auth_devices SET registered_uid = ? WHERE id = ?`,
        [userUid, deviceId]
    )
}

/**
 * Vérifie si un appareil est bloqué.
 */
export async function isDeviceBlocked(fingerprintHash: string): Promise<{ blocked: boolean; reason: string | null }> {
    const pool = getPool()

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT blocked, blocked_reason FROM auth_devices WHERE fingerprint_hash = ? LIMIT 1`,
        [fingerprintHash]
    )

    const row = rows[0] as { blocked: number; blocked_reason: string | null } | undefined
    if (!row) return { blocked: false, reason: null }

    return {
        blocked: Boolean(row.blocked),
        reason:  row.blocked_reason,
    }
}

/**
 * Vérifie si un appareil est déjà lié à un compte enregistré.
 * Retourne l'UID si oui, null sinon.
 */
export async function getDeviceRegisteredUid(fingerprintHash: string): Promise<string | null> {
    const pool = getPool()

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT registered_uid FROM auth_devices WHERE fingerprint_hash = ? LIMIT 1`,
        [fingerprintHash]
    )

    const row = rows[0] as { registered_uid: string | null } | undefined
    return row?.registered_uid ?? null
}

// ── Journalisation des sessions ───────────────────────────────────────────────

/**
 * Enregistre une entrée de session (tentative ou succès).
 */
export async function logDeviceSession(data: {
    deviceId:  number
    userUid:   string | null
    ip:        string
    action:    DeviceSessionRow['action']
    provider:  string
    meta?:     Record<string, unknown>
}): Promise<void> {
    const pool = getPool()

    await pool.execute(
        `INSERT INTO auth_device_sessions
            (device_id, user_uid, ip, action, provider, meta)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            data.deviceId,
            data.userUid,
            data.ip,
            data.action,
            data.provider,
            data.meta ? JSON.stringify(data.meta) : null,
        ]
    )
}

/**
 * Récupère l'historique des sessions d'un appareil (pour le backoffice admin).
 */
export async function getDeviceSessions(deviceId: number, limit = 20): Promise<DeviceSessionRow[]> {
    const pool = getPool()

    const [rows] = await pool.execute<DeviceSessionRow[] & mysql.RowDataPacket[]>(
        `SELECT * FROM auth_device_sessions WHERE device_id = ? ORDER BY created_at DESC LIMIT ?`,
        [deviceId, limit]
    )

    return rows
}
