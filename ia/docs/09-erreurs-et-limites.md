# Erreurs et Limites

## Erreurs d'authentification

### Erreur 401 — Clé API invalide

**Cause :** La clé API fournie n'existe pas ou a été révoquée.

**Solution :**
1. Vérifiez que vous utilisez le bon header : `X-API-Key` (pas `Authorization`)
2. Vérifiez que la clé commence par `pk_convessa_`
3. Regénérez votre clé API depuis [Accéder à mes sessions](/sessions) si nécessaire

### Erreur 403 — Compte suspendu ou quota épuisé

**Quota épuisé :**
- Vous avez atteint la limite de messages de votre forfait ce mois
- Solution : [Voir les forfaits](/pricing) pour passer à un forfait supérieur

**Compte suspendu :**
- Votre compte a été suspendu par l'administration
- Solution : Contactez le support via [Contacter le support](/contact)

## Erreurs de session WhatsApp

### Erreur 503 — Session non connectée

**Cause :** Votre numéro WhatsApp n'est pas connecté à CONVESSA.

**Solution :**
1. Allez dans [Accéder à mes sessions](/sessions)
2. Cliquez sur "Afficher le QR code"
3. Scannez le QR code depuis votre téléphone WhatsApp
4. Réessayez après connexion

### Session qui se déconnecte fréquemment

**Causes possibles :**
- Connexion internet instable sur votre téléphone
- WhatsApp a été fermé de force sur le téléphone
- WhatsApp a été mis en veille par le système Android/iOS (désactiver les restrictions de batterie)

**Solution :** Désactivez l'optimisation de la batterie pour WhatsApp dans les paramètres de votre téléphone.

## Erreurs d'envoi

### Numéro invalide (400)

**Cause :** Le numéro de téléphone n'est pas au bon format.

**Format correct :** Indicatif pays + numéro, sans + ni espaces
- ✅ `22960000000`
- ❌ `+22960000000`
- ❌ `060000000`
- ❌ `+229 60 00 00 00`

### Message non livré

WhatsApp peut ne pas livrer un message si :
- Le destinataire n'a pas WhatsApp installé
- Le numéro n'existe pas sur WhatsApp
- Vous avez été bloqué par le destinataire
- Le destinataire a désactivé son compte

### Numéro banni par WhatsApp

**Cause :** Envoi de trop de messages en masse trop rapidement, ou signalements de spam.

**Prévention :**
- Respectez les délais automatiques de CONVESSA (1,5 à 3 secondes entre messages)
- N'envoyez pas de messages non sollicités
- Évitez les messages identiques répétés (personnalisez le contenu)
- N'ajoutez pas des inconnus à des groupes sans leur accord

**Que faire si banni :**
- Contactez WhatsApp Business directement pour faire appel
- Utilisez un autre numéro en attendant

## Limites techniques

| Limite | Valeur |
|--------|--------|
| Taille message texte | 4096 caractères |
| Taille image | 16 MB max |
| Taille document | 100 MB max |
| Taille audio | 16 MB max |
| Taille vidéo | 16 MB max |
| Requêtes par minute | 60 |
| Messages en file simultanément | Illimité |

## Problèmes fréquents dans l'interface

### Page blanche après connexion

Videz le cache du navigateur et rechargez : `Ctrl+Shift+R` (Windows/Linux) ou `Cmd+Shift+R` (Mac).

### Erreur "Network Error" dans la console

Vérifiez votre connexion internet et que le domaine `convessa.epac-uac-optica-chapter.bj` est accessible.

### Le tableau de bord ne se charge pas

Déconnectez-vous et reconnectez-vous. Si le problème persiste, contactez le support.

## Contacter le support

Pour tout problème non résolu par cette documentation :
- Formulaire de contact : [Contacter le support](/contact)
- Renseignez votre numéro de téléphone pour être rappelé sur WhatsApp
