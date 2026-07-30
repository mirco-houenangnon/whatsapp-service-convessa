/**
 * ReferralCodeStore.ts — Codes de parrainage — MySQL.
 */

import { v4 as uuidv4 }   from 'uuid'
import { query, execute }  from './connection.js'
import { logger }          from '../services/logger.js'

export type UsageType = 'duration' | 'requests'

export interface ReferralCode {
    id: string; code: string; unlimited: boolean
    usageType: UsageType | null; usageValue: number | null; createdAt: Date
}

interface ReferralCodeRow {
    id: string; code: string; unlimited: number
    usage_type: UsageType | null; usage_value: number | null; created_at: Date
}

function rowToReferralCode(row: ReferralCodeRow): ReferralCode {
    return { id: row.id, code: row.code, unlimited: Boolean(row.unlimited), usageType: row.usage_type, usageValue: row.usage_value, createdAt: row.created_at }
}

export async function createReferralCode(data: { code: string; unlimited: boolean; usageType?: UsageType | null; usageValue?: number | null }): Promise<ReferralCode> {
    const id = uuidv4()
    await execute(
        `INSERT INTO referral_codes (id, code, unlimited, usage_type, usage_value) VALUES (?, ?, ?, ?, ?)`,
        [id, data.code, data.unlimited ? 1 : 0, data.unlimited ? null : (data.usageType ?? null), data.unlimited ? null : (data.usageValue ?? null)]
    )
    logger.info({ component: 'ReferralCodeStore', id, code: data.code }, 'Code créé')
    const created = await getReferralCodeById(id)
    if (!created) throw new Error('Code introuvable après création')
    return created
}

export async function getReferralCodeById(id: string): Promise<ReferralCode | null> {
    const rows = await query<ReferralCodeRow>('SELECT * FROM referral_codes WHERE id = ?', [id])
    return rows[0] ? rowToReferralCode(rows[0]) : null
}

export async function getReferralCodeByCode(code: string): Promise<ReferralCode | null> {
    const rows = await query<ReferralCodeRow>('SELECT * FROM referral_codes WHERE code = ?', [code])
    return rows[0] ? rowToReferralCode(rows[0]) : null
}

export async function listReferralCodes(): Promise<ReferralCode[]> {
    const rows = await query<ReferralCodeRow>('SELECT * FROM referral_codes ORDER BY created_at DESC')
    return rows.map(rowToReferralCode)
}
