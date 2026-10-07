import proj4 from 'proj4';

/**
 * Reads a coordinate pasted as one string: decimal degrees, degrees and decimal
 * minutes, degrees-minutes-seconds, or UTM. Pure; returns WGS84 latitude and
 * longitude with the format it recognised, or the reason it could not.
 *
 * UTM band letters follow the MGRS convention (C–M south, N–X north), so the
 * common "11N" and the band "11U" both read as northern hemisphere.
 */
export type CoordFormat = 'decimal' | 'degrees-minutes' | 'degrees-minutes-seconds' | 'utm';

export type ParsedCoord =
  | { ok: true; lat: number; lng: number; format: CoordFormat; warnings: string[] }
  | { ok: false; error: string };

const NUM = String.raw`(\d+(?:\.\d+)?)`;

/** One axis written with degrees and optional minutes and seconds, with an optional hemisphere letter on either side. */
const AXIS = new RegExp(
  String.raw`^([NSEW])?\s*(-)?\s*${NUM}\s*(?:°|º|d|\s)?\s*(?:${NUM}\s*(?:'|′|m|\s)?\s*)?(?:${NUM}\s*(?:"|″|''|s)?\s*)?([NSEW])?$`,
  'i',
);

interface Axis {
  value: number;
  hemi?: 'N' | 'S' | 'E' | 'W';
  parts: number;
}

function readAxis(text: string): Axis | null {
  const m = text.trim().match(AXIS);
  if (!m) return null;
  const [, pre, minus, d, mi, s, post] = m;
  if (pre && post) return null;
  const deg = Number(d);
  const min = mi === undefined ? 0 : Number(mi);
  const sec = s === undefined ? 0 : Number(s);
  if (min >= 60 || sec >= 60) return null;
  if ((mi !== undefined && !Number.isInteger(deg)) || (s !== undefined && !Number.isInteger(min))) return null;
  const hemi = (pre ?? post)?.toUpperCase() as Axis['hemi'];
  let value = deg + min / 60 + sec / 3600;
  if (minus || hemi === 'S' || hemi === 'W') value = -value;
  if (minus && (hemi === 'S' || hemi === 'W')) return null;
  return { value, hemi, parts: s !== undefined ? 3 : mi !== undefined ? 2 : 1 };
}

/** Splits "a, b" or "a b" into two axes, trying every split point for space-separated input. */
function splitPairs(text: string): Array<[string, string]> {
  const t = text.trim();
  for (const sep of [',', ';', '/']) {
    const parts = t.split(sep);
    if (parts.length === 2) return [[parts[0]!, parts[1]!]];
  }
  // Space separated: split before a hemisphere letter or a sign, or at each space.
  const out: Array<[string, string]> = [];
  const tokens = t.split(/\s+/);
  for (let i = 1; i < tokens.length; i++) out.push([tokens.slice(0, i).join(' '), tokens.slice(i).join(' ')]);
  return out;
}

const UTM = /^(?:zone\s*)?(\d{1,2})\s*([C-HJ-NP-X])?\s*,?\s*(\d{6}(?:\.\d+)?)\s*(?:m?\s*E)?\s*,?\s*(\d{7}(?:\.\d+)?)\s*(?:m?\s*N)?$/i;

function parseUtm(text: string): ParsedCoord | null {
  const m = text.trim().match(UTM);
  if (!m) return null;
  const zone = Number(m[1]);
  if (zone < 1 || zone > 60) return { ok: false, error: `UTM zone ${zone} does not exist; zones run 1 to 60` };
  const band = m[2]?.toUpperCase();
  const south = band !== undefined && band < 'N';
  const [lng, lat] = proj4(`+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`, 'WGS84', [Number(m[3]), Number(m[4])]);
  const warnings = band ? [] : ['No band letter given; read as northern hemisphere.'];
  return { ok: true, lat: round7(lat!), lng: round7(lng!), format: 'utm', warnings };
}

const round7 = (x: number) => Math.round(x * 1e7) / 1e7;

export function parseCoordinate(input: string): ParsedCoord {
  const text = input.trim().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  if (!text) return { ok: false, error: 'enter a coordinate' };
  const utm = parseUtm(text);
  if (utm) return utm;

  for (const [a, b] of splitPairs(text)) {
    const x = readAxis(a);
    const y = readAxis(b);
    if (!x || !y || x.parts !== y.parts) continue;
    const warnings: string[] = [];
    let latAxis = x;
    let lngAxis = y;
    const xIsLng = x.hemi === 'E' || x.hemi === 'W';
    const yIsLat = y.hemi === 'N' || y.hemi === 'S';
    if (xIsLng || yIsLat) [latAxis, lngAxis] = [y, x];
    else if (!x.hemi && !y.hemi && Math.abs(x.value) > 90 && Math.abs(y.value) <= 90) {
      [latAxis, lngAxis] = [y, x];
      warnings.push('Read as longitude first, then latitude.');
    }
    if (latAxis.hemi === 'E' || latAxis.hemi === 'W' || lngAxis.hemi === 'N' || lngAxis.hemi === 'S') continue;
    const lat = latAxis.value;
    const lng = lngAxis.value;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    if (lng > 0 && !lngAxis.hemi) warnings.push('Longitude is east of Greenwich. Anywhere in Canada it should be negative (west).');
    const format: CoordFormat = x.parts === 1 ? 'decimal' : x.parts === 2 ? 'degrees-minutes' : 'degrees-minutes-seconds';
    return { ok: true, lat: round7(lat), lng: round7(lng), format, warnings };
  }
  return {
    ok: false,
    error: 'could not read that as a coordinate. Try "51.2034, -115.6120", "N51 12.204 W115 36.720" or "11U 594123 5677123"',
  };
}

/** Decimal degrees as CalTopo and most tools accept them: "51.2034, -115.6120". */
export function formatLatLng(lat: number, lng: number, digits = 5): string {
  return `${lat.toFixed(digits)}, ${lng.toFixed(digits)}`;
}
