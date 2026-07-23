# WhatsApp Gateway — Guide d'intégration

> **Pour les équipes partenaires** — ce document décrit tout ce dont vous avez besoin pour intégrer le service WhatsApp Gateway dans votre application.
>
> Mis à jour en continu au fur et à mesure des développements.

---

## Fonctionnement prévu entre nos deux services

Voici le fonctionnement que j'ai prévu entre nos deux services :

### 1. Authentification utilisateur

- L'utilisateur arrive sur votre service et lance le processus d'authentification.
- Votre service génère une demande avec le numéro de téléphone de l'utilisateur et un code de vérification.
- Vous m'envoyez le numéro ainsi que le code à transmettre.
- Mon service se charge d'envoyer le message WhatsApp contenant ce code au numéro concerné.

### 2. Validation du code

- L'utilisateur saisit le même code reçu par WhatsApp dans votre interface.
- Votre service vérifie que le code correspond.
- Si la vérification est correcte, vous me demandez de créer une nouvelle session utilisateur.

### 3. Création de session et génération du QR Code

- Après validation, mon service crée une nouvelle session.
- La première étape de cette nouvelle session est la génération d'un code QR unique.
- Mon service transmet ce QR Code à votre service.
- Votre service l'intègre dans son dashboard afin de l'afficher à l'utilisateur.

### 4. Scan du QR Code

- L'utilisateur scanne le QR Code affiché dans votre dashboard.
- Mon service détecte la validation du scan.
- Une fois le scan confirmé, mon service génère automatiquement une clé API unique pour ce compte.

### 5. Génération de la clé API

La clé API sera générée selon les bonnes pratiques de sécurité.

### 6. Transmission de la clé API

Une fois générée :

- Mon service envoie la clé API à votre dashboard via une API sécurisée.
- Votre dashboard l'affiche à l'utilisateur selon vos règles d'interface.

En parallèle :

- Mon service envoie automatiquement une notification WhatsApp au même numéro utilisé au début du processus.

**Message envoyé par WhatsApp :**

> Félicitations ! Votre compte a été créé avec succès.
>
> Votre accès API est maintenant disponible.
>
> Votre clé API unique :
> [CLÉ API]
>
> Conservez cette clé précieusement. Elle vous permettra d'utiliser nos services en toute sécurité.
>
> Merci pour votre confiance.

L'objectif est que votre service gère toute la partie interface/dashboard, tandis que mon service gère l'authentification WhatsApp, les sessions, le QR Code, la connexion et la génération sécurisée des clés API.

---

## Informations de connexion

| Info | Valeur |
|---|---|
| **URL de base** | `http://127.0.0.1:3005` (local) — sera remplacée par l'URL de production |
| **Clé API admin** | Valeur de `BRIDGE_API_KEY` — fournie par l'équipe |
| **Header d'auth** | `X-Api-Key: votre-cle` sur chaque requête |

> En local sans `BRIDGE_API_KEY` définie, le header n'est pas obligatoire.

---

## Partie 1 — Onboarding d'un client (connexion WhatsApp)

Ce flux permet à un nouveau client de connecter son numéro WhatsApp au service et d'obtenir sa clé API personnelle.

### Vue d'ensemble du flux

```
1. Client s'inscrit sur votre plateforme
        │
        ▼
2. Votre backend → POST /api/v1/messages/send   ← envoie le code de vérif par WhatsApp
        │
        ▼
3. Client reçoit le code sur son téléphone et le saisit sur votre plateforme
        │
        ▼
4. Votre backend vérifie le code
        │  ✅ code correct
        ▼
5. Votre backend → POST /api/v1/tenants          ← crée la session
        │
        ▼
6. Votre backend poll GET /api/v1/tenants/:id/qr  ← récupère le QR code
        │
        ▼
7. Votre dashboard affiche le QR → client scanne avec son WhatsApp
        │
        ▼
8. Le service génère la clé API + notifie votre webhook + envoie WhatsApp de confirmation
```

---

### Étape 1 — Envoyer le code de vérification

Utilisez le numéro admin (déjà connecté au service) pour envoyer le code au client.

```
POST /api/v1/messages/send
X-Api-Key: BRIDGE_API_KEY
Content-Type: application/json
```

```json
{
  "to": "22994119476",
  "message": "Votre code de vérification WhatsApp Gateway : 483920\n\nCe code expire dans 10 minutes."
}
```

**Réponse (202) :**
```json
{
  "success": true,
  "queued": true,
  "messageId": "550e8400-e29b-41d4-a716-446655440000",
  "position": 1
}
```

> Le numéro `to` accepte n'importe quel format international : `22994119476`, `+22994119476`, `+1 555 123 4567`, etc.

---

### Étape 2 — Créer la session après validation du code

Appelez cet endpoint **uniquement après avoir vérifié** que le code saisi par le client correspond à celui envoyé.

```
POST /api/v1/tenants
X-Api-Key: BRIDGE_API_KEY
Content-Type: application/json
```

```json
{
  "phone": "22994119476",
  "name": "Nom ou email du client",
  "webhookUrl": "https://votre-backend.com/webhooks/whatsapp"
}
```

| Champ | Obligatoire | Description |
|---|---|---|
| `phone` | ✅ | Numéro international du client (chiffres uniquement) |
| `name` | ❌ | Nom ou identifiant pour référence |
| `webhookUrl` | ❌ | URL où le service vous notifiera quand le client est connecté |

**Réponse (201) :**
```json
{
  "success": true,
  "tenantId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "status": "pending_qr",
  "message": "Session en cours de démarrage. Appelez GET /api/v1/tenants/:id/qr dans 3-5 secondes pour récupérer le QR code."
}
```

**Erreur possible — numéro déjà existant (409) :**
```json
{
  "success": false,
  "error": { "code": "TENANT_ALREADY_EXISTS", "message": "Un tenant avec ce numéro existe déjà" }
}
```

---

### Étape 3 — Récupérer et afficher le QR code

Appelez cet endpoint en polling (toutes les 2 secondes) jusqu'à recevoir le QR, puis affichez-le.

```
GET /api/v1/tenants/{tenantId}/qr
X-Api-Key: BRIDGE_API_KEY
```

**Réponse — QR disponible (200) :**
```json
{
  "success": true,
  "status": "pending_qr",
  "tenantId": "3f2504e0-...",
  "qrCode": "data:image/png;base64,iVBORw0KGgoAAAANS...",
  "expiresIn": 60,
  "instructions": "Afficher ce QR code à l'utilisateur. Il doit le scanner avec WhatsApp → Appareils liés → Lier un appareil."
}
```

**Réponse — QR pas encore prêt (202) :**
```json
{
  "success": false,
  "status": "pending_qr",
  "message": "QR code pas encore disponible — réessayez dans 2-3 secondes"
}
```

**Réponse — déjà connecté (200) :**
```json
{
  "success": true,
  "status": "connected",
  "message": "Ce tenant est déjà connecté"
}
```

#### Afficher le QR dans votre frontend

```html
<!-- L'image est directement utilisable comme src -->
<img src="{{ qrCode }}" alt="Scanner avec WhatsApp" width="256" height="256" />
```

```javascript
// Exemple de polling en JavaScript
async function waitForQr(tenantId, apiKey) {
  while (true) {
    const res  = await fetch(`/api/v1/tenants/${tenantId}/qr`, {
      headers: { 'X-Api-Key': apiKey }
    })
    const data = await res.json()

    if (data.status === 'connected') {
      // Déjà connecté — arrêter le polling
      break
    }
    if (data.qrCode) {
      // Afficher le QR
      document.getElementById('qr-img').src = data.qrCode
      // Le QR expire dans ~60s — Baileys en génère un nouveau automatiquement
    }
    await new Promise(r => setTimeout(r, 2000))  // attendre 2 secondes
  }
}
```

> ⚠️ **Important** : le QR expire après ~60 secondes. Si le client ne scanne pas à temps, un nouveau QR sera automatiquement généré. Continuez le polling.

---

### Étape 4 — Réception de la confirmation

Une fois le QR scanné, vous êtes notifié de deux façons :

#### Option A — Webhook (recommandé)

Si vous avez fourni `webhookUrl` à l'étape 2, le service vous envoie automatiquement :

```
POST https://votre-backend.com/webhooks/whatsapp
Content-Type: application/json
User-Agent: WhatsApp-Gateway/2.0
```

```json
{
  "event": "tenant.connected",
  "tenantId": "3f2504e0-...",
  "phone": "+229XXXXX76",
  "apiKey": "wag_live_a3f8c2d1e9b4f7a0c5e2d8b1f6a3c9e4d7b0f2a5c8e1d4b7f0a3c6e9d2b5f8a1",
  "apiKeyHint": "wag_live_a3f8...",
  "connectedAt": "2026-07-23T10:30:00.000Z"
}
```

> ⚠️ **La clé API complète n'est transmise qu'une seule fois** — stockez-la immédiatement. Elle ne sera plus accessible ensuite (seul le hint est conservé).

#### Option B — Polling sur le statut

```
GET /api/v1/tenants/{tenantId}
X-Api-Key: BRIDGE_API_KEY
```

```json
{
  "success": true,
  "tenantId": "3f2504e0-...",
  "phone": "+229XXXXX76",
  "name": "Client Test",
  "status": "connected",
  "apiKeyHint": "wag_live_a3f8...",
  "connectedAt": "2026-07-23T10:30:00.000Z",
  "createdAt": "2026-07-23T10:25:00.000Z"
}
```

> Le `status` passe de `pending_qr` → `connected` après le scan.

#### Notification WhatsApp automatique

Le client reçoit aussi ce message sur son téléphone dès le scan :

```
✅ Félicitations ! Votre compte WhatsApp Gateway est activé.

📱 Numéro lié : +229XXXXX76
🔑 Votre clé API :
wag_live_a3f8c2d1e9b4...

⚠️ Conservez cette clé précieusement — elle ne sera plus affichée.

📖 Intégrez-la dans vos applications via le header :
X-Api-Key: wag_live_a3f8c2...

Bonne intégration ! 🚀
```

---

## Partie 2 — Envoyer des messages

### L'endpoint unique

```
POST /api/v1/messages/send
X-Api-Key: BRIDGE_API_KEY
Content-Type: application/json
```

### Les 3 cas d'usage

**Cas 1 — Texte seul**
```json
{
  "to": "22994119476",
  "message": "Votre code est : 483920"
}
```

**Cas 2 — Fichier seul**
```json
{
  "to": "22994119476",
  "media": {
    "type": "document",
    "mime": "application/pdf",
    "name": "contrat.pdf",
    "base64": "JVBERi0xLjQK..."
  }
}
```

**Cas 3 — Fichier + message**
```json
{
  "to": "22994119476",
  "message": "Voici votre document",
  "media": {
    "type": "document",
    "mime": "application/pdf",
    "name": "page_de_garde.pdf",
    "base64": "JVBERi0xLjQK..."
  }
}
```

> Pour `url` à la place de `base64`, fournissez une URL publique accessible : `"url": "https://..."`.

### Réponses

**Succès (202) :**
```json
{
  "success": true,
  "queued": true,
  "messageId": "550e8400-e29b-41d4-a716-446655440000",
  "position": 1
}
```

**Erreurs possibles :**

| HTTP | `error.code` | Cause |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Champ manquant, format invalide, fichier trop lourd |
| 401 | `UNAUTHORIZED` | Clé API manquante ou invalide |
| 503 | `SERVICE_NOT_CONNECTED` | WhatsApp admin non connecté |
| 429 | `RATE_LIMIT_EXCEEDED` | Trop de requêtes |
| 500 | `INTERNAL_ERROR` | Erreur interne |

### Vérifier le statut d'un message

```
GET /api/v1/messages/{messageId}
X-Api-Key: BRIDGE_API_KEY
```

```json
{
  "success": true,
  "messageId": "550e8400-...",
  "status": "sent",
  "to": "+229XXXXX76",
  "sentAt": "2026-07-23T10:30:02.000Z",
  "attempts": 1
}
```

Valeurs de `status` : `queued` · `sending` · `sent` · `failed`

---

## Partie 3 — Gestion des tenants

### Lister tous les tenants

```
GET /api/v1/tenants
X-Api-Key: BRIDGE_API_KEY
```

```json
{
  "success": true,
  "count": 3,
  "tenants": [
    {
      "tenantId": "...",
      "phone": "+229XXXXX76",
      "name": "Client A",
      "status": "connected",
      "apiKeyHint": "wag_live_a3f8...",
      "connectedAt": "2026-07-23T10:30:00.000Z"
    }
  ]
}
```

### Supprimer un tenant

```
DELETE /api/v1/tenants/{tenantId}
X-Api-Key: BRIDGE_API_KEY
```

```json
{ "success": true, "message": "Tenant supprimé" }
```

---

## Partie 4 — Statut du service admin

```
GET /api/v1/status
X-Api-Key: BRIDGE_API_KEY
```

```json
{
  "success": true,
  "status": "connected",
  "phone": "+229XXXXX56",
  "name": "Compte Admin",
  "connectedAt": "2026-07-23T10:00:00.000Z",
  "queue": { "pending": 2, "failed": 0 }
}
```

Valeurs de `status` : `connected` · `awaiting_qr` · `disconnected`

---

## Types de fichiers acceptés

| Type | Formats | Taille max |
|---|---|---|
| `image` | JPEG, PNG | 5 MB |
| `video` | MP4 (H.264 + AAC) | 16 MB |
| `audio` | MP3, M4A, OGG/Opus | 16 MB |
| `document` | PDF, Word, Excel, PowerPoint, ZIP, TXT, CSV | 100 MB |

Pour connaître les limites dynamiquement :
```
GET /api/v1/messages/media-limits
X-Api-Key: BRIDGE_API_KEY
```

---

## Exemples de code

### Laravel (PHP)

```php
// Envoyer un code de vérification
$response = Http::withHeaders(['X-Api-Key' => config('services.whatsapp.key')])
    ->post(config('services.whatsapp.url') . '/api/v1/messages/send', [
        'to'      => $user->phone,
        'message' => "Votre code : {$code}",
    ]);

// Créer un tenant
$response = Http::withHeaders(['X-Api-Key' => config('services.whatsapp.key')])
    ->post(config('services.whatsapp.url') . '/api/v1/tenants', [
        'phone'      => $user->phone,
        'name'       => $user->name,
        'webhookUrl' => route('webhooks.whatsapp'),
    ]);
$tenantId = $response->json('tenantId');

// Récupérer le QR (avec retry)
do {
    sleep(2);
    $qr = Http::withHeaders(['X-Api-Key' => config('services.whatsapp.key')])
        ->get(config('services.whatsapp.url') . "/api/v1/tenants/{$tenantId}/qr")
        ->json();
} while (!isset($qr['qrCode']));

// $qr['qrCode'] est directement utilisable comme src d'une balise <img>
```

### Node.js / JavaScript

```javascript
const BASE_URL = process.env.WHATSAPP_URL
const API_KEY  = process.env.WHATSAPP_API_KEY
const headers  = { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY }

// Envoyer un message
const send = await fetch(`${BASE_URL}/api/v1/messages/send`, {
  method: 'POST', headers,
  body: JSON.stringify({ to: '22994119476', message: 'Code : 4839' }),
})
const { messageId } = await send.json()

// Créer un tenant
const create    = await fetch(`${BASE_URL}/api/v1/tenants`, {
  method: 'POST', headers,
  body: JSON.stringify({ phone: '22994119476', name: 'Client', webhookUrl: 'https://...' }),
})
const { tenantId } = await create.json()

// Attendre et récupérer le QR
async function getQr(tenantId) {
  while (true) {
    const res  = await fetch(`${BASE_URL}/api/v1/tenants/${tenantId}/qr`, { headers: { 'X-Api-Key': API_KEY } })
    const data = await res.json()
    if (data.qrCode) return data.qrCode
    await new Promise(r => setTimeout(r, 2000))
  }
}
```

### Python (Django / Flask)

```python
import requests, time

BASE_URL = 'http://127.0.0.1:3005'
HEADERS  = {'X-Api-Key': 'votre-cle', 'Content-Type': 'application/json'}

# Créer un tenant
resp      = requests.post(f'{BASE_URL}/api/v1/tenants',
    json={'phone': '22994119476', 'name': 'Client', 'webhookUrl': 'https://...'},
    headers=HEADERS)
tenant_id = resp.json()['tenantId']

# Attendre le QR
qr_code = None
while not qr_code:
    time.sleep(2)
    r = requests.get(f'{BASE_URL}/api/v1/tenants/{tenant_id}/qr', headers=HEADERS)
    qr_code = r.json().get('qrCode')

# qr_code est une data URI utilisable directement en HTML : <img src="{{ qr_code }}" />
```

---

## Catalogue des codes d'erreur

| Code | HTTP | Description |
|---|---|---|
| `UNAUTHORIZED` | 401 | Clé API absente ou invalide |
| `VALIDATION_ERROR` | 400 | Champ manquant, type incorrect, contrainte non respectée |
| `PHONE_NOT_ON_WHATSAPP` | 404 | Numéro non enregistré sur WhatsApp |
| `MESSAGE_NOT_FOUND` | 404 | `messageId` inconnu |
| `TENANT_NOT_FOUND` | 404 | `tenantId` inconnu |
| `TENANT_ALREADY_EXISTS` | 409 | Un tenant avec ce numéro existe déjà |
| `MEDIA_SOURCE_MISSING` | 400 | Média sans `url` ni `base64` |
| `MEDIA_TYPE_INVALID` | 400 | Type de média non supporté |
| `MEDIA_MIME_INVALID` | 400 | Format MIME non accepté pour ce type |
| `MEDIA_TOO_LARGE` | 400 | Fichier dépasse la limite WhatsApp |
| `SERVICE_NOT_CONNECTED` | 503 | Service WhatsApp admin non connecté |
| `RATE_LIMIT_EXCEEDED` | 429 | Trop de requêtes — réessayez dans un moment |
| `INTERNAL_ERROR` | 500 | Erreur interne |
| `NOT_FOUND` | 404 | Route inconnue |

---

## Architecture du service

```
Votre backend
    │
    │  REST JSON  (X-Api-Key)
    ▼
whatsapp-service (Node.js)
    │
    ├── WhatsAppManager     ← numéro admin fixe (envoi codes, confirmations)
    ├── TenantManager       ← sessions indépendantes par client
    ├── QueueProcessor      ← file FIFO — 1 message à la fois, anti-spam
    └── MySQL               ← sessions chiffrées AES-256, file persistante
    │
    ▼
WhatsApp Web (via Baileys)
```

**Numéros supportés** : tous les indicatifs internationaux — aucune restriction géographique.

**Disponibilité** : reconnexion automatique avec backoff exponentiel en cas de coupure réseau.

---

*Document maintenu par l'équipe whatsapp-service — dernière mise à jour : 2026-07-23*
