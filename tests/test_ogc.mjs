import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wmsBbox,
  wmsCrsParameter,
  bboxParamToGeographic,
  serviceUrl,
  tileGrid,
  planWmsTiles,
} from '../web/ogc.js';

test('wmsBbox: WMS 1.3 EPSG:4326 uses latitude first', () => {
  assert.equal(wmsBbox(1, 2, 3, 4, 'EPSG:4326', '1.3.0'), '2,1,4,3');
});

test('wmsBbox: WMS 1.1.1 keeps easting first', () => {
  assert.equal(wmsBbox(1, 2, 3, 4, 'EPSG:4326', '1.1.1'), '1,2,3,4');
});

test('wmsBbox: projected CRS is never swapped, any version', () => {
  assert.equal(wmsBbox(1, 2, 3, 4, 'EPSG:31982', '1.3.0'), '1,2,3,4');
});

test('wmsCrsParameter matches version', () => {
  assert.equal(wmsCrsParameter('1.3.0'), 'CRS');
  assert.equal(wmsCrsParameter('1.1.1'), 'SRS');
});

test('bboxParamToGeographic is the inverse of wmsBbox', () => {
  const wire = wmsBbox(1, 2, 3, 4, 'EPSG:4326', '1.3.0').split(',').map(Number);
  assert.deepEqual(bboxParamToGeographic(wire, 'EPSG:4326', '1.3.0'), [1, 2, 3, 4]);
});

test('bboxParamToGeographic leaves non-4326/non-1.3 alone', () => {
  assert.deepEqual(bboxParamToGeographic([1, 2, 3, 4], 'EPSG:31982', '1.3.0'), [1, 2, 3, 4]);
  assert.deepEqual(bboxParamToGeographic([1, 2, 3, 4], 'EPSG:4326', '1.1.1'), [1, 2, 3, 4]);
});

test('serviceUrl extends an endpoint that already has a query string', () => {
  assert.equal(
    serviceUrl('https://example.test/wms?token=x', { request: 'GetMap' }),
    'https://example.test/wms?token=x&request=GetMap'
  );
});

test('serviceUrl adds a leading ? when the endpoint has none', () => {
  assert.equal(serviceUrl('https://example.test/wms', { a: '1' }), 'https://example.test/wms?a=1');
});

test('tileGrid: exact multiple of tile size', () => {
  assert.deepEqual(tileGrid(0, 0, 2048, 1024, 1024, 1024, 1), { cols: 2, rows: 1 });
});

test('tileGrid: never returns zero tiles for a nonempty extent', () => {
  assert.deepEqual(tileGrid(0, 0, 0.5, 0.5, 1024, 1024, 1), { cols: 1, rows: 1 });
});

test('planWmsTiles: single tile covers the whole extent', () => {
  const tiles = planWmsTiles({ minx: 0, miny: 0, maxx: 10, maxy: 10, tileW: 1024, tileH: 1024, resolution: 1 });
  assert.equal(tiles.length, 1);
  assert.deepEqual(
    [tiles[0].txmin, tiles[0].tymin, tiles[0].txmax, tiles[0].tymax],
    [0, 0, 10, 10]
  );
  assert.equal(tiles[0].width, 10);
  assert.equal(tiles[0].height, 10);
});

test('planWmsTiles: multiple tiles partition the extent without gaps or overlap', () => {
  const tiles = planWmsTiles({ minx: 0, miny: 0, maxx: 20, maxy: 10, tileW: 10, tileH: 10, resolution: 1 });
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].txmin, 0);
  assert.equal(tiles[0].txmax, 10);
  assert.equal(tiles[1].txmin, 10);
  assert.equal(tiles[1].txmax, 20);
});
