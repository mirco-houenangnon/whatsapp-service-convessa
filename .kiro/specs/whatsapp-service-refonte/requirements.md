# Requirements Document

## Introduction

Ce document définit les exigences fonctionnelles et non fonctionnelles pour la refonte du projet `whatsapp-service`.

`whatsapp-service` est le moteur WhatsApp de la plateforme. C'est un module spécialisé, indépendant de tout projet métier, consommé par d'autres systèmes via une API REST.

Son périmètre est strictement limité à la couche WhatsApp :
- connexion WhatsApp via Baileys
- gestion des sessions
- génération et gestion des QR codes
- envoi de messages avec file d'attente
- réception des événements WhatsApp
- exposition d'une API stable et générique
- supervision et alertes

Il ne gère pas : les comptes utilisateurs, l'inscription, l'authentification utilisateur, les profils, les permissions métier.

## Glossary

| Terme | Définition |
|---|---|
| **Baileys** | Bibliothèque Node.js open-source permettant de se connecter à WhatsApp Web via WebSocket |
| **Session** | Ensemble des credentials Baileys permettant de restaurer une connexion WhatsApp sans nouveau scan QR |
| **JID** | WhatsApp ID — identifiant unique d'un numéro sur WhatsApp (format : `33612345678@s.whatsapp.net`) |
| **QR code** | Code généré par Baileys que l'utilisateur doit scanner avec son téléphone pour initier une session |
| **File d'attente** | Mécanisme FIFO garantissant l'envoi séquentiel des messages (un seul à la fois) |
| **Numéro administrateur** | Numéro WhatsApp connecté au service, utilisé pour envoyer tous les messages sortants |
| **messageId** | Identifiant UUID unique attribué à chaque message entrant dans la file d'attente |
| **Backoff exponentiel** | Stratégie de reconnexion où le délai entre chaque tentative double progressivement |
| **Service consommateur** | Tout système externe (Laravel, NestJS, Django…) qui appelle l'API REST du service |

## Vue d'ensemble

`whatsapp-service` est le moteur WhatsApp de la plateforme. C'est un module spécialisé, indépendant de tout projet métier, consommé par d'autres systèmes via une API REST.

Son périmètre est strictement limité à la couche WhatsApp :
- connexion WhatsApp via Baileys
- gestion des sessions
- génération et gestion des QR codes
- envoi de messages avec file d'attente
- réception des événements WhatsApp
- exposition d'une API stable et générique
- supervision et alertes

Il ne gère pas : les comptes utilisateurs, l'inscription, l'authentification utilisateur, les profils, les permissions métier.

---

## Requirements

### 1. Intégration Baileys

#### 1.1 Intégration Baileys

#### 1.1
**En tant que** développeur déployant le service,
**je veux** que Baileys soit une dépendance npm standard,
**afin de** pouvoir installer le projet avec un simple `npm install`, sans dépendance à un dossier local externe.

**Critères d'acceptation :**
- [ ] `package.json` ne contient plus de référence `file:../Baileys`
- [ ] `npm install` fonctionne depuis n'importe quelle machine sans prérequis extérieur
- [ ] La version de Baileys est épinglée explicitement (pas de `^` ou `~`)
- [ ] Les scripts `setup` et `build:baileys` sont supprimés

---

### 2. Gestion des sessions WhatsApp

#### 2.1 — Stockage en base de données
**En tant que** service WhatsApp,
**je veux** stocker les données de session en base de données,
**afin de** ne plus exposer les credentials WhatsApp dans le système de fichiers.

> **Décision actée :** base de données MySQL/MariaDB (XAMPP en local). Driver `mysql2`.
> Une seule base couvre sessions ET file d'attente. Tables : `wa_sessions`, `wa_message_queue`, `wa_logs`.

**Critères d'acceptation :**
- [ ] Les données de session Baileys (creds, clés de sync, état) sont stockées en base de données
- [ ] Le dossier `auth/` n'est plus utilisé ni créé
- [ ] Les données sensibles stockées en base sont chiffrées au repos (AES-256-GCM)
- [ ] La base de données est configurable via `DATABASE_URL` dans `.env`

#### 2.2 — Restauration de session après redémarrage
**En tant que** service WhatsApp,
**je veux** restaurer automatiquement la session WhatsApp au démarrage,
**afin que** le service soit opérationnel sans intervention manuelle après un redémarrage.

**Critères d'acceptation :**
- [ ] Au démarrage, le service tente de restaurer une session existante depuis la base
- [ ] Si la session est valide, le service se reconnecte sans afficher de QR code
- [ ] Si la session est invalide ou absente, le service génère un nouveau QR code

#### 2.3 — Cycle de vie de la session
**En tant que** service WhatsApp,
**je veux** que la déconnexion soit un événement contrôlé,
**afin d'** éviter toute déconnexion accidentelle.

**Critères d'acceptation :**
- [ ] La déconnexion ne se produit que dans trois cas :
  1. WhatsApp invalide la session côté serveur
  2. L'utilisateur se déconnecte depuis l'application WhatsApp
  3. Une demande explicite de déconnexion est faite via l'API
- [ ] Les déconnexions réseau temporaires déclenchent une reconnexion automatique avec backoff exponentiel
- [ ] La session n'est supprimée de la base que lors d'une déconnexion définitive (cas 1 ou 3)

---

### 3. API REST — Contrat d'interface

#### 3.1 — Authentification entre systèmes
**En tant que** service consommateur (Laravel, NestJS, Django, etc.),
**je veux** m'authentifier auprès du service WhatsApp via une clé API,
**afin de** garantir que seuls les systèmes autorisés peuvent l'utiliser.

**Critères d'acceptation :**
- [ ] Toutes les routes sont protégées par le header `X-Api-Key`
- [ ] La clé est comparée en temps constant (anti timing-attack)
- [ ] Une clé absente ou incorrecte retourne `401`
- [ ] En production, le démarrage échoue si aucune clé n'est définie

#### 3.2 — Envoi de message
**En tant que** service consommateur,
**je veux** envoyer un message WhatsApp via un endpoint REST,
**afin d'** intégrer l'envoi WhatsApp dans n'importe quel workflow métier.

**Endpoint :** `POST /api/v1/messages/send`

**Corps de la requête :**
```json
{
  "to": "33612345678",
  "message": "Votre code de validation est : 483920"
}
```

**Réponse succès (202) :**
```json
{
  "success": true,
  "queued": true,
  "messageId": "uuid-v4",
  "position": 1
}
```

**Réponse erreur :**
```json
{
  "success": false,
  "error": {
    "code": "PHONE_NOT_ON_WHATSAPP",
    "message": "Le numéro fourni n'est pas enregistré sur WhatsApp"
  }
}
```

**Critères d'acceptation :**
- [ ] Le numéro `to` est validé (format international, chiffres uniquement après nettoyage)
- [ ] Le champ `message` est limité à 4096 caractères
- [ ] Le message est ajouté à la file d'attente et un `messageId` UUID est retourné
- [ ] Le code retour est `202 Accepted` (le message est en file, pas encore envoyé)
- [ ] Si le service n'est pas connecté, retourne `503`
- [ ] Si le numéro n'existe pas sur WhatsApp, retourne `404` avec code `PHONE_NOT_ON_WHATSAPP`
- [ ] Aucune logique de fallback géographique hardcodée (numéros béninois, etc.) dans ce service

#### 3.3 — Statut de la connexion
**En tant que** service consommateur,
**je veux** connaître l'état de la connexion WhatsApp,
**afin de** réagir en conséquence dans mon workflow.

**Endpoint :** `GET /api/v1/status`

**Réponse (connecté) :**
```json
{
  "status": "connected",
  "phone": "+22997123456",
  "name": "Admin WhatsApp",
  "connectedAt": "2026-07-22T10:30:00Z"
}
```

**Réponse (déconnecté) :**
```json
{
  "status": "disconnected",
  "reason": "session_revoked"
}
```

**Critères d'acceptation :**
- [ ] Retourne l'état courant en temps réel
- [ ] Le champ `reason` est présent uniquement si le statut est `disconnected`
- [ ] Les valeurs possibles de `reason` : `session_revoked`, `logged_out`, `not_initialized`

#### 3.4 — Déconnexion
**En tant que** service consommateur,
**je veux** déclencher une déconnexion propre via l'API,
**afin de** réinitialiser la session WhatsApp depuis ma plateforme.

**Endpoint :** `DELETE /api/v1/session`

**Réponse succès (200) :**
```json
{
  "success": true,
  "message": "Session supprimée. Un nouveau QR code sera généré."
}
```

**Critères d'acceptation :**
- [ ] La session est supprimée de la base de données
- [ ] Le socket Baileys est fermé proprement
- [ ] Le service génère immédiatement un nouveau QR code
- [ ] L'événement `logged_out` est émis via Socket.io

#### 3.5 — Statut d'un message en file
**En tant que** service consommateur,
**je veux** consulter le statut d'un message par son ID,
**afin de** savoir s'il a été envoyé, est en attente ou a échoué.

**Endpoint :** `GET /api/v1/messages/:messageId`

**Réponse :**
```json
{
  "messageId": "uuid-v4",
  "status": "sent",
  "to": "+33612345678",
  "sentAt": "2026-07-22T10:31:05Z",
  "attempts": 1
}
```

**Statuts possibles :** `queued`, `sending`, `sent`, `failed`

**Critères d'acceptation :**
- [ ] Retourne `404` si le `messageId` est inconnu
- [ ] Le statut est mis à jour en temps réel
- [ ] En cas d'échec, le champ `error` contient la raison

---

### 4. File d'attente d'envoi

#### 4.1 — Sérialisation des envois
**En tant que** service WhatsApp,
**je veux** traiter les messages un par un,
**afin de** réduire le risque de blocage WhatsApp lié aux envois simultanés.

**Critères d'acceptation :**
- [ ] Un seul message est envoyé à la fois (aucune concurrence)
- [ ] Les messages sont traités dans l'ordre FIFO
- [ ] La file est persistée en base de données (survit aux redémarrages)

#### 4.2 — Délai configurable entre envois
**En tant qu'** administrateur,
**je veux** configurer un délai entre chaque message,
**afin de** simuler un comportement humain et éviter la détection spam.

**Critères d'acceptation :**
- [ ] La variable `MESSAGE_DELAY_MS` définit le délai entre deux envois (défaut : 1500 ms)
- [ ] La variable `MESSAGE_DELAY_MAX_MS` permet un délai aléatoire (entre min et max)
- [ ] Les deux variables sont configurables dans `.env`

#### 4.3 — Gestion des échecs
**En tant que** service WhatsApp,
**je veux** retenter l'envoi d'un message en cas d'échec temporaire,
**afin de** maximiser la livraison sans intervention manuelle.

**Critères d'acceptation :**
- [ ] Un message en échec est retenté jusqu'à 3 fois
- [ ] Le délai entre chaque tentative suit un backoff exponentiel
- [ ] Après 3 échecs, le statut passe à `failed` et le message n'est plus retenté
- [ ] Les échecs sont journalisés avec la raison

---

### 5. Supervision et alertes

#### 5.1 — Détection de déconnexion
**En tant qu'** administrateur,
**je veux** être alerté immédiatement si le numéro administrateur se déconnecte,
**afin de** rétablir le service sans délai.

**Critères d'acceptation :**
- [ ] Toute déconnexion du socket WhatsApp déclenche une détection
- [ ] Une distinction est faite entre déconnexion temporaire (réseau) et définitive (session révoquée)
- [ ] Seule une déconnexion définitive déclenche l'alerte e-mail

#### 5.2 — Alerte e-mail
**En tant qu'** administrateur,
**je veux** recevoir un e-mail d'alerte en cas de déconnexion définitive,
**afin d'** intervenir rapidement.

**Critères d'acceptation :**
- [ ] L'e-mail contient : la date/heure, le numéro déconnecté, la raison détectée
- [ ] L'adresse destinataire est configurable via `ALERT_EMAIL`
- [ ] La configuration SMTP est définie dans `.env` (host, port, user, password)
- [ ] Si l'envoi d'e-mail échoue, l'erreur est journalisée mais ne bloque pas le service
- [ ] L'alerte n'est envoyée qu'une seule fois par événement de déconnexion (pas de boucle)

---

### 6. Sécurité

#### 6.1 — Protection des données de session
**En tant que** service WhatsApp,
**je veux** que les données de session soient chiffrées,
**afin que** les credentials WhatsApp ne soient pas lisibles en cas d'accès non autorisé à la base.

**Critères d'acceptation :**
- [ ] Les données de session sont chiffrées avec AES-256-GCM avant stockage
- [ ] La clé de chiffrement est définie dans `.env` (`SESSION_ENCRYPTION_KEY`)
- [ ] La clé n'est jamais stockée en base de données

#### 6.2 — Headers de sécurité HTTP
**En tant que** service exposant une API,
**je veux** que les headers de sécurité HTTP soient correctement configurés,
**afin de** réduire la surface d'attaque.

**Critères d'acceptation :**
- [ ] `X-Powered-By` est supprimé
- [ ] Les headers de sécurité standards sont appliqués (via Helmet ou équivalent)
- [ ] Le header `Content-Security-Policy` est configuré pour le dashboard

#### 6.3 — Rate limiting robuste
**En tant que** service exposant une API,
**je veux** un rate limiting qui résiste à la manipulation,
**afin de** prévenir les abus.

**Critères d'acceptation :**
- [ ] Le rate limit s'applique sur toutes les routes (pas uniquement `/send`)
- [ ] Le header `X-Forwarded-For` est validé avant extraction de l'IP
- [ ] Le rate limit est configurable via `.env`

#### 6.4 — Authentification Socket.io
**En tant que** service exposant un canal Socket.io,
**je veux** que les connexions Socket.io soient authentifiées,
**afin que** les événements temps réel ne soient pas accessibles à n'importe quel client.

**Critères d'acceptation :**
- [ ] La connexion Socket.io requiert un token valide au handshake
- [ ] Une connexion sans token ou avec un token invalide est rejetée
- [ ] Le dashboard utilise la même clé API que les endpoints REST

#### 6.5 — Journalisation structurée
**En tant qu'** administrateur,
**je veux** des logs structurés et exploitables,
**afin de** diagnostiquer les incidents et auditer l'activité.

**Critères d'acceptation :**
- [ ] Les logs sont au format JSON (pino)
- [ ] Le niveau de log est configurable via `LOG_LEVEL` (défaut : `info`)
- [ ] Les logs incluent : timestamp, niveau, composant, message, contexte
- [ ] Les numéros de téléphone sont tronqués dans les logs (jamais complets)
- [ ] Les erreurs incluent un identifiant de corrélation

---

### 7. Généricité et déployabilité

#### 7.1 — Indépendance métier
**En tant que** développeur intégrant ce service dans un nouveau projet,
**je veux** un service sans aucune logique métier hardcodée,
**afin de** pouvoir l'utiliser avec n'importe quel backend et n'importe quel numéro dans le monde.

**Critères d'acceptation :**
- [ ] Aucune référence à un pays ou indicatif téléphonique spécifique dans le code
- [ ] Aucune référence au projet CAP-EPAC ou à tout autre projet métier
- [ ] Le numéro administrateur est entièrement configurable via `.env`
- [ ] La description dans `package.json` est générique

#### 7.2 — Configuration complète par variables d'environnement
**En tant que** développeur déployant le service,
**je veux** pouvoir configurer l'intégralité du service via `.env`,
**afin de** déployer sans modifier le code.

**Variables requises (avec valeurs par défaut) :**

| Variable | Obligatoire | Défaut | Description |
|---|---|---|---|
| `PORT` | non | `3005` | Port d'écoute |
| `NODE_ENV` | non | `development` | Environnement |
| `BRIDGE_API_KEY` | oui (prod) | — | Clé d'authentification API |
| `CORS_ORIGIN` | non | `*` | Origines CORS autorisées |
| `ENABLE_DASHBOARD` | non | `false` | Activer le dashboard HTML |
| `DATABASE_URL` | oui | — | URL de connexion à la base de données |
| `SESSION_ENCRYPTION_KEY` | oui | — | Clé AES-256 pour chiffrement des sessions |
| `MESSAGE_DELAY_MS` | non | `1500` | Délai minimum entre deux envois (ms) |
| `MESSAGE_DELAY_MAX_MS` | non | `3000` | Délai maximum entre deux envois (ms) |
| `ALERT_EMAIL` | non | — | Email destinataire des alertes |
| `SMTP_HOST` | si ALERT_EMAIL | — | Serveur SMTP |
| `SMTP_PORT` | si ALERT_EMAIL | `587` | Port SMTP |
| `SMTP_USER` | si ALERT_EMAIL | — | Utilisateur SMTP |
| `SMTP_PASS` | si ALERT_EMAIL | — | Mot de passe SMTP |
| `LOG_LEVEL` | non | `info` | Niveau de log |

---

### 8. Dashboard de supervision

#### 8.1
**En tant qu'** administrateur,
**je veux** un dashboard web pour superviser le service,
**afin de** scanner le QR code, voir l'état de la connexion et monitorer l'activité.

**Critères d'acceptation :**
- [ ] Le dashboard est désactivé par défaut en production (`ENABLE_DASHBOARD=false`)
- [ ] L'accès au dashboard est protégé par la clé API (via Socket.io authentifié)
- [ ] Le dashboard affiche : statut connexion, numéro connecté, file d'attente, logs récents
- [ ] Le dashboard affiche le QR code en temps réel lors de la phase de connexion
- [ ] Le dashboard permet de déclencher une déconnexion (avec confirmation)

---

## Codes d'erreur — Référence complète

| Code | HTTP | Description |
|---|---|---|
| `UNAUTHORIZED` | 401 | Clé API manquante ou invalide |
| `VALIDATION_ERROR` | 400 | Corps de requête invalide |
| `PHONE_NOT_ON_WHATSAPP` | 404 | Numéro non enregistré sur WhatsApp |
| `MESSAGE_NOT_FOUND` | 404 | messageId inconnu |
| `SERVICE_NOT_CONNECTED` | 503 | Service WhatsApp non connecté |
| `RATE_LIMIT_EXCEEDED` | 429 | Trop de requêtes |
| `INTERNAL_ERROR` | 500 | Erreur interne non spécifiée |

---

## Contraintes non fonctionnelles

- **Latence** : le délai entre la réception d'une requête d'envoi et la mise en file doit être < 100 ms
- **Disponibilité** : reconnexion automatique en cas de coupure réseau
- **Portabilité** : fonctionne sur Node.js ≥ 20, Linux et Windows
- **Compatibilité** : API consommable par n'importe quel langage (Laravel, Django, Spring, .NET, NestJS…)
- **Responsabilité** : aucune donnée métier utilisateur n'est stockée — uniquement les credentials de session WhatsApp
