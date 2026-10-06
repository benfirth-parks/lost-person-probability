import {
  cellArea,
  cellCount,
  distance,
  distanceToPolyline,
  pointInPolygon,
  rasterizePolygon,
  rasterizePolylineLength,
  type Grid,
  type Point,
  type Polygon,
} from '../../geospatial/src/grid.ts';
import { hashValue } from '../../domain/src/hash.ts';

/**
 * POD estimators. Each is versioned and states its search-theory assumptions;
 * none is a universal formula.
 */
export const POD_MODELS = {
  'exponential-sweep-width@1': {
    description:
      'Random-search (exponential) detection function: POD = 1 − exp(−C), where coverage C = W·L / A ' +
      '(effective sweep width × track length within the area ÷ area). Assumes randomly distributed effort ' +
      'within each cell and a stationary subject; conservative relative to an ideal parallel sweep.',
  },
} as const;

export type PodModelId = keyof typeof POD_MODELS;

export function exponentialPod(coverage: number): number {
  if (!(coverage >= 0)) throw new Error('coverage must be non-negative');
  return 1 - Math.exp(-coverage);
}

export interface SweepWidthInput {
  readonly grid: Grid;
  /** Effective sweep width (m) for this resource, search object, terrain and visibility. */
  readonly sweepWidthM: number;
  /** Provenance of the sweep width: table, version, conditions. */
  readonly sweepWidthSource: string;
}

export interface PodSurface {
  readonly model: PodModelId;
  readonly status: 'planned' | 'achieved';
  /** Conditional POD per cell. */
  readonly pod: Float64Array;
  /** Coverage per cell. */
  readonly coverage: Float64Array;
  /** Area-weighted mean POD over the assignment cells. */
  readonly summaryPod: number;
  readonly summaryCoverage: number;
  readonly assignmentCellCount: number;
  readonly inputHash: string;
}

function summarise(pod: Float64Array, coverage: Float64Array, mask: Uint8Array) {
  let n = 0;
  let sp = 0;
  let sc = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    n++;
    sp += pod[i]!;
    sc += coverage[i]!;
  }
  return { summaryPod: n ? sp / n : 0, summaryCoverage: n ? sc / n : 0, assignmentCellCount: n };
}

/**
 * Planned POD: assumes the planned spacing is achieved uniformly across the
 * assignment polygon, so coverage = W / spacing in every assigned cell.
 * This is a plan, never evidence of search.
 */
export function plannedPod(input: SweepWidthInput & { area: Polygon; plannedSpacingM: number }): PodSurface {
  if (!(input.sweepWidthM > 0) || !(input.plannedSpacingM > 0)) throw new Error('sweep width and spacing must be positive');
  const mask = rasterizePolygon(input.grid, input.area);
  const c = input.sweepWidthM / input.plannedSpacingM;
  const coverage = new Float64Array(mask.length);
  const pod = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      coverage[i] = c;
      pod[i] = exponentialPod(c);
    }
  return {
    model: 'exponential-sweep-width@1',
    status: 'planned',
    pod,
    coverage,
    ...summarise(pod, coverage, mask),
    inputHash: hashValue({ ...input, grid: input.grid, kind: 'planned' }),
  };
}

/**
 * Achieved POD from processed GPS tracks: coverage in each cell is
 * W × (track length inside that cell) / cell area. Cells the tracks never
 * entered get POD 0, so an incomplete track cannot claim full coverage.
 * Analysis is clipped to the assignment polygon expanded by `clipBufferM`.
 */
export function achievedPod(input: SweepWidthInput & { area: Polygon; tracks: readonly (readonly Point[])[]; clipBufferM: number }): PodSurface {
  if (!(input.sweepWidthM > 0)) throw new Error('sweep width must be positive');
  const { grid } = input;
  const n = cellCount(grid);
  const a = cellArea(grid);
  const assignment = rasterizePolygon(grid, input.area);
  const length = new Float64Array(n);
  for (const t of input.tracks) {
    const l = rasterizePolylineLength(grid, t);
    for (let i = 0; i < n; i++) length[i]! += l[i]!;
  }
  const coverage = new Float64Array(n);
  const pod = new Float64Array(n);
  const ring = [...input.area, input.area[0]!];
  for (let i = 0; i < n; i++) {
    if (length[i] === 0) continue;
    if (!assignment[i]) {
      const col = i % grid.cols;
      const row = Math.floor(i / grid.cols);
      const c = { x: grid.originX + (col + 0.5) * grid.cellSize, y: grid.originY + (row + 0.5) * grid.cellSize };
      if (!(pointInPolygon(c, input.area) || distanceToPolyline(c, ring) <= input.clipBufferM)) continue;
    }
    coverage[i] = (input.sweepWidthM * length[i]!) / a;
    pod[i] = exponentialPod(coverage[i]!);
  }
  return {
    model: 'exponential-sweep-width@1',
    status: 'achieved',
    pod,
    coverage,
    ...summarise(pod, coverage, assignment),
    inputHash: hashValue({ area: input.area, tracks: input.tracks, w: input.sweepWidthM, src: input.sweepWidthSource, buf: input.clipBufferM, kind: 'achieved' }),
  };
}

/** Combines several POD surfaces cell by cell under independence (dependence 0) or a stated dependence. */
export function combinePodSurfaces(surfaces: readonly Float64Array[], dependence = 0): Float64Array {
  if (surfaces.length === 0) throw new Error('no surfaces');
  const n = surfaces[0]!.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let indep = 1;
    let max = 0;
    for (const s of surfaces) {
      indep *= 1 - s[i]!;
      max = Math.max(max, s[i]!);
    }
    const ind = 1 - indep;
    out[i] = ind - dependence * (ind - max);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Track processing
// ---------------------------------------------------------------------------

export interface TrackPoint extends Point {
  /** Epoch milliseconds. */
  readonly t: number;
}

export interface TrackReport {
  readonly ordered: boolean;
  readonly lengthM: number;
  readonly durationS: number;
  readonly gaps: ReadonlyArray<{ fromIndex: number; seconds: number }>;
  readonly impossibleJumps: readonly number[];
  readonly quality: 'good' | 'gappy' | 'suspect';
  readonly fingerprint: string;
}

export const TRACK_CLEANING_VERSION = 'track-clean@1';

/** Validates a raw track without changing it. */
export function assessTrack(points: readonly TrackPoint[], opts = { maxGapS: 120, maxSpeedMps: 4 }): TrackReport {
  let ordered = true;
  let lengthM = 0;
  const gaps: Array<{ fromIndex: number; seconds: number }> = [];
  const impossibleJumps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dt = (b.t - a.t) / 1000;
    const d = distance(a, b);
    if (dt <= 0) ordered = false;
    if (dt > opts.maxGapS) gaps.push({ fromIndex: i - 1, seconds: dt });
    if (dt > 0 && d / dt > opts.maxSpeedMps) impossibleJumps.push(i);
    lengthM += d;
  }
  const durationS = points.length > 1 ? (points[points.length - 1]!.t - points[0]!.t) / 1000 : 0;
  const quality = !ordered || impossibleJumps.length ? 'suspect' : gaps.length ? 'gappy' : 'good';
  return { ordered, lengthM, durationS, gaps, impossibleJumps, quality, fingerprint: hashValue(points.map((p) => [p.x, p.y, p.t])) };
}

/**
 * Versioned cleaning transformation: drops points that imply an impossible
 * speed from the last kept point. The raw track is preserved by the caller.
 * Gaps are not interpolated; a gap leaves its cells uncovered.
 */
export function cleanTrack(points: readonly TrackPoint[], maxSpeedMps = 4): { version: string; points: TrackPoint[]; removed: number[] } {
  const kept: TrackPoint[] = [];
  const removed: number[] = [];
  points.forEach((p, i) => {
    const last = kept[kept.length - 1];
    if (!last) return kept.push(p);
    const dt = (p.t - last.t) / 1000;
    if (dt <= 0 || distance(last, p) / dt > maxSpeedMps) removed.push(i);
    else kept.push(p);
  });
  return { version: TRACK_CLEANING_VERSION, points: kept, removed };
}

/** Splits a track at gaps so that no straight line is drawn across an unrecorded interval. */
export function splitAtGaps(points: readonly TrackPoint[], maxGapS = 120): TrackPoint[][] {
  const parts: TrackPoint[][] = [];
  let cur: TrackPoint[] = [];
  for (const p of points) {
    const last = cur[cur.length - 1];
    if (last && (p.t - last.t) / 1000 > maxGapS) {
      if (cur.length > 1) parts.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length > 1) parts.push(cur);
  return parts;
}
