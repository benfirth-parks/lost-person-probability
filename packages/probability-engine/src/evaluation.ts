import { cellArea, cellIndexAt, type Point } from '../../geospatial/src/grid.ts';
import { assertValid, type Distribution } from './distribution.ts';

/** Anything with a planner-availability time, e.g. a clue, track, or route. */
export interface TimedItem {
  readonly id: string;
  /** ISO time the information became available to planners. */
  readonly availableAt: string;
}

/**
 * Retrospective inputs are filtered by when planners had the information,
 * not by when it was observed.
 */
export function filterAvailable<T extends TimedItem>(items: readonly T[], cutoffIso: string): T[] {
  const cutoff = Date.parse(cutoffIso);
  if (Number.isNaN(cutoff)) throw new Error('invalid cutoff');
  return items.filter((it) => {
    const t = Date.parse(it.availableAt);
    if (Number.isNaN(t)) throw new Error(`item ${it.id} has an invalid availableAt`);
    return t <= cutoff;
  });
}

const OUTCOME_KEYS = /^(found|find|outcome|recovered|located_at|find_location|found_location|subject_found)/i;

/**
 * Leakage check on an allowed-information package: every timed item must be
 * available by the cutoff, and no key may carry outcome information.
 */
export function leakageCheck(pkg: { cutoff: string; items: readonly TimedItem[]; payload: unknown }): string[] {
  const problems: string[] = [];
  const cutoff = Date.parse(pkg.cutoff);
  for (const it of pkg.items) if (Date.parse(it.availableAt) > cutoff) problems.push(`item ${it.id} became available after the cutoff`);
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (OUTCOME_KEYS.test(k)) problems.push(`outcome-like field "${path}.${k}" present in package`);
        walk(x, `${path}.${k}`);
      }
  };
  walk(pkg.payload, '$');
  return problems;
}

export interface CaseMetrics {
  readonly findOutsideDomain: boolean;
  /** Probability assigned to the find cell (or to outside-domain). */
  readonly findProbability: number;
  /** Probability per km² at the find cell; null when outside. */
  readonly findDensityPerKm2: number | null;
  /** Share of domain cells with strictly higher density than the find cell, ties counted half (0 = best). */
  readonly rankPercentile: number | null;
  /** Fraction of the domain area that must be searched, highest density first, to reach the find cell. */
  readonly areaFractionToCapture: number | null;
  /** In-domain probability contained in the top 10/25/50 % of area by density. */
  readonly topAreaProbability: { readonly p10: number; readonly p25: number; readonly p50: number };
  /** ln(max(findProbability, floor)). */
  readonly logScore: number;
  readonly logScoreFloor: number;
}

export const LOG_SCORE_FLOOR = 1e-9;

export function caseMetrics(d: Distribution, find: Point, floor = LOG_SCORE_FLOOR): CaseMetrics {
  assertValid(d);
  const n = d.values.length;
  const sorted = Float64Array.from(d.values).sort().reverse();
  const top = (frac: number) => {
    const k = Math.max(1, Math.round(n * frac));
    let s = 0;
    for (let i = 0; i < k; i++) s += sorted[i]!;
    return s;
  };
  const topAreaProbability = { p10: top(0.1), p25: top(0.25), p50: top(0.5) };
  const idx = cellIndexAt(d.grid, find);
  if (idx < 0) {
    return {
      findOutsideDomain: true,
      findProbability: d.outside,
      findDensityPerKm2: null,
      rankPercentile: null,
      areaFractionToCapture: null,
      topAreaProbability,
      logScore: Math.log(Math.max(d.outside, floor)),
      logScoreFloor: floor,
    };
  }
  const p = d.values[idx]!;
  let higher = 0;
  let ties = 0;
  for (let i = 0; i < n; i++) {
    if (d.values[i]! > p) higher++;
    else if (d.values[i] === p) ties++;
  }
  return {
    findOutsideDomain: false,
    findProbability: p,
    findDensityPerKm2: (p / cellArea(d.grid)) * 1e6,
    rankPercentile: (higher + (ties - 1) / 2) / n,
    areaFractionToCapture: (higher + ties) / n,
    topAreaProbability,
    logScore: Math.log(Math.max(p, floor)),
    logScoreFloor: floor,
  };
}

export type EvaluationStatus = 'open' | 'locked' | 'revealed';

/**
 * Locked evaluation run. The find location is never stored here before
 * reveal: it is fetched through `outcomeProvider`, which is only invoked
 * after the run is locked.
 */
export class EvaluationRun {
  private _status: EvaluationStatus = 'open';
  private _locked: { surfaceId: string; candidate: Distribution; baselines: Record<string, Distribution>; lockedBy: string; lockedAt: string; inputHashes: Record<string, string> } | null = null;
  private _results: { candidate: CaseMetrics; baselines: Record<string, CaseMetrics> } | null = null;

  constructor(
    readonly incidentId: string,
    readonly informationCutoff: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get status(): EvaluationStatus {
    return this._status;
  }

  lock(args: { surfaceId: string; candidate: Distribution; baselines: Record<string, Distribution>; lockedBy: string; inputHashes: Record<string, string> }) {
    if (this._status !== 'open') throw new Error('run is already locked');
    assertValid(args.candidate);
    for (const b of Object.values(args.baselines)) assertValid(b);
    this._locked = { ...args, lockedAt: this.now() };
    this._status = 'locked';
    return { lockedAt: this._locked.lockedAt };
  }

  reveal(outcomeProvider: () => Point, revealedBy: { userId: string; role: string }) {
    if (this._status !== 'locked' || !this._locked) throw new Error('outcome cannot be revealed before the run is locked');
    if (!['evaluator', 'administrator', 'instructor'].includes(revealedBy.role)) throw new Error(`role ${revealedBy.role} may not reveal outcomes`);
    const find = outcomeProvider();
    const baselines: Record<string, CaseMetrics> = {};
    for (const [k, b] of Object.entries(this._locked.baselines)) baselines[k] = caseMetrics(b, find);
    this._results = { candidate: caseMetrics(this._locked.candidate, find), baselines };
    this._status = 'revealed';
    return { find, ...this._results, revealedAt: this.now(), revealedBy: revealedBy.userId };
  }
}
