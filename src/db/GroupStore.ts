/**
 * GroupStore.ts — CRUD des groupes WhatsApp créés par les tenants.
 *
 * Un groupe est créé UNE fois (via POST /api/v1/groups) et persiste ensuite :
 * le développeur peut y renvoyer des messages indéfiniment via son `groupId`,
 * sans jamais recréer de groupe à chaque envoi.
 */

import { v4 as uuidv4 } from 'uuid'
import { getPool }      from './connection.js'
import type mysql from 'mysql2/promise'

export interface Group {
    id:                     string
    tenantId:                string
    waGroupJid:              string
    name:                    string
    inviteCode:              string | null
    inviteCodeGeneratedAt:   Date | null
    participantsCount:       number
    status:                  'active' | 'deleted'
    createdAt:               Date
}

interface GroupRow {
    id:                       string
    tenant_id:                string
    wa_group_jid:             string
    name:                     string
    invite_code:              string | null
    invite_code_generated_at: Date | null
    participants_count:       number
    status:                   'active' | 'deleted'
    created_at:               Date
}

function rowToGroup(row: GroupRow): Group {
    return {
        id:                    row.id,
        tenantId:              row.tenant_id,
        waGroupJid:            row.wa_group_jid,
        name:                  row.name,
        inviteCode:            row.invite_code,
        inviteCodeGeneratedAt: row.invite_code_generated_at,
        participantsCount:     row.participants_count,
        status:                row.status,
        createdAt:             row.created_at,
    }
}

/**
 * Recherche un groupe existant du tenant par son nom (insensible à la casse,
 * espaces ignorés) — permet un `POST /groups` idempotent : rappeler avec le
 * même nom renvoie le groupe déjà créé plutôt que d'en créer un doublon.
 */
export async function findTenantGroupByName(tenantId: string, name: string): Promise<Group | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<GroupRow[] & mysql.RowDataPacket[]>(
        `SELECT * FROM wa_groups WHERE tenant_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?)) AND status = 'active' LIMIT 1`,
        [tenantId, name]
    )
    const row = rows[0]
    return row ? rowToGroup(row) : null
}

export async function createGroup(data: {
    tenantId:   string
    waGroupJid: string
    name:       string
    participantsCount: number
}): Promise<Group> {
    const pool = getPool()
    const id   = uuidv4()

    await pool.execute(
        `INSERT INTO wa_groups (id, tenant_id, wa_group_jid, name, participants_count, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
        [id, data.tenantId, data.waGroupJid, data.name, data.participantsCount]
    )

    const group = await getGroupById(id)
    if (!group) throw new Error('Groupe introuvable après création')
    return group
}

export async function getGroupById(id: string): Promise<Group | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<GroupRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM wa_groups WHERE id = ?',
        [id]
    )
    const row = rows[0]
    return row ? rowToGroup(row) : null
}

/**
 * Récupère un groupe appartenant à un tenant précis (vérification de
 * propriété — un tenant ne doit jamais pouvoir agir sur le groupe d'un autre).
 */
export async function getTenantGroupById(tenantId: string, id: string): Promise<Group | null> {
    const pool   = getPool()
    const [rows] = await pool.execute<GroupRow[] & mysql.RowDataPacket[]>(
        'SELECT * FROM wa_groups WHERE id = ? AND tenant_id = ?',
        [id, tenantId]
    )
    const row = rows[0]
    return row ? rowToGroup(row) : null
}

export async function listTenantGroups(tenantId: string): Promise<Group[]> {
    const pool   = getPool()
    const [rows] = await pool.execute<GroupRow[] & mysql.RowDataPacket[]>(
        `SELECT * FROM wa_groups WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC`,
        [tenantId]
    )
    return (rows as GroupRow[]).map(rowToGroup)
}

export async function updateGroupInviteCode(id: string, inviteCode: string): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE wa_groups SET invite_code = ?, invite_code_generated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [inviteCode, id]
    )
}

export async function incrementParticipantsCount(id: string, addedCount: number): Promise<void> {
    const pool = getPool()
    await pool.execute(
        `UPDATE wa_groups SET participants_count = participants_count + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [addedCount, id]
    )
}
