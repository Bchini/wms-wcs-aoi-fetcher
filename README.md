# wms-wcs-aoi-fetcher

Download a raster layer from a WMS or WCS service, clipped to an AOI, as a
single GeoTIFF — without manually clicking through a web portal tile by tile.

The repository also includes a lightweight **web command builder** in
[`web/`](web/). It is deployable as a static Cloudflare Pages site and creates
a checked command/script for the local Python + GDAL fetcher. A static site
cannot run GDAL or download potentially large GeoTIFFs itself, so the actual
fetch always remains on the user's machine.

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

## Output

- `<out>`: final clipped GeoTIFF.
- `<output-name>_tiles/`: (WMS mode) individual downloaded/georeferenced tiles, kept so a
  re-run resumes instead of re-downloading everything.
- `<out>.vrt`, `<out>_MOSAIC.tif` / `<out>_RAW.tif`: intermediate files, safe
  to delete once you have the final clipped output.

## License

MIT — see [LICENSE](LICENSE).
