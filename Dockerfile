# ── Stage 1 : Build Node.js ───────────────────────────────────────────────────
FROM node:22-alpine AS node-builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2 : Runtime final (Debian slim — compatible Python 3.11 + Node) ─────
FROM node:22-slim AS runtime

WORKDIR /app

# Python 3.11, pip, outils de build, curl/wget pour healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# ── Dépendances Python ────────────────────────────────────────────────────────
# On installe torch SANS l'index PyTorch — la version standard PyPI supporte CPU.
# torch 2.3+ est disponible directement sur PyPI sans flit_core.
COPY ia/requirements.txt ./ia/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages \
    torch --extra-index-url https://pypi.org/simple/ \
    && pip3 install --no-cache-dir --break-system-packages -r ./ia/requirements.txt

# Pré-télécharge le modèle d'embedding (évite la dépendance réseau au runtime)
# Modèle léger et multilingue — 470MB, fonctionne sans GPU
RUN python3 -c "\
import os; os.environ['TRANSFORMERS_OFFLINE']='0'; \
from sentence_transformers import SentenceTransformer; \
SentenceTransformer('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'); \
print('Modèle embedding prêt.')"

# ── Dépendances Node.js runtime ───────────────────────────────────────────────
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── Code compilé et assets Node ───────────────────────────────────────────────
COPY --from=node-builder /app/dist ./dist
COPY public ./public
COPY scripts ./scripts

# ── Code source Python du service IA ─────────────────────────────────────────
COPY ia ./ia

# ── Credentials Firebase ──────────────────────────────────────────────────────
COPY convessa-b3ecd-firebase-adminsdk-fbsvc-f3a1d77bbf.json ./

RUN mkdir -p /app/sessions

EXPOSE 3005

CMD ["node", "dist/index.js"]
