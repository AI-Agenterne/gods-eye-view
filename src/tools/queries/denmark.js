/** Denmark pack queries: the fork's Danish datasets inside an area. */

import { suggestView } from '../views.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  areaCenter,
  areaContains,
  distanceKm,
  lineTouchesArea,
  polygonsTouchArea,
  resolveArea,
} from '../area.js';
import { LIMIT_SCHEMA, capRows, countNoun } from '../results.js';

/** Denmark and its seas; outside this box the pack has nothing to say. */
const COVERAGE = Object.freeze({ west: 3, south: 53, east: 18, north: 59.5 });
const MAX_DATASETS = 8;

/** Datasets the military-awareness panel adds when the area is Danish. */
export const DENMARK_DEFENCE_DATASETS = Object.freeze([
  'drone-zones',
  'military-sea-areas',
  'military-heritage',
  'munitions',
  'nav-warnings',
  'firing-areas',
  'gps-jamming',
  'shadow-fleet',
]);

const intersectsCoverage = (area) =>
  area.south <= COVERAGE.north &&
  area.north >= COVERAGE.south &&
  area.west <= COVERAGE.east &&
  area.east >= COVERAGE.west;

/** Whether a GeoJSON geometry touches the area. */
export function geometryTouchesArea(geometry, area) {
  const c = geometry?.coordinates;
  switch (geometry?.type) {
    case 'Point':
      return areaContains(area, { lon: c[0], lat: c[1] });
    case 'MultiPoint':
      return c.some(([lon, lat]) => areaContains(area, { lon, lat }));
    case 'LineString':
      return lineTouchesArea(c, area);
    case 'MultiLineString':
      return c.some((line) => lineTouchesArea(line, area));
    case 'Polygon':
      return polygonsTouchArea([c], area);
    case 'MultiPolygon':
      return polygonsTouchArea(c, area);
    default:
      return false;
  }
}

/** The vertex nearest the reference point, for sorting and display. */
function nearestVertex(geometry, center) {
  let best = null;
  const visit = (value) => {
    if (typeof value?.[0] === 'number') {
      const point = { lon: value[0], lat: value[1] };
      const km = distanceKm(center, point);
      if (!best || km < best.km) best = { ...point, km };
    } else if (Array.isArray(value)) value.forEach(visit);
  };
  visit(geometry?.coordinates);
  return best;
}

export const denmarkInArea = defineTool({
  name: 'denmark_in_area',
  title: 'Danish data in an area',
  description:
    'Features from the Denmark pack (Danish open data: drone zones, military ' +
    'exercise areas at sea, bunkers and fortifications, dumped munitions, ' +
    'navigational warnings, wrecks, wind turbines, masts, live weather, power ' +
    'flows, ship tracks and more) that touch an area, nearest first per ' +
    'dataset. Pass dataset ids to narrow it; omit them to list the catalog.',
  inputSchema: {
    type: 'object',
    properties: {
      area: AREA_SCHEMA,
      datasets: {
        type: 'array',
        items: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' },
        maxItems: MAX_DATASETS,
      },
      limit: LIMIT_SCHEMA,
    },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['denmark'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const catalog = await services.denmark.getCatalog({ signal });
    if (!args.datasets?.length)
      return {
        summary: `The Denmark pack has ${countNoun(catalog.length, 'dataset')}; pass dataset ids to query them.`,
        data: {
          datasets: catalog.map(({ id, label, group, licence }) => ({
            id,
            label,
            group,
            licence,
          })),
        },
      };
    const known = new Map(catalog.map((d) => [d.id, d]));
    const unknown = args.datasets.filter((id) => !known.has(id));
    if (unknown.length)
      throw new ToolError(
        'invalid_arguments',
        `unknown Denmark dataset: ${unknown.join(', ')}`,
      );
    if (!intersectsCoverage(area))
      return {
        summary: `${area.label} is outside the Denmark pack's coverage.`,
        data: { sections: {} },
      };
    const center = areaCenter(area);
    const sections = {};
    const lines = [];
    let shown = 0;
    await Promise.all(
      args.datasets.map(async (id) => {
        const { features } = await services.denmark.getFeatures(id, { signal });
        const hits = features
          .filter((feature) => geometryTouchesArea(feature.geometry, area))
          .map((feature) => {
            const near = nearestVertex(feature.geometry, center);
            const props = feature.properties || {};
            return {
              title: props.title,
              subtitle: props.subtitle,
              category: props.category,
              distance_km: near ? Math.round(near.km * 10) / 10 : null,
              lat: near?.lat,
              lon: near?.lon,
              details: Object.fromEntries(props.info || []),
            };
          })
          .sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));
        sections[id] = {
          label: known.get(id).label,
          ...capRows(hits, args.limit),
        };
        shown += hits.length;
        if (hits.length)
          lines.push(
            `${hits.length} ${known.get(id).label.toLowerCase()} (nearest: ${hits[0].title}, ${hits[0].distance_km} km)`,
          );
      }),
    );
    signal?.throwIfAborted();
    return {
      summary: shown
        ? `In ${area.label}: ${lines.join('; ')}.`
        : `No features from ${countNoun(args.datasets.length, 'Denmark dataset')} in ${area.label}.`,
      data: {
        view: suggestView(services, { area, layers: ['denmark'] }),
        sections,
      },
    };
  },
});
