import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretUrl, ResolveError, reprojectBounds, lonLatToWebMercator } from '../src/resolve.mjs';

const WMS_CAPABILITIES = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Service><Name>WMS</Name></Service>
  <Capability>
    <Layer>
      <Layer>
        <Name>demo:layer_a</Name>
        <BoundingBox CRS="EPSG:4326" minx="27" miny="-19" maxx="44" maxy="5"/>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

const WCS_CAPABILITIES = `<?xml version="1.0"?>
<WCS_Capabilities version="1.0.0" xmlns="http://www.opengis.net/wcs">
  <ContentMetadata>
    <CoverageOfferingBrief>
      <name>demo:coverage_a</name>
      <lonLatEnvelope><pos>-10 30</pos><pos>10 50</pos></lonLatEnvelope>
    </CoverageOfferingBrief>
  </ContentMetadata>
</WCS_Capabilities>`;

function textResponse(body, ok = true) {
  return {
    ok,
    body: null,
    text: async () => body,
  };
}

function fakeFetch(byService) {
  return async (url) => {
    const parsed = new URL(url);
    const service = (parsed.searchParams.get('SERVICE') || '').toLowerCase();
    if (byService[service]) return textResponse(byService[service]);
    return textResponse('', false);
  };
}

test('a full GetMap URL with BBOX is used literally', async () => {
  const fetchImpl = fakeFetch({ wms: WMS_CAPABILITIES });
  const resolved = await interpretUrl(
    'https://example.test/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
      '&LAYERS=demo:layer_a&CRS=EPSG:4326&BBOX=40,-4,41,-3&WIDTH=1000&HEIGHT=1000',
    fetchImpl
  );
  assert.equal(resolved.service, 'wms');
  assert.equal(resolved.layer, 'demo:layer_a');
  assert.deepEqual(resolved.bounds, [-4, 40, -3, 41]);
  assert.ok(Math.abs(resolved.resolution - 0.001) < 1e-9);
});

test('a bare capabilities URL falls back to the full advertised extent', async () => {
  const fetchImpl = fakeFetch({ wms: WMS_CAPABILITIES });
  const resolved = await interpretUrl(
    'https://example.test/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities',
    fetchImpl
  );
  assert.equal(resolved.layer, 'demo:layer_a');
  assert.deepEqual(resolved.bounds, [-19, 27, 5, 44]);
  assert.ok(resolved.resolution > 0);
});

test('an unsupported version falls back to the service default', async () => {
  const fetchImpl = fakeFetch({ wms: WMS_CAPABILITIES });
  const resolved = await interpretUrl(
    'https://example.test/wms?SERVICE=WMS&VERSION=9.9.9&REQUEST=GetCapabilities',
    fetchImpl
  );
  assert.equal(resolved.version, '1.3.0');
});

test('WCS capabilities resolve via CoverageOfferingBrief', async () => {
  const fetchImpl = fakeFetch({ wcs: WCS_CAPABILITIES });
  const resolved = await interpretUrl(
    'https://example.test/wcs?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCapabilities',
    fetchImpl
  );
  assert.equal(resolved.service, 'wcs');
  assert.equal(resolved.layer, 'demo:coverage_a');
  assert.deepEqual(resolved.bounds, [-10, 30, 10, 50]);
});

test('service is guessed from the path when no SERVICE param is given', async () => {
  const fetchImpl = fakeFetch({ wcs: WCS_CAPABILITIES });
  const resolved = await interpretUrl('https://example.test/geoserver/wcs?layers=demo:coverage_a', fetchImpl);
  assert.equal(resolved.service, 'wcs');
});

test('a non-http(s) URL is rejected', async () => {
  await assert.rejects(() => interpretUrl('ftp://example.test/x', fakeFetch({})), ResolveError);
});

test('an oversized area is rejected', async () => {
  const hugeCapabilities = WMS_CAPABILITIES.replace(
    'minx="27" miny="-19" maxx="44" maxy="5"',
    'minx="-90" miny="-180" maxx="90" maxy="180"'
  );
  const fetchImpl = fakeFetch({ wms: hugeCapabilities });
  await assert.rejects(
    () =>
      interpretUrl(
        'https://example.test/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
          '&LAYERS=demo:layer_a&CRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=100000&HEIGHT=100000',
        fetchImpl
      ),
    (error) => error instanceof ResolveError && error.status === 413
  );
});

test('surrounding whitespace is stripped from the endpoint', async () => {
  const fetchImpl = fakeFetch({ wms: WMS_CAPABILITIES });
  const resolved = await interpretUrl(
    '  https://example.test/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities  ',
    fetchImpl
  );
  assert.equal(resolved.endpoint, 'https://example.test/wms');
});

// A layer that only advertises a geographic fallback (no BoundingBox in the
// requested CRS at all) -- the regression this guards against: those
// geographic degrees must never be reused as-is for a non-4326 request.
const GEOGRAPHIC_ONLY_CAPABILITIES = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Service><Name>WMS</Name></Service>
  <Capability>
    <Layer>
      <Layer>
        <Name>demo:geo_only</Name>
        <EX_GeographicBoundingBox>
          <westBoundLongitude>-10</westBoundLongitude>
          <eastBoundLongitude>10</eastBoundLongitude>
          <southBoundLatitude>30</southBoundLatitude>
          <northBoundLatitude>50</northBoundLatitude>
        </EX_GeographicBoundingBox>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

test('requesting EPSG:3857 against geographic-only capabilities reprojects, never reuses degrees as meters', async () => {
  const fetchImpl = fakeFetch({ wms: GEOGRAPHIC_ONLY_CAPABILITIES });
  const resolved = await interpretUrl(
    'https://example.test/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
      '&LAYERS=demo:geo_only&CRS=EPSG:3857',
    fetchImpl
  );
  assert.equal(resolved.crs, 'EPSG:3857');
  const [expMinX, expMinY] = lonLatToWebMercator(-10, 30);
  const [expMaxX, expMaxY] = lonLatToWebMercator(10, 50);
  assert.ok(Math.abs(resolved.bounds[0] - expMinX) < 1);
  assert.ok(Math.abs(resolved.bounds[1] - expMinY) < 1);
  assert.ok(Math.abs(resolved.bounds[2] - expMaxX) < 1);
  assert.ok(Math.abs(resolved.bounds[3] - expMaxY) < 1);
  // The old bug: bounds like [-10, 30, 10, 50] reused directly as "meters".
  assert.notEqual(resolved.bounds[0], -10);
});

test('requesting a CRS with no known transform falls back to the CRS the bounds are actually valid in', async () => {
  const fetchImpl = fakeFetch({ wms: GEOGRAPHIC_ONLY_CAPABILITIES });
  const resolved = await interpretUrl(
    'https://example.test/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
      '&LAYERS=demo:geo_only&CRS=EPSG:31982',
    fetchImpl
  );
  // Cannot reproject degrees to a UTM-style CRS with a closed-form formula --
  // must report the CRS the bounds actually are in (EPSG:4326), not pretend
  // they are EPSG:31982 meters.
  assert.equal(resolved.crs, 'EPSG:4326');
  assert.deepEqual(resolved.bounds, [-10, 30, 10, 50]);
});

test('reprojectBounds returns null for an unsupported CRS pair', () => {
  assert.equal(reprojectBounds([-10, 30, 10, 50], 'EPSG:4326', 'EPSG:31982'), null);
});

test('reprojectBounds is a no-op when source and target CRS already match', () => {
  const bounds = [-10, 30, 10, 50];
  assert.deepEqual(reprojectBounds(bounds, 'EPSG:4326', 'epsg:4326'), bounds);
});
