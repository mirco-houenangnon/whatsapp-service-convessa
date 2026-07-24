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
import { useDbAuthState }          from '../db/SessionStore.js'
import {
    getTenantById,
    getTenantByWhatsAppJid,
    updateTenantStatus,
    updateTenantPhone,
    setTenantApiKey,
    type Tenant,
} from '../db/TenantStore.js'
import { WhatsAppManager }         from './WhatsAppManager.js'
import type { MediaPayload }       from '../db/MessageQueue.js'

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

                    const rawPhone = session.phone?.split('@')[0]?.replace(/[^0-9]/g, '') ?? null

                    logger.info(
                        { component: 'TenantManager', tenantId, phone: maskPhone(rawPhone ?? '') },
                        'Tenant connecté ✅'
                    )

                    // ── Vérifier que ce numéro WhatsApp n'est pas déjà utilisé par un autre tenant ──
                    if (rawPhone) {
                        const existingTenant = await getTenantByWhatsAppJid(session.phone ?? '', tenantId)
                        if (existingTenant) {
                            logger.warn(
                                { component: 'TenantManager', tenantId, conflictTenantId: existingTenant.id, phone: maskPhone(rawPhone) },
                                'Numéro WhatsApp déjà actif sur un autre tenant — connexion refusée'
                            )
                            // Fermer la session immédiatement et marquer comme révoquée
                            try { sock.end(undefined) } catch { /* ignoré */ }
                            session.isConnected = false
                            await updateTenantStatus(tenantId, 'disconnected')
                            this.emit('error', tenantId, {
                                code:    'PHONE_ALREADY_IN_USE',
                                message: 'Ce numéro WhatsApp est déjà associé à un autre compte.',
                            })
                            return
                        }

                        // Mettre à jour le numéro réel du tenant (peut différer si création sans phone)
                        await updateTenantPhone(tenantId, rawPhone)
                    }

                    await updateTenantStatus(tenantId, 'connected')

                    // Générer la clé API
                    const tenant = await getTenantById(tenantId)
                    if (!tenant) return

                    // Si première connexion (pas encore de clé API)
                    if (!tenant.apiKeyHash) {
                        await this._onFirstConnection(tenant, session)
                    } else {
                        this.emit('connected', tenantId, { phone: maskPhone(rawPhone ?? '') })
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

    // ── Première connexion — génération clé API + notifications ───────────────

    private async _onFirstConnection(tenant: Tenant, session: TenantSession): Promise<void> {
        const { token, hash, hint } = generateApiKey()

        await setTenantApiKey(tenant.id, hash, hint, token)

        logger.info({ component: 'TenantManager', tenantId: tenant.id }, 'Clé API générée')

        // Notifier via webhook si configuré
        if (tenant.webhookUrl) {
            this._callWebhook(tenant.webhookUrl, {
                event:       'tenant.connected',
                tenantId:    tenant.id,
                phone:       maskPhone(session.phone ?? ''),
                apiKey:      token,
                apiKeyHint:  hint,
                connectedAt: new Date().toISOString(),
            })
        }

        // Émettre via Socket.io — le frontend récupère la clé ici
        this.emit('connected', tenant.id, {
            phone:      maskPhone(session.phone ?? ''),
            apiKey:     token,
            apiKeyHint: hint,
        })

        logger.info(
            { component: 'TenantManager', tenantId: tenant.id, hint },
            'Tenant activé — clé API transmise via Socket.io et webhook'
        )
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

    async sendMessageAsTenant(
        tenantId:  string,
        remoteJid: string,
        text:      string | null,
        media?:    MediaPayload,
        timeoutMs = 15_000
    ): Promise<void> {
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
            setTimeout(() => reject(new Error(`Timeout après ${timeoutMs}ms`)), timeoutMs)
        )

        await Promise.race([sendPromise, timeout])
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
}
