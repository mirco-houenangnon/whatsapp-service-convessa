/**
 * DeviceStore.ts — Empreintes client — MySQL.
 */

import { query, execute }  from './connection.js'
import { logger }          from '../services/logger.js'
import { createHash }      from 'crypto'
import type { Request }    from 'express'

export interface DeviceFingerprint {
    fingerprintHash: string
    ip:              string
    userAgent:       string | null
    acceptLanguage:  string | null
    clientHints?:    Record<string, string>
}

export interface DeviceRow {
    id:               number
    fingerprint_hash: string
    first_ip:         string
    user_agent:       string | null
    accept_language:  string | null
    client_hints:     string | null
    first_seen_at:    Date
    last_seen_at:     Date
    blocked:          boolean
    blocked_reason:   string | null
    registered_uid:   string | null
}

export interface DeviceSessionRow {
    id:         number
    device_id:  number
    user_uid:   string | null
    ip:         string
    action:     'register_attempt' | 'register_success' | 'login_attempt' | 'login_success' | 'login_blocked'
    provider:   string
    meta:       string | null
    created_at: Date
}

export function extractFingerprint(req: Request, extraClientData?: Record<string, string>): DeviceFingerprint {
    const machineHash  = req.headers['x-machine-hash']?.toString()?.trim() ?? null
    const ip           = getClientIp(req)
    const userAgent    = req.headers['user-agent']?.slice(0, 512)     ?? null
    const acceptLang   = req.headers['accept-language']?.slice(0, 128) ?? null
    const acceptEnc    = req.headers['accept-encoding']?.slice(0, 128) ?? null
    const chPlatform   = req.headers['sec-ch-ua-platform']?.toString()        ?? null
    const chMobile     = req.headers['sec-ch-ua-mobile']?.toString()          ?? null
    const chBrowser    = req.headers['sec-ch-ua']?.toString()?.slice(0, 256)  ?? null
    const chArch       = req.headers['sec-ch-ua-arch']?.toString()            ?? null

    const clientHints: Record<string, string> = {}
    if (chPlatform)  clientHints['platform']   = chPlatform
    if (chMobile)    clientHints['mobile']      = chMobile
    if (chBrowser)   clientHints['browser']     = chBrowser
    if (chArch)      clientHints['arch']        = chArch
    if (machineHash) clientHints['machineHash'] = machineHash
    if (extraClientData) Object.assign(clientHints, extraClientData)

    let fingerprintHash: string
    if (machineHash && /^[0-9a-f]{16,}$/i.test(machineHash)) {
        fingerprintHash = machineHash
    } else {
        fingerprintHash = createHash('sha256')
            .update([userAgent ?? '', acceptLang ?? '', acceptEnc ?? '', chPlatform ?? '', chMobile ?? '', chBrowser ?? '', chArch ?? ''].join('|'))
            .digest('hex')
    }
    return { fingerprintHash, ip, userAgent, acceptLanguage: acceptLang, clientHints: Object.keys(clientHints).length > 0 ? clientHints : undefined }
}

function getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() ?? req.ip ?? '0.0.0.0'
    return req.ip ?? req.socket?.remoteAddress ?? '0.0.0.0'
}

export async function upsertDevice(fp: DeviceFingerprint): Promise<{ device: DeviceRow; isNew: boolean }> {
    const existing = await query<DeviceRow>(`SELECT * FROM auth_devices WHERE fingerprint_hash = ? LIMIT 1`, [fp.fingerprintHash])
    if (existing[0]) {
        await execute(`UPDATE auth_devices SET last_seen_at = NOW(), first_ip = ? WHERE fingerprint_hash = ?`, [fp.ip, fp.fingerprintHash])
        return { device: { ...existing[0], blocked: Boolean(existing[0].blocked) }, isNew: false }
    }

    const hintsJson = fp.clientHints ? JSON.stringify(fp.clientHints) : null
    const result = await execute(
        `INSERT INTO auth_devices (fingerprint_hash, first_ip, user_agent, accept_language, client_hints, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
        [fp.fingerprintHash, fp.ip, fp.userAgent, fp.acceptLanguage, hintsJson]
    )
    const newRows = await query<DeviceRow>(`SELECT * FROM auth_devices WHERE id = ? LIMIT 1`, [result.insertId])
    logger.info({ component: 'DeviceStore', fp: fp.fingerprintHash.slice(0, 12) + '...' }, 'Nouvel appareil')
    return { device: { ...newRows[0]!, blocked: Boolean(newRows[0]!.blocked) }, isNew: true }
}

export async function linkDeviceToUser(deviceId: number, userUid: string): Promise<void> {
    await execute(`UPDATE auth_devices SET registered_uid = ? WHERE id = ?`, [userUid, deviceId])
}

export async function isDeviceBlocked(fingerprintHash: string): Promise<{ blocked: boolean; reason: string | null }> {
    const rows = await query<{ blocked: number; blocked_reason: string | null }>(
        `SELECT blocked, blocked_reason FROM auth_devices WHERE fingerprint_hash = ? LIMIT 1`, [fingerprintHash]
    )
    const row = rows[0]
    if (!row) return { blocked: false, reason: null }
    return { blocked: Boolean(row.blocked), reason: row.blocked_reason }
}

export async function getDeviceRegisteredUid(fingerprintHash: string): Promise<string | null> {
    const rows = await query<{ registered_uid: string | null }>(
        `SELECT registered_uid FROM auth_devices WHERE fingerprint_hash = ? LIMIT 1`, [fingerprintHash]
    )
    return rows[0]?.registered_uid ?? null
}

export async function logDeviceSession(data: {
    deviceId: number; userUid: string | null; ip: string
    action: DeviceSessionRow['action']; provider: string; meta?: Record<string, unknown>
}): Promise<void> {
    await execute(
        `INSERT INTO auth_device_sessions (device_id, user_uid, ip, action, provider, meta) VALUES (?, ?, ?, ?, ?, ?)`,
        [data.deviceId, data.userUid, data.ip, data.action, data.provider, data.meta ? JSON.stringify(data.meta) : null]
    )
}

export async function getDeviceSessions(deviceId: number, limit = 20): Promise<DeviceSessionRow[]> {
    return query<DeviceSessionRow>(
        `SELECT * FROM auth_device_sessions WHERE device_id = ? ORDER BY created_at DESC LIMIT ?`, [deviceId, limit]
    )
}
