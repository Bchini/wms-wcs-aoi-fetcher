// Reads only the coordinates out of a GeoJSON document to compute its
// bounding box in EPSG:4326 -- the CRS every GeoJSON coordinate is in, per
// RFC 7946, regardless of Feature/FeatureCollection/GeometryCollection
// nesting or which geometry type it is. This app clips an AOI to that
// bounding box (not the exact polygon shape): a real cutline would need a
// full vector reprojection/rasterization step this client-side pipeline
// doesn't carry. No shapefile/KML support -- those need a real parser (or
// GDAL/OGR itself) this app doesn't run client-side either.

function walkCoordinates(node, onPoint) {
  if (!Array.isArray(node)) return;
  if (typeof node[0] === 'number' && typeof node[1] === 'number') {
    onPoint(node[0], node[1]);
    return;
  }
  for (const child of node) walkCoordinates(child, onPoint);
}

function walkGeometry(geometry, onPoint) {
  if (!geometry) return;
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries || []) walkGeometry(child, onPoint);
    return;
  }
  walkCoordinates(geometry.coordinates, onPoint);
}

/**
 * The [minLon, minLat, maxLon, maxLat] bounding box of every coordinate in
 * a parsed GeoJSON document (a Feature, a FeatureCollection, or a bare
 * geometry). Throws if it carries no usable coordinate, or only a single
 * point (not enough to define an area).
 */
export function boundsFromGeoJson(geojson) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const onPoint = (lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  };

  const type = geojson?.type;
  if (type === 'FeatureCollection') {
    for (const feature of geojson.features || []) walkGeometry(feature?.geometry, onPoint);
  } else if (type === 'Feature') {
    walkGeometry(geojson.geometry, onPoint);
  } else if (type) {
    walkGeometry(geojson, onPoint);
  }

  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
    throw new Error('No usable coordinates found in this GeoJSON file.');
  }
  if (minLon === maxLon || minLat === maxLat) {
    throw new Error('This AOI has no area (looks like a single point, not a polygon).');
  }
  return [minLon, minLat, maxLon, maxLat];
}
