FROM python:3.11-slim

WORKDIR /app

# curl : attend Ollama + pull du modèle au démarrage
# build-essential : requis pour chromadb
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Installer PyTorch CPU-only en premier pour éviter le download des libs CUDA (~1.5 Go)
RUN pip install --no-cache-dir \
    torch==2.2.2 --index-url https://download.pytorch.org/whl/cpu

# Installer le reste des dépendances
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN chmod +x entrypoint.sh

EXPOSE 8100

ENTRYPOINT ["./entrypoint.sh"]