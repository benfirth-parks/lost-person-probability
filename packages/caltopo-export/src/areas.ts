import ClipperLib from 'clipper-lib';
import type { LngLat } from './search-map.ts';
import { localFrame, type XY } from './trails.ts';

/**
 * Area segments bounded by terrain: the search area (a circle out to a range
 * ring) is cut along boundary lines a searcher can find on the ground (streams,
 * roads, trails, ridgelines, cliff bands). Any piece still larger than a team
 * can cover is halved with straight cuts across its long axis until it fits.
 *
 * Lines come from the caller (bundled open data or a planner's file). Nothing
 * is looked up from an outside service. Geometry is worked in the same flat
 * local frame as the trail corridors.
 */
export const AREAS_VERSION = 'terrain-areas@0.1.0';

type Ring = [number, number][];

/** One area: an outer ring and any holes (an island between two streams, say). */
export interface Piece {
  outer: Ring;
  holes: Ring[];
}

/** Clipper works in integers: centimetres. */
const SCALE = 100;
const toPath = (r: readonly [number, number][]): ClipperLib.Path => r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromPath = (p: ClipperLib.Path): Ring => {
  const r: Ring = p.map((q) => [q.X / SCALE, q.Y / SCALE]);
  r.push(r[0]!);
  return r;
};

/** Area of a closed ring in square metres (always positive). */
export function ringAreaM2(r: readonly [number, number][]): number {
  let s = 0;
  for (let i = 1; i < r.length; i++) s += r[i - 1]![0] * r[i]![1] - r[i]![0] * r[i - 1]![1];
  return Math.abs(s / 2);
}

/** Area-weighted centre of the outer ring (holes ignored; used for ordering only). */
export function ringCentroid(r: readonly [number, number][]): XY {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 1; i < r.length; i++) {
    const [x0, y0] = r[i - 1]!;
    const [x1, y1] = r[i]!;
    const k = x0 * y1 - x1 * y0;
    a += k;
    cx += (x0 + x1) * k;
    cy += (y0 + y1) * k;
  }
  return a === 0 ? { x: r[0]![0], y: r[0]![1] } : { x: cx / (3 * a), y: cy / (3 * a) };
}

export const pieceAreaM2 = (p: Piece) => ringAreaM2(p.outer) - p.holes.reduce((s, h) => s + ringAreaM2(h), 0);

/** Circle of `radiusM` about the origin, as a closed ring every 2°. */
export function circleRing(radiusM: number): Ring {
  const r: Ring = [];
  for (let a = 0; a < 360; a += 2) r.push([radiusM * Math.sin((a * Math.PI) / 180), radiusM * Math.cos((a * Math.PI) / 180)]);
  r.push(r[0]!);
  return r;
}

/** Runs one Clipper boolean and returns the result as pieces (outer ring plus holes). */
function clip(subject: ClipperLib.Paths, clipPaths: ClipperLib.Paths, op: ClipperLib.ClipType): Piece[] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  if (clipPaths.length) c.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(op, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const out: Piece[] = [];
  const walk = (n: ClipperLib.PolyNode) => {
    for (const child of n.Childs()) {
      if (!child.IsHole()) out.push({ outer: fromPath(child.Contour()), holes: child.Childs().map((h) => fromPath(h.Contour())) });
      // Islands inside holes are outers again.
      for (const h of child.Childs()) walk(h);
    }
  };
  walk(tree);
  return out;
}

const piecePaths = (p: Piece): ClipperLib.Paths => [toPath(p.outer.slice(0, -1)), ...p.holes.map((h) => toPath(h.slice(0, -1)))];

/** Thin strips along each line, `gapM` wide in all, merged. Cutting the area by these splits it along the lines. */
function cutStrips(lines: readonly (readonly XY[])[], gapM: number): ClipperLib.Paths {
  const co = new ClipperLib.ClipperOffset(2, 0.25 * SCALE);
  for (const l of lines) {
    if (l.length < 2) continue;
    co.AddPath(
      l.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })),
      ClipperLib.JoinType.jtSquare,
      ClipperLib.EndType.etOpenButt,
    );
  }
  const paths: ClipperLib.Paths = [];
  co.Execute(paths, (gapM / 2) * SCALE);
  return paths;
}

/**
 * Halves a piece with a straight cut through its centre, across the longer
 * side of its bounding box, until every part is at most `maxAreaM2`.
 */
export function splitToSize(p: Piece, maxAreaM2: number, depth = 0): Piece[] {
  if (pieceAreaM2(p) <= maxAreaM2 || depth > 12) return [p];
  const xs = p.outer.map((q) => q[0]);
  const ys = p.outer.map((q) => q[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 10;
  const halves: Ring[] =
    x1 - x0 >= y1 - y0
      ? [
          [[x0 - pad, y0 - pad], [(x0 + x1) / 2, y0 - pad], [(x0 + x1) / 2, y1 + pad], [x0 - pad, y1 + pad]],
          [[(x0 + x1) / 2, y0 - pad], [x1 + pad, y0 - pad], [x1 + pad, y1 + pad], [(x0 + x1) / 2, y1 + pad]],
        ]
      : [
          [[x0 - pad, y0 - pad], [x1 + pad, y0 - pad], [x1 + pad, (y0 + y1) / 2], [x0 - pad, (y0 + y1) / 2]],
          [[x0 - pad, (y0 + y1) / 2], [x1 + pad, (y0 + y1) / 2], [x1 + pad, y1 + pad], [x0 - pad, y1 + pad]],
        ];
  return halves.flatMap((h) => clip(piecePaths(p), [toPath(h)], ClipperLib.ClipType.ctIntersection).flatMap((q) => splitToSize(q, maxAreaM2, depth + 1)));
}

export interface AreaSegment {
  /** A-1, A-2, … nearest the planning point first, then clockwise from north. */
  name: string;
  /** Polygon rings in longitude/latitude, outer ring first. */
  rings: LngLat[][];
  areaM2: number;
}

export interface AreaSegmentOptions {
  /** Search area: everything within this distance of the planning point. */
  radiusM: number;
  /** Largest area one segment may have, in square metres. A planner's choice, not a statistic. */
  maxAreaM2: number;
  /** Width of the strip removed along each boundary line, so neighbouring areas do not overlap. */
  gapM?: number;
  /** Pieces smaller than this are slivers between close lines; their total is reported, not hidden. */
  minAreaM2?: number;
}

export const DEFAULT_AREA_OPTIONS = { maxAreaM2: 1_000_000, gapM: 2, minAreaM2: 5_000 } as const;

export interface AreaSegmentResult {
  segments: AreaSegment[];
  /** Area left out as slivers, in square metres. */
  sliverAreaM2: number;
  sliverCount: number;
}

/** Cuts the circle of `radiusM` about `origin` along `lines`, then splits oversize pieces. Inputs are not changed. */
export function areaSegments(origin: LngLat, lines: readonly (readonly LngLat[])[], opts: AreaSegmentOptions): AreaSegmentResult {
  const { radiusM, maxAreaM2 } = opts;
  const gapM = opts.gapM ?? DEFAULT_AREA_OPTIONS.gapM;
  const minAreaM2 = opts.minAreaM2 ?? DEFAULT_AREA_OPTIONS.minAreaM2;
  if (!(radiusM >= 100 && radiusM <= 100_000)) throw new Error('area radius must be 100 m to 100 km');
  if (!(maxAreaM2 >= 10_000 && maxAreaM2 <= 100_000_000)) throw new Error('largest segment must be 0.01 to 100 km²');
  if (!(gapM > 0 && gapM <= 50)) throw new Error('gap must be more than 0 and at most 50 m');
  const f = localFrame(origin);
  const cut = clip([toPath(circleRing(radiusM).slice(0, -1))], cutStrips(lines.map((l) => l.map(f.toXY)), gapM), ClipperLib.ClipType.ctDifference);
  const pieces = cut.flatMap((p) => splitToSize(p, maxAreaM2));
  const kept = pieces.filter((p) => pieceAreaM2(p) >= minAreaM2);
  const slivers = pieces.filter((p) => pieceAreaM2(p) < minAreaM2);
  const ordered = kept
    .map((p) => {
      const c = ringCentroid(p.outer);
      return { p, d: Math.hypot(c.x, c.y), b: (Math.atan2(c.x, c.y) * 180) / Math.PI + 360 };
    })
    // Bands of 500 m out from the planning point, clockwise from north within each band.
    .sort((a, b) => Math.floor(a.d / 500) - Math.floor(b.d / 500) || (a.b % 360) - (b.b % 360));
  return {
    segments: ordered.map(({ p }, i) => ({
      name: `A-${i + 1}`,
      rings: [p.outer, ...p.holes].map((r) => r.map(([x, y]) => f.toLngLat({ x, y }))),
      areaM2: pieceAreaM2(p),
    })),
    sliverAreaM2: slivers.reduce((s, p) => s + pieceAreaM2(p), 0),
    sliverCount: slivers.length,
  };
}
