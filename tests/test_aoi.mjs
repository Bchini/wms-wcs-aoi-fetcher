import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundsFromGeoJson } from '../web/aoi.js';

const POLYGON = { type: 'Polygon', coordinates: [[[10, 45], [11, 45], [11, 46], [10, 46], [10, 45]]] };

test('boundsFromGeoJson reads a bare Polygon geometry', () => {
  assert.deepEqual(boundsFromGeoJson(POLYGON), [10, 45, 11, 46]);
});

test('boundsFromGeoJson reads a Feature wrapping a Polygon', () => {
  assert.deepEqual(boundsFromGeoJson({ type: 'Feature', properties: {}, geometry: POLYGON }), [10, 45, 11, 46]);
});

test('boundsFromGeoJson unions every feature in a FeatureCollection', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]] } },
    ],
  };
  assert.deepEqual(boundsFromGeoJson(fc), [0, 0, 6, 6]);
});

test('boundsFromGeoJson reads a MultiPolygon', () => {
  const multi = {
    type: 'MultiPolygon',
    coordinates: [
      [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]],
    ],
  };
  assert.deepEqual(boundsFromGeoJson(multi), [0, 0, 6, 6]);
});

test('boundsFromGeoJson reads a GeometryCollection', () => {
  const gc = { type: 'GeometryCollection', geometries: [POLYGON, { type: 'Point', coordinates: [20, 50] }] };
  assert.deepEqual(boundsFromGeoJson(gc), [10, 45, 20, 50]);
});

test('boundsFromGeoJson rejects an empty FeatureCollection', () => {
  assert.throws(() => boundsFromGeoJson({ type: 'FeatureCollection', features: [] }), /No usable coordinates/);
});

test('boundsFromGeoJson rejects a single Point (no area)', () => {
  assert.throws(() => boundsFromGeoJson({ type: 'Point', coordinates: [10, 45] }), /no area/);
});

test('boundsFromGeoJson rejects a document with no type', () => {
  assert.throws(() => boundsFromGeoJson({ coordinates: [10, 45] }), /No usable coordinates/);
});
