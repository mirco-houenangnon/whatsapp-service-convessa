"""
main.py — Point d'entrée du service IA.

Démarrage :
  1. Ouvre/crée la base vectorielle Chroma
  2. Indexe tout le projet (docs + code) une première fois
  3. Démarre la surveillance temps réel (réindexe à chaque modification)
  4. Expose POST /chat pour le frontend (via le backend Node, jamais en direct)
"""
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from cache import cache_get, cache_set
from config import settings
from ingest import get_chroma_collection, index_all, start_watchers
from fastapi.responses import StreamingResponse
from fast_path import check_fast_path, PERSONAL_INDICATORS
from llm import ask_llm, ask_llm_stream, warm_up_model, detect_system_prompt_leak
from rag import retrieve_context
from security import redact_sensitive, fetch_tenant_context

_state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    collection = get_chroma_collection()
    index_all(collection)
    observer = start_watchers(collection)
    _state["collection"] = collection
    _state["observer"] = observer
    await warm_up_model()
    yield
    observer.stop()
    observer.join()


app = FastAPI(title="Service IA — Chatbot du projet", lifespan=lifespan)

# Ce service n'est JAMAIS exposé publiquement (voir docker-compose.yml —
# pas de port publié). Seul le backend Node l'appelle, en réseau interne.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.backend_internal_url],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    lang: str = "fr"  # "fr" | "en" | "es"
    history: list[dict] = []
    stream: bool = False


class ChatResponse(BaseModel):
    answer: str
    sources: list[str]


@app.get("/health")
def health():
    return {"status": "ok"}


# ── Bouclier anti-jailbreak (1er filet, en entrée) ──────────────────────────
# Correspondance sur des MOTS/PHRASES ENTIERS (frontières \b), pas sur de
# simples sous-chaînes — évite les faux positifs (ex: "ignorer" ne doit pas
# déclencher juste parce qu'il contient "ignore"). Liste étendue à des
# formulations de contournement courantes (FR/EN), en plus des mots isolés
# déjà couverts.
_SHIELD_WORDS = [
    "ignore", "prompt", "raconte", "poème", "blague", "code source",
    "instructions internes", "instructions systeme", "instructions système",
    "oublie tes instructions", "ignore les instructions",
    "ignore toutes les instructions", "quelles sont tes instructions",
    "repete tes instructions", "répète tes instructions",
    "mode developpeur", "mode développeur", "sans restriction",
    "sans limite", "sans filtre", "nouveau role", "nouveau rôle",
    "tu es maintenant", "system prompt", "jailbreak",
    "ignore previous instructions", "developer mode", "dan mode",
    "no restrictions", "you are now", "repeat your instructions",
    "reveal your instructions",
]
_SHIELD_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(w) for w in _SHIELD_WORDS) + r")\b",
    re.IGNORECASE,
)

# Taille du tampon (en caractères) conservé en fin de flux avant émission,
# pour ne jamais couper un motif sensible (email, clé API, JWT...) en deux
# entre deux tokens successifs du LLM, et pour laisser une marge de détection
# à detect_system_prompt_leak() avant qu'un fragment ne parte au client.
_REDACT_STREAM_BUFFER = 300

# Garde-fous de taille — défense en profondeur : le backend Node valide déjà
# ces limites, mais ce service ne doit jamais faire une confiance aveugle à
# son appelant (même interne).
_MAX_MESSAGE_CHARS = 4000
_MAX_HISTORY_ITEMS = 12
_MAX_HISTORY_ITEM_CHARS = 2000

_SHIELD_MSG = "Je suis un assistant dédié à Convessa. Je ne peux répondre qu'aux questions concernant notre plateforme et l'API WhatsApp."


def _is_personal_question(q_lower: str) -> bool:
    """Même règle que le Fast-Path : question concernant le compte/tenant en direct."""
    return any(ind in q_lower for ind in PERSONAL_INDICATORS)


def _sanitize_history(history: list[dict] | None) -> list[dict]:
    if not history:
        return []
    trimmed = history[-_MAX_HISTORY_ITEMS:]
    safe: list[dict] = []
    for item in trimmed:
        if not isinstance(item, dict):
            continue
        clean = dict(item)
        for field in ("text", "content"):
            if isinstance(clean.get(field), str) and len(clean[field]) > _MAX_HISTORY_ITEM_CHARS:
                clean[field] = clean[field][:_MAX_HISTORY_ITEM_CHARS]
        safe.append(clean)
    return safe


@app.post("/chat")
async def chat(
    req: ChatRequest,
    authorization: str = Header(default=""),
    x_internal_service_key: str = Header(default=""),
):
    # Vérifie que l'appel vient bien du backend Node, pas d'un client externe.
    if x_internal_service_key != settings.internal_ai_service_key:
        return ChatResponse(answer="Accès non autorisé.", sources=[])

    # Garde-fous de taille (défense en profondeur, en plus de la validation Node)
    if len(req.message) > _MAX_MESSAGE_CHARS:
        return ChatResponse(answer="Votre message est trop long.", sources=[])
    req.history = _sanitize_history(req.history)

    # 0. SHIELD (Bouclier Anti-Jailbreak)
    if _SHIELD_PATTERN.search(req.message):
        if req.stream:
            async def generate_shield_stream():
                import json
                import asyncio
                await asyncio.sleep(1.0)
                words = _SHIELD_MSG.split(' ')
                for i, word in enumerate(words):
                    chunk = word if i == 0 else ' ' + word
                    yield f"data: {json.dumps({'chunk': chunk})}\n\n"
                    await asyncio.sleep(0.035)
                yield "data: [DONE]\n\n"
            return StreamingResponse(generate_shield_stream(), media_type="text/event-stream")
        return ChatResponse(answer=_SHIELD_MSG, sources=[])

    # 1. FAST-PATH (< 50ms) : Vérifie si la question correspond à une réponse instantanée
    fast_result = check_fast_path(req.message)
    if fast_result:
        fast_answer, suggestions = fast_result
        if req.stream:
            async def generate_fast_stream():
                import json
                import asyncio
                # 1. Simule un temps de réflexion initial de 1 seconde (1000ms) pour que l'animation "..." soit bien visible
                await asyncio.sleep(1.0)
                # 2. Simule la frappe progressive des mots
                words = fast_answer.split(' ')
                for i, word in enumerate(words):
                    chunk = word if i == 0 else ' ' + word
                    yield f"data: {json.dumps({'chunk': chunk})}\n\n"
                    await asyncio.sleep(0.035)
                # 3. Transmet les suggestions dynamiques et la source
                yield f"data: {json.dumps({'suggestions': suggestions})}\n\n"
                yield f"data: {json.dumps({'sources': ['documentation_officielle']})}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(generate_fast_stream(), media_type="text/event-stream")
        return ChatResponse(answer=fast_answer, sources=["documentation_officielle"])

    # 2. RAG & Contexte Client
    collection = _state["collection"]
    context, sources = retrieve_context(collection, req.message)

    if context == "__OUT_OF_DOMAIN__":
        if req.stream:
            async def generate_out_stream():
                import json
                import asyncio
                await asyncio.sleep(1.0)
                words = _SHIELD_MSG.split(' ')
                for i, word in enumerate(words):
                    chunk = word if i == 0 else ' ' + word
                    yield f"data: {json.dumps({'chunk': chunk})}\n\n"
                    await asyncio.sleep(0.035)
                yield "data: [DONE]\n\n"
            return StreamingResponse(generate_out_stream(), media_type="text/event-stream")
        return ChatResponse(answer=_SHIELD_MSG, sources=[])

    q_lower = req.message.lower().strip()
    is_personal = _is_personal_question(q_lower)

    # Le contexte compte n'est injecté QUE pour les questions réellement
    # personnelles. Pour une question générique ("comment envoyer une
    # image ?"), on ne mélange jamais de données tenant dans le prompt — ça
    # renforce la discrétion du contexte compte ET c'est ce qui permet de
    # mettre en cache une réponse générique en toute sécurité (jamais de
    # données d'un tenant A resservies à un tenant B).
    if is_personal:
        firebase_token = authorization.replace("Bearer ", "", 1) if authorization else ""
        tenant_context = await fetch_tenant_context(firebase_token)
        if tenant_context:
            context = f"[Compte du client connecté]\n{tenant_context}\n\n---\n\n{context}"

    # Log des questions qui échappent au Fast-Path — utile pour repérer les
    # sujets récurrents qui mériteraient une entrée Fast-Path dédiée.
    # On ne journalise QUE la question + langue, jamais le contexte enrichi
    # (qui peut contenir des données de compte), et on tronque par prudence.
    print(f"[main] [RAG_LLM_QUESTION] lang={req.lang} personal={is_personal} question={req.message[:300]!r}")

    cache_hit = None if is_personal else cache_get(req.message, req.lang)

    # 3. STREAMING MODE (LLM ou cache)
    if req.stream:
        if cache_hit:
            async def generate_cached_stream():
                import json
                import asyncio
                await asyncio.sleep(1.0)
                words = cache_hit["answer"].split(' ')
                for i, word in enumerate(words):
                    chunk = word if i == 0 else ' ' + word
                    yield f"data: {json.dumps({'chunk': chunk})}\n\n"
                    await asyncio.sleep(0.035)
                try:
                    from fast_path import get_contextual_suggestions
                    history_texts = [
                        h.get("text") or h.get("content") or ""
                        for h in (req.history or [])
                        if isinstance(h, dict)
                    ]
                    suggestions = get_contextual_suggestions(req.message, history_texts, lang=req.lang)
                    yield f"data: {json.dumps({'suggestions': suggestions})}\n\n"
                except Exception as e:
                    print(f"[main] Erreur lors du calcul des suggestions (cache) : {e}")
                yield f"data: {json.dumps({'sources': cache_hit['sources']})}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(generate_cached_stream(), media_type="text/event-stream")

        async def event_generator():
            import json
            full_text = ""
            flushed_len = 0

            try:
                async for token in ask_llm_stream(req.message, context, req.lang, req.history):
                    if token == "__ERROR__":
                        yield f"data: {json.dumps({'error': 'Erreur lors de la génération'})}\n\n"
                        return

                    full_text += token

                    # 2e filet anti-jailbreak : si le texte accumulé jusqu'ici
                    # contient une fuite verbatim du prompt système, on coupe
                    # immédiatement. Comme la phrase la plus courte détectée
                    # fait >= 30 caractères et que le tampon de rédaction fait
                    # 300 caractères, on est certain qu'elle n'a pas encore
                    # été envoyée au client à ce stade.
                    if detect_system_prompt_leak(full_text):
                        print("[main] Tentative de fuite du prompt système détectée et bloquée.")
                        yield f"data: {json.dumps({'chunk': _SHIELD_MSG})}\n\n"
                        return

                    # Rédaction sur le texte ACCUMULÉ (pas sur le token isolé) afin
                    # de rattraper les motifs sensibles qui s'étalent sur plusieurs
                    # tokens. On ne libère que la portion suffisamment "ancienne"
                    # (au-delà du tampon), pour ne jamais envoyer un fragment qui
                    # pourrait encore faire partie d'un motif en cours de formation.
                    redacted_full = redact_sensitive(full_text)
                    safe_upto = max(0, len(redacted_full) - _REDACT_STREAM_BUFFER)
                    if safe_upto > flushed_len:
                        chunk_to_send = redacted_full[flushed_len:safe_upto]
                        if chunk_to_send:
                            yield f"data: {json.dumps({'chunk': chunk_to_send})}\n\n"
                        flushed_len = safe_upto

                # Fin normale du flux : on vide le reste du tampon, rédigé.
                redacted_full = redact_sensitive(full_text)
                remainder = redacted_full[flushed_len:]
                if remainder:
                    yield f"data: {json.dumps({'chunk': remainder})}\n\n"

                if not is_personal and redacted_full.strip():
                    cache_set(req.message, req.lang, redacted_full, sources)

                # Envoie des suggestions dynamiques calculées en fonction de l'historique
                try:
                    from fast_path import get_contextual_suggestions
                    history_texts = [
                        h.get("text") or h.get("content") or ""
                        for h in (req.history or [])
                        if isinstance(h, dict)
                    ]
                    suggestions = get_contextual_suggestions(req.message, history_texts, lang=req.lang)
                    yield f"data: {json.dumps({'suggestions': suggestions})}\n\n"
                except Exception as e:
                    print(f"[main] Erreur lors du calcul des suggestions : {e}")

                yield f"data: {json.dumps({'sources': sources})}\n\n"

            except Exception as exc:
                # Filet de sécurité : toute exception imprévue dans le flux (JSON,
                # rédaction, etc.) ne doit jamais empêcher l'envoi du [DONE] final.
                print(f"[main] Erreur inattendue dans le flux SSE : {exc}")
                yield f"data: {json.dumps({'error': 'Erreur lors de la génération'})}\n\n"
            finally:
                yield "data: [DONE]\n\n"

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    # 4. STANDARD MODE (Non-streaming)
    if cache_hit:
        return ChatResponse(answer=cache_hit["answer"], sources=cache_hit["sources"])

    raw_answer = await ask_llm(req.message, context, req.lang, req.history)

    if raw_answer == "__TIMEOUT__":
        fallback = {
            "fr": "Le modèle met trop de temps à répondre en ce moment. Réessaie dans un instant.",
            "en": "The model is taking too long to respond right now. Please try again shortly.",
            "es": "El modelo está tardando demasiado en responder. Inténtalo de nuevo en un momento.",
        }
        return ChatResponse(answer=fallback.get(req.lang, fallback["fr"]), sources=sources)

    if raw_answer == "__ERROR__":
        fallback = {
            "fr": "Une erreur technique est survenue côté assistant. L'équipe a été notifiée.",
            "en": "A technical error occurred on the assistant's side. The team has been notified.",
            "es": "Ha ocurrido un error técnico del lado del asistente. El equipo ha sido notificado.",
        }
        return ChatResponse(answer=fallback.get(req.lang, fallback["fr"]), sources=sources)

    # 2e filet anti-jailbreak côté non-streaming : si détecté, on ne renvoie
    # jamais la réponse générée, on bascule sur le message de refus standard.
    if detect_system_prompt_leak(raw_answer):
        print("[main] Tentative de fuite du prompt système détectée et bloquée (non-stream).")
        return ChatResponse(answer=_SHIELD_MSG, sources=[])

    safe_answer = redact_sensitive(raw_answer)
    if not is_personal:
        cache_set(req.message, req.lang, safe_answer, sources)
    return ChatResponse(answer=safe_answer, sources=sources)