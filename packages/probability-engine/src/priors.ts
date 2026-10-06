import {
  cellArea,
  cellCentre,
  cellCount,
  distance,
  distanceToPolyline,
  type Grid,
  type Point,
  type Polyline,
} from '../../geospatial/src/grid.ts';
import { assertValid, normalize, sumValues, type Distribution, PROBABILITY_TOLERANCE } from './distribution.ts';

/**
 * Optional mask of cells that may hold probability (1) or may not (0), for
 * example open water or mapped impassable terrain. Masking is an explicit,
 * recorded modelling choice; it is never applied implicitly.
 */
export type CellMask = ArrayLike<number>;

function checkOutside(p: number) {
  if (!Number.isFinite(p) || p < 0 || p >= 1) throw new Error(`outside-domain probability must be in [0, 1), got ${p}`);
}

function checkMask(grid: Grid, mask: CellMask | undefined) {
  if (mask && mask.length !== cellCount(grid)) throw new Error('mask length must equal cell count');
}

/** Baseline A: equal probability per unit area across the domain. */
export function uniformPrior(grid: Grid, outsideProbability: number, mask?: CellMask): Distribution {
  checkOutside(outsideProbability);
  checkMask(grid, mask);
  const n = cellCount(grid);
  const masses = new Float64Array(n);
  for (let i = 0; i < n; i++) masses[i] = mask && !mask[i] ? 0 : 1;
  const inside = sumValues(masses);
  if (inside === 0) throw new Error('mask excludes every cell');
  for (let i = 0; i < n; i++) masses[i] = (masses[i]! / inside) * (1 - outsideProbability);
  return normalize(grid, masses, outsideProbability).distribution;
}

/**
 * Cumulative distance table for one subject category, e.g. the distances
 * from the planning point within which 25/50/75/95 % of historical subjects
 * were found. Values must come from an approved source; the engine records
 * the provenance but never supplies numbers of its own.
 */
export interface DistanceRingTable {
  readonly id: string;
  readonly version: string;
  readonly subjectCategory: string;
  readonly source: string;
  readonly sampleSize: number | null;
  readonly region: string | null;
  readonly period: string | null;
  /** 'approved_research' for sourced tables; anything else is shown as unapproved. */
  readonly status: 'draft' | 'approved_research' | 'exercise_only' | 'retired';
  /** Strictly increasing distances (m) with non-decreasing cumulative probabilities in (0, 1]. */
  readonly breaks: ReadonlyArray<{ readonly distanceM: number; readonly cumulativeProbability: number }>;
  /**
   * Outer radius (m) over which the probability beyond the last break is
   * spread. Required whenever the last cumulative probability is below 1.
   */
  readonly tailOuterDistanceM: number | null;
}

export function validateRingTable(t: DistanceRingTable): string[] {
  const e: string[] = [];
  if (t.breaks.length === 0) e.push('ring table has no breaks');
  let prevD = 0;
  let prevP = 0;
  for (const b of t.breaks) {
    if (!(b.distanceM > prevD)) e.push(`break distances must be strictly increasing (at ${b.distanceM} m)`);
    if (!(b.cumulativeProbability >= prevP) || b.cumulativeProbability > 1) e.push(`cumulative probability must be non-decreasing and ≤ 1 (at ${b.distanceM} m)`);
    prevD = b.distanceM;
    prevP = b.cumulativeProbability;
  }
  if (prevP < 1 - PROBABILITY_TOLERANCE && !(t.tailOuterDistanceM !== null && t.tailOuterDistanceM > prevD))
    e.push('tailOuterDistanceM must exceed the last break when the table does not reach probability 1');
  return e;
}

interface Ring {
  inner: number;
  outer: number;
  probability: number;
}

function ringsFromTable(t: DistanceRingTable): Ring[] {
  const rings: Ring[] = [];
  let inner = 0;
  let prevP = 0;
  for (const b of t.breaks) {
    rings.push({ inner, outer: b.distanceM, probability: b.cumulativeProbability - prevP });
    inner = b.distanceM;
    prevP = b.cumulativeProbability;
  }
  if (prevP < 1 && t.tailOuterDistanceM !== null) rings.push({ inner, outer: t.tailOuterDistanceM, probability: 1 - prevP });
  return rings;
}

/**
 * Deterministic quadrature for an isotropic Gaussian planning-point
 * uncertainty: offsets on a square lattice out to 3σ, weighted by the
 * normal density. Returns a single zero offset when σ is negligible.
 */
export function gaussianOffsets(sigmaM: number, cellSize: number): Array<{ dx: number; dy: number; w: number }> {
  if (!(sigmaM > cellSize / 4)) return [{ dx: 0, dy: 0, w: 1 }];
  const step = 0.75 * sigmaM;
  const out: Array<{ dx: number; dy: number; w: number }> = [];
  for (let i = -4; i <= 4; i++) {
    for (let j = -4; j <= 4; j++) {
      const dx = i * step;
      const dy = j * step;
      const r2 = (dx * dx + dy * dy) / (sigmaM * sigmaM);
      if (r2 > 9) continue;
      out.push({ dx, dy, w: Math.exp(-r2 / 2) });
    }
  }
  const total = out.reduce((s, o) => s + o.w, 0);
  return out.map((o) => ({ ...o, w: o.w / total }));
}

export interface DistanceRingPriorInput {
  readonly grid: Grid;
  readonly planningPoint: Point;
  /** One-sigma horizontal uncertainty of the planning point, metres. */
  readonly planningPointSigmaM: number;
  readonly table: DistanceRingTable;
  readonly mask?: CellMask;
}

/**
 * Baseline B: Euclidean distance rings. Each ring's probability is spread
 * uniformly by area over the annulus. The share of an annulus that falls
 * outside the grid goes to the outside-domain component, so a small domain
 * visibly reserves more outside probability rather than hiding it.
 * Masked cells hold no probability; their share of the ring is spread over
 * the ring's remaining cells.
 */
export function distanceRingPrior(input: DistanceRingPriorInput): Distribution {
  const { grid, planningPoint, table, mask } = input;
  const errors = validateRingTable(table);
  if (errors.length) throw new Error(errors.join('; '));
  checkMask(grid, mask);
  const rings = ringsFromTable(table);
  const n = cellCount(grid);
  const a = cellArea(grid);
  const masses = new Float64Array(n);
  const ringOf = new Int32Array(n);
  for (const off of gaussianOffsets(input.planningPointSigmaM, grid.cellSize)) {
    const p = { x: planningPoint.x + off.dx, y: planningPoint.y + off.dy };
    const valid = new Float64Array(rings.length);
    const masked = new Float64Array(rings.length);
    for (let i = 0; i < n; i++) {
      const d = distance(cellCentre(grid, i), p);
      let k = rings.findIndex((r) => d < r.outer);
      ringOf[i] = k;
      if (k < 0) continue;
      if (mask && !mask[i]) masked[k]!++;
      else valid[k]!++;
    }
    const perCell = rings.map((r, k) => {
      if (valid[k] === 0) return 0;
      const annulus = Math.PI * (r.outer * r.outer - r.inner * r.inner);
      const usable = Math.max(annulus - masked[k]! * a, valid[k]! * a);
      return (r.probability * Math.min(1 / valid[k]!, a / usable));
    });
    for (let i = 0; i < n; i++) {
      const k = ringOf[i]!;
      if (k < 0 || (mask && !mask[i])) continue;
      masses[i]! += off.w * perCell[k]!;
    }
  }
  const inside = sumValues(masses);
  return normalize(grid, masses, Math.max(0, 1 - inside)).distribution;
}

export interface RouteCorridorInput {
  readonly grid: Grid;
  readonly route: Polyline;
  /** Cells farther than this from the route get no corridor probability. */
  readonly bufferM: number;
  /** e-folding distance for the decay of weight away from the route. */
  readonly decayLengthM: number;
  readonly outsideProbability: number;
  readonly mask?: CellMask;
}

/** Probability concentrated near a route line, decaying exponentially with distance. */
export function routeCorridor(input: RouteCorridorInput): Distribution {
  const { grid, route, bufferM, decayLengthM, outsideProbability, mask } = input;
  checkOutside(outsideProbability);
  checkMask(grid, mask);
  if (route.length < 2) throw new Error('route needs at least two vertices');
  if (!(bufferM > 0) || !(decayLengthM > 0)) throw new Error('bufferM and decayLengthM must be positive');
  const n = cellCount(grid);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const d = distanceToPolyline(cellCentre(grid, i), route);
    if (d <= bufferM) w[i] = Math.exp(-d / decayLengthM);
  }
  const total = sumValues(w);
  if (total === 0) throw new Error('route corridor does not intersect the domain');
  for (let i = 0; i < n; i++) w[i] = (w[i]! / total) * (1 - outsideProbability);
  return normalize(grid, w, outsideProbability).distribution;
}

/** Maximum route confidence; a route corridor may never consume all probability. */
export const MAX_ROUTE_CONFIDENCE = 0.9;

/**
 * Baseline C: route-weighted prior. A mixture of a route corridor (with
 * weight = route confidence) and a background distribution such as distance
 * rings. Separate route hypotheses belong in separate scenarios.
 */
export function routeWeightedPrior(corridor: Distribution, background: Distribution, routeConfidence: number): Distribution {
  if (!(routeConfidence >= 0 && routeConfidence <= MAX_ROUTE_CONFIDENCE))
    throw new Error(`route confidence must be in [0, ${MAX_ROUTE_CONFIDENCE}]`);
  return mixture([
    { id: 'route-corridor', weight: routeConfidence, distribution: corridor },
    { id: 'background', weight: 1 - routeConfidence, distribution: background },
  ]).distribution;
}

/**
 * Baseline D: terrain-reachable prior. Uniform over cells whose
 * cost-distance from the planning point is within `maxCostDistance`.
 * This is a mobility envelope only; behavioural weighting is kept separate.
 */
export function reachablePrior(grid: Grid, costDistanceField: Float64Array, maxCostDistance: number, outsideProbability: number): Distribution {
  checkOutside(outsideProbability);
  if (costDistanceField.length !== cellCount(grid)) throw new Error('cost field length must equal cell count');
  const mask = costDistanceField.map((d) => (d <= maxCostDistance ? 1 : 0));
  return uniformPrior(grid, outsideProbability, mask);
}

export interface MixtureComponent {
  readonly id: string;
  readonly weight: number;
  readonly distribution: Distribution;
}

export interface MixtureResult {
  readonly distribution: Distribution;
  /** Weighted in-domain contribution of each component, by component id. */
  readonly contributions: Readonly<Record<string, Float64Array>>;
  readonly outsideContributions: Readonly<Record<string, number>>;
}

/**
 * Weighted scenario mixture. Weights must be non-negative and sum to one;
 * an "unresolved / other" hypothesis is just another component (often a
 * uniform prior), never an implicit remainder.
 */
export function mixture(components: readonly MixtureComponent[]): MixtureResult {
  if (components.length === 0) throw new Error('mixture needs at least one component');
  const grid = components[0]!.distribution.grid;
  const n = cellCount(grid);
  const ids = new Set<string>();
  let wsum = 0;
  for (const c of components) {
    if (ids.has(c.id)) throw new Error(`duplicate component id ${c.id}`);
    ids.add(c.id);
    if (!(c.weight >= 0) || !Number.isFinite(c.weight)) throw new Error(`weight for ${c.id} must be a finite non-negative number`);
    if (c.distribution.values.length !== n || c.distribution.grid.cellSize !== grid.cellSize) throw new Error(`component ${c.id} is on a different grid`);
    assertValid(c.distribution);
    wsum += c.weight;
  }
  if (Math.abs(wsum - 1) > PROBABILITY_TOLERANCE) throw new Error(`scenario weights sum to ${wsum}, not 1`);
  const masses = new Float64Array(n);
  let outside = 0;
  const contributions: Record<string, Float64Array> = {};
  const outsideContributions: Record<string, number> = {};
  for (const c of components) {
    const part = c.distribution.values.map((v) => v * c.weight);
    for (let i = 0; i < n; i++) masses[i]! += part[i]!;
    contributions[c.id] = part;
    outsideContributions[c.id] = c.weight * c.distribution.outside;
    outside += c.weight * c.distribution.outside;
  }
  return { distribution: normalize(grid, masses, outside).distribution, contributions, outsideContributions };
}
