# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copier les sources et compiler
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# wget pour le healthcheck docker-compose
RUN apk add --no-cache wget

# Dépendances runtime uniquement (pas les devDependencies)
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copier le build compilé
COPY --from=builder /app/dist ./dist

# Copier les assets statiques (dashboard admin)
COPY public ./public

# Copier les scripts utilitaires
COPY scripts ./scripts

# Copier les credentials Firebase (si présents)
COPY whatsappservice-50e51-firebase-adminsdk-fbsvc-d35a2c107b.json ./

# Le .env est monté via docker-compose (volume ou env_file)
# Ne pas copier .env dans l'image !

EXPOSE 3005

CMD ["node", "dist/index.js"]
