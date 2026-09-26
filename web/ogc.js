// OGC WMS/WCS request-building helpers. Pure functions, no GDAL/network
// dependency -- a browser-side port of the same logic in fetch.py, so the
// CLI and the web app agree on how a BBOX/tile grid is built.

/** Return a WMS BBOX string, accounting for the WMS 1.3 EPSG:4326 axis order. */
export function wmsBbox(minx, miny, maxx, maxy, crs, version) {
  if (version === '1.3.0' && crs.toUpperCase() === 'EPSG:4326') {
    return `${miny},${minx},${maxy},${maxx}`;
  }
  return `${minx},${miny},${maxx},${maxy}`;
}

export function wmsCrsParameter(version) {
  return version === '1.3.0' ? 'CRS' : 'SRS';
}

/**
 * Invert wmsBbox(): turn a BBOX taken from a pasted GetMap URL back into
 * [minx, miny, maxx, maxy] in standard axis order.
 */
export function bboxParamToGeographic(values, crs, version) {
  const [v0, v1, v2, v3] = values;
  if (version === '1.3.0' && crs.toUpperCase() === 'EPSG:4326') {
    return [v1, v0, v3, v2];
  }
  return [v0, v1, v2, v3];
}

/** Append encoded OGC parameters to endpoints with or without a query string. */
export function serviceUrl(baseUrl, params) {
  const separator = !baseUrl.includes('?') ? '?' : baseUrl.endsWith('?') || baseUrl.endsWith('&') ? '' : '&';
  return baseUrl + separator + new URLSearchParams(params).toString();
}

/** Return {cols, rows} of GetMap tiles needed to cover the extent. */
export function tileGrid(minx, miny, maxx, maxy, tileW, tileH, resolution) {
  const cols = Math.max(1, Math.ceil((maxx - minx) / (tileW * resolution)));
  const rows = Math.max(1, Math.ceil((maxy - miny) / (tileH * resolution)));
  return { cols, rows };
}

// Candidate output sizes (pixels on the longer side of the area) offered in
// the resolution dropdown. "Standard" matches the resolution /api/resolve
// itself suggests for a full-extent request, so a user who doesn't touch the
// dropdown gets the same result as before this option existed.
const RESOLUTION_PRESETS = [
  { label: 'Preview (fast)', pixels: 512 },
  { label: 'Standard', pixels: 2048 },
  { label: 'High', pixels: 4096 },
  { label: 'Maximum', pixels: 8192 },
];

/**
 * Resolution choices for [minx, miny, maxx, maxy], sized off the area's own
 * extent so a huge full-country request and a small neighborhood one get
 * sensibly different options. Drops any preset that would exceed the pixel
 * budget or (for WMS) need more tiles than a browser tab should fetch
 * sequentially; always returns at least one option.
 */
export function resolutionOptions(
  bounds,
  { maxPixels = 25_000_000, maxTiles = 64, tileSize = 1024 } = {}
) {
  const [minx, miny, maxx, maxy] = bounds;
  const dx = maxx - minx;
  const dy = maxy - miny;
  const span = Math.max(dx, dy);
  const options = [];
  for (const { label, pixels: target } of RESOLUTION_PRESETS) {
    const resolution = span / target;
    const width = Math.max(1, Math.round(dx / resolution));
    const height = Math.max(1, Math.round(dy / resolution));
    if (width * height > maxPixels) continue;
    const { cols, rows } = tileGrid(minx, miny, maxx, maxy, tileSize, tileSize, resolution);
    if (cols * rows > maxTiles) continue;
    options.push({ label, resolution, width, height, tiles: cols * rows });
  }
  if (!options.length) {
    // Every preset was too large (an enormous full-extent area) -- fall
    // back to whatever resolution exactly fills the pixel budget so there
    // is always at least one choice.
    const resolution = span / Math.sqrt(maxPixels);
    const width = Math.max(1, Math.round(dx / resolution));
    const height = Math.max(1, Math.round(dy / resolution));
    const { cols, rows } = tileGrid(minx, miny, maxx, maxy, tileSize, tileSize, resolution);
    options.push({ label: 'Maximum (capped)', resolution, width, height, tiles: cols * rows });
  }
  return options;
}

/**
 * A resolution derived from an exact pixel width the user typed in, instead
 * of one of the fixed presets -- for when a preset under- or over-shoots
 * what they actually want. Guarded by the same pixel/tile ceiling as
 * resolutionOptions() (a runaway width could otherwise hang the tab
 * decoding a huge canvas, or queue hundreds of sequential tile fetches);
 * pass `maxTiles: Infinity` for WCS, which this app never tiles.
 */
export function customResolution(
  bounds,
  targetWidth,
  { maxPixels = 25_000_000, maxTiles = 64, tileSize = 1024 } = {}
) {
  const [minx, miny, maxx, maxy] = bounds;
  if (!Number.isFinite(targetWidth) || targetWidth < 1) {
    throw new Error('Enter a whole number of pixels for the custom width.');
  }
  const resolution = (maxx - minx) / targetWidth;
  const width = Math.max(1, Math.round(targetWidth));
  const height = Math.max(1, Math.round((maxy - miny) / resolution));
  if (width * height > maxPixels) {
    throw new Error(
      `That width needs about ${Math.round((width * height) / 1_000_000)} million output pixels, over the ` +
        `${Math.round(maxPixels / 1_000_000)} million limit. Try a smaller width, or upload an AOI to shrink the area.`
    );
  }
  const { cols, rows } = tileGrid(minx, miny, maxx, maxy, tileSize, tileSize, resolution);
  if (cols * rows > maxTiles) {
    throw new Error(
      `That width needs ${cols * rows} WMS tiles, over the ${maxTiles}-tile limit. Try a smaller width, or ` +
        'upload an AOI to shrink the area.'
    );
  }
  return { resolution, width, height, tiles: cols * rows };
}

// -- AOI support: a GeoJSON AOI's coordinates are always EPSG:4326 (RFC
// 7946), so its bounding box needs reprojecting into whatever CRS the
// service actually got detected in before it can be intersected with the
// detected extent. Mirrors src/resolve.mjs's reprojectBounds() -- duplicated
// here because that module runs in the Worker and this one in the browser;
// both need to agree on the same closed-form cases.
const WEB_MERCATOR_RADIUS = 6378137;

export function lonLatToWebMercator(lon, lat) {
  const x = ((lon * Math.PI) / 180) * WEB_MERCATOR_RADIUS;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * WEB_MERCATOR_RADIUS;
  return [x, y];
}

/**
 * Reproject an AOI's [minx, miny, maxx, maxy] (always EPSG:4326) into
 * `toCrs`. Returns null when `toCrs` isn't one of the closed-form cases
 * this app knows how to convert -- callers should fall back to the full
 * detected extent rather than clip against a mislabeled box.
 */
export function reprojectAoiBounds(bounds, toCrs) {
  const target = toCrs.toUpperCase();
  if (target === 'EPSG:4326' || target === 'CRS:84') return bounds;
  if (target === 'EPSG:3857' || target === 'EPSG:900913') {
    const [minx, miny, maxx, maxy] = bounds;
    const [x1, y1] = lonLatToWebMercator(minx, miny);
    const [x2, y2] = lonLatToWebMercator(maxx, maxy);
    return [x1, y1, x2, y2];
  }
  return null;
}

// -- Scale-denominator warning: mirrors src/resolve.mjs's estimate/warning
// pair so the browser can recompute it after the user clips to an AOI or
// changes the resolution, both of which the server never sees (the
// server-computed `warning` in a /api/resolve response is only ever valid
// for that response's own full-extent default request).
const METERS_PER_DEGREE = 111_320;
const OGC_STANDARDIZED_PIXEL_SIZE_M = 0.00028;
const GEOGRAPHIC_CRS = new Set(['EPSG:4326', 'EPSG:4258', 'CRS:84']);

export function estimateScaleDenominator(resolution, crs) {
  const metersPerPixel = GEOGRAPHIC_CRS.has(crs.toUpperCase()) ? resolution * METERS_PER_DEGREE : resolution;
  return metersPerPixel / OGC_STANDARDIZED_PIXEL_SIZE_M;
}

/** Same wording as resolve.mjs's scaleWarning(), minus the "full extent" framing (may now be an AOI clip). */
export function scaleWarningText(maxScaleDenominator, resolution, crs) {
  if (!maxScaleDenominator) return null;
  const requestScaleDenominator = estimateScaleDenominator(resolution, crs);
  if (requestScaleDenominator <= maxScaleDenominator) return null;
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  return (
    `This layer only renders below 1:${fmt(maxScaleDenominator)} scale; at this resolution ` +
    `(about 1:${fmt(requestScaleDenominator)}), the download will likely be blank. Pick a finer ` +
    'resolution, or upload a smaller AOI.'
  );
}

/** The overlap of two [minx, miny, maxx, maxy] boxes, or null if they don't overlap. */
export function intersectBounds(a, b) {
  const minx = Math.max(a[0], b[0]);
  const miny = Math.max(a[1], b[1]);
  const maxx = Math.min(a[2], b[2]);
  const maxy = Math.min(a[3], b[3]);
  if (minx >= maxx || miny >= maxy) return null;
  return [minx, miny, maxx, maxy];
}

/**
 * Build the list of WMS GetMap tile requests covering [minx, miny, maxx, maxy]
 * at the given resolution, each carrying its own pixel bbox for georeferencing.
 */
export function planWmsTiles({ minx, miny, maxx, maxy, tileW, tileH, resolution }) {
  const { cols, rows } = tileGrid(minx, miny, maxx, maxy, tileW, tileH, resolution);
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    const tymax = maxy - row * tileH * resolution;
    const tymin = Math.max(miny, tymax - tileH * resolution);
    const height = Math.max(1, Math.round((tymax - tymin) / resolution));
    for (let col = 0; col < cols; col += 1) {
      const txmin = minx + col * tileW * resolution;
      const txmax = Math.min(maxx, txmin + tileW * resolution);
      const width = Math.max(1, Math.round((txmax - txmin) / resolution));
      tiles.push({ row, col, txmin, tymin, txmax, tymax, width, height });
    }
  }
  return tiles;
}
