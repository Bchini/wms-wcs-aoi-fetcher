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
