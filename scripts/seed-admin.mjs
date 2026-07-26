/**
 * seed-admin.mjs — Crée l'administrateur Convessa par défaut.
 *
 * Usage : node scripts/seed-admin.mjs
 */

import pkg from 'pg'
const { Client } = pkg
import { scryptSync, randomBytes } from 'crypto'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join }  from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '..', '.env') })

const ADMIN_EMAIL    = 'convessa@service.com'
const ADMIN_PASSWORD = 'Convessa@Service_2026'
const ADMIN_NAME     = 'Convessa Admin'

function hashPassword(password) {
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(password, salt, 64).toString('hex')
    return `${salt}:${hash}`
}

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
})

await client.connect()
console.log('✅ Connexion PostgreSQL (Neon) établie')

// Créer la table si elle n'existe pas
await client.query(`
    CREATE TABLE IF NOT EXISTS convessa_admins (
        id            SERIAL        PRIMARY KEY,
        email         VARCHAR(255)  NOT NULL UNIQUE,
        display_name  VARCHAR(100)  DEFAULT NULL,
        password_hash VARCHAR(200)  NOT NULL,
        active        BOOLEAN       NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ   DEFAULT NULL
    )
`)
console.log('✅ Table convessa_admins vérifiée')

// Vérifier si l'admin existe déjà
const existing = await client.query(
    'SELECT id, email FROM convessa_admins WHERE email = $1 LIMIT 1',
    [ADMIN_EMAIL]
)

if (existing.rows.length > 0) {
    console.log(`ℹ️  L'admin ${ADMIN_EMAIL} existe déjà (id: ${existing.rows[0].id}) — aucune action.`)
    await client.end()
    process.exit(0)
}

const passwordHash = hashPassword(ADMIN_PASSWORD)
const result = await client.query(
    `INSERT INTO convessa_admins (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
    [ADMIN_EMAIL, ADMIN_NAME, passwordHash]
)

console.log(`\n🎉 Admin créé avec succès !`)
console.log(`   ID       : ${result.rows[0].id}`)
console.log(`   Email    : ${ADMIN_EMAIL}`)
console.log(`   Nom      : ${ADMIN_NAME}`)
console.log(`   Password : ${ADMIN_PASSWORD}`)
console.log(`\n⚠️  Changez le mot de passe après la première connexion.\n`)

await client.end()
process.exit(0)
