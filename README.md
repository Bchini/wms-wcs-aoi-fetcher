# wms-wcs-aoi-fetcher

Download a raster layer from a WMS or WCS service, clipped to an AOI, as a
single GeoTIFF — without manually clicking through a web portal tile by tile.

## Live Cloudflare interface

**[Open the AOI Raster Fetcher](https://wms-wcs-aoi-fetcher.adel-bchini.workers.dev/)**

Paste a WMS or WCS URL and press **DETECT**. That's the whole interface —
everything else is detected automatically:

- **Service and version** — from a `SERVICE=`/`VERSION=` parameter if the URL
  has one, else guessed from the path (`.../wms`, `.../wcs`), else found by
  probing GetCapabilities for each in turn.
- **Layer** — from `LAYERS=`/`COVERAGE=`/etc. if given, else the first
  georeferenced layer the service advertises.
- **CRS** — from `CRS=`/`SRS=` if given, else `EPSG:4326`.
- **Area** — a full GetMap/GetCoverage URL's `BBOX` is used exactly as given,
  so pasting a request you copied out of a browser's network tab clips
  precisely that view. A bare endpoint or GetCapabilities link instead fetches
  the layer's full advertised extent.

DETECT shows the detected service/layer/CRS and a **resolution dropdown**
(Preview/Standard/High/Maximum) sized off that specific area — a full-country
extent and a small neighborhood get very different pixel-dimension options,
each capped so it stays within the 25-million-pixel budget and, for WMS,
within 64 tiles. Pick one and press **DOWNLOAD GEOTIFF**.

**The actual clip/mosaic/reproject runs entirely in your browser**, via
[gdal3.js](https://github.com/bugra9/gdal3.js) (real GDAL compiled to
WebAssembly) — the Cloudflare Worker only resolves the URL (`/api/resolve`)
and proxies the raw WMS/WCS bytes past the source server's CORS policy
(`/api/proxy`); it never touches the raster itself. That's deliberate: it
keeps the whole app on Cloudflare's **free** Workers plan (Cloudflare
Containers, which the previous server-side-GDAL version of this app used,
requires the paid plan). The progress bar reflects real tiles fetched/warped,
not a fake timer. Error reports are saved in the app's Cloudflare D1
database. Every request is capped at 25 million output pixels.

Because GDAL now runs client-side, **WMTS isn't supported** (its tile-matrix
math isn't implemented in the browser runner, and `fetch.py` never supported
it either) — use a WMS/WCS endpoint if the server offers one.

Grew out of fetching a 1m DSM from a Brazilian state WMS/WCS server for one
small area of interest, where downloading the whole state was never an
option.

## Why WCS vs WMS matters

- **WCS** (`--service wcs`) returns the *native pixel values* of a coverage
  (e.g. `Float32` elevation). Use it whenever you need real numbers —
  altitude, slope, hillshade, statistics.
- **WMS** (`--service wms`) returns a *rendered image* (RGB/PNG) of the
  layer, tiled and mosaicked here since WMS servers cap request size. Fine
  for a visual basemap or preview, but the pixel values are colors, not
  elevation — don't run terrain analysis on a WMS mosaic.

If a server exposes both, prefer WCS for anything you intend to compute on.

## CLI vs. the web app

The URL auto-detection above is a feature of the web app's Worker
(`src/resolve.mjs`, `interpretUrl()`), not of `fetch.py` itself — the CLI
below still takes explicit `--service`/`--layer`/`--crs`/`--aoi` flags, since
it has no notion of "the URL you pasted," only the fields you pass it. The two
are otherwise independent: the CLI runs local GDAL binaries over a real AOI
file, the web app runs gdal3.js (WASM) in the browser over a BBOX.

## Web app architecture

```
web/index.html, app.js   →  UI + orchestration
web/ogc.js                  →  BBOX/tile-grid math shared with fetch.py's logic
web/gdal-runner.js           →  loads gdal3.js, runs gdalwarp/gdal_translate
src/worker.mjs               →  routes /api/*, serves static assets
src/resolve.mjs, xml.mjs     →  interpret the pasted URL (no GDAL needed)
```

1. The browser POSTs the pasted URL to `/api/resolve`. The Worker fetches and
   parses GetCapabilities (`fast-xml-parser`) if needed and returns the
   resolved service/layer/CRS/bounds/resolution — no raster bytes involved.
2. For **WCS**, the browser fetches the single GetCoverage response through
   `/api/proxy` and runs one `gdalwarp -te ... -tr ... -t_srs ...` in WASM.
3. For **WMS**, the browser fetches each GetMap tile through `/api/proxy`,
   georeferences it (`gdal_translate -a_srs -a_ullr`), and warps it onto the
   *same* full-extent grid with `-dstalpha` (transparent outside that tile's
   own footprint). gdal3.js's `gdalwarp` takes exactly one source dataset —
   verified empirically, it has no `gdalbuildvrt` and a second call to the
   same destination replaces rather than merges — so the tiles are instead
   composited on a `<canvas>` (transparent pixels don't overwrite pixels an
   earlier tile already drew) and the composite is re-georeferenced with one
   more `gdal_translate -a_srs -a_ullr` call.
4. `/api/proxy` exists only because most government WMS/WCS servers don't
   send CORS headers; it does not process anything, just relays bytes past
   the browser's cross-origin restrictions (same-origin `Sec-Fetch-Site`
   checked, private/loopback hosts rejected, 80 MB cap, 60 s timeout).

## Requirements

- Python 3.9+
- GDAL command-line tools (`ogrinfo`, `gdal_translate`, `gdalbuildvrt`,
  `gdalwarp`) on `PATH`, or pass `--gdal-bin` pointing at the directory
  containing them (e.g. a QGIS install's `bin` folder on Windows).
- `pip install -r requirements.txt`

## Usage

AOI must already be reprojected to the CRS you're querying with — reproject
first with `ogr2ogr -t_srs EPSG:XXXX` if needed. WCS support is explicitly
limited to the proven WCS 1.0.0 GetCoverage request. WMS supports 1.1.1 and
1.3.0; EPSG:4326 axis order is handled correctly for 1.3.0.

**WCS (native values):**

```bash
python fetch.py --service wcs \
  --url https://example.gov/sigserver/wcs \
  --layer NAMESPACE:LAYER-NAME \
  --aoi aoi.gpkg \
  --crs EPSG:31982 \
  --resolution 1 \
  --out dsm_native.tif
```

**WMS (rendered mosaic):**

```bash
python fetch.py --service wms \
  --url https://example.gov/sigserver/wms \
  --layer NAMESPACE:LAYER-NAME \
  --aoi aoi.gpkg \
  --crs EPSG:31982 \
  --resolution 1 \
  --tile-size 1024 1024 \
  --out dsm_wms_rgb.tif
```

## Working around a geo-blocked server

Some government WMS/WCS servers reject requests from cloud/foreign IP
ranges outright (connection refused or timeout on both HTTP and HTTPS,
while a normal browser on a local ISP connection works fine). If that's
the case for you:

- `--relay microlink` routes **WMS** `GetMap` requests through a
  screenshot API instead of fetching the URL directly — it renders the URL
  in a real browser and returns the resulting image. This only works for
  image tiles (WMS), never for WCS: a screenshot relay re-encodes the
  response as an image, which would silently corrupt raw elevation values.
- For a blocked **WCS** request, there's no safe generic relay — you need
  a proxy that forwards raw bytes unmodified. Point `--url` at that proxy
  if you have one.

## Safety limits

- `--max-tiles` (default 4096) refuses a WMS job before it starts if the AOI,
  resolution and tile size would need more GetMap requests than that — catches
  a mistaken CRS or resolution before it hammers the server for hours.
- `--cleanup` deletes the intermediates (`_RAW.tif`, `_MOSAIC.tif`, `.vrt`,
  the WMS tile cache) once the final clipped output exists. Leave it off to
  keep the WMS tile cache for a resumable re-run.
- A failed run exits with status 1 and a one-line `error: ...` message on
  stderr instead of a Python traceback.

## Output

- `<out>`: final clipped GeoTIFF.
- `<output-name>_tiles/`: (WMS mode) individual downloaded/georeferenced tiles, kept so a
  re-run resumes instead of re-downloading everything, unless `--cleanup` is passed.
- `<out>.vrt`, `<out>_MOSAIC.tif` / `<out>_RAW.tif`: intermediate files, safe
  to delete once you have the final clipped output (or pass `--cleanup`).

## License

MIT — see [LICENSE](LICENSE).
