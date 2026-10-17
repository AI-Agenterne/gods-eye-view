import { csvObjects } from './csv.js';
import { zipEntries, zipEntryLines, zipEntryText } from './zip.js';

/**
 * Timetable-simulated vehicle positions from a static GTFS feed.
 *
 * `buildDayIndex` reads one feed once per service day: the trips running
 * today and yesterday (GTFS times run past 24:00) with their stop times.
 * `vehiclePositions` then places every running trip at the current time,
 * linearly between stops. Positions are the timetable, not live tracking.
 */

const DAY_S = 86_400;
const TIME_ZONE = 'Europe/Copenhagen';
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/** GTFS route types (basic and extended) to the layer's categories. */
export function transitMode(routeType) {
  const type = Number(routeType);
  if (type === 1 || (type >= 400 && type < 500)) return 'Metro';
  if (type === 109) return 'S-train';
  if (type === 2 || (type >= 100 && type < 200)) return 'Train';
  if (type === 0 || (type >= 900 && type < 1000)) return 'Light rail';
  if (type === 4 || (type >= 1000 && type < 1100) || type === 1200)
    return 'Ferry';
  // 715 is demand-responsive (flex) bus: its trips are booking windows, not vehicles.
  if (type === 715) return null;
  if (type === 3 || (type >= 200 && type < 300) || (type >= 700 && type < 800))
    return 'Bus';
  return null;
}

/** "25:04:30" → seconds after the service day's start. */
export function gtfsSeconds(text) {
  const [h, m, s] = String(text || '').split(':');
  const value = Number(h) * 3600 + Number(m) * 60 + Number(s || 0);
  return Number.isFinite(value) && h !== '' ? value : null;
}

/** Local calendar date (YYYYMMDD), weekday and seconds since midnight in Denmark. */
export function localClock(epochMs) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(epochMs))
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}${parts.month}${parts.day}`;
  const weekday = new Date(
    Date.UTC(+parts.year, +parts.month - 1, +parts.day),
  ).getUTCDay();
  return {
    date,
    weekday,
    seconds: +parts.hour * 3600 + +parts.minute * 60 + +parts.second,
  };
}

/** The calendar day before YYYYMMDD, with its weekday. */
export function previousDay(date) {
  const d = new Date(
    Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8) - 1),
  );
  return {
    date: d.toISOString().slice(0, 10).replace(/-/g, ''),
    weekday: d.getUTCDay(),
  };
}

/** Service ids running on one date, from calendar.txt plus calendar_dates.txt. */
export function activeServices(calendar, calendarDates, { date, weekday }) {
  const active = new Set();
  for (const row of calendar)
    if (
      row[WEEKDAYS[weekday]] === '1' &&
      row.start_date <= date &&
      date <= row.end_date
    )
      active.add(row.service_id);
  for (const row of calendarDates) {
    if (row.date !== date) continue;
    if (row.exception_type === '1') active.add(row.service_id);
    else if (row.exception_type === '2') active.delete(row.service_id);
  }
  return active;
}

/** Strip the quotes a GTFS export puts around simple fields. */
const unquote = (value) =>
  value?.length > 1 && value[0] === '"' && value[value.length - 1] === '"'
    ? value.slice(1, -1)
    : value;

/**
 * Build the trips running on `date` (and the overnight tail of the day
 * before) from a GTFS zip held in memory.
 * @param {Buffer} zip
 * @param {{date:string, weekday:number}} today
 * @returns {Promise<{date:string, trips:object[]}>}
 */
export async function buildDayIndex(zip, today) {
  const entries = zipEntries(zip);
  const table = async (name) => {
    const entry = entries.get(name);
    return entry ? csvObjects(await zipEntryText(zip, entry)) : [];
  };
  const [agencies, routes, stops, calendar, calendarDates, tripRows] =
    await Promise.all([
      table('agency.txt'),
      table('routes.txt'),
      table('stops.txt'),
      table('calendar.txt'),
      table('calendar_dates.txt'),
      table('trips.txt'),
    ]);
  const yesterday = previousDay(today.date);
  const services = [
    activeServices(calendar, calendarDates, today),
    activeServices(calendar, calendarDates, yesterday),
  ];
  const agencyName = new Map(agencies.map((a) => [a.agency_id, a.agency_name]));
  const routeById = new Map();
  for (const route of routes) {
    const mode = transitMode(route.route_type);
    if (!mode) continue;
    routeById.set(route.route_id, {
      mode,
      line: route.route_short_name || route.route_long_name,
      operator: agencyName.get(route.agency_id) || '',
    });
  }
  const stopIndex = new Map(stops.map((s, i) => [s.stop_id, i]));
  /** trip_id → trip under construction; one trip per service day it runs. */
  const building = new Map();
  for (const trip of tripRows) {
    const route = routeById.get(trip.route_id);
    if (!route) continue;
    const offsets = [];
    if (services[0].has(trip.service_id)) offsets.push(0);
    if (services[1].has(trip.service_id)) offsets.push(DAY_S);
    if (!offsets.length) continue;
    building.set(trip.trip_id, {
      route,
      headsign: trip.trip_headsign,
      offsets,
      rows: [],
    });
  }

  const stopTimes = entries.get('stop_times.txt');
  if (!stopTimes) throw new Error('gtfs_no_stop_times');
  let columns = null;
  for await (const line of zipEntryLines(zip, stopTimes)) {
    if (!line) continue;
    const cells = line.split(',');
    if (!columns) {
      const names = cells.map((c) => unquote(c.replace(/^﻿/, '')));
      columns = [
        'trip_id',
        'arrival_time',
        'departure_time',
        'stop_id',
        'stop_sequence',
      ].map((name) => names.indexOf(name));
      if (columns.includes(-1)) throw new Error('gtfs_stop_times_columns');
      continue;
    }
    const trip = building.get(unquote(cells[columns[0]]));
    if (!trip) continue;
    const stop = stopIndex.get(unquote(cells[columns[3]]));
    const arrival = gtfsSeconds(unquote(cells[columns[1]]));
    const departure = gtfsSeconds(unquote(cells[columns[2]]));
    if (stop === undefined || arrival === null || departure === null) continue;
    // Flat (sequence, arrival, departure, stop) quads keep a full day of
    // Danish stop times to a few tens of MB while the index is built.
    trip.rows.push(Number(cells[columns[4]]), arrival, departure, stop);
  }

  const trips = [];
  for (const trip of building.values()) {
    const n = trip.rows.length / 4;
    if (n < 2) continue;
    const order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => trip.rows[4 * a] - trip.rows[4 * b],
    );
    const times = new Int32Array(n * 2);
    const coords = new Float32Array(n * 2);
    const names = new Array(n);
    order.forEach((row, i) => {
      const stop = stops[trip.rows[4 * row + 3]];
      times[2 * i] = trip.rows[4 * row + 1];
      times[2 * i + 1] = trip.rows[4 * row + 2];
      coords[2 * i] = Number(stop.stop_lon);
      coords[2 * i + 1] = Number(stop.stop_lat);
      names[i] = stop.stop_name;
    });
    trip.rows = null;
    for (const offset of trip.offsets)
      trips.push({
        route: trip.route,
        headsign: trip.headsign,
        offset,
        start: times[1] - offset,
        end: times[2 * n - 2] - offset,
        times,
        coords,
        names,
      });
  }
  return { date: today.date, trips };
}

/**
 * Where each running trip is at `seconds` past local midnight.
 * @returns {Array<{lon:number, lat:number, trip:object, next:string, at:number}>}
 */
export function vehiclePositions({ trips }, seconds) {
  const out = [];
  for (const trip of trips) {
    if (seconds < trip.start || seconds > trip.end) continue;
    const t = seconds + trip.offset;
    const { times, coords, names } = trip;
    const n = names.length;
    // Last stop whose arrival is at or before t.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[2 * mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const departs = times[2 * i + 1];
    if (t <= departs || i === n - 1) {
      out.push({
        lon: coords[2 * i],
        lat: coords[2 * i + 1],
        trip,
        next: names[Math.min(i + 1, n - 1)],
        at: times[2 * Math.min(i + 1, n - 1)] - trip.offset,
      });
      continue;
    }
    const arrives = times[2 * i + 2];
    const f = arrives > departs ? (t - departs) / (arrives - departs) : 1;
    out.push({
      lon: coords[2 * i] + f * (coords[2 * i + 2] - coords[2 * i]),
      lat: coords[2 * i + 1] + f * (coords[2 * i + 3] - coords[2 * i + 1]),
      trip,
      next: names[i + 1],
      at: arrives - trip.offset,
    });
  }
  return out;
}
