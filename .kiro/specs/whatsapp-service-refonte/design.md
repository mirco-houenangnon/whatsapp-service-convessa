# Design Document

## Overview

Ce document décrit l'architecture technique complète du `whatsapp-service` refondu.
Il traduit les requirements en décisions concrètes : structure des fichiers, schéma de base de données, contrat d'API, composants internes et flux de données.

**Stack retenue :**
- Runtime : Node.js ≥ 20
- Langage : TypeScript strict
- Framework HTTP : Express 5
- WebSocket temps réel : Socket.io 4
- WhatsApp : `@whiskeysockets/baileys` (npm standard, version épinglée)
- Base de données : MySQL/MariaDB via `mysql2/promise` (XAMPP en local)
- Logging : `pino` (JSON structuré)
- Email : `nodemailer`
- Sécurité HTTP : `helmet`

---

## Architecture

### Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────────┐
│                        whatsapp-service                         │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────────┐  │
│  │  HTTP Server │   │  Socket.io   │   │  Queue Processor  │  │
│  │  (Express)   │   │  (realtime)  │   │  (FIFO worker)    │  │
│  └──────┬───────┘   └──────┬───────┘   └────────┬──────────┘  │
│         │                  │                     │              │
│  ┌──────▼─────────────────▼─────────────────────▼──────────┐  │
│  │                    WhatsAppManager                        │  │
│  │              (EventEmitter — cœur du service)            │  │
│  └──────────────────────────┬─────────────────────────────  ┘  │
│                             │                                   │
│  ┌──────────────────────────▼─────────────────────────────  ┐  │
│  │                    Baileys (WASocket)                     │  │
│  └──────────────────────────┬─────────────────────────────  ┘  │
│                             │                                   │
│  ┌──────┬──────────────────▼──────────────────────────────┐   │
│  │  DB  │  SessionStore  │  MessageQueue  │  Logger        │   │
│  │      │  (wa_sessions) │  (wa_msg_queue)│  (wa_logs)    │   │
│  └──────┴────────────────┴───────────────┴────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        Laravel/PHP      NestJS/JS       Django/Python
        (REST + JSON)   (REST + JSON)   (REST + JSON)
```

### Structure des fichiers

```
whatsapp-service/
├── src/
│   ├── index.ts                  # Point d'entrée — serveur HTTP + Socket.io
│   ├── config.ts                 # Lecture et validation de toutes les variables .env
│   │
│   ├── whatsapp/
│   │   ├── WhatsAppManager.ts    # Connexion Baileys, événements, reconnexion
│   │   └── QueueProcessor.ts     # Worker FIFO — consomme la file d'attente
│   │
│   ├── db/
│   │   ├── connection.ts         # Pool de connexion MySQL
│   │   ├── migrations.ts         # Création des tables au démarrage
│   │   ├── SessionStore.ts       # CRUD sessions chiffrées
│   │   └── MessageQueue.ts       # CRUD file d'attente
│   │
│   ├── api/
│   │   ├── middleware/
│   │   │   ├── auth.ts           # Vérification X-Api-Key (temps constant)
│   │   │   ├── rateLimit.ts      # Rate limiting (IP validée)
│   │   │   └── validate.ts       # Validation des corps de requête
│   │   └── routes/
│   │       ├── messages.ts       # POST /api/v1/messages/send + GET /:id
│   │       ├── session.ts        # DELETE /api/v1/session
│   │       └── status.ts         # GET /api/v1/status
│   │
│   ├── services/
│   │   ├── crypto.ts             # Chiffrement/déchiffrement AES-256-GCM
│   │   ├── mailer.ts             # Envoi d'alertes e-mail via nodemailer
│   │   └── logger.ts             # Instance pino configurée
│   │
│   └── socket/
│       └── SocketGateway.ts      # Gestion Socket.io + auth handshake
│
├── public/
│   └── index.html                # Dashboard (protégé, désactivé en prod)
│
├── .env
├── .env.example
├── package.json
└── tsconfig.json
```

### Flux — Envoi d'un message de validation

```
Service consommateur
    │
    ▼
POST /api/v1/messages/send  { to: "336...", message: "Code: 4839" }
    │
    ├─ Validation (format numéro, longueur message)
    ├─ INSERT wa_message_queue (status: 'queued')
    ├─ Retourne 202 { success: true, messageId: "uuid", position: N }
    │
    ▼
QueueProcessor (worker en arrière-plan)
    │
    ├─ Lit prochain message 'queued' (FIFO par queued_at)
    ├─ UPDATE status → 'sending'
    ├─ Résolution JID (onWhatsApp)
    │   ├─ Si JID trouvé → continue
    │   └─ Si non trouvé → UPDATE status 'failed', last_error 'PHONE_NOT_ON_WHATSAPP'
    │
    ├─ sock.sendMessage(jid, { text })
    │   ├─ Succès → UPDATE status 'sent', sent_at = NOW()
    │   │           Socket.io emit 'queue_update' { messageId, status: 'sent' }
    │   └─ Échec → attempts++
    │               Si attempts < 3 → requeue avec backoff
    │               Si attempts >= 3 → UPDATE status 'failed'
    │
    └─ Attendre MESSAGE_DELAY_MS (aléatoire entre min et max)
       └─ Traiter le message suivant
```

### Flux — Déconnexion et alerte e-mail

```
Baileys détecte une déconnexion
    │
    ├─ code = loggedOut (403) ?
    │   └─ OUI → déconnexion définitive
    │       ├─ UPDATE wa_sessions SET status = 'revoked'
    │       ├─ Socket.io emit 'logged_out' { reason: 'session_revoked' }
    │       ├─ mailer.sendAlert(...)   ← alerte e-mail unique
    │       └─ init() → nouveau QR code
    │
    └─ NON → déconnexion temporaire (réseau)
        ├─ Socket.io emit 'status_update' { status: 'disconnected', reason: 'network' }
        └─ Reconnexion automatique avec backoff (PAS d'alerte e-mail)
```

---

## Components and Interfaces

### config.ts — Validation de configuration

Lit toutes les variables `.env` au démarrage. Arrête le processus si une variable obligatoire est absente.

```typescript
interface AppConfig {
  port: number
  nodeEnv: 'development' | 'production'
  bridgeApiKey: string
  corsOrigin: string
  enableDashboard: boolean
  sessionEncryptionKey: string
  db: { host: string; port: number; name: string; user: string; pass: string }
  queue: { delayMs: number; delayMaxMs: number; maxRetry: number }
  alert: { email: string; smtp: SmtpConfig } | null
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}
```

### WhatsAppManager.ts — Gestionnaire de connexion

Hérite de `EventEmitter`. Gère le cycle de vie du socket Baileys et persiste la session en base.

**Événements émis :**
- `qr` → string brut du QR (SocketGateway le convertit en base64)
- `ready` → `{ phone, name, connectedAt }`
- `logged_out` → `{ reason }`
- `message` → payload Baileys brut

**Interface publique :**
```typescript
class WhatsAppManager extends EventEmitter {
  async init(): Promise<void>
  async logout(): Promise<void>
  async sendMessage(jid: string, text: string, timeoutMs?: number): Promise<void>
  getStatus(): ConnectionStatus
  getSocket(): WASocket | null
  isReady(): boolean
}
```

### QueueProcessor.ts — Worker FIFO

Tourne en boucle infinie en arrière-plan. Consomme un message à la fois depuis `wa_message_queue`.

```typescript
class QueueProcessor {
  constructor(waManager: WhatsAppManager, messageQueue: MessageQueue)
  start(): void
  stop(): void
  private processNext(): Promise<void>
  private sleep(ms: number): Promise<void>
  private randomDelay(): number
}
```

### SessionStore.ts — Persistance des sessions

Adapte l'interface `AuthState` de Baileys pour lire/écrire en base MySQL au lieu du système de fichiers.

```typescript
class SessionStore {
  async load(sessionId: string): Promise<AuthState | null>
  async save(sessionId: string, creds: AuthenticationCreds): Promise<void>
  async updateStatus(sessionId: string, status: SessionStatus, meta?: SessionMeta): Promise<void>
  async delete(sessionId: string): Promise<void>
}
```

### MessageQueue.ts — File d'attente

```typescript
class MessageQueue {
  async enqueue(recipient: string, message: string): Promise<{ id: string; position: number }>
  async dequeueNext(): Promise<QueuedMessage | null>
  async updateStatus(id: string, status: MessageStatus, extra?: Partial<QueuedMessage>): Promise<void>
  async getById(id: string): Promise<QueuedMessage | null>
  async getPosition(id: string): Promise<number>
  async countPending(): Promise<number>
}
```

### SocketGateway.ts — Socket.io authentifié

```typescript
class SocketGateway {
  constructor(io: Server, waManager: WhatsAppManager, messageQueue: MessageQueue)
  setup(): void
  private authenticate(token: string): boolean
  broadcast(event: string, data: unknown): void
}
```

### crypto.ts — Chiffrement AES-256-GCM

```typescript
function encrypt(plaintext: string, key: string): { iv: string; tag: string; data: string }
function decrypt(iv: string, tag: string, ciphertext: string, key: string): string
```

### mailer.ts — Alertes e-mail

```typescript
async function sendDisconnectAlert(config: AlertConfig, details: AlertDetails): Promise<void>
```

### API REST — Routes et contrat complet

#### Authentification — Header requis sur toutes les routes
```
X-Api-Key: <BRIDGE_API_KEY>
```

#### POST /api/v1/messages/send

**Requête :**
```json
{ "to": "33612345678", "message": "Votre code est : 483920" }
```

**Réponses :**

| Scénario | HTTP | Corps JSON |
|---|---|---|
| Mis en file | 202 | `{ "success": true, "queued": true, "messageId": "uuid", "position": 3 }` |
| Champ manquant | 400 | `{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Le champ 'to' est requis" } }` |
| Numéro invalide | 400 | `{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Format de numéro invalide" } }` |
| Message trop long | 400 | `{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Le message ne peut pas dépasser 4096 caractères" } }` |
| Service déconnecté | 503 | `{ "success": false, "error": { "code": "SERVICE_NOT_CONNECTED", "message": "Le service WhatsApp n'est pas connecté" } }` |
| Non autorisé | 401 | `{ "success": false, "error": { "code": "UNAUTHORIZED", "message": "Clé API manquante ou invalide" } }` |
| Trop de requêtes | 429 | `{ "success": false, "error": { "code": "RATE_LIMIT_EXCEEDED", "message": "Trop de requêtes, réessayez dans un moment" } }` |

#### GET /api/v1/messages/:messageId

**Réponses :**

| Scénario | HTTP | Corps JSON |
|---|---|---|
| En attente | 200 | `{ "success": true, "messageId": "uuid", "status": "queued", "position": 2, "to": "+336XXXXXX78", "queuedAt": "..." }` |
| Envoyé | 200 | `{ "success": true, "messageId": "uuid", "status": "sent", "to": "+336XXXXXX78", "sentAt": "...", "attempts": 1 }` |
| Échoué | 200 | `{ "success": true, "messageId": "uuid", "status": "failed", "to": "+336XXXXXX78", "attempts": 3, "error": "Timeout" }` |
| Introuvable | 404 | `{ "success": false, "error": { "code": "MESSAGE_NOT_FOUND", "message": "Aucun message trouvé pour cet identifiant" } }` |

#### GET /api/v1/status

| Scénario | HTTP | Corps JSON |
|---|---|---|
| Connecté | 200 | `{ "success": true, "status": "connected", "phone": "+22997XXXX56", "name": "Admin", "connectedAt": "...", "queue": { "pending": 2, "failed": 0 } }` |
| Déconnecté | 200 | `{ "success": true, "status": "disconnected", "reason": "session_revoked" }` |
| Attente QR | 200 | `{ "success": true, "status": "awaiting_qr" }` |

#### DELETE /api/v1/session

| Scénario | HTTP | Corps JSON |
|---|---|---|
| Succès | 200 | `{ "success": true, "message": "Session supprimée. Un nouveau QR code sera généré." }` |
| Erreur | 500 | `{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "Erreur lors de la déconnexion" } }` |

### Événements Socket.io

**Authentification au handshake :**
```javascript
const socket = io('http://127.0.0.1:3005', {
  auth: { token: 'BRIDGE_API_KEY' }
})
```

**Événements serveur → client :**

| Événement | Données | Déclencheur |
|---|---|---|
| `status_update` | `{ status, phone?, name?, connectedAt? }` | Tout changement d'état |
| `qr` | `string` (base64 PNG) | Nouveau QR généré |
| `ready` | `{ status, phone, name, connectedAt }` | Connexion établie |
| `logged_out` | `{ reason }` | Déconnexion définitive |
| `message_received` | `{ from, text, timestamp }` | Message entrant |
| `queue_update` | `{ messageId, status, position? }` | Changement dans la file |

---

## Data Models

### SessionStatus
```typescript
type SessionStatus = 'active' | 'disconnected' | 'revoked'
```

### ConnectionStatus
```typescript
type ConnectionStatus =
  | { status: 'connected'; phone: string; name: string; connectedAt: string }
  | { status: 'disconnected'; reason?: DisconnectReason }
  | { status: 'awaiting_qr' }
```

### DisconnectReason
```typescript
type DisconnectReason = 'session_revoked' | 'logged_out' | 'network' | 'not_initialized'
```

### MessageStatus
```typescript
type MessageStatus = 'queued' | 'sending' | 'sent' | 'failed'
```

### QueuedMessage
```typescript
interface QueuedMessage {
  id: string            // UUID v4
  recipient: string     // Numéro nettoyé (chiffres uniquement)
  jid: string | null    // JID résolu avant envoi
  message: string       // Contenu du message
  status: MessageStatus
  attempts: number
  lastError: string | null
  queuedAt: Date
  sentAt: Date | null
}
```

### AlertDetails
```typescript
interface AlertDetails {
  phone: string         // Numéro masqué du compte déconnecté
  reason: string        // Raison de la déconnexion
  occurredAt: string    // ISO 8601
}
```

### Schéma MySQL

**Table `wa_sessions` :**
```sql
CREATE TABLE wa_sessions (
  id            VARCHAR(64)   NOT NULL PRIMARY KEY,
  creds_iv      VARCHAR(32)   NOT NULL,
  creds_tag     VARCHAR(32)   NOT NULL,
  creds_data    LONGTEXT      NOT NULL,
  phone         VARCHAR(20)   DEFAULT NULL,
  display_name  VARCHAR(100)  DEFAULT NULL,
  status        ENUM('active','disconnected','revoked') NOT NULL DEFAULT 'disconnected',
  connected_at  DATETIME      DEFAULT NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

**Table `wa_message_queue` :**
```sql
CREATE TABLE wa_message_queue (
  id          VARCHAR(36)  NOT NULL PRIMARY KEY,
  recipient   VARCHAR(30)  NOT NULL,
  jid         VARCHAR(50)  DEFAULT NULL,
  message     TEXT         NOT NULL,
  status      ENUM('queued','sending','sent','failed') NOT NULL DEFAULT 'queued',
  attempts    TINYINT      NOT NULL DEFAULT 0,
  last_error  TEXT         DEFAULT NULL,
  queued_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at     DATETIME     DEFAULT NULL,
  INDEX idx_status (status),
  INDEX idx_queued_at (queued_at)
);
```

**Table `wa_logs` :**
```sql
CREATE TABLE wa_logs (
  id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  level       ENUM('debug','info','warn','error') NOT NULL,
  component   VARCHAR(50)  NOT NULL,
  message     TEXT         NOT NULL,
  context     JSON         DEFAULT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_level (level),
  INDEX idx_component (component),
  INDEX idx_created_at (created_at)
);
```

---

## Error Handling

### Principe général

Toutes les réponses d'erreur suivent la même enveloppe JSON :
```json
{
  "success": false,
  "error": {
    "code": "CODE_ERREUR",
    "message": "Description lisible"
  }
}
```

En production, les messages d'erreur sont génériques. En développement, ils exposent le détail.

### Catalogue des codes d'erreur

| Code | HTTP | Cause |
|---|---|---|
| `UNAUTHORIZED` | 401 | Clé API absente ou invalide |
| `VALIDATION_ERROR` | 400 | Corps de requête invalide (champ manquant, type incorrect, contrainte violée) |
| `PHONE_NOT_ON_WHATSAPP` | 404 | Numéro résolu mais non enregistré sur WhatsApp |
| `MESSAGE_NOT_FOUND` | 404 | `messageId` inconnu |
| `SERVICE_NOT_CONNECTED` | 503 | Socket Baileys non prêt au moment de l'appel |
| `RATE_LIMIT_EXCEEDED` | 429 | Fenêtre de rate limit dépassée |
| `INTERNAL_ERROR` | 500 | Erreur non anticipée |

### Messages d'erreur de validation — liste exhaustive

| Champ | Condition | Message |
|---|---|---|
| `to` | absent | "Le champ 'to' est requis" |
| `to` | type non string | "Le champ 'to' doit être une chaîne de caractères" |
| `to` | format invalide | "Format de numéro invalide — chiffres uniquement, indicatif international requis" |
| `message` | absent | "Le champ 'message' est requis" |
| `message` | type non string | "Le champ 'message' doit être une chaîne de caractères" |
| `message` | vide après trim | "Le message ne peut pas être vide" |
| `message` | > 4096 chars | "Le message ne peut pas dépasser 4096 caractères" |

### Gestion des erreurs dans la file d'attente

| Erreur | Comportement |
|---|---|
| Numéro non trouvé sur WhatsApp | `status = 'failed'`, `last_error = 'PHONE_NOT_ON_WHATSAPP'`, pas de retry |
| Timeout d'envoi (> 15s) | retry si `attempts < 3`, sinon `failed` |
| Socket non connecté au moment du traitement | pause du worker jusqu'à reconnexion |
| Erreur réseau transitoire | retry avec backoff exponentiel |

### Gestion des erreurs d'alerte e-mail

Si l'envoi d'e-mail échoue, l'erreur est journalisée en `error` mais ne bloque pas le service.
L'alerte n'est tentée qu'une seule fois par événement de déconnexion.

---

## Correctness Properties

### Property 1: Envoi séquentiel garanti
Le `QueueProcessor` ne lance jamais deux `sendMessage` en parallèle. Un seul message est en cours d'envoi à tout instant.

**Validates: Requirements 4.1**

### Property 2: Idempotence au redémarrage
Au redémarrage, tout message dont le statut est `sending` est automatiquement remis en `queued`. Aucun message ne reste bloqué indéfiniment dans un état intermédiaire.

**Validates: Requirements 4.1**

### Property 3: Session restaurée ou régénérée
Au démarrage, si `wa_sessions` contient une entrée avec `status = 'active'`, le service tente de se reconnecter sans afficher de QR code. Si la tentative échoue, un nouveau QR est généré.

**Validates: Requirements 2.2**

### Property 4: Alerte e-mail unique par événement
Un seul e-mail est envoyé par événement de déconnexion définitive. Les déconnexions réseau temporaires ne déclenchent aucune alerte.

**Validates: Requirements 5.2**

### Property 5: Déconnexion propre et ordonnée
`DELETE /api/v1/session` ferme le socket Baileys proprement avant de supprimer la session en base. La session n'est jamais supprimée sans que le socket soit fermé d'abord.

**Validates: Requirements 2.3, 3.4**

### Property 6: Confidentialité des numéros
Aucun numéro de téléphone complet n'apparaît dans les logs, les réponses d'erreur ou les événements Socket.io. Les numéros sont systématiquement masqués (ex: `+336XXXXXX78`).

**Validates: Requirements 6.5**

---

## Testing Strategy

> Les tests seront définis et exécutés dans un sprint dédié, après l'implémentation.

### Couverture cible

| Composant | Type de test | Priorité |
|---|---|---|
| `crypto.ts` | Unitaire — chiffrement/déchiffrement aller-retour | Haute |
| `config.ts` | Unitaire — variables manquantes, valeurs par défaut | Haute |
| `MessageQueue.ts` | Unitaire — enqueue, dequeue, updateStatus | Haute |
| `auth.ts` (middleware) | Unitaire — clé valide, clé absente, timing-safe | Haute |
| `validate.ts` (middleware) | Unitaire — tous les cas du catalogue d'erreurs | Haute |
| `POST /send` | Intégration — 202, 400, 503 | Haute |
| `GET /status` | Intégration — connected, disconnected, awaiting_qr | Moyenne |
| `QueueProcessor` | Intégration — FIFO, retry, délai | Moyenne |
| Socket.io auth | Intégration — handshake valide/invalide | Moyenne |

### Environnement de test
- Base de données de test isolée (préfixe `test_`)
- Baileys mocké pour les tests d'intégration
- Pas de connexion WhatsApp réelle dans les tests automatisés

---

## Variables d'environnement — Référence complète

```env
# ── Serveur ──────────────────────────────────────
PORT=3005
NODE_ENV=development            # development | production

# ── Sécurité ─────────────────────────────────────
BRIDGE_API_KEY=                 # OBLIGATOIRE en production (openssl rand -hex 32)
CORS_ORIGIN=*                   # * en dev, URL exacte en prod
SESSION_ENCRYPTION_KEY=         # OBLIGATOIRE (openssl rand -hex 32)

# ── Base de données ───────────────────────────────
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=whatsapp_service
DB_USER=root
DB_PASS=

# ── File d'attente ────────────────────────────────
MESSAGE_DELAY_MS=1500           # Délai minimum entre deux envois (ms)
MESSAGE_DELAY_MAX_MS=3000       # Délai maximum (aléatoire entre min et max)
MAX_RETRY_ATTEMPTS=3            # Tentatives max avant statut 'failed'

# ── Dashboard ─────────────────────────────────────
ENABLE_DASHBOARD=false          # true uniquement en dev ou avec protection nginx

# ── Alertes e-mail ────────────────────────────────
ALERT_EMAIL=                    # Destinataire des alertes de déconnexion
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=whatsapp-service@votre-domaine.com

# ── Logging ───────────────────────────────────────
LOG_LEVEL=info                  # debug | info | warn | error
```

---

## Dépendances npm — Liste définitive

### Production
| Package | Rôle |
|---|---|
| `@whiskeysockets/baileys` (version épinglée) | Client WhatsApp Web |
| `@hapi/boom` | Erreurs HTTP structurées (requis par Baileys) |
| `express ^5.2.1` | Serveur HTTP |
| `socket.io ^4.8.3` | WebSocket temps réel |
| `cors ^2.8.6` | Middleware CORS |
| `helmet ^8.x` | Headers de sécurité HTTP |
| `dotenv ^17.x` | Chargement `.env` |
| `mysql2 ^3.x` | Driver MySQL/MariaDB |
| `pino ^10.x` | Logging JSON structuré |
| `pino-pretty ^13.x` | Affichage lisible en développement |
| `nodemailer ^6.x` | Envoi d'alertes e-mail |
| `qrcode ^1.5.4` | Génération QR code base64 |
| `uuid ^11.x` | Génération UUID v4 pour messageId |

### Développement
| Package | Rôle |
|---|---|
| `tsx ^4.x` | Exécution TypeScript direct (remplace ts-node) |
| `typescript ^5.x` | Compilateur TS |
| `@types/node ^20.x` | Types Node.js |
| `@types/express ^5.x` | Types Express |
| `@types/cors ^2.x` | Types CORS |
| `@types/qrcode ^1.x` | Types QRCode |
| `@types/nodemailer ^6.x` | Types Nodemailer |
| `@types/uuid ^10.x` | Types UUID |
