import ClipperLib from 'clipper-lib';
import type { LngLat } from './search-map.ts';
import { localFrame, mergeBands, type XY } from './trails.ts';

/**
 * Area segments from terrain polygons (ridges, creeks and lakes, built ahead of
 * time by scripts/terrain/build_ridge_segments.py), kept only inside the ring
 * bands the planner ticks. The terrain sets every boundary except the edges of
 * the ticked bands; touching bands are treated as one, so a segment that
 * crosses the ring between two ticked bands is not cut there.
 *
 * Geometry is worked in the same flat local frame as the trail corridors.
 */
export const AREAS_VERSION = 'ridge-areas@0.1.0';

/** Pieces smaller than this, left where a ring cuts the corner of a segment, are dropped (m²). Not a size rule for segments. */
export const CRUMB_M2 = 5000;
/** Rings are drawn as polygons with this many sides: the gap to the true circle is r·(1 − cos(π/n)), under 1 m at 10 km. */
const CIRCLE_SIDES = 720;
/** Clipper works in integers: centimetres. */
const SCALE = 100;

type Path = ClipperLib.Path;

export interface AreaSegment {
  /** A-1, A-2, … nearest the planning point first: by the distance to the segment's nearest edge, 0 for the one that covers it. */
  name: string;
  /** Polygon rings in longitude/latitude, outer ring first, then holes (lakes). Closed. */
  rings: LngLat[][];
  areaM2: number;
}

export type Band = { innerM: number; outerM: number };

const toPath = (ring: readonly XY[]): Path => ring.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));

function circle(radiusM: number): Path {
  return Array.from({ length: CIRCLE_SIDES }, (_, i) => {
    const a = (2 * Math.PI * i) / CIRCLE_SIDES;
    return { X: Math.round(Math.sin(a) * radiusM * SCALE), Y: Math.round(Math.cos(a) * radiusM * SCALE) };
  });
}

/** How far the shape is from the origin: 0 if it covers the origin, else the distance to its nearest edge (m). */
function nearness(contours: Path[]): number {
  let inside = false;
  let best = Infinity;
  for (const path of contours) {
    for (let i = 0; i < path.length; i++) {
      const p = path[i]!;
      const q = path[(i + 1) % path.length]!;
      // Even-odd ray test along +x, and distance from the origin to edge p–q.
      if (p.Y > 0 !== q.Y > 0 && 0 < p.X + ((0 - p.Y) * (q.X - p.X)) / (q.Y - p.Y)) inside = !inside;
      const dx = q.X - p.X;
      const dy = q.Y - p.Y;
      const t = Math.max(0, Math.min(1, -(p.X * dx + p.Y * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(p.X + t * dx, p.Y + t * dy));
    }
  }
  return inside ? 0 : best / SCALE;
}

/**
 * The parts of each terrain polygon inside the chosen bands around `origin`,
 * named A-1, A-2, … nearest the origin first (one covering it is nearest). Each input
 * polygon is rings in longitude/latitude, outer first. Inputs are not changed.
 */
export function areaSegmentsInBands(origin: LngLat, polygons: readonly (readonly (readonly LngLat[])[])[], bands: readonly Band[]): AreaSegment[] {
  const merged = mergeBands(bands).filter((b) => b.outerM > b.innerM);
  if (!merged.length || !polygons.length) return [];
  const f = localFrame(origin);
  const maxR = merged[merged.length - 1]!.outerM;
  // The ticked bands as one clip region: outer circles with the inner circles as holes.
  const clipPaths: Path[] = [];
  for (const b of merged) {
    clipPaths.push(circle(b.outerM));
    if (b.innerM > 0) clipPaths.push(circle(b.innerM).reverse());
  }
  const found: { outer: Path; holes: Path[]; areaM2: number; d: number }[] = [];
  for (const poly of polygons) {
    const local = poly.map((r) => r.map(f.toXY));
    // Skip polygons wholly outside the outer circle (cheap box test).
    const xs = local[0]!.map((p) => p.x);
    const ys = local[0]!.map((p) => p.y);
    const dx = Math.max(0, Math.min(...xs), -Math.max(...xs));
    const dy = Math.max(0, Math.min(...ys), -Math.max(...ys));
    if (Math.hypot(dx, dy) > maxR) continue;
    const c = new ClipperLib.Clipper();
    c.AddPaths(local.map(toPath), ClipperLib.PolyType.ptSubject, true);
    c.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);
    const tree = new ClipperLib.PolyTree();
    c.Execute(ClipperLib.ClipType.ctIntersection, tree, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
    const walk = (node: ClipperLib.PolyNode) => {
      for (const child of node.Childs()) {
        if (!child.IsHole()) {
          const outer = child.Contour();
          const holes = child.Childs().map((h) => h.Contour());
          const areaM2 = (Math.abs(ClipperLib.Clipper.Area(outer)) - holes.reduce((s, h) => s + Math.abs(ClipperLib.Clipper.Area(h)), 0)) / (SCALE * SCALE);
          if (areaM2 >= CRUMB_M2) {
            found.push({ outer, holes, areaM2, d: nearness([outer, ...holes]) });
          }
        }
        walk(child);
      }
    };
    walk(tree);
  }
  found.sort((a, b) => a.d - b.d);
  const toRing = (p: Path) => {
    const r = p.map((q) => f.toLngLat({ x: q.X / SCALE, y: q.Y / SCALE }));
    r.push(r[0]!);
    return r;
  };
  return found.map((g, i) => ({ name: `A-${i + 1}`, rings: [g.outer, ...g.holes].map(toRing), areaM2: g.areaM2 }));
}
