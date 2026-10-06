import { validatePolygon, type Point, type Polygon } from '../../geospatial/src/grid.ts';
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
 * `resourceType`, and timestamped aircraft tracks. A timestamped ground track
 * has not yet been seen in a real export.
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
  /** Planned area only. Searched coverage comes from tracks, never from this polygon. */
  readonly kind: 'planned_area';
}

export interface ImportedTrack {
  readonly sourceId: string;
  readonly label: string;
  readonly points: readonly TrackPoint[];
  readonly report: TrackReport;
  /** Median speed above any ground pace: almost certainly an aircraft track. */
  readonly likelyAircraft: boolean;
}

/** 10 m/s (36 km/h): no ground team sustains this as a median speed. */
export const AIRCRAFT_MEDIAN_SPEED_MPS = 10;

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
  return { sourceId, label: labelText, points, report: assessTrack(points), likelyAircraft: medianSpeed(points) > AIRCRAFT_MEDIAN_SPEED_MPS };
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

function ring(coords: unknown, project: Project): Point[] | null {
  if (!Array.isArray(coords)) return null;
  const pts: Point[] = [];
  for (const c of coords) {
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null;
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
      if (!area || errs.length) {
        skipped.push({ sourceId, reason: `assignment outline is invalid (${errs.join('; ')}); fix it in CalTopo and export again` });
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
