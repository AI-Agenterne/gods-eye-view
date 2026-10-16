import { UTM_ZONES, utmToLonLat } from './utm.js';

/** Five decimals is ~1 m — finer than any of these datasets is accurate to. */
const PRECISION = 1e5;
const round = (n) => Math.round(n * PRECISION) / PRECISION;
const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

/** Build a coordinate transform for an EPSG code (4326 and UTM 32/33). */
export function projector(epsg = 4326) {
  const zone = UTM_ZONES[epsg];
  if (zone) return ([x, y]) => utmToLonLat(x, y, zone);
  if (epsg === 4326) return ([x, y]) => [x, y];
  throw new Error(`unsupported_crs_${epsg}`);
}

/** Perpendicular distance² from p to the segment a–b, in degrees². */
function segmentDistanceSq(p, a, b) {
  let [x, y] = a;
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx || dy) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) [x, y] = b;
    else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/** Iterative Douglas–Peucker; keeps both endpoints. */
export function simplifyLine(points, tolerance) {
  if (!tolerance || points.length <= 2) return points;
  const toleranceSq = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const sq = segmentDistanceSq(points[i], points[first], points[last]);
      if (sq > maxSq) {
        maxSq = sq;
        index = i;
      }
    }
    if (maxSq > toleranceSq) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Reproject, simplify and round one GeoJSON geometry. Returns null for a
 * geometry that is missing, unsupported or degenerate after simplification,
 * so one bad feature drops out instead of failing the dataset.
 * @param {object} geometry GeoJSON geometry.
 * @param {{project?: Function, tolerance?: number, budget?: {vertices:number}}} [options]
 */
export function normalizeGeometry(
  geometry,
  { project = (p) => p, tolerance = 0, budget = { vertices: Infinity } } = {},
) {
  if (!geometry || !GEOMETRY_TYPES.has(geometry.type)) return null;
  const point = (raw) => {
    if (
      !Array.isArray(raw) ||
      !Number.isFinite(raw[0]) ||
      !Number.isFinite(raw[1])
    )
      return null;
    const [lon, lat] = project(raw);
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    budget.vertices -= 1;
    return [round(lon), round(lat)];
  };
  const line = (raw, minimum) => {
    if (!Array.isArray(raw)) return null;
    const projected = raw.map(point);
    if (projected.some((p) => !p)) return null;
    const simplified = simplifyLine(projected, tolerance);
    return simplified.length >= minimum ? simplified : null;
  };
  const polygon = (rings) => {
    if (!Array.isArray(rings)) return null;
    const outer = line(rings[0], 4);
    if (!outer) return null;
    return [
      outer,
      ...rings
        .slice(1)
        .map((ring) => line(ring, 4))
        .filter(Boolean),
    ];
  };
  const many = (items, fn) => {
    const parts = Array.isArray(items) ? items.map(fn).filter(Boolean) : [];
    return parts.length ? parts : null;
  };
  let coordinates = null;
  switch (geometry.type) {
    case 'Point':
      coordinates = point(geometry.coordinates);
      break;
    case 'MultiPoint':
      coordinates = many(geometry.coordinates, point);
      break;
    case 'LineString':
      coordinates = line(geometry.coordinates, 2);
      break;
    case 'MultiLineString':
      coordinates = many(geometry.coordinates, (part) => line(part, 2));
      break;
    case 'Polygon':
      coordinates = polygon(geometry.coordinates);
      break;
    case 'MultiPolygon':
      coordinates = many(geometry.coordinates, polygon);
      break;
  }
  if (!coordinates || budget.vertices < 0) return null;
  // A one-point MultiPoint is a Point; the client only needs one shape.
  if (geometry.type === 'MultiPoint' && coordinates.length === 1)
    return { type: 'Point', coordinates: coordinates[0] };
  return { type: geometry.type, coordinates };
}

const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  deg: '°',
  quot: '"',
  apos: "'",
  lt: '‹',
  gt: '›',
};

/** Collapse whitespace, strip HTML tags and clamp a display string. */
export function cleanText(value, max = 160) {
  if (value === null || value === undefined) return '';
  const text = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&(nbsp|amp|deg|quot|apos|lt|gt);/g, (_, name) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || /^(n\/a|null|none|ukendt)$/i.test(text)) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The client contract for one feature's display fields: a title, an
 * optional subtitle, up to eight label/value rows, a style category and an
 * optional link. Empty rows are dropped.
 */
export function displayProperties({
  width,
  title,
  subtitle,
  rows = [],
  category,
  url,
  radiusM,
}) {
  const info = rows
    .map(([label, value]) => [label, cleanText(value)])
    .filter(([, value]) => value)
    .slice(0, 8);
  const props = { title: cleanText(title, 90) || 'Unnamed', info };
  const sub = cleanText(subtitle, 120);
  if (sub) props.subtitle = sub;
  if (category) props.category = String(category);
  if (typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url))
    props.url = url;
  if (Number.isFinite(radiusM) && radiusM > 0) props.radiusM = radiusM;
  if (Number.isFinite(width) && width > 0)
    props.width = Math.round(width * 10) / 10;
  return props;
}
