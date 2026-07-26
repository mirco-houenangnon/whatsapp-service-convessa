/**
 * SocketGateway.ts — Gestion Socket.io avec authentification au handshake.
 * Supporte les événements admin (numéro fixe) et tenant (multi-sessions).
 */

import type { Server, Socket } from 'socket.io'
import qrcode                  from 'qrcode'

import { config }           from '../config.js'
import { logger }           from '../services/logger.js'
import { WhatsAppManager }  from '../whatsapp/WhatsAppManager.js'
import { TenantManager }    from '../whatsapp/TenantManager.js'
import { QueueProcessor }   from '../whatsapp/QueueProcessor.js'

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }
    return diff === 0
}

export class SocketGateway {

    constructor(
        private readonly io:            Server,
        private readonly waManager:     WhatsAppManager,
        private readonly tenantManager: TenantManager,
        private readonly processor:     QueueProcessor,
    ) {}

    setup(): void {
        // ── Authentification au handshake ────────────────────────────────────
        this.io.use((socket, next) => {
            if (!config.bridgeApiKey) { next(); return }
            const token = socket.handshake.auth['token'] as string | undefined
            if (!token || !timingSafeEqual(token, config.bridgeApiKey)) {
                next(new Error('Authentification Socket.io invalide'))
                return
            }
            next()
        })

        // ── Connexion client ─────────────────────────────────────────────────
        this.io.on('connection', async (socket: Socket) => {
            logger.info({ component: 'Socket.io', socketId: socket.id }, 'Client connecté')

            // État admin immédiat
            socket.emit('status_update', this.waManager.getStatus())

            // QR admin en cache si disponible
            const cachedQr = this.waManager.getLastQr()
            if (cachedQr) {
                try {
                    socket.emit('qr', await qrcode.toDataURL(cachedQr))
                } catch { /* ignoré */ }
            }

            // ── Listeners admin ──────────────────────────────────────────────
            const onQr = async (qr: string) => {
                try { socket.emit('qr', await qrcode.toDataURL(qr)) } catch { /* ignoré */ }
            }
            const onReady        = (status: unknown) => { socket.emit('ready', status); this.io.emit('status_update', status) }
            const onLoggedOut    = (data: unknown)   => { this.io.emit('logged_out', data); this.io.emit('status_update', this.waManager.getStatus()) }
            const onStatusUpdate = (status: unknown) => { this.io.emit('status_update', status) }
            const onMessage      = (m: unknown)      => { socket.emit('message_received', m) }

            this.waManager.on('qr',           onQr)
            this.waManager.on('ready',         onReady)
            this.waManager.on('logged_out',    onLoggedOut)
            this.waManager.on('status_update', onStatusUpdate)
            this.waManager.on('message',       onMessage)

            // ── Listeners tenant ─────────────────────────────────────────────
            const onTenantQr = async (tenantId: string, qr: string) => {
                try {
                    const qrBase64 = await qrcode.toDataURL(qr)
                    socket.emit('tenant_qr', { tenantId, qrCode: qrBase64 })
                } catch { /* ignoré */ }
            }

            const onTenantConnected = (tenantId: string, data: unknown) => {
                // Broadcast à TOUS les clients connectés (pas seulement le socket courant)
                // Le frontend peut avoir changé de socket pendant le temps du scan QR
                this.io.emit('tenant_connected', { tenantId, ...( typeof data === 'object' ? data : {}) })
                this.io.emit('tenant_status_update', { tenantId, status: 'connected', ...(typeof data === 'object' ? data : {}) })
            }

            const onTenantDisconnected = (tenantId: string, reason: string) => {
                this.io.emit('tenant_status_update', { tenantId, status: 'disconnected', reason })
            }

            const onTenantError = (tenantId: string, data: unknown) => {
                this.io.emit('tenant_error', { tenantId, ...(typeof data === 'object' ? data : {}) })
            }

            // Abonnement activé après paiement
            const onSubscriptionActivated = (tenantId: string, data: unknown) => {
                this.io.emit('subscription_activated', { tenantId, ...(typeof data === 'object' ? data : {}) })
            }

            // Statut final d'un message tenant (sent/failed) — émis par send.ts
            // une fois que Baileys a réellement résolu l'envoi. Découple le
            // résultat réel de la réponse HTTP immédiate de POST /api/v1/send.
            const onMessageStatus = (tenantId: string, data: unknown) => {
                this.io.emit('message_status', { tenantId, ...(typeof data === 'object' ? data : {}) })
            }

            this.tenantManager.on('qr',                    onTenantQr)
            this.tenantManager.on('connected',              onTenantConnected)
            this.tenantManager.on('disconnected',           onTenantDisconnected)
            this.tenantManager.on('error',                  onTenantError)
            this.tenantManager.on('message_status',         onMessageStatus)
            this.tenantManager.on('subscription_activated', onSubscriptionActivated)

            // ── Nettoyage à la déconnexion ───────────────────────────────────
            socket.on('disconnect', () => {
                logger.info({ component: 'Socket.io', socketId: socket.id }, 'Client déconnecté')
                this.waManager.off('qr',           onQr)
                this.waManager.off('ready',        onReady)
                this.waManager.off('logged_out',   onLoggedOut)
                this.waManager.off('status_update', onStatusUpdate)
                this.waManager.off('message',      onMessage)
                this.tenantManager.off('qr',                    onTenantQr)
                this.tenantManager.off('connected',              onTenantConnected)
                this.tenantManager.off('disconnected',           onTenantDisconnected)
                this.tenantManager.off('error',                  onTenantError)
                this.tenantManager.off('message_status',         onMessageStatus)
                this.tenantManager.off('subscription_activated', onSubscriptionActivated)
            })
        })

        this.processor.attachIO(this.io)
    }

    broadcast(event: string, data: unknown): void {
        this.io.emit(event, data)
    }
}
