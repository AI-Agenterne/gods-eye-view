/**
 * ETRS89 / UTM (EPSG:25832, 25833) → geographic lon/lat, on the GRS80
 * ellipsoid. ETRS89 and WGS84 differ by well under a metre in Denmark, far
 * below what a globe overlay can show, so the result is used as WGS84.
 *
 * Danish authorities publish most vector data in zone 32 (Bornholm in 33).
 * A projection library would do the same job; this is the standard inverse
 * transverse-Mercator series, kept local so the provider needs no dependency.
 */
const A = 6_378_137;
const F = 1 / 298.257222101;
const K0 = 0.9996;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
const FALSE_EASTING = 500_000;

/** EPSG codes this module converts, mapped to their UTM zone. */
export const UTM_ZONES = Object.freeze({ 25832: 32, 25833: 33 });

/**
 * @param {number} easting Metres.
 * @param {number} northing Metres (northern hemisphere).
 * @param {number} [zone=32] UTM zone.
 * @returns {[number, number]} [lon, lat] in degrees.
 */
export function utmToLonLat(easting, northing, zone = 32) {
  const x = easting - FALSE_EASTING;
  const m = northing / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 =
    mu +
    ((3 * E1) / 2 - (27 * E1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * E1 ** 2) / 16 - (55 * E1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * E1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * E1 ** 4) / 512) * Math.sin(8 * mu);
  const sin = Math.sin(phi1);
  const cos = Math.cos(phi1);
  const tan = Math.tan(phi1);
  const n1 = A / Math.sqrt(1 - E2 * sin ** 2);
  const t1 = tan ** 2;
  const c1 = EP2 * cos ** 2;
  const r1 = (A * (1 - E2)) / (1 - E2 * sin ** 2) ** 1.5;
  const d = x / (n1 * K0);
  const lat =
    phi1 -
    ((n1 * tan) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * EP2 - 3 * c1 ** 2) *
          d ** 6) /
          720);
  const lon =
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * EP2 + 24 * t1 ** 2) * d ** 5) /
        120) /
    cos;
  const centralMeridian = zone * 6 - 183;
  return [centralMeridian + (lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
