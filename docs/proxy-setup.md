# PHP proxy setup for live `gtall` data

This service impersonates the mapa.zsr.sk browser client so our frontend can access the `gtall` feed even when the upstream endpoint requires the same cookies that the official site sets.

## Running the proxy locally

1. Install PHP if you haven’t already (PHP 8+ recommended).
2. Optionally seed `proxy/config.php` with cookies, but the script now refreshes them automatically via `/index.aspx`.
3. Start the built-in PHP server from the repo root:

   ```
   php -S 127.0.0.1:9000 -t proxy
   ```

   That exposes `http://127.0.0.1:9000/index.php`, and our Vite proxy rewrites `/proxy` to it.
4. The PHP script caches the last successful `gtall` response, polls the upstream API every 30 seconds while clients are active, and stops after 120 seconds of inactivity.

## Frontend integration

- `App.tsx` exposes **Use proxy live API (server handles cookies)** so the app can switch between the cached feed and the static mirror.
- `TrainService` records `hypothesisId=TS2` to show whether the proxy was used.
- The dev server proxies `/proxy` to `http://127.0.0.1:9000`, so run `npm run dev` and the PHP server together during development.
- Railway tiles now come through `/proxy?mode=osm&minLat=...`. The proxy simplifies each tile (every fourth point, joined ends) once, caches that geometry in `proxy/osm-cache` for 30 days, and only hits Overpass when the cache is missing or older than that.

## Deploying to Wedos (or any static+PHP host)

1. Run `npm run build`. The build step copies `proxy/` into `dist/proxy`, so upload the entire `dist/` directory to your host.
2. Ensure `dist/proxy` keeps its cache/log directories writable, and make sure your host allows outbound HTTPS requests (the proxy already accepts the remote certificate).
3. Point the frontend at the hosted `/proxy` path. The status line in the app will confirm the proxy is serving live data, and `/proxy?mode=osm` serves cached Overpass tiles for the frontend’s tile loader.

## Deploying to Coolify (Hetzner)

Plain `nginx:alpine` serving only `dist/` **will not work** — nginx cannot execute PHP.

Use the Node.js proxy + nginx compose stack instead. See [coolify-deployment.md](./coolify-deployment.md).

## Logging

The PHP proxy logs activity to `proxy/proxy.log`. Each line records the timestamp, success/failure, and any curl errors. The frontend keeps emitting T1/T2/T4 logs for tile loads and TS2 for proxy usage.

## Troubleshooting

- If `/proxy` returns `status: "error"`, inspect `proxy/proxy.log`.
- If `/proxy?mode=osm` fails, confirm `proxy/osm-cache` is writable; the endpoint will fall back to the last cached tile when Overpass is unreachable.
- The proxy refreshes cookies automatically, but you can still edit `proxy/config.php` manually if you ever need to seed values.
# PHP proxy setup for live `gtall` data

This service impersonates the mapa.zsr.sk browser client so our frontend can access the `gtall` feed even when the upstream endpoint requires the same cookies that the official site sets.

## Running the proxy

1. Install PHP if you haven’t already (PHP 8+ recommended).
2. Update `proxy/config.php` with the cookies you copied from the browser (set the `cookies` string to `MapaZsr_TechnicalCookieName=1; ASP.NET_SessionId=...; AVI_COOKIE=...`). The proxy now refreshes them automatically by loading `/index.aspx` before each fetch, so once set it will keep them valid.
3. Start the built-in PHP server from the repo root:

   ```
   php -S 127.0.0.1:9000 -t proxy
   ```

   That exposes `http://127.0.0.1:9000/index.php`, and our Vite proxy will rewrite `/proxy` to it.

4. The PHP script keeps a cached copy of the last successful `gtall` response. It polls every 60 seconds while at least one frontend client calls `/proxy`. If no client calls it for 120 seconds, polling stops until the next ping.

## Frontend integration

- `App.tsx` now exposes a checkbox labeled **Use proxy live API (server handles cookies)**. When enabled, the app hits `/proxy` instead of `/api/action`.
- The `TrainService` config uses `useProxy`/`proxyUrl` so we can switch sources dynamically, and the logging entry `hypothesisId=TS2` records whether the proxy or direct API was used.
- The Vite server proxies `/proxy` to `http://127.0.0.1:9000`. You can run both Vite (`pnpm dev`) and the PHP server simultaneously.

## Logging

The PHP proxy logs its activity to `proxy/proxy.log`. Each line records the timestamp, whether the fetch succeeded, and any curl error. The frontend continues to log tile fetch (T1/T2/T4) and adds `TS2` entries when it requests `gtall` via the proxy.

## Troubleshooting

- If the proxy returns an error (`status: "error"` in the JSON), check `proxy/proxy.log`.
- Ensure the cookie string in `proxy/config.php` is current; you might need to refresh it from the browser devtools every so often.

