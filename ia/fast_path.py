"""
fast_path.py — Réponses instantanées pour les questions récurrentes simples.
Couvre la documentation officielle Convessa sans faux-positifs.
Règle stricte : AUCUN EMOJI.

─── Cohérence avec le Fast-Path frontend (ChatWidget.jsx / detectIntent) ────
Il existe DEUX catalogues de réponses instantanées indépendants :
  - Frontend : `INTENT_RULES` (8 intents génériques, réponses dans les
    fichiers i18n `chatbot.quickAnswers.*`), déclenché AVANT tout appel réseau.
  - Backend (ici) : FAST_PATH_PATTERNS (27 entrées détaillées), déclenché
    seulement si le frontend n'a rien trouvé.
Tant qu'une vraie fusion des deux systèmes n'est pas faite, toute mise à jour
d'un sujet ci-dessous doit être répercutée manuellement côté frontend si un
intent équivalent existe. Table de correspondance connue (à tenir à jour) :

    id (backend)                          intentKey (frontend, i18n)
    ------------------------------------  ---------------------------
    connect_wa, qr_issue, disconnections,
    session_status                        connectWhatsapp
    api_key, revoke_key, secure_key        apiKey
    send_text, send_media, broadcast,
    message_status, headers                docs
    webhook, socketio                      webhooks
    create_group, group_members,
    group_invite, group_message            groups
    error_401, error_403, error_429,
    error_503                              docs
    pricing, quota, file_limits            pricing / mediaLimits
    contact_support                        support

Voir aussi docs/FAQ_SYNC.md pour le détail de cette dette d'architecture et
le plan de réconciliation.
"""

import re
import random
import unicodedata
import difflib

# Mots-clés d'intégration technique : Si la question contient un de ces termes,
# elle doit OBLIGATOIREMENT passer par le RAG + LLM pour générer du code sur mesure.
TECH_INTEGRATION_TERMS = {
    "laravel", "java", "spring", "springboot", "php", "python", "django", "fastapi",
    "flask", "node", "nodejs", "express", "nest", "nestjs", "c#", "csharp", "dotnet",
    "net", "ruby", "rails", "go", "golang", "rust", "swift", "kotlin", "flutter",
    "react", "vue", "angular", "postman", "curl", "axios", "guzzle", "httpclient",
    "backend", "frontend", "mobile", "android", "ios", "sdk"
}

FAST_PATH_PATTERNS = [
    # ─── CONNEXION WHATSAPP & QR CODE ─────────────────────────────────────────
    {
        "id": "connect_wa",
        "keywords": ["connecter whatsapp", "scanner qr", "qr code whatsapp", "connecter mon numero", "connecter mon numéro", "lier un appareil", "comment connecter whatsapp"],
        "answer": """Pour connecter votre numero WhatsApp :

1. Allez dans la section **Sessions** du tableau de bord.
2. Cliquez sur **Connecter un numero** pour afficher le QR code.
3. Ouvrez WhatsApp sur votre telephone.
4. Allez dans **Menu > Appareils lies > Lier un appareil**.
5. Scannez le QR code affiche a l'ecran.

Le statut passe automatiquement a **Connecte** une fois le scan effectue.

[Acceder a mes sessions](/sessions)"""
    },
    {
        "id": "qr_issue",
        "keywords": ["qr code ne s'affiche", "qr code ne marche", "qr code expire", "qr ne charge pas", "qr code tourne en boucle", "que faire si le qr code expire"],
        "answer": """Si le QR code ne s'affiche pas ou a expire :

- Verifiez votre connexion internet.
- Rafraichissez la page du navigateur.
- Desactivez les bloqueurs de publicite ou extensions qui pourraient interferer.
- Le QR code est valide environ 60 secondes. Rafraichissez la page pour en generer un nouveau.

[Acceder a mes sessions](/sessions)"""
    },
    {
        "id": "disconnections",
        "keywords": ["déconnecte souvent", "deconnecte souvent", "whatsapp se déconnecte", "whatsapp se deconnecte", "session deconnectee", "session déconnectée", "déconnexion fréquente"],
        "answer": """Si votre session WhatsApp se deconnecte frequemment :

- Assurez-vous que votre telephone reste connecte a internet (Wi-Fi ou 4G/5G).
- Desactivez l'optimisation de la batterie pour WhatsApp sur Android.
- Ne deconnectez pas la session Convessa depuis l'application mobile WhatsApp (Menu > Appareils lies).

Pour reconnecter, allez dans vos sessions et cliquez sur **Reconnecter** pour scanner un nouveau QR code.

[Acceder a mes sessions](/sessions)"""
    },
    {
        "id": "session_status",
        "keywords": ["verifier l'etat de ma session", "vérifier l'état de ma session", "etat de ma session", "état de ma session", "session est active", "statut de ma session", "ma session est active"],
        "answer": """Vous pouvez verifier l'etat de votre session WhatsApp directement dans la section Sessions du tableau de bord. Le statut indique si votre session est active, en attente de scan QR, ou deconnectee.

Via l'API, l'endpoint `GET /api/v1/tenants/me` retourne egalement le statut de votre session.

[Acceder a mes sessions](/sessions)"""
    },

    # ─── CLÉ API ──────────────────────────────────────────────────────────────
    {
        "id": "api_key",
        "keywords": ["clé api", "cle api", "trouver ma cle", "trouver ma clé", "où est ma clé", "ou est ma cle", "récupérer clé", "recuperer cle", "obtenir cle", "api key", "pk_convessa"],
        "answer": """Votre cle API est generee automatiquement lorsque vous connectez un numero WhatsApp.

1. Connectez-vous au tableau de bord Convessa.
2. Allez dans la section **Sessions**.
3. Votre cle API (format `pk_convessa_...`) s'affiche lors de la premiere connexion.

Stockez-la immediatement dans vos variables d'environnement. Pour des raisons de securite, elle ne sera plus reaffichee en clair. En cas de perte, deconnectez et reconnectez votre session pour en generer une nouvelle.

[Obtenir votre cle API](/docs?section=obtenir-cle-api)  [Acceder a mes sessions](/sessions)"""
    },
    {
        "id": "revoke_key",
        "keywords": ["renouveler clé", "renouveler cle", "révoquer clé", "revoquer cle", "nouvelle clé", "clé expirée", "clé compromise", "regenerer cle", "révoquer ma clé"],
        "answer": """Pour renouveler ou revoquer votre cle API :

- **Renouveler** : Souscrivez a un nouveau plan depuis la section Tarifs. Une nouvelle cle vous est attribuee immediatement.
- **Revoquer** : Depuis vos sessions, deconnectez la session concernee. Cela invalide immediatement la cle associee.

En cas de compromission, deconnectez votre session sans delai.

[Acceder a mes sessions](/sessions)  [Voir les forfaits](/pricing)"""
    },
    {
        "id": "secure_key",
        "keywords": ["securiser ma cle", "sécuriser ma clé", "securiser cle api", "fichier .env", "stocker cle", "proteger cle", "protéger clé"],
        "answer": """Pour securiser votre cle API, stockez-la dans un fichier `.env` a la racine de votre projet et ajoutez ce fichier a votre `.gitignore` pour ne jamais le pousser sur un depot public.

Dans votre code, accedez a la cle via les variables d'environnement de votre langage (par exemple `process.env.CONVESSA_API_KEY` en Node.js). Ne collez jamais la cle en dur dans votre code source.

[Consulter le guide d'integration](/docs?section=integration)"""
    },

    # ─── ENVOI DE MESSAGES ────────────────────────────────────────────────────
    {
        "id": "send_text",
        "keywords": ["comment envoyer un message whatsapp", "endpoint envoi message", "post /send", "envoyer un message texte", "envoyer un premier message", "envoyer un message via"],
        "answer": """Pour envoyer un message texte via l'API :

**Endpoint** : `POST /api/v1/send`

**Headers** :
- `X-Api-Key: pk_convessa_...`
- `Content-Type: application/json`

**Corps** :
```json
{
  "to": "229xxxxxxxxx",
  "message": "Votre commande a ete confirmee."
}
```

Le numero du destinataire doit etre au format international sans `+` ni espace. La reponse `202 Accepted` contient un `messageId` pour suivre le statut.

[Envoi de messages](/docs?section=envoyer-message)  [Envoyer un message](/send-message)"""
    },
    {
        "id": "send_media",
        "keywords": ["envoyer image whatsapp", "envoyer pdf whatsapp", "envoyer photo api", "envoyer document api", "envoyer fichier whatsapp", "envoyer un document pdf", "envoyer une image"],
        "answer": """Pour envoyer une image ou un document via l'API, ajoutez un objet `media` dans votre requete :

```json
{
  "to": "229xxxxxxxxx",
  "message": "Votre document en piece jointe.",
  "media": {
    "type": "document",
    "mime": "application/pdf",
    "url": "https://cdn.example.com/facture.pdf",
    "name": "facture.pdf"
  }
}
```

Formats acceptes : Images (JPEG, PNG - 5MB max), Documents (PDF, Word, ZIP - 100MB max), Audios (MP3 - 16MB max), Videos (MP4 - 16MB max).

[Envoi de messages](/docs?section=envoyer-message)"""
    },
    {
        "id": "broadcast",
        "keywords": ["envoyer à plusieurs", "envoyer a plusieurs", "envoi en masse", "envoyer en masse", "envoi groupe", "diffusion whatsapp", "plusieurs destinataires"],
        "answer": """Pour envoyer un message a plusieurs destinataires en une seule requete, utilisez un tableau dans le champ `to` :

```json
{
  "to": ["229xxxxxxxxx", "229yyyyyyyyy", "229zzzzzzzzz"],
  "message": "Notre boutique est ouverte ce samedi."
}
```

Maximum **50 destinataires** par appel. Chaque destinataire recoit un message individuel avec un `messageId` distinct.

[Envoi de messages](/docs?section=envoyer-message)"""
    },
    {
        "id": "message_status",
        "keywords": ["suivre le statut", "statut d'un message", "sent/delivered", "message delivre", "message envoye", "suivi message", "accusé de reception"],
        "answer": """Chaque message envoye retourne un `messageId` dans la reponse `202 Accepted`. Vous pouvez suivre son statut (sent, delivered, read) de deux facons :

- Via l'endpoint `GET /api/v1/send/status/{messageId}`
- En temps reel via les Webhooks ou la connexion Socket.io

[Reference API](/docs?section=reference-api)"""
    },

    # ─── HEADERS & INTÉGRATION ────────────────────────────────────────────────
    {
        "id": "headers",
        "keywords": ["headers obligatoires", "headers requis", "headers http", "quels sont les headers", "header api"],
        "answer": """Deux headers sont obligatoires pour chaque requete a l'API Convessa :

- `X-Api-Key: pk_convessa_...` pour l'authentification
- `Content-Type: application/json` pour le format des donnees

Ces headers doivent etre presents dans toutes vos requetes POST et GET authentifiees.

[Reference API](/docs?section=reference-api)  [Consulter le guide d'integration](/docs?section=integration)"""
    },
    {
        "id": "webhook",
        "keywords": ["configurer un webhook", "webhook", "retours d'envoi", "notification de livraison", "callback url"],
        "answer": """Les Webhooks vous permettent de recevoir des notifications en temps reel lorsque le statut d'un message change (envoye, delivre, lu). Vous pouvez configurer votre URL de callback dans les parametres de votre session sur le tableau de bord.

Pour plus de details sur le format des notifications et la mise en place, consultez la documentation d'integration.

[Consulter le guide d'integration](/docs?section=integration)  [Acceder a mes sessions](/sessions)"""
    },
    {
        "id": "socketio",
        "keywords": ["socket.io", "temps réel", "temps reel", "websocket", "statuts en temps"],
        "answer": """Convessa propose une connexion Socket.io pour suivre en temps reel les statuts de vos messages et les evenements de session. Cette fonctionnalite est detaillee dans la documentation d'integration.

[Consulter le guide d'integration](/docs?section=integration)"""
    },

    # ─── GROUPES ──────────────────────────────────────────────────────────────
    {
        "id": "create_group",
        "keywords": ["creer un groupe", "créer un groupe", "nouveau groupe whatsapp"],
        "answer": """Vous pouvez creer un groupe WhatsApp via l'API en utilisant l'endpoint dedie. La documentation detaille les parametres necessaires (nom du groupe, participants).

[Gestion des groupes](/docs?section=groupes)"""
    },
    {
        "id": "group_members",
        "keywords": ["ajouter des membres", "ajouter membre", "participant groupe", "ajouter au groupe"],
        "answer": """L'ajout de membres a un groupe WhatsApp se fait via l'API avec l'endpoint de gestion des participants. Vous devez fournir les numeros au format international.

[Gestion des groupes](/docs?section=groupes)"""
    },
    {
        "id": "group_invite",
        "keywords": ["lien d'invitation", "invitation groupe", "invite link"],
        "answer": """Vous pouvez obtenir le lien d'invitation d'un groupe WhatsApp via l'endpoint dedie de l'API. Ce lien permet a d'autres utilisateurs de rejoindre le groupe directement.

[Gestion des groupes](/docs?section=groupes)"""
    },
    {
        "id": "group_message",
        "keywords": ["message dans un groupe", "envoyer groupe", "message groupe"],
        "answer": """Pour envoyer un message dans un groupe, utilisez le meme endpoint `POST /api/v1/send` mais en specifiant l'identifiant du groupe dans le champ `to` au lieu d'un numero individuel.

[Gestion des groupes](/docs?section=groupes)  [Envoi de messages](/docs?section=envoyer-message)"""
    },

    # ─── ERREURS ──────────────────────────────────────────────────────────────
    {
        "id": "error_401",
        "keywords": ["erreur 401", "401 unauthorized", "unauthorized", "non autorisé", "non autorise"],
        "answer": """L'erreur 401 Unauthorized signifie que votre cle API est manquante, invalide ou expiree. Verifiez que le header `X-Api-Key` est bien present et que la cle correspond a une session active.

[Obtenir votre cle API](/docs?section=obtenir-cle-api)  [Erreurs et limites](/docs?section=erreurs-limites)"""
    },
    {
        "id": "error_403",
        "keywords": ["erreur 403", "session not active", "session_not_active", "403 forbidden"],
        "answer": """L'erreur 403 Session Not Active signifie que votre session WhatsApp est deconnectee ou revoquee. Reconnectez-vous en scannant un nouveau QR code depuis la section Sessions du tableau de bord.

[Acceder a mes sessions](/sessions)  [Erreurs et limites](/docs?section=erreurs-limites)"""
    },
    {
        "id": "error_429",
        "keywords": ["erreur 429", "rate limit", "trop de requetes", "limite requetes"],
        "answer": """L'erreur 429 Rate Limit Exceeded signifie que vous avez depasse le nombre maximal de requetes autorisees par minute. Attendez quelques secondes avant de renvoyer votre requete, ou passez a un forfait superieur pour augmenter vos limites.

[Erreurs et limites](/docs?section=erreurs-limites)  [Voir les forfaits](/pricing)"""
    },
    {
        "id": "error_503",
        "keywords": ["erreur 503", "503 service unavailable", "service unavailable", "service indisponible", "service temporairement indisponible"],
        "answer": """L'erreur 503 Service Unavailable signifie que le service est temporairement indisponible, generalement en raison d'une maintenance ou d'une charge elevee sur la plateforme. Reessayez votre requete dans quelques instants.

Si l'erreur persiste au-dela de quelques minutes, contactez le support.

[Erreurs et limites](/docs?section=erreurs-limites)  [Contacter le support](/contact)"""
    },

    # ─── TARIFS & QUOTAS ──────────────────────────────────────────────────────
    {
        "id": "pricing",
        "keywords": ["tarifs convessa", "prix abonnement", "combien coûte convessa", "forfaits disponibles", "tarifs et forfaits", "renouveler mon abonnement"],
        "answer": """Convessa propose plusieurs formules adaptees a vos besoins, du plan Starter pour tester jusqu'au plan Enterprise pour les forts volumes avec support prioritaire. Vous pouvez consulter et souscrire directement depuis votre tableau de bord.

[Voir les forfaits](/pricing)  [Tarifs et limites](/docs?section=tarifs-et-limites)"""
    },
    {
        "id": "quota",
        "keywords": ["consulter quota", "messages restants", "solde messages", "quota restant", "quota épuisé"],
        "answer": """Votre quota de messages est visible dans la section Sessions ou Mon Compte du tableau de bord. Le compteur indique le nombre de messages envoyes et le solde restant.

Vous pouvez aussi consulter ces informations via l'API avec l'endpoint `GET /api/v1/tenants/me`.

[Acceder a mes sessions](/sessions)  [Voir les forfaits](/pricing)"""
    },
    {
        "id": "file_limits",
        "keywords": ["limite de taille", "limites de taille", "taille des fichiers", "taille maximale", "taille max"],
        "answer": """Les limites de taille des fichiers pour l'envoi via l'API Convessa sont :

- Images (JPEG, PNG) : 5 MB maximum
- Documents (PDF, Word, ZIP) : 100 MB maximum
- Audios (MP3, OGG) : 16 MB maximum
- Videos (MP4) : 16 MB maximum

[Envoi de messages](/docs?section=envoyer-message)  [Erreurs et limites](/docs?section=erreurs-limites)"""
    },
    {
        "id": "dest_limit",
        "keywords": ["limite de destinataires", "limite destinataires", "combien de destinataires", "maximum destinataires"],
        "answer": """Vous pouvez envoyer un message a **50 destinataires** maximum par appel API. Chaque destinataire recoit un message individuel avec son propre `messageId` pour le suivi.

[Envoi de messages](/docs?section=envoyer-message)"""
    },

    # ─── SUPPORT ──────────────────────────────────────────────────────────────
    {
        "id": "contact_support",
        "keywords": ["contacter le support", "contacter support", "service client", "assistance technique", "besoin d'aide", "comment contacter"],
        "answer": """Vous pouvez contacter l'equipe Convessa directement depuis la page de contact. L'equipe repond generalement dans les 24 heures ouvrables.

[Contacter le support](/contact)"""
    },
]


# ── Pool de suggestions dynamiques variées ──────────────────────────────────

_SUGGESTION_POOLS = {
    "connexion": [
        "Ou trouver ma cle API ?",
        "Que faire si le QR code expire ?",
        "Comment verifier l'etat de ma session ?",
        "Comment révoquer ma clé API ?",
    ],
    "cle": [
        "Comment envoyer un premier message texte ?",
        "Comment securiser ma cle API dans un fichier .env ?",
        "Comment renouveler mon abonnement ?",
        "Quels sont les headers obligatoires ?",
    ],
    "envoi": [
        "Comment envoyer un document PDF ou une image ?",
        "Comment envoyer un message a plusieurs destinataires ?",
        "Comment suivre le statut d'un message (sent/delivered) ?",
        "Quelle est la limite de destinataires par appel ?",
    ],
    "groupe": [
        "Comment creer un groupe WhatsApp via l'API ?",
        "Comment ajouter des membres a un groupe ?",
        "Comment obtenir le lien d'invitation d'un groupe ?",
        "Comment envoyer un message dans un groupe ?",
    ],
    "erreur": [
        "Que signifie l'erreur 401 Unauthorized ?",
        "Que signifie l'erreur 403 Session Not Active ?",
        "Que signifie l'erreur 429 Rate Limit Exceeded ?",
        "Comment contacter le support technique ?",
    ],
    "integration": [
        "Quels sont les headers HTTP requis ?",
        "Comment configurer un Webhook pour les retours d'envoi ?",
        "Comment suivre les statuts en temps réel via Socket.io ?",
        "Quelles sont les limites de taille des fichiers ?",
    ],
    "default": [
        "Comment connecter mon numero WhatsApp ?",
        "Ou trouver ma cle API ?",
        "Comment envoyer un message via l'API ?",
        "Quels sont les tarifs et forfaits ?",
    ]
}

_SUGGESTION_POOLS_EN = {
    "connexion": [
        "Where can I find my API key?",
        "What if the QR code expires?",
        "How to check my session status?",
        "How to revoke my API key?",
    ],
    "cle": [
        "How to send a first text message?",
        "How to secure my API key in a .env file?",
        "How to renew my subscription?",
        "What are the required HTTP headers?",
    ],
    "envoi": [
        "How to send a PDF or image?",
        "How to send to multiple recipients?",
        "How to track message status?",
        "What is the recipient limit per call?",
    ],
    "default": [
        "How to connect my WhatsApp number?",
        "Where can I find my API key?",
        "How to send a message via API?",
        "What are the pricing plans?",
    ]
}


def get_contextual_suggestions(question: str, history_texts: list[str] = None, lang: str = "fr") -> list[str]:
    """
    Génère 3 suggestions dynamiques et variées en évitant de répéter les questions déjà posées.
    """
    q_lower = question.lower()
    asked_set = set(t.lower() for t in (history_texts or []))

    topic = "default"
    if any(w in q_lower for w in ["connecter", "qr", "session", "scan", "connect"]):
        topic = "connexion"
    elif any(w in q_lower for w in ["cle", "clé", "api key", "pk_convessa", "key"]):
        topic = "cle"
    elif any(w in q_lower for w in ["envoyer", "send", "message", "pdf", "image", "media", "diffusion"]):
        topic = "envoi"
    elif any(w in q_lower for w in ["groupe", "group", "participant"]):
        topic = "groupe"
    elif any(w in q_lower for w in ["erreur", "error", "401", "403", "429", "500", "503"]):
        topic = "erreur"
    elif any(w in q_lower for w in ["laravel", "java", "python", "php", "node", "express", "code", "integration", "webhook"]):
        topic = "integration"

    pools = _SUGGESTION_POOLS_EN if lang == "en" else _SUGGESTION_POOLS
    default_pool = _SUGGESTION_POOLS_EN["default"] if lang == "en" else _SUGGESTION_POOLS["default"]

    pool = pools.get(topic, default_pool)
    
    # Filtre les questions déjà posées dans la conversation
    available = [s for s in pool if s.lower() not in asked_set and s.lower() != q_lower]
    if len(available) < 3:
        # Complète avec le pool par défaut si besoin
        extra = [s for s in default_pool if s not in available and s.lower() not in asked_set]
        available.extend(extra)

    # Détection de friction / blocage / tentative répétée : propose le support en priorité
    is_blocked = any(w in q_lower for w in ["probleme", "problème", "erreur", "error", "issue", "bloque", "bloqué", "marche pas", "fonctionne pas", "bug", "echec", "échec", "invalide"]) or len(history_texts or []) >= 4
    support_suggestion = "How to contact technical support?" if lang == "en" else "Comment contacter le support technique ?"

    if is_blocked and support_suggestion not in asked_set:
        available = [s for s in available if s != support_suggestion]
        selected = [support_suggestion] + available[:2]
    else:
        selected = available[:3] if len(available) >= 3 else available

    return selected


# Mots-clés de contexte personnel : Si la question utilise des possessifs ou concerne le compte spécifique du dev/tenant,
# on REFUSE le fast-path pour que le LLM réponde de façon 100% dynamique et personnalisée avec les données en direct du tenant.
PERSONAL_INDICATORS = [
    "mon ", "ma ", "mes ", "mon_compte", "ma session", "mon statut", "mon quota",
    "mon forfait", "mon numéro", "mon numero", "mes messages", "combien me reste",
    "solde", "suis-je", "ai-je", "est-ce que je"
]


def _normalize_words(text: str) -> list[str]:
    """Minuscule, sans accents, ponctuation retirée -> liste de mots."""
    normalized = unicodedata.normalize('NFD', text)
    normalized = ''.join(c for c in normalized if unicodedata.category(c) != 'Mn')
    normalized = re.sub(r'[^\w\s]', ' ', normalized.lower())
    return [w for w in normalized.split() if w]


def _fuzzy_keyword_match(q_words: list[str], keyword: str) -> bool:
    """
    Vérifie que CHAQUE mot du mot-clé trouve une correspondance proche parmi
    les mots de la question (tolérance aux fautes de frappe, via difflib).
    Les mots trop courts (<=3 caractères, ex: "qr", "api") exigent une
    correspondance exacte pour éviter les faux positifs sur des mots courts
    qui se ressemblent tous un peu entre eux.

    CORRECTIF : une vraie faute de frappe change rarement la longueur d'un
    mot de plus de 1-2 caractères ("comnent"/"comment", "webhok"/"webhook").
    Sans ce garde-fou, un mot-clé composé comme "pk_convessa" (11 caractères)
    était jugé "assez proche" de "convessa" (8 caractères) par le seul ratio
    de similarité — ce n'est pas une faute de frappe, c'est un mot différent
    qui contient l'autre comme sous-chaîne. Ce cas précis faisait matcher
    n'importe quelle question mentionnant "Convessa" avec la réponse sur la
    clé API. Une différence de longueur > 2 exclut désormais ce cas tout en
    laissant passer les vraies fautes de frappe.
    """
    kw_words = _normalize_words(keyword)
    if not kw_words:
        return False
    for kw_word in kw_words:
        if len(kw_word) <= 3:
            if kw_word not in q_words:
                return False
            continue
        matches = difflib.get_close_matches(kw_word, q_words, n=1, cutoff=0.8)
        if not matches:
            return False
        if abs(len(matches[0]) - len(kw_word)) > 2:
            return False
    return True


def check_fast_path(question: str) -> tuple[str, list[str]] | None:
    """
    Vérifie si la question est une question FAQ exacte et générale.
    Retourne (réponse, suggestions) ou None si la question nécessite le RAG / LLM.
    """
    q_lower = question.lower().strip()
    if len(q_lower) < 3:
        return None

    # RÈGLE 1 : Si la question concerne l'intégration dans un langage/framework spécifique,
    # on REFUSE le fast-path pour forcer la génération du code par le LLM + RAG.
    tokens = set(re.findall(r'\w+', q_lower))
    if tokens.intersection(TECH_INTEGRATION_TERMS):
        return None

    # RÈGLE 2 : Si la question concerne l'état personnel du compte/tenant (contexte live),
    # on REFUSE le fast-path pour que le LLM génère une réponse hyper-personnalisée.
    if any(ind in q_lower for ind in PERSONAL_INDICATORS):
        return None

    # RÈGLE 3 : Correspondance stricte de mots-clés de phrase pour la doc générale
    for item in FAST_PATH_PATTERNS:
        for kw in item["keywords"]:
            if kw in q_lower:
                suggestions = get_contextual_suggestions(q_lower)
                return item["answer"], suggestions

    # RÈGLE 4 (fallback) : Correspondance approximative — tolère les fautes de
    # frappe (ex. "connceter whatapp") quand aucune correspondance exacte n'a
    # été trouvée à la règle 3. Ne s'applique qu'aux mêmes patterns, avec le
    # même filtrage tech/personnel déjà effectué ci-dessus.
    q_words = _normalize_words(q_lower)
    if q_words:
        for item in FAST_PATH_PATTERNS:
            for kw in item["keywords"]:
                if _fuzzy_keyword_match(q_words, kw):
                    suggestions = get_contextual_suggestions(q_lower)
                    return item["answer"], suggestions

    return None