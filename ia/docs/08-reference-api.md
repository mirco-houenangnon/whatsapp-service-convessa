# Référence API Complète

## Base URL

```
https://convessa.epac-uac-optica-chapter.bj/api/v1
```

## Authentification

Toutes les requêtes doivent inclure le header :

```
X-API-Key: pk_convessa_votre_cle_api
```

---

## Endpoints

### POST /send — Envoyer un message

Envoie un message texte ou média à un contact ou groupe WhatsApp.

**Headers :**
```
X-API-Key: pk_convessa_...
Content-Type: application/json
```

**Corps (message texte) :**
```json
{
  "recipient": "22960000000",
  "message": "Votre message ici"
}
```

**Corps (image par URL) :**
```json
{
  "recipient": "22960000000",
  "message": "Légende optionnelle",
  "media": {
    "type": "image",
    "url": "https://exemple.com/image.jpg"
  }
}
```

**Corps (document) :**
```json
{
  "recipient": "22960000000",
  "media": {
    "type": "document",
    "url": "https://exemple.com/doc.pdf",
    "mimetype": "application/pdf",
    "filename": "document.pdf"
  }
}
```

**Corps (audio) :**
```json
{
  "recipient": "22960000000",
  "media": {
    "type": "audio",
    "url": "https://exemple.com/audio.ogg",
    "mimetype": "audio/ogg; codecs=opus"
  }
}
```

**Corps (base64) :**
```json
{
  "recipient": "22960000000",
  "media": {
    "type": "image",
    "base64": "/9j/4AAQSkZJRg...",
    "mimetype": "image/jpeg",
    "filename": "photo.jpg"
  }
}
```

**Réponse succès :**
```json
{
  "success": true,
  "messageId": "uuid-du-message",
  "status": "queued"
}
```

---

### GET /groups — Lister les groupes

Retourne tous les groupes WhatsApp de votre session.

**Réponse :**
```json
{
  "groups": [
    {
      "id": "group-uuid",
      "name": "Mon Groupe",
      "jid": "120363...@g.us",
      "participantsCount": 42,
      "status": "active",
      "createdAt": "2024-01-15T10:00:00.000Z"
    }
  ]
}
```

---

### POST /groups — Créer un groupe

**Corps :**
```json
{
  "name": "Nom du groupe",
  "participants": ["22960000001", "22960000002"]
}
```

---

### GET /groups/{groupId}/invite — Lien d'invitation

**Réponse :**
```json
{
  "inviteLink": "https://chat.whatsapp.com/XXXXX",
  "inviteCode": "XXXXX"
}
```

---

### GET /tenants/me — Informations du compte

Retourne les informations de votre compte CONVESSA.

**Réponse :**
```json
{
  "id": "tenant-uuid",
  "phone": "22960000000",
  "status": "connected",
  "usageType": "limited",
  "messagesLimit": 1000,
  "messagesSent": 234,
  "apiKeyHint": "pk_convessa_ab...xy"
}
```

---

### GET /tenants/me/qr — Obtenir le QR code

Retourne le QR code pour connecter WhatsApp.

**Réponse :**
```json
{
  "qr": "data:image/png;base64,iVBORw0KGgo...",
  "status": "pending_qr"
}
```

---

## Codes d'erreur

| Code HTTP | Code erreur | Signification |
|-----------|-------------|---------------|
| 400 | INVALID_RECIPIENT | Numéro de téléphone invalide |
| 401 | UNAUTHORIZED | Clé API manquante ou invalide |
| 403 | FORBIDDEN | Compte suspendu ou quota épuisé |
| 404 | NOT_FOUND | Ressource introuvable |
| 429 | RATE_LIMIT | Trop de requêtes — ralentissez |
| 503 | SESSION_NOT_CONNECTED | WhatsApp non connecté |
| 500 | INTERNAL_ERROR | Erreur serveur interne |

---

## Webhooks (optionnel)

Configurez une URL webhook pour recevoir des notifications en temps réel sur le statut des messages.

**Configuration :** Tableau de bord → Paramètres → Webhook URL

**Événements envoyés :**
```json
{
  "event": "message.sent",
  "messageId": "uuid",
  "recipient": "22960000000",
  "status": "sent",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

## Limites de débit (Rate Limiting)

- Maximum 60 requêtes par minute par clé API
- Les messages sont envoyés avec un délai de 1,5 à 3 secondes entre chaque envoi
- Ces délais protègent votre numéro WhatsApp contre le bannissement
