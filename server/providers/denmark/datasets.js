import { cleanText, displayProperties } from './geometry.js';
import { utmToLonLat } from './utm.js';
import { readFirstSheet } from './xlsx.js';
import { aisShipClass, sampleAisTracks, zipFirstEntryLines } from './ais.js';
import { DEFENCE_DATASETS } from './defence.js';
import { MOVEMENT_DATASETS } from './movement.js';
import { ENVIRONMENT_DATASETS } from './environment.js';
import { IMAGERY_DATASETS } from './imagery.js';

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
  const text = String(value ?? '')
    .replace(/\s/g, '')
    .replace(',', '.');
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};
/** "Vejtemperatur: 14.0 C" → 14 — the description carries one more decimal. */
const labelled = (text, label) =>
  number(new RegExp(`${label}:\\s*(-?[\\d.]+)`).exec(String(text || ''))?.[1]);

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

// ---- Live feeds (wave B) ------------------------------------------------

const MINUTE = 60_000;
const DMI = 'https://opendataapi.dmi.dk';
/** DMI's own region of interest: Denmark, its seas and the near neighbours. */
const DMI_BBOX = '3,53,18,59.5';
const isoMinutesAgo = (now, minutes) =>
  new Date(now - minutes * MINUTE).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Latest observation per station for one DMI parameter. */
async function dmiLatest(fetchJson, api, parameterId, now, minutes = 40) {
  const url =
    `${DMI}/v2/${api}/collections/observation/items?parameterId=${parameterId}` +
    `&datetime=${isoMinutesAgo(now, minutes)}/..&bbox=${DMI_BBOX}&limit=20000`;
  const collection = await fetchJson(url, 30 * MB);
  const latest = new Map();
  for (const f of collection?.features || []) {
    const p = f.properties || {};
    const prior = latest.get(p.stationId);
    if (!prior || p.observed > prior.properties.observed)
      latest.set(p.stationId, f);
  }
  return latest;
}
async function dmiStations(fetchJson, api) {
  const collection = await fetchJson(
    `${DMI}/v2/${api}/collections/station/items?status=Active&bbox=${DMI_BBOX}&limit=10000`,
    30 * MB,
  );
  const names = new Map();
  for (const f of collection?.features || []) {
    const p = f.properties || {};
    if (!names.has(p.stationId)) names.set(p.stationId, p.name);
  }
  return names;
}
const hhmm = (iso) => (iso ? `${String(iso).slice(11, 16)} UTC` : '');

const TRAFFIC_LAYERS = [
  ['current-roadwork', 'Roadwork'],
  ['current-events', 'Incident'],
  ['current-queue', 'Queue'],
  ['current-roadblocks', 'Closed'],
  ['current-slippery-road', 'Slippery'],
  ['current-strong-wind-traffic-announcements', 'Wind'],
  ['current-ice-snow', 'Snow & ice'],
  ['winther-condition-saltspreder-position', 'Gritter'],
  ['current-swedish-accidents', 'Sweden'],
];
const TRAFFIC_GEOJSON =
  'https://storage.googleapis.com/trafikkort-data/geojson/25832';

/** Interconnector endpoints, roughly at each cable's landfall. */
const GRID_NODES = {
  DK1: [9.35, 56.15],
  DK2: [11.95, 55.45],
  DE: [9.75, 53.95],
  NL: [6.85, 53.43],
  GB: [0.17, 52.93],
  NO: [7.95, 58.15],
  SE1: [11.95, 57.65],
  SE2: [13.05, 55.62],
  BORNHOLM: [14.9, 55.12],
};
const INTERCONNECTORS = [
  ['Exchange_DK1_DE', 'DK1', 'DE', 'DK1 ↔ Germany'],
  ['Exchange_DK1_NL', 'DK1', 'NL', 'COBRAcable ↔ Netherlands'],
  ['Exchange_DK1_GB', 'DK1', 'GB', 'Viking Link ↔ Great Britain'],
  ['Exchange_DK1_NO', 'DK1', 'NO', 'Skagerrak ↔ Norway'],
  ['Exchange_DK1_SE', 'DK1', 'SE1', 'Konti-Skan ↔ Sweden'],
  ['Exchange_DK1_DK2', 'DK1', 'DK2', 'Storebælt link DK1 ↔ DK2'],
  ['Exchange_DK2_DE', 'DK2', 'DE', 'Kontek ↔ Germany'],
  ['Exchange_DK2_SE', 'DK2', 'SE2', 'Øresund ↔ Sweden'],
  ['Exchange_Bornholm_SE', 'BORNHOLM', 'SE2', 'Bornholm ↔ Sweden'],
];
const AUTOBAHNS = ['A7', 'A1', 'A23', 'A210', 'A215'];

DATASETS.push(
  {
    id: 'lightning',
    label: 'Lightning (last hour)',
    group: 'Live',
    color: '#fde047',
    categories: {
      '0–10 min': '#ffffff',
      '10–30 min': '#fde047',
      '30–60 min': '#f97316',
    },
    ttlMs: 2 * MINUTE,
    allowEmpty: true,
    credit: 'DMI — Danmarks Meteorologiske Institut',
    creditUrl: 'https://www.dmi.dk/friedata',
    licence: 'CC BY 4.0',
    async load({ fetchJson, now }) {
      const collection = await fetchJson(
        `${DMI}/v2/lightningdata/collections/observation/items?datetime=${isoMinutesAgo(now, 60)}/..&bbox=${DMI_BBOX}&limit=20000`,
        30 * MB,
      );
      const features = (collection?.features || []).map((f) => {
        const p = f.properties || {};
        const age = (now - Date.parse(p.observed)) / MINUTE;
        return feature(f.geometry, {
          title:
            p.type === 2 ? 'Cloud-to-cloud flash' : 'Cloud-to-ground strike',
          subtitle: `${hhmm(p.observed)} · ${Math.max(0, Math.round(age))} min ago`,
          category:
            age < 10 ? '0–10 min' : age < 30 ? '10–30 min' : '30–60 min',
          rows: [
            ['Current', Number.isFinite(p.amp) ? `${p.amp} kA` : ''],
            ['Strokes', p.strokes],
            ['Observed', p.observed],
          ],
        });
      });
      return { features };
    },
  },
  {
    id: 'weather-stations',
    label: 'Weather stations (live)',
    group: 'Live',
    color: '#38bdf8',
    categories: {
      'Below 0 °C': '#a5b4fc',
      '0–10 °C': '#38bdf8',
      '10–20 °C': '#4ade80',
      'Above 20 °C': '#f97316',
    },
    ttlMs: 10 * MINUTE,
    credit: 'DMI — Danmarks Meteorologiske Institut',
    creditUrl: 'https://www.dmi.dk/friedata',
    licence: 'CC BY 4.0',
    async load({ fetchJson, now }) {
      const [names, temp, wind, gust, dir] = await Promise.all([
        dmiStations(fetchJson, 'metObs'),
        dmiLatest(fetchJson, 'metObs', 'temp_dry', now),
        dmiLatest(fetchJson, 'metObs', 'wind_speed', now),
        dmiLatest(fetchJson, 'metObs', 'wind_max', now),
        dmiLatest(fetchJson, 'metObs', 'wind_dir', now),
      ]);
      const features = [...temp.values()].map((f) => {
        const p = f.properties;
        const t = p.value;
        const w = wind.get(p.stationId)?.properties.value;
        return feature(f.geometry, {
          title: names.get(p.stationId) || `Station ${p.stationId}`,
          subtitle: `${t} °C${Number.isFinite(w) ? ` · wind ${w} m/s` : ''} · ${hhmm(p.observed)}`,
          category:
            t < 0
              ? 'Below 0 °C'
              : t < 10
                ? '0–10 °C'
                : t < 20
                  ? '10–20 °C'
                  : 'Above 20 °C',
          rows: [
            ['Temperature', `${t} °C`],
            ['Wind', Number.isFinite(w) ? `${w} m/s` : ''],
            [
              'Gust (10 min)',
              gust.has(p.stationId)
                ? `${gust.get(p.stationId).properties.value} m/s`
                : '',
            ],
            [
              'Direction',
              dir.has(p.stationId)
                ? `${dir.get(p.stationId).properties.value}°`
                : '',
            ],
            ['Station', p.stationId],
          ],
        });
      });
      return { features };
    },
  },
  {
    id: 'sea-level',
    label: 'Sea level gauges (live)',
    group: 'Live',
    color: '#60a5fa',
    categories: {
      'High (> +60 cm)': '#ef4444',
      Normal: '#60a5fa',
      'Low (< −60 cm)': '#a78bfa',
    },
    ttlMs: 10 * MINUTE,
    credit: 'DMI — Danmarks Meteorologiske Institut',
    creditUrl: 'https://www.dmi.dk/friedata',
    licence: 'CC BY 4.0',
    async load({ fetchJson, now }) {
      const [names, level] = await Promise.all([
        dmiStations(fetchJson, 'oceanObs'),
        dmiLatest(fetchJson, 'oceanObs', 'sealev_dvr', now, 60),
      ]);
      const features = [...level.values()].map((f) => {
        const p = f.properties;
        return feature(f.geometry, {
          title: names.get(p.stationId) || `Gauge ${p.stationId}`,
          subtitle: `${p.value > 0 ? '+' : ''}${p.value} cm (DVR90) · ${hhmm(p.observed)}`,
          category:
            p.value > 60
              ? 'High (> +60 cm)'
              : p.value < -60
                ? 'Low (< −60 cm)'
                : 'Normal',
          rows: [
            ['Water level', `${p.value} cm above DVR90`],
            ['Observed', p.observed],
            ['Station', p.stationId],
          ],
        });
      });
      return { features };
    },
  },
  {
    id: 'road-conditions',
    label: 'Roadworks & road incidents',
    group: 'Live',
    color: '#f59e0b',
    categories: {
      Roadwork: '#f59e0b',
      Incident: '#ef4444',
      Queue: '#dc2626',
      Closed: '#7f1d1d',
      Slippery: '#93c5fd',
      Wind: '#a78bfa',
      'Snow & ice': '#e0f2fe',
      Gritter: '#22d3ee',
      Sweden: '#facc15',
    },
    ttlMs: 2 * MINUTE,
    allowEmpty: true,
    credit: 'Vejdirektoratet — trafikkort (public map feed)',
    creditUrl: 'https://trafikkort.vejdirektoratet.dk/',
    licence: 'Unofficial public map feed; official CC BY version via the NAP',
    personalUse: true,
    async load({ fetchJson }) {
      const settled = await Promise.allSettled(
        TRAFFIC_LAYERS.flatMap(([layer, kind]) =>
          ['point', 'line'].map(async (shape) => ({
            kind,
            collection: await fetchJson(
              `${TRAFFIC_GEOJSON}/${layer}.${shape}.json`,
              20 * MB,
            ),
          })),
        ),
      );
      const ok = settled
        .filter((r) => r.status === 'fulfilled')
        .map((r) => r.value);
      if (!ok.length) throw new Error('trafikkort_unavailable');
      // A message with a road stretch comes as both a line and a point; keep the line.
      const stretched = new Set(
        ok.flatMap(({ collection }) =>
          (collection?.features || [])
            .filter((f) => /LineString/.test(f.geometry?.type || ''))
            .map((f) => f.properties?.featureId),
        ),
      );
      const drawn = (f) =>
        f.geometry?.type !== 'Point' || !stretched.has(f.properties?.featureId);
      const features = ok.flatMap(({ kind, collection }) =>
        (collection?.features || []).filter(drawn).map((f) => {
          const p = f.properties || {};
          return feature(f.geometry, {
            title: cleanText(p.header || p.title) || kind,
            subtitle: [kind, cleanText(p.kommune)].filter(Boolean).join(' · '),
            category: kind,
            rows: [
              ['Details', p.description],
              ['From', p.beginPeriod],
              ['Until', p.endPeriod],
              ['Direction', p.direction],
            ],
          });
        }),
      );
      return { features, epsg: 25832, tolerance: 0.0001 };
    },
  },
  {
    id: 'road-temperatures',
    label: 'Road surface temperatures',
    group: 'Live',
    color: '#93c5fd',
    categories: {
      'Below 0 °C': '#e0f2fe',
      '0–3 °C': '#93c5fd',
      'Above 3 °C': '#4ade80',
    },
    ttlMs: 5 * MINUTE,
    credit: 'Vejdirektoratet — trafikkort (public map feed)',
    creditUrl: 'https://trafikkort.vejdirektoratet.dk/',
    licence: 'Unofficial public map feed; official CC BY version via the NAP',
    personalUse: true,
    async load({ fetchJson }) {
      const collection = await fetchJson(
        `${TRAFFIC_GEOJSON}/temperatures.point.json`,
        20 * MB,
      );
      const features = (collection?.features || []).flatMap((f) => {
        const p = f.properties || {};
        const road =
          labelled(p.description, 'Vejtemperatur') ??
          number(p.roadSurfaceTemperature);
        const air =
          labelled(p.description, 'Lufttemperatur') ?? number(p.airTemperature);
        const value = road ?? air;
        if (value === null) return [];
        return [
          feature(f.geometry, {
            title: `Road weather station ${cleanText(p.featureId)}`,
            subtitle: `Road ${road ?? '–'} °C · air ${air ?? '–'} °C`,
            category:
              value < 0 ? 'Below 0 °C' : value <= 3 ? '0–3 °C' : 'Above 3 °C',
            rows: [
              ['Road surface', road !== null ? `${road} °C` : ''],
              ['Air', air !== null ? `${air} °C` : ''],
              [
                'Dew point',
                p.dewPointTemperature ? `${p.dewPointTemperature} °C` : '',
              ],
              ['Humidity', p.relativeHumidity ? `${p.relativeHumidity} %` : ''],
              ['Measured', p.measurementTime],
            ],
          }),
        ];
      });
      return { features, epsg: 25832 };
    },
  },
  {
    id: 'power-flows',
    label: 'Power flows to neighbours (live)',
    group: 'Live',
    color: '#facc15',
    categories: { Export: '#f97316', Import: '#22d3ee', Grid: '#facc15' },
    ttlMs: 2 * MINUTE,
    credit: 'Energinet — Energi Data Service',
    creditUrl: 'https://www.energidataservice.dk/',
    licence: 'Energi Data Service terms (free, attribution)',
    async load({ fetchJson }) {
      const body = await fetchJson(
        'https://api.energidataservice.dk/dataset/PowerSystemRightNow?limit=1',
        1 * MB,
      );
      const r = body?.records?.[0];
      if (!r) throw new Error('energinet_empty');
      const mw = (v) => `${Math.round(Math.abs(v)).toLocaleString('en')} MW`;
      const at = `${String(r.Minutes1DK).slice(11, 16)} Danish time`;
      const features = INTERCONNECTORS.flatMap(([field, from, to, name]) => {
        const value = number(r[field]);
        if (value === null) return [];
        // Energinet signs flows as import into the first area: negative = export.
        const exporting = value < 0;
        return [
          feature(
            {
              type: 'LineString',
              coordinates: [GRID_NODES[from], GRID_NODES[to]],
            },
            {
              title: `${name}: ${mw(value)}`,
              subtitle: `${exporting ? 'Export from' : 'Import to'} ${from} · ${at}`,
              category:
                Math.abs(value) < 1 ? 'Grid' : exporting ? 'Export' : 'Import',
              width: Math.max(2, Math.min(14, Math.abs(value) / 150)),
              rows: [
                ['Flow', `${mw(value)} ${exporting ? 'out' : 'in'}`],
                ['Measured', at],
              ],
            },
          ),
        ];
      });
      for (const [area, label] of [
        ['DK1', 'West Denmark (DK1)'],
        ['DK2', 'East Denmark (DK2)'],
      ])
        features.push(
          feature(
            { type: 'Point', coordinates: GRID_NODES[area] },
            {
              title: label,
              subtitle: `National grid now · ${at}`,
              category: 'Grid',
              rows: [
                ['Offshore wind', mw(r.OffshoreWindPower)],
                ['Onshore wind', mw(r.OnshoreWindPower)],
                ['Solar', mw(r.SolarPower)],
                [
                  'Power plants',
                  mw((r.ProductionGe100MW || 0) + (r.ProductionLt100MW || 0)),
                ],
                [
                  'Net exchange',
                  `${mw(r.Exchange_Sum)} ${r.Exchange_Sum < 0 ? 'out' : 'in'}`,
                ],
                ['CO₂', `${Math.round(r.CO2Emission)} g/kWh`],
              ],
            },
          ),
        );
      return { features };
    },
  },
  {
    id: 'air-sensors',
    label: 'Citizen air sensors (PM2.5)',
    group: 'Live',
    color: '#a3e635',
    categories: {
      Good: '#22c55e',
      Fair: '#a3e635',
      Moderate: '#facc15',
      Poor: '#f97316',
      'Very poor': '#dc2626',
    },
    ttlMs: 10 * MINUTE,
    allowEmpty: true,
    credit: 'Sensor.Community',
    creditUrl: 'https://sensor.community/',
    licence: 'ODbL 1.0',
    async load({ fetchJson }) {
      const rows = await fetchJson(
        'https://data.sensor.community/airrohr/v1/filter/country=DK',
        20 * MB,
      );
      const sites = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.location?.indoor) continue;
        const values = Object.fromEntries(
          (row.sensordatavalues || []).map((v) => [
            v.value_type,
            number(v.value),
          ]),
        );
        if (values.P2 === undefined || values.P2 === null) continue;
        sites.set(row.location.id, { row, values });
      }
      // EAQI bands for PM2.5 (µg/m³).
      const band = (pm) =>
        pm <= 10
          ? 'Good'
          : pm <= 20
            ? 'Fair'
            : pm <= 25
              ? 'Moderate'
              : pm <= 50
                ? 'Poor'
                : 'Very poor';
      const features = [...sites.values()].map(({ row, values }) =>
        feature(
          {
            type: 'Point',
            coordinates: [
              number(row.location.longitude),
              number(row.location.latitude),
            ],
          },
          {
            title: `PM2.5 ${values.P2} µg/m³`,
            subtitle: `${band(values.P2)} (EAQI) · ${hhmm(String(row.timestamp).replace(' ', 'T'))}`,
            category: band(values.P2),
            rows: [
              ['PM2.5', `${values.P2} µg/m³`],
              ['PM10', values.P1 !== undefined ? `${values.P1} µg/m³` : ''],
              ['Sensor', row.sensor?.sensor_type?.name],
            ],
          },
        ),
      );
      return { features };
    },
  },
  {
    id: 'autobahn',
    label: 'German Autobahn warnings (north)',
    group: 'Live',
    color: '#fb7185',
    categories: { Warning: '#fb7185', Roadwork: '#f59e0b', Closure: '#7f1d1d' },
    ttlMs: 5 * MINUTE,
    allowEmpty: true,
    credit: 'Die Autobahn GmbH des Bundes',
    creditUrl: 'https://verkehr.autobahn.de/',
    licence: 'Public API (Autobahn GmbH)',
    async load({ fetchJson }) {
      const kinds = [
        ['warning', 'Warning'],
        ['roadworks', 'Roadwork'],
        ['closure', 'Closure'],
      ];
      const settled = await Promise.allSettled(
        AUTOBAHNS.flatMap((road) =>
          kinds.map(async ([service, kind]) => ({
            road,
            kind,
            body: await fetchJson(
              `https://verkehr.autobahn.de/o/autobahn/${road}/services/${service}`,
              10 * MB,
            ),
          })),
        ),
      );
      const features = settled
        .filter((r) => r.status === 'fulfilled')
        .flatMap(({ value: { road, kind, body } }) =>
          Object.values(body || {})
            .flat()
            .flatMap((item) => {
              const lat = number(item?.coordinate?.lat);
              const lon = number(item?.coordinate?.long);
              if (lat === null || lon === null || lat < 53.4) return [];
              return [
                feature(
                  { type: 'Point', coordinates: [lon, lat] },
                  {
                    title: cleanText(item.title) || `${road} ${kind}`,
                    subtitle: `${road} · ${kind}`,
                    category: kind,
                    rows: [
                      ['Details', (item.description || []).join(' ')],
                      ['Road', road],
                    ],
                  },
                ),
              ];
            }),
        );
      return { features };
    },
  },
);

/** Break a track where the receiver lost the ship, so gaps are not drawn as straight lines. */
function splitTrack(points) {
  const parts = [[]];
  let previous = null;
  for (const [lon, lat, t] of points) {
    if (
      previous &&
      (t - previous[2] > 45 * MINUTE ||
        Math.abs(lon - previous[0]) + Math.abs(lat - previous[1]) > 0.25)
    )
      parts.push([]);
    parts[parts.length - 1].push([lon, lat]);
    previous = [lon, lat, t];
  }
  return parts.filter((part) => part.length >= 2);
}

const AIS_BUCKET = 'http://aisdata.ais.dk.s3.eu-central-1.amazonaws.com';
DATASETS.push({
  id: 'ais-day',
  label: 'A day of shipping (AIS tracks)',
  group: 'Sea',
  color: '#94a3b8',
  categories: {
    Cargo: '#22c55e',
    Tanker: '#ef4444',
    'Passenger & ferry': '#3b82f6',
    Fishing: '#f59e0b',
    'Military & police': '#e879f9',
    'Service & SAR': '#14b8a6',
    Leisure: '#cbd5e1',
    Other: '#64748b',
  },
  ttlMs: 7 * DAY,
  credit: 'Danish Maritime Authority — historical AIS (aisdata.ais.dk)',
  creditUrl:
    'https://www.dma.dk/safety-at-sea/navigational-information/ais-data',
  licence: 'DMA AIS data terms',
  async load({ fetchText, fetchStream, now }) {
    const year = new Date(now).getUTCFullYear();
    const listing = await fetchText(
      `${AIS_BUCKET}/?list-type=2&prefix=aisdk-${year}`,
      4 * MB,
    );
    const latest = [
      ...listing.matchAll(/<Key>(aisdk-\d{4}-\d{2}-\d{2}\.zip)<\/Key>/g),
    ]
      .map((m) => m[1])
      .sort()
      .pop();
    if (!latest) throw new Error('ais_no_daily_file');
    const day = latest.slice(6, 16);
    const tracks = await sampleAisTracks(
      zipFirstEntryLines(await fetchStream(`${AIS_BUCKET}/${latest}`)),
    );
    const features = tracks.map(({ mmsi, meta, points }) => {
      const first = new Date(points[0][2]).toISOString().slice(11, 16);
      const last = new Date(points[points.length - 1][2])
        .toISOString()
        .slice(11, 16);
      return feature(
        { type: 'MultiLineString', coordinates: splitTrack(points) },
        {
          title: cleanText(meta.name) || `MMSI ${mmsi}`,
          subtitle: `${cleanText(meta.type) || 'Unknown type'} · ${day}`,
          category: aisShipClass(meta.type),
          rows: [
            ['MMSI', mmsi],
            ['Call sign', meta.callsign],
            ['IMO', meta.imo],
            ['Destination', meta.destination],
            ['Length', meta.length ? `${meta.length} m` : ''],
            ['Seen', `${first}–${last} UTC`],
          ],
        },
      );
    });
    return { features, tolerance: 0.0005 };
  },
});

DATASETS.push(
  ...DEFENCE_DATASETS,
  ...MOVEMENT_DATASETS,
  ...ENVIRONMENT_DATASETS,
  ...IMAGERY_DATASETS,
);

export const DATASET_BY_ID = new Map(DATASETS.map((d) => [d.id, d]));

/** The public, JSON-safe catalog the client renders its chips from. */
export function publicCatalog() {
  return DATASETS.map(
    ({
      id,
      kind,
      label,
      group,
      color,
      categories,
      credit,
      creditUrl,
      licence,
      personalUse,
      ttlMs,
    }) => ({
      id,
      kind: kind || 'features',
      label,
      group,
      color,
      categories: categories || null,
      credit,
      creditUrl,
      licence,
      personalUse: Boolean(personalUse),
      refreshMs: ttlMs,
    }),
  );
}
