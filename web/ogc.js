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
