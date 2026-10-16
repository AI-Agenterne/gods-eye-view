import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';

const FEATURES = {
  'drone-zones': [
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [10.0, 56.0],
            [10.4, 56.0],
            [10.4, 56.3],
            [10.0, 56.3],
            [10.0, 56.0],
          ],
        ],
      },
      properties: {
        title: 'Aarhus zone',
        category: 'Red',
        info: [['Type', 'Civil Lufthavn']],
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [12.6, 55.6] },
      properties: { title: 'Copenhagen', info: [] },
    },
  ],
};

const denmark = {
  async getCatalog() {
    return [
      {
        id: 'drone-zones',
        label: 'Drone no-fly zones',
        group: 'Defence',
        licence: 'x',
      },
    ];
  },
  async getFeatures(id) {
    return { features: FEATURES[id] || [] };
  },
};

test('denmark_in_area returns features touching the area, nearest first', async () => {
  const catalog = composeCatalog({ tools: coreTools, services: { denmark } });
  const result = await catalog.call('denmark_in_area', {
    area: { lat: 56.15, lon: 10.2, radius_km: 50 },
    datasets: ['drone-zones'],
  });
  const section = result.data.sections['drone-zones'];
  assert.equal(section.rows.length, 1, 'Copenhagen is outside 50 km of Aarhus');
  assert.equal(section.rows[0].title, 'Aarhus zone');
  assert.equal(section.rows[0].details.Type, 'Civil Lufthavn');
  assert.match(result.summary, /1 drone no-fly zones/);
});

test('denmark_in_area lists the catalog, refuses unknown ids and stays quiet abroad', async () => {
  const catalog = composeCatalog({ tools: coreTools, services: { denmark } });
  const listing = await catalog.call('denmark_in_area', {
    area: { lat: 56, lon: 10, radius_km: 10 },
  });
  assert.equal(listing.data.datasets[0].id, 'drone-zones');
  await assert.rejects(
    catalog.call('denmark_in_area', {
      area: { lat: 56, lon: 10, radius_km: 10 },
      datasets: ['nope'],
    }),
    /unknown Denmark dataset/,
  );
  const abroad = await catalog.call('denmark_in_area', {
    area: { lat: 40.7, lon: -74, radius_km: 20 },
    datasets: ['drone-zones'],
  });
  assert.match(abroad.summary, /outside the Denmark pack/);
});
