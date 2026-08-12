"""
config.py — Lecture centralisée des variables d'environnement.

Le service IA hérite directement des variables du process Node.js parent
(lui-même chargé depuis .env.docker). Il n'y a pas de fichier .env séparé
pour l'IA — toutes les variables viennent du même .env.docker du backend.
"""
import os


def _optional(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


class Settings:
    ollama_host: str     = _optional("OLLAMA_HOST",    "http://host.docker.internal:11434")
    ollama_model: str    = _optional("OLLAMA_MODEL",   "qwen2.5:3b")

    # Fournisseur LLM : "ollama" (auto-hébergé) ou "openai_compatible" (Groq, OpenAI, vLLM)
    llm_provider: str    = _optional("LLM_PROVIDER",   "ollama")
    llm_api_key: str     = _optional("LLM_API_KEY",    "")
    llm_base_url: str    = _optional("LLM_BASE_URL",   "https://api.groq.com/openai/v1")

    embedding_model: str = _optional("EMBEDDING_MODEL", "intfloat/multilingual-e5-base")

    # Chemins dans le conteneur — définis par le spawn Node (index.ts)
    docs_path: str   = _optional("DOCS_PATH",   "/app/ia/docs")
    chroma_path: str = _optional("CHROMA_PATH", "/app/ia/chroma_db")

    # Clé interne héritée du backend (même valeur que INTERNAL_AI_SERVICE_KEY)
    internal_ai_service_key: str = _optional("INTERNAL_AI_SERVICE_KEY", "")

    # URL du backend — l'IA s'y connecte pour récupérer le contexte tenant
    backend_internal_url: str = _optional("BACKEND_INTERNAL_URL", "http://127.0.0.1:3005")

    port: int = int(_optional("PORT", "8100"))


settings = Settings()
