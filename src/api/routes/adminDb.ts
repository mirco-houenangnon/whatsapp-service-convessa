/**
 * adminDb.ts — API du DB Browser admin (contrôle total table par table).
 * Toutes les routes sont protégées par requireAdminAuth et restreintes
 * à la whitelist définie dans schemaMeta.ts.
 */

import { Router } from 'express'
import { requireAdminAuth } from '../middleware/adminAuth.js'
import { listTablesMeta } from '../../db/schemaMeta.js'
import { listRows, getRow, updateRow, insertRow, deleteRow, AdminDbError } from '../../db/AdminDbStore.js'
import { logger } from '../../services/logger.js'

/**
 * Les valeurs de PK sont transmises encodées en JSON dans le paramètre :pk
 * (gère aussi les PK composites, ex: wa_session_keys). Express décode déjà
 * une fois le paramètre d'URL — on ne redécode donc pas ici.
 */
function decodePk(raw: string): unknown[] {
    try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
        return [raw]
    }
}

function handleDbError(err: unknown, res: import('express').Response): void {
    if (err instanceof AdminDbError) {
        const status = err.code === 'NOT_FOUND' ? 404
            : err.code === 'FORBIDDEN' || err.code === 'FORBIDDEN_COLUMN' || err.code === 'FORBIDDEN_TABLE' ? 403
            : 400
        res.status(status).json({ success: false, error: { code: err.code, message: err.message } })
        return
    }
    logger.error({ component: 'AdminDb', err }, 'Erreur DB browser')
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
}

export function adminDbRouter(): Router {
    const router = Router()
    router.use(requireAdminAuth)

    // ── GET /api/admin/db/tables — liste des tables + métadonnées colonnes ────
    router.get('/tables', (_req, res) => {
        res.json({ success: true, tables: listTablesMeta() })
    })

    // ── GET /api/admin/db/tables/:table/rows ───────────────────────────────────
    router.get('/tables/:table/rows', async (req, res) => {
        const page   = Math.max(1, parseInt(req.query['page'] as string, 10) || 1)
        const limit  = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string, 10) || 25))
        const search = typeof req.query['search'] === 'string' ? (req.query['search'] as string).trim() : undefined

        try {
            const result = await listRows(req.params['table']!, { page, limit, search })
            res.json({ success: true, ...result, meta: { page, limit, pages: Math.ceil(result.total / limit) } })
        } catch (err) { handleDbError(err, res) }
    })

    // ── GET /api/admin/db/tables/:table/rows/:pk ───────────────────────────────
    router.get('/tables/:table/rows/:pk', async (req, res) => {
        try {
            const row = await getRow(req.params['table']!, decodePk(req.params['pk']!))
            if (!row) { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Ligne introuvable' } }); return }
            res.json({ success: true, row })
        } catch (err) { handleDbError(err, res) }
    })

    // ── POST /api/admin/db/tables/:table/rows — création ───────────────────────
    router.post('/tables/:table/rows', async (req, res) => {
        try {
            const row = await insertRow(req.params['table']!, req.body as Record<string, unknown>)
            logger.info({ component: 'AdminDb', adminId: req.adminUser!.sub, table: req.params['table'] }, 'Ligne créée (DB browser)')
            res.status(201).json({ success: true, row })
        } catch (err) { handleDbError(err, res) }
    })

    // ── PUT /api/admin/db/tables/:table/rows/:pk — mise à jour ─────────────────
    router.put('/tables/:table/rows/:pk', async (req, res) => {
        try {
            const row = await updateRow(req.params['table']!, decodePk(req.params['pk']!), req.body as Record<string, unknown>)
            logger.info({ component: 'AdminDb', adminId: req.adminUser!.sub, table: req.params['table'] }, 'Ligne modifiée (DB browser)')
            res.json({ success: true, row })
        } catch (err) { handleDbError(err, res) }
    })

    // ── DELETE /api/admin/db/tables/:table/rows/:pk ─────────────────────────────
    router.delete('/tables/:table/rows/:pk', async (req, res) => {
        try {
            await deleteRow(req.params['table']!, decodePk(req.params['pk']!))
            logger.warn({ component: 'AdminDb', adminId: req.adminUser!.sub, table: req.params['table'] }, 'Ligne supprimée (DB browser)')
            res.json({ success: true })
        } catch (err) { handleDbError(err, res) }
    })

    return router
}
