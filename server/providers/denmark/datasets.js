import { cleanText, displayProperties } from './geometry.js';
import { utmToLonLat } from './utm.js';
import { readFirstSheet } from './xlsx.js';

/**
 * The Denmark pack's server-side dataset registry.
 *
 * Every upstream URL is fixed here; the proxy only ever fetches what this
 * file names, never a client-supplied URL. Each entry's `load` receives
 * bounded fetch helpers and returns `{ features, epsg?, tolerance? }`, where
 * every feature carries raw GeoJSON geometry and the display contract from
 * `displayProperties`. Normalization (reprojection, simplification, rounding,
 * vertex budget) happens once in the proxy, after `load`.
 *
 * Licences are recorded per dataset and surfaced in the app's attribution.
 * Sources marked `personalUse` must stay on a local install: they are fine to
 * show on screen, but are not to be republished.
 */

/** Denmark plus its surrounding seas, as lon/lat. */
export const DK_BBOX = Object.freeze([7.5, 54.4, 15.6, 58.0]);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

const EMODNET_WFS = 'https://ows.emodnet-humanactivities.eu/wfs';
const KULTURARV_WFS = 'https://www.kulturarv.dk/ffgeoserver/public/wfs';
const MILJOEPORTAL_WFS =
  'https://arealeditering-dist-geo.miljoeportal.dk/geoserver/wfs';
const GEOFA_WFS = 'https://geofa.geodanmark.dk/ows/fkg/fkg';

/** A WFS GetFeature URL returning GeoJSON in lon/lat order. */
export function wfsUrl(base, typeName, { bbox, cql, properties, max } = {}) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
  });
  if (bbox) params.set('bbox', `${bbox.join(',')},EPSG:4326`);
  if (cql) params.set('CQL_FILTER', cql);
  if (properties) params.set('propertyName', properties.join(','));
  if (max) params.set('maxFeatures', String(max));
  return `${base}?${params}`;
}

/** Load several EMODnet layers around Denmark and tag each with its layer. */
async function emodnet(fetchJson, layers, cap) {
  const collections = await Promise.all(
    layers.map((layer) =>
      fetchJson(
        wfsUrl(EMODNET_WFS, `emodnet:${layer}`, { bbox: DK_BBOX }),
        cap,
      ),
    ),
  );
  return collections.flatMap((collection, index) =>
    (collection?.features || []).map((feature) => ({
      ...feature,
      layer: layers[index],
    })),
  );
}

const feature = (geometry, props) => ({
  type: 'Feature',
  geometry,
  properties: displayProperties(props),
});

/** The newest technology wins the site's colour. */
const MAST_TECH_RANK = [
  '5G',
  'LTE',
  'UMTS',
  'GSM',
  'GSM-R',
  'Broadcast',
  'Other',
];
function mastTechnology(name) {
  const value = String(name || '').toUpperCase();
  if (value.includes('5G') || value.includes('NR')) return '5G';
  if (value.includes('LTE')) return 'LTE';
  if (value.includes('UMTS')) return 'UMTS';
  if (value === 'GSM-R') return 'GSM-R';
  if (value.includes('GSM')) return 'GSM';
  if (/DVB|DAB|FM|TV|RADIO/.test(value)) return 'Broadcast';
  return 'Other';
}

/** Periods in Fund og Fortidsminder's `datering`, oldest first. */
const PERIODS = [
  'Stenalder',
  'Bronzealder',
  'Jernalder',
  'Oldtid',
  'Vikingetid',
  'Middelalder',
  'Nyere tid',
  'Udateret',
];
const period = (value) =>
  PERIODS.find((name) => String(value || '').startsWith(name)) || 'Udateret';

/** Monument types recorded for 19th- and 20th-century military works. */
const MILITARY_HERITAGE_TYPES = [
  'Batteri',
  'Befæstning',
  'Luftværnsanlæg',
  'Kommunikationsanlæg',
  'Skanse',
];

/** Facility types worth a pin on a national map, out of GeoFA's ~90. */
const OUTDOOR_TYPES = new Map([
  ['Shelter', 'Shelter'],
  ['Bålhytte', 'Bålhytte'],
  ['Tørvejrsrum/Madpakkehus', 'Shelter'],
  ['Teltplads', 'Teltplads'],
  ['Fugletårn/Udsigtstårn', 'Udsigtstårn'],
  ['Udsigtspunkt', 'Udsigtstårn'],
  ['Blå flag badested', 'Badested'],
  ['Badestrand/-sted', 'Badested'],
]);

/** Trafikstyrelsen's colour codes: 1 red, 4 orange, 5 blue. */
const DRONE_ZONE = { 1: 'Red', 4: 'Orange', 5: 'Blue' };

const kilometres = (value) => {
  const match = /([\d.,]+)\s*km/i.exec(String(value || ''));
  return match ? Number(match[1].replace(',', '.')) * 1000 : null;
};

export const DATASETS = [
  {
    id: 'masts',
    label: 'Mobile & broadcast masts',
    group: 'Infrastructure',
    color: '#22d3ee',
    categories: {
      '5G': '#e879f9',
      LTE: '#22d3ee',
      UMTS: '#38bdf8',
      GSM: '#a3e635',
      'GSM-R': '#facc15',
      Broadcast: '#fb923c',
      Other: '#94a3b8',
    },
    ttlMs: 7 * DAY,
    credit: 'Mastedatabasen (Digitaliseringsstyrelsen)',
    creditUrl: 'https://mastedatabasen.dk/',
    licence: 'Danish public open data',
    async load({ fetchJson }) {
      const rows = await fetchJson(
        'https://mastedatabasen.dk/Master/antenner.json?maxantal=200000',
        160 * MB,
      );
      if (!Array.isArray(rows)) throw new Error('masts_malformed');
      // One record per antenna; a site carries several. Group by position.
      const sites = new Map();
      for (const row of rows) {
        const lat = Number(row?.wgs84koordinat?.bredde);
        const lon = Number(row?.wgs84koordinat?.laengde);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
        let site = sites.get(key);
        if (!site) {
          site = {
            lon,
            lat,
            address: [cleanText(row.vejnavn?.navn), cleanText(row.husnr)]
              .filter(Boolean)
              .join(' '),
            town: [row.postnummer?.nr, cleanText(row.postnummer?.navn)]
              .filter(Boolean)
              .join(' '),
            techs: new Set(),
            bands: new Set(),
            since: '',
          };
          sites.set(key, site);
        }
        site.techs.add(cleanText(row.teknologi?.navn));
        if (row.frekvensbaand) site.bands.add(cleanText(row.frekvensbaand));
        const date = cleanText(row.idriftsaettelsesdato);
        if (date && (!site.since || date < site.since)) site.since = date;
      }
      const features = [...sites.values()].map((site) => {
        const techs = [...site.techs].filter(Boolean);
        const category = techs
          .map(mastTechnology)
          .sort(
            (a, b) => MAST_TECH_RANK.indexOf(a) - MAST_TECH_RANK.indexOf(b),
          )[0];
        return feature(
          { type: 'Point', coordinates: [site.lon, site.lat] },
          {
            title: site.address || 'Antenna site',
            subtitle: site.town,
            category: category || 'Other',
            rows: [
              ['Technology', techs.sort().join(', ')],
              ['Bands', [...site.bands].filter(Boolean).sort().join(', ')],
              ['In service since', site.since],
            ],
          },
        );
      });
      return { features };
    },
  },
  {
    id: 'drone-zones',
    label: 'Drone no-fly zones',
    group: 'Defence & airspace',
    color: '#ef4444',
    categories: { Red: '#ef4444', Orange: '#f97316', Blue: '#3b82f6' },
    ttlMs: DAY,
    credit: 'Trafikstyrelsen — dronezoner',
    creditUrl: 'https://www.droneregler.dk/',
    licence: 'Trafikstyrelsen; download marked for personal use',
    personalUse: true,
    async load({ fetchJson }) {
      const collection = await fetchJson(
        'https://trafikstyrelsen.maps.arcgis.com/sharing/rest/content/items/980697acd04d4a9bb1fd34bbefab924a/data',
        40 * MB,
      );
      const features = (collection?.features || []).flatMap((raw) => {
        const p = raw.properties || {};
        const zone = DRONE_ZONE[p.Farve];
        if (!zone) return [];
        const radiusM = kilometres(p.Bufferzone);
        // A point without a buffer is a label anchor, not a zone.
        if (raw.geometry?.type === 'Point' && !radiusM) return [];
        return [
          feature(raw.geometry, {
            title: cleanText(p.title) || cleanText(p.typeId),
            subtitle: `${zone} zone · ${cleanText(p.typeId)}`,
            category: zone,
            radiusM: raw.geometry?.type === 'Point' ? radiusM : undefined,
            rows: [
              ['Type', p.typeId],
              ['Buffer', p.Bufferzone],
              ['ICAO', p.ICAO],
              ['Note', p.Kommentar],
            ],
          }),
        ];
      });
      return { features, tolerance: 0.0002 };
    },
  },
  {
    id: 'military-sea-areas',
    label: 'Military exercise areas at sea',
    group: 'Defence & airspace',
    color: '#f43f5e',
    ttlMs: 30 * DAY,
    credit: 'EMODnet Human Activities',
    creditUrl: 'https://emodnet.ec.europa.eu/en/human-activities',
    licence: 'CC BY 4.0',
    async load({ fetchJson }) {
      const raw = await emodnet(fetchJson, ['militaryareaspoly'], 20 * MB);
      const features = raw.map((f) => {
        const p = f.properties || {};
        const types = [p.type_1, p.type_2, p.type_3]
          .map((t) => cleanText(t))
          .filter(Boolean);
        return feature(f.geometry, {
          title: types[0] || 'Military area',
          subtitle: cleanText(p.country),
          rows: [
            ['Use', types.join(', ')],
            ['Country', p.country],
            ['Status', p.status],
            [
              'Area',
              Number.isFinite(p.areakm) ? `${Math.round(p.areakm)} km²` : '',
            ],
          ],
          url: p.resource,
        });
      });
      return { features, tolerance: 0.001 };
    },
  },
  {
    id: 'military-heritage',
    label: 'Bunkers, batteries & fortifications',
    group: 'Defence & airspace',
    color: '#a8a29e',
    ttlMs: 30 * DAY,
    credit: 'Fund og Fortidsminder — Slots- og Kulturstyrelsen',
    creditUrl: 'https://www.kulturarv.dk/fundogfortidsminder/',
    licence: 'Danish public open data',
    async load({ fetchJson }) {
      const cql = `anlaegstype IN (${MILITARY_HERITAGE_TYPES.map((t) => `'${t}'`).join(',')})`;
      const layers = await Promise.all(
        ['punkt_fredet', 'punkt_ikkefredet'].map((layer) =>
          fetchJson(
            wfsUrl(KULTURARV_WFS, `public:fundogfortidsminder_${layer}`, {
              cql,
            }),
            20 * MB,
          ),
        ),
      );
      const features = layers.flatMap((collection, index) =>
        (collection?.features || []).map((f) => {
          const p = f.properties || {};
          return feature(f.geometry, {
            title: p.anlaegstype,
            subtitle: `${cleanText(p.datering)} · ${index === 0 ? 'protected' : 'registered'}`,
            category: p.anlaegstype,
            rows: [
              ['Type', p.anlaegstype],
              ['Period', p.datering],
              ['Protection no.', p.frednr],
            ],
            url: String(p.url || '').replace(/^http:/, 'https:'),
          });
        }),
      );
      return { features };
    },
  },
  {
    id: 'munitions',
    label: 'Dumped munitions',
    group: 'Sea',
    color: '#dc2626',
    categories: { Chemical: '#a855f7', Conventional: '#dc2626' },
    ttlMs: 30 * DAY,
    credit: 'EMODnet Human Activities (OSPAR, HELCOM)',
    creditUrl: 'https://emodnet.ec.europa.eu/en/human-activities',
    licence: 'CC BY 4.0',
    async load({ fetchJson }) {
      const raw = await emodnet(
        fetchJson,
        ['munitions', 'munitionspoly'],
        20 * MB,
      );
      const features = raw.map((f) => {
        const p = f.properties || {};
        const type = cleanText(p.munition_type || p.munitiontype || p.type);
        const description = cleanText(p.description || p.descriptio, 300);
        return feature(f.geometry, {
          title: description.split('.')[0] || 'Dumped munitions',
          subtitle: type,
          category: /chem/i.test(type) ? 'Chemical' : 'Conventional',
          rows: [
            ['Type', type],
            ['Details', description],
            ['Year', p.thedate],
          ],
          url: p.infoprov,
        });
      });
      return { features, tolerance: 0.0005 };
    },
  },
  {
    id: 'wrecks',
    label: 'Wrecks & marine heritage',
    group: 'Sea',
    color: '#0ea5e9',
    categories: { Wreck: '#0ea5e9', Heritage: '#14b8a6' },
    ttlMs: 30 * DAY,
    credit: 'EMODnet Human Activities; Fund og Fortidsminder',
    creditUrl: 'https://emodnet.ec.europa.eu/en/human-activities',
    licence: 'CC BY 4.0; Danish public open data',
    async load({ fetchJson }) {
      const [wrecks, marine] = await Promise.all([
        emodnet(fetchJson, ['wwshipwrecks'], 30 * MB),
        fetchJson(
          wfsUrl(KULTURARV_WFS, 'public:fundogfortidsminder_punkt_marin'),
          40 * MB,
        ),
      ]);
      const features = [
        ...wrecks.map((f) => {
          const p = f.properties || {};
          return feature(f.geometry, {
            title: cleanText(p.name) || cleanText(p.wreck_cate) || 'Wreck',
            subtitle: cleanText(p.wreck_cate),
            category: 'Wreck',
            rows: [
              ['Category', p.wreck_cate],
              ['Type', p.type],
              ['Flag', p.flag],
              ['Water depth', p.water_dept ? `${p.water_dept} m` : ''],
            ],
          });
        }),
        ...(marine?.features || []).map((f) => {
          const p = f.properties || {};
          return feature(f.geometry, {
            title: p.anlaegstype,
            subtitle: cleanText(p.datering),
            category: 'Heritage',
            rows: [
              ['Type', p.anlaegstype],
              ['Period', p.datering],
            ],
            url: String(p.url || '').replace(/^http:/, 'https:'),
          });
        }),
      ];
      return { features };
    },
  },
  {
    id: 'nav-warnings',
    label: 'Navigational warnings',
    group: 'Sea',
    color: '#facc15',
    categories: { NW: '#ef4444', NM: '#facc15' },
    ttlMs: 30 * 60_000,
    credit: 'Danish Maritime Authority — Niord',
    creditUrl: 'https://niord.dma.dk/',
    licence: 'Danish public open data',
    async load({ fetchJson }) {
      const messages = await fetchJson(
        'https://niord.dma.dk/rest/public/v1/messages?lang=en',
        20 * MB,
      );
      if (!Array.isArray(messages)) throw new Error('niord_malformed');
      const features = messages.flatMap((message) => {
        const desc =
          message.descs?.find((d) => d.lang === 'en') ||
          message.descs?.[0] ||
          {};
        return (message.parts || []).flatMap((part) => {
          const partDesc =
            part.descs?.find((d) => d.lang === 'en') || part.descs?.[0] || {};
          return (part.geometry?.features || []).map((f) =>
            feature(f.geometry, {
              title:
                cleanText(desc.title) ||
                cleanText(partDesc.subject) ||
                message.shortId,
              subtitle: `${message.shortId || ''} · ${cleanText(message.type).toLowerCase().replace(/_/g, ' ')}`,
              category: message.mainType,
              rows: [
                ['Id', message.shortId],
                ['Area', message.areas?.[0]?.descs?.[0]?.name],
                ['Details', partDesc.details],
                [
                  'Published',
                  message.publishDateFrom
                    ? new Date(message.publishDateFrom)
                        .toISOString()
                        .slice(0, 10)
                    : '',
                ],
              ],
            }),
          );
        });
      });
      return { features };
    },
  },
  {
    id: 'wind-farms',
    label: 'Offshore wind farms',
    group: 'Infrastructure',
    color: '#4ade80',
    categories: {
      Production: '#4ade80',
      Construction: '#facc15',
      Approved: '#60a5fa',
      Planned: '#94a3b8',
    },
    ttlMs: 30 * DAY,
    credit: 'EMODnet Human Activities',
    creditUrl: 'https://emodnet.ec.europa.eu/en/human-activities',
    licence: 'CC BY 4.0',
    async load({ fetchJson }) {
      const raw = await emodnet(fetchJson, ['windfarmspoly'], 20 * MB);
      const features = raw.map((f) => {
        const p = f.properties || {};
        return feature(f.geometry, {
          title: cleanText(p.name) || 'Wind farm',
          subtitle: [cleanText(p.status), cleanText(p.country)]
            .filter(Boolean)
            .join(' · '),
          category: cleanText(p.status) || 'Planned',
          rows: [
            ['Turbines', p.n_turbines],
            ['Capacity', p.power_mw ? `${p.power_mw} MW` : ''],
            ['Status', p.status],
            ['In service', p.year],
            ['Country', p.country],
          ],
        });
      });
      return { features, tolerance: 0.0005 };
    },
  },
  {
    id: 'subsea-lines',
    label: 'Subsea cables & pipelines',
    group: 'Infrastructure',
    color: '#c084fc',
    categories: { Cable: '#c084fc', Pipeline: '#f59e0b' },
    ttlMs: 30 * DAY,
    credit: 'EMODnet Human Activities (BSH and national sources)',
    creditUrl: 'https://emodnet.ec.europa.eu/en/human-activities',
    licence: 'CC BY 4.0',
    async load({ fetchJson }) {
      const raw = await emodnet(
        fetchJson,
        ['pipelines', 'bshcontiscables', 'pcablesbshcontis'],
        60 * MB,
      );
      const features = raw.map((f) => {
        const p = f.properties || {};
        const pipeline = f.layer === 'pipelines';
        return feature(f.geometry, {
          title:
            cleanText(p.name || p.name_1 || p.descriptio || p.title) ||
            (pipeline ? 'Pipeline' : 'Subsea cable'),
          subtitle: cleanText(p.status || p.medium || p.type),
          category: pipeline ? 'Pipeline' : 'Cable',
          rows: [
            ['Operator', p.operator || p.owner],
            ['Medium', p.medium || p.product],
            ['Status', p.status],
            ['Country', p.country],
          ],
        });
      });
      return { features, tolerance: 0.0005 };
    },
  },
  {
    id: 'lighthouses',
    label: 'Lighthouses',
    group: 'Sea',
    color: '#fde047',
    ttlMs: 30 * DAY,
    credit: 'EMODnet Human Activities',
    creditUrl: 'https://emodnet.ec.europa.eu/en/human-activities',
    licence: 'CC BY 4.0',
    async load({ fetchJson }) {
      const raw = await emodnet(fetchJson, ['lighthouses'], 10 * MB);
      const features = raw.map((f) => {
        const p = f.properties || {};
        return feature(f.geometry, {
          title: cleanText(p.name) || 'Lighthouse',
          subtitle: cleanText(p.country),
          rows: [
            ['Country', p.country],
            ['Height', p.height ? `${p.height} m` : ''],
            ['Range', p.range ? `${p.range} nm` : ''],
          ],
        });
      });
      return { features };
    },
  },
  {
    id: 'monuments',
    label: 'Protected ancient monuments',
    group: 'Heritage',
    color: '#d97706',
    categories: {
      Stenalder: '#78716c',
      Bronzealder: '#d97706',
      Jernalder: '#b45309',
      Oldtid: '#a16207',
      Vikingetid: '#dc2626',
      Middelalder: '#7c3aed',
      'Nyere tid': '#2563eb',
      Udateret: '#94a3b8',
    },
    ttlMs: 30 * DAY,
    credit: 'Fund og Fortidsminder — Slots- og Kulturstyrelsen',
    creditUrl: 'https://www.kulturarv.dk/fundogfortidsminder/',
    licence: 'Danish public open data',
    async load({ fetchJson }) {
      const collection = await fetchJson(
        wfsUrl(KULTURARV_WFS, 'public:fundogfortidsminder_punkt_fredet', {
          properties: ['geom', 'anlaegstype', 'datering', 'frednr', 'url'],
        }),
        60 * MB,
      );
      const features = (collection?.features || []).map((f) => {
        const p = f.properties || {};
        return feature(f.geometry, {
          title: p.anlaegstype,
          subtitle: cleanText(p.datering),
          category: period(p.datering),
          rows: [
            ['Type', p.anlaegstype],
            ['Period', p.datering],
            ['Protection no.', p.frednr],
          ],
          url: String(p.url || '').replace(/^http:/, 'https:'),
        });
      });
      return { features };
    },
  },
  {
    id: 'natura2000',
    label: 'Natura 2000 areas',
    group: 'Nature & outdoors',
    color: '#16a34a',
    categories: { Habitat: '#16a34a', Bird: '#65a30d' },
    ttlMs: 30 * DAY,
    credit: 'Danmarks Arealinformation — Miljøstyrelsen',
    creditUrl: 'https://miljoeportal.dk/',
    licence: 'Danish public open data',
    async load({ fetchJson }) {
      const [habitat, birds] = await Promise.all(
        ['dai:habitat_omr', 'dai:fugle_bes_omr'].map((layer) =>
          fetchJson(wfsUrl(MILJOEPORTAL_WFS, layer), 120 * MB),
        ),
      );
      const features = [
        [habitat, 'Habitat'],
        [birds, 'Bird'],
      ].flatMap(([collection, kind]) =>
        (collection?.features || []).map((f) => {
          const p = f.properties || {};
          return feature(f.geometry, {
            title: p.Objektnavn || p.objektnavn,
            subtitle: `${kind === 'Habitat' ? 'Habitat area' : 'Bird protection area'} ${cleanText(p.Site_ident || p.site_ident)}`,
            category: kind,
            rows: [
              ['Site', p.Site_ident || p.site_ident],
              [
                'Area',
                Number.isFinite(p.Shape_area)
                  ? `${(p.Shape_area / 1e6).toFixed(1)} km²`
                  : '',
              ],
            ],
          });
        }),
      );
      return { features, tolerance: 0.0004 };
    },
  },
  {
    id: 'outdoors',
    label: 'Shelters, camps & viewpoints',
    group: 'Nature & outdoors',
    color: '#84cc16',
    categories: {
      Shelter: '#84cc16',
      Bålhytte: '#f97316',
      Teltplads: '#22c55e',
      Udsigtstårn: '#a78bfa',
      Badested: '#38bdf8',
    },
    ttlMs: 7 * DAY,
    credit: 'GeoFA — Danish facilities database (Udinaturen)',
    creditUrl: 'https://www.geofa.dk/',
    licence: 'Danish public open data',
    async load({ fetchJson }) {
      const params = new URLSearchParams({
        service: 'WFS',
        version: '1.1.0',
        request: 'GetFeature',
        typeName: 'fkg:fkg.t_5800_fac_pkt',
        outputFormat: 'application/json',
        propertyName: 'geometri,facil_ty,navn,beskrivels,ansvar_org',
        maxFeatures: '60000',
      });
      const collection = await fetchJson(`${GEOFA_WFS}?${params}`, 80 * MB);
      const features = (collection?.features || []).flatMap((f) => {
        const p = f.properties || {};
        const category = OUTDOOR_TYPES.get(p.facil_ty);
        if (!category) return [];
        return [
          feature(f.geometry, {
            title: cleanText(p.navn) || p.facil_ty,
            subtitle: p.facil_ty,
            category,
            rows: [
              ['Type', p.facil_ty],
              ['About', p.beskrivels],
              ['Managed by', p.ansvar_org],
            ],
          }),
        ];
      });
      return { features, epsg: 25832 };
    },
  },
  {
    id: 'water-stations',
    label: 'Water level & flow stations',
    group: 'Nature & outdoors',
    color: '#38bdf8',
    categories: {
      Vandløb: '#38bdf8',
      Sø: '#2563eb',
      Hav: '#1e40af',
      Havn: '#64748b',
    },
    ttlMs: 7 * DAY,
    credit: 'VanDa — Danmarks Miljøportal / Miljøstyrelsen',
    creditUrl: 'https://vandah.miljoeportal.dk/',
    licence: 'Danish public open data',
    async load({ fetchJson }) {
      const stations = await fetchJson(
        'https://vandah.miljoeportal.dk/api/stations?format=json',
        30 * MB,
      );
      if (!Array.isArray(stations)) throw new Error('vanda_malformed');
      const keep = new Set(['Vandløb', 'Sø', 'Hav', 'Havn']);
      const features = stations.flatMap((s) => {
        if (!keep.has(s.locationType) || String(s.location?.srid) !== '25832')
          return [];
        return [
          feature(
            { type: 'Point', coordinates: [s.location.x, s.location.y] },
            {
              title: s.name,
              subtitle: s.locationType,
              category: s.locationType,
              rows: [
                ['Station', s.stationId],
                ['Type', s.locationType],
                ['Owner', s.stationOwnerName],
                [
                  'Catchment',
                  s.catchmentAreaKm2 ? `${s.catchmentAreaKm2} km²` : '',
                ],
              ],
            },
          ),
        ];
      });
      return { features, epsg: 25832 };
    },
  },
];

/** ENS publishes the turbine register under a new media id each month. */
const ENS_DATA_PAGE =
  'https://ens.dk/analyser-og-statistik/data-oversigt-over-energisektoren';
const number = (value) => {
  const n = Number(
    String(value ?? '')
      .replace(/\s/g, '')
      .replace(',', '.'),
  );
  return Number.isFinite(n) ? n : null;
};

DATASETS.push({
  id: 'wind-turbines',
  label: 'Wind turbines (every one)',
  group: 'Infrastructure',
  color: '#f8fafc',
  categories: { Land: '#f8fafc', Offshore: '#4ade80' },
  ttlMs: 14 * DAY,
  credit: 'Energistyrelsen — stamdataregister for vindmøller',
  creditUrl: ENS_DATA_PAGE,
  licence: 'Danish public open data',
  async load({ fetchText, fetchBytes }) {
    const page = await fetchText(ENS_DATA_PAGE, 4 * MB);
    const media =
      /href="(?:https:\/\/ens\.dk)?\/media\/(\d+)\/download"[^>]*>\s*Vinddata\b/i.exec(
        page,
      )?.[1];
    if (!media) throw new Error('turbine_register_link_not_found');
    const rows = readFirstSheet(
      await fetchBytes(`https://ens.dk/media/${media}/download`, 40 * MB),
    );
    const header = rows.findIndex((row) => /GSRN/i.test(row.A || ''));
    if (header < 0) throw new Error('turbine_register_malformed');
    const months = Object.entries(rows[header]).filter(([, v]) =>
      /^\d{4}-\d{2}$/.test(v),
    );
    const features = [];
    for (const row of rows.slice(header + 1)) {
      if (!/^\d{18}$/.test(row.A || '') || row.D) continue; // decommissioned
      const x = number(row.N);
      const y = number(row.O);
      if (!x || !y) continue;
      // Bornholm is registered in UTM 33 unless the row was already reprojected.
      const zone = String(row.K).startsWith('400') && x < 700_000 ? 33 : 32;
      const [lon, lat] = utmToLonLat(x, y, zone);
      const offshore = row.J === 'HAV';
      const lastYear = months
        .slice(-12)
        .reduce((sum, [column]) => sum + (number(row[column]) || 0), 0);
      const kw = number(row.E);
      features.push(
        feature(
          { type: 'Point', coordinates: [lon, lat] },
          {
            title: [cleanText(row.H), cleanText(row.I)]
              .filter(Boolean)
              .join(' '),
            subtitle: `${kw ? `${kw >= 1000 ? `${kw / 1000} MW` : `${kw} kW`}` : ''} · ${cleanText(String(row.K).replace(/^\d+ - /, ''))}`,
            category: offshore ? 'Offshore' : 'Land',
            rows: [
              ['Hub height', row.G ? `${row.G} m` : ''],
              ['Rotor', row.F ? `${row.F} m` : ''],
              ['Capacity', kw ? `${kw} kW` : ''],
              ['Grid since', row.C],
              [
                'Last 12 mo.',
                lastYear
                  ? `${Math.round(lastYear / 1000).toLocaleString('en')} MWh`
                  : '',
              ],
              ['GSRN', row.A],
            ],
          },
        ),
      );
    }
    return { features };
  },
});

export const DATASET_BY_ID = new Map(DATASETS.map((d) => [d.id, d]));

/** The public, JSON-safe catalog the client renders its chips from. */
export function publicCatalog() {
  return DATASETS.map(
    ({
      id,
      label,
      group,
      color,
      categories,
      credit,
      creditUrl,
      licence,
      personalUse,
    }) => ({
      id,
      label,
      group,
      color,
      categories: categories || null,
      credit,
      creditUrl,
      licence,
      personalUse: Boolean(personalUse),
    }),
  );
}
