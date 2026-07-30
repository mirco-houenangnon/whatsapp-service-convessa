/**
 * seed-admin.mjs — Script standalone de seed admin (optionnel).
 * Le seed est aussi intégré directement dans runMigrations() au démarrage.
 * Usage : node scripts/seed-admin.mjs
 */

import mysql from 'mysql2/promise'
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

const connection = await mysql.createConnection({
    host:     process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT || '3306', 10),
    database: process.env.DB_NAME     || 'convessa',
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASS     || '',
    charset:  'utf8mb4',
    timezone: 'Z',
})

console.log('✅ Connexion MySQL établie')

const [existing] = await connection.execute(
    'SELECT id, email FROM convessa_admins WHERE email = ? LIMIT 1',
    [ADMIN_EMAIL]
)

if (existing.length > 0) {
    console.log(`ℹ️  L'admin ${ADMIN_EMAIL} existe déjà (id: ${existing[0].id}) — aucune action.`)
    await connection.end()
    process.exit(0)
}

const passwordHash = hashPassword(ADMIN_PASSWORD)
const [result] = await connection.execute(
    `INSERT INTO convessa_admins (email, display_name, password_hash) VALUES (?, ?, ?)`,
    [ADMIN_EMAIL, ADMIN_NAME, passwordHash]
)

console.log(`\n🎉 Admin créé avec succès !`)
console.log(`   ID       : ${result.insertId}`)
console.log(`   Email    : ${ADMIN_EMAIL}`)
console.log(`   Password : ${ADMIN_PASSWORD}`)
console.log(`\n⚠️  Changez le mot de passe après la première connexion.\n`)

await connection.end()
process.exit(0)
