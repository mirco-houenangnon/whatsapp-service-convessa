/**
 * QueueProcessor.ts — Worker FIFO de la file d'attente.
 *
 * - Un seul message envoyé à la fois (aucune concurrence)
 * - Délai aléatoire configurable entre chaque envoi
 * - Retry avec backoff exponentiel (max 3 tentatives)
 * - Pause automatique si WhatsApp se déconnecte
 */

import { config }          from '../config.js'
import { logger }          from '../services/logger.js'
import { normalizePhone }  from '../services/phoneUtils.js'
import { WhatsAppManager } from './WhatsAppManager.js'
import {
    dequeueNext,
    updateStatus,
    requeueWithDelay,
    getQueueStats,
    type QueuedMessage,
} from '../db/MessageQueue.js'

const RETRY_DELAYS = [5_000, 15_000, 60_000] as const  // backoff retry : 5s, 15s, 60s

export class QueueProcessor {

    private running:   boolean = false
    private paused:    boolean = false
    private timer:     ReturnType<typeof setTimeout> | null = null
    private io:        { emit: (event: string, data: unknown) => void } | null = null

    constructor(private readonly waManager: WhatsAppManager) {}

    /**
     * Attache l'instance Socket.io pour les notifications temps réel.
     */
    attachIO(io: { emit: (event: string, data: unknown) => void }): void {
        this.io = io
    }

    start(): void {
        if (this.running) return
        this.running = true
        logger.info({ component: 'QueueProcessor' }, 'Worker démarré')
        this._scheduleNext(0)
    }

    stop(): void {
        this.running = false
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
        logger.info({ component: 'QueueProcessor' }, 'Worker arrêté')
    }

    // ── Traitement ─────────────────────────────────────────────────────────────

    private _scheduleNext(delayMs: number): void {
        if (!this.running) return
        this.timer = setTimeout(() => this._processNext(), delayMs)
    }

    private async _processNext(): Promise<void> {
        if (!this.running) return

        // Si WhatsApp n'est pas connecté, on attend avant de réessayer
        if (!this.waManager.isReady()) {
            if (!this.paused) {
                this.paused = true
                logger.warn({ component: 'QueueProcessor' }, 'WhatsApp déconnecté — file en pause')
            }
            this._scheduleNext(5_000)
            return
        }

        if (this.paused) {
            this.paused = false
            logger.info({ component: 'QueueProcessor' }, 'WhatsApp reconnecté — reprise de la file')
        }

        const msg = await dequeueNext()

        if (!msg) {
            // File vide — polling toutes les 2 secondes
            this._scheduleNext(2_000)
            return
        }

        logger.info(
            { component: 'QueueProcessor', messageId: msg.id, attempts: msg.attempts },
            'Traitement message'
        )

        // Marquer comme en cours d'envoi
        await updateStatus(msg.id, 'sending')
        this.io?.emit('queue_update', { messageId: msg.id, status: 'sending' })

        try {
            const sock = this.waManager.getSocket()
            if (!sock) throw new Error('Socket indisponible')

            // Résolution du JID WhatsApp — normalizePhone gère le 0 de tête local
            const cleanRecipient = normalizePhone(msg.recipient)
            const jid             = `${cleanRecipient}@s.whatsapp.net`
            const waResults       = await sock.onWhatsApp(jid)
            const found           = waResults?.[0]

            if (!found?.exists) {
                // Numéro non trouvé sur WhatsApp — échec définitif (pas de retry)
                await updateStatus(msg.id, 'failed', {
                    lastError: 'PHONE_NOT_ON_WHATSAPP',
                })
                this.io?.emit('queue_update', { messageId: msg.id, status: 'failed', error: 'PHONE_NOT_ON_WHATSAPP' })
                logger.warn({ component: 'QueueProcessor', messageId: msg.id }, 'Numéro absent de WhatsApp')

            } else {
                // Envoi du message
                await this.waManager.sendMessage(found.jid, msg.message, msg.media ?? undefined)

                await updateStatus(msg.id, 'sent', {
                    jid:    found.jid,
                    sentAt: new Date(),
                })

                const stats = await getQueueStats()
                this.io?.emit('queue_update', { messageId: msg.id, status: 'sent' })
                this.io?.emit('status_update_queue', stats)

                logger.info({ component: 'QueueProcessor', messageId: msg.id }, 'Message envoyé ✅')
            }

        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : 'Erreur inconnue'
            logger.error({ component: 'QueueProcessor', messageId: msg.id, err }, 'Échec envoi')

            const attempts = msg.attempts + 1

            if (attempts >= config.queue.maxRetry) {
                // Échec définitif
                await updateStatus(msg.id, 'failed', { lastError: errorMsg })
                this.io?.emit('queue_update', { messageId: msg.id, status: 'failed', error: errorMsg })
                logger.warn(
                    { component: 'QueueProcessor', messageId: msg.id, attempts },
                    'Tentatives épuisées — message abandonné'
                )
            } else {
                // Retry avec backoff
                const retryDelay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)] ?? 60_000
                await requeueWithDelay(msg.id, retryDelay)
                logger.info(
                    { component: 'QueueProcessor', messageId: msg.id, attempts, retryDelay },
                    `Retry dans ${retryDelay / 1000}s`
                )
            }
        }

        // Délai aléatoire avant le prochain message (comportement humain)
        const delay = this._randomDelay()
        this._scheduleNext(delay)
    }

    private _randomDelay(): number {
        const { delayMs, delayMaxMs } = config.queue
        if (delayMaxMs <= delayMs) return delayMs
        return Math.floor(Math.random() * (delayMaxMs - delayMs + 1)) + delayMs
    }
}
