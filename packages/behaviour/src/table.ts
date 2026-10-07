import { z } from 'zod';

/**
 * Lost-person behaviour tables: for each subject category and terrain, the
 * distances from the planning point within which 25, 50, 75 and 95 percent of
 * subjects were found, and optionally the dispersion angles around the
 * direction of travel.
 *
 * The app holds no research values of its own. A table is loaded from a source
 * the user names (a licensed published table, or an agency's own closed cases).
 * The only built-in table is EXERCISE_TABLE, whose values are invented round
 * numbers for training and are labelled as such everywhere they appear.
 */
export const BEHAVIOUR_VERSION = 'behaviour-table@0.1.0';
export const PERCENTILES = [25, 50, 75, 95] as const;
export type Percentile = (typeof PERCENTILES)[number];

const Quartiles = z.object({ 25: z.number().positive(), 50: z.number().positive(), 75: z.number().positive(), 95: z.number().positive() });

const increasing = (q: Record<Percentile, number>) => PERCENTILES.every((p, i) => i === 0 || q[p] > q[PERCENTILES[i - 1]!]);

export const BehaviourEntry = z
  .object({
    category: z.string().trim().toLowerCase().min(1).max(40),
    /** Terrain or ecoregion the row applies to, as the source names it (e.g. "mountainous", "flat"). "any" matches every terrain. */
    terrain: z.string().trim().toLowerCase().min(1).max(40),
    /** Number of cases behind the row, when the source gives it. */
    n: z.number().int().positive().optional(),
    ringsKm: Quartiles.refine(increasing, 'ring distances must increase from 25% to 95%'),
    dispersionDeg: Quartiles.refine(increasing, 'dispersion angles must increase from 25% to 95%')
      .refine((q) => q[95] <= 360, 'a dispersion angle cannot exceed 360°')
      .optional(),
    /** Cases behind the dispersion angles, which the source may count separately from the distances. */
    dispersionN: z.number().int().positive().optional(),
  })
  .strict();
export type BehaviourEntry = z.infer<typeof BehaviourEntry>;

export const BehaviourTable = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** Full citation: author, title, edition, table numbers, or the agency dataset and its date. */
    source: z.string().trim().min(1).max(300),
    kind: z.enum(['exercise', 'published', 'agency']),
    /** Distance units in the source, converted to km on load. */
    entries: z.array(BehaviourEntry).min(1),
  })
  .strict()
  .refine((t) => new Set(t.entries.map((e) => `${e.category}|${e.terrain}`)).size === t.entries.length, 'each category and terrain may appear only once');
export type BehaviourTable = z.infer<typeof BehaviourTable>;

/**
 * Invented values for training. Deliberately round and identical across
 * categories so nobody mistakes them for research data.
 */
export const EXERCISE_TABLE: BehaviourTable = {
  name: 'EXERCISE VALUES',
  source: 'Invented round numbers for training. Not research data; do not use on a real search.',
  kind: 'exercise',
  entries: ['hiker', 'hunter', 'climber', 'skier', 'snowshoer', 'mountain biker', 'angler', 'gatherer', 'runner', 'camper', 'child', 'youth', 'other'].flatMap(
    (category) => [
      { category, terrain: 'mountainous', ringsKm: { 25: 1, 50: 2, 75: 4, 95: 10 }, dispersionDeg: { 25: 30, 50: 60, 75: 90, 95: 150 } },
      { category, terrain: 'flat', ringsKm: { 25: 1, 50: 2, 75: 4, 95: 10 }, dispersionDeg: { 25: 30, 50: 60, 75: 90, 95: 150 } },
    ],
  ),
};

export interface Lookup {
  entry: BehaviourEntry;
  /** True when the row is for "any" terrain rather than the terrain asked for. */
  terrainFallback: boolean;
  /** One line naming the table, row and source, for the ring descriptions in the CalTopo file. */
  citation: string;
}

/** The row for a category and terrain, falling back to the category's "any" row. Null when the table has neither. Percentile rings say where past subjects were found; they are not detection probabilities or boundaries. */
export function lookupBehaviour(table: BehaviourTable, category: string, terrain: string): Lookup | null {
  const c = category.trim().toLowerCase();
  const t = terrain.trim().toLowerCase();
  const exact = table.entries.find((e) => e.category === c && e.terrain === t);
  const entry = exact ?? table.entries.find((e) => e.category === c && e.terrain === 'any');
  if (!entry) return null;
  const n = entry.n ? `, n=${entry.n}` : '';
  const dn = entry.dispersionDeg && entry.dispersionN ? `; dispersion n=${entry.dispersionN}` : '';
  const label = table.kind === 'exercise' ? `${table.name} (exercise values, not research data)` : table.name;
  return { entry, terrainFallback: !exact, citation: `${label}: ${entry.category}, ${entry.terrain}${n}${dn}. Source: ${table.source}` };
}

export const categories = (t: BehaviourTable) => [...new Set(t.entries.map((e) => e.category))];
export const terrains = (t: BehaviourTable, category?: string) =>
  [...new Set(t.entries.filter((e) => !category || e.category === category.toLowerCase()).map((e) => e.terrain))];

/** Column order for the CSV a user fills in from their source. */
export const CSV_HEADER = 'category,terrain,n,ring25,ring50,ring75,ring95,disp25,disp50,disp75,disp95';

export type TableProblem = { line: number; message: string };

/**
 * Reads a table from CSV in CSV_HEADER order. Distances are in `unit` and
 * converted to km. Dispersion columns may be left empty for a row. Returns the
 * table, or every problem found with its line number.
 */
export function parseBehaviourCsv(
  csv: string,
  meta: { name: string; source: string; kind: 'published' | 'agency' },
  unit: 'km' | 'mi' = 'km',
): { ok: true; table: BehaviourTable } | { ok: false; problems: TableProblem[] } {
  const toKm = unit === 'mi' ? 1.609344 : 1;
  const lines = csv.split(/\r?\n/);
  const problems: TableProblem[] = [];
  const entries: unknown[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cells = line.split(',').map((c) => c.trim());
    if (i === 0 && cells[0]!.toLowerCase() === 'category') return;
    if (cells.length < 7) return problems.push({ line: i + 1, message: 'needs at least category, terrain, n and four ring distances' });
    const num = (s: string | undefined) => (s === undefined || s === '' ? undefined : Number(s));
    const [category, terrain, n, r25, r50, r75, r95, d25, d50, d75, d95] = cells;
    const rings = [r25, r50, r75, r95].map((v) => num(v)! * toKm);
    const disp = [d25, d50, d75, d95].map(num);
    if ([...rings, ...disp].some((v) => v !== undefined && Number.isNaN(v))) return problems.push({ line: i + 1, message: 'a number could not be read' });
    if (disp.some((v) => v !== undefined) && disp.some((v) => v === undefined))
      return problems.push({ line: i + 1, message: 'give all four dispersion angles or none' });
    entries.push({
      category,
      terrain: terrain || 'any',
      ...(n ? { n: Number(n) } : {}),
      ringsKm: { 25: round3(rings[0]!), 50: round3(rings[1]!), 75: round3(rings[2]!), 95: round3(rings[3]!) },
      ...(disp[0] !== undefined ? { dispersionDeg: { 25: disp[0], 50: disp[1]!, 75: disp[2]!, 95: disp[3]! } } : {}),
    });
    const row = BehaviourEntry.safeParse(entries[entries.length - 1]);
    if (!row.success) problems.push({ line: i + 1, message: row.error.issues.map((x) => x.message).join('; ') });
  });
  if (problems.length) return { ok: false, problems };
  const table = BehaviourTable.safeParse({ ...meta, entries });
  if (!table.success) return { ok: false, problems: table.error.issues.map((x) => ({ line: 0, message: x.message })) };
  return { ok: true, table: table.data };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
