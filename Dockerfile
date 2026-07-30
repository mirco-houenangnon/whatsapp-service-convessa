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

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:3005/api/v1/status').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
