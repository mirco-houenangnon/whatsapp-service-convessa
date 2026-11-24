# Connecter votre WhatsApp

## Qu'est-ce qu'une session WhatsApp ?

Une session WhatsApp est la connexion entre votre numéro de téléphone WhatsApp et CONVESSA. Une fois connecté, CONVESSA peut envoyer des messages depuis votre numéro.

**Important** : CONVESSA utilise WhatsApp Web (via Baileys). Cela signifie que votre téléphone doit rester connecté à internet pour que les messages puissent être envoyés.

## Étapes pour connecter WhatsApp

### 1. Accéder à la page Sessions

Allez dans [Accéder à mes sessions](/sessions) depuis votre tableau de bord.

### 2. Générer le QR code

Cliquez sur le bouton "Afficher le QR code". Un QR code apparaît à l'écran.

### 3. Scanner depuis votre téléphone

1. Ouvrez WhatsApp sur votre téléphone
2. Allez dans **Paramètres** → **Appareils liés** → **Lier un appareil**
3. Pointez la caméra sur le QR code affiché
4. Attendez la confirmation de connexion

### 4. Connexion confirmée

Une fois le QR code scanné, la page se met à jour automatiquement et affiche le statut "Connecté". Votre numéro WhatsApp est maintenant lié à CONVESSA.

## Statuts de session

| Statut | Signification |
|--------|---------------|
| `pending_qr` | En attente du scan du QR code |
| `connected` | WhatsApp connecté et actif |
| `disconnected` | Déconnecté — reconnecter nécessaire |
| `banned` | Numéro banni par WhatsApp |

## Obtenir sa clé API

Après connexion de WhatsApp, une clé API est générée automatiquement.

1. Allez dans [Accéder à mes sessions](/sessions)
2. Cliquez sur "Générer ma clé API"
3. **Copiez et conservez la clé** — elle ne sera affichée qu'une seule fois
4. Cette clé est nécessaire pour toutes vos requêtes API

Format d'une clé API CONVESSA : `pk_convessa_xxxxxxxxxxxxxxxxxxxx`

## Déconnexion et reconnexion

### Se déconnecter

Depuis la page Sessions, cliquez sur "Déconnecter". Cela supprime la session WhatsApp Web sans affecter votre compte WhatsApp principal.

### Se reconnecter

Si la session expire (après inactivité prolongée ou redémarrage du serveur), il faut rescanner un nouveau QR code en suivant les étapes ci-dessus.

## Problèmes fréquents

### Le QR code tourne en boucle / spinner infini

Attendez quelques secondes — le serveur génère un nouveau QR code toutes les 20 secondes. Si le problème persiste plus d'une minute, rafraîchissez la page et réessayez.

### "Session expirée"

WhatsApp déconnecte automatiquement les sessions après une longue inactivité ou si le téléphone n'a pas eu internet. Rescannez un nouveau QR code.

### Le QR code ne se scanne pas

Vérifiez que la caméra de votre téléphone fonctionne correctement et que vous êtes bien dans **Paramètres → Appareils liés** de WhatsApp (pas dans l'appareil photo normal).

### Erreur "Numéro banni"

WhatsApp peut bannir un numéro qui envoie trop de messages en masse trop rapidement. Utilisez les délais recommandés (voir la section Envoi de messages).
