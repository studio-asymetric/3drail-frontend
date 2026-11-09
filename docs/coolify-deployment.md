# Coolify deployment (Hetzner)

Use the **Dockerfile** at the repository root. It builds the Vite app and serves it, together with the Node proxy, on port 80. Mount `/data` so the caches persist. The steps are in the root `README.md`.

The notes below describe an older two-container compose layout. Prefer the Dockerfile.

The frontend is a static Vite build, but it depends on a **server-side proxy** at `/proxy` for:

- Live train data from `mapa.zsr.sk` (`/proxy`)
- OSM railway tiles via Overpass (`/proxy?mode=osm&...`)

Plain `nginx:alpine` serving only `dist/` cannot run this — the old Wedos host used PHP (`proxy/index.php`). On Coolify we run a small **Node.js proxy** alongside nginx.

## Architecture

```text
Browser
   │
   ▼
Coolify Proxy (Traefik, TLS)
   │
   ▼
nginx:alpine  ── /proxy ──►  node proxy (port 3001)
   │                              │
   │                              ├── mapa.zsr.sk (gtall)
   │                              └── overpass-api.de (OSM)
   │
   └── /  →  dist/ (static Vite build)
```

## Quick setup in Coolify

1. **Build locally**
   ```bash
   npm run build
   ```

2. **Create a Compose Service** in Coolify (not a Nixpacks static app).

3. **Point Coolify at this repo** (or upload `docker-compose.yml` + `dist/`).

4. **Use the included compose file** (`docker-compose.yml`):
   - `website` — nginx serving `dist/`
   - `proxy` — Node.js API proxy with persistent cache volume

5. **Assign your domain** in Coolify (e.g. `railmap.example.com`) to the `website` service port 80.

6. **Verify**
   - Site loads: `https://your-domain/`
   - Proxy health: `https://your-domain/proxy` → JSON with `source: "proxy"`
   - OSM tiles: `https://your-domain/proxy?mode=osm&minLat=48&maxLat=49&minLng=17&maxLng=18&level=coarse` → JSON with `elements`

## Alternative: SFTP + bind mounts (portfolio-style)

If you prefer uploading files like the asymetric.studio setup:

1. Upload `dist/` contents to `/var/www/3drail/` on the server.
2. Upload `deploy/nginx.conf` to `/var/www/3drail-nginx.conf`.
3. Run the proxy container separately and reference it in nginx:

```yaml
services:
  website:
    image: nginx:alpine
    volumes:
      - /var/www/3drail:/usr/share/nginx/html:ro
      - /var/www/3drail-nginx.conf:/etc/nginx/conf.d/default.conf:ro
    ports:
      - '80'
    depends_on:
      - proxy

  proxy:
    image: your-registry/3drail-proxy:latest
    volumes:
      - /var/www/3drail-proxy-data:/app
    restart: unless-stopped
```

Build and push the proxy image from this repo:

```bash
docker build -f deploy/Dockerfile.proxy -t 3drail-proxy .
```

The nginx config must include the `/proxy` location block from `deploy/nginx.conf`.

## Local development

Run both processes:

```bash
npm run proxy   # starts Node proxy on :3001
npm run dev     # Vite dev server proxies /proxy → :3001
```

PHP proxy (`php -S ... index.php`) still works for local use but is no longer required for deployment.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Failed to fetch OSM rail data: NetworkError` | `/proxy` not routed to Node proxy | Add nginx `location /proxy` block; ensure proxy container is running |
| `/proxy` returns 404 HTML | nginx serving static files only | Use `deploy/nginx.conf`, not default nginx config |
| `/proxy` returns 502 | proxy container down or wrong hostname | Check `docker compose ps`; nginx must reach `http://proxy:3001` |
| Live trains empty | mapa.zsr.sk cookies/upstream issue | Check proxy logs at `/app/proxy.log` in proxy container |
| OSM tiles slow first load | Cold cache, fetching from Overpass | Normal; simplified tiles cache for 30 days in the proxy volume |

## Files

| File | Purpose |
|------|---------|
| `proxy/server.mjs` | Node.js proxy (replaces PHP for production) |
| `deploy/nginx.conf` | nginx with SPA fallback + `/proxy` routing |
| `deploy/Dockerfile.proxy` | Proxy container image |
| `docker-compose.yml` | Coolify-ready compose stack |
