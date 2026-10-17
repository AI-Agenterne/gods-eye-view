/** Small CSV helpers for the Denmark pack's registry loaders. */

/** Minimal RFC 4180 CSV row splitter (quoted fields, doubled quotes). */
export function csvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

/** CSV text to objects keyed by the header row. */
export function csvObjects(text) {
  const [header, ...rows] = csvRows(text.replace(/^\uFEFF/, ''));
  return rows.map((cells) =>
    Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])),
  );
}
