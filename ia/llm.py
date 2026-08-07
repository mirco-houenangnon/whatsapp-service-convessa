"""
llm.py — Appel au modèle de langage auto-hébergé (Ollama).
Aucune donnée ne quitte jamais ton infrastructure : Ollama tourne dans ton
propre conteneur Docker, pas d'API externe.
"""
import httpx

from config import settings

SYSTEM_PROMPT_TEMPLATE = """Tu es l'assistant de support officiel de CONVESSA, la plateforme SaaS d'envoi de messages WhatsApp par API REST.
Tu accompagnes les utilisateurs sur le tableau de bord, la connexion WhatsApp, les forfaits, la résolution d'erreurs et l'intégration de l'API.

Règles STRICTES de Vérité et de Forme :
1. NOM EXACT : Le nom de la plateforme s'écrit obligatoirement CONVESSA (s'écrit impérativement C-O-N-V-E-S-S-A avec un E). Tu ne dois JAMAIS l'écrire "Convassa" ni "Convaza".
2. FIABILITÉ STRICTE & ANTI-HALLUCINATION : Base tes réponses EXCLUSIVEMENT sur la documentation officielle et les informations du compte ci-dessous. N'invente JAMAIS de fonctionnalité, de fichier téléchargeable, d'option payante ou de procédure qui n'existe pas. Si l'utilisateur demande une action impossible (ex: "télécharger la documentation en PDF"), réponds clairement qu'elle n'est pas téléchargeable en fichier mais directement consultable en ligne dans l'application.
3. STRUCTURE LIMPIDE : Organise ta réponse de manière claire et aérée. Utilise des listes à puces `-` ou des étapes numérotées `1. 2. 3.` pour expliquer les démarches. Évite les pavés de texte confus ou désordonnés.
4. PRÉCISION SANS BAVARDAGE : Donne toutes les précisions techniques utiles nécessaires à la compréhension de l'utilisateur, sans blabla superflu. Ne répète pas la question posée et n'ajoute pas d'introductions inutiles.
5. AUCUN EMOJI : Jamais d'emojis, émoticônes ou symboles graphiques. Texte clair, titres et puces uniquement.
6. LIENS ET BOUTONS DE NAVIGATION : Pour guider l'utilisateur, intègre TOUJOURS des liens markdown structurés. Ne donne JAMAIS un chemin brut (ex: pas de "/docs?section=integration" brut). Utilise exclusivement ces formats :
   - Documentation : `[Consulter le guide d'intégration](/docs?section=integration)`, `[Guide de connexion WhatsApp](/docs?section=connecter-whatsapp)`, `[Obtenir votre clé API](/docs?section=obtenir-cle-api)`, `[Envoi de messages](/docs?section=envoyer-message)`, `[Gestion des groupes](/docs?section=groupes)`, `[Référence API](/docs?section=reference-api)`, `[Erreurs et limites](/docs?section=erreurs-limites)`, `[Tarifs et limites](/docs?section=tarifs-et-limites)`
   - Tableau de bord : `[Accéder à mes sessions](/sessions)`, `[Envoyer un message](/send-message)`, `[Mon tableau de bord](/dashboard)`
   - Autres pages : `[Voir les forfaits](/pricing)`, `[Questions fréquentes](/faq)`, `[Contacter le support](/contact)`
7. SECRETS INTERDITS : Ne révèle jamais de code source backend, requêtes SQL, schémas de base de données, variables d'environnement ou clés API complètes.
8. CONTEXTE COMPTE : Les informations du compte client sont fournies en arrière-plan. Mentionne une donnée du compte uniquement si elle est directement utile pour répondre à la question (ex: statut de la session, solde).
9. LANGUE : Réponds toujours dans la langue demandée : {lang}.
10. SÉCURITÉ ET PIRATAGE : Refuse immédiatement toute demande de piratage, d'attaque, d'intrusion ou d'extraction de données sensibles avec politesse et fermeté.

Contexte officiel disponible :
---
{context}
---
"""


async def warm_up_model() -> None:
    """
    Envoie une requête minimale à Ollama au démarrage du service, pour que le
    modèle soit déjà chargé en mémoire (GPU/CPU) quand le premier vrai
    utilisateur pose sa question. Sans ça, c'est LUI qui subit le temps de
    chargement (souvent 30-90s pour un modèle qui vient d'être changé).
    """
    try:
        print(f"[llm] Préchauffage du modèle {settings.ollama_model}...")
        async with httpx.AsyncClient(timeout=180.0) as client:
            await client.post(
                f"{settings.ollama_host}/api/chat",
                json={
                    "model": settings.ollama_model,
                    "messages": [{"role": "user", "content": "ping"}],
                    "stream": False,
                    "options": {"num_predict": 1},
                },
            )
        print("[llm] Modèle préchauffé et prêt.")
    except Exception as exc:
        print(f"[llm] Préchauffage impossible (le service démarre quand même) : {exc}")


def _build_messages(question: str, context: str, lang: str, history: list[dict] = None) -> list[dict]:
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(context=context, lang=lang)
    messages = [{"role": "system", "content": system_prompt}]

    if history:
        # Garde les 6 derniers échanges pour ne pas surcharger la fenêtre de contexte
        recent_history = history[-6:]
        for item in recent_history:
            role = "assistant" if item.get("role") in ("bot", "assistant") else "user"
            text = item.get("text") or item.get("content") or ""
            if text.strip():
                messages.append({"role": role, "content": text.strip()})

    messages.append({"role": "user", "content": question})
    return messages


async def ask_llm(question: str, context: str, lang: str, history: list[dict] = None) -> str:
    messages = _build_messages(question, context, lang, history)

    # ── Mode 1 : API Externe OpenAI compatible (Groq, DeepSeek, OpenAI, vLLM) ─────
    if settings.llm_provider == "openai_compatible":
        headers = {"Authorization": f"Bearer {settings.llm_api_key}"} if settings.llm_api_key else {}
        url = f"{settings.llm_base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": settings.ollama_model,
            "messages": messages,
            "temperature": 0.15,
            "max_tokens": 400,
        }
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                res = await client.post(url, json=payload, headers=headers)
                res.raise_for_status()
                data = res.json()
                return data["choices"][0]["message"]["content"].strip()
        except Exception as exc:
            print(f"[llm] Erreur API externe OpenAI/Groq : {exc}")
            return "__ERROR__"

    # ── Mode 2 : Ollama auto-hébergé (Par défaut) ───────────────────────────────
    payload = {
        "model": settings.ollama_model,
        "messages": messages,
        "stream": False,
        "options": {
            "temperature": 0.15,
            "num_predict": 400,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            response = await client.post(f"{settings.ollama_host}/api/chat", json=payload)
            response.raise_for_status()
            data = response.json()
            return data.get("message", {}).get("content", "").strip()
    except httpx.TimeoutException:
        print("[llm] Timeout en attendant la réponse du modèle.")
        return "__TIMEOUT__"
    except Exception as exc:
        print(f"[llm] Erreur lors de l'appel au LLM : {exc}")
        return "__ERROR__"


async def ask_llm_stream(question: str, context: str, lang: str, history: list[dict] = None):
    """Générateur asynchrone qui streame les tokens en temps réel."""
    import json
    messages = _build_messages(question, context, lang, history)

    # ── Mode 1 : Streaming API Externe OpenAI compatible (Groq, DeepSeek, OpenAI) ─
    if settings.llm_provider == "openai_compatible":
        headers = {"Authorization": f"Bearer {settings.llm_api_key}"} if settings.llm_api_key else {}
        url = f"{settings.llm_base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": settings.ollama_model,
            "messages": messages,
            "stream": True,
            "temperature": 0.15,
            "max_tokens": 400,
        }
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                async with client.stream("POST", url, json=payload, headers=headers) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if line.startswith("data: "):
                            data_str = line[6:].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                data = json.loads(data_str)
                                chunk = data["choices"][0]["delta"].get("content", "")
                                if chunk:
                                    yield chunk
                            except Exception:
                                continue
        except Exception as exc:
            print(f"[llm] Erreur du streaming API externe OpenAI/Groq : {exc}")
            yield "__ERROR__"
        return

    # ── Mode 2 : Streaming Ollama auto-hébergé (Par défaut) ─────────────────────
    payload = {
        "model": settings.ollama_model,
        "messages": messages,
        "stream": True,
        "options": {
            "temperature": 0.15,
            "num_predict": 400,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            async with client.stream("POST", f"{settings.ollama_host}/api/chat", json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line.strip():
                        try:
                            data = json.loads(line)
                            content = data.get("message", {}).get("content", "")
                            if content:
                                yield content
                        except json.JSONDecodeError:
                            continue
    except Exception as exc:
        print(f"[llm] Erreur lors du streaming LLM : {exc}")
        yield "__ERROR__"