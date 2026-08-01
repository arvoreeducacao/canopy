FROM node:20-bookworm-slim

# Chromium from Debian works on both amd64 and arm64 — Chrome for Testing is x64-only.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY bin ./bin
COPY src ./src
COPY cockpit ./cockpit
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x docker/entrypoint.sh

ENV CANOPY_BIND=0.0.0.0 \
    CANOPY_DATA_DIR=/data \
    CANOPY_CDP_PORT=9222 \
    CHROME_BIN=/usr/bin/chromium

RUN useradd -m canopy && mkdir -p /data && chown canopy:canopy /data
USER canopy
VOLUME /data
EXPOSE 4664

ENTRYPOINT ["dumb-init", "--", "/app/docker/entrypoint.sh"]
