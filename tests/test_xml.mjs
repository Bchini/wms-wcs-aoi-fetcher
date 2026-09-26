import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseElements,
  layerIdentifier,
  hasBoundingBox,
  boxFromElement,
  firstLayerName,
  scaleDenominatorLimits,
} from '../src/xml.mjs';

const WMS_CAPABILITIES = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Service><Name>WMS</Name></Service>
  <Capability>
    <Layer>
      <Layer>
        <Name>demo:layer_a</Name>
        <BoundingBox CRS="EPSG:4326" minx="27" miny="-19" maxx="44" maxy="5"/>
        <BoundingBox SRS="EPSG:25830" minx="100000" miny="4000000" maxx="200000" maxy="4100000"/>
        <Style><Name>default</Name></Style>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

const WCS_CAPABILITIES = `<?xml version="1.0"?>
<WCS_Capabilities version="1.0.0" xmlns="http://www.opengis.net/wcs">
  <ContentMetadata>
    <CoverageOfferingBrief>
      <name>demo:coverage_a</name>
      <lonLatEnvelope>
        <pos>-10 30</pos>
        <pos>10 50</pos>
      </lonLatEnvelope>
    </CoverageOfferingBrief>
  </ContentMetadata>
</WCS_Capabilities>`;

test('WMS 1.3 EPSG:4326 BoundingBox is un-swapped to lon/lat', () => {
  const [element] = parseElements(
    '<Layer xmlns="http://www.opengis.net/wms"><Name>x</Name>' +
      '<BoundingBox CRS="EPSG:4326" minx="27" miny="-19" maxx="44" maxy="5"/></Layer>'
  );
  const result = boxFromElement(element, 'EPSG:4326');
  assert.deepEqual(result.bounds, [-19, 27, 5, 44]);
  assert.equal(result.crs, 'EPSG:4326');
});

test('WMS 1.1 SRS BoundingBox is not swapped', () => {
  const [element] = parseElements(
    '<Layer xmlns="http://www.opengis.net/wms"><Name>x</Name>' +
      '<BoundingBox SRS="EPSG:4326" minx="-19" miny="27" maxx="5" maxy="44"/></Layer>'
  );
  const result = boxFromElement(element, 'EPSG:4326');
  assert.deepEqual(result.bounds, [-19, 27, 5, 44]);
});

test('CRS:84 BoundingBox is never swapped (always lon/lat, unlike EPSG:4326 in WMS 1.3)', () => {
  const [element] = parseElements(
    '<Layer xmlns="http://www.opengis.net/wms"><Name>x</Name>' +
      '<BoundingBox CRS="CRS:84" minx="-19" miny="27" maxx="5" maxy="44"/></Layer>'
  );
  const result = boxFromElement(element, 'CRS:84');
  assert.deepEqual(result.bounds, [-19, 27, 5, 44]);
  assert.equal(result.crs, 'CRS:84');
});

test('projected CRS BoundingBox is never swapped', () => {
  const [element] = parseElements(
    '<Layer xmlns="http://www.opengis.net/wms"><Name>x</Name>' +
      '<BoundingBox CRS="EPSG:25830" minx="100000" miny="4000000" maxx="200000" maxy="4100000"/></Layer>'
  );
  const result = boxFromElement(element, 'EPSG:25830');
  assert.deepEqual(result.bounds, [100000, 4000000, 200000, 4100000]);
});

test('WMS 1.1.1 LatLonBoundingBox is lon/lat order', () => {
  const [element] = parseElements(
    '<Layer xmlns="http://www.opengis.net/wms"><Name>x</Name>' +
      '<LatLonBoundingBox minx="-19" miny="27" maxx="5" maxy="44"/></Layer>'
  );
  const result = boxFromElement(element, 'EPSG:9999');
  assert.deepEqual(result.bounds, [-19, 27, 5, 44]);
  assert.equal(result.crs, 'EPSG:4326');
});

test('firstLayerName skips a nameless container layer', () => {
  const elements = parseElements(WMS_CAPABILITIES);
  assert.equal(firstLayerName(elements, 'wms'), 'demo:layer_a');
});

test('firstLayerName reads a WCS CoverageOfferingBrief', () => {
  const elements = parseElements(WCS_CAPABILITIES);
  assert.equal(firstLayerName(elements, 'wcs'), 'demo:coverage_a');
});

test('scaleDenominatorLimits reads MaxScaleDenominator on a real layer', () => {
  const [element] = parseElements(
    '<Layer xmlns="http://www.opengis.net/wms"><Name>x</Name>' +
      '<MaxScaleDenominator>40000.0</MaxScaleDenominator></Layer>'
  );
  assert.deepEqual(scaleDenominatorLimits(element), { min: null, max: 40000 });
});

test('scaleDenominatorLimits returns null when neither bound is declared', () => {
  const [element] = parseElements('<Layer xmlns="http://www.opengis.net/wms"><Name>x</Name></Layer>');
  assert.equal(scaleDenominatorLimits(element), null);
});

test('layerIdentifier + boxFromElement find the requested CRS on a real layer', () => {
  const elements = parseElements(WMS_CAPABILITIES);
  const layer = elements.find((el) => layerIdentifier(el, 'wms') === 'demo:layer_a');
  assert.ok(layer);
  assert.ok(hasBoundingBox(layer));
  const result = boxFromElement(layer, 'EPSG:25830');
  assert.deepEqual(result.bounds, [100000, 4000000, 200000, 4100000]);
  assert.equal(result.crs, 'EPSG:25830');
});
