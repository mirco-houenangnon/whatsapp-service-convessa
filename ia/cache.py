"""
cache.py — Cache mémoire des réponses RAG+LLM pour questions non-personnelles.

Portée volontairement réduite (v1) : correspondance sur question NORMALISÉE
(minuscule, sans accents, ponctuation/espaces réduits), pas une similarité
sémantique par embeddings. Ça couvre déjà un cas fréquent (plusieurs
utilisateurs tapant une reformulation quasi identique d'une même question),
sans le risque de faux-positif d'un vrai cache sémantique (qui pourrait
retourner une réponse légèrement à côté pour une question voisine mais
différente). Une évolution possible en v2 : réutiliser Chroma pour une
correspondance par similarité vectorielle, avec un seuil de distance strict.

RÈGLE DE SÉCURITÉ IMPORTANTE : ce cache est PARTAGÉ entre tous les
utilisateurs. Il ne doit JAMAIS recevoir de réponse générée à partir du
contexte compte d'un tenant (voir main.py — le cache n'est alimenté/consulté
que pour les questions jugées non-personnelles), sous peine de fuite de
données d'un client vers un autre.
"""
import re
import time
import unicodedata

_ANSWER_CACHE: dict[tuple[str, str], dict] = {}

CACHE_TTL_SECONDS = 6 * 3600  # 6h : au-delà, on préfère régénérer (doc a pu changer)
CACHE_MAX_ENTRIES = 500
CACHE_MIN_QUESTION_LEN = 3


def normalize_question(question: str) -> str:
    """Minuscule, sans accents, ponctuation retirée, espaces réduits."""
    text = unicodedata.normalize('NFD', question or "")
    text = ''.join(c for c in text if unicodedata.category(c) != 'Mn')
    text = re.sub(r'[^\w\s]', ' ', text.lower())
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def _key(question: str, lang: str) -> tuple[str, str]:
    return (normalize_question(question), lang)


def cache_get(question: str, lang: str) -> dict | None:
    if len(normalize_question(question)) < CACHE_MIN_QUESTION_LEN:
        return None
    entry = _ANSWER_CACHE.get(_key(question, lang))
    if not entry:
        return None
    if time.time() - entry["ts"] > CACHE_TTL_SECONDS:
        _ANSWER_CACHE.pop(_key(question, lang), None)
        return None
    return entry


def cache_set(question: str, lang: str, answer: str, sources: list[str]) -> None:
    if len(normalize_question(question)) < CACHE_MIN_QUESTION_LEN or not answer.strip():
        return
    key = _key(question, lang)
    if key not in _ANSWER_CACHE and len(_ANSWER_CACHE) >= CACHE_MAX_ENTRIES:
        # Éviction simple : on retire l'entrée la plus ancienne pour borner la mémoire.
        oldest_key = min(_ANSWER_CACHE, key=lambda k: _ANSWER_CACHE[k]["ts"])
        _ANSWER_CACHE.pop(oldest_key, None)
    _ANSWER_CACHE[key] = {"answer": answer, "sources": sources, "ts": time.time()}


def cache_clear() -> None:
    """Utilitaire pour les tests."""
    _ANSWER_CACHE.clear()


def cache_size() -> int:
    return len(_ANSWER_CACHE)