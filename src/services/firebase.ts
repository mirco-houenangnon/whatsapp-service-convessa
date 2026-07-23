/**
 * firebase.ts — Initialisation du SDK Firebase Admin.
 *
 * Supporte deux modes de configuration :
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON  — contenu JSON de la clé de service (recommandé CI/CD)
 *   2. FIREBASE_SERVICE_ACCOUNT_PATH  — chemin vers le fichier JSON (dev local)
 *
 * Le module exporte `firebaseAuth` prête à vérifier les ID tokens Firebase
 * (Google, GitHub, etc.).
 */

import { readFileSync }                                        from 'fs'
import { resolve }                                             from 'path'
import { initializeApp, getApps, cert, type ServiceAccount }  from 'firebase-admin/app'
import { getAuth }                                             from 'firebase-admin/auth'
import { logger }                                              from './logger.js'
import { config }                                              from '../config.js'

function loadServiceAccount(): ServiceAccount {
    // Priorité 1 : JSON inline dans la variable d'environnement
    if (config.firebase.serviceAccountJson) {
        try {
            return JSON.parse(config.firebase.serviceAccountJson) as ServiceAccount
        } catch {
            logger.error(
                { component: 'Firebase' },
                'FIREBASE_SERVICE_ACCOUNT_JSON invalide — JSON malformé'
            )
            process.exit(1)
        }
    }

    // Priorité 2 : chemin vers un fichier JSON sur le disque
    if (config.firebase.serviceAccountPath) {
        try {
            const filePath = resolve(config.firebase.serviceAccountPath)
            const raw      = readFileSync(filePath, 'utf-8')
            return JSON.parse(raw) as ServiceAccount
        } catch (err) {
            logger.error(
                { component: 'Firebase', err },
                'Impossible de charger FIREBASE_SERVICE_ACCOUNT_PATH'
            )
            process.exit(1)
        }
    }

    logger.error(
        { component: 'Firebase' },
        'Aucune configuration Firebase trouvée. Définissez FIREBASE_SERVICE_ACCOUNT_JSON ou FIREBASE_SERVICE_ACCOUNT_PATH'
    )
    process.exit(1)
}

function initFirebase() {
    // Évite les ré-initialisations en cas de hot-reload (tsx watch)
    if (getApps().length > 0) return getApps()[0]!

    const serviceAccount = loadServiceAccount()

    return initializeApp({
        credential: cert(serviceAccount),
        projectId:  config.firebase.projectId || undefined,
    })
}

initFirebase()

/** Instance Firebase Auth — vérifie les ID tokens côté serveur */
export const firebaseAuth = getAuth()

logger.info({ component: 'Firebase' }, 'Firebase Admin SDK initialisé')
