import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { IMAGERY_DATASETS, wmsTileUrl } from './imagery.js';
import { denmarkProxy } from './index.js';

const density = IMAGERY_DATASETS.find((d) => d.id === 'ship-density');
const query = (params) => new URLSearchParams(params);
const TILE = {
  SERVICE: 'WMS',
  REQUEST: 'GetMap',
  LAYERS: 'anything-the-client-says',
  BBOX: '9,54,11.25,56.25',
  WIDTH: '256',
  HEIGHT: '256',
  SRS: 'EPSG:4326',
};

test('wmsTileUrl fixes the layer and accepts only tile geometry', () => {
  const url = new URL(wmsTileUrl(density, query(TILE)));
  assert.equal(url.origin + url.pathname, density.wms.base);
  assert.equal(url.searchParams.get('layers'), 'vesseldensity_allavg');
  assert.equal(url.searchParams.get('bbox'), '9,54,11.25,56.25');
  assert.equal(url.searchParams.get('srs'), 'EPSG:4326');
  for (const bad of [
    { ...TILE, BBOX: '1,2,3' },
    { ...TILE, BBOX: '11,54,9,56' },
    { ...TILE, WIDTH: '4096' },
    { ...TILE, SRS: 'EPSG:25832' },
  ])
    assert.equal(wmsTileUrl(density, query(bad)), null);
});

function recorder() {
  return {
    status: 0,
    headers: {},
    body: null,
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

test('proxy serves WMS tiles from cache and refuses non-images', async () => {
  const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-dk-wms-'));
  let calls = 0;
  let type = 'image/png';
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(
      String(url),
      /^https:\/\/ows\.emodnet-humanactivities\.eu\/wms\?/,
    );
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { 'content-type': type },
    });
  };
  const proxy = denmarkProxy({ fetchImpl, cacheDir });
  const tileUrl = `/wms/ship-density?${query(TILE)}`;

  const first = recorder();
  await proxy.handle({ method: 'GET', url: tileUrl }, first);
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Type'], 'image/png');
  const again = recorder();
  await proxy.handle({ method: 'GET', url: tileUrl }, again);
  assert.equal(calls, 1, 'a cached tile is not refetched');

  const bad = recorder();
  await proxy.handle({ method: 'GET', url: '/wms/ship-density?BBOX=1' }, bad);
  assert.equal(bad.status, 400);

  const notRaster = recorder();
  await proxy.handle(
    { method: 'GET', url: `/wms/masts?${query(TILE)}` },
    notRaster,
  );
  assert.equal(notRaster.status, 404);
  const notFeatures = recorder();
  await proxy.handle(
    { method: 'GET', url: '/features/ship-density' },
    notFeatures,
  );
  assert.equal(notFeatures.status, 404);

  type = 'text/xml';
  const xml = recorder();
  await proxy.handle(
    {
      method: 'GET',
      url: `/wms/ship-density?${query({ ...TILE, WIDTH: '128' })}`,
    },
    xml,
  );
  assert.equal(xml.status, 502, 'a WMS error document is not served as a tile');
  await fsp.rm(cacheDir, { recursive: true, force: true });
});
