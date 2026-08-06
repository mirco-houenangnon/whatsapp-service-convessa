"""
config.py — Lecture centralisée des variables d'environnement.
"""
import os
from dotenv import load_dotenv

load_dotenv()


def _optional(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


class Settings:
    ollama_host: str     = _optional("OLLAMA_HOST",    "http://ollama:11434")
    ollama_model: str    = _optional("OLLAMA_MODEL",   "qwen2.5:3b")

    # Fournisseur LLM : "ollama" (auto-hébergé) ou "openai_compatible" (Groq, DeepSeek, OpenAI, vLLM)
    llm_provider: str    = _optional("LLM_PROVIDER",   "ollama")
    llm_api_key: str     = _optional("LLM_API_KEY",    "")
    llm_base_url: str    = _optional("LLM_BASE_URL",   "https://api.groq.com/openai/v1")

    embedding_model: str = _optional("EMBEDDING_MODEL", "intfloat/multilingual-e5-base")

    docs_path: str  = _optional("DOCS_PATH",  "/data/frontend-docs")
    chroma_path: str = _optional("CHROMA_PATH", "/data/chroma_db")

    internal_ai_service_key: str = _optional("INTERNAL_AI_SERVICE_KEY", "")
    backend_internal_url: str    = _optional("BACKEND_INTERNAL_URL", "http://backend:3005")

    port: int = int(_optional("PORT", "8100"))


settings = Settings()
