"""
main.py — Point d'entrée du service IA.

Démarrage :
  1. Ouvre/crée la base vectorielle Chroma
  2. Indexe tout le projet (docs + code) une première fois
  3. Démarre la surveillance temps réel (réindexe à chaque modification)
  4. Expose POST /chat pour le frontend (via le backend Node, jamais en direct)
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config import settings
from ingest import get_chroma_collection, index_all, start_watchers
from fastapi.responses import StreamingResponse
from fast_path import check_fast_path
from llm import ask_llm, ask_llm_stream, warm_up_model
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


@app.post("/chat")
async def chat(
    req: ChatRequest,
    authorization: str = Header(default=""),
    x_internal_service_key: str = Header(default=""),
):
    # Vérifie que l'appel vient bien du backend Node, pas d'un client externe.
    if x_internal_service_key != settings.internal_ai_service_key:
        return ChatResponse(answer="Accès non autorisé.", sources=[])

    # 0. SHIELD (Bouclier Anti-Jailbreak)
    bad_words = ["ignore", "prompt", "raconte", "poème", "blague", "code source"]
    msg_lower = req.message.lower()
    if any(bw in msg_lower for bw in bad_words):
        shield_msg = "Je suis un assistant dédié à Convessa. Je ne peux répondre qu'aux questions concernant notre plateforme et l'API WhatsApp."
        if req.stream:
            async def generate_shield_stream():
                import json
                import asyncio
                await asyncio.sleep(0.3)
                words = shield_msg.split(' ')
                for i, word in enumerate(words):
                    chunk = word if i == 0 else ' ' + word
                    yield f"data: {json.dumps({'chunk': chunk})}\n\n"
                    await asyncio.sleep(0.025)
                yield "data: [DONE]\n\n"
            return StreamingResponse(generate_shield_stream(), media_type="text/event-stream")
        return ChatResponse(answer=shield_msg, sources=[])

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
                # 3. Transmet les suggestions dynamiques
                yield f"data: {json.dumps({'suggestions': suggestions})}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(generate_fast_stream(), media_type="text/event-stream")
        return ChatResponse(answer=fast_answer, sources=["documentation_officielle"])

    # 2. RAG & Contexte Client
    collection = _state["collection"]
    context, sources = retrieve_context(collection, req.message)

    if context == "__OUT_OF_DOMAIN__":
        out_msg = "Je suis un assistant dédié à Convessa. Je ne peux répondre qu'aux questions concernant notre plateforme et l'API WhatsApp."
        if req.stream:
            async def generate_out_stream():
                import json
                import asyncio
                await asyncio.sleep(1.0)
                words = out_msg.split(' ')
                for i, word in enumerate(words):
                    chunk = word if i == 0 else ' ' + word
                    yield f"data: {json.dumps({'chunk': chunk})}\n\n"
                    await asyncio.sleep(0.035)
                yield "data: [DONE]\n\n"
            return StreamingResponse(generate_out_stream(), media_type="text/event-stream")
        return ChatResponse(answer=out_msg, sources=[])

    # Si un token Firebase est transmis, on enrichit le contexte avec les
    # données du compte du client — récupérées via le backend, jamais en direct.
    firebase_token = authorization.replace("Bearer ", "", 1) if authorization else ""
    tenant_context = await fetch_tenant_context(firebase_token)
    if tenant_context:
        context = f"[Compte du client connecté]\n{tenant_context}\n\n---\n\n{context}"

    # 3. STREAMING MODE (LLM)
    if req.stream:
        async def event_generator():
            import json
            full_text = []
            async for token in ask_llm_stream(req.message, context, req.lang, req.history):
                if token == "__ERROR__":
                    yield f"data: {json.dumps({'error': 'Erreur lors de la génération'})}\n\n"
                    break
                full_text.append(token)
                safe_token = redact_sensitive(token)
                yield f"data: {json.dumps({'chunk': safe_token})}\n\n"
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

            yield "data: [DONE]\n\n"

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    # 4. STANDARD MODE (Non-streaming)
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

    safe_answer = redact_sensitive(raw_answer)
    return ChatResponse(answer=safe_answer, sources=sources)