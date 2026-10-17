import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CYBER_DATASETS,
  cityKey,
  placeCity,
  radiusFor,
} from './cyber.js';
import { publicCatalog } from './datasets.js';

const [dataset] = CYBER_DATASETS;

/** A host/count answer that also carries every device field Shodan can return. */
function answer(cities, extra = {}) {
  return {
    total: cities.reduce((s, [, n]) => s + n, 0),
    facets: {
      city: cities.map(([value, count]) => ({ value, count })),
      port: [{ value: 443, count: 900 }],
      product: [{ value: 'nginx', count: 300 }],
    },
    matches: [
      {
        ip_str: '192.0.2.44',
        ipv6: '2001:db8::7',
        org: 'Secret Water Utility A/S',
        hostnames: ['scada.example.dk'],
        http: { html: '<title>Login</title>' },
        screenshot: { data: 'iVBORw0K' },
      },
    ],
    ...extra,
  };
}

async function withKey(value, fn) {
  const previous = process.env.SHODAN_API_KEY;
  if (value == null) delete process.env.SHODAN_API_KEY;
  else process.env.SHODAN_API_KEY = value;
  try {
    return await fn();
  } finally {
    if (previous == null) delete process.env.SHODAN_API_KEY;
    else process.env.SHODAN_API_KEY = previous;
  }
}

test('cyber-exposure passes on counts only, never a device detail', async () => {
  const out = await withKey('k-test', () =>
    dataset.load({
      fetchJson: async () =>
        answer([
          ['Aarhus', 4000],
          ['Copenhagen', 20000],
          ['Atlantis', 7],
        ]),
      wait: async () => {},
    }),
  );
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /\b\d{1,3}(\.\d{1,3}){3}\b/, 'no IPv4');
  assert.doesNotMatch(text, /2001:db8/i, 'no IPv6');
  for (const leak of ['Secret Water', 'scada.example', 'Login', 'iVBOR', 'k-test'])
    assert.ok(!text.includes(leak), `leaked ${leak}`);
  for (const f of out.features) assert.equal(f.properties.url, undefined);
  const aarhus = out.features.find((f) => f.properties.title === 'Aarhus');
  assert.equal(aarhus.properties.subtitle, '4,000 internet-facing services');
  const summary = out.features.at(-1).properties;
  assert.deepEqual(summary.info.at(-1), ['Not placed on map', '7 · Atlantis']);
});

test('cyber-exposure is listed only when a key is set', async () => {
  const listed = () => publicCatalog().some((d) => d.id === 'cyber-exposure');
  assert.equal(await withKey(null, listed), false);
  assert.equal(await withKey('k', listed), true);
  await withKey(null, () =>
    assert.rejects(dataset.load({ fetchJson: async () => ({}) }), /no_key/),
  );
});

test('city names fold to one place across spellings', () => {
  assert.equal(cityKey('Århus'), cityKey('Aarhus'));
  assert.equal(placeCity('Århus').name, 'Aarhus');
  assert.equal(placeCity('Koge').name, 'Køge');
  assert.equal(placeCity('Copenhagen').name, 'København');
  assert.equal(placeCity('Atlantis'), null);
});

test('queries run one at a time, spaced, and a failing category is isolated', async () => {
  let active = 0;
  let peak = 0;
  let waits = 0;
  let calls = 0;
  const out = await withKey('k', () =>
    dataset.load({
      fetchJson: async (url) => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 2));
        active -= 1;
        if (url.includes('port%3A554')) throw new Error('upstream_http_403');
        return answer([['Aarhus', 50]]);
      },
      wait: async () => {
        waits += 1;
      },
    }),
  );
  assert.equal(peak, 1);
  assert.equal(calls, 5);
  assert.equal(waits, 4);
  const rows = out.features[0].properties.info;
  assert.deepEqual(rows.find(([l]) => l.includes('RTSP')), [
    'Video streams (RTSP)',
    'unavailable',
  ]);
});

test('circle radius grows with the count inside its bounds', () => {
  assert.equal(radiusFor(1), 800);
  assert.ok(radiusFor(10_000) > radiusFor(1_000));
  assert.equal(radiusFor(1e9), 12_000);
});
