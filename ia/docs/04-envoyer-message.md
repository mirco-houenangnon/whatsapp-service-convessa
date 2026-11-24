# Envoyer des Messages via l'API

## URL de base de l'API

```
https://convessa.epac-uac-optica-chapter.bj/api/v1
```

## Authentification

Toutes les requêtes API nécessitent votre clé API dans le header :

```
X-API-Key: pk_convessa_votre_cle_api_ici
```

## Envoyer un message texte

**Endpoint :** `POST /api/v1/send`

### Corps de la requête

```json
{
  "recipient": "22960000000",
  "message": "Bonjour, votre commande est confirmée !"
}
```

### Paramètres

| Paramètre | Type | Obligatoire | Description |
|-----------|------|-------------|-------------|
| `recipient` | string | Oui | Numéro WhatsApp au format international (sans + ni espaces) |
| `message` | string | Oui (si pas de média) | Texte du message |

### Exemple avec curl

```bash
curl -X POST https://convessa.epac-uac-optica-chapter.bj/api/v1/send \
  -H "X-API-Key: pk_convessa_votre_cle" \
  -H "Content-Type: application/json" \
  -d '{"recipient": "22960000000", "message": "Bonjour depuis CONVESSA !"}'
```

### Exemple JavaScript (fetch)

```javascript
const response = await fetch('https://convessa.epac-uac-optica-chapter.bj/api/v1/send', {
  method: 'POST',
  headers: {
    'X-API-Key': 'pk_convessa_votre_cle',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    recipient: '22960000000',
    message: 'Bonjour depuis CONVESSA !'
  })
});
const data = await response.json();
```

### Exemple Python

```python
import requests

response = requests.post(
    'https://convessa.epac-uac-optica-chapter.bj/api/v1/send',
    headers={'X-API-Key': 'pk_convessa_votre_cle'},
    json={'recipient': '22960000000', 'message': 'Bonjour depuis CONVESSA !'}
)
print(response.json())
```

## Envoyer une image

```json
{
  "recipient": "22960000000",
  "message": "Voici votre reçu",
  "media": {
    "type": "image",
    "url": "https://exemple.com/recu.jpg"
  }
}
```

Ou en base64 :

```json
{
  "recipient": "22960000000",
  "media": {
    "type": "image",
    "base64": "data:image/jpeg;base64,/9j/4AAQSkZJRgAB...",
    "mimetype": "image/jpeg",
    "filename": "recu.jpg"
  }
}
```

## Envoyer un document PDF

```json
{
  "recipient": "22960000000",
  "message": "Votre facture en pièce jointe",
  "media": {
    "type": "document",
    "url": "https://exemple.com/facture.pdf",
    "mimetype": "application/pdf",
    "filename": "facture.pdf"
  }
}
```

## Envoyer un message audio

```json
{
  "recipient": "22960000000",
  "media": {
    "type": "audio",
    "url": "https://exemple.com/message.mp3",
    "mimetype": "audio/mpeg"
  }
}
```

## Réponse de l'API

### Succès (200)

```json
{
  "success": true,
  "messageId": "msg_abc123",
  "status": "queued"
}
```

### Erreur

```json
{
  "success": false,
  "error": "Session WhatsApp non connectée",
  "code": "SESSION_NOT_CONNECTED"
}
```

## Format des numéros de téléphone

Les numéros doivent être au format international **sans le signe +** :

- Bénin : `22960000000` (indicatif 229 + numéro à 8 chiffres)
- France : `33612345678`
- Côte d'Ivoire : `22507123456`

**Mauvais formats** : `+229 60 00 00 00`, `060000000`, `+22960000000`

**Bon format** : `22960000000`

## File d'attente des messages

Les messages sont mis en file d'attente et envoyés avec un délai aléatoire de 1,5 à 3 secondes entre chaque message. Ce délai protège votre numéro contre le bannissement WhatsApp.

## Limites selon le forfait

| Forfait | Messages/mois |
|---------|---------------|
| Gratuit | Limité |
| Starter | Selon plan |
| Pro | Selon plan |
| Illimité | Illimité |

Consultez [Voir les forfaits](/pricing) pour les détails exacts.
