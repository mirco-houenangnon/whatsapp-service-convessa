"""
security.py — Deuxième ligne de défense (la première étant le prompt système
dans llm.py, qui peut échouer, donc on ne lui fait jamais confiance seule).

1. redact_sensitive() : masque toute donnée qui ressemble à un secret dans le
   texte final, AVANT qu'il ne soit renvoyé à l'utilisateur.
2. fetch_tenant_context() : si la question porte sur le compte du client
   connecté, va chercher ses données via le backend Node — jamais directement
   en base. Le backend applique sa propre whitelist (voir schemaMeta.ts).
"""
import re

import httpx

from config import settings

# Motifs à masquer systématiquement, même s'ils viennent du contexte indexé
# par erreur (défense en profondeur — ne remplace pas une bonne indexation).
_PATTERNS = [
    re.compile(r"pk_convessa_[A-Za-z0-9_-]{10,}"),                              # Clé API tenant
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),          # Emails
    re.compile(r"(?i)(password|mot de passe|secret|token|api[_-]?key|mysql_password|internal_key)\s*[:=]\s*\S+"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),  # JWT
    re.compile(r"(?i)\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE)\b\s+"), # SQL queries
    re.compile(r"(?i)/(app|whatsapp-service|ia-service|Convessa|node_modules|src/api|src/db|src/services)/[A-Za-z0-9_./-]+"), # Internal paths
]

_REDACTED = "[information masquée]"


def redact_sensitive(text: str) -> str:
    cleaned = text
    for pattern in _PATTERNS:
        cleaned = pattern.sub(_REDACTED, cleaned)
    return cleaned


async def fetch_tenant_context(firebase_id_token: str) -> str:
    """
    Demande au backend Node un résumé sécurisé du compte du tenant connecté
    (plan, statut de session, quotas...). Le backend vérifie le token Firebase
    lui-même et ne renvoie QUE ce qu'il a explicitement autorisé.
    Retourne une chaîne vide si le token est absent/invalide — le chatbot
    répondra alors uniquement à partir de la documentation publique.
    """
    if not firebase_id_token:
        return ""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{settings.backend_internal_url}/api/v1/internal/chatbot-context",
                headers={
                    "Authorization": f"Bearer {firebase_id_token}",
                    "X-Internal-Service-Key": settings.internal_ai_service_key,
                },
            )
            if resp.status_code != 200:
                return ""
            data = resp.json()
            return data.get("context", "")
    except Exception as exc:
        print(f"[security] Impossible de récupérer le contexte tenant : {exc}")
        return ""
