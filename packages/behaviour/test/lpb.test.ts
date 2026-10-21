import { describe, expect, it } from 'vitest';
import { BehaviourTable, LPB_CATEGORIES, LPB_PRINTED, LPB_TABLE, LPB_TERRAINS, PERCENTILES, lookupBehaviour } from '../src/index.ts';

describe('Lost Person Behavior rows', () => {
  it('is a valid table holding only the checked categories', () => {
    expect(BehaviourTable.safeParse(LPB_TABLE).success).toBe(true);
    expect(new Set(LPB_TABLE.entries.map((e) => e.category))).toEqual(
      new Set(['dementia', 'mental illness', 'intellectual disability', 'mountain biker', 'other (extreme sports)', 'other (motorcycle)', 'runner']),
    );
    for (const e of LPB_TABLE.entries) expect(LPB_CATEGORIES as readonly string[]).toContain(e.category);
    expect(LPB_TABLE.entries.filter((e) => e.category === 'dementia').map((e) => e.terrain)).toEqual([...LPB_TERRAINS]);
  });

  it('kilometres agree with the miles printed beside them, to within the book\'s rounding', () => {
    // Each printed value is rounded to 0.1, so the two can differ by up to 0.05 mi × 1.609 + 0.05 km ≈ 0.13 km.
    // One printed pair is further apart than that: motorcycle 95%, 15.0 mi beside 24.3 km (15.0 mi = 24.14 km).
    const off: string[] = [];
    for (const c of LPB_PRINTED)
      PERCENTILES.forEach((p, i) => {
        if (Math.abs(c.km[i]! - c.mi[i]! * 1.609344) > 0.131) off.push(`${c.category} ${c.column ?? c.terrains.join('/')} ${p}%`);
      });
    expect(off).toEqual(['other (motorcycle) any 95%']);
  });

  it('matches the printed dementia temperate mountainous row: n=95, 0.3/0.8/1.9/8.3 km, dispersion 11/23/66/70° (n=11)', () => {
    const l = lookupBehaviour(LPB_TABLE, 'dementia', 'temperate mountainous')!;
    expect(l.entry).toMatchObject({ n: 95, ringsKm: { 25: 0.3, 50: 0.8, 75: 1.9, 95: 8.3 }, dispersionDeg: { 25: 11, 50: 23, 75: 66, 95: 70 }, dispersionN: 11 });
    expect(l.citation).toMatch(/n=95; dispersion n=11\. Source: Koester.*Dementia chapter.*pp\. 165–166/);
  });

  it('matches the printed mental illness temperate mountain row (p. 201): n=23, 0.6/2.3/8.3/14.6 km, no dispersion', () => {
    const l = lookupBehaviour(LPB_TABLE, 'mental illness', 'temperate mountainous')!;
    expect(l.entry).toMatchObject({ n: 23, ringsKm: { 25: 0.6, 50: 2.3, 75: 8.3, 95: 14.6 } });
    expect(l.entry.dispersionDeg).toBeUndefined();
    expect(l.citation).toMatch(/Mental Illness chapter.*p\. 201\.$/);
  });

  it('says when a row comes from a differently named column', () => {
    expect(lookupBehaviour(LPB_TABLE, 'mental illness', 'temperate flat')!.citation).toMatch(/temperate flat \(printed as "temperate non-mtn"\), n=23/);
    const runner = ['temperate mountainous', 'temperate flat'].map((t) => lookupBehaviour(LPB_TABLE, 'runner', t)!);
    for (const r of runner) expect(r.entry).toMatchObject({ n: 14, ringsKm: { 25: 1.4, 50: 2.6, 75: 3.4, 95: 5.8 }, column: 'temperate, all' });
  });

  it('uses the "any" row for the Other categories, which print no ecoregion', () => {
    const l = lookupBehaviour(LPB_TABLE, 'other (motorcycle)', 'temperate mountainous')!;
    expect(l).toMatchObject({ terrainFallback: true, entry: { n: 13, ringsKm: { 25: 6.5, 50: 11.7, 75: 17.5, 95: 24.3 } } });
  });

  it('gives dispersion angles only where the book prints them', () => {
    expect(LPB_TABLE.entries.filter((e) => e.dispersionDeg).map((e) => `${e.category}|${e.terrain}`)).toEqual([
      'dementia|temperate mountainous',
      'dementia|temperate flat',
      'mountain biker|dry mountainous',
    ]);
    expect(lookupBehaviour(LPB_TABLE, 'mountain biker', 'dry mountainous')!.entry).toMatchObject({ dispersionDeg: { 25: 15, 50: 37, 75: 68, 95: 115 }, dispersionN: 14 });
  });

  it('leaves out columns with fewer than four printed percentiles', () => {
    expect(lookupBehaviour(LPB_TABLE, 'mental illness', 'dry mountainous')).toBeNull();
    expect(lookupBehaviour(LPB_TABLE, 'other (base jumper)', 'temperate mountainous')).toBeNull();
  });

  it('has no row for categories that were not checked', () => {
    expect(lookupBehaviour(LPB_TABLE, 'hiker', 'temperate mountainous')).toBeNull();
  });
});
