# Railatlas

Live positions, delays, and station-by-station journeys for trains on the Slovak network, drawn on a 3D map.

The curved rail lines are OpenStreetMap railway geometry. That is the same vector data the geographic base map on [mapa.zsr.sk](https://mapa.zsr.sk) styles (MapTiler style “ZSR”, layer `transportation`, classes `rail` and `transit`). This site requests those ways from OpenStreetMap and draws them as strokes, so it does not use the MapTiler key or the raster tiles from that site.

Train positions and the journey list come from the public `gtall` and `TrainDetail` calls that mapa.zsr.sk already makes in the browser. That feed is not open data and is not relicensed here.

## License

The website source is under the MIT License. See `LICENSE`.

The bundled Geist typeface stays under the SIL Open Font License 1.1, with reserved font name “Geist”. The full text is in `src/fonts/OFL.txt`.

Railway geometry is © OpenStreetMap contributors, available under the Open Database License.

## Develop

```bash
npm install
npm run proxy
npm run dev
```

The dev server forwards `/proxy` to the Node proxy on port 3001. That proxy replaces the old PHP script and keeps the same responses: `gtall`, OSM tiles, and the station list (`mode=detail`).

## Deploy on Coolify

Build pack: **Dockerfile** at the repository root. Port **80**.

Mount a persistent volume at `/data` so the train cache and the railway-vector cache survive a rebuild.

| Variable | Value in the image |
| --- | --- |
| `PROXY_PORT` | `80` |
| `STATIC_ROOT` | `/app/dist` |
| `OSM_CACHE_DIR` | `/data/osm-cache` |
| `PROXY_CACHE_FILE` | `/data/cache.json` |
| `PROXY_LOG_FILE` | `/data/proxy.log` |
| `MAPTILER_KEY` | key for the same vector tiles as the geographic map on mapa.zsr.sk |

Set `MAPTILER_KEY` in Coolify. Without it the railway tiles fall back to Overpass. After the first visit the tiles are kept for 30 days.

Check:

- `/` loads the map
- `/proxy` returns JSON with `"source": "proxy"`
- `/proxy?mode=detail&train=241` returns a `stops` array

Point the Coolify domain at this application. On Wedos, a specific A record has to override the old wildcard, the same way the other studio sites do.
