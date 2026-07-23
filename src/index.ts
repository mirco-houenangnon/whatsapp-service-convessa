/**
 * index.ts — Point d'entrée du service WhatsApp Gateway.
 *
 * Séquence de démarrage :
 *   1. Valider la configuration (.env)
 *   2. Tester la connexion MySQL
 *   3. Exécuter les migrations (CREATE TABLE IF NOT EXISTS)
 *   4. Démarrer Express + Socket.io
 *   5. Initialiser WhatsAppManager (numéro admin — fixe)
 *   6. Initialiser TenantManager (sessions multi-tenant)
 *   7. Démarrer le QueueProcessor (worker FIFO)
 */

import express           from 'express'
import { createServer }  from 'http'
import { Server }        from 'socket.io'
import cors              from 'cors'
import helmet            from 'helmet'
import path              from 'path'
import { fileURLToPath } from 'url'

import { config }           from './config.js'
import { logger }           from './services/logger.js'
import { testConnection }   from './db/connection.js'
import { closePool }        from './db/connection.js'
import { runMigrations }    from './db/migrations.js'
import { WhatsAppManager }  from './whatsapp/WhatsAppManager.js'
import { TenantManager }    from './whatsapp/TenantManager.js'
import { QueueProcessor }   from './whatsapp/QueueProcessor.js'
import { SocketGateway }    from './socket/SocketGateway.js'
import { statusRouter }     from './api/routes/status.js'
import { sessionRouter }    from './api/routes/session.js'
import { messagesRouter }   from './api/routes/messages.js'
import { tenantsRouter }    from './api/routes/tenants.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Application Express ────────────────────────────────────────────────────────

const app        = express()
const httpServer = createServer(app)

const io = new Server(httpServer, {
    cors:              { origin: config.corsOrigin },
    maxHttpBufferSize: 1e5,
})

// ── Middlewares globaux ────────────────────────────────────────────────────────

app.use(helmet({
    contentSecurityPolicy: config.enableDashboard
        ? {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc:  ["'self'", "'unsafe-inline'", 'cdn.socket.io', 'unpkg.com', 'fonts.googleapis.com'],
                styleSrc:   ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
                fontSrc:    ["'self'", 'fonts.gstatic.com'],
                imgSrc:     ["'self'", 'data:'],
                connectSrc: ["'self'", 'ws:', 'wss:'],
            },
        }
        : false,
}))

app.use(cors({ origin: config.corsOrigin }))
// Limite augmentée pour les médias base64 (document PDF jusqu'à 100MB = ~133MB base64)
app.use(express.json({ limit: '150mb' }))
app.disable('x-powered-by')

// ── Dashboard HTML ─────────────────────────────────────────────────────────────

if (!config.isProd || config.enableDashboard) {
    const publicDir = path.join(__dirname, '..', 'public')
    app.use(express.static(publicDir))
    logger.info({ component: 'Server' }, `Dashboard disponible sur http://127.0.0.1:${config.port}`)
}

// ── Instances principales ──────────────────────────────────────────────────────

const waManager     = new WhatsAppManager()
const tenantManager = new TenantManager(waManager)
const processor     = new QueueProcessor(waManager)
const gateway       = new SocketGateway(io, waManager, tenantManager, processor)

// ── Routes API ─────────────────────────────────────────────────────────────────

app.use('/api/v1', statusRouter(waManager))
app.use('/api/v1', sessionRouter(waManager))
app.use('/api/v1', messagesRouter(waManager))
app.use('/api/v1', tenantsRouter(tenantManager))

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
        await testConnection()
        await runMigrations()

        gateway.setup()

        await new Promise<void>((resolve) => {
            httpServer.listen(config.port, '127.0.0.1', resolve)
        })

        logger.info(
            { component: 'Server', port: config.port, env: config.nodeEnv },
            `WhatsApp Gateway démarré → http://127.0.0.1:${config.port}`
        )

        await waManager.init()
        processor.start()

    } catch (err) {
        logger.error({ component: 'Server', err }, 'Erreur au démarrage — arrêt')
        process.exit(1)
    }
}

bootstrap()
