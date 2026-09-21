# wms-wcs-aoi-fetcher

Download a raster layer from a WMS or WCS service, clipped to an AOI, as a
single GeoTIFF — without manually clicking through a web portal tile by tile.

## Live Cloudflare interface

**[Open the AOI Raster Fetcher](https://wms-wcs-aoi-fetcher.adel-bchini.workers.dev/)**

Paste a WMS, WCS, or WMTS URL and press **RUN**. That's the whole interface —
everything else is detected automatically:

- **Service and version** — from a `SERVICE=`/`VERSION=` parameter if the URL
  has one, else guessed from the path (`.../wms`, `.../wcs`, `.../wmts`), else
  found by probing GetCapabilities for each in turn.
- **Layer** — from `LAYERS=`/`COVERAGE=`/etc. if given, else the first
  georeferenced layer the service advertises.
- **CRS** — from `CRS=`/`SRS=` if given, else `EPSG:4326`.
- **Area and resolution** — a full GetMap/GetCoverage URL's `BBOX` (and
  `WIDTH`/`HEIGHT`, if present) is used exactly as given, so pasting a request
  you copied out of a browser's network tab clips precisely that view. A bare
  endpoint or GetCapabilities link instead fetches the layer's full advertised
  extent, sized to roughly 2048 px on the longer side.

Cloudflare runs GDAL in a container, clips the resolved raster, and starts the
GeoTIFF download when processing completes — a progress bar tracks it (the
container returns one finished response, so it's a decelerating estimate, not
a byte count). Error reports are saved directly in the app's Cloudflare D1
database. Every request is capped at 25 million output pixels.

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

The URL auto-detection above is a feature of the web app's container
(`container/server.py`, `interpret_url()`), not of `fetch.py` itself — the CLI
below still takes explicit `--service`/`--layer`/`--crs`/`--aoi` flags, since
it has no notion of "the URL you pasted," only the fields you pass it.

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
