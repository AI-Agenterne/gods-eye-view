import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { utmToLonLat } from './utm.js';
import { cleanText, normalizeGeometry, simplifyLine } from './geometry.js';
import { DATASETS, publicCatalog, wfsUrl } from './datasets.js';
import { denmarkProxy, normalizeDataset } from './index.js';

test('UTM 32N matches Mastedatabasen’s own WGS84 for the same antenna', () => {
  const [lon, lat] = utmToLonLat(707497, 6172235, 32);
  assert.ok(Math.abs(lon - 12.2980461668132) < 1e-6);
  assert.ok(Math.abs(lat - 55.651577357159) < 1e-6);
});

test('simplifyLine keeps endpoints and drops collinear points', () => {
  const line = [
    [0, 0],
    [1, 0.00001],
    [2, 0],
    [3, 1],
  ];
  assert.deepEqual(simplifyLine(line, 0.001), [
    [0, 0],
    [2, 0],
    [3, 1],
  ]);
});

test('normalizeGeometry rounds, rejects bad coordinates and degenerate rings', () => {
  assert.deepEqual(
    normalizeGeometry({ type: 'Point', coordinates: [10.123456789, 56.1] }),
    { type: 'Point', coordinates: [10.12346, 56.1] },
  );
  assert.equal(
    normalizeGeometry({ type: 'Point', coordinates: [200, 0] }),
    null,
  );
  assert.equal(
    normalizeGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    }),
    null,
  );
  assert.equal(normalizeGeometry({ type: 'GeometryCollection' }), null);
});

test('cleanText strips markup and decodes the entities Niord uses', () => {
  assert.equal(cleanText('<p>55&deg; 13.6&#39;N&nbsp;x</p>'), "55° 13.6'N x");
  assert.equal(cleanText('n/a'), '');
  assert.equal(cleanText('x'.repeat(10), 5), 'xxxx…');
});

test('normalizeDataset reprojects UTM sources and drops undrawable features', () => {
  const features = normalizeDataset({
    epsg: 25832,
    features: [
      {
        geometry: { type: 'Point', coordinates: [707497, 6172235] },
        properties: { title: 'a' },
      },
      { geometry: null, properties: { title: 'b' } },
    ],
  });
  assert.equal(features.length, 1);
  assert.deepEqual(features[0].geometry.coordinates, [12.29805, 55.65158]);
});

test('registry ids are unique, routable and every entry is credited', () => {
  const ids = DATASETS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of publicCatalog()) {
    assert.match(d.id, /^[a-z0-9-]{1,40}$/);
    assert.ok(d.credit && d.licence, `${d.id} needs credit and licence`);
  }
  assert.match(
    wfsUrl('https://example.test/wfs', 'x:y', { bbox: [1, 2, 3, 4] }),
    /bbox=1%2C2%2C3%2C4%2CEPSG%3A4326/,
  );
});

/** A minimal Node-style response recorder for the middleware. */
function recorder() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      this.body = body;
    },
  };
}

test('proxy serves a dataset, caches it, and falls back to stale on failure', async () => {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-dk-'));
  let clock = 1_000_000;
  let calls = 0;
  let fail = false;
  const fetchImpl = async () => {
    calls += 1;
    if (fail) return new Response('nope', { status: 503 });
    return new Response(
      JSON.stringify([
        {
          wgs84koordinat: { bredde: '56.15', laengde: '10.2' },
          teknologi: { navn: '5G NR' },
          vejnavn: { navn: 'Testvej' },
          postnummer: { nr: '8000', navn: 'Aarhus C' },
        },
      ]),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const proxy = denmarkProxy({ fetchImpl, cacheDir, now: () => clock });

  const first = recorder();
  await proxy.handle({ method: 'GET', url: '/features/masts' }, first);
  assert.equal(first.status, 200);
  const body = JSON.parse(first.body);
  assert.equal(body.features.length, 1);
  assert.equal(body.features[0].properties.category, '5G');
  assert.equal(calls, 1);

  const cached = recorder();
  await proxy.handle({ method: 'GET', url: '/features/masts' }, cached);
  assert.equal(calls, 1, 'a fresh dataset is served from memory');

  clock += 8 * 24 * 3_600_000;
  fail = true;
  const stale = recorder();
  await proxy.handle({ method: 'GET', url: '/features/masts' }, stale);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-DK-Status'], 'stale');

  const unknown = recorder();
  await proxy.handle({ method: 'GET', url: '/features/../../etc' }, unknown);
  assert.equal(unknown.status, 404);

  const catalog = recorder();
  await proxy.handle({ method: 'GET', url: '/datasets' }, catalog);
  assert.ok(JSON.parse(catalog.body).datasets.some((d) => d.id === 'masts'));
  await fsp.rm(cacheDir, { recursive: true, force: true });
});
