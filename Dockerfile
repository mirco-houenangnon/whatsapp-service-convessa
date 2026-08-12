# ── Stage 1 : Build Node.js ───────────────────────────────────────────────────
FROM node:22-alpine AS node-builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2 : Runtime final (Debian slim — compatible Python 3.11 + Node) ─────
# On utilise node:22-slim (Debian) et non Alpine pour que les wheels Python
# compilés (torch, chromadb) fonctionnent sans recompilation.
FROM node:22-slim AS runtime

WORKDIR /app

# Python 3.11, pip, outils de build pour chromadb, curl/wget pour healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# ── Dépendances Python ────────────────────────────────────────────────────────
# torch CPU en premier — couche stable, ne se réinstalle pas si requirements.txt
# change pour une autre raison.
RUN pip3 install --no-cache-dir --break-system-packages \
    torch==2.2.2 --index-url https://download.pytorch.org/whl/cpu

COPY ia/requirements.txt ./ia/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r ./ia/requirements.txt

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
COPY whatsappservice-50e51-firebase-adminsdk-fbsvc-d35a2c107b.json ./

RUN mkdir -p /app/sessions

EXPOSE 3005

CMD ["node", "dist/index.js"]
