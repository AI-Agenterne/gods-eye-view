import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { zipEntries, zipEntryText } from './zip.js';
import {
  activeServices,
  buildDayIndex,
  gtfsSeconds,
  localClock,
  previousDay,
  transitMode,
  vehiclePositions,
} from './gtfs.js';
import { clearanceCategory } from './movement.js';

/** A minimal deflated ZIP with a central directory, like a GTFS export. */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Saturday 17 October 2026. Trip 10 runs Saturdays, the flex trip 11 is
// skipped, and the night train 12 is Friday's, running on past midnight.
const FEED = {
  'agency.txt': '"agency_id","agency_name"\n1,"Midttrafik"\n',
  'routes.txt':
    '"route_id","agency_id","route_short_name","route_long_name","route_type"\n' +
    '"r1",1,"2A","",3\n"r2",1,"Flex","",715\n"r3",1,"","Kystbanen",2\n',
  'stops.txt':
    '"stop_id","stop_name","stop_lat","stop_lon"\n' +
    'A,"Aarhus H","56.15","10.20"\nB,"Lisbjerg","56.25","10.20"\n',
  'calendar.txt':
    '"service_id","monday","tuesday","wednesday","thursday","friday","saturday","sunday","start_date","end_date"\n' +
    '1,0,0,0,0,0,1,0,20261001,20261231\n2,0,0,0,0,1,0,0,20261001,20261231\n',
  'calendar_dates.txt': '"service_id","date","exception_type"\n',
  'trips.txt':
    '"route_id","service_id","trip_id","trip_headsign"\n' +
    '"r1",1,10,"Lisbjerg"\n"r2",1,11,"Flex"\n"r3",2,12,"Night run"\n',
  'stop_times.txt':
    '"trip_id","arrival_time","departure_time","stop_id","stop_sequence"\n' +
    '10,8:10:00,8:10:00,B,1\n10,8:00:00,8:00:00,A,0\n' +
    '11,8:00:00,8:00:00,A,0\n11,8:10:00,8:10:00,B,1\n' +
    '12,23:50:00,23:50:00,A,0\n12,24:10:00,24:10:00,B,1\n',
};

test('zip reader finds and inflates entries by name', async () => {
  const zip = makeZip({ 'a.txt': 'hello\nworld\n' });
  const entries = zipEntries(zip);
  assert.deepEqual([...entries.keys()], ['a.txt']);
  assert.equal(await zipEntryText(zip, entries.get('a.txt')), 'hello\nworld');
  assert.throws(() => zipEntries(Buffer.from('not a zip at all, sorry!')));
});

test('GTFS helpers: times past midnight, modes, calendars, local clock', () => {
  assert.equal(gtfsSeconds('25:04:30'), 25 * 3600 + 4 * 60 + 30);
  assert.equal(gtfsSeconds(''), null);
  assert.equal(transitMode(3), 'Bus');
  assert.equal(transitMode(109), 'S-train');
  assert.equal(transitMode(715), null);
  assert.equal(transitMode(4), 'Ferry');
  assert.deepEqual(previousDay('20261101'), { date: '20261031', weekday: 6 });
  const saturday = { date: '20261017', weekday: 6 };
  const services = activeServices(
    [
      {
        service_id: '1',
        saturday: '1',
        start_date: '20261001',
        end_date: '20261231',
      },
    ],
    [{ service_id: '1', date: '20261017', exception_type: '2' }],
    saturday,
  );
  assert.equal(services.size, 0, 'a removal exception wins');
  // 06:30 UTC is 08:30 in Copenhagen during summer time.
  const clock = localClock(Date.UTC(2026, 9, 17, 6, 30));
  assert.deepEqual(clock, {
    date: '20261017',
    weekday: 6,
    seconds: 8.5 * 3600,
  });
});

test('timetable index places vehicles between stops, past midnight too', async () => {
  const index = await buildDayIndex(makeZip(FEED), {
    date: '20261017',
    weekday: 6,
  });
  const ids = index.trips.map((t) => t.headsign).sort();
  assert.deepEqual(ids, ['Lisbjerg', 'Night run']);

  const [bus] = vehiclePositions(index, 8 * 3600 + 5 * 60);
  assert.equal(bus.trip.route.line, '2A');
  assert.ok(Math.abs(bus.lat - 56.2) < 1e-6, 'halfway after 5 of 10 minutes');
  assert.equal(bus.next, 'Lisbjerg');

  // Friday's 23:50 train is 15 of its 20 minutes along at 00:05 Saturday.
  const [night] = vehiclePositions(index, 5 * 60);
  assert.equal(night.trip.route.mode, 'Train');
  assert.ok(Math.abs(night.lat - 56.225) < 1e-5);
  assert.equal(vehiclePositions(index, 23 * 3600 + 55 * 60).length, 0);
  assert.equal(
    vehiclePositions(index, 7 * 3600).length,
    0,
    'none before 08:00',
  );
});

test('bridge clearance bands', () => {
  assert.equal(clearanceCategory(0), null);
  assert.equal(clearanceCategory(3.9), 'Clearance under 4.2 m');
  assert.equal(clearanceCategory(4.3), 'Clearance 4.2–4.5 m');
  assert.equal(clearanceCategory(4.6), 'Clearance 4.5 m+');
});
