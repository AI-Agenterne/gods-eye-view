import * as Cesium from 'cesium';
export { createDenmarkSource } from './source.js';

export const DENMARK_LAYER_ID = 'denmark';
const PICK_PREFIX = 'dk:';
const STORAGE_KEY = 'gev:denmark:datasets:v1';
const DEFAULT_DATASETS = [
  'drone-zones',
  'military-sea-areas',
  'nav-warnings',
  'wind-farms',
  'subsea-lines',
  'gps-jamming',
];
/** Datasets drawn as 3D volumes, with their ceiling in metres. */
const EXTRUDE_M = { 'drone-zones': 120 };
/** Dense national registers draw smaller so sparse layers stay legible. */
const POINT_SIZE = {
  lightning: 10,
  'transit-sim': 6,
  bridges: 5,
  'power-flows': 12,
  monuments: 4,
  masts: 5,
  wrecks: 5,
  'wind-turbines': 5,
  outdoors: 5,
};
/** Points stay visible over photoreal terrain within this camera distance. */
const POINT_DEPTH_TEST_DISTANCE_M = 2_000_000;
/** Refetch an active dataset at most this often; the proxy caches per TTL. */
const REFRESH_MS = 10 * 60_000;
/** The fastest any dataset refetches (the timetable simulation, every 20 s). */
const MIN_REFRESH_MS = 20_000;

const readStoredSelection = () => {
  try {
    const stored = JSON.parse(
      globalThis.localStorage?.getItem(STORAGE_KEY) || 'null',
    );
    return Array.isArray(stored)
      ? stored.filter((id) => typeof id === 'string')
      : null;
  } catch {
    return null;
  }
};
const storeSelection = (ids) => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable: selection lasts for this session only */
  }
};

/** Representative lon/lat for a feature, used for the card and fly-to. */
export function featureAnchor(geometry) {
  let coords = geometry?.coordinates;
  while (Array.isArray(coords?.[0])) coords = coords[0];
  return Array.isArray(coords) && coords.length >= 2 ? coords : null;
}

/** The colour a feature draws in: its category's, else the dataset's. */
export function featureColor(dataset, properties) {
  return (
    dataset.categories?.[properties?.category] || dataset.color || '#e5e7eb'
  );
}

/**
 * One layer, many Danish datasets. The row's chips switch individual
 * datasets on and off; each dataset loads lazily from the Denmark proxy the
 * first time it is switched on and is drawn with primitives (points) or
 * entities (lines, areas, buffered points).
 * @param {object} options
 * @param {{getCatalog: Function, getFeatures: Function}} options.source
 * @param {object} options.services Application scene owners.
 */
export function createDenmarkLayer({ source, services = {} } = {}) {
  if (typeof source?.getFeatures !== 'function')
    throw new TypeError('Denmark layer requires a feature source');
  const { picking, context, render, isPointerFree = () => true } = services;

  let viewer = null;
  let enabled = false;
  let catalog = [];
  let catalogError = null;
  let catalogPromise = null;
  let active = new Set(readStoredSelection() || DEFAULT_DATASETS);
  let focus = null;
  let clickHandler = null;
  let card = null;
  let listener = null;
  let lastUpdate = null;
  /** @type {Map<string, object>} dataset id → render bucket */
  const buckets = new Map();

  const notify = () => listener?.();
  const requestRender = () => render?.governorRequestRender?.(DENMARK_LAYER_ID);
  const datasetById = (id) => catalog.find((d) => d.id === id);

  function bucketFor(id) {
    let bucket = buckets.get(id);
    if (!bucket) {
      const points = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      const dataSource = new Cesium.CustomDataSource(`denmark:${id}`);
      viewer.scene.primitives.add(points);
      viewer.dataSources.add(dataSource);
      bucket = {
        points,
        dataSource,
        features: [],
        loadedAt: 0,
        loading: null,
        error: null,
      };
      buckets.set(id, bucket);
    }
    return bucket;
  }

  function showBucket(id, show) {
    const bucket = buckets.get(id);
    if (!bucket) return;
    bucket.points.show = show;
    bucket.dataSource.show = show;
  }

  function draw(dataset, bucket) {
    bucket.points.removeAll();
    bucket.dataSource.entities.removeAll();
    const extrude = EXTRUDE_M[dataset.id];
    const entities = bucket.dataSource.entities;
    entities.suspendEvents();
    bucket.features.forEach((feature, index) => {
      const { geometry, properties: props } = feature;
      const color = Cesium.Color.fromCssColorString(
        featureColor(dataset, props),
      );
      const id = `${PICK_PREFIX}${dataset.id}:${index}`;
      const fill = color.withAlpha(extrude ? 0.18 : 0.28);
      const addPoint = ([lon, lat]) => {
        if (props.radiusM) {
          entities.add({
            id: `${id}:${entities.values.length}`,
            position: Cesium.Cartesian3.fromDegrees(lon, lat),
            ellipse: {
              semiMajorAxis: props.radiusM,
              semiMinorAxis: props.radiusM,
              material: fill,
              ...(extrude
                ? {
                    height: 0,
                    extrudedHeight: extrude,
                    outline: true,
                    outlineColor: color,
                  }
                : { classificationType: Cesium.ClassificationType.BOTH }),
            },
          });
          return;
        }
        bucket.points.add({
          id,
          position: Cesium.Cartesian3.fromDegrees(lon, lat),
          pixelSize: POINT_SIZE[dataset.id] || 7,
          color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
          outlineWidth: 1,
          scaleByDistance: new Cesium.NearFarScalar(2e4, 1.4, 2e6, 0.55),
          disableDepthTestDistance: POINT_DEPTH_TEST_DISTANCE_M,
        });
      };
      const addLine = (coords) =>
        entities.add({
          id: `${id}:${entities.values.length}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(coords.flat()),
            width: props.width || 2.5,
            material: color.withAlpha(0.9),
            clampToGround: true,
          },
        });
      const addPolygon = (rings) => {
        const hierarchy = new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArray(rings[0].flat()),
          rings
            .slice(1)
            .map(
              (ring) =>
                new Cesium.PolygonHierarchy(
                  Cesium.Cartesian3.fromDegreesArray(ring.flat()),
                ),
            ),
        );
        entities.add({
          id: `${id}:${entities.values.length}`,
          polygon: {
            hierarchy,
            material: fill,
            ...(extrude
              ? {
                  height: 0,
                  extrudedHeight: extrude,
                  outline: true,
                  outlineColor: color,
                }
              : { classificationType: Cesium.ClassificationType.BOTH }),
          },
        });
        if (!extrude) addLine(rings[0]);
      };
      switch (geometry.type) {
        case 'Point':
          addPoint(geometry.coordinates);
          break;
        case 'MultiPoint':
          geometry.coordinates.forEach(addPoint);
          break;
        case 'LineString':
          addLine(geometry.coordinates);
          break;
        case 'MultiLineString':
          geometry.coordinates.forEach(addLine);
          break;
        case 'Polygon':
          addPolygon(geometry.coordinates);
          break;
        case 'MultiPolygon':
          geometry.coordinates.forEach(addPolygon);
          break;
      }
    });
    entities.resumeEvents();
    showBucket(dataset.id, enabled && active.has(dataset.id));
    requestRender();
  }

  async function loadDataset(id, { force = false } = {}) {
    const dataset = datasetById(id);
    if (!dataset || !viewer) return;
    const bucket = bucketFor(id);
    if (bucket.loading) return bucket.loading;
    const maxAge = Math.max(MIN_REFRESH_MS, dataset.refreshMs || REFRESH_MS);
    if (!force && bucket.loadedAt && Date.now() - bucket.loadedAt < maxAge) {
      showBucket(id, enabled && active.has(id));
      return;
    }
    bucket.loading = (async () => {
      notify();
      try {
        const { features } = await source.getFeatures(id);
        if (!viewer) return;
        bucket.features = features;
        bucket.loadedAt = Date.now();
        bucket.error = null;
        lastUpdate = bucket.loadedAt;
        draw(dataset, bucket);
      } catch (error) {
        bucket.error = error?.message || 'unavailable';
        console.warn(`[Data:Denmark] ${id} failed:`, bucket.error);
      } finally {
        bucket.loading = null;
        notify();
      }
    })();
    return bucket.loading;
  }

  async function ensureCatalog() {
    if (catalog.length) return catalog;
    catalogPromise ||= source
      .getCatalog()
      .then((datasets) => {
        catalog = datasets;
        catalogError = null;
        active = new Set([...active].filter((id) => datasetById(id)));
        return catalog;
      })
      .catch((error) => {
        catalogError = error?.message || 'Denmark catalog unavailable';
        catalogPromise = null;
        throw error;
      })
      .finally(notify);
    return catalogPromise;
  }

  function toggleDataset(id) {
    if (active.has(id)) {
      active.delete(id);
      showBucket(id, false);
      if (focus === id) focus = null;
    } else {
      active.add(id);
      focus = id;
      if (enabled) void loadDataset(id);
    }
    storeSelection([...active]);
    hideCard();
    notify();
    requestRender();
  }

  // ---- Info card -------------------------------------------------------

  function hideCard() {
    card?.remove();
    card = null;
  }

  function showCard(dataset, feature, screen) {
    hideCard();
    if (typeof document === 'undefined') return;
    const props = feature.properties || {};
    card = document.createElement('div');
    card.className = 'dk-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', props.title || dataset.label);
    Object.assign(card.style, {
      position: 'fixed',
      zIndex: 60,
      maxWidth: '320px',
      padding: '10px 12px',
      borderRadius: '10px',
      background: 'rgba(12,16,22,0.92)',
      border: `1px solid ${featureColor(dataset, props)}`,
      color: '#e5e7eb',
      font: '12px/1.45 system-ui, sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
    });
    const add = (tag, text, style = {}) => {
      const node = document.createElement(tag);
      node.textContent = text;
      Object.assign(node.style, style);
      card.appendChild(node);
      return node;
    };
    add('div', dataset.label.toUpperCase(), {
      fontSize: '10px',
      letterSpacing: '0.08em',
      color: featureColor(dataset, props),
    });
    add('div', props.title || 'Unnamed', {
      fontWeight: 600,
      fontSize: '14px',
      margin: '2px 0',
    });
    if (props.subtitle)
      add('div', props.subtitle, { color: '#9ca3af', marginBottom: '6px' });
    for (const [label, value] of props.info || []) {
      const row = add('div', '', { display: 'flex', gap: '8px' });
      const key = document.createElement('span');
      key.textContent = label;
      Object.assign(key.style, {
        color: '#9ca3af',
        minWidth: '84px',
        flexShrink: 0,
      });
      const val = document.createElement('span');
      val.textContent = value;
      row.append(key, val);
    }
    if (props.url) {
      const link = add('a', 'Source record', {
        display: 'inline-block',
        marginTop: '6px',
        color: '#93c5fd',
      });
      link.href = props.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    add('div', `${dataset.credit} · ${dataset.licence}`, {
      marginTop: '6px',
      fontSize: '10px',
      color: '#6b7280',
    });
    const close = add('button', '×', {
      position: 'absolute',
      top: '4px',
      right: '6px',
      background: 'none',
      border: 0,
      color: '#9ca3af',
      fontSize: '16px',
      cursor: 'pointer',
    });
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', hideCard);
    document.body.appendChild(card);
    const { innerWidth: w, innerHeight: h } = globalThis;
    const rect = card.getBoundingClientRect();
    card.style.left = `${Math.max(8, Math.min(screen.x + 14, w - rect.width - 8))}px`;
    card.style.top = `${Math.max(8, Math.min(screen.y + 14, h - rect.height - 8))}px`;
  }

  /** Resolve a pick id like `dk:<dataset>:<index>[:part]` to its feature. */
  function resolvePick(pickId) {
    if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
      return null;
    const [, datasetId, index] = pickId.split(':');
    const dataset = datasetById(datasetId);
    const feature = buckets.get(datasetId)?.features?.[Number(index)];
    return dataset && feature
      ? { dataset, feature, pickId: `${PICK_PREFIX}${datasetId}:${index}` }
      : null;
  }

  function onClick(click) {
    if (!enabled || !isPointerFree()) return;
    const picked = viewer.scene.pick(click.position);
    const pickId =
      picking?.resolvePickId?.(picked) ?? picked?.id?.id ?? picked?.id;
    const hit = resolvePick(typeof pickId === 'string' ? pickId : null);
    if (!hit) {
      hideCard();
      return;
    }
    const anchor = featureAnchor(hit.feature.geometry);
    const subject = { id: hit.pickId };
    context?.registerEntityContext?.(subject, {
      id: hit.pickId,
      layerId: DENMARK_LAYER_ID,
      layerName: `Denmark · ${hit.dataset.label}`,
      source: hit.dataset.credit,
      label: hit.feature.properties?.title,
      properties: Object.fromEntries(hit.feature.properties?.info || []),
      latitude: anchor?.[1],
      longitude: anchor?.[0],
    });
    context?.selectEntityContext?.(subject);
    showCard(hit.dataset, hit.feature, click.position);
  }

  const onKey = (event) => {
    if (event.key === 'Escape') hideCard();
  };

  // ---- Layer interface ---------------------------------------------------

  const layer = {
    id: DENMARK_LAYER_ID,
    name: 'Denmark',
    icon: '✚',
    source: 'Danish open data',
    // Live datasets refresh on their own TTL; this is only the polling tick.
    updateInterval: 20_000,

    init(v) {
      if (viewer) throw new Error('Denmark layer is already initialized');
      viewer = v;
      picking?.registerPickOwner?.(DENMARK_LAYER_ID, (id) =>
        String(id).startsWith(PICK_PREFIX),
      );
    },

    async enable() {
      enabled = true;
      if (!clickHandler && viewer) {
        clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        clickHandler.setInputAction(
          onClick,
          Cesium.ScreenSpaceEventType.LEFT_CLICK,
        );
        globalThis.addEventListener?.('keydown', onKey);
      }
      notify();
      try {
        await ensureCatalog();
      } catch {
        return;
      }
      if (!enabled) return;
      await Promise.all([...active].map((id) => loadDataset(id)));
    },

    disable() {
      enabled = false;
      for (const id of buckets.keys()) showBucket(id, false);
      clickHandler?.destroy();
      clickHandler = null;
      globalThis.removeEventListener?.('keydown', onKey);
      hideCard();
      context?.removeEntityContextsForLayer?.(DENMARK_LAYER_ID);
      notify();
      requestRender();
    },

    async update() {
      if (!enabled || !catalog.length) return false;
      await Promise.all([...active].map((id) => loadDataset(id)));
      return true;
    },

    destroy() {
      layer.disable();
      for (const bucket of buckets.values()) {
        viewer?.scene?.primitives?.remove(bucket.points);
        viewer?.dataSources?.remove(bucket.dataSource, true);
      }
      buckets.clear();
      picking?.unregisterPickOwner?.(DENMARK_LAYER_ID);
      viewer = null;
      listener = null;
    },

    getRowControls() {
      const ordered = [...catalog].sort((a, b) =>
        a.group.localeCompare(b.group),
      );
      const chips = ordered.map((dataset) => {
        const bucket = buckets.get(dataset.id);
        const on = active.has(dataset.id);
        const count =
          on && bucket?.features?.length
            ? ` ${bucket.features.length.toLocaleString('en')}`
            : '';
        const state = bucket?.loading ? ' …' : bucket?.error && on ? ' !' : '';
        return {
          id: `dk-${dataset.id}`,
          label: `${dataset.label}${count}${state}`,
          title: `${dataset.group} — ${dataset.credit} (${dataset.licence})${
            bucket?.error ? ` — failed: ${bucket.error}` : ''
          }`,
          active: on,
          onClick: () => toggleDataset(dataset.id),
        };
      });
      const focused =
        datasetById(focus) ||
        ordered.find((d) => active.has(d.id) && d.categories);
      const legend = focused?.categories
        ? Object.entries(focused.categories).map(([label, color]) => ({
            label,
            color,
          }))
        : ordered
            .filter((d) => active.has(d.id))
            .map((d) => ({ label: d.label, color: d.color }));
      const total = [...active].reduce(
        (sum, id) => sum + (buckets.get(id)?.features?.length || 0),
        0,
      );
      return {
        chips,
        legend,
        info: catalogError
          ? `Denmark data unavailable: ${catalogError}`
          : catalog.length
            ? `${active.size} of ${catalog.length} datasets · ${total.toLocaleString('en')} features${
                focused?.categories ? ` · legend: ${focused.label}` : ''
              }`
            : 'Loading Danish datasets…',
      };
    },

    setRowControlsListener(fn) {
      listener = typeof fn === 'function' ? fn : null;
    },

    getAnalystRecords(maxCount = 500) {
      if (!enabled) return [];
      const records = [];
      for (const id of active) {
        const dataset = datasetById(id);
        for (const feature of buckets.get(id)?.features || []) {
          if (records.length >= maxCount) return records;
          const anchor = featureAnchor(feature.geometry);
          records.push({
            layer: DENMARK_LAYER_ID,
            dataset: dataset?.label,
            title: feature.properties?.title,
            subtitle: feature.properties?.subtitle,
            category: feature.properties?.category,
            lat: anchor?.[1],
            lon: anchor?.[0],
          });
        }
      }
      return records;
    },

    getStats() {
      const loaded = [...active].map((id) => buckets.get(id)).filter(Boolean);
      const errors = loaded.map((b) => b.error).filter(Boolean);
      return {
        count: loaded.reduce((sum, b) => sum + b.features.length, 0),
        lastUpdate,
        error:
          catalogError ||
          (errors.length && errors.length === loaded.length ? errors[0] : null),
      };
    },
  };
  return layer;
}
