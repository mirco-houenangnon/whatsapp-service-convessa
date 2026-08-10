FROM python:3.11-slim

WORKDIR /app

# curl : attend Ollama + pull du modèle au démarrage
# build-essential : requis pour chromadb
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Installation de toutes les dépendances (~50 MB au lieu de ~700 MB avec torch).
# optimum[onnxruntime] convertit intfloat/multilingual-e5-base en ONNX à la
# première exécution puis met le résultat en cache dans le volume hf_cache,
# donc les redémarrages suivants sont instantanés.
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Correction des fins de ligne Windows (CRLF → LF) et permissions d'exécution.
# Sans ça, si entrypoint.sh a des CRLF (édition sous Windows), Linux
# ne trouve pas le shebang et lève "no such file or directory".
RUN sed -i 's/\r$//' entrypoint.sh && chmod +x entrypoint.sh

EXPOSE 8100

ENTRYPOINT ["./entrypoint.sh"]