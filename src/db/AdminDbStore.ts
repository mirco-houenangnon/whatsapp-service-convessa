/**
 * AdminDbStore.ts — CRUD générique sécurisé sur les tables whitelistées
 * (voir schemaMeta.ts). Aucun identifiant SQL n'est jamais construit à
 * partir d'une entrée utilisateur sans passer par cette whitelist.
 *
 * Base de données : MySQL (mysql2) — placeholders `?`, backtick pour
 * les identifiants, pas de RETURNING (on re-lit après UPDATE/INSERT).
 */

import { query, execute } from './connection.js'
import { getTableMeta, maskSensitive, type TableMeta } from './schemaMeta.js'

export class AdminDbError extends Error {
    constructor(public code: string, message: string) {
        super(message)
    }
}

function requireTable(table: string): TableMeta {
    const meta = getTableMeta(table)
    if (!meta) throw new AdminDbError('UNKNOWN_TABLE', `Table inconnue ou non exposée : ${table}`)
    return meta
}

/** Échappe un identifiant SQL pour MySQL avec des backticks. */
function quoteIdent(ident: string): string {
    return `\`${ident.replace(/`/g, '``')}\``
}

/** Construit la clause WHERE pk avec des placeholders `?`. */
function pkWhere(table: TableMeta, pkValues: unknown[]): { clause: string; params: unknown[] } {
    if (pkValues.length !== table.pk.length) {
        throw new AdminDbError('VALIDATION_ERROR', `Clé primaire invalide pour ${table.name}`)
    }
    const clause = table.pk.map((col) => `${quoteIdent(col)} = ?`).join(' AND ')
    return { clause, params: pkValues }
}

/** Récupère une ligne par sa PK. */
async function fetchRowByPk(table: TableMeta, pkValues: unknown[]): Promise<Record<string, unknown> | null> {
    const { clause, params } = pkWhere(table, pkValues)
    const rows = await query(`SELECT * FROM ${quoteIdent(table.name)} WHERE ${clause} LIMIT 1`, params)
    return (rows[0] as Record<string, unknown>) ?? null
}

export interface ListRowsOptions {
    page:    number
    limit:   number
    search?: string
}

export async function listRows(tableName: string, opts: ListRowsOptions) {
    const table  = requireTable(tableName)
    const offset = (opts.page - 1) * opts.limit
    const params: unknown[] = []
    let where = ''

    if (opts.search && table.searchable?.length) {
        const conds = table.searchable.map((col) => {
            params.push(`%${opts.search}%`)
            return `${quoteIdent(col)} LIKE ?`
        })
        where = `WHERE ${conds.join(' OR ')}`
    }

    const countRows = await query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM ${quoteIdent(table.name)} ${where}`, params
    )
    const total = parseInt(countRows[0]?.total ?? '0', 10)

    const sortCol = table.defaultSort ?? table.pk[0]!
    const rows = await query(
        `SELECT * FROM ${quoteIdent(table.name)} ${where}
         ORDER BY ${quoteIdent(sortCol)} DESC LIMIT ? OFFSET ?`,
        [...params, Number(opts.limit), Number(offset)]
    )

    return {
        table: { name: table.name, label: table.label, pk: table.pk, columns: table.columns },
        total,
        rows:  rows.map((r) => maskSensitive(table, r as Record<string, unknown>)),
    }
}

export async function getRow(tableName: string, pkValues: unknown[]) {
    const table = requireTable(tableName)
    const row   = await fetchRowByPk(table, pkValues)
    if (!row) return null
    return maskSensitive(table, row)
}

function assertEditableColumn(table: TableMeta, colName: string): void {
    const col = table.columns.find((c) => c.name === colName)
    if (!col) throw new AdminDbError('UNKNOWN_COLUMN', `Colonne inconnue : ${colName}`)
    if (col.sensitive)         throw new AdminDbError('FORBIDDEN_COLUMN', `Colonne protégée, non éditable : ${colName}`)
    if (table.pk.includes(colName)) throw new AdminDbError('FORBIDDEN_COLUMN', `La clé primaire ne peut pas être modifiée : ${colName}`)
}

export async function updateRow(
    tableName: string,
    pkValues:  unknown[],
    changes:   Record<string, unknown>
) {
    const table = requireTable(tableName)
    const cols  = Object.keys(changes)
    if (cols.length === 0) throw new AdminDbError('VALIDATION_ERROR', 'Aucune modification fournie')
    cols.forEach((c) => assertEditableColumn(table, c))

    const setParams: unknown[] = []
    const setClause = cols.map((c) => {
        setParams.push(changes[c])
        return `${quoteIdent(c)} = ?`
    }).join(', ')

    // updated_at géré automatiquement par ON UPDATE CURRENT_TIMESTAMP en MySQL
    const { clause, params: pkParams } = pkWhere(table, pkValues)

    await execute(
        `UPDATE ${quoteIdent(table.name)} SET ${setClause} WHERE ${clause}`,
        [...setParams, ...pkParams]
    )

    // MySQL n'a pas RETURNING — on relit la ligne mise à jour
    const updated = await fetchRowByPk(table, pkValues)
    if (!updated) throw new AdminDbError('NOT_FOUND', 'Ligne introuvable après mise à jour')
    return maskSensitive(table, updated)
}

export async function insertRow(tableName: string, values: Record<string, unknown>) {
    const table = requireTable(tableName)

    for (const col of table.columns) {
        if (col.required && !col.generated && (values[col.name] === undefined || values[col.name] === null || values[col.name] === '')) {
            throw new AdminDbError('VALIDATION_ERROR', `Le champ "${col.name}" est requis`)
        }
    }

    const cols = Object.keys(values).filter((k) => {
        const col = table.columns.find((c) => c.name === k)
        return col && !col.sensitive && !col.generated
    })
    if (cols.length === 0) throw new AdminDbError('VALIDATION_ERROR', 'Aucune donnée valide à insérer')

    const params = cols.map((c) => values[c])
    const placeholders = cols.map(() => '?').join(', ')

    const result = await execute(
        `INSERT INTO ${quoteIdent(table.name)} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`,
        params
    )

    // Récupérer la ligne insérée — pour AUTO_INCREMENT on utilise insertId, sinon PK fournie
    let pkValues: unknown[]
    if (table.pk.length === 1 && result.insertId) {
        pkValues = [result.insertId]
    } else {
        pkValues = table.pk.map((c) => values[c])
    }

    const inserted = await fetchRowByPk(table, pkValues)
    if (!inserted) throw new AdminDbError('NOT_FOUND', 'Ligne introuvable après insertion')
    return maskSensitive(table, inserted)
}

export async function deleteRow(tableName: string, pkValues: unknown[]) {
    const table = requireTable(tableName)
    const { clause, params } = pkWhere(table, pkValues)
    await execute(`DELETE FROM ${quoteIdent(table.name)} WHERE ${clause}`, params)
    return true
}
