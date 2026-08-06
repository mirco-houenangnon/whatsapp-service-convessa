"""
rag.py — Retrieval-Augmented Generation avancé.
Extraction précise du contexte de la question avec recherche multi-requêtes,
filtrage par pertinence et structuration pour le LLM.
"""

import re

DOC_RESULTS = 6  # Morceaux de documentation interrogés
MAX_CONTEXT_CHARS = 6000  # Garde-fou pour le contexte du LLM


def _clean_query(question: str) -> str:
    """Conserve uniquement les termes techniques et mots-clés significatifs."""
    # Supprime la ponctuation de base
    q = re.sub(r'[^\w\s]', ' ', question)
    # Mots vides courants en français
    stopwords = {"comment", "pourquoi", "quand", "quel", "quelle", "quels", "quelles", "dans",
                 "avec", "pour", "sans", "sur", "faire", "plus", "avoir", "etre", "est", "des",
                 "les", "une", "des", "qui", "que", "quoi", "mais", "dans", "votre", "mon", "ma"}
    words = [w for w in q.split() if w.lower() not in stopwords and len(w) > 1]
    return " ".join(words) if words else question


def retrieve_context(collection, question: str) -> tuple[str, list[str]]:
    """
    Interroge la base vectorielle avec la question brute + une version nettoyée
    afin de garantir la pertinence contextuelle.
    Retourne (texte de contexte assemblé, liste des fichiers sources utilisés).
    """
    cleaned_q = _clean_query(question)
    query_texts = [question]
    if cleaned_q and cleaned_q != question:
        query_texts.append(cleaned_q)

    doc_results = collection.query(
        query_texts=query_texts,
        n_results=DOC_RESULTS,
        where={"source_type": "doc"},
    )

    pieces: list[str] = []
    sources: list[str] = []
    seen_texts = set()
    total_chars = 0

    all_docs = doc_results.get("documents", [])
    all_metas = doc_results.get("metadatas", [])
    all_distances = doc_results.get("distances", [])

    # Extrait les mots-clés significatifs pour le boost BM25/Hybride
    query_keywords = set(_clean_query(question).lower().split())

    # Fusionne les résultats des requêtes en éliminant les doublons avec score Hybride
    matches = []
    for q_idx in range(len(all_docs)):
        docs = all_docs[q_idx] if q_idx < len(all_docs) else []
        metas = all_metas[q_idx] if q_idx < len(all_metas) else []
        distances = all_distances[q_idx] if q_idx < len(all_distances) else []
        for text, meta, dist in zip(docs, metas, distances):
            if text not in seen_texts:
                seen_texts.add(text)
                # Score Hybride : Si le morceau contient les mots-clés exacts, on applique un boost de pertinence
                text_lower = text.lower()
                kw_matches = sum(1 for kw in query_keywords if kw in text_lower)
                boost = min(0.4, kw_matches * 0.1)
                adjusted_dist = max(0.0, dist - boost)
                matches.append((adjusted_dist, text, meta))

    # Trie par pertinence hybride (distance ajustée la plus faible en premier)
    matches.sort(key=lambda x: x[0])

    for dist, text, meta in matches:
        # Seuil de pertinence (retient les documents pertinents)
        if dist > 1.85:
            continue

        source_path = meta.get("source_path", "inconnu")
        block = f"[Documentation officielle — {source_path}]\n{text}"
        if total_chars + len(block) > MAX_CONTEXT_CHARS:
            continue
        pieces.append(block)
        if source_path not in sources:
            sources.append(source_path)
        total_chars += len(block)

    # Si aucun document sous le seuil strict n'a été retenu, on prend les 3 meilleurs morceaux s'ils existent
    if not pieces and matches:
        for dist, text, meta in matches[:3]:
            source_path = meta.get("source_path", "inconnu")
            block = f"[Documentation officielle — {source_path}]\n{text}"
            pieces.append(block)
            if source_path not in sources:
                sources.append(source_path)

    if not pieces:
        return "__OUT_OF_DOMAIN__", []

    context = "\n\n---\n\n".join(pieces)
    return context, sources