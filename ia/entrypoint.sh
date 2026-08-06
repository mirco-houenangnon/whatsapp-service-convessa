#!/bin/sh
# entrypoint.sh — Attend qu'Ollama soit prêt, tire le modèle si absent,
# puis démarre le service IA FastAPI.
# Lancé automatiquement au premier "docker compose up -d --build".

set -e

OLLAMA_HOST="${OLLAMA_HOST:-http://ollama:11434}"
MODEL="${OLLAMA_MODEL:-qwen2.5:7b}"

echo "[entrypoint] Attente d'Ollama sur ${OLLAMA_HOST} ..."

# Attendre qu'Ollama réponde — max 3 minutes (180s / 3s = 60 tentatives)
i=0
until curl -sf "${OLLAMA_HOST}/api/tags" > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[entrypoint] ⚠️  Ollama ne répond pas après 3 min — démarrage quand même"
    break
  fi
  sleep 3
done

echo "[entrypoint] Ollama répond."

# Vérifier si le modèle est déjà présent dans le volume Ollama
if curl -sf "${OLLAMA_HOST}/api/tags" | grep -q "\"${MODEL}\""; then
  echo "[entrypoint] ✅ Modèle ${MODEL} déjà présent — pas de téléchargement."
else
  echo "[entrypoint] ⬇️  Téléchargement du modèle ${MODEL} (première fois, peut prendre plusieurs minutes)..."
  curl -sf -X POST "${OLLAMA_HOST}/api/pull" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${MODEL}\"}" \
    --no-buffer -o /dev/null
  echo "[entrypoint] ✅ Modèle ${MODEL} téléchargé."
fi

echo "[entrypoint] Démarrage du service IA (port 8100)..."
exec uvicorn main:app --host 0.0.0.0 --port 8100 --log-level warning
