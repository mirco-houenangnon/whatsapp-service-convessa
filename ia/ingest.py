"""
ingest.py — Indexation du projet dans la base vectorielle (Chroma).

Deux sources, avec une priorité différente au moment de la réponse :
  - "doc"  : fichiers Markdown de la documentation publique (frontend/public/docs)
  - "code" : fichiers source du backend (routes, services...) pour les questions
             plus techniques. Le contenu des tables sensibles n'est JAMAIS ici —
             ceci indexe uniquement le CODE, pas les données de la base.

Sécurité : certains fichiers sont explicitement exclus car ils peuvent contenir
des secrets même par erreur (.env, clés de service, certificats...).
"""
import hashlib
import os
import time
from pathlib import Path

import chromadb
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from config import settings

# Extensions qu'on accepte d'indexer (Documentation utilisateur uniquement)
DOC_EXTENSIONS = {".md", ".mdx"}

# Fichiers/dossiers JAMAIS indexés, même par erreur de configuration du volume.
EXCLUDED_PATTERNS = (
    ".env", "secret", "serviceAccount", "firebase-adminsdk",
    ".pem", ".key", "node_modules", ".git",
)

CHUNK_SIZE = 1600      # caractères par morceau — assez grand pour garder un bloc d'exemple de code entier
CHUNK_OVERLAP = 200    # chevauchement pour ne pas couper une idée en deux


def _is_excluded(path: Path) -> bool:
    text = str(path).lower()
    return any(p.lower() in text for p in EXCLUDED_PATTERNS)


def _chunk_markdown(text: str) -> list[str]:
    """
    Découpe un Markdown par section (titres # ## ###), pour que chaque morceau
    reste une unité de sens complète (une étape, une explication) plutôt qu'une
    tranche arbitraire de caractères. Si une section est trop longue, elle est
    ensuite re-découpée avec _chunk_text, mais en gardant son titre en tête de
    chaque sous-morceau pour ne jamais perdre le contexte.
    """
    lines = text.split("\n")
    sections: list[str] = []
    current: list[str] = []

    for line in lines:
        if line.startswith("#") and current:
            sections.append("\n".join(current))
            current = [line]
        else:
            current.append(line)
    if current:
        sections.append("\n".join(current))

    if not sections:
        return _chunk_text(text)

    chunks: list[str] = []
    for section in sections:
        if len(section) <= CHUNK_SIZE:
            if section.strip():
                chunks.append(section)
            continue
        title_line = section.split("\n", 1)[0]
        for sub in _chunk_text(section):
            chunks.append(sub if sub.startswith(title_line) else f"{title_line}\n{sub}")
    return chunks


def _chunk_text(text: str) -> list[str]:
    """Découpe un texte en morceaux avec chevauchement, sur des frontières de ligne si possible."""
    if len(text) <= CHUNK_SIZE:
        return [text]
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        # essaye de couper sur un saut de ligne proche de la fin du morceau
        cut = text.rfind("\n", start, end)
        if cut == -1 or cut <= start + 200:
            cut = end
        chunks.append(text[start:cut])
        start = max(cut - CHUNK_OVERLAP, cut) if cut == end else cut - CHUNK_OVERLAP
        start = max(start, 0)
        if cut == end:
            start = end
    return [c for c in chunks if c.strip()]


def _stable_id(source_path: str, chunk_index: int) -> str:
    h = hashlib.sha256(f"{source_path}:{chunk_index}".encode()).hexdigest()[:16]
    return f"{h}"


def _iter_files(root: str, extensions: set[str]):
    root_path = Path(root)
    if not root_path.exists():
        return
    for path in root_path.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in extensions:
            continue
        if _is_excluded(path):
            continue
        yield path


def get_chroma_collection():
    """Retourne (ou crée) la collection Chroma, avec le modèle d'embeddings ONNX multilingue.

    On charge directement le fichier model.onnx pré-converti depuis le repo
    HuggingFace `optimum/multilingual-e5-base` — zéro torch, zéro conversion
    à la volée. Le tokenizer vient du repo d'origine `intfloat/multilingual-e5-base`.

    Téléchargement unique au premier démarrage (~280 MB), puis mis en cache dans
    le volume Docker hf_cache (/data/hf_cache). Les redémarrages suivants sont
    instantanés.
    """
    import numpy as np
    import onnxruntime as ort
    from transformers import AutoTokenizer
    from huggingface_hub import hf_hub_download

    hf_cache = _hf_cache()
    base_model  = settings.embedding_model              # "intfloat/multilingual-e5-base"
    onnx_repo   = "onnx-community/multilingual-e5-base-ONNX"  # repo HF avec model.onnx pré-converti
    # Le fichier ONNX float32 standard est dans le sous-dossier onnx/
    onnx_file   = "onnx/model.onnx"

    # Tokenizer depuis le repo d'origine (identique à sentence-transformers)
    tokenizer = AutoTokenizer.from_pretrained(base_model, cache_dir=hf_cache)

    # Téléchargement du fichier ONNX pré-converti (pas de torch nécessaire)
    onnx_path = hf_hub_download(
        repo_id=onnx_repo,
        filename=onnx_file,
        cache_dir=hf_cache,
    )

    # Session ONNX Runtime — CPU uniquement, pas de GPU requis
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(onnx_path, sess_options=sess_options,
                                   providers=["CPUExecutionProvider"])

    def _embed(texts: list[str]) -> list[list[float]]:
        # Préfixe recommandé par intfloat pour les requêtes de passage (retrieval)
        prefixed = [f"passage: {t}" for t in texts]
        enc = tokenizer(
            prefixed,
            padding=True,
            truncation=True,
            max_length=512,
            return_tensors="np",
        )
        inputs = {k: v for k, v in enc.items() if k in
                  {inp.name for inp in session.get_inputs()}}
        outputs = session.run(None, inputs)
        # outputs[0] = last_hidden_state (B, T, D)
        token_embeddings = outputs[0]
        attention_mask   = enc["attention_mask"].astype(np.float32)  # (B, T)
        mask_expanded    = attention_mask[:, :, np.newaxis]           # (B, T, 1)
        sum_embeddings   = np.sum(token_embeddings * mask_expanded, axis=1)
        sum_mask         = np.clip(mask_expanded.sum(axis=1), a_min=1e-9, a_max=None)
        embeddings       = sum_embeddings / sum_mask                  # (B, D)
        # Normalisation L2 (cosine similarity ready)
        norms      = np.linalg.norm(embeddings, axis=1, keepdims=True)
        embeddings = embeddings / np.clip(norms, a_min=1e-9, a_max=None)
        return embeddings.tolist()

    client = chromadb.PersistentClient(path=settings.chroma_path)
    return client.get_or_create_collection(
        name="project_knowledge",
        embedding_function=_embed,
        metadata={"hnsw:space": "cosine"},
    )


def _hf_cache() -> str:
    """Chemin du cache HuggingFace — utilise la variable d'env HF_HOME si définie."""
    import os
    return os.environ.get("HF_HOME", "/data/hf_cache")


def _index_file(collection, path: Path, source_type: str, base_dir: str):
    rel_path = str(path.relative_to(base_dir))
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception as exc:
        print(f"[ingest] Impossible de lire {rel_path} : {exc}")
        return

    # On retire d'abord les anciens morceaux de ce fichier (cas d'une modification)
    collection.delete(where={"source_path": rel_path})

    chunks = _chunk_markdown(text) if path.suffix.lower() in DOC_EXTENSIONS else _chunk_text(text)
    if not chunks:
        return

    ids = [_stable_id(rel_path, i) for i in range(len(chunks))]
    metadatas = [
        {"source_path": rel_path, "source_type": source_type, "chunk_index": i}
        for i in range(len(chunks))
    ]
    collection.add(documents=chunks, ids=ids, metadatas=metadatas)
    print(f"[ingest] Indexé : {rel_path} ({len(chunks)} morceaux)")


def _remove_file(collection, path: Path, base_dir: str):
    try:
        rel_path = str(path.relative_to(base_dir))
    except ValueError:
        return
    collection.delete(where={"source_path": rel_path})
    print(f"[ingest] Retiré de l'index : {rel_path}")


def index_all(collection) -> None:
    """Indexation complète de la documentation — appelée au démarrage du service."""
    count = 0
    for path in _iter_files(settings.docs_path, DOC_EXTENSIONS):
        _index_file(collection, path, "doc", settings.docs_path)
        count += 1
    print(f"[ingest] Indexation complète terminée : {count} fichiers de documentation.")


class _ReindexHandler(FileSystemEventHandler):
    """Réagit à chaque modification de fichier pour ré-indexer en temps réel."""

    def __init__(self, collection, base_dir: str, source_type: str, extensions: set[str]):
        self.collection = collection
        self.base_dir = base_dir
        self.source_type = source_type
        self.extensions = extensions

    def _handle(self, event, is_delete: bool = False):
        if event.is_directory:
            return
        path = Path(event.src_path)
        if path.suffix.lower() not in self.extensions or _is_excluded(path):
            return
        if is_delete:
            _remove_file(self.collection, path, self.base_dir)
        else:
            # petite attente pour laisser l'éditeur finir d'écrire le fichier
            time.sleep(0.3)
            _index_file(self.collection, path, self.source_type, self.base_dir)

    def on_modified(self, event):
        self._handle(event)

    def on_created(self, event):
        self._handle(event)

    def on_deleted(self, event):
        self._handle(event, is_delete=True)


def start_watchers(collection) -> Observer:
    """Démarre la surveillance temps réel du dossier de documentation. Non bloquant."""
    observer = Observer()
    if os.path.isdir(settings.docs_path):
        observer.schedule(
            _ReindexHandler(collection, settings.docs_path, "doc", DOC_EXTENSIONS),
            settings.docs_path, recursive=True,
        )
    observer.start()
    print("[ingest] Surveillance temps réel active sur la documentation.")
    return observer