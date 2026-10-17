import { cleanText, displayProperties } from './geometry.js';

/**
 * Energy, statistics and environment datasets for the Denmark pack:
 * transmission substations with free grid capacity, renewables and
 * population per municipality, the Aarhus University air-quality forecast,
 * and weather balloons in flight.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

const feature = (geometry, props) => ({
  type: 'Feature',
  geometry,
  properties: displayProperties(props),
});

const ENERGINET = 'https://api.energidataservice.dk/dataset';
const MUNICIPALITIES_URL =
  'https://geoserver.plandata.dk/geoserver/wfs?service=WFS&version=2.0.0' +
  '&request=GetFeature&typeNames=pdk:theme_pdk_kommuneplan_oversigt_vedtaget' +
  '&outputFormat=application/json&propertyName=komnr,kommunenavn,geometri';

/** Shoelace area of one ring, in the ring's own units squared. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return Math.abs(sum) / 2;
}

/** Area of a projected (metre) Polygon or MultiPolygon, in km². */
export function areaKm2(geometry) {
  const polygons =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  let m2 = 0;
  for (const [outer, ...holes] of polygons)
    m2 += ringArea(outer) - holes.reduce((s, h) => s + ringArea(h), 0);
  return m2 / 1e6;
}

/** Statbank and Energinet number municipalities without leading zeros or with three digits. */
export const municipalityKey = (value) =>
  String(Number(value)).padStart(3, '0');

/**
 * The 98 municipalities from Plandata's municipal-plan overview (one current
 * plan per municipality), in EPSG:25832. Memoised for a day: two datasets
 * draw on the same 38 MB of boundaries.
 */
let municipalityCache = null;
async function municipalities(fetchJson, now) {
  if (municipalityCache && now - municipalityCache.at < DAY)
    return municipalityCache.list;
  const collection = await fetchJson(MUNICIPALITIES_URL, 80 * MB);
  const byKey = new Map();
  for (const f of collection?.features || []) {
    const key = municipalityKey(f.properties?.komnr);
    if (!f.geometry || key === 'NaN') continue;
    const previous = byKey.get(key);
    // A municipality with two current plans keeps the larger outline.
    if (!previous || areaKm2(f.geometry) > previous.areaKm2)
      byKey.set(key, {
        key,
        name: f.properties.kommunenavn,
        geometry: f.geometry,
        areaKm2: areaKm2(f.geometry),
      });
  }
  if (byKey.size < 90) throw new Error('municipalities_incomplete');
  municipalityCache = { at: now, list: [...byKey.values()] };
  return municipalityCache.list;
}

/** Bucket a value into the first band whose upper bound it is under. */
export function band(value, bands) {
  for (const [limit, label] of bands) if (value < limit) return label;
  return bands[bands.length - 1][1];
}

const RENEWABLE_BANDS = [
  [50, 'Under 50 MW'],
  [150, '50–150 MW'],
  [300, '150–300 MW'],
  [Infinity, 'Over 300 MW'],
];
const DENSITY_BANDS = [
  [50, 'Under 50 / km²'],
  [100, '50–100 / km²'],
  [250, '100–250 / km²'],
  [1000, '250–1,000 / km²'],
  [Infinity, 'Over 1,000 / km²'],
];
const FREE_CAPACITY_BANDS = [
  [100, 'Under 100 MW free'],
  [300, '100–300 MW free'],
  [Infinity, 'Over 300 MW free'],
];

/** Latest TSO capacity map: one row per substation, current grid preferred. */
export function latestSubstations(records) {
  const latest = records.reduce(
    (max, r) => (r.publication_date > max ? r.publication_date : max),
    '',
  );
  const byStation = new Map();
  for (const r of records) {
    if (r.publication_date !== latest) continue;
    const key = r.TSO_station_name;
    const previous = byStation.get(key);
    if (!previous || previous.grid_precondition === 'reinforced_grid')
      byStation.set(key, r);
  }
  return [...byStation.values()];
}

/** Read a JSON-stat 2 single-dimension dataset into Map(code → value). */
export function jsonStatValues(body, dimension) {
  const index = body?.dataset?.dimension?.[dimension]?.category?.index;
  const values = body?.dataset?.value;
  if (!index || !Array.isArray(values)) throw new Error('jsonstat_malformed');
  return new Map(Object.entries(index).map(([code, i]) => [code, values[i]]));
}

const AIR_INDEX = {
  1: 'Index 1 (best)',
  2: 'Index 2',
  3: 'Index 3',
  4: 'Index 4',
  5: 'Index 5+',
};

export const ENVIRONMENT_DATASETS = [
  {
    id: 'substations',
    label: 'Substations & free grid capacity',
    group: 'Infrastructure',
    color: '#facc15',
    categories: {
      'Over 300 MW free': '#22c55e',
      '100–300 MW free': '#facc15',
      'Under 100 MW free': '#ef4444',
      'Connection point': '#94a3b8',
    },
    ttlMs: 7 * DAY,
    credit: 'Energinet — Energi Data Service (grid capacity map)',
    creditUrl: 'https://www.energidataservice.dk/',
    licence: 'Energi Data Service terms (free, attribution)',
    async load({ fetchJson }) {
      // Sequential: Energi Data Service answers parallel bursts with HTTP 429.
      const tso = await fetchJson(
        `${ENERGINET}/GridCapacityMapTSO?limit=0`,
        20 * MB,
      );
      const points = await fetchJson(
        `${ENERGINET}/ConnectionPointsInGrid?limit=0`,
        10 * MB,
      );
      const stations = latestSubstations(tso?.records || []).map((r) =>
        feature(
          { type: 'Point', coordinates: [r.longitude, r.latitude] },
          {
            title: `${r.TSO_station_name} ${r.voltage_level_kv} kV`,
            subtitle: `${r.available_capacity_MW} MW free · ${r.publication_date.slice(0, 7)}`,
            category: band(r.available_capacity_MW, FREE_CAPACITY_BANDS),
            rows: [
              ['Free capacity', `${r.available_capacity_MW} MW`],
              [
                'Wind (100 MW park)',
                `${r.available_capacity_wind_at_100_MW_in_percent}% of hours`,
              ],
              [
                'Solar (100 MW park)',
                `${r.available_capacity_solar_at_100_MW_in_percent}% of hours`,
              ],
              ['Grid', String(r.grid_precondition).replace(/_/g, ' ')],
              ['Voltage', `${r.voltage_level_kv} kV`],
            ],
          },
        ),
      );
      const connections = (points?.records || []).map((r) =>
        feature(
          {
            type: 'Point',
            coordinates: [
              r.ConnectionPointLongitude,
              r.ConnectionPointLatitude,
            ],
          },
          {
            title: r.ConnectionPointName,
            subtitle: `Connection point · ${r.NetCompanyName}`,
            category: 'Connection point',
            rows: [
              ['Code', r.ConnectionPointCode],
              ['Municipality', r.Municipality],
              ['Grid company', r.NetCompanyName],
            ],
          },
        ),
      );
      return { features: [...stations, ...connections] };
    },
  },
  {
    id: 'renewables-by-municipality',
    label: 'Wind & solar per municipality',
    group: 'Infrastructure',
    color: '#22c55e',
    categories: {
      'Under 50 MW': '#dcfce7',
      '50–150 MW': '#86efac',
      '150–300 MW': '#22c55e',
      'Over 300 MW': '#15803d',
    },
    ttlMs: 7 * DAY,
    credit: 'Energinet — capacity per municipality; Plandata.dk boundaries',
    creditUrl: 'https://www.energidataservice.dk/',
    licence: 'Energi Data Service terms; Plandata.dk open data',
    async load({ fetchJson, now }) {
      const [areas, capacity] = await Promise.all([
        municipalities(fetchJson, now),
        fetchJson(
          `${ENERGINET}/CapacityPerMunicipality?limit=300&sort=Month%20desc`,
          5 * MB,
        ),
      ]);
      const records = capacity?.records || [];
      const month = records[0]?.Month;
      const byKey = new Map(
        records
          .filter((r) => r.Month === month)
          .map((r) => [municipalityKey(r.MunicipalityNo), r]),
      );
      const features = areas.flatMap((area) => {
        const r = byKey.get(area.key);
        if (!r) return [];
        const onshore = r.OnshoreWindCapacity + r.SolarPowerCapacity;
        return [
          feature(area.geometry, {
            title: area.name,
            subtitle: `${Math.round(onshore)} MW onshore wind + solar · ${String(month).slice(0, 7)}`,
            category: band(onshore, RENEWABLE_BANDS),
            rows: [
              ['Onshore wind', `${Math.round(r.OnshoreWindCapacity)} MW`],
              ['Solar', `${Math.round(r.SolarPowerCapacity)} MW`],
              ['Offshore wind', `${Math.round(r.OffshoreWindCapacity)} MW`],
              ['Onshore turbines', r.NumberOnshoreWindGenerators],
              ['Solar installations', r.NumberSolarPanels],
            ],
          }),
        ];
      });
      return { features, epsg: 25832, tolerance: 0.002 };
    },
  },
  {
    id: 'population-density',
    label: 'Population density per municipality',
    group: 'Statistics',
    color: '#a855f7',
    categories: {
      'Under 50 / km²': '#f3e8ff',
      '50–100 / km²': '#d8b4fe',
      '100–250 / km²': '#c084fc',
      '250–1,000 / km²': '#9333ea',
      'Over 1,000 / km²': '#581c87',
    },
    ttlMs: 7 * DAY,
    credit: 'Statistics Denmark (FOLK1A); Plandata.dk boundaries',
    creditUrl: 'https://www.statbank.dk/FOLK1A',
    licence: 'Statistics Denmark open data (attribution); Plandata.dk',
    async load({ fetchJson, now }) {
      const [areas, stat] = await Promise.all([
        municipalities(fetchJson, now),
        fetchJson(
          'https://api.statbank.dk/v1/data/FOLK1A/JSONSTAT?lang=en&OMR%C3%85DE=*&Tid=(1)',
          2 * MB,
        ),
      ]);
      const population = jsonStatValues(stat, 'OMRÅDE');
      const quarter = Object.keys(
        stat?.dataset?.dimension?.Tid?.category?.index || {},
      )[0];
      const features = areas.flatMap((area) => {
        const people = population.get(area.key);
        if (!(people > 0) || !(area.areaKm2 > 0)) return [];
        const density = people / area.areaKm2;
        return [
          feature(area.geometry, {
            title: area.name,
            subtitle: `${Math.round(density).toLocaleString('en')} people per km² · ${quarter || ''}`,
            category: band(density, DENSITY_BANDS),
            rows: [
              ['Population', people.toLocaleString('en')],
              ['Area', `${Math.round(area.areaKm2).toLocaleString('en')} km²`],
              ['Density', `${Math.round(density)} / km²`],
              ['Quarter', quarter],
            ],
          }),
        ];
      });
      return { features, epsg: 25832, tolerance: 0.002 };
    },
  },
  {
    id: 'air-forecast',
    label: 'Air-quality forecast (Aarhus University)',
    group: 'Live',
    color: '#4ade80',
    categories: {
      'Index 1 (best)': '#4ade80',
      'Index 2': '#a3e635',
      'Index 3': '#facc15',
      'Index 4': '#f97316',
      'Index 5+': '#dc2626',
    },
    ttlMs: 3 * HOUR,
    credit: 'Aarhus University, Department of Environmental Science (Holger)',
    creditUrl: 'https://holger.envs.au.dk/',
    licence: 'Public API via opendata.dk (Københavns Kommune)',
    async load({ fetchJson, now }) {
      const [points, days] = await Promise.all([
        fetchJson('https://holger.envs.au.dk/api/point_info', 5 * MB),
        fetchJson('https://holger.envs.au.dk/api/aqindex_day', 10 * MB),
      ]);
      const today = new Date(now).toISOString().slice(0, 10);
      const byPid = new Map();
      for (const d of Array.isArray(days) ? days : [])
        if (d.date === today) byPid.set(d.pid, d);
      const features = (Array.isArray(points) ? points : []).flatMap((p) => {
        const d = byPid.get(p.pid);
        if (!d || !Number.isFinite(p.long) || !Number.isFinite(p.lat))
          return [];
        const index = Math.min(5, Math.max(1, Number(d.global_ix) || 1));
        return [
          feature(
            { type: 'Point', coordinates: [p.long, p.lat] },
            {
              title: cleanText(p.name_short) || cleanText(p.full_address),
              subtitle: `${AIR_INDEX[index]} today · ${p.type === 'Maaling' ? 'measuring station' : 'forecast point'}`,
              category: AIR_INDEX[index],
              rows: [
                ['NO₂', `${d.no2} µg/m³`],
                ['O₃', `${d.o3} µg/m³`],
                ['PM2.5', `${d.pm25} µg/m³`],
                ['PM10', `${d.pm10} µg/m³`],
                ['Driver', d.global_ix_pol],
                ['Address', p.full_address],
              ],
            },
          ),
        ];
      });
      return { features };
    },
  },
  {
    id: 'radiosondes',
    label: 'Weather balloons (radiosondes)',
    group: 'Live',
    color: '#e879f9',
    categories: { Ascending: '#e879f9', Descending: '#38bdf8' },
    ttlMs: 2 * 60_000,
    allowEmpty: true,
    credit: 'SondeHub — amateur radiosonde tracking',
    creditUrl: 'https://sondehub.org/',
    licence: 'SondeHub data (CC BY-SA 2.0)',
    async load({ fetchJson }) {
      const sondes = await fetchJson(
        'https://api.v2.sondehub.org/sondes?lat=56&lon=10.5&distance=500000&last=10800',
        5 * MB,
      );
      const features = Object.values(sondes || {}).flatMap((s) => {
        if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return [];
        const alt = Math.round(Number(s.alt) || 0);
        return [
          feature(
            { type: 'Point', coordinates: [s.lon, s.lat] },
            {
              title: `${s.type || 'Radiosonde'} ${s.serial}`,
              subtitle: `${alt.toLocaleString('en')} m · ${String(s.datetime || '').slice(11, 16)} UTC`,
              category: Number(s.vel_v) < 0 ? 'Descending' : 'Ascending',
              rows: [
                ['Altitude', `${alt.toLocaleString('en')} m`],
                [
                  'Climb rate',
                  Number.isFinite(s.vel_v) ? `${s.vel_v.toFixed(1)} m/s` : '',
                ],
                ['Frequency', s.frequency ? `${s.frequency} MHz` : ''],
                ['Last heard', s.datetime],
                ['Heard by', s.uploader_callsign],
              ],
            },
          ),
        ];
      });
      return { features };
    },
  },
];
