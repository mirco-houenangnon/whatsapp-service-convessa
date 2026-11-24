# Groupes WhatsApp

## Qu'est-ce que la gestion de groupes ?

CONVESSA permet d'envoyer des messages à des groupes WhatsApp existants ou d'en créer de nouveaux via l'API. C'est idéal pour les notifications communautaires, les annonces d'équipe ou les campagnes ciblées.

## Lister vos groupes

**Endpoint :** `GET /api/v1/groups`

```bash
curl https://convessa.epac-uac-optica-chapter.bj/api/v1/groups \
  -H "X-API-Key: pk_convessa_votre_cle"
```

### Réponse

```json
{
  "groups": [
    {
      "id": "groupe_abc123",
      "name": "Clients VIP",
      "jid": "120363000000000000@g.us",
      "participantsCount": 150,
      "status": "active"
    }
  ]
}
```

## Envoyer un message à un groupe

### Via l'ID du groupe CONVESSA

```json
{
  "groupId": "groupe_abc123",
  "message": "Bonjour à tous ! Promo -20% ce weekend."
}
```

### Via le JID WhatsApp directement

```json
{
  "recipient": "120363000000000000@g.us",
  "message": "Message pour le groupe"
}
```

## Créer un groupe depuis l'API

**Endpoint :** `POST /api/v1/groups`

```json
{
  "name": "Promo Novembre",
  "participants": ["22960000001", "22960000002", "22960000003"]
}
```

## Obtenir le lien d'invitation d'un groupe

**Endpoint :** `GET /api/v1/groups/{groupId}/invite`

```bash
curl https://convessa.epac-uac-optica-chapter.bj/api/v1/groups/groupe_abc123/invite \
  -H "X-API-Key: pk_convessa_votre_cle"
```

### Réponse

```json
{
  "inviteLink": "https://chat.whatsapp.com/XXXXXXXXXXXXXXX",
  "inviteCode": "XXXXXXXXXXXXXXX"
}
```

## Bonnes pratiques pour les groupes

- Évitez d'envoyer plus de 1 message par heure dans un groupe très actif
- Prévenez les membres qu'ils rejoignent un groupe de communication automatisée
- Respectez les règles d'utilisation de WhatsApp pour éviter le bannissement

## Depuis le tableau de bord

Vous pouvez aussi gérer vos groupes depuis l'interface :

1. Allez dans [Mon tableau de bord](/dashboard)
2. Section "Groupes WhatsApp"
3. Ajoutez, supprimez ou gérez vos groupes directement
