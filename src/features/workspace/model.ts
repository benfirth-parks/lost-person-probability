/**
 * Workspace model: the planning operations the map workspace offers, as pure
 * functions over the engine. No React, no DOM. A Preview is never a committed
 * surface; committing goes through the data source.
 */
import {
  achievedPod,
  applyLikelihood,
  assessTrack,
  cleanTrack,
  distanceRingPrior,
  gaussianKernel,
  kernelLikelihood,
  mixture,
  noFindUpdate,
  plannedPod,
  probabilityOfSuccess,
  routeCorridor,
  routeWeightedPrior,
  splitAtGaps,
  summarizeLikelihood,
  sumValues,
  uniformPrior,
  wedgeKernel,
  type Distribution,
  type DistanceRingTable,
  type PodSurface,
} from '../../../packages/probability-engine/src/index.ts';
import {
  grid,
  IPP,
  IPP_SIGMA_M,
  landMask,
  trail,
  zoneOf,
  ZONES,
  type ExerciseAssignment,
  type ExerciseClue,
} from '../../../packages/exercises/alpine-ex-01.ts';

export type PreviewKind = 'prior' | 'clue_update' | 'search_update';

export interface Preview {
  kind: PreviewKind;
  title: string;
  prior: Distribution | null;
  posterior: Distribution;
  normalizationConstant: number;
  inputs: unknown;
  provenance: Record<string, unknown>;
  extreme: boolean;
  sensitivity?: { label: string; dist: Distribution }[];
  pod?: Float64Array;
  notes: string[];
  evidenceId?: string;
}

export interface Scenario {
  id: string;
  name: string;
  weight: number;
  describe: string;
}

export interface PriorConfig {
  scenarios: Scenario[];
  rings: DistanceRingTable;
  routeConfidence: number;
}

export const DEFAULT_SCENARIOS: Scenario[] = [
  { id: 'S1', name: 'Stayed on the trail toward the lake', weight: 0.45, describe: 'Route corridor along the trail mixed with distance rings.' },
  { id: 'S2', name: 'Left the trail and wandered', weight: 0.4, describe: 'Distance rings from the trailhead, open water excluded.' },
  { id: 'S3', name: 'Unresolved or other', weight: 0.15, describe: 'Uniform over the domain with 30 % reserved outside it.' },
];

export const ringsPrior = (rings: DistanceRingTable) =>
  distanceRingPrior({ grid, planningPoint: IPP, planningPointSigmaM: IPP_SIGMA_M, table: rings, mask: landMask });
export const uniformBaseline = () => uniformPrior(grid, 0.3, landMask);

export function weightsValid(scenarios: Scenario[]): boolean {
  return Math.abs(scenarios.reduce((s, x) => s + x.weight, 0) - 1) < 1e-9;
}

export function buildPrior(cfg: PriorConfig): Preview {
  const ringDist = ringsPrior(cfg.rings);
  const corridor = routeCorridor({ grid, route: trail, bufferM: 300, decayLengthM: 120, outsideProbability: 0.02, mask: landMask });
  const byId: Record<string, Distribution> = {
    S1: routeWeightedPrior(corridor, ringDist, cfg.routeConfidence),
    S2: ringDist,
    S3: uniformBaseline(),
  };
  const m = mixture(cfg.scenarios.map((s) => ({ id: s.id, weight: s.weight, distribution: byId[s.id]! })));
  const scenarioMass: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.contributions)) scenarioMass[k] = sumValues(v) + m.outsideContributions[k]!;
  return {
    kind: 'prior',
    title: 'Scenario-mixture prior',
    prior: null,
    posterior: m.distribution,
    normalizationConstant: 1,
    inputs: { scenarios: cfg.scenarios, rings: cfg.rings, routeConfidence: cfg.routeConfidence, ipp: IPP, ippSigma: IPP_SIGMA_M, mask: 'open-water' },
    provenance: { method: 'scenario-mixture', scenarioMass, ringTable: `${cfg.rings.id}@${cfg.rings.version} (${cfg.rings.status})` },
    extreme: false,
    notes: [
      `Distance-ring table ${cfg.rings.id}@${cfg.rings.version} is marked ${cfg.rings.status.replace('_', ' ')}.`,
      'Open-water cells hold no probability; their share of each ring is spread over the ring’s land cells.',
    ],
  };
}

function clueLikelihood(c: ExerciseClue, reliability: number, relevance: number, sigma?: number) {
  const kernel =
    c.template === 'point'
      ? gaussianKernel(grid, c.location, sigma ?? c.sigmaM!)
      : wedgeKernel(grid, c.location, c.bearingDeg!, c.halfAngleDeg!, c.rangeM!);
  return kernelLikelihood(grid, kernel, { reliability, relevance });
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function previewClue(prior: Distribution, c: ExerciseClue, reliability: number, relevance: number, sigma?: number): Preview {
  const f = clueLikelihood(c, reliability, relevance, sigma);
  const s = summarizeLikelihood(f);
  const r = applyLikelihood(prior, f);
  const shifted = (d: number) => applyLikelihood(prior, clueLikelihood(c, clamp01(reliability + d), clamp01(relevance + d), sigma)).posterior;
  return {
    kind: 'clue_update',
    title: `${c.id} ${c.type}`,
    prior,
    posterior: r.posterior,
    normalizationConstant: r.normalizationConstant,
    inputs: { clue: c.id, template: c.template, reliability, relevance, sigma: sigma ?? c.sigmaM ?? null },
    provenance: { evidence: c.id, method: `kernel-likelihood/${c.template}@1`, reliability, relevance, lrMin: s.min, lrMax: s.max },
    extreme: s.extreme,
    sensitivity: [
      { label: 'Low', dist: shifted(-0.2) },
      { label: 'Central', dist: r.posterior },
      { label: 'High', dist: shifted(0.2) },
    ],
    evidenceId: c.id,
    notes: [
      `Likelihood ratios range from ${s.min.toFixed(2)} to ${s.max.toFixed(1)} (outside domain ${f.lrOutside.toFixed(2)}).`,
      `Credibility q = reliability × relevance = ${(reliability * relevance).toFixed(2)}, assuming the two are independent.`,
      ...(s.extreme ? ['These ratios are extreme. The rationale must explain why.'] : []),
    ],
  };
}

export interface AssignmentPod {
  planned: PodSurface;
  achieved: PodSurface;
  quality: string;
  gaps: number;
}

export function podFor(a: ExerciseAssignment, sweepWidthM: number): AssignmentPod {
  const planned = plannedPod({ grid, area: a.area, sweepWidthM, sweepWidthSource: 'exercise value', plannedSpacingM: a.plannedSpacingM });
  const report = assessTrack(a.track);
  const parts = splitAtGaps(cleanTrack(a.track).points);
  const achieved = achievedPod({ grid, area: a.area, sweepWidthM, sweepWidthSource: 'exercise value', tracks: parts, clipBufferM: 50 });
  return { planned, achieved, quality: report.quality, gaps: report.gaps.length };
}

export function previewSearch(prior: Distribution, a: ExerciseAssignment, sweepWidthM: number): Preview {
  const { achieved } = podFor(a, sweepWidthM);
  const r = noFindUpdate(prior, achieved.pod);
  const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
  return {
    kind: 'search_update',
    title: `${a.id} no-find update`,
    prior,
    posterior: r.posterior,
    normalizationConstant: r.normalizationConstant,
    inputs: { assignment: a.id, sweepWidthM, podInputHash: achieved.inputHash },
    provenance: { evidence: a.id, method: 'no-find/exponential-sweep-width@1', achievedSummaryPod: achieved.summaryPod, sweepWidthM },
    extreme: false,
    pod: achieved.pod,
    evidenceId: a.id,
    notes: [
      `Achieved POD from the GPS track: ${pct(achieved.summaryPod)} averaged over the assignment. Cells the track never reached keep POD 0.`,
      `POS of this search on the current surface: ${pct(probabilityOfSuccess(prior, achieved.pod), 2)}.`,
      'Searched cells keep probability in proportion to 1 − POD. Nothing is set to zero.',
    ],
  };
}

/** Probability per zone plus outside-domain. */
export function zoneSums(d: Distribution): { zones: { name: string; p: number }[]; outside: number } {
  const z = new Float64Array(ZONES.length);
  d.values.forEach((v, i) => (z[zoneOf[i]!]! += v));
  return { zones: ZONES.map((name, i) => ({ name, p: z[i]! })), outside: d.outside };
}

/** Smallest set of cells (highest probability first) holding `level` of all probability; empty if in-domain mass is too small. */
export function hpdMask(d: Distribution, level: number): Uint8Array {
  const idx = Array.from(d.values.keys()).sort((a, b) => d.values[b]! - d.values[a]!);
  const m = new Uint8Array(d.values.length);
  let acc = 0;
  for (const i of idx) {
    if (acc >= level) break;
    m[i] = 1;
    acc += d.values[i]!;
  }
  return acc >= level ? m : new Uint8Array(0);
}
