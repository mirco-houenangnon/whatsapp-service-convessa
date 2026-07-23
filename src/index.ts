/**
 * index.ts — Point d'entrée du service WhatsApp.
 *
 * Séquence de démarrage :
 *   1. Valider la configuration (.env)
 *   2. Tester la connexion MySQL
 *   3. Exécuter les migrations (CREATE TABLE IF NOT EXISTS)
 *   4. Démarrer Express + Socket.io
 *   5. Initialiser WhatsAppManager (restauration session ou nouveau QR)
 *   6. Démarrer le QueueProcessor (worker FIFO)
 */

import express          from 'express'
import { createServer } from 'http'
import { Server }       from 'socket.io'
import cors             from 'cors'
import helmet           from 'helmet'
import path             from 'path'
import { fileURLToPath } from 'url'

import { config }          from './config.js'
import { logger }          from './services/logger.js'
import { testConnection }  from './db/connection.js'
import { closePool }       from './db/connection.js'
import { runMigrations }   from './db/migrations.js'
import { WhatsAppManager } from './whatsapp/WhatsAppManager.js'
import { QueueProcessor }  from './whatsapp/QueueProcessor.js'
import { SocketGateway }   from './socket/SocketGateway.js'
import { statusRouter }    from './api/routes/status.js'
import { sessionRouter }   from './api/routes/session.js'
import { messagesRouter }  from './api/routes/messages.js'
import { authRouter }      from './api/routes/auth.js'
import { docsRouter }      from './api/routes/docs.js'

// Initialise Firebase Admin SDK au démarrage
import './services/firebase.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Application Express ────────────────────────────────────────────────────────

const app        = express()
const httpServer = createServer(app)

const io = new Server(httpServer, {
    cors:               { origin: config.corsOrigin },
    maxHttpBufferSize:  1e5,   // 100 KB — protection DoS
})

// ── Middlewares globaux ────────────────────────────────────────────────────────

app.use(helmet({
    contentSecurityPolicy: config.enableDashboard
        ? {
            directives: {
                defaultSrc:      ["'self'"],
                // gstatic.com = Firebase JS SDK CDN | 'unsafe-hashes' = inline event handlers (onclick=...)
                scriptSrc:       ["'self'", "'unsafe-inline'", "'unsafe-hashes'",
                                  'cdn.socket.io', 'unpkg.com', 'fonts.googleapis.com',
                                  'www.gstatic.com', 'apis.google.com'],
                scriptSrcAttr:   ["'unsafe-inline'"],
                styleSrc:        ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
                fontSrc:         ["'self'", 'fonts.gstatic.com'],
                imgSrc:          ["'self'", 'data:', 'https:'],
                connectSrc:      ["'self'", 'ws:', 'wss:', 'https://identitytoolkit.googleapis.com',
                                  'https://securetoken.googleapis.com', 'https://*.firebaseio.com'],
                frameSrc:        ["'self'", 'https://whatsappservice-50e51.firebaseapp.com',
                                  'https://accounts.google.com'],
            },
        }
        : false,
}))

app.use(cors({ origin: config.corsOrigin }))
app.use(express.json({ limit: '10kb' }))
app.disable('x-powered-by')

// ── Dashboard HTML (désactivé en production par défaut) ───────────────────────

if (!config.isProd || config.enableDashboard) {
    const publicDir = path.join(__dirname, '..', 'public')
    app.use(express.static(publicDir))
    logger.info({ component: 'Server' }, `Dashboard disponible sur http://127.0.0.1:${config.port}`)
}

// ── Instances principales ──────────────────────────────────────────────────────

const waManager = new WhatsAppManager()
const processor = new QueueProcessor(waManager)
const gateway   = new SocketGateway(io, waManager, processor)

// ── Routes API ─────────────────────────────────────────────────────────────────

app.use('/api/v1', statusRouter(waManager))
app.use('/api/v1', sessionRouter(waManager))
app.use('/api/v1', messagesRouter(waManager))
app.use('/api/v1', authRouter())
app.use('/api/v1', docsRouter())

// ── Route 404 ──────────────────────────────────────────────────────────────────

app.use((_req, res) => {
    res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Route introuvable' },
    })
})

// ── Gestion des erreurs non catchées ──────────────────────────────────────────

process.on('uncaughtException', (err) => {
    logger.error({ component: 'Process', err }, 'Exception non catchée')
})

process.on('unhandledRejection', (reason) => {
    logger.error({ component: 'Process', reason }, 'Promise rejetée non gérée')
})

// ── Arrêt propre ───────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
    logger.info({ component: 'Server' }, 'Arrêt du service...')
    processor.stop()
    await closePool()
    process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)

// ── Démarrage ──────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
    try {
        // 1. Vérifier la connexion MySQL
        await testConnection()

        // 2. Migrations
        await runMigrations()

        // 3. Socket.io
        gateway.setup()

        // 4. Démarrage du serveur HTTP
        await new Promise<void>((resolve) => {
            httpServer.listen(config.port, '127.0.0.1', resolve)
        })

        logger.info(
            { component: 'Server', port: config.port, env: config.nodeEnv },
            `WhatsApp Service démarré → http://127.0.0.1:${config.port}`
        )

        // 5. Initialisation WhatsApp
        await waManager.init()

        // 6. Démarrage du worker de file d'attente
        processor.start()

    } catch (err) {
        logger.error({ component: 'Server', err }, 'Erreur au démarrage — arrêt')
        process.exit(1)
    }
}

bootstrap()
