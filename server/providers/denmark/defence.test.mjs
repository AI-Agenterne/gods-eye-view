import test from 'node:test';
import assert from 'node:assert/strict';

import {
  airfieldCategory,
  firingFeatures,
  jammingFeatures,
  jammingLevel,
  latestJammingDay,
  matchSanctionedTracks,
  navaidFrequency,
  sanctionsIndex,
} from './defence.js';
import { csvObjects } from './csv.js';

test('jamming bands follow GPSJam and ignore thin cells', () => {
  assert.equal(jammingLevel(1, 1), null, 'two aircraft is too few');
  assert.equal(jammingLevel(99, 1), null, 'under 2% is normal');
  assert.equal(jammingLevel(19, 1).category, 'Medium (2–10%)');
  assert.equal(jammingLevel(8, 2).category, 'High (>10%)');
});

test('latestJammingDay skips suspect days', () => {
  const manifest =
    'date,suspect,num_bad_aircraft_hexes,source\n' +
    '2026-10-14,false,537,merged\n' +
    '2026-10-15,false,517,merged\n' +
    '2026-10-16,true,9000,merged\n';
  assert.equal(latestJammingDay(manifest), '2026-10-15');
});

test('jammingFeatures draws closed hexes near Denmark only', () => {
  // 8408... sits over the Baltic near Kaliningrad; 8400... is in the Pacific.
  const csv =
    'hex,count_good_aircraft,count_bad_aircraft\n' +
    '84088a1ffffffff,11,2\n' +
    '8400533ffffffff,1,9\n' +
    'garbage,1,1\n';
  const features = jammingFeatures(csv, '2026-10-15');
  assert.equal(features.length, 1);
  const ring = features[0].geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1], 'ring is closed');
  assert.equal(features[0].properties.category, 'High (>10%)');
});

test('firingFeatures keeps Niord geometry and names the area', () => {
  const [f] = firingFeatures(
    [
      {
        shortId: 'FA/EK-D-371 2026',
        areas: [{ descs: [{ lang: 'en', name: 'EK D 371 Marstal Bugt' }] }],
        parts: [
          {
            descs: [{ lang: 'en', details: 'Pass with caution.' }],
            eventDates: [{ fromDate: Date.UTC(2026, 0, 1) }],
            geometry: {
              features: [
                {
                  geometry: {
                    type: 'Polygon',
                    coordinates: [
                      [
                        [10.4, 54.7],
                        [10.5, 54.7],
                        [10.5, 54.8],
                        [10.4, 54.7],
                      ],
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
    'Firing area',
  );
  assert.equal(f.properties.title, 'EK D 371 Marstal Bugt');
  assert.equal(f.properties.category, 'Firing area');
  assert.throws(() => firingFeatures({}, 'x'), /niord_malformed/);
});

test('csvObjects handles quotes, commas and doubled quotes', () => {
  const rows = csvObjects('"a","b"\n"x, y","say ""hi"""\n');
  assert.deepEqual(rows, [{ a: 'x, y', b: 'say "hi"' }]);
});

test('sanctioned and shadow-fleet tracks match on IMO or MMSI', () => {
  const index = sanctionsIndex(
    csvObjects(
      '"type","caption","imo","risk","flag","mmsi","url","datasets"\n' +
        '"VESSEL","DARK ONE","IMO9318084","sanction;mare.shadow","mh","","https://www.opensanctions.org/entities/x","ua_war_sanctions"\n' +
        '"VESSEL","LISTED","","sanction","ru","273000001","https://www.opensanctions.org/entities/y","eu_journal_sanctions"\n' +
        '"VESSEL","ONLY DETAINED","IMO1234567","mare.detained","pa","","",""\n',
    ),
  );
  const track = (imo, mmsi) => ({
    geometry: {
      type: 'MultiLineString',
      coordinates: [
        [
          [10, 57],
          [11, 57],
        ],
      ],
    },
    properties: {
      title: 'AIS NAME',
      info: [
        ['MMSI', mmsi],
        ['IMO', imo],
        ['Seen', '00:00–23:56 UTC'],
      ],
    },
  });
  const hits = matchSanctionedTracks(
    [
      track('9318084', '538012985'),
      track('', '273000001'),
      track('1234567', '111111111'),
    ],
    index,
  );
  assert.deepEqual(
    hits.map((h) => h.properties.category),
    ['Shadow fleet', 'Sanctioned'],
    'detentions alone are not a sanctions hit',
  );
  assert.equal(hits[0].properties.title, 'DARK ONE');
});

test('airfields: closed fields drop out, air bases are military', () => {
  assert.equal(
    airfieldCategory({ type: 'closed', name: 'Old', ident: 'X' }),
    null,
  );
  assert.equal(
    airfieldCategory({
      type: 'medium_airport',
      name: 'Aalborg Airport',
      ident: 'EKYT',
    }),
    'Military',
  );
  assert.equal(
    airfieldCategory({
      type: 'small_airport',
      name: 'Glider Field',
      ident: 'EKTO',
    }),
    'Small airfield',
  );
  assert.equal(
    navaidFrequency({ type: 'VOR-DME', frequency_khz: '116700' }),
    '116.70 MHz',
  );
  assert.equal(
    navaidFrequency({ type: 'NDB', frequency_khz: '382' }),
    '382 kHz',
  );
});
