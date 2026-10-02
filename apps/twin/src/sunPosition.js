/* Solar / lunar sky angles for the home twin (LE19 4BH / Narborough).
 *
 * Pure JS — NOAA-style solar position. No deps.
 *
 * Returns altitude / azimuth in radians:
 *   altitude: 0 = horizon, +π/2 = zenith, negative = below horizon
 *   azimuth:  0 = north, clockwise (π/2 = east, π = south, 3π/2 = west)
 *
 * Viewer mapping (scene after X-mirror; layout X east, Y south):
 *   scene +X = west, −X = east, +Y = south, −Y = north, +Z = up
 *   light offset from house centre toward the body:
 *     dx = −sin(az) · cos(alt) · dist
 *     dy = −cos(az) · cos(alt) · dist
 *     dz =  sin(alt) · dist
 */

/** LE19 4BH — approx Narborough. */
export const HOME_LAT = 52.57;
export const HOME_LON = -1.20;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * @param {Date} date
 * @param {number} [latDeg=HOME_LAT]
 * @param {number} [lonDeg=HOME_LON]
 * @returns {{ altitude: number, azimuth: number, declination: number }}
 */
export function getSunPosition(date, latDeg = HOME_LAT, lonDeg = HOME_LON) {
  const lat = latDeg * DEG;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;

  let L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360;
  if (L0 < 0) L0 += 360;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG;

  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
    + 0.000289 * Math.sin(3 * M);
  const trueLong = (L0 + C) * DEG;
  const omega = (125.04 - 1934.136 * T) * DEG;
  const lambda = trueLong - 0.00569 * DEG - 0.00478 * DEG * Math.sin(omega);

  const eps0 =
    (23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60)
    * DEG;
  const eps = eps0 + 0.00256 * DEG * Math.cos(omega);

  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));

  let gmst =
    280.46061837
    + 360.98564736629 * (jd - 2451545)
    + 0.000387933 * T * T
    - (T * T * T) / 38710000;
  gmst = ((gmst % 360) + 360) % 360;
  const lmst = (gmst + lonDeg) * DEG;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  let ha = lmst - ra;
  ha = ((ha + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

  const sinAlt =
    Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const altitude = Math.asin(Math.min(1, Math.max(-1, sinAlt)));

  // Azimuth from north, clockwise (NOAA-style atan2 + π → N-CW).
  const yAz = Math.sin(ha);
  const xAz = Math.cos(ha) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat);
  let azimuth = Math.atan2(yAz, xAz) + Math.PI;
  azimuth = ((azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  return { altitude, azimuth, declination: dec };
}

/**
 * Cheap night moon stand-in: opposite solar azimuth, clamped altitude.
 * Good enough for a directional fill; not an ephemeris.
 *
 * @param {{ altitude: number, azimuth: number }} sun
 * @returns {{ altitude: number, azimuth: number }}
 */
export function getApproxMoonPosition(sun) {
  const azimuth = (sun.azimuth + Math.PI) % (2 * Math.PI);
  const altitude = Math.max(0.12, Math.min(0.55, 0.35 - sun.altitude * 0.25));
  return { altitude, azimuth };
}

/**
 * Unit direction from house toward a body, in viewer scene axes.
 * @param {number} altitude
 * @param {number} azimuth
 * @returns {{ x: number, y: number, z: number }}
 */
export function skyDirectionScene(altitude, azimuth) {
  const c = Math.cos(altitude);
  const east = Math.sin(azimuth) * c;
  const north = Math.cos(azimuth) * c;
  const up = Math.sin(altitude);
  return {
    x: -east, // scene −X = east
    y: -north, // scene −Y = north
    z: up,
  };
}

/**
 * Civil-twilight blend weight for the sun disk (0 = night, 1 = full day).
 * @param {number} altitudeRad
 */
export function dayFactorFromAltitude(altitudeRad) {
  const deg = altitudeRad * RAD;
  if (deg <= -6) return 0;
  if (deg >= 6) return 1;
  const t = (deg + 6) / 12;
  return t * t * (3 - 2 * t);
}

/** Format a Date as Europe/London wall-clock HH:MM for UI. */
export function formatLondonHM(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
