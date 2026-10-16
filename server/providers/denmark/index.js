import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  readResponseBytesCapped,
  readResponseTextCapped,
} from '../common/http.js';
import { DATASET_BY_ID, publicCatalog } from './datasets.js';
import { normalizeGeometry, projector } from './geometry.js';

/** Hard ceilings so one runaway upstream cannot exhaust memory or the client. */
const MAX_FEATURES = 120_000;
const MAX_VERTICES = 4_000_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;

/**
 * Normalize a dataset's loader output into the GeoJSON the client draws:
 * WGS84, rounded, simplified, capped. Features that cannot be drawn drop out.
 * @param {{features: object[], epsg?: number, tolerance?: number}} loaded
 * @returns {object[]}
 */
export function normalizeDataset({ features, epsg = 4326, tolerance = 0 }) {
  if (!Array.isArray(features)) throw new Error('dataset_malformed');
  const project = projector(epsg);
  const budget = { vertices: MAX_VERTICES };
  const out = [];
  for (const raw of features) {
    if (out.length >= MAX_FEATURES || budget.vertices <= 0) break;
    const geometry = normalizeGeometry(raw?.geometry, {
      project,
      tolerance,
      budget,
    });
    if (geometry)
      out.push({ type: 'Feature', geometry, properties: raw.properties });
  }
  return out;
}

/**
 * Denmark pack proxy.
 *
 *   GET /api/dk/datasets        → the registry's public catalog
 *   GET /api/dk/features/<id>   → that dataset as a GeoJSON FeatureCollection
 *
 * Each dataset is cached in memory and on disk (`.gev-cache/dk/<id>.json`)
 * for its own TTL, refreshed single-flight, and served stale when the
 * upstream fails. Only registry ids are routable.
 */
export function denmarkProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'dk'),
  timeoutMs = 120_000,
} = {}) {
  /** @type {Map<string, {at:number, body:string, count:number}>} */
  const memory = new Map();
  /** @type {Map<string, Promise<object>>} */
  const inflight = new Map();
  /** @type {Map<string, number>} */
  const failedAt = new Map();

  /** One bounded upstream GET; `read` consumes the body under the cap. */
  const fetchCapped = async (url, maxBytes, read, deadlineMs = timeoutMs) => {
    const signal = AbortSignal.timeout(deadlineMs);
    const response = await fetchImpl(url, {
      signal,
      headers: {
        Accept: 'application/json,application/geo+json,*/*;q=0.5',
        'User-Agent': 'Gods Eye View (Denmark pack; local install)',
      },
    });
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new Error(`upstream_http_${response.status}`);
    }
    return read(response, maxBytes, signal);
  };
  const fetchJson = async (url, maxBytes) =>
    JSON.parse(await fetchCapped(url, maxBytes, readResponseTextCapped));
  const fetchText = (url, maxBytes) =>
    fetchCapped(url, maxBytes, readResponseTextCapped);
  const fetchBytes = async (url, maxBytes) =>
    Buffer.from(await fetchCapped(url, maxBytes, readResponseBytesCapped));
  /** A streamed body for multi-hundred-MB archives; the caller bounds work. */
  const fetchStream = (url, deadlineMs = 30 * 60_000) =>
    fetchCapped(url, Infinity, (response) => response.body, deadlineMs);

  const diskPath = (id) => path.join(cacheDir, `${id}.json`);

  async function readDisk(id) {
    try {
      const entry = JSON.parse(await fsp.readFile(diskPath(id), 'utf8'));
      if (Number.isFinite(entry?.at) && typeof entry.body === 'string')
        return entry;
    } catch {
      /* no disk copy yet */
    }
    return null;
  }

  async function refresh(dataset) {
    const features = normalizeDataset(
      await dataset.load({
        fetchJson,
        fetchText,
        fetchBytes,
        fetchStream,
        now: now(),
      }),
    );
    if (!features.length && !dataset.allowEmpty)
      throw new Error('dataset_empty');
    const at = now();
    const body = JSON.stringify({
      type: 'FeatureCollection',
      id: dataset.id,
      fetchedAt: at,
      features,
    });
    const entry = { at, body, count: features.length };
    memory.set(dataset.id, entry);
    failedAt.delete(dataset.id);
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(diskPath(dataset.id), JSON.stringify(entry));
    } catch (error) {
      console.warn(`[dk] cache write failed for ${dataset.id}:`, error.message);
    }
    return entry;
  }

  /** Resolve a dataset: fresh cache, else refresh, else stale, else throw. */
  async function resolve(dataset) {
    let entry = memory.get(dataset.id) || (await readDisk(dataset.id));
    if (entry) memory.set(dataset.id, entry);
    const fresh = entry && now() - entry.at < dataset.ttlMs;
    const backingOff =
      now() - (failedAt.get(dataset.id) ?? -Infinity) < FAILURE_BACKOFF_MS;
    if (fresh || (entry && backingOff))
      return { entry, status: fresh ? 'ready' : 'stale' };
    if (!inflight.has(dataset.id)) {
      inflight.set(
        dataset.id,
        refresh(dataset).finally(() => inflight.delete(dataset.id)),
      );
    }
    try {
      return { entry: await inflight.get(dataset.id), status: 'ready' };
    } catch (error) {
      failedAt.set(dataset.id, now());
      console.warn(`[dk] ${dataset.id} refresh failed:`, error.message);
      if (entry) return { entry, status: 'stale' };
      throw error;
    }
  }

  const send = (res, status, body, extra = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(body);
  };

  async function handle(req, res) {
    if (req.method !== 'GET')
      return send(res, 405, '{"error":"method_not_allowed"}');
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/datasets' || pathname === '/datasets/') {
      const catalog = publicCatalog().map((d) => ({
        ...d,
        count: memory.get(d.id)?.count ?? null,
      }));
      return send(res, 200, JSON.stringify({ datasets: catalog }));
    }
    const match = /^\/features\/([a-z0-9-]{1,40})$/.exec(pathname);
    const dataset = match && DATASET_BY_ID.get(match[1]);
    if (!dataset) return send(res, 404, '{"error":"unknown_dataset"}');
    try {
      const { entry, status } = await resolve(dataset);
      return send(res, 200, entry.body, {
        'X-DK-Status': status,
        'X-DK-Fetched-At': new Date(entry.at).toISOString(),
      });
    } catch (error) {
      return send(
        res,
        502,
        JSON.stringify({
          error: 'upstream_unavailable',
          detail: error.message,
        }),
      );
    }
  }

  function install(server) {
    server.middlewares.use('/api/dk', (req, res) => {
      handle(req, res).catch((error) => {
        console.warn('[dk] handler error:', error);
        if (!res.headersSent) send(res, 500, '{"error":"internal"}');
      });
    });
  }

  return {
    name: 'denmark-proxy',
    configureServer: install,
    configurePreviewServer: install,
    /** Exposed for tests and warm-up scripts. */
    resolve: (id) => resolve(DATASET_BY_ID.get(id)),
    handle,
  };
}
