# Railatlas — Vite build and the train proxy, one container (Coolify)
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY proxy/server.mjs proxy/trainDetail.mjs ./proxy/

RUN mkdir -p /data/osm-cache

ENV PROXY_PORT=80 \
    STATIC_ROOT=/app/dist \
    OSM_CACHE_DIR=/data/osm-cache \
    PROXY_CACHE_FILE=/data/cache.json \
    PROXY_LOG_FILE=/data/proxy.log \
    NODE_ENV=production

EXPOSE 80

CMD ["node", "proxy/server.mjs"]
