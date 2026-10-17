import { cellToBoundary } from 'h3-js';
import { cleanText, displayProperties } from './geometry.js';
import { csvObjects } from './csv.js';

/**
 * Defence-related Denmark pack datasets: GPS jamming, firing areas,
 * sanctioned and shadow-fleet ships seen in Danish waters, and airfields.
 * Registered into the main registry by `datasets.js`.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

const feature = (geometry, props) => ({
  type: 'Feature',
  geometry,
  properties: displayProperties(props),
});

/** The Baltic and North Sea around Denmark, wide enough to include Kaliningrad. */
const JAMMING_AREA = Object.freeze({ west: 3, south: 52, east: 24, north: 62 });
const JAMMING_MIN_AIRCRAFT = 3;

/** GPSJam's own bands: under 2% is normal, 2–10% medium, over 10% high. */
export function jammingLevel(good, bad) {
  const total = good + bad;
  if (total < JAMMING_MIN_AIRCRAFT) return null;
  const pct = (100 * bad) / total;
  if (pct > 10) return { pct, category: 'High (>10%)' };
  if (pct >= 2) return { pct, category: 'Medium (2–10%)' };
  return null;
}

/** The newest manifest day that GPSJam has not flagged as suspect. */
export function latestJammingDay(manifest) {
  return manifest
    .split('\n')
    .slice(1)
    .map((line) => line.split(','))
    .filter(
      ([date, suspect]) =>
        /^\d{4}-\d{2}-\d{2}$/.test(date) && suspect === 'false',
    )
    .map(([date]) => date)
    .sort()
    .pop();
}

/** Parse a GPSJam H3 CSV into jamming hexes inside JAMMING_AREA. */
export function jammingFeatures(csv, day) {
  const out = [];
  for (const line of csv.split('\n').slice(1)) {
    const [hex, goodText, badText] = line.trim().split(',');
    if (!/^[0-9a-f]{15}$/.test(hex || '')) continue;
    const good = Number(goodText);
    const bad = Number(badText);
    const level = jammingLevel(good, bad);
    if (!level) continue;
    let ring;
    try {
      ring = cellToBoundary(hex, true);
    } catch {
      continue;
    }
    const inside = ring.some(
      ([lon, lat]) =>
        lon >= JAMMING_AREA.west &&
        lon <= JAMMING_AREA.east &&
        lat >= JAMMING_AREA.south &&
        lat <= JAMMING_AREA.north,
    );
    if (!inside) continue;
    out.push(
      feature(
        { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
        {
          title: `${Math.round(level.pct)}% of aircraft with degraded GPS`,
          subtitle: `GPS interference · ${day}`,
          category: level.category,
          rows: [
            ['Aircraft affected', bad],
            ['Aircraft normal', good],
            ['H3 cell', hex],
            ['Day', day],
          ],
        },
      ),
    );
  }
  return out;
}

const NIORD = 'https://niord.dma.dk/rest/public/v1/messages?lang=en';

/** Niord firing areas (permanent) and firing exercises (active notices). */
export function firingFeatures(messages, category) {
  if (!Array.isArray(messages)) throw new Error('niord_malformed');
  return messages.flatMap((message) => {
    const desc =
      message.descs?.find((d) => d.lang === 'en') || message.descs?.[0] || {};
    const area =
      message.areas?.[0]?.descs?.find((d) => d.lang === 'en')?.name ||
      message.areas?.[0]?.descs?.[0]?.name;
    return (message.parts || []).flatMap((part) => {
      const partDesc =
        part.descs?.find((d) => d.lang === 'en') || part.descs?.[0] || {};
      const from = part.eventDates?.[0]?.fromDate;
      const to = part.eventDates?.[0]?.toDate;
      return (part.geometry?.features || []).map((f) =>
        feature(f.geometry, {
          title: cleanText(area) || cleanText(desc.title) || message.shortId,
          subtitle: `${category} · ${message.shortId || 'Niord'}`,
          category,
          rows: [
            ['Id', message.shortId],
            ['Area', area],
            ['Details', partDesc.details],
            ['From', from ? new Date(from).toISOString().slice(0, 16) : ''],
            ['To', to ? new Date(to).toISOString().slice(0, 16) : ''],
          ],
        }),
      );
    });
  });
}

/** Index OpenSanctions maritime vessels that are sanctioned or shadow fleet. */
export function sanctionsIndex(rows) {
  const byImo = new Map();
  const byMmsi = new Map();
  for (const row of rows) {
    if (row.type !== 'VESSEL') continue;
    const risks = row.risk.split(';');
    const category = risks.includes('mare.shadow')
      ? 'Shadow fleet'
      : risks.includes('sanction')
        ? 'Sanctioned'
        : null;
    if (!category) continue;
    const entry = { ...row, category };
    const imo = row.imo.replace(/^IMO/i, '');
    if (/^\d{7}$/.test(imo)) byImo.set(imo, entry);
    for (const mmsi of row.mmsi.split(';'))
      if (/^\d{9}$/.test(mmsi)) byMmsi.set(mmsi, entry);
  }
  return { byImo, byMmsi };
}

const infoValue = (props, label) =>
  props?.info?.find(([key]) => key === label)?.[1] || '';

/** AIS-day tracks whose IMO or MMSI is on the sanctions index. */
export function matchSanctionedTracks(tracks, { byImo, byMmsi }) {
  return tracks.flatMap((track) => {
    const props = track.properties;
    const imo = String(infoValue(props, 'IMO')).replace(/\D/g, '');
    const mmsi = String(infoValue(props, 'MMSI'));
    const hit = byImo.get(imo) || byMmsi.get(mmsi);
    if (!hit) return [];
    const sources = hit.datasets
      .split(';')
      .filter(Boolean)
      .slice(0, 4)
      .join(', ');
    return [
      feature(track.geometry, {
        title: cleanText(hit.caption) || props.title,
        subtitle: `${hit.category} · seen ${infoValue(props, 'Seen')}`,
        category: hit.category,
        url: hit.url,
        width: 4,
        rows: [
          ['MMSI', mmsi],
          ['IMO', imo],
          ['Flag', hit.flag.toUpperCase()],
          ['AIS name', props.title],
          ['Listed by', sources],
          ['Destination', infoValue(props, 'Destination')],
        ],
      }),
    ];
  });
}

const OURAIRPORTS = 'https://davidmegginson.github.io/ourairports-data';
/** Air bases OurAirports names as civil airports. */
const MILITARY_ICAO = new Set(['EKKA', 'EKSP', 'EKYT', 'EKAV', 'EKVL']);
const AIRFIELD_TYPE = {
  large_airport: 'Airport',
  medium_airport: 'Airport',
  small_airport: 'Small airfield',
  heliport: 'Heliport',
  seaplane_base: 'Seaplane base',
};

/** VOR/TACAN/DME in MHz; NDBs are low-frequency and stay in kHz. */
export function navaidFrequency({ type, frequency_khz: khz }) {
  const value = Number(khz);
  if (!value) return '';
  return /NDB/i.test(type)
    ? `${value} kHz`
    : `${(value / 1000).toFixed(2)} MHz`;
}

export function airfieldCategory(row) {
  if (row.type === 'closed') return null;
  if (MILITARY_ICAO.has(row.ident) || /air base|military|naval/i.test(row.name))
    return 'Military';
  return AIRFIELD_TYPE[row.type] || null;
}

export const DEFENCE_DATASETS = [
  {
    id: 'gps-jamming',
    label: 'GPS jamming',
    group: 'Defence & airspace',
    color: '#f97316',
    categories: { 'High (>10%)': '#dc2626', 'Medium (2–10%)': '#f59e0b' },
    ttlMs: 6 * HOUR,
    allowEmpty: true,
    credit: 'GPSJam.org — daily GPS interference from ADS-B',
    creditUrl: 'https://gpsjam.org/',
    licence: 'GPSJam data (free use with attribution)',
    async load({ fetchText }) {
      const day = latestJammingDay(
        await fetchText('https://gpsjam.org/data/manifest.csv', MB),
      );
      if (!day) throw new Error('gpsjam_no_day');
      const csv = await fetchText(
        `https://gpsjam.org/data/${day}-h3_4.csv`,
        16 * MB,
      );
      return { features: jammingFeatures(csv, day) };
    },
  },
  {
    id: 'firing-areas',
    label: 'Firing areas & exercises',
    group: 'Defence & airspace',
    color: '#ef4444',
    categories: { 'Firing area': '#ef4444', 'Firing exercise': '#fbbf24' },
    ttlMs: 30 * 60_000,
    credit: 'Danish Maritime Authority — Niord firing areas',
    creditUrl: 'https://niord.dma.dk/',
    licence: 'Danish public open data',
    async load({ fetchJson }) {
      const [areas, exercises] = await Promise.all([
        fetchJson(`${NIORD}&messageSeries=dma-fa`, 10 * MB),
        fetchJson(`${NIORD}&messageSeries=dma-fe`, 10 * MB),
      ]);
      return {
        features: [
          ...firingFeatures(areas, 'Firing area'),
          ...firingFeatures(exercises, 'Firing exercise'),
        ],
      };
    },
  },
  {
    id: 'shadow-fleet',
    label: 'Sanctioned & shadow-fleet ships',
    group: 'Defence & airspace',
    color: '#dc2626',
    categories: { 'Shadow fleet': '#dc2626', Sanctioned: '#a855f7' },
    ttlMs: 6 * HOUR,
    allowEmpty: true,
    personalUse: true,
    credit: 'OpenSanctions maritime × DMA AIS day',
    creditUrl: 'https://www.opensanctions.org/datasets/maritime/',
    licence: 'CC BY-NC 4.0 (OpenSanctions)',
    async load({ fetchJson, fetchText, dataset }) {
      const index = await fetchJson(
        'https://data.opensanctions.org/datasets/latest/maritime/index.json',
        MB,
      );
      const csvUrl = index?.resources?.find(
        (r) => r.name === 'maritime.csv',
      )?.url;
      if (!/^https:\/\/data\.opensanctions\.org\//.test(csvUrl || ''))
        throw new Error('opensanctions_no_csv');
      const sanctions = sanctionsIndex(
        csvObjects(await fetchText(csvUrl, 40 * MB)),
      );
      return {
        features: matchSanctionedTracks(await dataset('ais-day'), sanctions),
        tolerance: 0.0005,
      };
    },
  },
  {
    id: 'airfields',
    label: 'Airfields & navaids',
    group: 'Defence & airspace',
    color: '#38bdf8',
    categories: {
      Military: '#e879f9',
      Airport: '#38bdf8',
      'Small airfield': '#94a3b8',
      Heliport: '#22c55e',
      'Seaplane base': '#14b8a6',
      Navaid: '#facc15',
    },
    ttlMs: 7 * DAY,
    credit: 'OurAirports',
    creditUrl: 'https://ourairports.com/countries/DK/',
    licence: 'Public domain (OurAirports)',
    async load({ fetchText }) {
      const [airports, navaids] = await Promise.all([
        fetchText(`${OURAIRPORTS}/airports.csv`, 40 * MB),
        fetchText(`${OURAIRPORTS}/navaids.csv`, 20 * MB),
      ]);
      const point = (row) => ({
        type: 'Point',
        coordinates: [Number(row.longitude_deg), Number(row.latitude_deg)],
      });
      const fields = csvObjects(airports)
        .filter((row) => row.iso_country === 'DK')
        .flatMap((row) => {
          const category = airfieldCategory(row);
          if (!category) return [];
          return [
            feature(point(row), {
              title: row.name,
              subtitle: `${category} · ${row.ident}`,
              category,
              url: row.wikipedia_link || row.home_link,
              rows: [
                ['ICAO', row.icao_code || row.gps_code || row.ident],
                ['IATA', row.iata_code],
                ['Municipality', row.municipality],
                ['Elevation', row.elevation_ft ? `${row.elevation_ft} ft` : ''],
                ['Scheduled service', row.scheduled_service],
              ],
            }),
          ];
        });
      const aids = csvObjects(navaids)
        .filter((row) => row.iso_country === 'DK')
        .map((row) =>
          feature(point(row), {
            title: `${row.name} ${row.type}`,
            subtitle: `Navaid · ${row.ident}`,
            category: 'Navaid',
            rows: [
              ['Ident', row.ident],
              ['Type', row.type],
              ['Frequency', navaidFrequency(row)],
              ['DME channel', row.dme_channel],
              ['Airport', row.associated_airport],
            ],
          }),
        );
      return { features: [...fields, ...aids] };
    },
  },
];
