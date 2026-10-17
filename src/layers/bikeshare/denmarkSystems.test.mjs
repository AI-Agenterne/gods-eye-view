import assert from 'node:assert/strict';
import test from 'node:test';
import { CITY_BY_ID } from './registry.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../data/gbfsSource.js';
import { parseStationStatus } from '../../sources/gbfsStations.js';

// The farthest hub from each registered centre in the live feed (checked
// 2026-10-17): Copenhagen's feed runs out to Hillerød.
const SYSTEMS = {
  'donkey-copenhagen': { lat: 55.9279133, lon: 12.3106, maxKm: 40 },
  'donkey-aarhus': { lat: 56.2027976, lon: 10.2814677, maxKm: 15 },
};

const km = (a, b) => {
  const r = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) *
      Math.cos(b.lat * r) *
      Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

test('Donkey Republic Copenhagen and Aarhus are registered and proxied', () => {
  for (const [id, far] of Object.entries(SYSTEMS)) {
    const system = CITY_BY_ID.get(id);
    assert.ok(system, `${id} is registered`);
    assert.equal(system.provider, 'Donkey Republic');
    assert.equal(system.loadRadiusKm, far.maxKm);
    for (const feed of [
      system.stationInformationUrl,
      system.stationStatusUrl,
    ]) {
      const url = new URL(feed);
      assert.ok(isAllowedGbfsHost(url.hostname));
      assert.ok(isAllowedGbfsPath(url.pathname, url.hostname));
    }
    const centre = { lat: system.centerLat, lon: system.centerLon };
    assert.ok(km(centre, far) < far.maxKm, `${id} reaches its farthest hub`);
  }
  assert.ok(!isAllowedGbfsPath('/api/private/x', 'stables.donkey.bike'));
});

test('GBFS 3.0 station_status counts vehicles and parses RFC 3339 time', () => {
  const status = parseStationStatus({
    data: {
      stations: [
        {
          station_id: '6218',
          num_vehicles_available: 2,
          num_docks_available: 0,
          last_reported: '2026-10-16T05:19:23Z',
        },
      ],
    },
  }).get('6218');
  assert.equal(status.bikesAvailable, 2);
  assert.equal(status.lastReported, Date.UTC(2026, 9, 16, 5, 19, 23) / 1000);
});
