/**
 * index.ts — Point d'entrée du service WhatsApp Gateway.
 *
 * Séquence de démarrage :
 *   1. Valider la configuration (.env)
 *   2. Tester la connexion PostgreSQL (Neon)
 *   3. Exécuter les migrations (CREATE TABLE IF NOT EXISTS)
 *   4. Démarrer Express + Socket.io
 *   5. Initialiser WhatsAppManager (numéro admin — fixe)
 *   6. Initialiser TenantManager (sessions multi-tenant)
 *   7. Démarrer le QueueProcessor (worker FIFO)
 *   8. Firebase Admin SDK (auth multiplateforme)
 */

import express           from 'express'
import { createServer }  from 'http'
import { Server }        from 'socket.io'
import cors              from 'cors'
import helmet            from 'helmet'
import path              from 'path'
import { fileURLToPath } from 'url'

import { config }          from './config.js'
import { logger }          from './services/logger.js'
import { testConnection }  from './db/connection.js'
import { closePool }       from './db/connection.js'
import { runMigrations }   from './db/migrations.js'
import { WhatsAppManager } from './whatsapp/WhatsAppManager.js'
import { TenantManager }   from './whatsapp/TenantManager.js'
import { QueueProcessor }  from './whatsapp/QueueProcessor.js'
import { SocketGateway }   from './socket/SocketGateway.js'
import { statusRouter }    from './api/routes/status.js'
import { sessionRouter }   from './api/routes/session.js'
import { messagesRouter }  from './api/routes/messages.js'
import { tenantsRouter }   from './api/routes/tenants.js'
import { authRouter }      from './api/routes/auth.js'
import { docsRouter }      from './api/routes/docs.js'
import { adminRouter }     from './api/routes/admin.js'
import { adminDbRouter }       from './api/routes/adminDb.js'
import { adminProfilesRouter } from './api/routes/adminProfiles.js'
import { sendRouter }      from './api/routes/send.js'
import { groupsRouter }    from './api/routes/groups.js'
import { plansRouter }     from './api/routes/plans.js'
import { paymentsRouter }  from './api/routes/payments.js'
import { contactRouter }   from './api/routes/contact.js'

// Initialise Firebase Admin SDK au démarrage
import './services/firebase.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Application Express ───────────────────────────────────────────────────────

const app        = express()
const httpServer = createServer(app)

const io = new Server(httpServer, {
    cors: {
        origin:      config.corsOrigin,
        credentials: true,
    },
    maxHttpBufferSize: 1e5,
})

// ── Middlewares globaux ───────────────────────────────────────────────────────

app.use(helmet({
    // Cross-Origin-Opener-Policy doit être 'unsafe-none' pour permettre aux
    // popups Firebase OAuth (Google, GitHub) de communiquer avec la fenêtre parente.
    crossOriginOpenerPolicy: { policy: 'unsafe-none' },

    // Autoriser l'iframe depuis le même domaine (admin → panel whatsapp)
    frameguard: { action: 'sameorigin' },

    contentSecurityPolicy: config.enableDashboard
        ? {
            directives: {
                defaultSrc:    ["'self'"],
                scriptSrc:     ["'self'", "'unsafe-inline'", "'unsafe-hashes'",
                                'cdn.socket.io', 'unpkg.com', 'fonts.googleapis.com',
                                'www.gstatic.com', 'apis.google.com'],
                scriptSrcAttr: ["'unsafe-inline'"],
                styleSrc:      ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
                fontSrc:       ["'self'", 'fonts.gstatic.com'],
                imgSrc:        ["'self'", 'data:', 'https:'],
                connectSrc:    ["'self'", 'ws:', 'wss:',
                                'https://identitytoolkit.googleapis.com',
                                'https://securetoken.googleapis.com',
                                'https://*.firebaseio.com',
                                'https://cdn.socket.io',
                                'https://unpkg.com'],
                frameSrc:      ["'self'",
                                'https://whatsappservice-50e51.firebaseapp.com',
                                'https://accounts.google.com'],
                // Autoriser la page à être chargée dans une iframe du même domaine
                frameAncestors: ["'self'"],
            },
        }
        : false,
}))

app.use(cors({
    origin:      config.corsOrigin,
    credentials: true,
}))
// Autoriser les requêtes Private Network Access (Chrome 94+)
// Nécessaire quand le frontend est servi en HTTPS et contacte le backend local
app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    next()
})
// Limite augmentée pour les médias base64 (document PDF jusqu'à 100MB = ~133MB base64)
app.use(express.json({ limit: '150mb' }))
app.disable('x-powered-by')

// ── Dashboard HTML ────────────────────────────────────────────────────────────
// Toujours servi — la sécurité est assurée par l'auth JWT admin (/api/admin/*)
// et non par la variable ENABLE_DASHBOARD.
{
    const publicDir = path.join(__dirname, '..', 'public')
    app.use(express.static(publicDir))

    app.get('/admin',  (_req, res) => res.redirect('/admin/login.html'))
    app.get('/admin/', (_req, res) => res.redirect('/admin/index.html'))

    logger.info(
        { component: 'Server' },
        `Admin backoffice → ${config.isProd ? 'https' : 'http'}://[host]/admin/login.html`
    )
}

// ── Instances principales ─────────────────────────────────────────────────────

const waManager     = new WhatsAppManager()
const tenantManager = new TenantManager(waManager)
const processor     = new QueueProcessor(waManager)
const gateway       = new SocketGateway(io, waManager, tenantManager, processor)

// ── Routes API ────────────────────────────────────────────────────────────────

app.use('/api/v1', statusRouter(waManager))
app.use('/api/v1', sessionRouter(waManager))
app.use('/api/v1', messagesRouter(waManager))
app.use('/api/v1', tenantsRouter(tenantManager))
app.use('/api/v1', authRouter(waManager))
app.use('/api/v1', docsRouter())
app.use('/api/admin', adminRouter(tenantManager))
app.use('/api/admin/db', adminDbRouter())
app.use('/api/admin/profiles', adminProfilesRouter())
app.use('/api/v1', sendRouter(tenantManager))
app.use('/api/v1', groupsRouter(tenantManager))
app.use('/api/v1/plans', plansRouter())
app.use('/api/v1', paymentsRouter(tenantManager))
app.use('/api/v1', contactRouter(waManager))

// ── Route 404 ─────────────────────────────────────────────────────────────────

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

// ── Arrêt propre ──────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
    logger.info({ component: 'Server' }, 'Arrêt du service...')
    processor.stop()
    await closePool()
    process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)

// ── Démarrage ─────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
    try {
        await testConnection()
        await runMigrations()

        gateway.setup()

        // Reconnecter les sessions WhatsApp tenant qui étaient actives avant
        // ce redémarrage (le Map en mémoire de TenantManager repart à zéro,
        // pas les credentials Baileys persistées en base).
        tenantManager.restoreSessions().catch((err) => {
            logger.error({ component: 'Server', err }, 'Erreur lors de la restauration des sessions tenant')
        })
        await new Promise<void>((resolve) => {
            httpServer.listen(config.port, '::', resolve)
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