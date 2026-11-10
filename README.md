# Railatlas

Live positions, delays, and station-by-station journeys for trains on the Slovak network, drawn on a 3D map.

The curved rail lines are OpenStreetMap railway geometry (ODbL). The muted basemap is a Railatlas MapLibre style on OpenFreeMap (OSM / OpenMapTiles) plus public Mapzen terrain tiles — not SBB/geOps Trafimage.

Train positions and the journey list come from the public `gtall` and `TrainDetail` calls that mapa.zsr.sk already makes in the browser. That feed is not open data and is not relicensed here.

## License

The website source is under the MIT License. See `LICENSE`.

The bundled Geist typeface stays under the SIL Open Font License 1.1, with reserved font name “Geist”. The full text is in `src/fonts/OFL.txt`.

Railway geometry is © OpenStreetMap contributors, available under the Open Database License. The geographic basemap is © OpenFreeMap © OpenMapTiles © OpenStreetMap contributors, with terrain from AWS/Mapzen tiles.

## Develop

```bash
npm install
npm run proxy
npm run dev
```

The dev server forwards `/proxy` to the Node proxy on port 3001. That proxy replaces the old PHP script and keeps the same responses: `gtall`, OSM tiles, and the station list (`mode=detail`).

## Deploy on Coolify

Build pack: **Dockerfile** at the repository root. Port **80**.

If the Coolify resource is a **Docker Compose** app instead, use the repo `docker-compose.yml`. The website image is built from `deploy/Dockerfile.website` (frontend + nginx config copied in). Do not bind-mount `deploy/nginx.conf` from the host. If a previous deploy created `/data/coolify/applications/<uuid>/deploy/nginx.conf` as a **directory**, delete that path on the server before redeploying.

Mount a persistent volume at `/data` so the train cache and the railway-vector cache survive a rebuild.

| Variable | Value in the image |
| --- | --- |
| `PROXY_PORT` | `80` |
| `STATIC_ROOT` | `/app/dist` |
| `OSM_CACHE_DIR` | `/data/osm-cache` |
| `PROXY_CACHE_FILE` | `/data/cache.json` |
| `PROXY_LOG_FILE` | `/data/proxy.log` |
| `MAPTILER_KEY` | MapTiler Cloud key for rail-vector extraction (not required for the basemap) |

Set `MAPTILER_KEY` in Coolify so railway geometry can be built from MapTiler extracts. The basemap itself uses OpenFreeMap and does not need that key. After the first visit the tiles are kept on disk.

Check:

- `/` loads the map
- `/proxy` returns JSON with `"source": "proxy"`
- `/proxy?mode=detail&train=241` returns a `stops` array

Point the Coolify domain at this application as **`railatlas.eu`** (no www). Also attach **`www.railatlas.eu`** to the same service so the app can 301 it to the apex host. Force HTTPS in Coolify. On Wedos, a specific A record has to override the old wildcard, the same way the other studio sites do.

After deploy, submit `https://railatlas.eu/sitemap.xml` in Search Console. The file is a real XML document; `/index.html`, `http://`, and `www` 301 to `https://railatlas.eu/`.
