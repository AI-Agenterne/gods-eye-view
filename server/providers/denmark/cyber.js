import { displayProperties } from './geometry.js';
import { band } from './environment.js';

/**
 * Cyber exposure for the Denmark pack: how many internet-facing services
 * Shodan indexes per Danish city, split into a few risk categories.
 *
 * Aggregates only. The loader calls `/shodan/host/count` (0 query credits)
 * and reads nothing but `total` and facet `{value, count}` pairs. No IP,
 * hostname, organisation, banner, screenshot or device link ever leaves this
 * module — `matches` is ignored by construction, and a unit test enforces it.
 * Opening a device found this way can be unlawful access (straffeloven
 * § 263), so GEV never points at one.
 *
 * The key is server-side only and read at request time, so a key saved
 * through Provider Settings applies without a restart. Without one the
 * dataset is left out of the catalog.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

const COUNT_URL = 'https://api.shodan.io/shodan/host/count';
/** Shodan allows about one request per second per key. */
const SPACING_MS = 1100;

export const shodanKey = () => String(process.env.SHODAN_API_KEY || '').trim();

/** Port lists instead of `tag:` filters, which need a paid plan. */
export const CYBER_CATEGORIES = Object.freeze([
  {
    key: 'ics',
    label: 'Industrial control (ICS)',
    filter: 'port:502,102,20000,44818,47808,1911,2404',
  },
  {
    key: 'remote',
    label: 'Remote access (RDP/VNC/Telnet)',
    filter: 'port:3389,5900,23',
  },
  {
    key: 'db',
    label: 'Open databases',
    filter: 'port:27017,9200,6379,5432,3306',
  },
  { key: 'rtsp', label: 'Video streams (RTSP)', filter: 'port:554' },
]);

const TOTAL_BANDS = [
  [100, 'Under 100'],
  [1000, '100–1,000'],
  [10000, '1,000–10,000'],
  [Infinity, 'Over 10,000'],
];

/**
 * Fold a Danish place name to one comparable key: Århus, Aarhus and AARHUS
 * all become `arhus`; Køge and Koge both become `koge`.
 */
export function cityKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/[øö]/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/aa/g, 'a')
    .replace(/[^a-z]/g, '');
}

/** English exonyms Shodan's GeoIP data may use. */
const ALIASES = new Map([
  ['copenhagen', 'kobenhavn'],
  ['elsinore', 'helsingor'],
  ['kongenslyngby', 'lyngby'],
  ['solrod', 'solrodstrand'],
]);

/** City centres as [name, lat, lon]: the places a Danish IP is geolocated to. */
const CITIES = [
  ['København', 55.6761, 12.5683],
  ['Frederiksberg', 55.6786, 12.5236],
  ['Aarhus', 56.1572, 10.2107],
  ['Odense', 55.4038, 10.4024],
  ['Aalborg', 57.0488, 9.9217],
  ['Esbjerg', 55.4765, 8.4594],
  ['Randers', 56.4607, 10.0364],
  ['Kolding', 55.4904, 9.4722],
  ['Horsens', 55.8607, 9.8503],
  ['Vejle', 55.7093, 9.5357],
  ['Roskilde', 55.6415, 12.0803],
  ['Herning', 56.1393, 8.9738],
  ['Hørsholm', 55.8811, 12.5009],
  ['Silkeborg', 56.1697, 9.5451],
  ['Næstved', 55.2299, 11.7609],
  ['Fredericia', 55.5657, 9.7526],
  ['Viborg', 56.4532, 9.402],
  ['Køge', 55.4581, 12.1822],
  ['Holstebro', 56.3601, 8.6161],
  ['Taastrup', 55.6517, 12.2925],
  ['Slagelse', 55.4028, 11.3546],
  ['Hillerød', 55.9267, 12.3109],
  ['Sønderborg', 54.9138, 9.7922],
  ['Svendborg', 55.0598, 10.6068],
  ['Hjørring', 57.4642, 9.9823],
  ['Holbæk', 55.7171, 11.7124],
  ['Frederikshavn', 57.441, 10.5366],
  ['Nørresundby', 57.0588, 9.9228],
  ['Ringsted', 55.4427, 11.79],
  ['Haderslev', 55.2537, 9.4898],
  ['Skive', 56.5666, 9.0273],
  ['Ølstykke', 55.7957, 12.1594],
  ['Nykøbing Falster', 54.7691, 11.8742],
  ['Greve', 55.5833, 12.3],
  ['Kastrup', 55.6333, 12.6333],
  ['Ballerup', 55.7317, 12.3633],
  ['Lyngby', 55.7704, 12.5038],
  ['Glostrup', 55.6667, 12.4],
  ['Albertslund', 55.6569, 12.3639],
  ['Brøndby', 55.65, 12.4167],
  ['Hvidovre', 55.6572, 12.4736],
  ['Rødovre', 55.6806, 12.4537],
  ['Herlev', 55.7237, 12.4399],
  ['Ishøj', 55.6154, 12.3518],
  ['Birkerød', 55.8473, 12.4283],
  ['Farum', 55.8085, 12.3602],
  ['Charlottenlund', 55.7518, 12.5735],
  ['Hellerup', 55.7322, 12.5706],
  ['Gentofte', 55.7484, 12.5502],
  ['Valby', 55.6614, 12.5163],
  ['Vanløse', 55.6872, 12.4913],
  ['Bagsværd', 55.7614, 12.4546],
  ['Virum', 55.7962, 12.4729],
  ['Holte', 55.8094, 12.4705],
  ['Værløse', 55.7826, 12.3725],
  ['Søborg', 55.7333, 12.5167],
  ['Skovlunde', 55.7167, 12.4],
  ['Hedehusene', 55.6528, 12.1942],
  ['Dragør', 55.5933, 12.6714],
  ['Helsingør', 56.0361, 12.6136],
  ['Skanderborg', 56.0343, 9.9301],
  ['Ikast', 56.1388, 9.1576],
  ['Grenaa', 56.4158, 10.8783],
  ['Thisted', 56.9552, 8.6943],
  ['Aabenraa', 55.0443, 9.4174],
  ['Billund', 55.7313, 9.1153],
  ['Odder', 55.9731, 10.1528],
  ['Middelfart', 55.5059, 9.7303],
  ['Nyborg', 55.3127, 10.7896],
  ['Kalundborg', 55.6795, 11.0886],
  ['Ebeltoft', 56.1944, 10.6821],
  ['Hadsten', 56.3277, 10.0491],
  ['Viby', 56.1281, 10.1608],
  ['Brabrand', 56.1557, 10.1101],
  ['Risskov', 56.1925, 10.2289],
  ['Højbjerg', 56.1213, 10.2105],
  ['Hinnerup', 56.2662, 10.0624],
  ['Ry', 56.0882, 9.7652],
  ['Brønderslev', 57.2702, 9.9411],
  ['Hobro', 56.6431, 9.7907],
  ['Varde', 55.6206, 8.4807],
  ['Ribe', 55.3282, 8.7612],
  ['Tønder', 54.9333, 8.8667],
  ['Vordingborg', 55.0088, 11.9105],
  ['Nakskov', 54.8306, 11.1361],
  ['Rønne', 55.1009, 14.7066],
  ['Faaborg', 55.0951, 10.2423],
  ['Assens', 55.2699, 9.9007],
  ['Lemvig', 56.5486, 8.3102],
  ['Struer', 56.4922, 8.5883],
  ['Ringkøbing', 56.09, 8.2442],
  ['Skagen', 57.7209, 10.5839],
  ['Vejen', 55.4812, 9.137],
  ['Grindsted', 55.7577, 8.9218],
  ['Brande', 55.9427, 9.1287],
  ['Tårnby', 55.6303, 12.6008],
  ['Solrød Strand', 55.5333, 12.2167],
  ['Frederikssund', 55.8396, 12.069],
  ['Helsinge', 56.0225, 12.1975],
  ['Hørning', 56.0866, 10.0373],
  ['Galten', 56.1531, 9.9077],
  ['Brøndbyvester', 55.665, 12.41],
  ['Tune', 55.594, 12.177],
  ['Sorø', 55.432, 11.556],
  ['Hedensted', 55.77, 9.701],
  ['Kjellerup', 56.286, 9.434],
  ['Hammel', 56.256, 9.861],
  ['Bjerringbro', 56.376, 9.661],
  ['Haslev', 55.323, 11.964],
  ['Nordborg', 55.057, 9.743],
  ['Fredensborg', 55.976, 12.405],
  ['Stenløse', 55.769, 12.192],
  ['Lillerød', 55.875, 12.344],
  ['Stavtrup', 56.135, 10.115],
  ['Kerteminde', 55.449, 10.657],
  ['Frederiksværk', 55.971, 12.022],
];

const CITY_BY_KEY = new Map(
  CITIES.map(([name, lat, lon]) => [cityKey(name), { name, lat, lon }]),
);

/** The table entry for a facet city name, or null when it is not placed. */
export function placeCity(name) {
  const key = cityKey(name);
  return CITY_BY_KEY.get(ALIASES.get(key) ?? key) ?? null;
}

/** Ground-circle radius: area grows with the count, bounded for legibility. */
export const radiusFor = (count) =>
  Math.min(12_000, Math.max(800, Math.round(Math.sqrt(count) * 35)));

const fmt = (n) => Number(n || 0).toLocaleString('en');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Only the aggregate parts of a host/count answer survive this line. */
function facetPairs(answer, name) {
  return (answer?.facets?.[name] || [])
    .map(({ value, count }) => ({ value: String(value), count: Number(count) }))
    .filter((f) => f.value && Number.isFinite(f.count));
}

export const CYBER_DATASETS = [
  {
    id: 'cyber-exposure',
    label: 'Cyber exposure per city (Shodan)',
    group: 'Defence',
    color: '#38bdf8',
    categories: {
      'Under 100': '#38bdf8',
      '100–1,000': '#facc15',
      '1,000–10,000': '#f97316',
      'Over 10,000': '#ef4444',
      'National summary': '#94a3b8',
    },
    ttlMs: DAY,
    credit: 'Data © Shodan (aggregate counts only)',
    creditUrl: 'https://www.shodan.io/',
    licence: 'Shodan API terms (attribution; no redistribution)',
    personalUse: true,
    available: () => Boolean(shodanKey()),
    async load({ fetchJson, wait = sleep }) {
      const key = shodanKey();
      if (!key) throw new Error('no_key');
      const count = (filter, facets) =>
        fetchJson(
          `${COUNT_URL}?${new URLSearchParams({
            key,
            query: `country:DK ${filter}`.trim(),
            facets,
          })}`,
          2 * MB,
        );

      // Sequential and spaced: Shodan rate-limits bursts per key.
      const all = await count('', 'city:100,port:8,product:8');
      const perCategory = {};
      for (const c of CYBER_CATEGORIES) {
        await wait(SPACING_MS);
        try {
          perCategory[c.key] = facetPairs(
            await count(c.filter, 'city:100'),
            'city',
          );
        } catch {
          perCategory[c.key] = null; // one category failing keeps the rest
        }
      }

      const cities = new Map();
      const unplaced = [];
      for (const { value, count: n } of facetPairs(all, 'city')) {
        const place = placeCity(value);
        if (!place) {
          unplaced.push({ value, count: n });
          continue;
        }
        const city = cities.get(place.name) ?? { ...place, total: 0, by: {} };
        city.total += n;
        cities.set(place.name, city);
      }
      for (const c of CYBER_CATEGORIES)
        for (const { value, count: n } of perCategory[c.key] || []) {
          const city = cities.get(placeCity(value)?.name);
          if (city) city.by[c.key] = (city.by[c.key] || 0) + n;
        }

      const categoryRows = (by) =>
        CYBER_CATEGORIES.map((c) => [
          c.label,
          perCategory[c.key] ? fmt(by[c.key]) : 'unavailable',
        ]);

      const features = [...cities.values()].map((city) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [city.lon, city.lat] },
        properties: displayProperties({
          title: city.name,
          subtitle: `${fmt(city.total)} internet-facing services`,
          category: band(city.total, TOTAL_BANDS),
          radiusM: radiusFor(city.total),
          rows: [['All services', fmt(city.total)], ...categoryRows(city.by)],
        }),
      }));

      const top = (name, n) =>
        facetPairs(all, name)
          .slice(0, n)
          .map((f) => `${f.value} (${fmt(f.count)})`)
          .join(', ');
      const national = {};
      for (const c of CYBER_CATEGORIES)
        national[c.key] = (perCategory[c.key] || []).reduce(
          (s, f) => s + f.count,
          0,
        );
      features.push({
        type: 'Feature',
        // In the North Sea off Jutland, clear of every city circle.
        geometry: { type: 'Point', coordinates: [7.9, 56.0] },
        properties: displayProperties({
          title: 'Denmark — national summary',
          subtitle: `${fmt(all?.total)} internet-facing services`,
          category: 'National summary',
          rows: [
            ['All services', fmt(all?.total)],
            ...categoryRows(national).map(([l, v]) => [`${l} (top cities)`, v]),
            ['Top ports', top('port', 5)],
            ['Top products', top('product', 4)],
            [
              'Not placed on map',
              [
                fmt(unplaced.reduce((s, f) => s + f.count, 0)),
                ...unplaced.slice(0, 4).map((f) => f.value),
              ].join(' · '),
            ],
          ],
        }),
      });
      return { features };
    },
  },
];
