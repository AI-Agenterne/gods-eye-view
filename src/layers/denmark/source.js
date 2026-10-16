import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Monuments, the largest dataset, is ~11 MB; leave headroom for growth. */
const MAX_FEATURES_BYTES = 48 * 1024 * 1024;
const MAX_CATALOG_BYTES = 256 * 1024;

/**
 * Client for the Denmark pack proxy (`server/providers/denmark`). The proxy
 * owns every upstream URL; this source only names registry ids.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] Injected fetch, for tests.
 * @param {string} [options.base='/api/dk'] Proxy mount point.
 * @returns {{getCatalog: Function, getFeatures: Function}}
 */
export function createDenmarkSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = '/api/dk',
} = {}) {
  const getJson = async (url, maxBytes, signal) => {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.json())?.detail || '';
      } catch {
        /* body is not JSON */
      }
      throw new Error(detail || `HTTP ${response.status}`);
    }
    return {
      body: await readResponseJsonCapped(response, maxBytes, signal),
      status: response.headers.get('x-dk-status') || 'ready',
    };
  };

  return {
    /** @returns {Promise<Array<object>>} The dataset catalog. */
    async getCatalog({ signal } = {}) {
      const { body } = await getJson(
        `${base}/datasets`,
        MAX_CATALOG_BYTES,
        signal,
      );
      if (!Array.isArray(body?.datasets))
        throw new Error('Malformed Denmark catalog');
      return body.datasets;
    },

    /** @returns {Promise<{features: Array<object>, fetchedAt: number, status: string}>} */
    async getFeatures(id, { signal } = {}) {
      if (!/^[a-z0-9-]{1,40}$/.test(id))
        throw new TypeError(`Bad dataset id: ${id}`);
      const { body, status } = await getJson(
        `${base}/features/${id}`,
        MAX_FEATURES_BYTES,
        signal,
      );
      if (!Array.isArray(body?.features))
        throw new Error(`Malformed dataset: ${id}`);
      return { features: body.features, fetchedAt: body.fetchedAt, status };
    },
  };
}
