import { cellCount, type Grid } from '../../geospatial/src/grid.ts';

/** Numerical tolerance for the sum-to-one invariant. Kept in configuration, tested in the suite. */
export const PROBABILITY_TOLERANCE = 1e-10;

/**
 * A full probability distribution over the search domain: one probability
 * per in-domain raster cell plus an explicit outside-domain component.
 * Engine functions never mutate a Distribution they receive.
 */
export interface Distribution {
  readonly grid: Grid;
  /** Probability of area (POA) per cell; not a density. */
  readonly values: Float64Array;
  /** Probability the subject is outside the defined domain. */
  readonly outside: number;
}

export class InvariantError extends Error {
  constructor(readonly violations: string[]) {
    super(`probability invariant violated: ${violations.join('; ')}`);
  }
}

export function sumValues(values: ArrayLike<number>): number {
  // Neumaier summation keeps the sum accurate for many tiny cell values.
  let sum = 0;
  let c = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const t = sum + v;
    c += Math.abs(sum) >= Math.abs(v) ? sum - t + v : v - t + sum;
    sum = t;
  }
  return sum + c;
}

export function checkInvariants(d: Distribution, tolerance = PROBABILITY_TOLERANCE): string[] {
  const errors: string[] = [];
  if (d.values.length !== cellCount(d.grid)) errors.push(`expected ${cellCount(d.grid)} cells, got ${d.values.length}`);
  let bad = 0;
  for (let i = 0; i < d.values.length; i++) {
    const v = d.values[i]!;
    if (!Number.isFinite(v) || v < 0) bad++;
  }
  if (bad) errors.push(`${bad} cell(s) are negative, NaN or infinite`);
  if (!Number.isFinite(d.outside) || d.outside < 0 || d.outside > 1) errors.push(`outside-domain probability ${d.outside} is not in [0, 1]`);
  const total = sumValues(d.values) + d.outside;
  if (!(Math.abs(total - 1) <= tolerance)) errors.push(`probabilities sum to ${total}, not 1 ± ${tolerance}`);
  return errors;
}

export function assertValid(d: Distribution, tolerance = PROBABILITY_TOLERANCE): Distribution {
  const errors = checkInvariants(d, tolerance);
  if (errors.length) throw new InvariantError(errors);
  return d;
}

export interface Normalized {
  readonly distribution: Distribution;
  /** Sum of the unnormalized masses (in-domain plus outside). Stored with every update. */
  readonly normalizationConstant: number;
}

/** Normalizes unnormalized in-domain masses and an outside mass so that they sum to one. */
export function normalize(grid: Grid, masses: Float64Array, outsideMass: number): Normalized {
  for (let i = 0; i < masses.length; i++) {
    const m = masses[i]!;
    if (!Number.isFinite(m) || m < 0) throw new InvariantError([`unnormalized mass at cell ${i} is ${m}`]);
  }
  if (!Number.isFinite(outsideMass) || outsideMass < 0) throw new InvariantError([`outside mass is ${outsideMass}`]);
  const z = sumValues(masses) + outsideMass;
  if (!(z > 0) || !Number.isFinite(z)) throw new InvariantError([`normalization constant is ${z}; the update removed all probability`]);
  const values = new Float64Array(masses.length);
  for (let i = 0; i < masses.length; i++) values[i] = masses[i]! / z;
  const distribution = assertValid({ grid, values, outside: outsideMass / z });
  return { distribution, normalizationConstant: z };
}

/** Probability density (per m²) of each cell. */
export function densities(d: Distribution): Float64Array {
  const a = d.grid.cellSize * d.grid.cellSize;
  return d.values.map((v) => v / a);
}

export function inDomainProbability(d: Distribution): number {
  return sumValues(d.values);
}
