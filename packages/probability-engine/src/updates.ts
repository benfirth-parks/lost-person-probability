import { cellCentre, cellCount, distance, type Grid, type Point } from '../../geospatial/src/grid.ts';
import { assertValid, normalize, sumValues, type Distribution } from './distribution.ts';

export interface UpdateResult {
  readonly posterior: Distribution;
  readonly normalizationConstant: number;
}

// ---------------------------------------------------------------------------
// Evidence (clue) updates
// ---------------------------------------------------------------------------

export interface LikelihoodField {
  /** Likelihood ratio per cell. */
  readonly lr: Float64Array;
  /** Likelihood ratio for the outside-domain component. */
  readonly lrOutside: number;
}

/** Ratio of the largest to the smallest LR above which a rationale is mandatory. */
export const EXTREME_LR_SPREAD = 100;

export interface LikelihoodSummary {
  readonly min: number;
  readonly max: number;
  readonly spread: number;
  readonly extreme: boolean;
}

export function summarizeLikelihood(f: LikelihoodField): LikelihoodSummary {
  let min = f.lrOutside;
  let max = f.lrOutside;
  for (const v of f.lr) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const spread = min > 0 ? max / min : Infinity;
  return { min, max, spread, extreme: spread > EXTREME_LR_SPREAD };
}

/** posterior_i ∝ prior_i × LR_i, including the outside-domain component. */
export function applyLikelihood(prior: Distribution, f: LikelihoodField): UpdateResult {
  assertValid(prior);
  const n = prior.values.length;
  if (f.lr.length !== n) throw new Error('likelihood field length must equal cell count');
  const check = (v: number, where: string) => {
    if (!Number.isFinite(v) || v < 0) throw new Error(`likelihood ratio at ${where} is ${v}; must be finite and non-negative`);
  };
  check(f.lrOutside, 'outside');
  const masses = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    check(f.lr[i]!, `cell ${i}`);
    masses[i] = prior.values[i]! * f.lr[i]!;
  }
  const { distribution, normalizationConstant } = normalize(prior.grid, masses, prior.outside * f.lrOutside);
  return { posterior: distribution, normalizationConstant };
}

/**
 * Reliability and relevance of a clue are recorded separately. They are
 * combined into the probability that the clue is a true indication of the
 * subject's location under an explicit independence assumption.
 */
export interface ClueCredibility {
  /** Probability that the report or measurement is accurate. */
  readonly reliability: number;
  /** Probability that the report relates to the missing subject. */
  readonly relevance: number;
}

export function combinedCredibility(c: ClueCredibility): number {
  for (const [k, v] of Object.entries(c)) if (!(v >= 0 && v <= 1)) throw new Error(`${k} must be in [0, 1]`);
  return c.reliability * c.relevance;
}

/**
 * Converts a spatial kernel (mass per cell, summing to ≤ 1 over the grid)
 * into likelihood ratios using a two-component model:
 *   P(clue | subject in cell i) = q·f_i + (1 − q)/N
 * relative to the uninformative alternative 1/N, giving
 *   LR_i = (1 − q) + q·N·f_i,   LR_outside = 1 − q.
 * With q = 0 the clue changes nothing; with q < 1 no cell is driven to zero.
 */
export function kernelLikelihood(grid: Grid, kernel: Float64Array, credibility: ClueCredibility): LikelihoodField {
  const q = combinedCredibility(credibility);
  const n = cellCount(grid);
  if (kernel.length !== n) throw new Error('kernel length must equal cell count');
  const ksum = sumValues(kernel);
  if (ksum > 1 + 1e-9) throw new Error('kernel mass exceeds 1');
  const lr = new Float64Array(n);
  for (let i = 0; i < n; i++) lr[i] = 1 - q + q * n * kernel[i]!;
  return { lr, lrOutside: 1 - q };
}

/** Gaussian location kernel (e.g. witness sighting, device fix) with σ in metres. */
export function gaussianKernel(grid: Grid, centre: Point, sigmaM: number): Float64Array {
  if (!(sigmaM > 0)) throw new Error('sigma must be positive');
  const n = cellCount(grid);
  const k = new Float64Array(n);
  const a = grid.cellSize * grid.cellSize;
  const norm = a / (2 * Math.PI * sigmaM * sigmaM);
  for (let i = 0; i < n; i++) {
    const d = distance(cellCentre(grid, i), centre);
    k[i] = norm * Math.exp(-(d * d) / (2 * sigmaM * sigmaM));
  }
  const s = sumValues(k);
  // Mass of the kernel beyond the grid edge is simply not in the domain; only rescale down if cell sampling overshoots.
  if (s > 1) for (let i = 0; i < n; i++) k[i] = k[i]! / s;
  return k;
}

/**
 * Directional kernel: uniform over the wedge from `origin` within
 * `halfAngleDeg` of `bearingDeg` (clockwise from grid north) and `maxRangeM`.
 */
export function wedgeKernel(grid: Grid, origin: Point, bearingDeg: number, halfAngleDeg: number, maxRangeM: number): Float64Array {
  const n = cellCount(grid);
  const k = new Float64Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const c = cellCentre(grid, i);
    const d = distance(c, origin);
    if (d > maxRangeM || d === 0) continue;
    const brg = (Math.atan2(c.x - origin.x, c.y - origin.y) * 180) / Math.PI;
    const diff = Math.abs(((brg - bearingDeg + 540) % 360) - 180);
    if (diff <= halfAngleDeg) {
      k[i] = 1;
      count++;
    }
  }
  if (count === 0) throw new Error('wedge does not cover any cell');
  const wedgeArea = (Math.PI * maxRangeM * maxRangeM * (2 * halfAngleDeg)) / 360;
  const inGrid = Math.min(1, (count * grid.cellSize * grid.cellSize) / wedgeArea);
  for (let i = 0; i < n; i++) k[i] = (k[i]! / count) * inGrid;
  return k;
}

// ---------------------------------------------------------------------------
// Search (no-find) updates
// ---------------------------------------------------------------------------

export interface NoFindOptions {
  /** Permit POD = 1 in some cells. Only for genuinely certain detection. */
  readonly allowCertainDetection?: boolean;
}

/**
 * Unsuccessful-search update: posterior_i ∝ prior_i × (1 − POD_i).
 * Unsearched cells and the outside component have POD 0.
 */
export function noFindUpdate(prior: Distribution, pod: Float64Array, opts: NoFindOptions = {}): UpdateResult {
  assertValid(prior);
  const n = prior.values.length;
  if (pod.length !== n) throw new Error('POD surface length must equal cell count');
  const masses = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = pod[i]!;
    if (!(d >= 0 && d <= 1)) throw new Error(`POD at cell ${i} is ${d}; must be in [0, 1]`);
    if (d === 1 && !opts.allowCertainDetection) throw new Error(`POD of 1 at cell ${i} requires allowCertainDetection`);
    masses[i] = prior.values[i]! * (1 - d);
  }
  const { distribution, normalizationConstant } = normalize(prior.grid, masses, prior.outside);
  return { posterior: distribution, normalizationConstant };
}

/** POS = Σ POA_i × POD_i over the cells covered. */
export function probabilityOfSuccess(d: Distribution, pod: ArrayLike<number>): number {
  if (pod.length !== d.values.length) throw new Error('POD surface length must equal cell count');
  let s = 0;
  for (let i = 0; i < pod.length; i++) s += d.values[i]! * pod[i]!;
  return s;
}

/**
 * Cumulative POD from repeated searches of one cell.
 * dependence = 0 → independent searches: 1 − Π(1 − d_r).
 * dependence = 1 → fully dependent: max(d_r) (later searches add nothing).
 * Intermediate values interpolate linearly; the value used is recorded.
 */
export function cumulativePod(pods: readonly number[], dependence = 0): number {
  if (!(dependence >= 0 && dependence <= 1)) throw new Error('dependence must be in [0, 1]');
  if (pods.length === 0) return 0;
  for (const d of pods) if (!(d >= 0 && d <= 1)) throw new Error('each POD must be in [0, 1]');
  const independent = 1 - pods.reduce((p, d) => p * (1 - d), 1);
  const max = Math.max(...pods);
  return independent - dependence * (independent - max);
}

// ---------------------------------------------------------------------------
// Manual adjustments
// ---------------------------------------------------------------------------

export interface ManualAdjustment {
  /** Multiplicative factor per cell (≥ 0). */
  readonly factors: Float64Array;
  /** Multiplicative factor for the outside component. */
  readonly outsideFactor: number;
  readonly rationale: string;
}

/** Manual weighting with a mandatory rationale. Cannot revive zero-probability cells. */
export function applyManualAdjustment(prior: Distribution, adj: ManualAdjustment): UpdateResult {
  if (adj.rationale.trim().length < 10) throw new Error('manual adjustments require a rationale of at least 10 characters');
  return applyLikelihood(prior, { lr: adj.factors, lrOutside: adj.outsideFactor });
}

/**
 * Sets the outside-domain probability to a new value, rescaling in-domain
 * cells proportionally. Requires a rationale.
 */
export function setOutsideProbability(prior: Distribution, outside: number, rationale: string): UpdateResult {
  if (rationale.trim().length < 10) throw new Error('changing outside-domain probability requires a rationale');
  if (!(outside >= 0 && outside < 1)) throw new Error('outside probability must be in [0, 1)');
  const inside = 1 - prior.outside;
  if (inside <= 0) throw new Error('prior has no in-domain probability to rescale');
  const scale = (1 - outside) / inside;
  const masses = prior.values.map((v) => v * scale);
  const { distribution, normalizationConstant } = normalize(prior.grid, masses, outside);
  return { posterior: distribution, normalizationConstant };
}

// ---------------------------------------------------------------------------
// Transfer reporting
// ---------------------------------------------------------------------------

export interface TransferSummary {
  /** Total probability moved between cells/outside: ½ Σ |posterior − prior|. */
  readonly moved: number;
  readonly outsideChange: number;
  /** Per-zone change, keyed by zone label, when zones are supplied. */
  readonly byZone: Readonly<Record<string, { prior: number; posterior: number; change: number }>>;
}

export function transferSummary(prior: Distribution, posterior: Distribution, zones?: { labels: readonly string[]; zoneOf: ArrayLike<number> }): TransferSummary {
  let moved = Math.abs(posterior.outside - prior.outside);
  const byZone: Record<string, { prior: number; posterior: number; change: number }> = {};
  if (zones) for (const l of zones.labels) byZone[l] = { prior: 0, posterior: 0, change: 0 };
  for (let i = 0; i < prior.values.length; i++) {
    moved += Math.abs(posterior.values[i]! - prior.values[i]!);
    if (zones) {
      const z = zones.zoneOf[i]!;
      const l = zones.labels[z];
      if (l !== undefined) {
        byZone[l]!.prior += prior.values[i]!;
        byZone[l]!.posterior += posterior.values[i]!;
      }
    }
  }
  for (const v of Object.values(byZone)) v.change = v.posterior - v.prior;
  return { moved: moved / 2, outsideChange: posterior.outside - prior.outside, byZone };
}
