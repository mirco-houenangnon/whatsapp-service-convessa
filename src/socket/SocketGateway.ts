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
        // ── Authentification au handshake ────────────────────────────────────
        // En production, l'authentification est obligatoire si BRIDGE_API_KEY est défini
        // En développement avec dashboard activé, on autorise les connexions locales sans token
        this.io.use((socket, next) => {
            // Si pas de clé API configurée, on laisse passer
            if (!config.bridgeApiKey) { next(); return }
            
            // En mode développement avec dashboard, on autorise les connexions sans token
            const isDashboardRequest = config.enableDashboard && !config.isProd
            
            const token = socket.handshake.auth['token'] as string | undefined
            
            // Si dashboard en dev, on accepte les connexions sans token
            if (isDashboardRequest && !token) {
                next()
                return
            }
            
            // Sinon, on vérifie le token
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
                    // Le QR peut être une URL (Baileys récent) ou une chaîne encodée
                    const qrData = cachedQr.startsWith('http') ? cachedQr : cachedQr
                    socket.emit('qr', await qrcode.toDataURL(qrData))
                    logger.info({ component: 'Socket.io' }, 'QR code en cache envoyé au client')
                } catch (err) { 
                    logger.error({ component: 'Socket.io', err }, 'Erreur génération QR en cache')
                }
            }

            // ── Listeners admin ──────────────────────────────────────────────
            const onQr = async (qr: string) => {
                try { 
                    const qrData = qr.startsWith('http') ? qr : qr
                    const qrImage = await qrcode.toDataURL(qrData)
                    socket.emit('qr', qrImage)
                    logger.info({ component: 'Socket.io' }, 'QR code envoyé au client')
                } catch (err) { 
                    logger.error({ component: 'Socket.io', err }, 'Erreur génération QR')
                }
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
                socket.emit('tenant_connected', { tenantId, ...( typeof data === 'object' ? data : {}) })
                this.io.emit('tenant_status_update', { tenantId, status: 'connected', ...(typeof data === 'object' ? data : {}) })
            }

            const onTenantDisconnected = (tenantId: string, reason: string) => {
                this.io.emit('tenant_status_update', { tenantId, status: 'disconnected', reason })
            }

            this.tenantManager.on('qr',          onTenantQr)
            this.tenantManager.on('connected',    onTenantConnected)
            this.tenantManager.on('disconnected', onTenantDisconnected)

            // ── Nettoyage à la déconnexion ───────────────────────────────────
            socket.on('disconnect', () => {
                logger.info({ component: 'Socket.io', socketId: socket.id }, 'Client déconnecté')
                this.waManager.off('qr',           onQr)
                this.waManager.off('ready',        onReady)
                this.waManager.off('logged_out',   onLoggedOut)
                this.waManager.off('status_update', onStatusUpdate)
                this.waManager.off('message',      onMessage)
                this.tenantManager.off('qr',          onTenantQr)
                this.tenantManager.off('connected',    onTenantConnected)
                this.tenantManager.off('disconnected', onTenantDisconnected)
            })
        })

        this.processor.attachIO(this.io)
    }

    broadcast(event: string, data: unknown): void {
        this.io.emit(event, data)
    }
}
