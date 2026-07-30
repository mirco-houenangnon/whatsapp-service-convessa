/**
 * GroupStore.ts — Groupes WhatsApp — MySQL.
 */

import { v4 as uuidv4 }  from 'uuid'
import { query, execute } from './connection.js'

export interface Group {
    id:                    string
    tenantId:              string
    waGroupJid:            string
    name:                  string
    inviteCode:            string | null
    inviteCodeGeneratedAt: Date | null
    participantsCount:     number
    status:                'active' | 'deleted'
    createdAt:             Date
}

interface GroupRow {
    id: string; tenant_id: string; wa_group_jid: string; name: string
    invite_code: string | null; invite_code_generated_at: Date | null
    participants_count: number; status: 'active' | 'deleted'; created_at: Date
}

function rowToGroup(row: GroupRow): Group {
    return {
        id: row.id, tenantId: row.tenant_id, waGroupJid: row.wa_group_jid, name: row.name,
        inviteCode: row.invite_code, inviteCodeGeneratedAt: row.invite_code_generated_at,
        participantsCount: row.participants_count, status: row.status, createdAt: row.created_at,
    }
}

export async function findTenantGroupByName(tenantId: string, name: string): Promise<Group | null> {
    const rows = await query<GroupRow>(
        `SELECT * FROM wa_groups WHERE tenant_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?)) AND status = 'active' LIMIT 1`,
        [tenantId, name]
    )
    return rows[0] ? rowToGroup(rows[0]) : null
}

export async function createGroup(data: { tenantId: string; waGroupJid: string; name: string; participantsCount: number }): Promise<Group> {
    const id = uuidv4()
    await execute(
        `INSERT INTO wa_groups (id, tenant_id, wa_group_jid, name, participants_count, status) VALUES (?, ?, ?, ?, ?, 'active')`,
        [id, data.tenantId, data.waGroupJid, data.name, data.participantsCount]
    )
    const group = await getGroupById(id)
    if (!group) throw new Error('Groupe introuvable après création')
    return group
}

export async function getGroupById(id: string): Promise<Group | null> {
    const rows = await query<GroupRow>('SELECT * FROM wa_groups WHERE id = ?', [id])
    return rows[0] ? rowToGroup(rows[0]) : null
}

export async function getTenantGroupById(tenantId: string, id: string): Promise<Group | null> {
    const rows = await query<GroupRow>('SELECT * FROM wa_groups WHERE id = ? AND tenant_id = ?', [id, tenantId])
    return rows[0] ? rowToGroup(rows[0]) : null
}

export async function listTenantGroups(tenantId: string): Promise<Group[]> {
    const rows = await query<GroupRow>(
        `SELECT * FROM wa_groups WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC`, [tenantId]
    )
    return rows.map(rowToGroup)
}

export async function updateGroupInviteCode(id: string, inviteCode: string): Promise<void> {
    await execute(
        `UPDATE wa_groups SET invite_code = ?, invite_code_generated_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [inviteCode, id]
    )
}

export async function incrementParticipantsCount(id: string, addedCount: number): Promise<void> {
    await execute(
        `UPDATE wa_groups SET participants_count = participants_count + ?, updated_at = NOW() WHERE id = ?`,
        [addedCount, id]
    )
}
