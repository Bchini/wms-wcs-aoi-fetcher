# wms-wcs-aoi-fetcher

[![CI](https://github.com/Bchini/wms-wcs-aoi-fetcher/actions/workflows/ci.yml/badge.svg)](https://github.com/Bchini/wms-wcs-aoi-fetcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Download a raster layer from a WMS or WCS service, clip it to an AOI, and export the result as a single GeoTIFF without manually clicking through a web portal tile by tile.

This project was built for cases where a full national or regional raster is too large to download, but a small area of interest still needs to be extracted cleanly and reproducibly.

## Project overview

The repository includes two complementary execution paths:

- a local CLI built in Python with GDAL (`fetch.py`), for direct command-line use in a desktop or server environment,
- a browser-based web app running in Cloudflare Workers, powered by `gdal3.js` in WebAssembly, for lighter infrastructure and no dedicated GDAL server.

Both paths follow the same overall workflow:

1. identify the OGC service and layer,
2. detect or infer the CRS and bounds,
3. compute an appropriate output resolution,
4. fetch the raster data,
5. clip it against the AOI,
6. export a final GeoTIFF.

## Live Cloudflare interface

Open the app here:

**[AOI Raster Fetcher](https://wms-wcs-aoi-fetcher.adel-bchini.workers.dev/)**

Paste a WMS or WCS URL and press **DETECT**. The interface tries to infer everything automatically:

- service and version from `SERVICE=` / `VERSION=` parameters, or by guessing from the endpoint path,
- layer from `LAYERS=` / `COVERAGE=` / other OGC identifiers,
- CRS from `CRS=` / `SRS=` or defaulting to `EPSG:4326`,
- extent from a literal `BBOX` or from the service's advertised capabilities.

The app then proposes resolution presets sized for the actual area selected, keeping the request under the configured pixel and tile budgets.

## Why WCS vs WMS matters

- **WCS** (`--service wcs`) returns the native pixel values of a coverage (for example `Float32` elevation data). It is the correct choice whenever you want to compute on the data itself.
- **WMS** (`--service wms`) returns a rendered image, usually tile-based and mosaicked after the fact. It is useful for map previews or visual basemaps, but pixel values are colors and not raw terrain values.

If a server exposes both protocols, prefer WCS for quantitative analysis.

## Features

- WMS and WCS support,
- AOI clipping from any GDAL/OGR-readable vector dataset,
- WMS tiling and mosaicking,
- WCS single GetCoverage fetch for native values,
- browser-side processing with gdal3.js,
- protected pixel budgets and tile caps,
- clean error handling and resumable WMS tile caches,
- automatic detection of OGC service metadata.

## CLI vs web app

The auto-detection logic is part of the web worker (`src/resolve.mjs` and related files), not of the Python CLI itself. The CLI still expects explicit values like `--service`, `--layer`, `--crs`, and `--aoi` because it works from concrete inputs rather than a pasted URL.

The two flows are otherwise independent:

- CLI: local GDAL binaries over a real AOI file,
- web app: browser-side GDAL via WebAssembly over a BBOX.

## Web app architecture

```text
web/index.html, app.js        → UI + orchestration
web/ogc.js                   → BBOX / tile-grid logic shared with the CLI
web/gdal-runner.js            → loads gdal3.js and runs GDAL operations
src/worker.mjs                → routes /api/* and serves static assets
src/resolve.mjs, xml.mjs      → detect and interpret pasted URLs
```

1. The browser POSTs the pasted URL to `/api/resolve`.
2. The worker fetches and parses the relevant OGC capabilities when needed.
3. For WCS, the browser fetches the GetCoverage response through `/api/proxy` and clips it in-browser.
4. For WMS, the browser downloads tiles through `/api/proxy`, georeferences them, and mosaics them before the final clip.
5. `/api/proxy` is used to relay raw bytes past the source server's CORS restrictions;
   it does not process the raster itself.

## Feedback notifications

The feedback form writes to the `feedback` D1 table (`migrations/`). After the first deployment, apply the migration once with:

```bash
npx wrangler d1 migrations apply wms-wcs-aoi-feedback --remote
```

Without that migration, `/api/feedback` will fail with a 503 and no row will be stored. Email notifications are optional and require:

- `NOTIFY_EMAIL` as a plain variable in `wrangler.jsonc`,
- `RESEND_API_KEY` as a Cloudflare secret:

```bash
npx wrangler secret put RESEND_API_KEY
```

If no secret is configured, the D1 row is still saved but no email is sent.

## Requirements

- Python 3.9+
- GDAL command-line tools (`ogrinfo`, `gdal_translate`, `gdalbuildvrt`, `gdalwarp`) on `PATH`, or `--gdal-bin` pointing to the directory containing them,
- `pip install -r requirements.txt`

## Quick start

AOI data must already be in the same CRS as the service being queried. Reproject it first if needed, for example with `ogr2ogr -t_srs EPSG:XXXX`.

### WCS (native values)

```bash
python fetch.py --service wcs \
  --url https://example.gov/sigserver/wcs \
  --layer NAMESPACE:LAYER-NAME \
  --aoi aoi.gpkg \
  --crs EPSG:31982 \
  --resolution 1 \
  --out dsm_native.tif
```

### WMS (rendered mosaic)

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

Some government WMS/WCS endpoints reject requests from cloud or foreign IP ranges. If your browser can access the service but your server cannot, try one of these strategies:

- `--relay microlink` routes WMS `GetMap` requests through a browser-rendering screenshot API,
- for blocked WCS requests, there is no safe generic relay for raw binary data; a trusted proxy that forwards bytes without modification is required.

## Safety limits

- `--max-tiles` refuses a WMS job before it starts if the AOI, resolution and tile size would exceed the configured tile budget,
- `--cleanup` removes intermediate files such as `_RAW.tif`, `_MOSAIC.tif`, `.vrt` and the WMS tile cache once the final output exists,
- failed runs exit with a short `error: ...` message on stderr instead of a Python traceback,
- the app enforces a maximum pixel budget to avoid unexpectedly huge GeoTIFF generation.

## Output

The CLI writes the following artifacts:

- `<out>`: final clipped GeoTIFF,
- `<output-name>_tiles/`: WMS-only tile cache, kept for resumable reruns unless `--cleanup` is passed,
- `<out>.vrt`, `<out>_MOSAIC.tif`, `<out>_RAW.tif`: intermediate files, safe to delete once the final output is verified.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Contributions are welcome. The project is intentionally simple and test-driven, and the existing Node and Python test files are a good place to add new regression coverage.
