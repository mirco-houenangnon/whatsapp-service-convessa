#!/bin/sh
# entrypoint.sh â€” Attend qu'Ollama soit prÃªt, tire le modÃ¨le si absent,
# puis dÃ©marre le service IA FastAPI.
# LancÃ© automatiquement au premier "docker compose up -d --build".

set -e

OLLAMA_HOST="${OLLAMA_HOST:-http://ollama:11434}"
MODEL="${OLLAMA_MODEL:-qwen2.5:7b}"

echo "[entrypoint] Attente d'Ollama sur ${OLLAMA_HOST} ..."

# Attendre qu'Ollama rÃ©ponde â€” max 3 minutes (180s / 3s = 60 tentatives)
i=0
until curl -sf "${OLLAMA_HOST}/api/tags" > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[entrypoint] âš ï¸  Ollama ne rÃ©pond pas aprÃ¨s 3 min â€” dÃ©marrage quand mÃªme"
    break
  fi
  sleep 3
done

echo "[entrypoint] Ollama rÃ©pond."

# VÃ©rifier si le modÃ¨le est dÃ©jÃ  prÃ©sent dans le volume Ollama
if curl -sf "${OLLAMA_HOST}/api/tags" | grep -q "\"${MODEL}\""; then
  echo "[entrypoint] âœ… ModÃ¨le ${MODEL} dÃ©jÃ  prÃ©sent â€” pas de tÃ©lÃ©chargement."
else
  echo "[entrypoint] â¬‡ï¸  TÃ©lÃ©chargement du modÃ¨le ${MODEL} (premiÃ¨re fois, peut prendre plusieurs minutes)..."
  curl -sf -X POST "${OLLAMA_HOST}/api/pull" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${MODEL}\"}" \
    --no-buffer -o /dev/null
  echo "[entrypoint] âœ… ModÃ¨le ${MODEL} tÃ©lÃ©chargÃ©."
fi

echo "[entrypoint] DÃ©marrage du service IA (port 8100)..."
exec uvicorn main:app --host 0.0.0.0 --port 8100 --log-level warning
