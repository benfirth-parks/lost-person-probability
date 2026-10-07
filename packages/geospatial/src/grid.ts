/**
 * Regular raster grid in a local projected coordinate reference (metres).
 *
 * Coordinates are (x east, y north). Cell (col, row) has row 0 at the
 * southern edge; the flat index is `row * cols + col`. Projection from
 * geographic coordinates happens outside this module so that the geometry
 * code makes no hidden assumptions about datum, zone, or the dateline.
 */
export interface Grid {
  /** Coordinate-reference label, e.g. "EPSG:3402" or "local-exercise". */
  readonly crs: string;
  /** x of the western edge of column 0, metres. */
  readonly originX: number;
  /** y of the southern edge of row 0, metres. */
  readonly originY: number;
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Polyline = readonly Point[];
export type Polygon = readonly Point[];

export function makeGrid(g: Grid): Grid {
  if (!(g.cellSize > 0) || !Number.isFinite(g.cellSize)) throw new Error('cellSize must be a positive finite number');
  if (!Number.isInteger(g.cols) || !Number.isInteger(g.rows) || g.cols < 1 || g.rows < 1)
    throw new Error('cols and rows must be positive integers');
  if (!Number.isFinite(g.originX) || !Number.isFinite(g.originY)) throw new Error('origin must be finite');
  return Object.freeze({ ...g });
}

export const cellCount = (g: Grid): number => g.cols * g.rows;
export const cellArea = (g: Grid): number => g.cellSize * g.cellSize;
export const domainArea = (g: Grid): number => cellCount(g) * cellArea(g);

export function cellCentre(g: Grid, index: number): Point {
  const col = index % g.cols;
  const row = Math.floor(index / g.cols);
  return { x: g.originX + (col + 0.5) * g.cellSize, y: g.originY + (row + 0.5) * g.cellSize };
}

/** Index of the cell containing `p`, or -1 when `p` is outside the grid. */
export function cellIndexAt(g: Grid, p: Point): number {
  const col = Math.floor((p.x - g.originX) / g.cellSize);
  const row = Math.floor((p.y - g.originY) / g.cellSize);
  if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return -1;
  return row * g.cols + col;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Shortest distance from `p` to segment `a`–`b`. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToPolyline(p: Point, line: Polyline): number {
  if (line.length === 0) throw new Error('polyline is empty');
  if (line.length === 1) return distance(p, line[0]!);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegment(p, line[i - 1]!, line[i]!));
  return best;
}

export function polylineLength(line: Polyline): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += distance(line[i - 1]!, line[i]!);
  return total;
}

/** Even–odd point-in-polygon test. The polygon need not repeat its first vertex. */
export function pointInPolygon(p: Point, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Shoelace area in m². */
export function polygonArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j]!.x * poly[i]!.y - poly[i]!.x * poly[j]!.y;
  return Math.abs(s) / 2;
}

/** Validates a polygon: at least 3 finite vertices, non-zero area, no self-intersection. */
export function validatePolygon(poly: Polygon): string[] {
  const errors: string[] = [];
  if (poly.length < 3) errors.push('polygon needs at least 3 vertices');
  if (poly.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) errors.push('polygon has non-finite coordinates');
  if (errors.length) return errors;
  if (polygonArea(poly) === 0) errors.push('polygon has zero area');
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) {
        errors.push(`polygon edges ${i} and ${j} intersect`);
        return errors;
      }
    }
  }
  return errors;
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b) && o(a, b, c) !== 0 && o(c, d, a) !== 0;
}

/** Boolean mask of cells whose centre lies inside the polygon. */
export function rasterizePolygon(g: Grid, poly: Polygon): Uint8Array {
  const mask = new Uint8Array(cellCount(g));
  for (let i = 0; i < mask.length; i++) mask[i] = pointInPolygon(cellCentre(g, i), poly) ? 1 : 0;
  return mask;
}

/**
 * Length of `line` falling inside each cell, in metres. Segments are walked
 * in steps no longer than a quarter cell, so the total over all cells equals
 * the in-grid part of the polyline length to within that step resolution.
 */
export function rasterizePolylineLength(g: Grid, line: Polyline): Float64Array {
  const out = new Float64Array(cellCount(g));
  const step = g.cellSize / 4;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const len = distance(a, b);
    if (len === 0) continue;
    const n = Math.max(1, Math.ceil(len / step));
    const piece = len / n;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const idx = cellIndexAt(g, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      if (idx >= 0) out[idx]! += piece;
    }
  }
  return out;
}

/**
 * Cost-distance (travel effort) from a start point over the grid, using
 * 8-connected Dijkstra. `costMultiplier[i]` scales the cost of crossing cell
 * i relative to flat open ground (1). `Infinity` marks an impassable cell.
 * The result is in "equivalent flat metres"; it is a mobility surface only
 * and says nothing about behaviour.
 */
export function costDistance(g: Grid, start: Point, costMultiplier: ArrayLike<number>): Float64Array {
  const n = cellCount(g);
  if (costMultiplier.length !== n) throw new Error('costMultiplier length must equal cell count');
  const dist = new Float64Array(n).fill(Infinity);
  const s = cellIndexAt(g, start);
  if (s < 0) throw new Error('start point is outside the grid');
  if (!(costMultiplier[s]! < Infinity)) return dist;
  dist[s] = 0;
  const heap = new MinHeap();
  heap.push(0, s);
  const d = g.cellSize;
  const moves: Array<[number, number, number]> = [
    [1, 0, d], [-1, 0, d], [0, 1, d], [0, -1, d],
    [1, 1, d * Math.SQRT2], [1, -1, d * Math.SQRT2], [-1, 1, d * Math.SQRT2], [-1, -1, d * Math.SQRT2],
  ];
  while (heap.size) {
    const [cd, i] = heap.pop();
    if (cd > dist[i]!) continue;
    const col = i % g.cols;
    const row = (i - col) / g.cols;
    for (const [dc, dr, len] of moves) {
      const c2 = col + dc;
      const r2 = row + dr;
      if (c2 < 0 || r2 < 0 || c2 >= g.cols || r2 >= g.rows) continue;
      const j = r2 * g.cols + c2;
      const m = costMultiplier[j]!;
      if (!(m < Infinity) || !(m >= 0)) continue;
      const nd = cd + (len * (costMultiplier[i]! + m)) / 2;
      if (nd < dist[j]!) {
        dist[j] = nd;
        heap.push(nd, j);
      }
    }
  }
  return dist;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(k: number, v: number) {
    this.keys.push(k);
    this.vals.push(v);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= k) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.keys[0]!, this.vals[0]!];
    const lk = this.keys.pop()!;
    const lv = this.vals.pop()!;
    if (this.keys.length) {
      this.keys[0] = lk;
      this.vals[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[m]!) m = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.vals[a], this.vals[b]] = [this.vals[b]!, this.vals[a]!];
  }
}
