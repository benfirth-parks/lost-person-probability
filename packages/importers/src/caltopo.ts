import { pointInPolygon, validatePolygon, type Point, type Polygon } from '../../geospatial/src/grid.ts';
import { hashValue } from '../../domain/src/hash.ts';
import { assessTrack, type TrackPoint, type TrackReport } from '../../pod-engine/src/pod.ts';

/**
 * File-based import of CalTopo exports (GeoJSON) and GPX tracks.
 *
 * Runs locally: the caller reads the file and passes its text in, and nothing
 * is sent anywhere. Projection to the case's local metre grid is supplied by
 * the caller so this package stays independent of any CRS library.
 *
 * Free text (descriptions, comments) is dropped on purpose: it can carry names
 * or narrative, which the research interface must not hold. Only a short
 * label, an assignment number and a status are kept.
 *
 * The CalTopo field mapping follows CalTopo's documented GeoJSON export
 * (`properties.class`, `title`, `number`, `status`, coordinates with an
 * optional epoch-millisecond fourth element). A real BYK search-map template
 * export confirmed the folder, marker and coordinate layout (untimed
 * coordinates carry 0 as the fourth element). A real incident export
 * confirmed polygon assignments identified by `letter` with `status` and
 * `resourceType`, and timestamped aircraft tracks. Further real exports
 * confirmed timestamped ground tracks (about 5 s sampling) that include
 * driving and long stops, and hand-drawn outlines with repeated vertices and
 * small self-crossings, which this importer now handles.
 */
export const IMPORTER_VERSION = 'caltopo-import@0.1.0';

export type Project = (lng: number, lat: number) => Point;

export interface ImportedAssignment {
  readonly sourceId: string;
  readonly label: string;
  readonly status: string | null;
  /** CalTopo resource type (GROUND, AIR, ...). Only ground search has an approved POD model. */
  readonly resourceType: string | null;
  readonly area: Polygon;
  /** The outline crosses itself, but harmlessly: no area is lost at SELF_CROSSING_SAMPLE_M. */
  readonly selfCrossing: boolean;
  /** Planned area only. Searched coverage comes from tracks, never from this polygon. */
  readonly kind: 'planned_area';
}

export interface ImportedTrack {
  readonly sourceId: string;
  readonly label: string;
  /** Raw recorded points, unchanged. */
  readonly points: readonly TrackPoint[];
  readonly report: TrackReport;
  /** Median speed above any ground pace: almost certainly an aircraft track. */
  readonly likelyAircraft: boolean;
  /** The on-foot parts of the track. Only these count as ground search effort. */
  readonly segments: readonly (readonly TrackPoint[])[];
  /** Seconds spent in each movement class, so the planner sees what was removed. */
  readonly movement: { readonly onFootS: number; readonly vehicleS: number; readonly stationaryS: number };
}

/** 10 m/s (36 km/h): no ground team sustains this as a median speed. */
export const AIRCRAFT_MEDIAN_SPEED_MPS = 10;

/**
 * Movement segmentation (track-segment@1). These are data-cleaning thresholds,
 * not behavioural statistics: they separate searching on foot from driving and
 * from a device left standing, whose GPS jitter would otherwise add fake track
 * length and over-credit coverage. Speed is the straight-line displacement over
 * a window of about a minute, which averages out jitter.
 */
export const TRACK_SEGMENTATION = {
  version: 'track-segment@1',
  windowS: 60,
  /** Below this a device is effectively standing still. */
  stationaryMps: 0.15,
  /** Above this the device is in a vehicle (a brisk walk is about 1.5 m/s). */
  vehicleMps: 3,
  /** Shorter stops or drives are kept as part of the on-foot track. */
  minRunS: 60,
} as const;

type Movement = 'foot' | 'vehicle' | 'stationary';

function classify(points: readonly TrackPoint[]): Movement[] {
  const { windowS, stationaryMps, vehicleMps } = TRACK_SEGMENTATION;
  const half = (windowS * 1000) / 2;
  const out: Movement[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < points.length; i++) {
    const t = points[i]!.t;
    while (points[lo]!.t < t - half) lo++;
    while (hi + 1 < points.length && points[hi + 1]!.t <= t + half) hi++;
    const a = points[lo]!;
    const b = points[hi]!;
    const dt = (b.t - a.t) / 1000;
    const v = dt > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / dt : 0;
    out.push(v < stationaryMps ? 'stationary' : v > vehicleMps ? 'vehicle' : 'foot');
  }
  return out;
}

/** Splits a track into on-foot segments, dropping sustained driving and standing still. */
export function segmentTrack(points: readonly TrackPoint[]): { segments: TrackPoint[][]; movement: ImportedTrack['movement'] } {
  const cls = classify(points);
  // Runs of one class; short non-foot runs are folded back into foot.
  const runs: Array<{ kind: Movement; from: number; to: number }> = [];
  cls.forEach((k, i) => {
    const last = runs[runs.length - 1];
    if (last && last.kind === k) last.to = i;
    else runs.push({ kind: k, from: i, to: i });
  });
  const dur = (r: { from: number; to: number }) => (points[Math.min(r.to + 1, points.length - 1)]!.t - points[r.from]!.t) / 1000;
  for (const r of runs) if (r.kind !== 'foot' && dur(r) < TRACK_SEGMENTATION.minRunS) r.kind = 'foot';
  // A brief "foot" reading squeezed between a drive and a stop is the window blurring
  // the change of mode, not walking.
  runs.forEach((r, i) => {
    const before = runs[i - 1];
    const after = runs[i + 1];
    if (r.kind === 'foot' && before && after && before.kind !== 'foot' && after.kind !== 'foot' && dur(r) < TRACK_SEGMENTATION.minRunS) r.kind = before.kind;
  });

  const movement = { onFootS: 0, vehicleS: 0, stationaryS: 0 };
  const segments: TrackPoint[][] = [];
  let current: TrackPoint[] | null = null;
  for (const r of runs) {
    const d = dur(r);
    if (r.kind === 'foot') {
      movement.onFootS += d;
      current ??= [];
      for (let i = r.from; i <= r.to; i++) current.push(points[i]!);
    } else {
      if (r.kind === 'vehicle') movement.vehicleS += d;
      else movement.stationaryS += d;
      if (current && current.length > 1) segments.push(current);
      current = null;
    }
  }
  if (current && current.length > 1) segments.push(current);
  return { segments, movement };
}

function medianSpeed(points: readonly TrackPoint[]): number {
  const v: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i]!.t - points[i - 1]!.t) / 1000;
    if (dt > 0) v.push(Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y) / dt);
  }
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)]!;
}

function track(sourceId: string, labelText: string, points: TrackPoint[]): ImportedTrack {
  return { sourceId, label: labelText, points, report: assessTrack(points), likelyAircraft: medianSpeed(points) > AIRCRAFT_MEDIAN_SPEED_MPS, ...segmentTrack(points) };
}

export interface ImportResult {
  readonly importerVersion: string;
  readonly sourceHash: string;
  readonly assignments: readonly ImportedAssignment[];
  readonly tracks: readonly ImportedTrack[];
  /** Features that were not imported, with the reason. Nothing is dropped silently. */
  readonly skipped: ReadonlyArray<{ sourceId: string; reason: string }>;
}

const MAX_LABEL = 40;

function label(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL);
}

// Epoch milliseconds between 2000 and 2100: tells a timestamp apart from other fourth values.
function isEpochMs(v: unknown): v is number {
  return typeof v === 'number' && v > 946_684_800_000 && v < 4_102_444_800_000;
}

/** Sample spacing used to check whether a self-crossing outline loses any area. */
export const SELF_CROSSING_SAMPLE_M = 20;

function winding(p: Point, poly: Polygon): number {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y && b.y > p.y && side > 0) w++;
    else if (a.y > p.y && b.y <= p.y && side < 0) w--;
  }
  return w;
}

/**
 * Area (m²) that a self-crossing outline would lose: places the outline wraps
 * around (non-zero winding) that the even-odd fill used by the grid code
 * leaves out, where the outline overlaps itself.
 */
export function selfOverlapArea(poly: Polygon, step = SELF_CROSSING_SAMPLE_M): number {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  let lost = 0;
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      const p = { x, y };
      if (winding(p, poly) !== 0 && !pointInPolygon(p, poly)) lost++;
    }
  }
  return lost * step * step;
}

function ring(coords: unknown, project: Project): Point[] | null {
  if (!Array.isArray(coords)) return null;
  const pts: Point[] = [];
  let prev: unknown[] | null = null;
  for (const c of coords) {
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null;
    // CalTopo repeats a vertex where an outline was snapped to a trail. The repeat is a
    // zero-length edge that reads as a self-crossing, so it is dropped; the shape is unchanged.
    if (prev && prev[0] === c[0] && prev[1] === c[1]) continue;
    prev = c;
    pts.push(project(c[0], c[1]));
  }
  // GeoJSON rings repeat the first vertex at the end; the grid code does not.
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (a && b && pts.length > 1 && a.x === b.x && a.y === b.y) pts.pop();
  return pts;
}

function timedLine(coords: unknown, times: unknown, project: Project): TrackPoint[] | string {
  if (!Array.isArray(coords) || coords.length < 2) return 'line has fewer than 2 points';
  const out: TrackPoint[] = [];
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return `point ${i} is not a coordinate`;
    let t: number | undefined = isEpochMs(c[3]) ? c[3] : undefined;
    if (t === undefined && Array.isArray(times)) {
      const s = times[i];
      const parsed = typeof s === 'string' ? Date.parse(s) : typeof s === 'number' ? s : NaN;
      if (isEpochMs(parsed)) t = parsed;
    }
    if (t === undefined) return 'line has no timestamps, so it is a drawn line, not a recorded track';
    out.push({ ...project(c[0], c[1]), t });
  }
  return out;
}

/** Parses a CalTopo GeoJSON export. Polygon assignments become planned areas; timestamped lines become tracks. */
export function parseCaltopoGeoJson(text: string, project: Project): ImportResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('file is not valid JSON');
  }
  const fc = json as { type?: unknown; features?: unknown };
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw new Error('file is not a GeoJSON FeatureCollection');

  const assignments: ImportedAssignment[] = [];
  const tracks: ImportedTrack[] = [];
  const skipped: Array<{ sourceId: string; reason: string }> = [];

  fc.features.forEach((f: any, i: number) => {
    const props = (f && typeof f.properties === 'object' && f.properties) || {};
    const sourceId = String(f?.id ?? props.id ?? `feature-${i}`);
    const cls = typeof props.class === 'string' ? props.class : '';
    const geom = f?.geometry;
    const type = geom?.type;

    // Folders only group other features and carry no geometry.
    if (cls === 'Folder' && !geom) return;

    if (cls === 'Assignment' || (type === 'Polygon' && cls === '')) {
      if (type !== 'Polygon') {
        skipped.push({ sourceId, reason: `${cls || 'feature'} with ${type ?? 'no'} geometry: only polygon assignments are supported` });
        return;
      }
      if (Array.isArray(geom.coordinates) && geom.coordinates.length > 1) {
        skipped.push({ sourceId, reason: 'polygon has holes, which are not supported yet' });
        return;
      }
      const area = ring(geom.coordinates?.[0], project);
      const errs = area ? validatePolygon(area) : ['polygon coordinates are malformed'];
      // Hand-drawn outlines often loop back on themselves along a trail. That is only a
      // problem where the loop overlaps the outline and the fill would drop that area.
      const crossingOnly = errs.length > 0 && errs.every((e) => e.includes('intersect'));
      const lost = area && crossingOnly ? selfOverlapArea(area) : 0;
      if (!area || (errs.length && !crossingOnly) || lost > 0) {
        const why = lost > 0 ? `outline overlaps itself, which would drop about ${Math.round(lost / 100) * 100} m² from the area` : errs.join('; ');
        skipped.push({ sourceId, reason: `assignment outline is invalid (${why}); fix it in CalTopo and export again` });
        return;
      }
      // CalTopo identifies assignments by letter (A, B, ...) and sometimes a number.
      const id = [props.letter, props.number].filter((v) => typeof v === 'string' || typeof v === 'number').map(String).join('');
      assignments.push({
        sourceId,
        label: label(id ? `${id} ${props.title ?? ''}` : props.title, `Assignment ${assignments.length + 1}`),
        status: typeof props.status === 'string' ? props.status : null,
        resourceType: typeof props.resourceType === 'string' ? props.resourceType.toUpperCase() : null,
        area,
        selfCrossing: crossingOnly,
        kind: 'planned_area',
      });
      return;
    }

    if (type === 'LineString') {
      const pts = timedLine(geom.coordinates, props.coordTimes ?? props.coordinateProperties?.times, project);
      if (typeof pts === 'string') {
        skipped.push({ sourceId, reason: pts });
        return;
      }
      tracks.push(track(sourceId, label(props.title, `Track ${tracks.length + 1}`), pts));
      return;
    }

    skipped.push({ sourceId, reason: `${cls || type || 'unknown'} features are not imported` });
  });

  return { importerVersion: IMPORTER_VERSION, sourceHash: hashValue(text), assignments, tracks, skipped };
}

function attr(tag: string, name: string): number {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(tag);
  return m ? Number(m[1]) : NaN;
}

/** Parses the track segments of a GPX file. Each <trkseg> becomes one track so device gaps stay visible. */
export function parseGpx(text: string, project: Project): ImportResult {
  if (!/<gpx[\s>]/.test(text)) throw new Error('file is not GPX');
  const tracks: ImportedTrack[] = [];
  const skipped: Array<{ sourceId: string; reason: string }> = [];
  const segs = text.match(/<trkseg[\s>][\s\S]*?<\/trkseg>/g) ?? [];
  segs.forEach((seg, i) => {
    const sourceId = `trkseg-${i}`;
    const pts: TrackPoint[] = [];
    let problem = '';
    for (const m of seg.matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g)) {
      const lat = attr(m[1]!, 'lat');
      const lon = attr(m[1]!, 'lon');
      const time = /<time>([^<]+)<\/time>/.exec(m[2]!)?.[1];
      const t = time ? Date.parse(time.trim()) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        problem = `point ${pts.length} has no valid lat/lon`;
        break;
      }
      if (!isEpochMs(t)) {
        problem = `point ${pts.length} has no valid time`;
        break;
      }
      pts.push({ ...project(lon, lat), t });
    }
    if (!problem && pts.length < 2) problem = 'segment has fewer than 2 points';
    if (problem) skipped.push({ sourceId, reason: problem });
    else tracks.push(track(sourceId, `GPX segment ${i + 1}`, pts));
  });
  if (!segs.length) skipped.push({ sourceId: 'file', reason: 'no track segments found (routes and waypoints are not imported)' });
  return { importerVersion: IMPORTER_VERSION, sourceHash: hashValue(text), assignments: [], tracks, skipped };
}

/** Picks the parser from the file content. */
export function parseSearchFile(text: string, project: Project): ImportResult {
  const head = text.trimStart().slice(0, 200);
  if (head.startsWith('{')) return parseCaltopoGeoJson(text, project);
  if (head.startsWith('<')) return parseGpx(text, project);
  throw new Error('unrecognised file: expected CalTopo GeoJSON or GPX');
}
