# WhatsApp Gateway

Service Node.js/TypeScript — API REST générique pour envoyer des messages WhatsApp,
gérer des sessions multi-tenant et authentifier des utilisateurs via Firebase.

---

## Démarrage rapide (collab)

### Prérequis
- Node.js ≥ 20
- MySQL / MariaDB (XAMPP)
- Fichier `whatsappservice-50e51-firebase-adminsdk-fbsvc-d35a2c107b.json` (demande à l'équipe — **ne jamais committer**)

### Installation

```bash
npm install
cp .env.example .env
# Remplir .env (voir section Configuration ci-dessous)
```

### Base de données

```sql
CREATE DATABASE whatsapp_service CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Les tables sont créées **automatiquement** au démarrage.

### Lancer le service

```bash
npm run dev
```

Le service démarre sur `http://127.0.0.1:3005`.
La doc Swagger est disponible sur `http://127.0.0.1:3005/api/v1/docs`.

### QR Code admin (premier démarrage)

1. Ouvrir `http://127.0.0.1:3005` dans le navigateur
2. Scanner le QR code avec WhatsApp → Appareils liés → Lier un appareil
3. Une fois connecté : "Service Opérationnel" s'affiche

> Si le QR ne s'affiche pas dans le dashboard, attendre ~5 secondes et rafraîchir la page.

---

## Configuration (.env)

```env
# Serveur
PORT=3005
NODE_ENV=development

# Sécurité API
BRIDGE_API_KEY=                         # vide en dev, obligatoire en prod
CORS_ORIGIN=*
SESSION_ENCRYPTION_KEY=dev-key-change-me-in-production-xx

# Base de données MySQL
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=whatsapp_service
DB_USER=root
DB_PASS=

# File d'attente
MESSAGE_DELAY_MS=1500
MESSAGE_DELAY_MAX_MS=3000
MAX_RETRY_ATTEMPTS=3

# Dashboard
ENABLE_DASHBOARD=true

# Alertes email (optionnel)
ALERT_EMAIL=
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=whatsapp-service@localhost

# Logging
LOG_LEVEL=info

# Firebase
FIREBASE_PROJECT_ID=whatsappservice-50e51
FIREBASE_SERVICE_ACCOUNT_PATH=./whatsappservice-50e51-firebase-adminsdk-fbsvc-d35a2c107b.json
FIREBASE_WEB_API_KEY=AIzaSyC1QO7iJdYlu6yRdFWV_LF9_lmw1ZjcZiA
```

---

## Architecture

```
Frontend / App
    │
    ├── Firebase SDK (Google/GitHub OAuth) ──► Firebase Auth
    │                                              │ ID Token
    │◄──────────────────────────────────────────────┘
    │
    │  REST  (Authorization: Bearer <idToken>  ou  X-Api-Key)
    ▼
whatsapp-service (Node.js)
    │
    ├── Auth routes       ← Firebase Admin SDK vérifie les tokens
    ├── WhatsAppManager   ← numéro admin fixe (envoi OTP, notifications)
    ├── TenantManager     ← sessions WhatsApp indépendantes par client
    ├── QueueProcessor    ← file FIFO anti-spam
    └── MySQL             ← users, OTP, sessions, messages
    │
    ▼
WhatsApp Web (Baileys)
```

---

## Authentification — 3 modes

### Mode 1 — Google / GitHub (Firebase OAuth)

```
Frontend → Firebase SDK signInWithPopup(GoogleProvider)
         ← ID Token
Frontend → POST /api/v1/auth/verify   Authorization: Bearer <idToken>
         ← { user: { uid, email, displayName, provider } }
```

### Mode 2 — Numéro de téléphone (OTP WhatsApp)

```
1. Frontend → POST /api/v1/auth/phone/register   { phone: "22994119476" }
            ← 202 — OTP envoyé par WhatsApp

2. Utilisateur reçoit le code sur son téléphone et le saisit

3. Frontend → POST /api/v1/auth/phone/verify-otp  { phone, code }
            ← { customToken }

4. Frontend → Firebase SDK signInWithCustomToken(customToken)
            ← ID Token standard

5. Frontend → POST /api/v1/auth/verify   Authorization: Bearer <idToken>
            ← { user }
```

### Mode 3 — Clé API (admin / machine-to-machine)

```
Header: X-Api-Key: BRIDGE_API_KEY
```

---

## Flux complet — Onboarding tenant WhatsApp

```
1. Utilisateur s'authentifie (Google, GitHub ou OTP) → obtient son uid Firebase

2. Frontend → POST /api/v1/tenants
              X-Api-Key: BRIDGE_API_KEY
              { phone, name, userUid, webhookUrl? }
            ← { tenantId, status: "pending_qr" }

3. Frontend poll → GET /api/v1/tenants/:id/qr
                 ← { qrCode: "data:image/png;base64,..." }
   Frontend affiche le QR

4. Utilisateur scanne le QR avec son WhatsApp

5. Service détecte la connexion →
   - Génère clé API unique (wag_live_...) chiffrée en base
   - Émet via Socket.io : tenant_connected { tenantId, apiKey }
   - Appelle webhookUrl si fourni

6. Frontend affiche la clé API à l'utilisateur via Socket.io
   L'utilisateur peut la retrouver à tout moment via GET /api/v1/tenants/:id/api-key
```

> La clé API n'est **jamais** renvoyée par WhatsApp — c'est le frontend qui l'affiche.
> Un seul numéro WhatsApp ne peut pas être connecté deux fois simultanément.

---

## Endpoints — Référence complète

### Authentification

| Méthode | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/verify` | Bearer | Vérifier un ID Token Firebase |
| `GET` | `/api/v1/auth/me` | Bearer | Profil utilisateur connecté |
| `POST` | `/api/v1/auth/logout` | Bearer | Révoquer les tokens Firebase |
| `POST` | `/api/v1/auth/phone/register` | — | Inscription par téléphone (OTP) |
| `POST` | `/api/v1/auth/phone/verify-otp` | — | Vérifier l'OTP |
| `POST` | `/api/v1/auth/phone/login` | — | Connexion compte existant |
| `GET` | `/api/v1/auth/users` | X-Api-Key | Lister les utilisateurs (admin) |
| `DELETE` | `/api/v1/auth/users/:uid` | X-Api-Key | Désactiver un compte (admin) |

### Tenants (sessions WhatsApp)

| Méthode | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/tenants` | X-Api-Key | Créer un tenant + démarrer QR |
| `GET` | `/api/v1/tenants` | X-Api-Key | Lister tous les tenants |
| `GET` | `/api/v1/tenants/:id` | X-Api-Key | Statut d'un tenant |
| `GET` | `/api/v1/tenants/:id/qr` | X-Api-Key | QR code courant (base64 PNG) |
| `GET` | `/api/v1/tenants/:id/api-key` | X-Api-Key | Clé API complète (affichage dashboard) |
| `DELETE` | `/api/v1/tenants/:id` | X-Api-Key | Supprimer un tenant |

### Messages

| Méthode | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/messages/send` | X-Api-Key | Envoyer un message (texte ou média) |
| `GET` | `/api/v1/messages/:id` | X-Api-Key | Statut d'un message |
| `GET` | `/api/v1/messages/media-limits` | X-Api-Key | Limites fichiers WhatsApp |

### Service

| Méthode | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/status` | X-Api-Key | État connexion admin + file |
| `DELETE` | `/api/v1/session` | X-Api-Key | Réinitialiser session admin |
| `GET` | `/api/v1/docs` | — | Swagger UI interactif |
| `GET` | `/api/v1/openapi.json` | — | Spec OpenAPI (import Postman) |

---

## Envoyer des messages

```
POST /api/v1/messages/send
X-Api-Key: BRIDGE_API_KEY
Content-Type: application/json
```

**Texte seul :**
```json
{ "to": "22994119476", "message": "Votre code : 483920" }
```

**Fichier + message :**
```json
{
  "to": "22994119476",
  "message": "Voici votre document",
  "media": {
    "type": "document",
    "mime": "application/pdf",
    "name": "contrat.pdf",
    "base64": "JVBERi0xLjQK..."
  }
}
```

**Réponse (202) :**
```json
{ "success": true, "queued": true, "messageId": "uuid", "position": 1 }
```

### Formats acceptés

| Type | Formats | Max |
|---|---|---|
| `image` | JPEG, PNG | 5 MB |
| `video` | MP4 (H.264 + AAC) | 16 MB |
| `audio` | MP3, M4A, OGG/Opus | 16 MB |
| `document` | PDF, Word, Excel, PPT, ZIP, TXT | 100 MB |

---

## Guide d'intégration — Pour les utilisateurs du service (tenants)

> Ce guide s'adresse aux développeurs qui ont créé un compte sur la plateforme
> et souhaitent intégrer l'envoi de messages WhatsApp dans leur propre application.

### Ce que vous avez reçu après inscription

Une **clé API unique** de la forme :
```
wag_live_a3f8c2d1e9b4f7a0c5e2d8b1f6a3c9e4d7b0f2a5c8e1d4b7f0a3c6e9d2b5f8a1
```

Et une **URL de base** :
```
https://votre-domaine.com   (ou http://127.0.0.1:3005 en local)
```

> ⚠️ La clé n'est affichée qu'une seule fois au moment de la connexion. Stockez-la dans les variables d'environnement de votre application, jamais dans le code source.
>
> Si vous l'avez perdue, votre dashboard peut la récupérer à tout moment via l'API.

### Récupérer sa clé API à tout moment

Si l'utilisateur a besoin de revoir sa clé depuis le dashboard :

```
GET {URL_BASE}/api/v1/tenants/{tenantId}/api-key
X-Api-Key: BRIDGE_API_KEY
```

```json
{
  "success": true,
  "tenantId": "3f2504e0-...",
  "apiKey": "wag_live_a3f8c2d1e9b4f7a0...",
  "apiKeyHint": "wag_live_a3f8..."
}
```

La clé est stockée chiffrée en base (AES-256-GCM) et déchiffrée à la demande. Elle n'est jamais exposée en clair dans la base de données.

---

### Comment ça marche

Vous envoyez une requête HTTP POST à notre service avec :
- le numéro de téléphone du destinataire
- le message à envoyer

Notre service envoie le message via **votre numéro WhatsApp** connecté au scan du QR.

```
Votre application
      │
      │  POST /api/v1/messages/send
      │  X-Api-Key: wag_live_votre-cle
      │  { "to": "33612345678", "message": "..." }
      ▼
WhatsApp Gateway
      │
      ▼
Destinataire reçoit le message WhatsApp
(depuis votre numéro connecté)
```

---

### Envoyer un message texte

**Requête :**
```
POST {URL_BASE}/api/v1/messages/send
Content-Type: application/json
X-Api-Key: wag_live_votre-cle
```

```json
{
  "to": "33612345678",
  "message": "Bonjour, votre commande est prête !"
}
```

> Le numéro `to` doit inclure l'indicatif international, sans le `+`.
> Exemples : `33612345678` (France), `22994119476` (Bénin), `12025550123` (USA)

**Réponse succès (202) :**
```json
{
  "success": true,
  "queued": true,
  "messageId": "550e8400-e29b-41d4-a716-446655440000",
  "position": 1
}
```

Conservez le `messageId` pour vérifier l'état de l'envoi.

---

### Vérifier si le message est parti

```
GET {URL_BASE}/api/v1/messages/550e8400-e29b-41d4-a716-446655440000
X-Api-Key: wag_live_votre-cle
```

```json
{
  "success": true,
  "messageId": "550e8400-...",
  "status": "sent",
  "to": "336XXXXXX78",
  "sentAt": "2026-07-23T10:30:05.000Z",
  "attempts": 1
}
```

Statuts possibles : `queued` → `sending` → `sent` ou `failed`

---

### Envoyer un fichier (PDF, image, vidéo…)

```json
{
  "to": "33612345678",
  "message": "Voici votre facture",
  "media": {
    "type": "document",
    "mime": "application/pdf",
    "name": "facture-2026-07.pdf",
    "base64": "JVBERi0xLjQK..."
  }
}
```

Pour les images :
```json
{
  "to": "33612345678",
  "media": {
    "type": "image",
    "mime": "image/jpeg",
    "base64": "/9j/4AAQSkZJRgAB..."
  }
}
```

Formats et limites :

| Type | Formats | Taille max |
|---|---|---|
| `image` | JPEG, PNG | 5 MB |
| `video` | MP4 | 16 MB |
| `audio` | MP3, M4A, OGG | 16 MB |
| `document` | PDF, Word, Excel, PPT, ZIP, TXT | 100 MB |

---

### Exemples par langage

**Laravel (PHP) :**
```php
// Dans config/services.php
// 'whatsapp' => ['url' => env('WAG_URL'), 'key' => env('WAG_API_KEY')]

// Envoi
$response = Http::withHeaders(['X-Api-Key' => config('services.whatsapp.key')])
    ->post(config('services.whatsapp.url') . '/api/v1/messages/send', [
        'to'      => $user->phone,
        'message' => "Bonjour {$user->name}, votre commande est confirmée.",
    ]);

if ($response->successful()) {
    $messageId = $response->json('messageId');
    // Stocker $messageId pour suivi
}
```

**Node.js / Express :**
```javascript
// .env : WAG_URL=http://... WAG_API_KEY=wag_live_...

async function sendWhatsApp(to, message) {
    const res = await fetch(`${process.env.WAG_URL}/api/v1/messages/send`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Api-Key':    process.env.WAG_API_KEY,
        },
        body: JSON.stringify({ to, message }),
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.error?.message)
    return data.messageId
}
```

**NestJS :**
```typescript
// whatsapp.service.ts
@Injectable()
export class WhatsAppService {
    constructor(private readonly httpService: HttpService) {}

    async send(to: string, message: string): Promise<string> {
        const { data } = await this.httpService.post(
            `${process.env.WAG_URL}/api/v1/messages/send`,
            { to, message },
            { headers: { 'X-Api-Key': process.env.WAG_API_KEY } }
        ).toPromise()

        return data.messageId
    }
}
```

**Python (Django / Flask) :**
```python
import os, requests

WAG_URL = os.environ['WAG_URL']
WAG_KEY = os.environ['WAG_API_KEY']

def send_whatsapp(to: str, message: str) -> str:
    resp = requests.post(
        f'{WAG_URL}/api/v1/messages/send',
        json={'to': to, 'message': message},
        headers={'X-Api-Key': WAG_KEY},
        timeout=10
    )
    resp.raise_for_status()
    return resp.json()['messageId']
```

**Java (Spring Boot) :**
```java
// application.properties : wag.url=... wag.api-key=wag_live_...

@Service
public class WhatsAppService {

    @Value("${wag.url}")     private String wagUrl;
    @Value("${wag.api-key}") private String wagKey;

    private final RestTemplate restTemplate = new RestTemplate();

    public String send(String to, String message) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-Api-Key", wagKey);
        headers.setContentType(MediaType.APPLICATION_JSON);

        Map<String, String> body = Map.of("to", to, "message", message);
        ResponseEntity<Map> resp = restTemplate.exchange(
            wagUrl + "/api/v1/messages/send",
            HttpMethod.POST,
            new HttpEntity<>(body, headers),
            Map.class
        );
        return (String) resp.getBody().get("messageId");
    }
}
```

**C# (.NET) :**
```csharp
// appsettings.json : "Wag": { "Url": "...", "ApiKey": "wag_live_..." }

public class WhatsAppService
{
    private readonly HttpClient _http;
    private readonly string _apiKey;

    public WhatsAppService(HttpClient http, IConfiguration config)
    {
        _http   = http;
        _apiKey = config["Wag:ApiKey"]!;
        _http.BaseAddress = new Uri(config["Wag:Url"]!);
    }

    public async Task<string> SendAsync(string to, string message)
    {
        _http.DefaultRequestHeaders.Remove("X-Api-Key");
        _http.DefaultRequestHeaders.Add("X-Api-Key", _apiKey);

        var resp = await _http.PostAsJsonAsync("/api/v1/messages/send",
            new { to, message });
        resp.EnsureSuccessStatusCode();

        var data = await resp.Content.ReadFromJsonAsync<JsonElement>();
        return data.GetProperty("messageId").GetString()!;
    }
}
```

**Go :**
```go
func SendWhatsApp(to, message string) (string, error) {
    body, _ := json.Marshal(map[string]string{"to": to, "message": message})
    req, _ := http.NewRequest("POST", os.Getenv("WAG_URL")+"/api/v1/messages/send",
        bytes.NewBuffer(body))
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("X-Api-Key", os.Getenv("WAG_API_KEY"))

    resp, err := http.DefaultClient.Do(req)
    if err != nil { return "", err }
    defer resp.Body.Close()

    var data map[string]interface{}
    json.NewDecoder(resp.Body).Decode(&data)
    return data["messageId"].(string), nil
}
```

---

### Variables d'environnement recommandées

Peu importe le langage, stockez toujours :

```env
WAG_URL=https://votre-domaine.com
WAG_API_KEY=wag_live_a3f8c2d1e9b4f7a0...
```

Ne mettez jamais la clé en dur dans le code source.

---

### Erreurs courantes

| Erreur reçue | Cause | Solution |
|---|---|---|
| `401 UNAUTHORIZED` | Clé API absente ou mal placée | Vérifiez le header `X-Api-Key` |
| `400 VALIDATION_ERROR` | Numéro invalide | Numéro en chiffres uniquement, avec indicatif (ex: `33612345678`) |
| `503 SERVICE_NOT_CONNECTED` | Votre WhatsApp est déconnecté | Reconnectez-vous depuis le dashboard |
| `404 PHONE_NOT_ON_WHATSAPP` | Destinataire n'a pas WhatsApp | Vérifiez le numéro |
| `429 RATE_LIMIT_EXCEEDED` | Trop de requêtes rapides | Ajoutez un délai entre les appels |

---

## Socket.io — Événements temps réel

```javascript
const socket = io('http://127.0.0.1:3005', {
  auth: { token: 'BRIDGE_API_KEY' }  // optionnel si pas de clé en dev
})
```

| Événement | Données | Description |
|---|---|---|
| `status_update` | `{ status, phone?, name? }` | État connexion admin |
| `qr` | `string` base64 PNG | QR code admin |
| `ready` | `{ status, phone, name }` | Admin connecté |
| `logged_out` | `{ reason }` | Admin déconnecté |
| `tenant_qr` | `{ tenantId, qrCode }` | QR code d'un tenant |
| `tenant_connected` | `{ tenantId, phone, apiKey }` | Tenant connecté + clé API |
| `tenant_status_update` | `{ tenantId, status }` | Changement statut tenant |
| `queue_update` | `{ messageId, status }` | Statut message dans la file |

---

## Codes d'erreur

| Code | HTTP | Description |
|---|---|---|
| `UNAUTHORIZED` | 401 | Clé API ou token Bearer absent/invalide |
| `TOKEN_EXPIRED` | 401 | ID Token Firebase expiré |
| `TOKEN_REVOKED` | 403 | Token révoqué après logout |
| `FORBIDDEN_PROVIDER` | 403 | Provider OAuth non autorisé |
| `VALIDATION_ERROR` | 400 | Champ manquant ou invalide |
| `PHONE_NOT_ON_WHATSAPP` | 404 | Numéro non enregistré sur WhatsApp |
| `MESSAGE_NOT_FOUND` | 404 | messageId inconnu |
| `TENANT_NOT_FOUND` | 404 | tenantId inconnu |
| `TENANT_ALREADY_EXISTS` | 409 | Numéro déjà connecté |
| `PHONE_ALREADY_REGISTERED` | 409 | Numéro déjà inscrit |
| `PHONE_NOT_REGISTERED` | 404 | Numéro non inscrit (utiliser /register) |
| `WHATSAPP_UNAVAILABLE` | 503 | Service WhatsApp non connecté |
| `SERVICE_NOT_CONNECTED` | 503 | Admin WhatsApp déconnecté |
| `RATE_LIMIT_EXCEEDED` | 429 | Trop de requêtes |
| `INTERNAL_ERROR` | 500 | Erreur interne |

---

## Scripts utiles

```bash
npm run dev          # Démarrer en développement (hot-reload)
npm run build        # Compiler TypeScript
npm start            # Démarrer en production
npm run test:auth    # Tester toutes les routes d'authentification
```

*Dernière mise à jour : 2026-07-23*
