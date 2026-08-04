/**
 * groups.ts — Gestion des groupes WhatsApp pour les tenants.
 *
 * Authentification : clé API tenant (X-Api-Key: pk_convessa_...)
 *
 * ── Comportement (norme suivie par les principales passerelles WhatsApp) ──
 * POST /groups est IDEMPOTENT PAR NOM : rappeler avec le même nom ne crée
 * jamais de doublon — le groupe existant est retourné (`created: false`).
 * C'est le geste "une seule action" pour le développeur : il peut appeler
 * POST /groups à chaque fois qu'il veut s'assurer qu'un groupe existe, sans
 * avoir à vérifier lui-même s'il l'a déjà créé.
 *
 * Un groupe n'est JAMAIS créé silencieusement comme effet de bord d'un
 * envoi de message (POST /send) — créer des groupes en arrière-plan à
 * chaque envoi est un pattern à risque de bannissement WhatsApp. La création
 * reste un geste explicite, mais réduit au minimum (un seul appel, idempotent).
 *
 * Pour les participants dont les réglages de confidentialité empêchent
 * l'ajout direct, le lien d'invitation leur est automatiquement envoyé en
 * message privé (fallback géré par TenantManager) — le développeur n'a rien
 * à faire de plus.
 */

import { Router }              from 'express'
import { requireTenantApiKey } from '../middleware/tenantAuth.js'
import { rateLimit }           from '../middleware/rateLimit.js'
import { TenantManager }       from '../../whatsapp/TenantManager.js'
import { logger }              from '../../services/logger.js'
import { normalizePhone }      from '../../services/phoneUtils.js'
import {
    findTenantGroupByName,
    createGroup,
    getTenantGroupById,
    listTenantGroups,
    updateGroupInviteCode,
    incrementParticipantsCount,
}                               from '../../db/GroupStore.js'

const PHONE_REGEX = /^[+\d\s\-().]+$/
const MAX_PARTICIPANTS = 256 // limite WhatsApp

function sanitizePhone(raw: string): string {
    return normalizePhone(raw)
}

export function groupsRouter(tenantManager: TenantManager): Router {
    const router = Router()

    // ── POST /api/v1/groups — créer (ou récupérer) un groupe ────────────────
    router.post('/groups', rateLimit, requireTenantApiKey, async (req, res) => {
        const tenant = req.tenant!
        const body   = req.body as { name?: unknown; participants?: unknown }

        if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "Le champ 'name' est requis" } })
            return
        }
        const name = body.name.trim()

        if (!Array.isArray(body.participants) || body.participants.length === 0) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'participants' doit être un tableau non vide de numéros" } })
            return
        }
        if (body.participants.length > MAX_PARTICIPANTS) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Maximum ${MAX_PARTICIPANTS} participants par groupe (limite WhatsApp)` } })
            return
        }

        const participantJids: string[] = []
        for (const p of body.participants) {
            const trimmed = String(p).trim()
            if (!PHONE_REGEX.test(trimmed)) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Numéro participant invalide : '${trimmed}'` } })
                return
            }
            participantJids.push(`${sanitizePhone(trimmed)}@s.whatsapp.net`)
        }

        if (!tenantManager.isConnected(tenant.id)) {
            res.status(503).json({ success: false, error: { code: 'SESSION_NOT_CONNECTED', message: "Votre session WhatsApp n'est pas connectée." } })
            return
        }

        try {
            // ── Idempotence par nom — pas de doublon si déjà créé ────────────
            const existing = await findTenantGroupByName(tenant.id, name)
            if (existing) {
                res.status(200).json({
                    success:  true,
                    created:  false,
                    groupId:  existing.id,
                    name:     existing.name,
                    participantsCount: existing.participantsCount,
                    message:  'Un groupe avec ce nom existe déjà — aucun doublon créé.',
                })
                return
            }

            const { groupJid, addedJids, invitedByLinkJids } = await tenantManager.createGroupAsTenant(tenant.id, name, participantJids)

            const group = await createGroup({
                tenantId:          tenant.id,
                waGroupJid:        groupJid,
                name,
                participantsCount: addedJids.length + invitedByLinkJids.length,
            })

            logger.info(
                { component: 'GroupsRoute', tenantId: tenant.id, groupId: group.id, added: addedJids.length, invited: invitedByLinkJids.length },
                'Groupe créé (self-service)'
            )

            res.status(201).json({
                success:            true,
                created:            true,
                groupId:            group.id,
                name:               group.name,
                addedDirectly:      addedJids.length,
                invitedByLink:      invitedByLinkJids.length,
                message: invitedByLinkJids.length > 0
                    ? `Groupe créé. ${invitedByLinkJids.length} participant(s) n'ont pas pu être ajoutés directement (réglages de confidentialité) — un lien d'invitation leur a été envoyé en message privé.`
                    : 'Groupe créé avec tous les participants.',
            })

        } catch (err) {
            logger.error({ component: 'GroupsRoute', tenantId: tenant.id, err }, 'Erreur création groupe')
            res.status(500).json({
                success: false,
                error: { code: 'GROUP_CREATE_ERROR', message: err instanceof Error ? err.message : 'Erreur lors de la création du groupe' },
            })
        }
    })

    // ── GET /api/v1/groups — lister mes groupes ─────────────────────────────
    router.get('/groups', requireTenantApiKey, async (req, res) => {
        const tenant = req.tenant!
        const groups = await listTenantGroups(tenant.id)
        res.json({
            success: true,
            count:   groups.length,
            groups:  groups.map(g => ({
                groupId:           g.id,
                name:              g.name,
                participantsCount: g.participantsCount,
                createdAt:         g.createdAt,
            })),
        })
    })

    // ── GET /api/v1/groups/:id — détail d'un groupe ─────────────────────────
    router.get('/groups/:id', requireTenantApiKey, async (req, res) => {
        const tenant = req.tenant!
        const group  = await getTenantGroupById(tenant.id, req.params['id'] as string)

        if (!group) {
            res.status(404).json({ success: false, error: { code: 'GROUP_NOT_FOUND', message: 'Groupe introuvable' } })
            return
        }

        res.json({
            success:           true,
            groupId:           group.id,
            name:              group.name,
            participantsCount: group.participantsCount,
            inviteCode:        group.inviteCode,
            createdAt:         group.createdAt,
        })
    })

    // ── GET /api/v1/groups/:id/invite — lien d'invitation ───────────────────
    router.get('/groups/:id/invite', requireTenantApiKey, async (req, res) => {
        const tenant = req.tenant!
        const group  = await getTenantGroupById(tenant.id, req.params['id'] as string)

        if (!group) {
            res.status(404).json({ success: false, error: { code: 'GROUP_NOT_FOUND', message: 'Groupe introuvable' } })
            return
        }

        if (!tenantManager.isConnected(tenant.id)) {
            res.status(503).json({ success: false, error: { code: 'SESSION_NOT_CONNECTED', message: "Votre session WhatsApp n'est pas connectée." } })
            return
        }

        try {
            const code = await tenantManager.getGroupInviteCode(tenant.id, group.waGroupJid)
            await updateGroupInviteCode(group.id, code)
            res.json({ success: true, groupId: group.id, inviteLink: `https://chat.whatsapp.com/${code}` })
        } catch (err) {
            logger.error({ component: 'GroupsRoute', tenantId: tenant.id, groupId: group.id, err }, "Erreur génération lien d'invitation")
            res.status(500).json({ success: false, error: { code: 'INVITE_ERROR', message: "Erreur lors de la génération du lien d'invitation" } })
        }
    })

    // ── POST /api/v1/groups/:id/participants — ajouter des participants ────
    router.post('/groups/:id/participants', rateLimit, requireTenantApiKey, async (req, res) => {
        const tenant = req.tenant!
        const group  = await getTenantGroupById(tenant.id, req.params['id'] as string)

        if (!group) {
            res.status(404).json({ success: false, error: { code: 'GROUP_NOT_FOUND', message: 'Groupe introuvable' } })
            return
        }

        const body = req.body as { participants?: unknown }
        if (!Array.isArray(body.participants) || body.participants.length === 0) {
            res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: "'participants' doit être un tableau non vide de numéros" } })
            return
        }

        const participantJids: string[] = []
        for (const p of body.participants) {
            const trimmed = String(p).trim()
            if (!PHONE_REGEX.test(trimmed)) {
                res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Numéro participant invalide : '${trimmed}'` } })
                return
            }
            participantJids.push(`${sanitizePhone(trimmed)}@s.whatsapp.net`)
        }

        if (!tenantManager.isConnected(tenant.id)) {
            res.status(503).json({ success: false, error: { code: 'SESSION_NOT_CONNECTED', message: "Votre session WhatsApp n'est pas connectée." } })
            return
        }

        try {
            const { addedJids, invitedByLinkJids } = await tenantManager.addGroupParticipants(tenant.id, group.waGroupJid, participantJids)
            await incrementParticipantsCount(group.id, addedJids.length + invitedByLinkJids.length)

            res.json({
                success:       true,
                addedDirectly: addedJids.length,
                invitedByLink: invitedByLinkJids.length,
                message: invitedByLinkJids.length > 0
                    ? `${invitedByLinkJids.length} participant(s) invité(s) par lien (réglages de confidentialité).`
                    : 'Tous les participants ont été ajoutés.',
            })
        } catch (err) {
            logger.error({ component: 'GroupsRoute', tenantId: tenant.id, groupId: group.id, err }, 'Erreur ajout participants')
            res.status(500).json({ success: false, error: { code: 'PARTICIPANTS_ADD_ERROR', message: "Erreur lors de l'ajout des participants" } })
        }
    })

    return router
}
