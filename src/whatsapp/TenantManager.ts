/**
 * TenantManager.ts — Gestionnaire multi-tenant des sessions WhatsApp.
 *
 * Chaque tenant a sa propre instance WhatsApp (socket Baileys indépendant).
 * Le numéro admin (PRIMARY) reste géré par WhatsAppManager séparément.
 *
 * Cycle de vie d'un tenant :
 *   1. createSession(tenantId) → génère un QR code
 *   2. Utilisateur scanne le QR → onConnected déclenché
 *   3. Clé API générée + webhook notifié + WhatsApp de confirmation envoyé
 *   4. Tenant actif → peut envoyer des messages via sa propre session
 */

import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    type WASocket,
} from '@whiskeysockets/baileys'
import { Boom }         from '@hapi/boom'
import { EventEmitter } from 'events'

import { logger, maskPhone }       from '../services/logger.js'
import { generateApiKey }          from '../services/apiKeyService.js'
import { resolveTenantPrivileges, ReferralCodeError } from '../services/tenantPrivileges.js'
import { useDbAuthState }          from '../db/SessionStore.js'
import {
    getTenantById,
    getTenantByWhatsAppJid,
    updateTenantStatus,
    updateTenantPhone,
    setTenantApiKeyWithPrivileges,
    listTenants,
    type Tenant,
} from '../db/TenantStore.js'
import { getFreePlan }             from '../db/SubscriptionPlanStore.js'
import { WhatsAppManager }         from './WhatsAppManager.js'
import type { MediaPayload }       from '../db/MessageQueue.js'
import { config }                  from '../config.js'

const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const

interface TenantSession {
    tenantId:     string
    sock:         WASocket
    isConnected:  boolean
    lastQr:       string | null
    reconnects:   number
    phone:        string | null
}

const baileysLogger = {
    level: 'silent' as const,
    trace: () => {}, debug: () => {}, info: () => {},
    warn:  () => {}, error: () => {}, fatal: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    child: function() { return this as any },
}

export class TenantManager extends EventEmitter {

    // Map tenantId → session active
    private sessions: Map<string, TenantSession> = new Map()

    constructor(private readonly adminManager: WhatsAppManager) {
        super()
        this.setMaxListeners(200)
    }

    // ── Créer/démarrer une session pour un tenant ──────────────────────────────

    async createSession(tenantId: string): Promise<void> {
        // Si déjà une session active pour ce tenant, la fermer proprement
        const existing = this.sessions.get(tenantId)
        if (existing) {
            this._closeSocket(tenantId, existing.sock)
            this.sessions.delete(tenantId)
        }

        await updateTenantStatus(tenantId, 'pending_qr')
        await this._initSession(tenantId, 0)
    }

    // ── Restauration des sessions au démarrage du serveur ──────────────────────
    // Le Map `sessions` est en mémoire et vide à chaque redémarrage du process.
    // Sans cet appel, `isConnected()` renvoie false pour tous les tenants même
    // si leur statut en base est 'connected' et que leurs credentials Baileys
    // sont toujours valides — d'où un 503 SESSION_NOT_CONNECTED trompeur sur
    // /api/v1/send juste après un redéploiement/redémarrage.
    // _initSession() réutilise les credentials persistées (useDbAuthState) :
    // la reconnexion se fait silencieusement, sans générer de nouveau QR.

    async restoreSessions(): Promise<void> {
        const tenants = await listTenants()
        const toRestore = tenants.filter(t => t.status === 'connected')

        if (toRestore.length === 0) {
            logger.info({ component: 'TenantManager' }, 'Aucune session tenant à restaurer')
            return
        }

        logger.info(
            { component: 'TenantManager', count: toRestore.length },
            'Restauration des sessions tenant connectées...'
        )

        for (const tenant of toRestore) {
            this._initSession(tenant.id, 0).catch((err) => {
                logger.error({ component: 'TenantManager', tenantId: tenant.id, err }, 'Erreur restauration session tenant')
            })
        }
    }

    // ── Initialisation interne d'une session ───────────────────────────────────

    private async _initSession(tenantId: string, reconnectAttempt: number): Promise<void> {
        try {
            const { state, saveCreds } = await useDbAuthState(tenantId)
            const { version }          = await fetchLatestBaileysVersion()

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sock = makeWASocket({ version, logger: baileysLogger as any, auth: state, syncFullHistory: false })

            const session: TenantSession = {
                tenantId,
                sock,
                isConnected: false,
                lastQr:      null,
                reconnects:  reconnectAttempt,
                phone:       null,
            }

            this.sessions.set(tenantId, session)

            // ── Événements Baileys ───────────────────────────────────────────
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update

                if (qr) {
                    session.lastQr      = qr
                    session.isConnected = false
                    logger.info({ component: 'TenantManager', tenantId }, 'QR généré pour tenant')
                    this.emit('qr', tenantId, qr)
                }

                if (connection === 'close') {
                    session.isConnected = false
                    session.lastQr      = null
                    session.phone       = null

                    const code        = (lastDisconnect?.error as Boom)?.output?.statusCode
                    const isLoggedOut = code === DisconnectReason.loggedOut

                    logger.warn({ component: 'TenantManager', tenantId, code }, 'Session tenant fermée')

                    if (isLoggedOut) {
                        await updateTenantStatus(tenantId, 'disconnected')
                        this.emit('disconnected', tenantId, 'session_revoked')
                        this.sessions.delete(tenantId)
                    } else {
                        await updateTenantStatus(tenantId, 'disconnected')
                        this.emit('disconnected', tenantId, 'network')

                        const delay = RECONNECT_DELAYS[Math.min(session.reconnects, RECONNECT_DELAYS.length - 1)] ?? 30_000
                        session.reconnects++

                        setTimeout(() => this._initSession(tenantId, session.reconnects), delay)
                    }

                } else if (connection === 'open') {
                    session.isConnected  = true
                    session.reconnects   = 0
                    session.phone        = sock.user?.id ?? null

                    // Baileys JID format: "22990956919:19@s.whatsapp.net"
                    // Le ":19" est le device ID — on doit l'ignorer pour avoir le vrai numéro
                    const jidPart  = session.phone?.split('@')[0] ?? ''           // "22990956919:19"
                    const rawPhone = jidPart.split(':')[0]?.replace(/[^0-9]/g, '') ?? null  // "22990956919"

                    logger.info(
                        { component: 'TenantManager', tenantId, phone: maskPhone(rawPhone ?? ''), jid: session.phone },
                        'Tenant connecté ✅'
                    )

                    try {
                        // ── Vérifier que ce numéro WhatsApp n'est pas déjà utilisé par un autre tenant ──
                        if (rawPhone) {
                            const existingTenant = await getTenantByWhatsAppJid(session.phone ?? '', tenantId)
                            if (existingTenant) {
                                logger.warn(
                                    { component: 'TenantManager', tenantId, conflictTenantId: existingTenant.id, phone: maskPhone(rawPhone) },
                                    'Numéro WhatsApp déjà actif sur un autre tenant — connexion refusée'
                                )
                                try { sock.end(undefined) } catch { /* ignoré */ }
                                session.isConnected = false
                                await updateTenantStatus(tenantId, 'disconnected')
                                this.emit('error', tenantId, {
                                    code:    'PHONE_ALREADY_IN_USE',
                                    message: 'Ce numéro WhatsApp est déjà associé à un autre compte.',
                                })
                                return
                            }

                            // Aucune saisie manuelle de numéro : le tenant scanne directement.
                            // Le numéro réel est déduit du JID Baileys et enregistré ici.
                            await updateTenantPhone(tenantId, rawPhone)
                        }

                        await updateTenantStatus(tenantId, 'connected')

                        const tenant = await getTenantById(tenantId)
                        if (!tenant) {
                            logger.error({ component: 'TenantManager', tenantId }, 'Tenant introuvable après connexion')
                            return
                        }

                        if (!tenant.apiKeyHash) {
                            await this._onFirstConnection(tenant, session)
                        } else {
                            this.emit('connected', tenantId, { phone: maskPhone(rawPhone ?? '') })
                        }
                    } catch (openErr) {
                        logger.error({ component: 'TenantManager', tenantId, err: openErr }, 'Erreur lors du traitement connection=open')
                        this.emit('error', tenantId, { code: 'INTERNAL_ERROR', message: 'Erreur lors de la finalisation de la connexion' })
                    }
                }
            })

            sock.ev.on('creds.update', saveCreds)

        } catch (err) {
            logger.error({ component: 'TenantManager', tenantId, err }, 'Erreur init session tenant')
            const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)] ?? 30_000
            setTimeout(() => this._initSession(tenantId, reconnectAttempt + 1), delay)
        }
    }

    // ── Première connexion — QR scanné avec succès ─────────────────────────────
    // On NE génère PLUS la clé API automatiquement ici : le frontend doit
    // d'abord demander à l'utilisateur s'il possède un code de parrainage
    // (modal) puis appeler activateTenant() (via POST /api/v1/tenants/me/activate).
    // On signale simplement au frontend que la connexion WhatsApp a réussi et
    // qu'elle est "en attente d'activation".

    private async _onFirstConnection(tenant: Tenant, session: TenantSession): Promise<void> {
        logger.info(
            { component: 'TenantManager', tenantId: tenant.id },
            'QR scanné avec succès — en attente d\'activation (code de parrainage éventuel)'
        )

        this.emit('connected', tenant.id, {
            phone:              maskPhone(session.phone ?? ''),
            awaitingActivation: true,
        })
    }

    // ── Activation — appelée une fois que l'utilisateur a répondu au prompt ────
    // "possédez-vous un code de parrainage ?" (avec ou sans code). Calcule les
    // privilèges d'utilisation (illimité / durée / quota de messages) puis
    // génère la clé API définitive.

    async activateTenant(tenantId: string, referralCode?: string | null): Promise<{
        token:     string
        hint:      string
        expiresAt: Date | null
    }> {
        const tenant = await getTenantById(tenantId)
        if (!tenant) {
            throw Object.assign(new Error('Tenant introuvable'), { code: 'TENANT_NOT_FOUND' })
        }
        if (tenant.apiKeyHash) {
            // Idempotence : ne jamais régénérer/écraser une clé déjà émise.
            throw Object.assign(new Error('Cette session possède déjà une clé API'), { code: 'ALREADY_ACTIVATED' })
        }

        let privileges
        try {
            privileges = await resolveTenantPrivileges(referralCode)
        } catch (err) {
            if (err instanceof ReferralCodeError) {
                throw Object.assign(new Error(err.message), { code: 'INVALID_REFERRAL_CODE' })
            }
            throw err
        }

        const { token, hash, hint } = generateApiKey()
        const trimmedCode = referralCode?.trim() || null

        await setTenantApiKeyWithPrivileges(tenant.id, hash, hint, token, privileges, trimmedCode)

        logger.info(
            {
                component: 'TenantManager', tenantId: tenant.id,
                usageType: privileges.usageType, messagesLimit: privileges.messagesLimit,
                expiresAt: privileges.expiresAt, referralCode: trimmedCode,
            },
            'Tenant activé — clé API générée avec privilèges'
        )

        const session     = this.sessions.get(tenantId)
        const phoneToMask = session?.phone ?? tenant.phone ?? ''
        const expiresIso  = privileges.expiresAt ? privileges.expiresAt.toISOString() : null

        // ── Message de bienvenue WhatsApp ────────────────────────────────────────
        const phoneForWelcome = session?.phone ?? tenant.phone ?? ''
        if (phoneForWelcome) {
            // Récupérer le nom réel du plan gratuit pour l'afficher dans le message
            const freePlan = trimmedCode ? null : await getFreePlan().catch(() => null)
            const freePlanName = freePlan?.name ?? 'Gratuit'

            const planLabel = trimmedCode
                ? `votre abonnement (code de parrainage *${trimmedCode}*)`
                : `votre plan *${freePlanName}*`

            const usageMsg = privileges.usageType === 'unlimited'
                ? `Vous bénéficiez de ${planLabel}, avec un accès *illimité* à l'API.`
                : privileges.usageType === 'requests'
                ? `Vous bénéficiez de ${planLabel}, avec *${privileges.messagesLimit?.toLocaleString('fr-FR')} messages* à votre disposition.`
                : privileges.expiresAt
                ? `Vous bénéficiez de ${planLabel}, valable jusqu'au *${privileges.expiresAt.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}*.`
                : `Vous bénéficiez de ${planLabel}.`

            const welcomeText =
                `🎉 *Bienvenue sur Convessa !*\n\n` +
                `Votre session WhatsApp API est maintenant active et prête à l'emploi.\n\n` +
                `${usageMsg}\n\n` +
                `*Prochaines étapes :*\n` +
                `1️⃣ Récupérez votre clé API dans votre espace Convessa\n` +
                `2️⃣ Consultez la documentation et intégrez l'API dans votre application\n` +
                `3️⃣ Envoyez votre premier message — c'est aussi simple que ça\n\n` +
                `📖 Documentation : https://convessa.dev/docs\n` +
                `💬 Contactez-nous depuis le site : https://convessa.dev/contact\n\n` +
                `Votre clé API commence par : *${hint}*\n` +
                `_Gardez votre clé secrète et ne la partagez jamais._`

            try {
                await this.sendMessageAsTenantViaAdmin(phoneForWelcome, welcomeText)
            } catch (err) {
                logger.warn({ component: 'TenantManager', tenantId, err }, 'Impossible d\'envoyer le message de bienvenue WhatsApp')
            }
        }

        if (tenant.webhookUrl) {
            this._callWebhook(tenant.webhookUrl, {
                event:           'tenant.connected',
                tenantId:        tenant.id,
                phone:           maskPhone(phoneToMask),
                apiKey:          token,
                apiKeyHint:      hint,
                apiKeyExpiresAt: expiresIso,
                usageType:       privileges.usageType,
                messagesLimit:   privileges.messagesLimit,
                connectedAt:     new Date().toISOString(),
            })
        }

        this.emit('connected', tenant.id, {
            phone:           maskPhone(phoneToMask),
            apiKey:          token,
            apiKeyHint:      hint,
            apiKeyExpiresAt: expiresIso,
            usageType:       privileges.usageType,
            messagesLimit:   privileges.messagesLimit,
        })

        return { token, hint, expiresAt: privileges.expiresAt }
    }

    // ── Webhook ────────────────────────────────────────────────────────────────

    private _callWebhook(url: string, payload: unknown): void {
        // Fire-and-forget — n'attend pas la réponse
        import('https').then(({ request }) => {
            try {
                const body     = JSON.stringify(payload)
                const urlObj   = new URL(url)
                const options  = {
                    hostname: urlObj.hostname,
                    port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                    path:     urlObj.pathname + urlObj.search,
                    method:   'POST',
                    headers:  {
                        'Content-Type':   'application/json',
                        'Content-Length': Buffer.byteLength(body),
                        'User-Agent':     'WhatsApp-Gateway/2.0',
                    },
                    timeout: 10_000,
                }

                const req = request(options, (res) => {
                    logger.info({ component: 'TenantManager', url, status: res.statusCode }, 'Webhook appelé')
                })

                req.on('error', (err) => {
                    logger.error({ component: 'TenantManager', url, err }, 'Erreur webhook')
                })

                req.write(body)
                req.end()
            } catch (err) {
                logger.error({ component: 'TenantManager', err }, 'Erreur construction webhook')
            }
        }).catch(() => {})
    }

    // ── Envoi de message depuis la session d'un tenant ─────────────────────────

    /**
     * Envoie un message depuis la session propre du tenant.
     *
     * IMPORTANT — `timeoutMs` est un filet de sécurité INTERNE (par défaut
     * `config.send.safetyTimeoutMs`, 120s) : il évite qu'une promesse Baileys
     * bloquée ne reste ouverte indéfiniment en mémoire. Ce n'est PAS un
     * timeout "réponse HTTP" — la route /send répond immédiatement au client
     * et ne dépend jamais de la durée réelle de cet envoi (voir send.ts).
     * Un média volumineux peut légitimement prendre plus de 15s à uploader ;
     * le rendre bloquant pour le client causait de faux échecs alors que le
     * message partait bien.
     *
     * Retourne l'ID du message WhatsApp (key.id) une fois réellement transmis.
     */
    async sendMessageAsTenant(
        tenantId:  string,
        remoteJid: string,
        text:      string | null,
        media?:    MediaPayload,
        timeoutMs = config.send.safetyTimeoutMs
    ): Promise<{ waMessageId: string | null }> {
        const session = this.sessions.get(tenantId)
        if (!session?.isConnected || !session.sock) {
            throw new Error('Session tenant non connectée')
        }

        // Envoyer depuis la session propre du tenant (pas le manager admin)
        let sendPromise: Promise<unknown>

        if (media) {
            sendPromise = this._sendTenantMedia(session.sock, remoteJid, text, media)
        } else if (text) {
            sendPromise = session.sock.sendMessage(remoteJid, { text })
        } else {
            throw new Error('Le message doit contenir du texte ou un média')
        }

        const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout de sécurité après ${timeoutMs}ms`)), timeoutMs)
        )

        const result = await Promise.race([sendPromise, timeout]) as { key?: { id?: string | null } } | undefined
        return { waMessageId: result?.key?.id ?? null }
    }

    // ── Groupes ─────────────────────────────────────────────────────────────────

    /**
     * Crée un groupe WhatsApp depuis la session du tenant.
     * Les participants dont les réglages de confidentialité empêchent l'ajout
     * direct ("qui peut m'ajouter à des groupes") reçoivent automatiquement
     * le lien d'invitation en message privé, plutôt que d'échouer silencieusement.
     */
    async createGroupAsTenant(
        tenantId:     string,
        name:         string,
        participantsJid: string[]
    ): Promise<{ groupJid: string; addedJids: string[]; invitedByLinkJids: string[] }> {
        const session = this.sessions.get(tenantId)
        if (!session?.isConnected || !session.sock) {
            throw new Error('Session tenant non connectée')
        }

        const group    = await session.sock.groupCreate(name, participantsJid)
        const groupJid = group.id

        // `groupCreate` ne renvoie pas de statut par participant (contrairement à
        // `groupParticipantsUpdate`) : on déduit les échecs par différence entre
        // la liste demandée et la liste réellement présente dans le groupe créé.
        const presentJids = new Set((group.participants ?? []).map(p => p.id))
        const addedJids:  string[] = participantsJid.filter(jid => presentJids.has(jid))
        const failedJids: string[] = participantsJid.filter(jid => !presentJids.has(jid))

        // Fallback : envoyer le lien d'invitation en DM à ceux qui n'ont pas pu être ajoutés
        const invitedByLinkJids: string[] = []
        if (failedJids.length > 0) {
            try {
                const code = await session.sock.groupInviteCode(groupJid)
                if (!code) throw new Error('Code d\'invitation introuvable')
                const link = `https://chat.whatsapp.com/${code}`
                for (const jid of failedJids) {
                    try {
                        await session.sock.sendMessage(jid, {
                            text: `Vous avez été invité(e) au groupe "${name}". Rejoignez via ce lien : ${link}`,
                        })
                        invitedByLinkJids.push(jid)
                    } catch (err) {
                        logger.warn({ component: 'TenantManager', tenantId, jid, err }, 'Impossible d\'envoyer le lien d\'invitation par DM')
                    }
                }
            } catch (err) {
                logger.warn({ component: 'TenantManager', tenantId, err }, 'Impossible de générer le lien d\'invitation pour le fallback')
            }
        }

        logger.info(
            { component: 'TenantManager', tenantId, groupJid, added: addedJids.length, invitedByLink: invitedByLinkJids.length },
            'Groupe WhatsApp créé'
        )

        return { groupJid, addedJids, invitedByLinkJids }
    }

    /**
     * Récupère (ou génère) le code d'invitation d'un groupe.
     */
    async getGroupInviteCode(tenantId: string, groupJid: string): Promise<string> {
        const session = this.sessions.get(tenantId)
        if (!session?.isConnected || !session.sock) {
            throw new Error('Session tenant non connectée')
        }
        const code = await session.sock.groupInviteCode(groupJid)
        if (!code) throw new Error('Code d\'invitation introuvable')
        return code
    }

    /**
     * Ajoute des participants à un groupe existant. Retourne, comme à la
     * création, la liste de ceux ajoutés directement et ceux à relancer par lien.
     */
    async addGroupParticipants(
        tenantId:        string,
        groupJid:        string,
        participantsJid: string[]
    ): Promise<{ addedJids: string[]; invitedByLinkJids: string[] }> {
        const session = this.sessions.get(tenantId)
        if (!session?.isConnected || !session.sock) {
            throw new Error('Session tenant non connectée')
        }

        const results = await session.sock.groupParticipantsUpdate(groupJid, participantsJid, 'add')

        const addedJids: string[]  = []
        const failedJids: string[] = []
        for (const r of results) {
            if (!r.jid) continue
            if (r.status === '200') addedJids.push(r.jid)
            else failedJids.push(r.jid)
        }

        const invitedByLinkJids: string[] = []
        if (failedJids.length > 0) {
            try {
                const code = await session.sock.groupInviteCode(groupJid)
                if (!code) throw new Error('Code d\'invitation introuvable')
                const link = `https://chat.whatsapp.com/${code}`
                for (const jid of failedJids) {
                    try {
                        await session.sock.sendMessage(jid, { text: `Voici le lien pour rejoindre le groupe : ${link}` })
                        invitedByLinkJids.push(jid)
                    } catch { /* ignoré */ }
                }
            } catch { /* ignoré */ }
        }

        return { addedJids, invitedByLinkJids }
    }

    private async _sendTenantMedia(
        sock:      import('@whiskeysockets/baileys').WASocket,
        remoteJid: string,
        caption:   string | null,
        media:     MediaPayload
    ): Promise<unknown> {
        let mediaData: Buffer | { url: string }
        if (media.url) {
            mediaData = { url: media.url }
        } else if (media.base64) {
            mediaData = Buffer.from(media.base64, 'base64')
        } else {
            throw new Error('Média sans source')
        }

        const commonOpts = caption ? { caption } : {}

        switch (media.type) {
            case 'image':
                return sock.sendMessage(remoteJid, { image: mediaData, mimetype: media.mime, ...commonOpts })
            case 'video':
                return sock.sendMessage(remoteJid, { video: mediaData, mimetype: media.mime, ...commonOpts })
            case 'audio':
                return sock.sendMessage(remoteJid, { audio: mediaData, mimetype: media.mime, ptt: false })
            case 'document':
                return sock.sendMessage(remoteJid, { document: mediaData, mimetype: media.mime, fileName: media.name ?? 'fichier', ...commonOpts })
            default:
                throw new Error(`Type de média non supporté : ${media.type}`)
        }
    }

    // ── Getters ────────────────────────────────────────────────────────────────

    getLastQr(tenantId: string): string | null {
        return this.sessions.get(tenantId)?.lastQr ?? null
    }

    isConnected(tenantId: string): boolean {
        return this.sessions.get(tenantId)?.isConnected ?? false
    }

    getActiveCount(): number {
        return [...this.sessions.values()].filter(s => s.isConnected).length
    }

    // ── Fermeture propre d'une session ─────────────────────────────────────────

    async closeSession(tenantId: string): Promise<void> {
        const session = this.sessions.get(tenantId)
        if (!session) return

        this._closeSocket(tenantId, session.sock)
        this.sessions.delete(tenantId)
        await updateTenantStatus(tenantId, 'disconnected')
    }

    private _closeSocket(tenantId: string, sock: WASocket): void {
        const events = [
            'connection.update', 'creds.update', 'messages.upsert',
            'chats.upsert', 'contacts.upsert',
        ] as const

        for (const event of events) {
            try { sock.ev.removeAllListeners(event) } catch { /* ignoré */ }
        }
        try { sock.end(undefined) } catch { /* déjà fermé */ }

        logger.info({ component: 'TenantManager', tenantId }, 'Session tenant fermée')
    }

    // ── Envoyer un message via le numéro admin (pour notifications système) ──────
    async sendMessageAsTenantViaAdmin(phone: string, text: string): Promise<void> {
        // `phone` peut être un JID Baileys brut ("22912345678:19@s.whatsapp.net")
        // ou un numéro nu ("22912345678"). On normalise vers "XXXXXXX@s.whatsapp.net".
        const raw = phone.includes('@') ? phone.split('@')[0]! : phone
        const number = raw.split(':')[0]!.replace(/[^0-9]/g, '')
        const jid = `${number}@s.whatsapp.net`
        await this.adminManager.sendMessage(jid, text)
    }
}