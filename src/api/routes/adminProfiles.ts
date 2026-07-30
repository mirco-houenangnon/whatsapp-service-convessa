/**
 * adminProfiles.ts — API du mode « gestion de profils » : vue 360° d'un
 * utilisateur (auth_users + tout ce qui s'y rattache), édition champ par
 * champ, et suppression totale et cascade en un clic.
 */

import { Router } from 'express'
import { requireAdminAuth } from '../middleware/adminAuth.js'
import { listProfiles, getProfile, updateProfileField, deleteProfile } from '../../db/UserProfileStore.js'
import { AdminDbError } from '../../db/AdminDbStore.js'
import { logger } from '../../services/logger.js'

function handleErr(err: unknown, res: import('express').Response): void {
    if (err instanceof AdminDbError) {
        const status = err.code === 'NOT_FOUND' ? 404
            : err.code === 'FORBIDDEN' || err.code === 'FORBIDDEN_COLUMN' || err.code === 'FORBIDDEN_TABLE' ? 403
            : 400
        res.status(status).json({ success: false, error: { code: err.code, message: err.message } })
        return
    }
    logger.error({ component: 'AdminProfiles', err }, 'Erreur profils')
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } })
}

export function adminProfilesRouter(): Router {
    const router = Router()
    router.use(requireAdminAuth)

    // ── GET /api/admin/profiles?search=&page=&limit= ───────────────────────────
    router.get('/', async (req, res) => {
        const page   = Math.max(1, parseInt(req.query['page'] as string, 10) || 1)
        const limit  = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string, 10) || 20))
        const search = typeof req.query['search'] === 'string' ? (req.query['search'] as string).trim() : undefined
        try {
            const { total, profiles } = await listProfiles({ page, limit, search })
            res.json({ success: true, profiles, meta: { page, limit, total, pages: Math.ceil(total / limit) } })
        } catch (err) { handleErr(err, res) }
    })

    // ── GET /api/admin/profiles/:uid — vue 360° ─────────────────────────────────
    router.get('/:uid', async (req, res) => {
        try {
            const profile = await getProfile(req.params['uid']!)
            if (!profile) { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Profil introuvable' } }); return }
            res.json({ success: true, profile })
        } catch (err) { handleErr(err, res) }
    })

    // ── PUT /api/admin/profiles/:uid/field — édition d'un champ précis ─────────
    router.put('/:uid/field', async (req, res) => {
        const { table, pk, column, value } = req.body as { table?: unknown; pk?: unknown; column?: unknown; value?: unknown }
        if (typeof table !== 'string' || !Array.isArray(pk) || typeof column !== 'string') {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'table, pk (array) et column sont requis' } })
            return
        }
        try {
            const row = await updateProfileField(req.params['uid']!, table, pk, column, value)
            logger.info({ component: 'AdminProfiles', adminId: req.adminUser!.sub, uid: req.params['uid'], table, column }, 'Champ profil modifié')
            res.json({ success: true, row })
        } catch (err) { handleErr(err, res) }
    })

    // ── DELETE /api/admin/profiles/:uid — suppression totale cascade ───────────
    router.delete('/:uid', async (req, res) => {
        try {
            const result = await deleteProfile(req.params['uid']!)
            logger.warn({ component: 'AdminProfiles', adminId: req.adminUser!.sub, uid: req.params['uid'] }, 'Profil supprimé (cascade totale)')
            res.json({ success: true, ...result })
        } catch (err) { handleErr(err, res) }
    })

    return router
}
