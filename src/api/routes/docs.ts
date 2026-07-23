/**
 * docs.ts — Documentation interactive Swagger UI.
 *
 * Accessible sur : GET /api/v1/docs
 *
 * La spec OpenAPI est définie inline (pas besoin de fichier séparé).
 * Elle couvre l'intégralité des endpoints du service.
 */

import { Router }          from 'express'
import swaggerUi           from 'swagger-ui-express'
import { config }          from '../../config.js'

// ── Spec OpenAPI 3.0 ──────────────────────────────────────────────────────────

const openApiSpec = {
    openapi: '3.0.3',
    info: {
        title:       'WhatsApp Service — API Documentation',
        version:     '2.0.0',
        description: `
## WhatsApp Gateway Service

API REST générique pour envoyer des messages WhatsApp via Baileys,
avec authentification multiplateforme (Google, GitHub, Téléphone OTP).

### Authentification — 3 modes

| Mode | Flow | En-tête |
|------|------|---------|
| **Google / GitHub** | Firebase OAuth → ID Token | \`Authorization: Bearer <idToken>\` |
| **Téléphone OTP** | register → OTP WhatsApp → verify-otp → customToken | \`Authorization: Bearer <idToken>\` |
| **Admin** | Clé API statique | \`X-Api-Key: <bridgeApiKey>\` |

### Flux Google / GitHub

\`\`\`
Client → Firebase SDK (OAuth) → Firebase Auth
       ← ID Token ←
Client → POST /api/v1/auth/verify  (Bearer idToken)
       ← Profil utilisateur ←
\`\`\`

### Flux Téléphone OTP

\`\`\`
Client → POST /api/v1/auth/phone/register  { phone }
       ← 202 Accepted ←
WhatsApp reçoit → Code OTP 6 chiffres (valable 10 min)
Client → POST /api/v1/auth/phone/verify-otp  { phone, code }
       ← { customToken } ←
Client → Firebase SDK signInWithCustomToken(customToken)
       ← ID Token ←
Client → POST /api/v1/auth/verify  (Bearer idToken) ou GET /api/v1/auth/me
\`\`\`
        `.trim(),
        contact: {
            name: 'Convessa — WhatsApp Service',
        },
    },
    servers: [
        {
            url:         `http://127.0.0.1:${config.port}`,
            description: 'Serveur local',
        },
    ],

    // ── Sécurité ──────────────────────────────────────────────────────────────
    components: {
        securitySchemes: {
            bearerAuth: {
                type:         'http',
                scheme:       'bearer',
                bearerFormat: 'Firebase ID Token',
                description:  'Firebase ID Token obtenu après connexion OAuth (Google/GitHub) via le SDK Firebase client',
            },
            apiKeyAuth: {
                type: 'apiKey',
                in:   'header',
                name: 'X-Api-Key',
                description: 'Clé API Bridge (BRIDGE_API_KEY) — endpoints admin uniquement',
            },
        },

        schemas: {
            AuthProfile: {
                type: 'object',
                properties: {
                    success:     { type: 'boolean', example: true },
                    user: {
                        type: 'object',
                        properties: {
                            uid:         { type: 'string', example: 'firebase-uid-abc123' },
                            email:       { type: 'string', format: 'email', example: 'user@gmail.com' },
                            displayName: { type: 'string', example: 'Jean Dupont' },
                            photoUrl:    { type: 'string', format: 'uri', example: 'https://lh3.googleusercontent.com/...' },
                            provider:    { type: 'string', example: 'google.com', enum: ['google.com', 'github.com'] },
                            active:      { type: 'boolean', example: true },
                            createdAt:   { type: 'string', format: 'date-time' },
                            lastLoginAt: { type: 'string', format: 'date-time' },
                        },
                    },
                },
            },

            Error: {
                type: 'object',
                properties: {
                    success: { type: 'boolean', example: false },
                    error: {
                        type: 'object',
                        properties: {
                            code:    { type: 'string', example: 'UNAUTHORIZED' },
                            message: { type: 'string', example: "Token d'authentification manquant" },
                        },
                    },
                },
            },

            MessageSendRequest: {
                type:     'object',
                required: ['to', 'message'],
                properties: {
                    to:      { type: 'string', example: '22990000000', description: 'Numéro international sans +' },
                    message: { type: 'string', example: 'Bonjour !', maxLength: 4096 },
                },
            },

            MessageSendResponse: {
                type: 'object',
                properties: {
                    success:   { type: 'boolean', example: true },
                    queued:    { type: 'boolean', example: true },
                    messageId: { type: 'string', format: 'uuid' },
                    position:  { type: 'integer', example: 3 },
                },
            },

            MessageStatus: {
                type: 'object',
                properties: {
                    success:   { type: 'boolean' },
                    messageId: { type: 'string', format: 'uuid' },
                    status:    { type: 'string', enum: ['queued', 'sending', 'sent', 'failed'] },
                    to:        { type: 'string', example: '229****000' },
                    attempts:  { type: 'integer' },
                    queuedAt:  { type: 'string', format: 'date-time' },
                    sentAt:    { type: 'string', format: 'date-time', nullable: true },
                    position:  { type: 'integer', nullable: true },
                    error:     { type: 'string', nullable: true },
                },
            },
        },

        responses: {
            Unauthorized: {
                description: 'Token ou clé API manquant / invalide',
                content: {
                    'application/json': {
                        schema: { '$ref': '#/components/schemas/Error' },
                    },
                },
            },
            ForbiddenProvider: {
                description: 'Provider OAuth non autorisé (seuls Google et GitHub sont acceptés)',
                content: {
                    'application/json': {
                        schema: { '$ref': '#/components/schemas/Error' },
                    },
                },
            },
        },
    },

    // ── Tags ──────────────────────────────────────────────────────────────────
    tags: [
        { name: 'Auth',         description: 'Authentification Firebase (Google / GitHub)' },
        { name: 'Auth - Phone', description: 'Authentification par numéro de téléphone (OTP WhatsApp)' },
        { name: 'Auth - Admin', description: 'Gestion des comptes — nécessite la clé API' },
        { name: 'WhatsApp',     description: 'Envoi et suivi des messages WhatsApp' },
        { name: 'Status',       description: "État de la connexion WhatsApp et de la file d'attente" },
        { name: 'Session',      description: 'Gestion de la session WhatsApp (QR code)' },
    ],

    // ── Paths ─────────────────────────────────────────────────────────────────
    paths: {

        // ── Auth ──────────────────────────────────────────────────────────────

        '/api/v1/auth/verify': {
            post: {
                tags:    ['Auth'],
                summary: 'Vérifier un Firebase ID Token',
                description: `
Endpoint principal d'authentification. Appelé après que le client a obtenu un ID Token
via le SDK Firebase (Google Sign-In ou GitHub).

**Providers supportés :** \`google.com\` · \`github.com\`

Le serveur :
1. Vérifie cryptographiquement le token via Firebase Admin SDK
2. Crée ou met à jour le profil en base MySQL
3. Retourne le profil utilisateur
                `.trim(),
                security: [{ bearerAuth: [] }],
                responses: {
                    200: {
                        description: 'Token valide — profil retourné',
                        content: { 'application/json': { schema: { '$ref': '#/components/schemas/AuthProfile' } } },
                    },
                    401: { '$ref': '#/components/responses/Unauthorized' },
                    403: { '$ref': '#/components/responses/ForbiddenProvider' },
                },
            },
        },

        '/api/v1/auth/me': {
            get: {
                tags:    ['Auth'],
                summary: 'Profil de l\'utilisateur connecté',
                description: 'Retourne le profil de l\'utilisateur identifié par le Bearer token.',
                security: [{ bearerAuth: [] }],
                responses: {
                    200: {
                        description: 'Profil utilisateur',
                        content: { 'application/json': { schema: { '$ref': '#/components/schemas/AuthProfile' } } },
                    },
                    401: { '$ref': '#/components/responses/Unauthorized' },
                    404: {
                        description: 'Utilisateur non trouvé en base — appelez /auth/verify d\'abord',
                        content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } },
                    },
                },
            },
        },

        '/api/v1/auth/logout': {
            post: {
                tags:    ['Auth'],
                summary: 'Déconnexion — révocation du token Firebase',
                description: `
Révoque tous les refresh tokens de l'utilisateur côté Firebase.

> **Note :** Les ID tokens déjà émis restent valides jusqu'à expiration (1h).
> Pour une révocation strictement immédiate, le service utilise \`checkRevoked: true\`
> lors de la vérification des tokens.
                `.trim(),
                security: [{ bearerAuth: [] }],
                responses: {
                    200: {
                        description: 'Déconnexion effectuée',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        message: { type: 'string', example: 'Déconnexion effectuée' },
                                    },
                                },
                            },
                        },
                    },
                    401: { '$ref': '#/components/responses/Unauthorized' },
                },
            },
        },

        // ── Auth Téléphone OTP ─────────────────────────────────────────────────

        '/api/v1/auth/phone/register': {
            post: {
                tags:    ['Auth - Phone'],
                summary: 'Inscription par numéro de téléphone',
                description: `
**Étape 1/2 du flux OTP.**

Vérifie que le numéro n'est pas déjà utilisé, génère un code OTP à 6 chiffres
et l'envoie au numéro via WhatsApp.

En mode \`development\`, le code est aussi retourné dans \`devOtp\` pour faciliter les tests.
                `.trim(),
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['phone'],
                                properties: {
                                    phone:       { type: 'string', example: '22960000000', description: 'Numéro international sans + (indicatif inclus)' },
                                    displayName: { type: 'string', example: 'Jean Dupont', description: 'Nom affiché (optionnel)' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    202: {
                        description: 'OTP envoyé via WhatsApp',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        message: { type: 'string', example: 'Code envoyé au 229****000 via WhatsApp' },
                                        devOtp:  { type: 'string', example: '482910', description: 'Uniquement en développement' },
                                    },
                                },
                            },
                        },
                    },
                    400: { description: 'Format de numéro invalide' },
                    409: { description: 'Numéro déjà enregistré — utilisez /auth/phone/login' },
                    503: { description: 'WhatsApp non connecté (production uniquement)' },
                },
            },
        },

        '/api/v1/auth/phone/verify-otp': {
            post: {
                tags:    ['Auth - Phone'],
                summary: 'Vérifier le code OTP et activer le compte',
                description: `
**Étape 2/2 du flux OTP.**

Vérifie le code reçu par WhatsApp. En cas de succès :
1. Crée le compte Firebase (provider \`phone\`)
2. Sauvegarde le profil en base MySQL
3. Retourne un **Custom Token Firebase**

Le frontend doit ensuite appeler \`signInWithCustomToken(customToken)\` via le SDK Firebase
pour obtenir un ID Token standard, utilisable sur tous les autres endpoints.

**Limites de sécurité :** 5 tentatives max, expiration 10 minutes.
                `.trim(),
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['phone', 'code'],
                                properties: {
                                    phone: { type: 'string', example: '22960000000' },
                                    code:  { type: 'string', example: '482910', description: 'Code OTP à 6 chiffres' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'OTP valide — compte activé',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success:     { type: 'boolean', example: true },
                                        customToken: { type: 'string', description: 'Firebase Custom Token — à échanger via signInWithCustomToken()' },
                                        user:        { '$ref': '#/components/schemas/AuthProfile' },
                                        message:     { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                    400: { description: 'Code incorrect ou invalide' },
                    410: { description: 'Code expiré ou trop de tentatives' },
                },
            },
        },

        '/api/v1/auth/phone/login': {
            post: {
                tags:    ['Auth - Phone'],
                summary: 'Connexion d\'un compte existant par téléphone',
                description: `
Envoie un nouveau code OTP au numéro si le compte existe déjà.
Ensuite appeler \`POST /auth/phone/verify-otp\` avec le code reçu.
                `.trim(),
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['phone'],
                                properties: {
                                    phone: { type: 'string', example: '22960000000' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    202: { description: 'Code OTP envoyé' },
                    404: { description: 'Numéro non enregistré — utilisez /auth/phone/register' },
                    403: { description: 'Compte désactivé' },
                    503: { description: 'WhatsApp non connecté' },
                },
            },
        },

        '/api/v1/auth/users': {
            get: {
                tags:    ['Auth - Admin'],
                summary: 'Lister les utilisateurs',
                description: 'Endpoint admin protégé par la clé API Bridge.',
                security: [{ apiKeyAuth: [] }],
                parameters: [
                    { in: 'query', name: 'page',     schema: { type: 'integer', default: 1 } },
                    { in: 'query', name: 'limit',    schema: { type: 'integer', default: 20, maximum: 100 } },
                    { in: 'query', name: 'provider', schema: { type: 'string', enum: ['google.com', 'github.com'] }, description: 'Filtrer par provider' },
                ],
                responses: {
                    200: {
                        description: 'Liste paginée',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean' },
                                        data:    { type: 'array', items: { '$ref': '#/components/schemas/AuthProfile' } },
                                        meta: {
                                            type: 'object',
                                            properties: {
                                                page:  { type: 'integer' },
                                                limit: { type: 'integer' },
                                                total: { type: 'integer' },
                                                pages: { type: 'integer' },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    401: { '$ref': '#/components/responses/Unauthorized' },
                },
            },
        },

        '/api/v1/auth/users/{uid}': {
            delete: {
                tags:    ['Auth - Admin'],
                summary: 'Désactiver un compte utilisateur',
                description: 'Désactive le compte en base et révoque les tokens Firebase. Protégé par la clé API.',
                security: [{ apiKeyAuth: [] }],
                parameters: [
                    { in: 'path', name: 'uid', required: true, schema: { type: 'string' }, description: 'Firebase UID' },
                ],
                responses: {
                    200: {
                        description: 'Compte désactivé',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        message: { type: 'string', example: 'Compte désactivé' },
                                    },
                                },
                            },
                        },
                    },
                    404: { description: 'Utilisateur introuvable' },
                    401: { '$ref': '#/components/responses/Unauthorized' },
                },
            },
        },

        // ── WhatsApp Messages ─────────────────────────────────────────────────

        '/api/v1/messages/send': {
            post: {
                tags:    ['WhatsApp'],
                summary: 'Envoyer un message WhatsApp',
                description: 'Ajoute un message à la file d\'attente FIFO. Retourne immédiatement un ID de suivi.',
                security: [{ apiKeyAuth: [] }],
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { '$ref': '#/components/schemas/MessageSendRequest' } } },
                },
                responses: {
                    202: {
                        description: 'Message mis en file',
                        content: { 'application/json': { schema: { '$ref': '#/components/schemas/MessageSendResponse' } } },
                    },
                    400: { description: 'Validation échouée', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
                    401: { '$ref': '#/components/responses/Unauthorized' },
                    503: { description: 'WhatsApp non connecté', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
                },
            },
        },

        '/api/v1/messages/{id}': {
            get: {
                tags:    ['WhatsApp'],
                summary: 'Statut d\'un message',
                description: 'Consulte le statut d\'un message par son UUID.',
                security: [{ apiKeyAuth: [] }],
                parameters: [
                    { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
                ],
                responses: {
                    200: {
                        description: 'Statut du message',
                        content: { 'application/json': { schema: { '$ref': '#/components/schemas/MessageStatus' } } },
                    },
                    404: { description: 'Message introuvable' },
                    401: { '$ref': '#/components/responses/Unauthorized' },
                },
            },
        },

        // ── Status ────────────────────────────────────────────────────────────

        '/api/v1/status': {
            get: {
                tags:    ['Status'],
                summary: 'État de la connexion WhatsApp',
                description: 'Retourne le statut de connexion WhatsApp et les statistiques de la file d\'attente.',
                security: [{ apiKeyAuth: [] }],
                responses: {
                    200: {
                        description: 'Statut courant',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean' },
                                        status:  { type: 'string', enum: ['connected', 'connecting', 'disconnected', 'qr_pending'] },
                                        phone:   { type: 'string', nullable: true },
                                        queue: {
                                            type: 'object',
                                            properties: {
                                                queued:  { type: 'integer' },
                                                sending: { type: 'integer' },
                                                sent:    { type: 'integer' },
                                                failed:  { type: 'integer' },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },

        // ── Session ───────────────────────────────────────────────────────────

        '/api/v1/session/qr': {
            get: {
                tags:    ['Session'],
                summary: 'QR Code de connexion WhatsApp',
                description: 'Retourne le QR code à scanner avec WhatsApp (base64 PNG ou URL data).',
                security: [{ apiKeyAuth: [] }],
                responses: {
                    200: { description: 'QR code disponible' },
                    404: { description: 'Aucun QR code disponible (déjà connecté ou en attente)' },
                },
            },
        },

        '/api/v1/session/logout': {
            post: {
                tags:    ['Session'],
                summary: 'Déconnecter la session WhatsApp',
                description: 'Déconnecte WhatsApp et supprime la session enregistrée.',
                security: [{ apiKeyAuth: [] }],
                responses: {
                    200: { description: 'Session déconnectée' },
                    401: { '$ref': '#/components/responses/Unauthorized' },
                },
            },
        },
    },
}

// ── Router ────────────────────────────────────────────────────────────────────

export function docsRouter(): Router {
    const router = Router()

    // Spec JSON brute — chemin DISTINCT de /docs pour éviter que
    // swaggerUi.serve (middleware statique) intercepte la requête
    router.get('/openapi.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.json(openApiSpec)
    })

    router.use(
        '/docs',
        swaggerUi.serve,
        swaggerUi.setup(openApiSpec, {
            customSiteTitle: 'WhatsApp Service — API Docs',
            swaggerOptions: {
                persistAuthorization: true,
                displayRequestDuration: true,
                defaultModelsExpandDepth: 2,
                defaultModelExpandDepth: 2,
                docExpansion: 'list',
                filter: true,
            },
        })
    )

    return router
}
