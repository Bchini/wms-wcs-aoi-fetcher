// Fill in whatever a pasted WMS/WCS/WMTS URL leaves out: service, version,
// layer, CRS, area and resolution -- from the URL's own query string first,
// then from the service's own GetCapabilities document. A JS port of the
// same interpret_url() this app used to run inside a Cloudflare Container;
// it now runs directly in the Worker (no GDAL needed for this part).
import { parseElements, layerIdentifier, boxFromElement, firstLayerName } from './xml.mjs';

export const SUPPORTED_SERVICES = ['wms', 'wcs'];
export const DEFAULT_VERSION = { wms: '1.3.0', wcs: '1.0.0' };
export const SUPPORTED_VERSIONS = { wms: new Set(['1.1.1', '1.3.0']), wcs: new Set(['1.0.0']) };

export const MAX_REQUEST_PIXELS = 25_000_000;
export const MAX_CAPABILITIES_BYTES = 5 * 1024 * 1024;
const DEFAULT_TARGET_PIXELS_PER_SIDE = 2048;

export class ResolveError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

function queryParams(url) {
  const parsed = new URL(url);
  const params = {};
  for (const [key, value] of parsed.searchParams) params[key.toUpperCase()] = value;
  return params;
}

function endpointOnly(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function guessServiceFromPath(url) {
  const path = new URL(url).pathname.toLowerCase();
  // WMTS deliberately excluded: the browser-side GDAL runner does not
  // implement WMTS's tile-matrix math (see README).
  for (const candidate of ['wcs', 'wms']) {
    if (path.includes(candidate)) return candidate;
  }
  return null;
}

function pixelCount(bounds, resolution) {
  const [minx, miny, maxx, maxy] = bounds;
  return ((maxx - minx) / resolution) * ((maxy - miny) / resolution);
}

function guardPixelBudget(bounds, resolution) {
  const pixels = pixelCount(bounds, resolution);
  if (!Number.isFinite(pixels) || pixels > MAX_REQUEST_PIXELS) {
    throw new ResolveError(
      `This area needs more than ${Math.floor(MAX_REQUEST_PIXELS / 1_000_000)} million output ` +
        'pixels. Paste a URL with a smaller BBOX, or a coarser WIDTH/HEIGHT.',
      413
    );
  }
}

async function fetchCapabilities(fetchImpl, endpoint, service, version) {
  const parsed = new URL(endpoint);
  parsed.searchParams.set('SERVICE', service.toUpperCase());
  parsed.searchParams.set('REQUEST', 'GetCapabilities');
  parsed.searchParams.set('VERSION', version);
  let response;
  try {
    response = await fetchImpl(parsed.toString(), {
      headers: { 'User-Agent': 'wms-wcs-aoi-fetcher/2.0' },
    });
  } catch (error) {
    throw new ResolveError(`Could not read ${service.toUpperCase()} capabilities from this URL.`);
  }
  if (!response.ok) {
    throw new ResolveError(`Could not read ${service.toUpperCase()} capabilities from this URL.`);
  }
  const reader = response.body?.getReader();
  let text;
  if (reader) {
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_CAPABILITIES_BYTES) {
        await reader.cancel();
        throw new ResolveError('The service capabilities document is too large.');
      }
      chunks.push(value);
    }
    text = new TextDecoder('utf-8').decode(
      chunks.reduce((acc, chunk) => {
        const merged = new Uint8Array(acc.length + chunk.length);
        merged.set(acc);
        merged.set(chunk, acc.length);
        return merged;
      }, new Uint8Array())
    );
  } else {
    text = await response.text();
  }
  try {
    return parseElements(text);
  } catch (error) {
    throw new ResolveError('The service returned invalid capabilities XML.');
  }
}

async function advertisedBounds(fetchImpl, service, endpoint, layer, version, crs) {
  const elements = await fetchCapabilities(fetchImpl, endpoint, service, version);
  for (const element of elements) {
    if (layerIdentifier(element, service) === layer) {
      const candidate = boxFromElement(element, crs);
      if (candidate) return candidate;
    }
  }
  throw new ResolveError(`The service did not advertise an extent for layer '${layer}'. Try a different URL.`);
}

async function probeService(fetchImpl, endpoint) {
  for (const service of SUPPORTED_SERVICES) {
    let elements;
    try {
      elements = await fetchCapabilities(fetchImpl, endpoint, service, DEFAULT_VERSION[service]);
    } catch {
      continue;
    }
    if (firstLayerName(elements, service)) return { service, elements };
  }
  throw new ResolveError(
    'Could not detect a WMS or WCS service at this URL. Paste a service endpoint or a full ' +
      'GetCapabilities/GetMap/GetCoverage URL. (WMTS is not supported by this browser-based app.)'
  );
}

/**
 * Resolve a pasted URL into concrete request parameters.
 * `fetchImpl` is injected so tests can stub it without a real network call.
 */
export async function interpretUrl(rawUrl, fetchImpl) {
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new ResolveError('Paste a full http(s) WMS/WCS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ResolveError('Paste a full http(s) WMS/WCS URL.');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localdomain')) {
    throw new ResolveError('Local service URLs are not allowed.');
  }

  const params = queryParams(url.toString());
  const endpoint = endpointOnly(url.toString());

  let service = (params.SERVICE || '').toLowerCase();
  let probedElements = null;
  if (!SUPPORTED_SERVICES.includes(service)) service = guessServiceFromPath(url.toString());
  if (!SUPPORTED_SERVICES.includes(service)) {
    const probed = await probeService(fetchImpl, endpoint);
    service = probed.service;
    probedElements = probed.elements;
  }

  let version = params.VERSION;
  if (!SUPPORTED_VERSIONS[service].has(version)) version = DEFAULT_VERSION[service];

  let layer = params.LAYERS || params.LAYER || params.COVERAGE || params.COVERAGEID || params.TYPENAME || params.TYPENAMES;
  if (layer && layer.includes(',')) layer = layer.split(',')[0];
  if (!layer) {
    const elements = probedElements || (await fetchCapabilities(fetchImpl, endpoint, service, version));
    layer = firstLayerName(elements, service);
    if (!layer) {
      throw new ResolveError(`The ${service.toUpperCase()} service at this URL did not advertise any layer.`);
    }
  }

  let crs = (params.CRS || params.SRS || 'EPSG:4326').toUpperCase();
  if (!/^EPSG:\d+$/.test(crs)) crs = 'EPSG:4326';

  const bboxParam = params.BBOX;
  const widthParam = params.WIDTH;
  const heightParam = params.HEIGHT;
  let bounds = null;
  let usedLiteralBbox = false;
  if (bboxParam) {
    const rawValues = bboxParam.split(',').map(Number);
    if (rawValues.length === 4 && rawValues.every(Number.isFinite)) {
      const [v0, v1, v2, v3] = rawValues;
      const candidate =
        service === 'wms' && version === '1.3.0' && crs === 'EPSG:4326' ? [v1, v0, v3, v2] : [v0, v1, v2, v3];
      if (candidate[0] < candidate[2] && candidate[1] < candidate[3]) {
        bounds = candidate;
        usedLiteralBbox = true;
      }
    }
  }

  if (!bounds) {
    const found = await advertisedBounds(fetchImpl, service, endpoint, layer, version, crs);
    bounds = found.bounds;
  }

  const [minx, miny, maxx, maxy] = bounds;
  let resolution;
  if (usedLiteralBbox && widthParam && /^\d+$/.test(widthParam) && Number(widthParam) > 0) {
    resolution = (maxx - minx) / Number(widthParam);
  } else if (usedLiteralBbox && heightParam && /^\d+$/.test(heightParam) && Number(heightParam) > 0) {
    resolution = (maxy - miny) / Number(heightParam);
  } else {
    resolution = Math.max(maxx - minx, maxy - miny) / DEFAULT_TARGET_PIXELS_PER_SIDE;
  }
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new ResolveError('Could not derive a usable resolution from this URL.');
  }
  guardPixelBudget(bounds, resolution);

  let imageFormat = params.FORMAT || '';
  if (!['image/png', 'image/jpeg'].includes(imageFormat)) imageFormat = 'image/png';

  return { service, endpoint, version, layer, crs, bounds, resolution, imageFormat };
}
