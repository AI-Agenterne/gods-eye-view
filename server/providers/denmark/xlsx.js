import { inflateRawSync } from 'node:zlib';

/**
 * Minimal XLSX reader: enough to read the first worksheet of a plain
 * workbook (shared strings, inline strings, numbers) into rows of cell
 * values keyed by column letter. No formulas, styles or dates — the Danish
 * registers this serves store everything as text or numbers.
 */

const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/** Read the named entries of a ZIP archive via its central directory. */
export function unzipEntries(buffer, names) {
  const wanted = new Set(names);
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('xlsx_not_zip');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('xlsx_bad_directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted.has(name)) continue;
    if (size > MAX_ENTRY_BYTES) throw new Error('xlsx_entry_too_large');
    const dataStart =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataStart, dataStart + compressed);
    if (method === 0) out.set(name, data.toString('utf8'));
    else if (method === 8) out.set(name, inflateRawSync(data).toString('utf8'));
    else throw new Error(`xlsx_unsupported_compression_${method}`);
  }
  return out;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (text) =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, e) =>
    e[0] === '#'
      ? String.fromCodePoint(
          e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
        )
      : XML_ENTITIES[e],
  );
const runText = (xml) =>
  decodeXml(
    [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''),
  );

/**
 * @param {Buffer} buffer An .xlsx file.
 * @returns {Array<Record<string, string>>} Rows of the first sheet.
 */
export function readFirstSheet(buffer) {
  const sheetName = 'xl/worksheets/sheet1.xml';
  const entries = unzipEntries(buffer, ['xl/sharedStrings.xml', sheetName]);
  const sheet = entries.get(sheetName);
  if (!sheet) throw new Error('xlsx_no_sheet');
  const shared = [
    ...(entries.get('xl/sharedStrings.xml') || '').matchAll(
      /<si>([\s\S]*?)<\/si>/g,
    ),
  ].map((m) => runText(m[1]));
  const rows = [];
  for (const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cell of row[1].matchAll(
      /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const [, column, attrs, body = ''] = cell;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (type === 's')
        cells[column] =
          value === undefined ? '' : (shared[Number(value)] ?? '');
      else if (type === 'inlineStr') cells[column] = runText(body);
      else cells[column] = value === undefined ? '' : decodeXml(value);
    }
    rows.push(cells);
  }
  return rows;
}
