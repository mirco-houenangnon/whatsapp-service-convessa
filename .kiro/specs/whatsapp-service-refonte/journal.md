# Journal de travail — whatsapp-service (Refonte)

Ce fichier trace chaque action réalisée sur le projet, dans l'ordre chronologique.
Il ne contient pas de code — uniquement ce qui a été fait, pourquoi, et ce qui en découle.

---

## Entrée 001 — Analyse initiale du projet
**Date :** 2026-07-22
**Statut :** ✅ Terminé

### Ce qui a été fait
Lecture complète de tous les fichiers du projet existant :
- `src/index.ts` — serveur Express + Socket.io + endpoints REST
- `src/whatsapp.ts` — WhatsAppManager (connexion Baileys, reconnexion, envoi)
- `public/index.html` — dashboard de supervision
- `package.json`, `tsconfig.json`, `.env`, `.env.example`, `README.md`

### Ce qui a été constaté
- Baileys référencé en `file:../Baileys` (dépendance locale externe)
- Sessions stockées dans `auth/primary-session/` (4075 fichiers JSON en clair sur le disque)
- Logique métier béninoise hardcodée dans `index.ts` (fallback indicatifs 229/22901)
- Socket.io sans authentification
- Rate limit manipulable via `X-Forwarded-For` forgé
- Pas de file d'attente — envois directs et potentiellement concurrents
- Pas d'alerte e-mail en cas de déconnexion
- Pas de logging structuré (pino configuré en `silent`)
- Dossier `auth/` nettoyé (session supprimée)

### Décisions prises
- Supprimer la dépendance `file:../Baileys` → migrer vers npm standard
- Supprimer le stockage fichier → migrer vers base de données
- Supprimer toute logique métier géographique hardcodée
- Ajouter file d'attente, alertes, authentification Socket.io, logging

---

## Entrée 002 — Création du document Requirements
**Date :** 2026-07-22
**Statut :** ✅ Terminé
**Fichier produit :** `.kiro/specs/whatsapp-service-refonte/requirements.md`

### Ce qui a été fait
Rédaction complète du document de requirements couvrant 8 domaines :
1. Intégration Baileys (migration npm)
2. Gestion des sessions (stockage BDD, restauration, cycle de vie)
3. API REST (5 endpoints, contrats JSON, codes d'erreur)
4. File d'attente (FIFO, délais configurables, retry)
5. Supervision et alertes (détection déconnexion, e-mail)
6. Sécurité (chiffrement, headers, rate limit, auth Socket.io, logs)
7. Généricité (zéro logique métier, 100% configurable)
8. Dashboard (désactivé par défaut, protégé)

Validation du format Kiro spec (aucune erreur de diagnostic).

### Décisions structurantes validées
- **Base de données :** MySQL/MariaDB via XAMPP (environnement local)
- **Périmètre BDD :** une seule base pour les sessions ET la file d'attente
- **Structure :** bien séparée par tables distinctes

---

## Entrée 003 — Décisions de base de données
**Date :** 2026-07-22
**Statut :** ✅ Acté

### Contexte
L'utilisateur travaille en local avec XAMPP (MySQL/MariaDB).
Une seule base de données sera utilisée pour l'ensemble du service.

### Tables prévues (à détailler dans le design)
| Table | Rôle |
|---|---|
| `wa_sessions` | Stockage des credentials Baileys chiffrés |
| `wa_message_queue` | File d'attente des messages (FIFO) |
| `wa_logs` | Journal d'activité structuré du service |

### Dépendance npm retenue
- `mysql2` — driver MySQL natif pour Node.js, supporte les Promises et les prepared statements
- Pas d'ORM pour rester léger — requêtes SQL directes avec `mysql2/promise`

---

## Entrée 004 — Design technique
**Date :** 2026-07-22
**Statut :** ✅ Terminé
**Fichier produit :** `.kiro/specs/whatsapp-service-refonte/design.md`

### Ce qui a été fait
Rédaction complète du document de design technique couvrant :
- Architecture globale (diagramme ASCII)
- Structure des fichiers source (13 modules organisés par couche)
- Interfaces TypeScript de chaque composant
- Schéma MySQL des 3 tables (`wa_sessions`, `wa_message_queue`, `wa_logs`)
- Contrat d'API REST complet (4 endpoints, tous les cas success/erreur)
- Événements Socket.io avec authentification
- Deux flux de données détaillés (envoi de message, déconnexion/alerte)
- Catalogue exhaustif des messages d'erreur et codes HTTP
- 6 propriétés de correction formelles liées aux requirements
- Stratégie de tests (unitaires + intégration)
- Liste définitive des dépendances npm
- Référence complète des variables d'environnement

### Décisions techniques clés
- MySQL/MariaDB via `mysql2/promise` — pas d'ORM, requêtes SQL directes
- AES-256-GCM pour le chiffrement des sessions, IV aléatoire par opération
- `uuid` v4 comme `messageId` retourné immédiatement au service consommateur (202 Accepted)
- Messages bloqués en `sending` remis en `queued` au redémarrage (idempotence)
- Numéros masqués partout (logs, réponses, événements Socket.io)
- `ts-node` remplacé par `tsx` (plus rapide, ESM natif)

### En attente
Validation du design par l'utilisateur avant de créer les tâches d'implémentation.

---

_Ce journal sera mis à jour après chaque action significative._
