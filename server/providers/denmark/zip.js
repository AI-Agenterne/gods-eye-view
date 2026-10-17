import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

/**
 * Read a ZIP archive held in memory through its central directory. Enough
 * for GTFS feeds: no ZIP64, no encryption, stored or deflated entries.
 * @param {Buffer} buffer The whole archive.
 * @returns {Map<string, {method:number, size:number, start:number}>}
 */
export function zipEntries(buffer) {
  let eocd = -1;
  for (
    let i = buffer.length - 22;
    i >= Math.max(0, buffer.length - 65_557);
    i--
  )
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('zip_no_directory');
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50)
      throw new Error('zip_bad_entry');
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20); // compressed
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    if (buffer.readUInt32LE(local) !== 0x04034b50)
      throw new Error('zip_bad_local');
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    entries.set(name, { method, size, start });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Stream one entry's text, line by line, without inflating it all at once.
 * @param {Buffer} buffer
 * @param {{method:number, size:number, start:number}} entry
 * @returns {AsyncGenerator<string>}
 */
export async function* zipEntryLines(buffer, entry) {
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error(`zip_method_${entry.method}`);
  const bytes = buffer.subarray(entry.start, entry.start + entry.size);
  const body =
    entry.method === 8
      ? Readable.from([bytes]).pipe(createInflateRaw())
      : Readable.from([bytes]);
  const decoder = new TextDecoder();
  let partial = '';
  try {
    for await (const chunk of body) {
      partial += decoder.decode(chunk, { stream: true });
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) yield line.replace(/\r$/, '');
    }
    if (partial) yield partial.replace(/\r$/, '');
  } finally {
    body.destroy();
  }
}

/** A whole (small) entry as text. */
export async function zipEntryText(buffer, entry) {
  const lines = [];
  for await (const line of zipEntryLines(buffer, entry)) lines.push(line);
  return lines.join('\n');
}
