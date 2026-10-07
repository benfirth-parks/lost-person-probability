import type { BehaviourTable } from './table.ts';

/**
 * Figures from Robert J. Koester, Lost Person Behavior (dbS Productions, 2008),
 * limited to what could be checked against a primary source: the Dementia
 * chapter the publisher posts at https://www.dbs-sar.com/LPB/Dementia.pdf
 * (book pp. 161–169). Each row was compared with the printed table on
 * 2026-10-07; the kilometre and mile versions printed side by side agree to
 * within rounding (see the test).
 *
 * The book covers 41 subject categories. The other 40 are not here because no
 * source copy was available to check them against. They are added by loading
 * their rows from the book (BehaviourTablePanel), never filled from memory.
 */
export const LPB_SOURCE =
  'Koester, R.J. (2008). Lost Person Behavior. dbS Productions. Dementia chapter, "Distance (horizontal) from the IPP" and "Dispersion Angle" tables, pp. 165–166.';

/** The five ecoregion columns, as printed. */
export const LPB_TERRAINS = ['temperate mountainous', 'temperate flat', 'dry mountainous', 'dry flat', 'urban'] as const;

/** The book's 41 categories, in the publisher's list order, for the category picker. Only some have figures loaded. */
export const LPB_CATEGORIES = [
  'abduction', 'aircraft', 'angler', 'atv', 'autistic', 'camper', 'caver', 'child 1-3', 'child 4-6', 'child 7-9', 'child 10-12',
  'child/youth 13-15', 'climber', 'dementia', 'despondent', 'gatherer', 'hiker', 'horseback rider', 'hunter', 'mental illness',
  'intellectual disability', 'mountain biker', 'other (base jumper)', 'other (extreme sports)', 'other (motorcycle)', 'runner',
  'skier-alpine', 'skier-nordic', 'snowboarder', 'snowshoer', 'substance abuse', 'urban entrapment', 'vehicle (missing vehicle)',
  'vehicle (four-wheel drive)', 'vehicle (abandoned vehicle)', 'water (powered boat)', 'water (non-powered boat)',
  'water (person in water, flat water)', 'water (person in water, current)', 'water (person in water, flood stage)', 'worker',
] as const;

/** As printed, in miles, for the consistency check in the tests. Columns follow LPB_TERRAINS. */
export const LPB_DEMENTIA_MILES = {
  n: [95, 175, 14, 15, 336],
  25: [0.2, 0.2, 0.6, 0.3, 0.2],
  50: [0.5, 0.6, 1.2, 1.0, 0.7],
  75: [1.2, 1.5, 1.9, 2.2, 2.0],
  95: [5.1, 7.9, 3.8, 7.3, 7.8],
} as const;

const KM = {
  25: [0.3, 0.3, 1.0, 0.5, 0.3],
  50: [0.8, 1.0, 1.9, 1.6, 1.1],
  75: [1.9, 2.4, 3.1, 3.6, 3.2],
  95: [8.3, 12.8, 6.1, 11.8, 12.6],
} as const;

/** Printed for "Temperate" only (n = 11), so it is attached to the two temperate rows and no others. */
const DEMENTIA_DISPERSION_TEMPERATE = { 25: 11, 50: 23, 75: 66, 95: 70 };

export const LPB_TABLE: BehaviourTable = {
  name: 'Lost Person Behavior (Koester 2008), checked rows',
  source: LPB_SOURCE,
  kind: 'published',
  entries: LPB_TERRAINS.map((terrain, i) => ({
    category: 'dementia',
    terrain,
    n: LPB_DEMENTIA_MILES.n[i]!,
    ringsKm: { 25: KM[25][i]!, 50: KM[50][i]!, 75: KM[75][i]!, 95: KM[95][i]! },
    ...(terrain.startsWith('temperate') ? { dispersionDeg: DEMENTIA_DISPERSION_TEMPERATE, dispersionN: 11 } : {}),
  })),
};
