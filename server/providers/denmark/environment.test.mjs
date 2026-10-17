import test from 'node:test';
import assert from 'node:assert/strict';

import {
  areaKm2,
  band,
  jsonStatValues,
  latestSubstations,
  municipalityKey,
} from './environment.js';

test('areaKm2 subtracts holes from projected polygons', () => {
  const square = (x, y, size) => [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
  // 10 km × 10 km with a 2 km × 2 km hole.
  const polygon = {
    type: 'Polygon',
    coordinates: [square(0, 0, 10_000), square(1000, 1000, 2000)],
  };
  assert.equal(areaKm2(polygon), 96);
  assert.equal(
    areaKm2({ type: 'MultiPolygon', coordinates: [polygon.coordinates] }),
    96,
  );
  assert.equal(areaKm2({ type: 'Point', coordinates: [0, 0] }), 0);
});

test('municipality keys and bands', () => {
  assert.equal(municipalityKey(101), '101');
  assert.equal(municipalityKey('85'), '085');
  const bands = [
    [50, 'low'],
    [Infinity, 'high'],
  ];
  assert.equal(band(10, bands), 'low');
  assert.equal(band(50, bands), 'high');
});

test('latestSubstations keeps the newest publication, current grid first', () => {
  const rows = latestSubstations([
    {
      publication_date: '2025-06-01',
      TSO_station_name: 'A',
      grid_precondition: 'current_grid',
    },
    {
      publication_date: '2025-12-01',
      TSO_station_name: 'A',
      grid_precondition: 'reinforced_grid',
    },
    {
      publication_date: '2025-12-01',
      TSO_station_name: 'A',
      grid_precondition: 'current_grid',
    },
    {
      publication_date: '2025-12-01',
      TSO_station_name: 'B',
      grid_precondition: 'reinforced_grid',
    },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.TSO_station_name, r.grid_precondition]),
    [
      ['A', 'current_grid'],
      ['B', 'reinforced_grid'],
    ],
  );
});

test('jsonStatValues maps category codes to values', () => {
  const body = {
    dataset: {
      dimension: { OMRÅDE: { category: { index: { '000': 0, 101: 1 } } } },
      value: [6_000_000, 670_000],
    },
  };
  assert.equal(jsonStatValues(body, 'OMRÅDE').get('101'), 670_000);
  assert.throws(() => jsonStatValues({}, 'OMRÅDE'), /jsonstat_malformed/);
});
