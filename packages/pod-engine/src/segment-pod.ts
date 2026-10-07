import { z } from 'zod';
import { exponentialPod } from './pod.ts';

/**
 * Planned POD for a search segment from a sweep-width table.
 *
 * Coverage is planned, not achieved: C = W / S, the effective sweep width over
 * the planned spacing between searchers (or between flight lines), assuming
 * that spacing is held across the whole segment. POD = 1 − exp(−C) (the
 * random-search detection function, see POD_MODELS). Nothing here says what a
 * team actually covered; that comes from tracks after the search.
 *
 * CalTopo assignments carry three PODs (responsive subject, unresponsive
 * subject, clues), each LOW, MEDIUM or HIGH, so there is one sweep width per
 * search object and the result is binned with thresholds the planner can see.
 */
export const SEGMENT_POD_VERSION = 'segment-pod@0.1.0';

/** CalTopo resource types seen in the BYK maps. */
export const RESOURCES = ['GROUND', 'DOG_TRAIL', 'AIR'] as const;
export type Resource = (typeof RESOURCES)[number];
export const RESOURCE_LABELS: Record<Resource, string> = { GROUND: 'Ground team', DOG_TRAIL: 'Dog team', AIR: 'Air (helicopter)' };

export const VEGETATION = ['open', 'light', 'moderate', 'dense'] as const;
export type Vegetation = (typeof VEGETATION)[number];

export const SLOPES = ['gentle', 'steep'] as const;
export type Slope = (typeof SLOPES)[number];

export const SEARCH_OBJECTS = ['responsive', 'unresponsive', 'clue'] as const;
export type SearchObject = (typeof SEARCH_OBJECTS)[number];

const Widths = z.object({ responsive: z.number().positive(), unresponsive: z.number().positive(), clue: z.number().positive() }).strict();

export const SweepWidthEntry = z
  .object({
    resource: z.enum(RESOURCES),
    vegetation: z.enum(VEGETATION),
    /** "any" matches both slopes. */
    slope: z.enum([...SLOPES, 'any']),
    /** Effective sweep width in metres, per search object. */
    widthM: Widths,
  })
  .strict();
export type SweepWidthEntry = z.infer<typeof SweepWidthEntry>;

export const SweepWidthTable = z
  .object({
    name: z.string().trim().min(1).max(80),
    source: z.string().trim().min(1).max(300),
    kind: z.enum(['exercise', 'published', 'agency']),
    entries: z.array(SweepWidthEntry).min(1),
  })
  .strict();
export type SweepWidthTable = z.infer<typeof SweepWidthTable>;

/**
 * Invented round numbers for training, chosen only so that denser vegetation,
 * unresponsive subjects and clues give narrower widths. Not research data.
 */
export const EXERCISE_SWEEP_TABLE: SweepWidthTable = {
  name: 'EXERCISE SWEEP WIDTHS',
  source: 'Invented round numbers for training. Not research data; do not use on a real search.',
  kind: 'exercise',
  entries: [
    ...row('GROUND', [60, 40, 20, 10]),
    ...row('DOG_TRAIL', [100, 80, 60, 40]),
    ...row('AIR', [200, 100, 40, 10]),
  ],
};

function row(resource: Resource, responsive: [number, number, number, number]): SweepWidthEntry[] {
  return VEGETATION.map((vegetation, i) => ({
    resource,
    vegetation,
    slope: 'any' as const,
    widthM: { responsive: responsive[i]!, unresponsive: responsive[i]! / 2, clue: responsive[i]! / 4 },
  }));
}

/** The row for a resource, vegetation and slope, falling back to the "any" slope row. */
export function lookupSweepWidth(table: SweepWidthTable, resource: Resource, vegetation: Vegetation, slope: Slope): SweepWidthEntry | null {
  const match = (s: SweepWidthEntry['slope']) => table.entries.find((e) => e.resource === resource && e.vegetation === vegetation && e.slope === s);
  return match(slope) ?? match('any') ?? null;
}

export type PodClass = 'LOW' | 'MEDIUM' | 'HIGH';

/** Bin edges for CalTopo's LOW / MEDIUM / HIGH. This tool's default, shown to the planner, not a standard. */
export const DEFAULT_POD_BINS = { medium: 0.4, high: 0.7 } as const;

export function podClass(pod: number, bins: { medium: number; high: number } = DEFAULT_POD_BINS): PodClass {
  if (!(bins.medium > 0 && bins.high > bins.medium && bins.high < 1)) throw new Error('POD bins must satisfy 0 < medium < high < 1');
  return pod >= bins.high ? 'HIGH' : pod >= bins.medium ? 'MEDIUM' : 'LOW';
}

export interface SegmentPlan {
  resource: Resource;
  vegetation: Vegetation;
  slope: Slope;
  /** Planned spacing between searchers, or between flight lines, in metres. */
  spacingM: number;
}

export interface SegmentPod {
  status: 'planned';
  widthM: Record<SearchObject, number>;
  coverage: Record<SearchObject, number>;
  pod: Record<SearchObject, number>;
  podClass: Record<SearchObject, PodClass>;
}

/** Planned POD per search object. Null when the table has no row for the plan. */
export function plannedSegmentPod(table: SweepWidthTable, plan: SegmentPlan, bins: { medium: number; high: number } = DEFAULT_POD_BINS): SegmentPod | null {
  if (!(plan.spacingM > 0)) throw new Error('spacing must be positive');
  const e = lookupSweepWidth(table, plan.resource, plan.vegetation, plan.slope);
  if (!e) return null;
  const per = <T>(f: (o: SearchObject) => T) => Object.fromEntries(SEARCH_OBJECTS.map((o) => [o, f(o)])) as Record<SearchObject, T>;
  const coverage = per((o) => e.widthM[o] / plan.spacingM);
  const pod = per((o) => exponentialPod(coverage[o]));
  return { status: 'planned', widthM: per((o) => e.widthM[o]), coverage, pod, podClass: per((o) => podClass(pod[o], bins)) };
}
