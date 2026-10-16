import { createInflateRaw } from 'node:zlib';
import { Readable } from 'node:stream';

/**
 * Stream the first entry of a remote ZIP as text lines without buffering
 * the archive. The Danish Maritime Authority's daily AIS files are ~500 MB
 * zipped with a single CSV inside, written with a data descriptor, so the
 * local header's sizes are zero and the deflate stream itself marks the end.
 * @param {ReadableStream} body A fetch response body.
 * @returns {AsyncGenerator<string>}
 */
export async function* zipFirstEntryLines(body) {
  const source = Readable.fromWeb(body);
  // One iterator for the whole body: breaking out of a for-await over a
  // Readable destroys it, which would lose everything after the header.
  const chunks = source[Symbol.asyncIterator]();
  let header = Buffer.alloc(0);
  let rest = null;
  while (!rest) {
    const { value, done } = await chunks.next();
    if (done) throw new Error('ais_truncated');
    header = Buffer.concat([header, value]);
    if (header.length < 30) continue;
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('ais_not_zip');
    if (header.readUInt16LE(8) !== 8) throw new Error('ais_not_deflate');
    const start = 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (header.length >= start) rest = header.subarray(start);
  }
  const inflate = createInflateRaw();
  const write = async (chunk) => {
    if (!inflate.write(chunk))
      await new Promise((r) => inflate.once('drain', r));
  };
  const feed = (async () => {
    try {
      await write(rest);
      for (;;) {
        if (inflate.writableEnded || inflate.destroyed) break;
        const { value, done } = await chunks.next();
        if (done) break;
        await write(value);
      }
      if (!inflate.destroyed) inflate.end();
    } catch {
      /* the inflater stops at the deflate stream's end; the rest is the directory */
    } finally {
      source.destroy();
    }
  })();
  let partial = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of inflate) {
      partial += decoder.decode(chunk, { stream: true });
      const lines = partial.split('\n');
      partial = lines.pop();
      yield* lines;
    }
    if (partial) yield partial;
  } finally {
    inflate.destroy();
    source.destroy();
    await feed.catch(() => {});
  }
}

/** Danish AIS "Ship type" values grouped for colour. */
export function aisShipClass(type) {
  const value = String(type || '').toLowerCase();
  if (value.includes('military') || value.includes('law enforcement'))
    return 'Military & police';
  if (value.includes('tanker')) return 'Tanker';
  if (value.includes('cargo')) return 'Cargo';
  if (value.includes('passenger')) return 'Passenger & ferry';
  if (value.includes('fishing')) return 'Fishing';
  if (value.includes('sailing') || value.includes('pleasure')) return 'Leisure';
  if (
    /tug|pilot|sar|dredg|diving|port tender|towing|anti-pollution|hsc|wig/.test(
      value,
    )
  )
    return 'Service & SAR';
  return 'Other';
}

const SAMPLE_MS = 5 * 60_000;
const MIN_MOVE_DEG = 0.002; // ~200 m

/**
 * Reduce a day of AIS position reports to one sampled track per vessel.
 * Only class A/B ships are kept; base stations, AtoN and SAR aircraft are not.
 * @param {AsyncIterable<string>} lines CSV lines, header first.
 * @param {{maxVessels?: number}} [options]
 * @returns {Promise<Array<object>>} Tracks: {mmsi, name, type, ...meta, points: [[lon,lat,t]]}
 */
export async function sampleAisTracks(lines, { maxVessels = 6000 } = {}) {
  let columns = null;
  const vessels = new Map();
  for await (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const cells = line.split(',');
    if (!columns) {
      columns = Object.fromEntries(
        cells.map((name, index) => [
          name.replace(/^#\s*/, '').trim().toLowerCase(),
          index,
        ]),
      );
      continue;
    }
    const mobile = cells[columns['type of mobile']];
    if (mobile !== 'Class A' && mobile !== 'Class B') continue;
    const lat = Number(cells[columns.latitude]);
    const lon = Number(cells[columns.longitude]);
    if (!(lat > 50 && lat < 62 && lon > 0 && lon < 20)) continue;
    const mmsi = cells[columns.mmsi];
    // "16/10/2026 00:00:01"
    const [d, m, rest] = String(cells[columns.timestamp] || '').split('/');
    const t = Date.parse(`${rest?.slice(0, 4)}-${m}-${d}T${rest?.slice(5)}Z`);
    if (!mmsi || !Number.isFinite(t)) continue;
    let vessel = vessels.get(mmsi);
    if (!vessel) {
      if (vessels.size >= maxVessels * 3) continue;
      vessel = { mmsi, points: [], meta: {} };
      vessels.set(mmsi, vessel);
    }
    const take = (key, column) => {
      const value = cells[columns[column]];
      if (value && value !== 'Undefined' && value !== 'Unknown')
        vessel.meta[key] = value;
    };
    take('name', 'name');
    take('type', 'ship type');
    take('callsign', 'callsign');
    take('destination', 'destination');
    take('length', 'length');
    take('imo', 'imo');
    const last = vessel.points[vessel.points.length - 1];
    if (
      last &&
      (t - last[2] < SAMPLE_MS ||
        Math.abs(lon - last[0]) + Math.abs(lat - last[1]) < MIN_MOVE_DEG)
    )
      continue;
    vessel.points.push([lon, lat, t]);
  }
  return [...vessels.values()]
    .filter((v) => v.points.length >= 3)
    .sort((a, b) => b.points.length - a.points.length)
    .slice(0, maxVessels);
}
