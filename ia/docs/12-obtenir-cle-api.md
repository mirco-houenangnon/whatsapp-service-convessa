# Obtenir votre Clé API

## Qu'est-ce que la clé API ?

La clé API CONVESSA est un identifiant unique et secret qui vous permet d'authentifier vos requêtes à l'API. Elle ressemble à ceci :

```
pk_convessa_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

## Prérequis

Avant d'obtenir votre clé API, vous devez :
1. Avoir un compte CONVESSA (inscription gratuite)
2. Avoir connecté votre numéro WhatsApp (scan du QR code)

## Étapes pour obtenir la clé API

### 1. Connectez-vous

Allez sur CONVESSA et connectez-vous avec Google, GitHub ou email.

### 2. Connectez WhatsApp

Si ce n'est pas déjà fait, allez dans [Accéder à mes sessions](/sessions) et connectez votre WhatsApp en scannant le QR code.

### 3. Générez la clé

1. Depuis la page [Accéder à mes sessions](/sessions)
2. Cliquez sur **"Générer ma clé API"**
3. Une fenêtre affiche votre clé — **copiez-la immédiatement**
4. La clé n'est affichée qu'une seule fois pour des raisons de sécurité

### 4. Conservez la clé en sécurité

- Stockez la dans une variable d'environnement (`API_KEY=pk_convessa_...`)
- Ne la commitez jamais dans Git
- Ne la partagez pas publiquement

## Utiliser la clé API

Dans vos requêtes HTTP, ajoutez le header :

```
X-API-Key: pk_convessa_votre_cle_ici
```

Exemple complet :

```bash
curl -X POST https://convessa.epac-uac-optica-chapter.bj/api/v1/send \
  -H "X-API-Key: pk_convessa_votre_cle" \
  -H "Content-Type: application/json" \
  -d '{"recipient": "22960000000", "message": "Test API"}'
```

## Renouveler la clé API

Si votre clé a été compromise ou si vous souhaitez la changer :

1. Allez dans [Accéder à mes sessions](/sessions)
2. Cliquez sur **"Renouveler ma clé API"**
3. Confirmez l'action
4. Copiez la nouvelle clé

**Important :** L'ancienne clé est immédiatement invalidée. Mettez à jour la clé dans toutes vos applications.

## La clé est valide combien de temps ?

La clé API n'a pas de date d'expiration automatique. Elle reste valide tant que :
- Votre compte est actif
- Vous n'avez pas généré une nouvelle clé
- Votre compte n'a pas été suspendu

## Problèmes fréquents

### "Clé API invalide" (401)

- Vérifiez que vous utilisez le bon header : `X-API-Key` (majuscule X)
- Vérifiez que la clé commence par `pk_convessa_`
- Vérifiez qu'il n'y a pas d'espace avant ou après la clé
- Regénérez la clé si elle a été compromise

### Je n'ai pas pu copier la clé lors de la génération

Regénérez une nouvelle clé depuis [Accéder à mes sessions](/sessions). L'ancienne est annulée.

### Le bouton "Générer ma clé API" est grisé

Vérifiez que votre WhatsApp est bien connecté (statut "Connecté" affiché). La génération de clé nécessite une session WhatsApp active.
