/**
 * WhatsAppManager.ts — Gestionnaire de connexion Baileys.
 *
 * - Session persistée en MySQL (chiffrée AES-256-GCM)
 * - Reconnexion automatique avec backoff exponentiel
 * - Détection déconnexion définitive → alerte e-mail
 * - Guard isInitializing contre les race conditions
 */

import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    type WASocket,
} from '@whiskeysockets/baileys'
import { Boom }          from '@hapi/boom'
import pino              from 'pino'
import { EventEmitter }  from 'events'

import { config }                                              from '../config.js'
import { logger, maskPhone }                                   from '../services/logger.js'
import { sendDisconnectAlert }                                 from '../services/mailer.js'
import {
    useDbAuthState,
    updateSessionStatus,
    deleteSession,
    type SessionStatus,
} from '../db/SessionStore.js'

const SESSION_ID = 'primary'

// Logger silencieux pour Baileys (on gère nos propres logs)
const baileysLogger = pino({ level: 'silent' })

// Délais de reconnexion : 1s, 2s, 4s, 8s, 16s, 30s max
const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const

export type ConnectionStatus =
    | { status: 'connected';    phone: string; name: string; connectedAt: string }
    | { status: 'disconnected'; reason?: string }
    | { status: 'awaiting_qr' }

export class WhatsAppManager extends EventEmitter {

    private sock:              WASocket | null = null
    private isConnected:       boolean         = false
    private isInitializing:    boolean         = false
    private reconnectAttempt:  number          = 0
    private connectedAt:       string | null   = null
    private connectedPhone:    string | null   = null
    private connectedName:     string | null   = null
    private alertSentForEvent: boolean         = false  // évite le doublon d'alerte

    constructor() {
        super()
        this.setMaxListeners(50)
    }

    // ── Initialisation ─────────────────────────────────────────────────────────

    async init(): Promise<void> {
        if (this.isInitializing) {
            logger.debug({ component: 'WhatsAppManager' }, 'Init déjà en cours — ignoré')
            return
        }

        this.isInitializing   = true
        this.alertSentForEvent = false

        try {
            if (this.sock) {
                this._closeSocket(this.sock)
                this.sock = null
            }

            const { state, saveCreds } = await useDbAuthState(SESSION_ID)
            const { version }          = await fetchLatestBaileysVersion()

            logger.info({ component: 'WhatsAppManager', version: version.join('.') }, 'Démarrage Baileys')

            this.sock = makeWASocket({
                version,
                logger: baileysLogger,
                auth:   state,
                syncFullHistory: false,
            })

            // ── Événements de connexion ──────────────────────────────────────
            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update

                if (qr) {
                    this.isConnected = false
                    this.emit('qr', qr)
                    await updateSessionStatus(SESSION_ID, 'disconnected')
                }

                if (connection === 'close') {
                    this.isConnected     = false
                    this.connectedPhone  = null
                    this.connectedName   = null
                    this.connectedAt     = null

                    const statusCode      = (lastDisconnect?.error as Boom)?.output?.statusCode
                    const isLoggedOut     = statusCode === DisconnectReason.loggedOut
                    const shouldReconnect = !isLoggedOut

                    logger.warn(
                        { component: 'WhatsAppManager', statusCode, shouldReconnect },
                        `Connexion fermée — code: ${statusCode ?? 'inconnu'}`
                    )

                    if (isLoggedOut) {
                        // Déconnexion définitive — session révoquée par WhatsApp
                        await updateSessionStatus(SESSION_ID, 'revoked')
                        this.emit('logged_out', { reason: 'session_revoked' })

                        // Alerte e-mail une seule fois par événement
                        if (!this.alertSentForEvent && config.alert) {
                            this.alertSentForEvent = true
                            await sendDisconnectAlert(config.alert, {
                                phone:      maskPhone(this.connectedPhone ?? 'inconnu'),
                                reason:     'Session révoquée par WhatsApp (loggedOut)',
                                occurredAt: new Date().toISOString(),
                            })
                        }

                        setTimeout(() => this.init(), 500)

                    } else {
                        // Déconnexion temporaire — tentative de reconnexion
                        await updateSessionStatus(SESSION_ID, 'disconnected')
                        this.emit('status_update', { status: 'disconnected', reason: 'network' })

                        const delay = RECONNECT_DELAYS[
                            Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
                        ] ?? 30_000
                        this.reconnectAttempt++

                        logger.info(
                            { component: 'WhatsAppManager', attempt: this.reconnectAttempt, delayMs: delay },
                            `Reconnexion dans ${delay / 1000}s...`
                        )

                        setTimeout(() => this.init(), delay)
                    }

                } else if (connection === 'open') {
                    this.isConnected      = true
                    this.reconnectAttempt = 0
                    this.connectedAt      = new Date().toISOString()
                    this.connectedPhone   = this.sock?.user?.id   ?? null
                    this.connectedName    = this.sock?.user?.name ?? null

                    await updateSessionStatus(SESSION_ID, 'active', {
                        phone:       this.connectedPhone ?? undefined,
                        displayName: this.connectedName  ?? undefined,
                    })

                    logger.info(
                        {
                            component: 'WhatsAppManager',
                            phone:     maskPhone(this.connectedPhone ?? ''),
                            name:      this.connectedName,
                        },
                        'WhatsApp connecté ✅'
                    )

                    this.emit('ready', this.getStatus())
                    this.emit('status_update', this.getStatus())
                }
            })

            this.sock.ev.on('creds.update', saveCreds)

            this.sock.ev.on('messages.upsert', (m) => {
                if (m.type === 'notify') {
                    this.emit('message', m)
                }
            })

        } catch (err) {
            logger.error({ component: 'WhatsAppManager', err }, 'Erreur initialisation')

            const delay = RECONNECT_DELAYS[
                Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
            ] ?? 30_000
            this.reconnectAttempt++

            setTimeout(() => this.init(), delay)

        } finally {
            this.isInitializing = false
        }
    }

    // ── Déconnexion ────────────────────────────────────────────────────────────

    async logout(): Promise<void> {
        this.isConnected    = false
        this.connectedPhone = null
        this.connectedName  = null
        this.connectedAt    = null

        if (this.sock) {
            try { await this.sock.logout() } catch { /* déjà invalide */ }
            this._closeSocket(this.sock)
            this.sock = null
        }

        await deleteSession(SESSION_ID)
        this.emit('logged_out', { reason: 'logged_out' })

        setTimeout(() => this.init(), 500)
    }

    // ── Envoi de message ───────────────────────────────────────────────────────

    async sendMessage(
        remoteJid: string,
        text: string,
        timeoutMs = 15_000
    ): Promise<void> {
        if (!this.sock)        throw new Error('Socket non initialisé')
        if (!this.isConnected) throw new Error('WhatsApp non connecté')

        const send    = this.sock.sendMessage(remoteJid, { text })
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout après ${timeoutMs}ms`)), timeoutMs)
        )

        await Promise.race([send, timeout])
    }

    // ── Statut ─────────────────────────────────────────────────────────────────

    getStatus(): ConnectionStatus {
        if (this.isConnected && this.connectedPhone) {
            return {
                status:      'connected',
                phone:       maskPhone(this.connectedPhone),
                name:        this.connectedName ?? '',
                connectedAt: this.connectedAt ?? new Date().toISOString(),
            }
        }
        return { status: 'disconnected' }
    }

    isReady(): boolean {
        return this.isConnected && this.sock !== null
    }

    getSocket(): WASocket | null {
        return this.sock
    }

    // ── Utilitaires privés ─────────────────────────────────────────────────────

    private _closeSocket(sock: WASocket): void {
        const events = [
            'connection.update', 'creds.update', 'messaging-history.set',
            'chats.upsert', 'chats.update', 'chats.delete', 'presence.update',
            'contacts.upsert', 'contacts.update', 'messages.delete',
            'messages.update', 'messages.media-update', 'messages.upsert',
            'messages.reaction', 'message-receipt.update', 'groups.upsert',
            'groups.update', 'group-participants.update', 'blocklist.set',
            'blocklist.update', 'call', 'labels.edit', 'labels.association',
            'settings.update',
        ] as const

        for (const event of events) {
            try { sock.ev.removeAllListeners(event) } catch { /* ignoré */ }
        }
        try { sock.end(undefined) } catch { /* déjà fermé */ }
    }
}
