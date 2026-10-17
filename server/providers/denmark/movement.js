import { displayProperties } from './geometry.js';
import { buildDayIndex, localClock, vehiclePositions } from './gtfs.js';

/**
 * Movement datasets for the Denmark pack: every scheduled train, bus, metro
 * and ferry placed from the Rejseplanen timetable, plus bridge clearances
 * and weight limits from the Road Directorate's map feed.
 */

const MB = 1024 * 1024;
const DAY = 86_400_000;

const feature = (geometry, props) => ({
  type: 'Feature',
  geometry,
  properties: displayProperties(props),
});

const TRAFFIC_GEOJSON =
  'https://storage.googleapis.com/trafikkort-data/geojson/25832';
const GTFS_URL = 'https://www.rejseplanen.info/labs/GTFS.zip';

const hhmm = (seconds) => {
  const s = ((seconds % 86_400) + 86_400) % 86_400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(
    Math.floor((s % 3600) / 60),
  ).padStart(2, '0')}`;
};

/** Clearance bands for bridges and tunnels over state roads. */
export function clearanceCategory(metres) {
  if (!(metres > 0)) return null;
  if (metres < 4.2) return 'Clearance under 4.2 m';
  if (metres < 4.5) return 'Clearance 4.2–4.5 m';
  return 'Clearance 4.5 m+';
}

/** Danish bridge bearing classes below 60 restrict heavy goods traffic. */
const WEIGHT_CLASS_LIMIT = 60;

/** The day's timetable index, rebuilt when the Danish calendar date changes. */
let dayIndex = null;

export const MOVEMENT_DATASETS = [
  {
    id: 'transit-sim',
    label: 'Public transport (timetable)',
    group: 'Live',
    color: '#38bdf8',
    categories: {
      Train: '#ef4444',
      'S-train': '#f97316',
      Metro: '#22c55e',
      'Light rail': '#a855f7',
      Bus: '#facc15',
      Ferry: '#38bdf8',
    },
    ttlMs: 20_000,
    allowEmpty: true,
    personalUse: true,
    credit: 'Rejseplanen Labs GTFS — positions simulated from the timetable',
    creditUrl: 'https://www.rejseplanen.info/labs/',
    licence: 'Rejseplanen Labs terms (non-commercial)',
    async load({ fetchBytes, now }) {
      const clock = localClock(now);
      if (dayIndex?.date !== clock.date) {
        const zip = await fetchBytes(GTFS_URL, 120 * MB);
        dayIndex = await buildDayIndex(zip, clock);
      }
      const features = vehiclePositions(dayIndex, clock.seconds).map(
        ({ lon, lat, trip, next, at }) =>
          feature(
            { type: 'Point', coordinates: [lon, lat] },
            {
              title: `${trip.route.line} → ${trip.headsign}`,
              subtitle: `${trip.route.mode} · ${trip.route.operator}`,
              category: trip.route.mode,
              rows: [
                ['Next stop', next],
                ['Due', hhmm(at)],
                ['Position', 'Scheduled, not live tracking'],
              ],
            },
          ),
      );
      return { features };
    },
  },
  {
    id: 'bridges',
    label: 'Bridge clearances & weight limits',
    group: 'Infrastructure',
    color: '#f59e0b',
    categories: {
      'Clearance under 4.2 m': '#ef4444',
      'Clearance 4.2–4.5 m': '#f59e0b',
      'Clearance 4.5 m+': '#4ade80',
      'Weight-limited': '#a855f7',
    },
    ttlMs: 7 * DAY,
    personalUse: true,
    credit: 'Vejdirektoratet — trafikkort (public map feed)',
    creditUrl: 'https://trafikkort.vejdirektoratet.dk/',
    licence: 'Unofficial public map feed; official CC BY version via the NAP',
    async load({ fetchJson }) {
      const [clearance, weight] = await Promise.all([
        fetchJson(`${TRAFFIC_GEOJSON}/clearance-height.point.json`, 20 * MB),
        fetchJson(`${TRAFFIC_GEOJSON}/weight-restriction.point.json`, 20 * MB),
      ]);
      const low = (clearance?.features || []).flatMap((f) => {
        const p = f.properties || {};
        const metres = Number(p.clearance);
        const category = clearanceCategory(metres);
        if (!category) return [];
        return [
          feature(f.geometry, {
            title: p.title || 'Bridge',
            subtitle: `${metres.toFixed(2)} m clearance · ${p.kind || ''}`,
            category,
            rows: [
              ['Clearance', `${metres.toFixed(2)} m`],
              ['Structure', p.kind],
              ['Register no.', p.regNo],
            ],
          }),
        ];
      });
      const limited = (weight?.features || []).flatMap((f) => {
        const p = f.properties || {};
        const bearing = Number(p.class);
        if (!(bearing > 0 && bearing < WEIGHT_CLASS_LIMIT)) return [];
        return [
          feature(f.geometry, {
            title: p.title || 'Bridge',
            subtitle: `Bearing class ${bearing} · ${p.kind || ''}`,
            category: 'Weight-limited',
            rows: [
              ['Bearing class', bearing],
              ['Structure', p.kind],
              ['Register no.', p.regNo],
            ],
          }),
        ];
      });
      return { features: [...low, ...limited], epsg: 25832 };
    },
  },
];
