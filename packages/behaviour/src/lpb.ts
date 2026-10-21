import type { BehaviourEntry, BehaviourTable, Percentile } from './table.ts';

/**
 * Figures from Robert J. Koester, Lost Person Behavior (dbS Productions, 2008),
 * typed from pages of the book that were seen while typing them:
 *
 * - Dementia, pp. 165–166: the chapter the publisher posts at
 *   https://www.dbs-sar.com/LPB/Dementia.pdf, checked 2026-10-07.
 * - Mental Illness (p. 201), Mental Retardation / Intellectual Disability
 *   (p. 208), Mountain Biker (p. 215), Other (p. 222) and Runner (p. 227):
 *   scans of the printed book supplied by the project owner, 2026-10-21.
 *
 * Each row keeps the kilometre and mile values exactly as printed side by side,
 * and the tests check that they agree to within the book's rounding. The
 * generator uses the kilometres.
 *
 * Only distance and dispersion tables are typed; the chapters' find location,
 * scenario, survivability, track offset, mobility and elevation tables are not
 * used by the generator. Columns with fewer than four printed percentiles are
 * left out (e.g. Mental Illness "Dry, All" prints only the median), as is BASE
 * jumper (n = 1, no distances printed).
 *
 * The book covers 41 subject categories. The rest are added by loading their
 * rows from the book (BehaviourTablePanel) or by typing them here from a page
 * that is in front of you, never from memory.
 */
export const LPB_SOURCE = 'Koester, R.J. (2008). Lost Person Behavior. dbS Productions.';

/** The five ecoregion columns used for the terrain picker. */
export const LPB_TERRAINS = ['temperate mountainous', 'temperate flat', 'dry mountainous', 'dry flat', 'urban'] as const;
type Terrain = (typeof LPB_TERRAINS)[number] | 'any';

/** The book's 41 categories, in the publisher's list order, for the category picker. Only some have figures loaded. */
export const LPB_CATEGORIES = [
  'abduction', 'aircraft', 'angler', 'atv', 'autistic', 'camper', 'caver', 'child 1-3', 'child 4-6', 'child 7-9', 'child 10-12',
  'child/youth 13-15', 'climber', 'dementia', 'despondent', 'gatherer', 'hiker', 'horseback rider', 'hunter', 'mental illness',
  'intellectual disability', 'mountain biker', 'other (base jumper)', 'other (extreme sports)', 'other (motorcycle)', 'runner',
  'skier-alpine', 'skier-nordic', 'snowboarder', 'snowshoer', 'substance abuse', 'urban entrapment', 'vehicle (missing vehicle)',
  'vehicle (four-wheel drive)', 'vehicle (abandoned vehicle)', 'water (powered boat)', 'water (non-powered boat)',
  'water (person in water, flat water)', 'water (person in water, current)', 'water (person in water, flood stage)', 'worker',
] as const;

type Four = readonly [number, number, number, number];

/** One printed column of a "Distance (horizontal) from the IPP" table. */
export interface LpbPrintedColumn {
  category: (typeof LPB_CATEGORIES)[number];
  /** The column heading as printed, where it is not simply the terrain's name (e.g. "temperate non-mtn"). */
  column?: string;
  /** The terrains it applies to: an "All" column covers both of its ecoregion's terrains; no ecoregion given means "any". */
  terrains: readonly Terrain[];
  n: number;
  /** 25/50/75/95% as printed, in kilometres and in miles. */
  km: Four;
  mi: Four;
  /** "Dispersion Angle" for this column, when printed. */
  dispersion?: { n: number; deg: Four };
  ref: string;
}

const dist = (chapter: string, page: string) => `${chapter} chapter, "Distance (horizontal) from the IPP" table, p. ${page}.`;

export const LPB_PRINTED: readonly LpbPrintedColumn[] = [
  // Dementia, pp. 165–166. Dispersion is printed for "Temperate" only (n = 11).
  ...([
    ['temperate mountainous', 95, [0.3, 0.8, 1.9, 8.3], [0.2, 0.5, 1.2, 5.1]],
    ['temperate flat', 175, [0.3, 1.0, 2.4, 12.8], [0.2, 0.6, 1.5, 7.9]],
    ['dry mountainous', 14, [1.0, 1.9, 3.1, 6.1], [0.6, 1.2, 1.9, 3.8]],
    ['dry flat', 15, [0.5, 1.6, 3.6, 11.8], [0.3, 1.0, 2.2, 7.3]],
    ['urban', 336, [0.3, 1.1, 3.2, 12.6], [0.2, 0.7, 2.0, 7.8]],
  ] as const).map(([terrain, n, km, mi]) => ({
    category: 'dementia' as const,
    terrains: [terrain],
    n,
    km,
    mi,
    ...(terrain.startsWith('temperate') ? { dispersion: { n: 11, deg: [11, 23, 66, 70] as const } } : {}),
    ref: 'Dementia chapter, "Distance (horizontal) from the IPP" and "Dispersion Angle" tables, pp. 165–166.',
  })),

  // Mental Illness, p. 201. No dispersion table. "Dry, All" (n = 8) prints only the median (1.0 km), so it is not loaded.
  { category: 'mental illness', terrains: ['temperate mountainous'], n: 23, km: [0.6, 2.3, 8.3, 14.6], mi: [0.4, 1.4, 5.1, 9.0], ref: dist('Mental Illness', '201') },
  { category: 'mental illness', column: 'temperate non-mtn', terrains: ['temperate flat'], n: 23, km: [0.8, 1.0, 2.3, 8.1], mi: [0.5, 0.6, 1.4, 5.0], ref: dist('Mental Illness', '201') },
  { category: 'mental illness', terrains: ['urban'], n: 38, km: [0.3, 0.6, 1.5, 12.5], mi: [0.2, 0.4, 0.9, 7.7], ref: dist('Mental Illness', '201') },

  // Mental Retardation (Intellectual Disability), p. 208. No dispersion table. The urban 95% is printed as 6.14 mi.
  { category: 'intellectual disability', terrains: ['temperate mountainous'], n: 31, km: [0.6, 1.6, 3.2, 11.3], mi: [0.4, 1.0, 2.0, 7.0], ref: dist('Mental Retardation (Intellectual Disability)', '208') },
  { category: 'intellectual disability', terrains: ['temperate flat'], n: 36, km: [0.3, 1.0, 2.1, 11.8], mi: [0.2, 0.6, 1.3, 7.3], ref: dist('Mental Retardation (Intellectual Disability)', '208') },
  { category: 'intellectual disability', column: 'dry, all', terrains: ['dry mountainous', 'dry flat'], n: 21, km: [1.1, 4.0, 8.7, 62.6], mi: [0.7, 2.5, 5.4, 38.9], ref: dist('Mental Retardation (Intellectual Disability)', '208') },
  { category: 'intellectual disability', terrains: ['urban'], n: 44, km: [0.3, 0.8, 3.7, 9.9], mi: [0.2, 0.5, 2.3, 6.14], ref: dist('Mental Retardation (Intellectual Disability)', '208') },

  // Mountain Biker, p. 215. Dispersion is printed for "Dry" only (n = 14); the "Temperate" dispersion column is blank.
  { category: 'mountain biker', terrains: ['temperate mountainous'], n: 25, km: [3.1, 4.0, 11.3, 25.0], mi: [1.9, 2.5, 7.0, 15.5], ref: dist('Mountain Biker', '215') },
  {
    category: 'mountain biker', terrains: ['dry mountainous'], n: 32, km: [2.7, 6.4, 13.2, 29.1], mi: [1.7, 4.0, 8.2, 18.1],
    dispersion: { n: 14, deg: [15, 37, 68, 115] },
    ref: 'Mountain Biker chapter, "Distance (horizontal) from the IPP" and "Dispersion Angle" tables, p. 215.',
  },

  // Other, p. 222. No ecoregion is given, so these are "any" rows. No dispersion table.
  { category: 'other (extreme sports)', terrains: ['any'], n: 8, km: [0.5, 2.6, 5.7, 13.4], mi: [0.3, 1.6, 3.5, 8.3], ref: dist('Other', '222') },
  // The 95% is printed as 15.0 mi and 24.3 km; 15.0 mi is 24.1 km. The generator uses the printed 24.3 km.
  { category: 'other (motorcycle)', terrains: ['any'], n: 13, km: [6.5, 11.7, 17.5, 24.3], mi: [4.0, 7.2, 10.8, 15.0], ref: dist('Other', '222') },

  // Runner, p. 227. One "Temperate, All" column. No dispersion table.
  { category: 'runner', column: 'temperate, all', terrains: ['temperate mountainous', 'temperate flat'], n: 14, km: [1.4, 2.6, 3.4, 5.8], mi: [0.9, 1.6, 2.1, 3.6], ref: dist('Runner', '227') },
];

const quartiles = (v: Four): Record<Percentile, number> => ({ 25: v[0], 50: v[1], 75: v[2], 95: v[3] });

export const LPB_TABLE: BehaviourTable = {
  name: 'Lost Person Behavior (Koester 2008), checked rows',
  source: LPB_SOURCE,
  kind: 'published',
  entries: LPB_PRINTED.flatMap((c) =>
    c.terrains.map(
      (terrain): BehaviourEntry => ({
        category: c.category,
        terrain,
        n: c.n,
        ringsKm: quartiles(c.km),
        ...(c.dispersion ? { dispersionDeg: quartiles(c.dispersion.deg), dispersionN: c.dispersion.n } : {}),
        ...(c.column ? { column: c.column } : {}),
        ref: c.ref,
      }),
    ),
  ),
};
