# Railatlas — Vite build and the train proxy, one container (Coolify)
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# The public address (canonical link, sitemap, social cards); Coolify can override it.
ARG VITE_SITE_URL=https://mojvlak.sk
ENV VITE_SITE_URL=$VITE_SITE_URL
RUN npm run build

FROM node:22-alpine

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY proxy/*.mjs ./proxy/
COPY proxy/regions/*.mjs ./proxy/regions/
RUN npm install --omit=dev pbf @mapbox/vector-tile

RUN mkdir -p /data/osm-cache

ENV PROXY_PORT=80 \
    STATIC_ROOT=/app/dist \
    OSM_CACHE_DIR=/data/osm-cache \
    REGION_DATA_DIR=/data/region/pid \
    JMK_DATA_DIR=/data/region/jmk \
    PROXY_CACHE_FILE=/data/cache.json \
    PROXY_LOG_FILE=/data/proxy.log \
    NODE_ENV=production

EXPOSE 80

CMD ["node", "proxy/server.mjs"]
