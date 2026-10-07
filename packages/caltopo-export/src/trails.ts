import ClipperLib from 'clipper-lib';
import type { LngLat } from './search-map.ts';

/**
 * Trail corridor segments: each trail inside a radius of the planning point is
 * cut into pieces of about equal length and buffered a fixed distance either
 * side, giving one polygon per piece for a hasty team to clear.
 *
 * Trails come from a file the planner supplies (GPX, or GeoJSON such as a
 * CalTopo export). Nothing is looked up from an outside service.
 *
 * Geometry is worked in a flat local frame centred on the planning point
 * (metres east and north). Over the tens of kilometres a search map covers the
 * distortion is well under a metre per kilometre, far below the corridor width.
 */
export const TRAILS_VERSION = 'trail-corridors@0.2.0';

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export interface XY {
  x: number;
  y: number;
}

export interface LocalFrame {
  toXY: (p: LngLat) => XY;
  toLngLat: (p: XY) => LngLat;
}

/** Equirectangular frame around `origin`. */
export function localFrame(origin: LngLat): LocalFrame {
  const k = Math.cos(rad(origin.lat));
  return {
    toXY: (p) => ({ x: rad(p.lng - origin.lng) * k * EARTH_RADIUS_M, y: rad(p.lat - origin.lat) * EARTH_RADIUS_M }),
    toLngLat: (p) => ({ lng: origin.lng + deg(p.x / (k * EARTH_RADIUS_M)), lat: origin.lat + deg(p.y / EARTH_RADIUS_M) }),
  };
}

const len = (a: XY, b: XY) => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a: XY, b: XY, t: number): XY => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function lineLength(line: readonly XY[]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += len(line[i - 1]!, line[i]!);
  return s;
}

/**
 * The parts of a line between `innerM` and `outerM` of the origin (a ring band;
 * an inner radius of 0 gives the whole circle), in order. Each leg is cut where
 * it crosses either circle.
 */
export function clipToBand(line: readonly XY[], innerM: number, outerM: number): XY[][] {
  const inBand = (p: XY) => {
    const r = Math.hypot(p.x, p.y);
    return r >= innerM && r <= outerM;
  };
  /** Parameters in (0,1) where leg a→b crosses a circle of radius r. */
  const crossings = (a: XY, b: XY, r: number): number[] => {
    if (r <= 0) return [];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const A = dx * dx + dy * dy;
    const B = 2 * (a.x * dx + a.y * dy);
    const C = a.x * a.x + a.y * a.y - r * r;
    const disc = B * B - 4 * A * C;
    if (A === 0 || disc <= 0) return [];
    const q = Math.sqrt(disc);
    return [(-B - q) / (2 * A), (-B + q) / (2 * A)].filter((t) => t > 0 && t < 1);
  };
  const out: XY[][] = [];
  let cur: XY[] = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const ts = [0, ...crossings(a, b, innerM), ...crossings(a, b, outerM), 1].sort((u, v) => u - v);
    for (let k = 1; k < ts.length; k++) {
      if (ts[k]! - ts[k - 1]! <= 0) continue;
      // Each piece between crossings is wholly in or out of the band: test its middle.
      if (inBand(lerp(a, b, (ts[k - 1]! + ts[k]!) / 2))) {
        if (!cur.length) cur.push(lerp(a, b, ts[k - 1]!));
        cur.push(lerp(a, b, ts[k]!));
      } else if (cur.length) {
        out.push(cur);
        cur = [];
      }
    }
  }
  if (cur.length) out.push(cur);
  return out.map((l) => l.filter((q, i) => i === 0 || len(l[i - 1]!, q) > 1e-9)).filter((l) => l.length >= 2 && lineLength(l) > 0);
}

/** The parts of a line inside a circle of `radius` about the origin, in order. */
export function clipToCircle(line: readonly XY[], radius: number): XY[][] {
  return clipToBand(line, 0, radius);
}

/**
 * Joins lines that meet end to end where only those two lines meet (a trail
 * drawn in several parts), so pieces are not cut short at every join. Lines are
 * not joined through a junction of three or more. Ends within `toleranceM` meet.
 */
export function joinLines(lines: readonly (readonly XY[])[], toleranceM = 1): XY[][] {
  const key = (p: XY) => `${Math.round(p.x / toleranceM)},${Math.round(p.y / toleranceM)}`;
  const degree = new Map<string, number>();
  for (const l of lines) for (const p of [l[0]!, l[l.length - 1]!]) degree.set(key(p), (degree.get(key(p)) ?? 0) + 1);
  const used = new Array<boolean>(lines.length).fill(false);
  const out: XY[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let cur = [...lines[i]!];
    // Grow the end, then the start, while exactly one other unused line meets there.
    for (const atEnd of [true, false]) {
      for (;;) {
        const tip = atEnd ? cur[cur.length - 1]! : cur[0]!;
        const k = key(tip);
        if (degree.get(k) !== 2) break;
        const j = lines.findIndex((l, n) => !used[n] && (key(l[0]!) === k || key(l[l.length - 1]!) === k));
        if (j < 0) break;
        used[j] = true;
        const l = lines[j]!;
        const fwd = key(l[0]!) === k ? [...l] : [...l].reverse();
        // fwd starts at the tip.
        cur = atEnd ? [...cur, ...fwd.slice(1)] : [...fwd.reverse().slice(0, -1), ...cur];
        if (key(cur[0]!) === key(cur[cur.length - 1]!) && cur.length > 2) break; // closed loop
      }
    }
    out.push(cur);
  }
  return out;
}

/**
 * Cuts a line into round(length / target) pieces of equal length (at least
 * one), so no short scrap is left at the end.
 */
export function splitEvenly(line: readonly XY[], targetM: number): XY[][] {
  const total = lineLength(line);
  const n = Math.max(1, Math.round(total / targetM));
  const step = total / n;
  const pieces: XY[][] = [];
  let cur: XY[] = [line[0]!];
  let done = 0; // length covered by finished pieces plus cur
  let next = step;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const l = len(a, b);
    while (pieces.length < n - 1 && done + l >= next - 1e-9) {
      const q = lerp(a, b, l === 0 ? 0 : (next - done) / l);
      cur.push(q);
      pieces.push(cur);
      cur = [q];
      next += step;
    }
    cur.push(b);
    done += l;
  }
  pieces.push(cur);
  return pieces.map((p) => p.filter((q, i) => i === 0 || len(p[i - 1]!, q) > 1e-6)).filter((p) => p.length >= 2);
}

type Ring = [number, number][];

/** Clipper works in integers: centimetres. */
const SCALE = 100;
/** Largest gap between a rounded end or bend and the true circle, in metres. */
export const ARC_TOLERANCE_M = 0.25;

/**
 * Every point within `halfWidthM` of the line, with round ends and bends,
 * using Clipper's offsetting (robust where switchbacks make the corridor
 * overlap itself). Rounded parts sit inside the true circle by at most
 * ARC_TOLERANCE_M. Returns rings in the local frame, closed, outer ring first,
 * then any holes (where a trail loops back on itself).
 */
export function bufferLine(line: readonly XY[], halfWidthM: number): Ring[] {
  const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE_M * SCALE);
  co.AddPath(
    line.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })),
    ClipperLib.JoinType.jtRound,
    ClipperLib.EndType.etOpenRound,
  );
  const paths: ClipperLib.Path[] = [];
  co.Execute(paths, halfWidthM * SCALE);
  if (!paths.length) throw new Error('trail piece produced no corridor');
  // One connected line gives one outer ring (largest area) and possibly holes.
  const byArea = [...paths].sort((a, b) => Math.abs(ClipperLib.Clipper.Area(b)) - Math.abs(ClipperLib.Clipper.Area(a)));
  const outerSign = Math.sign(ClipperLib.Clipper.Area(byArea[0]!));
  return byArea
    .filter((p, i) => i === 0 || Math.sign(ClipperLib.Clipper.Area(p)) !== outerSign)
    .map((p) => {
      const r: Ring = p.map((q) => [q.X / SCALE, q.Y / SCALE]);
      r.push(r[0]!);
      return r;
    });
}

export interface TrailCorridor {
  /** T-1, T-2, … in the order the trails and pieces were read. */
  name: string;
  /** Polygon rings in longitude/latitude, outer ring first. */
  rings: LngLat[][];
  /** Length of trail inside the piece, in metres. */
  trailLengthM: number;
}

export interface TrailCorridorOptions {
  /** Distance either side of the trail, in metres. */
  halfWidthM: number;
  /** Target piece length along the trail, in metres. */
  pieceLengthM: number;
  /**
   * Ring bands to cover, as distances from the planning point (inner 0 for the
   * innermost). Touching bands are treated as one, so pieces are not cut at a
   * ring between two chosen bands.
   */
  bands: { innerM: number; outerM: number }[];
}

export const DEFAULT_TRAIL_OPTIONS = { halfWidthM: 50, pieceLengthM: 1000 } as const;

/** Corridor polygons for every trail inside the chosen ring bands around `origin`. Inputs are not changed. */
export function trailCorridors(origin: LngLat, trails: readonly (readonly LngLat[])[], opts: TrailCorridorOptions): TrailCorridor[] {
  if (!(opts.halfWidthM >= 5 && opts.halfWidthM <= 1000)) throw new Error('corridor half-width must be 5 to 1000 m');
  if (!(opts.pieceLengthM >= 100 && opts.pieceLengthM <= 20000)) throw new Error('piece length must be 100 m to 20 km');
  const f = localFrame(origin);
  const out: TrailCorridor[] = [];
  const lines = joinLines(trails.map((t) => t.map(f.toXY)));
  for (const band of mergeBands(opts.bands)) {
    for (const part of lines.flatMap((l) => clipToBand(l, band.innerM, band.outerM))) {
      for (const piece of splitEvenly(part, opts.pieceLengthM)) {
        const rings = bufferLine(piece, opts.halfWidthM).map((r) => r.map(([x, y]) => f.toLngLat({ x, y })));
        out.push({ name: `T-${out.length + 1}`, rings, trailLengthM: lineLength(piece) });
      }
    }
  }
  return out;
}

/** Bands sorted outwards, with touching or overlapping bands joined. */
function mergeBands(bands: readonly { innerM: number; outerM: number }[]): { innerM: number; outerM: number }[] {
  const out: { innerM: number; outerM: number }[] = [];
  for (const b of [...bands].sort((p, q) => p.innerM - q.innerM)) {
    const last = out[out.length - 1];
    if (last && b.innerM <= last.outerM) last.outerM = Math.max(last.outerM, b.outerM);
    else out.push({ ...b });
  }
  return out;
}

/**
 * Reads trail lines from a GPX file (tracks and routes; times not needed) or a
 * GeoJSON file (LineString and MultiLineString features). Returns the lines and
 * a count of what was skipped.
 */
export function parseTrailFile(text: string): { lines: LngLat[][]; skipped: number } {
  const head = text.trimStart().slice(0, 200);
  if (head.startsWith('<')) {
    if (!/<gpx[\s>]/.test(text)) throw new Error('file is not GPX');
    const lines: LngLat[][] = [];
    let skipped = 0;
    const blocks = [...(text.match(/<trkseg[\s>][\s\S]*?<\/trkseg>/g) ?? []), ...(text.match(/<rte[\s>][\s\S]*?<\/rte>/g) ?? [])];
    for (const b of blocks) {
      const pts = [...b.matchAll(/<(?:trkpt|rtept)\b([^>]*?)\/?>/g)].map((m) => ({ lat: attr(m[1]!, 'lat'), lng: attr(m[1]!, 'lon') }));
      if (pts.length >= 2 && pts.every(valid)) lines.push(pts);
      else skipped++;
    }
    if (!blocks.length) throw new Error('no tracks or routes found in the GPX file');
    return { lines, skipped };
  }
  if (head.startsWith('{')) {
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('file is not valid JSON');
    }
    const feats: any[] = json?.type === 'FeatureCollection' && Array.isArray(json.features) ? json.features : json?.type === 'Feature' ? [json] : [];
    if (!feats.length) throw new Error('file is not a GeoJSON FeatureCollection');
    const lines: LngLat[][] = [];
    let skipped = 0;
    for (const ft of feats) {
      const g = ft?.geometry;
      const cs: unknown[] = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
      if (!cs.length) {
        if (g) skipped++;
        continue;
      }
      for (const c of cs) {
        const pts = Array.isArray(c) ? c.map((p: any) => ({ lng: Number(p?.[0]), lat: Number(p?.[1]) })) : [];
        if (pts.length >= 2 && pts.every(valid)) lines.push(pts);
        else skipped++;
      }
    }
    return { lines, skipped };
  }
  throw new Error('unrecognised file: expected GPX or GeoJSON');
}

const valid = (p: LngLat) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

function attr(tag: string, name: string): number {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(tag);
  return m ? Number(m[1]) : NaN;
}
