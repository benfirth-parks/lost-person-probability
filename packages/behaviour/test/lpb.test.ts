import { describe, expect, it } from 'vitest';
import { BehaviourTable, LPB_DEMENTIA_MILES, LPB_TABLE, LPB_TERRAINS, PERCENTILES, lookupBehaviour } from '../src/index.ts';

describe('Lost Person Behavior rows', () => {
  it('is a valid table holding only the checked dementia rows', () => {
    expect(BehaviourTable.safeParse(LPB_TABLE).success).toBe(true);
    expect(new Set(LPB_TABLE.entries.map((e) => e.category))).toEqual(new Set(['dementia']));
    expect(LPB_TABLE.entries.map((e) => e.terrain)).toEqual([...LPB_TERRAINS]);
  });

  it('kilometres agree with the miles printed beside them, to within the book\'s rounding', () => {
    // Each printed value is rounded to 0.1, so the two can differ by up to 0.05 mi × 1.609 + 0.05 km ≈ 0.13 km.
    LPB_TABLE.entries.forEach((e, i) => {
      for (const p of PERCENTILES) expect(Math.abs(e.ringsKm[p] - LPB_DEMENTIA_MILES[p][i]! * 1.609344), `${e.terrain} ${p}%`).toBeLessThanOrEqual(0.131);
    });
  });

  it('matches the printed temperate mountainous row: n=95, 0.3/0.8/1.9/8.3 km, dispersion 11/23/66/70° (n=11)', () => {
    const l = lookupBehaviour(LPB_TABLE, 'dementia', 'temperate mountainous')!;
    expect(l.entry).toMatchObject({ n: 95, ringsKm: { 25: 0.3, 50: 0.8, 75: 1.9, 95: 8.3 }, dispersionDeg: { 25: 11, 50: 23, 75: 66, 95: 70 }, dispersionN: 11 });
    expect(l.citation).toMatch(/n=95; dispersion n=11\. Source: Koester/);
  });

  it('gives dispersion angles only where the book prints them (temperate)', () => {
    expect(LPB_TABLE.entries.filter((e) => e.dispersionDeg).map((e) => e.terrain)).toEqual(['temperate mountainous', 'temperate flat']);
  });

  it('has no row for categories that were not checked', () => {
    expect(lookupBehaviour(LPB_TABLE, 'hiker', 'temperate mountainous')).toBeNull();
  });
});
