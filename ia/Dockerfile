FROM python:3.11-slim

WORKDIR /app

# curl : attend Ollama + pull du modèle au démarrage
# build-essential : requis pour chromadb
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# CORRECTIF CACHE : torch installé AVANT de copier requirements.txt.
# Cette couche ne dépend d'aucun fichier du projet (juste de cette ligne de
# commande elle-même) — un futur changement de requirements.txt, même sans
# rapport avec torch (ex: bump de version de fastapi), ne la réinvalidera
# donc plus. Avant ce correctif, l'installation CPU-only de torch (~700 Mo,
# déjà un gain vs les ~1.5 Go de la version CUDA) était réinstallée à chaque
# fois que requirements.txt changeait, quelle qu'en soit la raison.
RUN pip install --no-cache-dir \
    torch==2.2.2 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .

# Installe le reste des dépendances. pip voit que torch==2.2.2 est déjà
# satisfait (installé juste avant) et ne le retélécharge pas, même si
# sentence-transformers le liste dans ses propres dépendances.
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN chmod +x entrypoint.sh

EXPOSE 8100

ENTRYPOINT ["./entrypoint.sh"]