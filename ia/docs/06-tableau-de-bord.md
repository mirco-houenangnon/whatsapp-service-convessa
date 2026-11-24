# Tableau de Bord

## Accéder au tableau de bord

Après connexion, vous êtes redirigé vers [Mon tableau de bord](/dashboard).

## Sections du tableau de bord

### Vue d'ensemble

La page d'accueil du tableau de bord affiche :

- **Statut de la session WhatsApp** : connecté / déconnecté
- **Messages envoyés ce mois** : compteur en temps réel
- **Quota restant** : messages restants selon votre forfait
- **Derniers messages envoyés** : liste des 10 derniers envois

### Sessions WhatsApp

Accessible via [Accéder à mes sessions](/sessions).

Depuis cette page, vous pouvez :
- Voir le statut de votre connexion WhatsApp
- Générer un QR code pour connecter ou reconnecter WhatsApp
- Générer ou renouveler votre clé API
- Voir les informations de votre compte WhatsApp connecté (numéro, nom)

### Envoyer un message

Accessible via [Envoyer un message](/send-message).

Interface de test pour envoyer des messages sans écrire de code :
1. Entrez le numéro destinataire
2. Rédigez votre message
3. Ajoutez optionnellement un média (image, document)
4. Cliquez sur Envoyer

### Statistiques

Le tableau de bord affiche des statistiques sur :
- Nombre de messages envoyés par jour/semaine/mois
- Taux de succès des envois
- Messages en attente dans la file d'attente
- Historique des 30 derniers jours

## Clé API

### Qu'est-ce que la clé API ?

La clé API est un identifiant secret qui authentifie vos requêtes vers l'API CONVESSA. Elle est liée à votre compte et votre session WhatsApp.

Format : `pk_convessa_xxxxxxxxxxxxxxxxxxxx`

### Générer une clé API

1. Allez dans [Accéder à mes sessions](/sessions)
2. Votre WhatsApp doit être connecté
3. Cliquez sur "Générer ma clé API"
4. **Copiez la clé immédiatement** — elle n'est affichée qu'une seule fois

### Renouveler une clé API

Si votre clé API est compromise, vous pouvez en générer une nouvelle. L'ancienne clé sera automatiquement invalidée.

**Attention** : Après renouvellement, mettez à jour la clé dans toutes vos applications qui l'utilisent.

## Paramètres du compte

Depuis le tableau de bord, vous pouvez :
- Voir vos informations de profil (email, nom)
- Consulter votre plan actuel et la date d'expiration
- Mettre à niveau votre forfait via [Voir les forfaits](/pricing)
