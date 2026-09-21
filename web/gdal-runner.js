// Runs the actual raster clip/mosaic/reproject entirely in the browser via
// gdal3.js (GDAL compiled to WebAssembly). No server-side processing at all,
// which is what lets this app run on Cloudflare's free Workers plan (no
// Containers, no paid plan).
//
// gdal3.js's gdalwarp() takes exactly one source dataset -- it has no
// gdalbuildvrt and no multi-source mosaicking (verified empirically: a
// second gdalwarp call to the same destination replaces it rather than
// merging). So a multi-tile WMS mosaic is built by warping each tile
// independently onto the SAME full target grid (-te/-tr) with -dstalpha
// (transparent outside that tile's own footprint), then compositing the
// resulting PNGs on a <canvas> -- transparent pixels simply don't overwrite
// pixels an earlier tile already drew. The composited canvas is finally
// re-georeferenced with one more gdal_translate -a_srs/-a_ullr call.

const GDAL_VERSION = '2.8.1';
const GDAL_CDN_BASE = `https://cdn.jsdelivr.net/npm/gdal3.js@${GDAL_VERSION}/dist/package`;
const GDAL_SCRIPT_INTEGRITY = 'sha384-yW4c2Jx7lsREjJg58+ZI5U6gAso2bRAPw3LdzPWm7z8+rMJ24R7AS+EFyXDPxgYM';

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
    }
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

let gdalPromise = null;
/** Load gdal3.js (once) and return its initialized API object. */
export function loadGdal() {
  if (!gdalPromise) {
    gdalPromise = loadScript(`${GDAL_CDN_BASE}/gdal3.js`, GDAL_SCRIPT_INTEGRITY).then(() =>
      window.initGdalJs({ path: GDAL_CDN_BASE, useWorker: false })
    );
  }
  return gdalPromise;
}

function outputPath(filePath) {
  return filePath.local || filePath.real || filePath;
}

async function fetchViaProxy(url) {
  const response = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `The source server returned HTTP ${response.status}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fetch a single WCS GetCoverage response and clip/reproject it onto
 * [minx, miny, maxx, maxy] at `resolution`. Returns a GeoTIFF Blob.
 */
export async function runWcs({ url, bounds, resolution, crs }, onProgress) {
  const Gdal = await loadGdal();
  onProgress?.({ phase: 'fetching', done: 0, total: 1 });
  const bytes = await fetchViaProxy(url);
  onProgress?.({ phase: 'fetching', done: 1, total: 1 });

  onProgress?.({ phase: 'processing', done: 0, total: 1 });
  const rawFile = new File([bytes], 'coverage.tif');
  const opened = await Gdal.open(rawFile);
  if (!opened.datasets.length) {
    throw new Error('The server did not return a readable coverage.');
  }
  const [minx, miny, maxx, maxy] = bounds;
  const clipped = await Gdal.gdalwarp(opened.datasets[0], [
    '-of', 'GTiff',
    '-t_srs', crs,
    '-te', String(minx), String(miny), String(maxx), String(maxy),
    '-tr', String(resolution), String(resolution),
    '-co', 'COMPRESS=DEFLATE',
  ]);
  const outBytes = await Gdal.getFileBytes(outputPath(clipped));
  onProgress?.({ phase: 'processing', done: 1, total: 1 });
  return new Blob([outBytes], { type: 'image/tiff' });
}

/**
 * Fetch every WMS GetMap tile in `tiles`, georeference and warp each onto
 * the shared [minx, miny, maxx, maxy] grid, composite them, and
 * re-georeference the result. Returns a GeoTIFF Blob.
 */
export async function runWms({ tiles, bounds, resolution, crs }, onProgress) {
  const Gdal = await loadGdal();
  const [minx, miny, maxx, maxy] = bounds;
  const teArgs = ['-te', String(minx), String(miny), String(maxx), String(maxy)];
  const trArgs = ['-tr', String(resolution), String(resolution)];

  let canvas = null;
  let ctx = null;
  const total = tiles.length;
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    onProgress?.({ phase: 'fetching', done: index, total });
    const bytes = await fetchViaProxy(tile.url);

    onProgress?.({ phase: 'processing', done: index, total });
    const rawFile = new File([bytes], `tile_${tile.row}_${tile.col}.png`);
    const opened = await Gdal.open(rawFile);
    if (!opened.datasets.length) {
      throw new Error(`Tile r${tile.row}c${tile.col} was not a readable image.`);
    }
    const georeferenced = await Gdal.gdal_translate(opened.datasets[0], [
      '-of', 'GTiff',
      '-a_srs', crs,
      '-a_ullr', String(tile.txmin), String(tile.tymax), String(tile.txmax), String(tile.tymin),
    ]);
    const openedGeo = await Gdal.open(outputPath(georeferenced));
    const warped = await Gdal.gdalwarp(openedGeo.datasets[0], [
      '-of', 'GTiff', '-t_srs', crs, ...teArgs, ...trArgs, '-r', 'near', '-dstalpha',
    ]);
    const openedWarped = await Gdal.open(outputPath(warped));
    const [width, height] = openedWarped.datasets[0].info.size;
    const png = await Gdal.gdal_translate(openedWarped.datasets[0], ['-of', 'PNG']);
    const pngBytes = await Gdal.getFileBytes(outputPath(png));

    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      ctx = canvas.getContext('2d');
    }
    const bitmap = await createImageBitmap(new Blob([pngBytes], { type: 'image/png' }));
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  }
  onProgress?.({ phase: 'fetching', done: total, total });

  if (!canvas) {
    throw new Error('No tiles were produced for this area.');
  }

  onProgress?.({ phase: 'compositing', done: 0, total: 1 });
  const compositedBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const compositedFile = new File([compositedBlob], 'composited.png');
  const openedComposited = await Gdal.open(compositedFile);
  const finalTif = await Gdal.gdal_translate(openedComposited.datasets[0], [
    '-of', 'GTiff',
    '-a_srs', crs,
    '-a_ullr', String(minx), String(maxy), String(maxx), String(miny),
    '-co', 'COMPRESS=DEFLATE',
  ]);
  const finalBytes = await Gdal.getFileBytes(outputPath(finalTif));
  onProgress?.({ phase: 'compositing', done: 1, total: 1 });
  return new Blob([finalBytes], { type: 'image/tiff' });
}
