/**
 * SocketGateway.ts — Gestion Socket.io avec authentification au handshake.
 *
 * La connexion est refusée si le token fourni au handshake ne correspond
 * pas à BRIDGE_API_KEY. En mode développement sans clé définie, tout client
 * est accepté.
 */

import type { Server, Socket } from 'socket.io'
import qrcode                  from 'qrcode'

import { config }          from '../config.js'
import { logger }          from '../services/logger.js'
import { WhatsAppManager } from '../whatsapp/WhatsAppManager.js'
import { QueueProcessor }  from '../whatsapp/QueueProcessor.js'

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
        private readonly io:         Server,
        private readonly waManager:  WhatsAppManager,
        private readonly processor:  QueueProcessor,
    ) {}

    setup(): void {
        // ── Authentification au handshake ────────────────────────────────────
        this.io.use((socket, next) => {
            if (!config.bridgeApiKey) {
                // Mode développement sans clé — tout le monde passe
                next()
                return
            }

            const token = socket.handshake.auth['token'] as string | undefined

            if (!token || !timingSafeEqual(token, config.bridgeApiKey)) {
                next(new Error('Authentification Socket.io invalide'))
                return
            }

            next()
        })

        // ── Connexion client ─────────────────────────────────────────────────
        this.io.on('connection', (socket: Socket) => {
            logger.info({ component: 'Socket.io', socketId: socket.id }, 'Client connecté')

            // Envoyer l'état immédiatement
            socket.emit('status_update', this.waManager.getStatus())

            // ── Listeners WhatsApp → ce client ──────────────────────────────
            const onQr = async (qr: string) => {
                try {
                    const qrImage = await qrcode.toDataURL(qr)
                    socket.emit('qr', qrImage)
                } catch (e) {
                    logger.error({ component: 'Socket.io', e }, 'Erreur génération QR')
                }
            }

            const onReady = (status: unknown) => {
                socket.emit('ready', status)
                this.io.emit('status_update', status)
            }

            const onLoggedOut = (data: unknown) => {
                this.io.emit('logged_out', data)
                this.io.emit('status_update', this.waManager.getStatus())
            }

            const onStatusUpdate = (status: unknown) => {
                this.io.emit('status_update', status)
            }

            const onMessage = (m: unknown) => {
                socket.emit('message_received', m)
            }

            this.waManager.on('qr',           onQr)
            this.waManager.on('ready',         onReady)
            this.waManager.on('logged_out',    onLoggedOut)
            this.waManager.on('status_update', onStatusUpdate)
            this.waManager.on('message',       onMessage)

            // ── Nettoyage à la déconnexion ───────────────────────────────────
            socket.on('disconnect', () => {
                logger.info({ component: 'Socket.io', socketId: socket.id }, 'Client déconnecté')
                this.waManager.off('qr',           onQr)
                this.waManager.off('ready',        onReady)
                this.waManager.off('logged_out',   onLoggedOut)
                this.waManager.off('status_update', onStatusUpdate)
                this.waManager.off('message',      onMessage)
            })
        })

        // Attacher le QueueProcessor au Socket.io pour les mises à jour temps réel
        this.processor.attachIO(this.io)
    }

    broadcast(event: string, data: unknown): void {
        this.io.emit(event, data)
    }
}
