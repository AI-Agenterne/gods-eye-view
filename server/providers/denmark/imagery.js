/**
 * Raster overlays for the Denmark pack, proxied as WMS GetMap tiles.
 *
 * Like the vector registry, every upstream base URL and layer name is fixed
 * here. A tile request may choose only the bounding box, the tile size and
 * one of the projections Cesium asks for; the proxy names the layer itself.
 * Keyed services (Dataforsyningen, wave C) add their token server-side here.
 */

const DAY = 86_400_000;

export const IMAGERY_DATASETS = [
  {
    id: 'ship-density',
    kind: 'wms',
    label: 'Ship traffic density (annual)',
    group: 'Sea',
    color: '#22c55e',
    ttlMs: 30 * DAY,
    credit: 'EMODnet Human Activities — vessel density (EMSA)',
    creditUrl: 'https://emodnet.ec.europa.eu/en/human-activities',
    licence: 'CC BY 4.0',
    wms: {
      base: 'https://ows.emodnet-humanactivities.eu/wms',
      layers: 'vesseldensity_allavg',
    },
  },
];

const PROJECTIONS = new Set(['EPSG:4326', 'EPSG:3857']);
const MAX_TILE_PX = 1024;

/**
 * Build the upstream GetMap URL for one tile, or null when the request is
 * not a tile this proxy serves.
 * @param {{wms: {base: string, layers: string}}} dataset
 * @param {URLSearchParams} query The client's query (keys case-insensitive).
 * @returns {string|null}
 */
export function wmsTileUrl(dataset, query) {
  const param = (name) => {
    for (const [key, value] of query)
      if (key.toLowerCase() === name) return value;
    return null;
  };
  const bbox = String(param('bbox') || '')
    .split(',')
    .map(Number);
  const width = Number(param('width'));
  const height = Number(param('height'));
  const srs = String(param('srs') || param('crs') || '').toUpperCase();
  if (
    bbox.length !== 4 ||
    !bbox.every(Number.isFinite) ||
    bbox[0] >= bbox[2] ||
    bbox[1] >= bbox[3] ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_TILE_PX ||
    height > MAX_TILE_PX ||
    !PROJECTIONS.has(srs)
  )
    return null;
  // WMS 1.1.1 keeps lon/lat axis order for EPSG:4326, as Cesium sends it.
  const upstream = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: dataset.wms.layers,
    styles: '',
    srs,
    bbox: bbox.join(','),
    width: String(width),
    height: String(height),
    format: 'image/png',
    transparent: 'true',
  });
  return `${dataset.wms.base}?${upstream}`;
}
