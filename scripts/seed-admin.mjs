/**
 * seed-admin.mjs — Crée l'administrateur Convessa par défaut.
 *
 * Usage : node scripts/seed-admin.mjs
 *
 * Crée le compte convessa@service.com s'il n'existe pas déjà.
 * Si le compte existe, le script affiche un message et sort proprement.
 */

import { createConnection } from 'mysql2/promise'
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join }  from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '..', '.env') })

// ── Config ────────────────────────────────────────────────────────────────────
const ADMIN_EMAIL    = 'convessa@service.com'
const ADMIN_PASSWORD = 'Convessa@Service_2026'
const ADMIN_NAME     = 'Convessa Admin'

// ── Hash scrypt (identique à AdminStore.ts) ───────────────────────────────────
function hashPassword(password) {
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(password, salt, 64).toString('hex')
    return `${salt}:${hash}`
}

// ── Connexion MySQL ───────────────────────────────────────────────────────────
const conn = await createConnection({
    host:     process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT || '3306', 10),
    database: process.env.DB_NAME     || 'whatsapp_service',
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASS     || '',
    charset:  'utf8mb4',
})

console.log('✅ Connexion MySQL établie')

// ── Créer la table si elle n'existe pas encore ────────────────────────────────
await conn.execute(`
    CREATE TABLE IF NOT EXISTS convessa_admins (
        id            INT           NOT NULL AUTO_INCREMENT,
        email         VARCHAR(255)  NOT NULL,
        display_name  VARCHAR(100)  DEFAULT NULL,
        password_hash VARCHAR(200)  NOT NULL,
        active        TINYINT(1)    NOT NULL DEFAULT 1,
        created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        last_login_at DATETIME      DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_email (email),
        INDEX idx_active (active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`)
console.log('✅ Table convessa_admins vérifiée')

// ── Vérifier si l'admin existe déjà ──────────────────────────────────────────
const [rows] = await conn.execute(
    'SELECT id, email FROM convessa_admins WHERE email = ? LIMIT 1',
    [ADMIN_EMAIL]
)

if (rows.length > 0) {
    console.log(`ℹ️  L'admin ${ADMIN_EMAIL} existe déjà (id: ${rows[0].id}) — aucune action.`)
    await conn.end()
    process.exit(0)
}

// ── Créer l'admin ─────────────────────────────────────────────────────────────
const passwordHash = hashPassword(ADMIN_PASSWORD)

const [result] = await conn.execute(
    `INSERT INTO convessa_admins (email, display_name, password_hash) VALUES (?, ?, ?)`,
    [ADMIN_EMAIL, ADMIN_NAME, passwordHash]
)

console.log(`\n🎉 Admin créé avec succès !`)
console.log(`   ID       : ${result.insertId}`)
console.log(`   Email    : ${ADMIN_EMAIL}`)
console.log(`   Nom      : ${ADMIN_NAME}`)
console.log(`   Password : ${ADMIN_PASSWORD}`)
console.log(`\n⚠️  Changez le mot de passe après la première connexion.\n`)

await conn.end()
process.exit(0)
