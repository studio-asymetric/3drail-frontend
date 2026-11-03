# Coolify compose for railatlas.eu (SFTP + bind mounts)

Upload these to the server before deploying:

```text
/var/www/railatlas.eu/              ← dist/ contents (index.html, assets/, …)
/var/www/railatlas-proxy/server.mjs ← from repo proxy/server.mjs
/var/www/railatlas-proxy/osm-cache/ ← from repo proxy/osm-cache/ (optional warm cache)
/var/www/railatlas-nginx.conf       ← from repo deploy/railatlas-nginx.conf
```

## docker-compose.yml (paste into Coolify)

```yaml
services:
  demo:
    image: 'nginx:alpine'
    depends_on:
      - proxy
    volumes:
      - '/var/www/railatlas.eu:/usr/share/nginx/html:ro'
      - '/var/www/railatlas-nginx.conf:/etc/nginx/conf.d/default.conf:ro'
    ports:
      - '80'
    restart: unless-stopped

  proxy:
    image: 'node:22-alpine'
    working_dir: /app
    command: ['node', 'server.mjs']
    volumes:
      - '/var/www/railatlas-proxy:/app'
    environment:
      PROXY_PORT: 3001
      OSM_CACHE_DIR: /app/osm-cache
      PROXY_CACHE_FILE: /app/cache.json
      PROXY_LOG_FILE: /app/proxy.log
    restart: unless-stopped
```

> Do **not** reuse `default-config-asymetric-nginx.conf` — it has no `/proxy` route.

## Verify

```bash
curl -s https://railatlas.eu/proxy | head -c 200
curl -s "https://railatlas.eu/proxy?mode=osm&minLat=47.73&maxLat=48.73&minLng=16.83&maxLng=17.83&level=coarse" | head -c 200
```

Both should return JSON, not HTML or 404.

## Frontend deploy (unchanged)

```bash
npm run build
```

Upload **contents** of `dist/` into `/var/www/railatlas.eu/` (flat, not nested).
