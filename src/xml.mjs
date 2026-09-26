// OGC capabilities XML reading, using fast-xml-parser's order-preserving
// mode so every element (at any depth) can be walked as one flat list --
// the same shape as Python's ElementTree.iter(), which the container-based
// version of this app used before the client-side rewrite.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
});

const BOX_TAGS = new Set([
  'BoundingBox',
  'EX_GeographicBoundingBox',
  'WGS84BoundingBox',
  'lonLatEnvelope',
  'LatLonBoundingBox',
]);

/** Parse an XML document into a flat list of {tag, children, attrs}, depth-first. */
export function parseElements(xmlText) {
  const doc = parser.parse(xmlText);
  const elements = [];
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        if (key === ':@' || key === '#text') continue;
        const children = node[key];
        const attrs = node[':@'] || {};
        elements.push({ tag: key, children, attrs });
        walk(children);
      }
    }
  };
  walk(doc);
  return elements;
}

/** The trimmed text of the first direct child named `name` (case-insensitive). */
export function directText(children, name) {
  if (!Array.isArray(children)) return null;
  const lower = name.toLowerCase();
  for (const node of children) {
    const key = Object.keys(node).find((k) => k !== ':@');
    if (key && key.toLowerCase() === lower) {
      const inner = node[key];
      if (Array.isArray(inner)) {
        const textNode = inner.find((n) => '#text' in n);
        if (textNode != null) return String(textNode['#text']).trim();
      }
    }
  }
  return null;
}

/** The Name/Identifier of `element` if it is a real layer entry for `service`. */
export function layerIdentifier(element, service) {
  if (service === 'wmts') {
    return element.tag === 'Layer' ? directText(element.children, 'Identifier') : null;
  }
  if (service === 'wcs') {
    return ['CoverageOfferingBrief', 'CoverageOffering'].includes(element.tag)
      ? directText(element.children, 'Name')
      : null;
  }
  return element.tag === 'Layer' ? directText(element.children, 'Name') : null;
}

/** True if `element` carries any kind of OGC bounding box as a direct child. */
export function hasBoundingBox(element) {
  if (!Array.isArray(element.children)) return false;
  return element.children.some((node) => {
    const key = Object.keys(node).find((k) => k !== ':@');
    return key && BOX_TAGS.has(key);
  });
}

/**
 * The [minx, miny, maxx, maxy] + source CRS of `element`'s bounding box,
 * preferring an exact match for `requestedCrs`, else falling back to any
 * geographic box (EX_GeographicBoundingBox / WGS84BoundingBox / lonLatEnvelope
 * / WMS 1.1's LatLonBoundingBox), all always in EPSG:4326.
 */
export function boxFromElement(element, requestedCrs) {
  if (!Array.isArray(element.children)) return null;
  for (const node of element.children) {
    const key = Object.keys(node).find((k) => k !== ':@');
    if (key !== 'BoundingBox') continue;
    const attrs = node[':@'] || {};
    const crsAttr = attrs['@_CRS'];
    const srsAttr = attrs['@_SRS'];
    const sourceCrs = crsAttr || srsAttr;
    if (!sourceCrs || sourceCrs.toUpperCase() !== requestedCrs.toUpperCase()) continue;
    let minx = parseFloat(attrs['@_minx']);
    let miny = parseFloat(attrs['@_miny']);
    let maxx = parseFloat(attrs['@_maxx']);
    let maxy = parseFloat(attrs['@_maxy']);
    if ([minx, miny, maxx, maxy].some((v) => Number.isNaN(v))) continue;
    // WMS >= 1.3 (the "CRS" attribute, unlike 1.1's always-x/y "SRS")
    // reports EPSG:4326 in its registered lat/lon axis order.
    if (crsAttr && sourceCrs.toUpperCase() === 'EPSG:4326') {
      [minx, miny, maxx, maxy] = [miny, minx, maxy, maxx];
    }
    return { bounds: [minx, miny, maxx, maxy], crs: sourceCrs };
  }
  for (const node of element.children) {
    const key = Object.keys(node).find((k) => k !== ':@');
    if (key === 'EX_GeographicBoundingBox') {
      const west = parseFloat(directText(node[key], 'westBoundLongitude'));
      const south = parseFloat(directText(node[key], 'southBoundLatitude'));
      const east = parseFloat(directText(node[key], 'eastBoundLongitude'));
      const north = parseFloat(directText(node[key], 'northBoundLatitude'));
      if ([west, south, east, north].every((v) => Number.isFinite(v))) {
        return { bounds: [west, south, east, north], crs: 'EPSG:4326' };
      }
    }
    if (key === 'WGS84BoundingBox' || key === 'lonLatEnvelope') {
      const lower = directText(node[key], 'LowerCorner') || directText(node[key], 'pos');
      const positions = (node[key] || [])
        .filter((n) => Object.keys(n).find((k) => k !== ':@') === 'pos')
        .map((n) => {
          const inner = n.pos;
          const textNode = Array.isArray(inner) ? inner.find((x) => '#text' in x) : null;
          return textNode ? String(textNode['#text']).trim() : null;
        })
        .filter(Boolean);
      const upper = directText(node[key], 'UpperCorner') || positions[1];
      if (lower && upper) {
        const [minX, minY] = lower.split(/\s+/).slice(0, 2).map(Number);
        const [maxX, maxY] = upper.split(/\s+/).slice(0, 2).map(Number);
        if ([minX, minY, maxX, maxY].every((v) => Number.isFinite(v))) {
          return { bounds: [minX, minY, maxX, maxY], crs: 'EPSG:4326' };
        }
      }
    }
    if (key === 'LatLonBoundingBox') {
      const attrs = node[':@'] || {};
      const minX = parseFloat(attrs['@_minx']);
      const minY = parseFloat(attrs['@_miny']);
      const maxX = parseFloat(attrs['@_maxx']);
      const maxY = parseFloat(attrs['@_maxy']);
      if ([minX, minY, maxX, maxY].every((v) => Number.isFinite(v))) {
        return { bounds: [minX, minY, maxX, maxY], crs: 'EPSG:4326' };
      }
    }
  }
  return null;
}

/**
 * A layer's own MinScaleDenominator/MaxScaleDenominator, if it declares
 * either (WMS-only; GeoServer commonly restricts a per-feature-style layer,
 * e.g. building footprints, to render only below some scale so a
 * full-extent request comes back blank instead of failing outright).
 */
export function scaleDenominatorLimits(element) {
  if (!Array.isArray(element.children)) return null;
  const min = directText(element.children, 'MinScaleDenominator');
  const max = directText(element.children, 'MaxScaleDenominator');
  const minValue = min != null ? parseFloat(min) : null;
  const maxValue = max != null ? parseFloat(max) : null;
  if (!Number.isFinite(minValue) && !Number.isFinite(maxValue)) return null;
  return {
    min: Number.isFinite(minValue) ? minValue : null,
    max: Number.isFinite(maxValue) ? maxValue : null,
  };
}

/** The first real, georeferenced layer/coverage advertised by the service. */
export function firstLayerName(elements, service) {
  for (const element of elements) {
    const identifier = layerIdentifier(element, service);
    if (!identifier) continue;
    if (service === 'wms' && !hasBoundingBox(element)) {
      // Skip container <Layer> elements that carry a Name but no bounding
      // box of their own (INSPIRE-style capabilities nest the real layers
      // one level below a nameless or generic root layer).
      continue;
    }
    return identifier;
  }
  return null;
}
