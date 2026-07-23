/**
 * test-auth.mjs — Script de test complet de l'API d'authentification
 *
 * Stratégie :
 *   1. Le SDK Firebase Admin crée un Custom Token signé pour un UID de test
 *   2. On l'échange contre un vrai ID Token via l'API REST Firebase
 *      (signInWithCustomToken — REST Identity Toolkit)
 *   3. On utilise cet ID Token pour tester toutes les routes /auth/*
 *
 * Usage :
 *   node scripts/test-auth.mjs
 *
 * Pré-requis :
 *   - Le serveur doit tourner : npm run dev
 *   - FIREBASE_WEB_API_KEY doit être définie dans .env
 *     (Firebase Console → Paramètres du projet → Clé API Web)
 */

import { readFileSync }                            from 'fs'
import { resolve, dirname }                        from 'path'
import { fileURLToPath }                           from 'url'
import { initializeApp, cert, getApps }            from 'firebase-admin/app'
import { getAuth }                                 from 'firebase-admin/auth'

const __dir = dirname(fileURLToPath(import.meta.url))

// ── Charger .env manuellement (pas de dépendance à dotenv ici) ────────────────
function loadEnv() {
    const envPath = resolve(__dir, '..', '.env')
    const lines   = readFileSync(envPath, 'utf-8').split('\n')
    const env     = {}
    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const idx = trimmed.indexOf('=')
        if (idx === -1) continue
        const key = trimmed.slice(0, idx).trim()
        const val = trimmed.slice(idx + 1).trim()
        env[key]  = val
    }
    return env
}

const env = loadEnv()

const SERVICE_ACCOUNT_PATH = env['FIREBASE_SERVICE_ACCOUNT_PATH']
const WEB_API_KEY          = env['FIREBASE_WEB_API_KEY']
const SERVER_URL           = `http://127.0.0.1:${env['PORT'] || '3005'}`
const BRIDGE_API_KEY       = env['BRIDGE_API_KEY'] || ''

// ── Couleurs terminal ─────────────────────────────────────────────────────────
const c = {
    reset:  '\x1b[0m',
    green:  '\x1b[32m',
    red:    '\x1b[31m',
    yellow: '\x1b[33m',
    cyan:   '\x1b[36m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
}

function log(icon, label, msg = '') {
    console.log(`${icon}  ${c.bold}${label}${c.reset}${msg ? `  ${c.dim}${msg}${c.reset}` : ''}`)
}
function ok(label, detail = '')  { log(`${c.green}✓${c.reset}`, label, detail) }
function fail(label, detail = '') { log(`${c.red}✗${c.reset}`, label, detail) }
function info(label, detail = '') { log(`${c.cyan}→${c.reset}`, label, detail) }
function warn(label, detail = '') { log(`${c.yellow}⚠${c.reset}`, label, detail) }
function section(title) {
    console.log(`\n${c.bold}${c.cyan}━━━  ${title}  ━━━${c.reset}`)
}

// ── Init Firebase Admin ───────────────────────────────────────────────────────
function initAdmin() {
    if (getApps().length > 0) return getAuth()

    if (!SERVICE_ACCOUNT_PATH) {
        fail('FIREBASE_SERVICE_ACCOUNT_PATH non définie dans .env')
        process.exit(1)
    }

    const saPath = resolve(__dir, '..', SERVICE_ACCOUNT_PATH)
    const sa     = JSON.parse(readFileSync(saPath, 'utf-8'))

    initializeApp({ credential: cert(sa), projectId: sa.project_id })
    return getAuth()
}

// ── Créer un utilisateur Firebase de test ─────────────────────────────────────
async function getOrCreateTestUser(auth) {
    const testEmail = 'test-script@whatsapp-service.local'
    let   user

    try {
        user = await auth.getUserByEmail(testEmail)
        info('Utilisateur de test existant', `uid: ${user.uid}`)
    } catch {
        user = await auth.createUser({
            email:         testEmail,
            emailVerified: true,
            displayName:   'Test Script User',
            disabled:      false,
        })
        ok('Utilisateur de test créé', `uid: ${user.uid}`)
    }
    return user
}

// ── Générer un Custom Token → ID Token via REST ───────────────────────────────
async function getIdToken(auth, uid) {
    // 1. Custom Token (signé par le service account)
    const customToken = await auth.createCustomToken(uid, {
        provider: 'google.com',   // claim custom lu par requireFirebaseProvider en dev
    })
    info('Custom Token généré')

    // 2. Échanger contre un ID Token via Firebase REST API
    if (!WEB_API_KEY) {
        warn('FIREBASE_WEB_API_KEY manquante dans .env')
        warn('Impossible d\'obtenir un ID Token via REST')
        warn('Ajoutez : FIREBASE_WEB_API_KEY=AIzaSy...')
        warn('Récupérez-la : Firebase Console → Paramètres → Général → Clé API Web')
        return null
    }

    const url  = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`
    const resp = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token: customToken, returnSecureToken: true }),
    })

    const data = await resp.json()

    if (!resp.ok || !data.idToken) {
        fail('Échec échange Custom Token → ID Token', JSON.stringify(data.error ?? data))
        return null
    }

    ok('ID Token obtenu', `expire dans ${data.expiresIn}s`)
    return data.idToken
}

// ── Appel API générique ───────────────────────────────────────────────────────
async function apiCall(method, path, body, headers = {}) {
    const url  = SERVER_URL + path
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
    }
    if (body) opts.body = JSON.stringify(body)

    try {
        const r    = await fetch(url, opts)
        const text = await r.text()
        let   data
        try   { data = JSON.parse(text) }
        catch { data = text }
        return { status: r.status, data }
    } catch (e) {
        return { status: 0, data: { network_error: e.message } }
    }
}

function bearerHdr(token) {
    return { Authorization: `Bearer ${token}` }
}
function apiKeyHdr() {
    return BRIDGE_API_KEY ? { 'X-Api-Key': BRIDGE_API_KEY } : {}
}

function printResult(result) {
    const color = result.status >= 200 && result.status < 300 ? c.green
                : result.status >= 400                         ? c.red
                :                                               c.yellow
    console.log(`    ${color}HTTP ${result.status}${c.reset}`)
    const body = typeof result.data === 'string'
        ? result.data.slice(0, 300)
        : JSON.stringify(result.data, null, 2).split('\n').slice(0, 20).join('\n')
    console.log(body.split('\n').map(l => `    ${c.dim}${l}${c.reset}`).join('\n'))
}

function assert(condition, label) {
    if (condition) ok(label)
    else           fail(label)
    return condition
}

// ── TESTS ─────────────────────────────────────────────────────────────────────
async function runTests() {
    console.log(`\n${c.bold}${c.green}╔══════════════════════════════════════════╗`)
    console.log(`║   WhatsApp Service — Auth API Tests       ║`)
    console.log(`╚══════════════════════════════════════════╝${c.reset}\n`)

    info('Serveur cible', SERVER_URL)
    info('Service Account', SERVICE_ACCOUNT_PATH ?? '—')
    info('Web API Key', WEB_API_KEY ? `${WEB_API_KEY.slice(0, 8)}...` : '⚠️  NON DÉFINIE')

    let passed = 0, failed = 0
    const check = (cond, label) => { cond ? passed++ : failed++; return assert(cond, label) }

    // ── 1. Ping serveur ───────────────────────────────────────────────────────
    section('1. Ping serveur')
    const ping = await apiCall('GET', '/api/v1/status', null, apiKeyHdr())
    printResult(ping)
    check(ping.status !== 0, 'Serveur joignable')
    if (ping.status === 0) {
        fail('Le serveur ne répond pas — lancez : npm run dev')
        process.exit(1)
    }

    // ── 2. Init Firebase Admin + token de test ────────────────────────────────
    section('2. Firebase Admin SDK')
    let idToken = null
    let testUid = null

    try {
        const auth = initAdmin()
        ok('Firebase Admin initialisé')

        const testUser = await getOrCreateTestUser(auth)
        testUid = testUser.uid

        idToken = await getIdToken(auth, testUid)
    } catch (e) {
        fail('Erreur Firebase Admin', e.message)
    }

    // ── 3. POST /auth/verify ──────────────────────────────────────────────────
    section('3. POST /api/v1/auth/verify')

    if (!idToken) {
        warn('ID Token indisponible — test /auth/verify ignoré')
        warn('→ Ajoutez FIREBASE_WEB_API_KEY dans .env pour ce test')
    } else {
        const r = await apiCall('POST', '/api/v1/auth/verify', {}, bearerHdr(idToken))
        printResult(r)
        check(r.status === 200,       'Status 200')
        check(r.data?.success === true, 'success: true')
        check(!!r.data?.user?.uid,    'user.uid présent')
        check(r.data?.user?.uid === testUid, `uid correspond (${testUid?.slice(0, 12)}...)`)
        if (r.data?.user) {
            info('Profil retourné',
                `email=${r.data.user.email} | provider=${r.data.user.provider}`)
        }
    }

    // ── 4. GET /auth/me ───────────────────────────────────────────────────────
    section('4. GET /api/v1/auth/me')

    if (!idToken) {
        warn('ID Token indisponible — test /auth/me ignoré')
    } else {
        const r = await apiCall('GET', '/api/v1/auth/me', null, bearerHdr(idToken))
        printResult(r)
        check(r.status === 200,        'Status 200')
        check(r.data?.success === true, 'success: true')
        check(!!r.data?.user?.uid,     'user.uid présent')
    }

    // ── 5. POST /auth/verify — token invalide ─────────────────────────────────
    section('5. Sécurité — token invalide rejeté')
    {
        const r = await apiCall('POST', '/api/v1/auth/verify', {}, { Authorization: 'Bearer token.invalide.ici' })
        printResult(r)
        check(r.status === 403 || r.status === 401, 'Token invalide → 401/403')
        check(!r.data?.success,                      'success: false')
    }

    // ── 6. POST /auth/verify — sans token ─────────────────────────────────────
    section('6. Sécurité — sans token')
    {
        const r = await apiCall('POST', '/api/v1/auth/verify', {})
        printResult(r)
        check(r.status === 401, 'Pas de token → 401')
    }

    // ── 7. GET /auth/users (admin) ────────────────────────────────────────────
    section('7. GET /api/v1/auth/users (admin)')
    {
        const r = await apiCall('GET', '/api/v1/auth/users?page=1&limit=5', null, apiKeyHdr())
        printResult(r)
        check(r.status === 200,        'Status 200')
        check(r.data?.success === true, 'success: true')
        check(Array.isArray(r.data?.data), 'data[] est un tableau')
        check(typeof r.data?.meta?.total === 'number', 'meta.total présent')
        if (r.data?.meta) info('Pagination', JSON.stringify(r.data.meta))
    }

    // ── 8. GET /auth/users — filtre provider ──────────────────────────────────
    section('8. Filtre provider google.com')
    {
        const r = await apiCall(
            'GET', '/api/v1/auth/users?provider=google.com', null, apiKeyHdr()
        )
        printResult(r)
        check(r.status === 200, 'Status 200 avec filtre provider')
    }

    // ── 9. DELETE /auth/users/:uid — uid inexistant ───────────────────────────
    section('9. Sécurité — DELETE uid inexistant')
    {
        const r = await apiCall('DELETE', '/api/v1/auth/users/uid-qui-nexiste-pas', null, apiKeyHdr())
        printResult(r)
        check(r.status === 404, 'UID inexistant → 404')
    }

    // ── 10. POST /auth/logout ─────────────────────────────────────────────────
    section('10. POST /api/v1/auth/logout')

    if (!idToken) {
        warn('ID Token indisponible — test /auth/logout ignoré')
    } else {
        const r = await apiCall('POST', '/api/v1/auth/logout', {}, bearerHdr(idToken))
        printResult(r)
        check(r.status === 200,        'Status 200')
        check(r.data?.success === true, 'success: true')

        // Vérifier que le token révoqué est maintenant rejeté
        info('Vérification révocation token...')
        // Note: Firebase met jusqu'à 1min pour propager la révocation
        // donc on attend 2s avant de re-tester
        await new Promise(r => setTimeout(r, 2000))
        const r2 = await apiCall('GET', '/api/v1/auth/me', null, bearerHdr(idToken))
        printResult(r2)
        check(
            r2.status === 401 || r2.status === 403,
            'Token révoqué rejeté après logout'
        )
    }

    // ── 11. Docs ──────────────────────────────────────────────────────────────
    section('11. Documentation Swagger')
    {
        const r = await apiCall('GET', '/api/v1/openapi.json', null)
        check(r.status === 200,    'GET /api/v1/openapi.json → 200')
        check(r.data?.openapi === '3.0.3', 'spec OpenAPI 3.0.3 valide')
        check(Array.isArray(r.data?.tags), 'tags présents')
    }

    // ── Résumé ────────────────────────────────────────────────────────────────
    const total = passed + failed
    console.log(`\n${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`)
    console.log(`${c.bold}  Résultats : ${c.green}${passed} réussis${c.reset} / ${c.red}${failed} échoués${c.reset} / ${total} total`)
    console.log(`${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`)

    if (failed === 0) {
        console.log(`${c.green}${c.bold}  ✅ Tous les tests sont passés !${c.reset}\n`)
    } else {
        console.log(`${c.yellow}${c.bold}  ⚠️  ${failed} test(s) échoués.${c.reset}`)
        if (!WEB_API_KEY) {
            console.log(`\n${c.dim}  → Pour les tests /auth/verify, /auth/me et /auth/logout,`)
            console.log(`    ajoutez dans .env :`)
            console.log(`    FIREBASE_WEB_API_KEY=AIzaSy...`)
            console.log(`    (Firebase Console → Paramètres du projet → Clé API Web)${c.reset}\n`)
        }
    }
}

runTests().catch(e => {
    console.error(`\n${c.red}Erreur fatale :${c.reset}`, e)
    process.exit(1)
})
