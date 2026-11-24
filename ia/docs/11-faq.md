# Foire Aux Questions (FAQ)

## Questions générales

### CONVESSA est-il gratuit ?

CONVESSA propose des forfaits payants. Consultez [Voir les forfaits](/pricing) pour les tarifs actuels. Il peut exister une offre d'essai ou un quota gratuit initial — vérifiez la page des forfaits pour les informations à jour.

### CONVESSA est-il légal ?

Oui, à condition de respecter les conditions d'utilisation de WhatsApp. Vous devez uniquement envoyer des messages à des personnes qui ont consenti à les recevoir. L'envoi de spam est interdit et peut entraîner le bannissement de votre numéro.

### Mes données sont-elles sécurisées ?

Oui. CONVESSA ne stocke pas le contenu de vos messages après envoi. Les sessions WhatsApp sont chiffrées. Votre clé API est hashée en base de données.

### CONVESSA utilise-t-il l'API officielle WhatsApp Business ?

Non. CONVESSA utilise WhatsApp Web (via la bibliothèque Baileys), ce qui ne nécessite pas d'approbation Meta. Cela signifie que n'importe quel numéro WhatsApp peut être connecté, mais implique un risque de bannissement si les règles ne sont pas respectées.

---

## Questions techniques

### Combien de messages puis-je envoyer simultanément ?

Il n'y a pas de limite simultanée côté CONVESSA — tous les messages sont mis en file d'attente. Cependant, ils sont envoyés avec un délai de 1,5 à 3 secondes entre chaque envoi pour protéger votre numéro.

### Peut-on envoyer des messages à des numéros internationaux ?

Oui, à tout numéro WhatsApp dans le monde. Utilisez le format international : indicatif pays + numéro (sans + ni espaces).

### Peut-on envoyer des messages en HTML ?

Non. WhatsApp ne supporte pas le HTML. Vous pouvez utiliser le formatage WhatsApp natif :
- **Gras** : `*texte*`
- _Italique_ : `_texte_`
- Barré : `~texte~`
- `Monospace` : ` ```texte``` `

### Comment savoir si un message a été livré ?

Via le webhook ou en consultant le tableau de bord → historique des messages.

### Peut-on envoyer des vidéos ?

Oui, via l'API avec `"type": "video"` et l'URL ou le base64 de la vidéo. Taille maximum : 16 MB.

### Peut-on recevoir des messages (réponses) avec CONVESSA ?

Cette fonctionnalité n'est pas disponible actuellement. CONVESSA est optimisé pour l'envoi sortant.

---

## Questions sur le compte

### Comment supprimer mon compte ?

Contactez le support via [Contacter le support](/contact) pour demander la suppression de votre compte.

### Puis-je avoir plusieurs numéros WhatsApp ?

Actuellement, un compte CONVESSA est lié à une session WhatsApp (un numéro). Contactez le support pour des besoins multi-numéros.

### Que se passe-t-il à l'expiration de mon forfait ?

Vos messages en attente ne sont plus envoyés. Votre session WhatsApp reste connectée. Renouvelez votre forfait pour reprendre les envois.

### Comment modifier mon email ou mot de passe ?

La connexion CONVESSA utilise Firebase Authentication. Pour modifier vos informations, utilisez les paramètres de votre compte Google ou GitHub selon votre méthode de connexion.

---

## Questions sur les paiements

### Le paiement est-il sécurisé ?

Oui. Les paiements passent par FedaPay ou KKiaPay qui sont des plateformes de paiement certifiées et sécurisées en Afrique de l'Ouest.

### Je n'ai pas reçu l'activation après paiement ?

Attendez 2 à 5 minutes. Si le problème persiste, contactez le support en précisant votre email, le montant et l'heure du paiement.

### Puis-je obtenir une facture ?

Contactez le support via [Contacter le support](/contact) en précisant votre demande de facture.

### Le remboursement est-il possible ?

Les remboursements sont examinés au cas par cas. Contactez le support dans les 48h suivant le paiement.

---

## Communauté et support

### Il y a-t-il une communauté CONVESSA ?

Oui ! Après avoir généré votre clé API, vous pouvez rejoindre la communauté WhatsApp CONVESSA pour des conseils, annonces et entraide entre utilisateurs.

### Comment contacter le support ?

Via le formulaire sur [Contacter le support](/contact). Renseignez votre numéro de téléphone pour être contacté par WhatsApp.
