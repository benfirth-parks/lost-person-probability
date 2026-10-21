import { describe, expect, it } from 'vitest';
import { BehaviourTable, LPB_CATEGORIES, LPB_PRINTED, LPB_TABLE, LPB_TERRAINS, PERCENTILES, lookupBehaviour } from '../src/index.ts';

describe('Lost Person Behavior rows', () => {
  it('is a valid table holding only the checked categories', () => {
    expect(BehaviourTable.safeParse(LPB_TABLE).success).toBe(true);
    expect(new Set(LPB_TABLE.entries.map((e) => e.category))).toEqual(
      new Set([
        'climber', 'climber (mountaineer)', 'dementia', 'despondent', 'hiker', 'mental illness', 'intellectual disability', 'mountain biker',
        'other (extreme sports)', 'other (motorcycle)', 'runner',
      ]),
    );
    // Every category is in the book's list, apart from the climber sub-type the book prints as its own column.
    for (const e of LPB_TABLE.entries) expect([...LPB_CATEGORIES, 'climber (mountaineer)']).toContain(e.category);
    expect(LPB_TABLE.entries.filter((e) => e.category === 'dementia').map((e) => e.terrain)).toEqual([...LPB_TERRAINS]);
  });

  it('kilometres agree with the miles printed beside them, to within the book\'s rounding', () => {
    // Each printed value is rounded to 0.1, so the two can differ by up to 0.05 mi × 1.609 + 0.05 km ≈ 0.13 km.
    // Four printed 95% pairs are further apart than that; the printed km are used:
    // despondent temperate mtn 13.3 mi / 21.6 km (= 21.40), despondent dry mtn 11.1 mi / 18.0 km (= 17.86),
    // hiker dry mtn 11.9 mi / 19.3 km (= 19.15), motorcycle 15.0 mi / 24.3 km (= 24.14).
    const off: string[] = [];
    for (const c of LPB_PRINTED)
      PERCENTILES.forEach((p, i) => {
        if (Math.abs(c.km[i]! - c.mi[i]! * 1.609344) > 0.131) off.push(`${c.category} ${c.column ?? c.terrains.join('/')} ${p}%`);
      });
    expect(off).toEqual(['despondent temperate mountainous 95%', 'despondent dry mountainous 95%', 'hiker dry mountainous 95%', 'other (motorcycle) any 95%']);
  });

  it('matches the printed dementia temperate mountainous row: n=95, 0.3/0.8/1.9/8.3 km, dispersion 11/23/66/70° (n=11)', () => {
    const l = lookupBehaviour(LPB_TABLE, 'dementia', 'temperate mountainous')!;
    expect(l.entry).toMatchObject({ n: 95, ringsKm: { 25: 0.3, 50: 0.8, 75: 1.9, 95: 8.3 }, dispersionDeg: { 25: 11, 50: 23, 75: 66, 95: 70 }, dispersionN: 11 });
    expect(l.citation).toMatch(/n=95; dispersion n=11\. Source: Koester.*Dementia chapter.*p\. 164\./);
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
      'hiker|temperate mountainous',
      'hiker|temperate flat',
      'hiker|dry mountainous',
      'hiker|dry flat',
      'mountain biker|dry mountainous',
    ]);
    expect(lookupBehaviour(LPB_TABLE, 'mountain biker', 'dry mountainous')!.entry).toMatchObject({ dispersionDeg: { 25: 15, 50: 37, 75: 68, 95: 115 }, dispersionN: 14 });
  });

  it('matches the printed hiker temperate mountain row (p. 184) and its dispersion (p. 185)', () => {
    const l = lookupBehaviour(LPB_TABLE, 'hiker', 'temperate mountainous')!;
    expect(l.entry).toMatchObject({ n: 568, ringsKm: { 25: 1.1, 50: 3.1, 75: 5.8, 95: 18.3 }, dispersionDeg: { 25: 2, 50: 23, 75: 64, 95: 132 }, dispersionN: 134 });
    expect(l.citation).toMatch(/n=568; dispersion n=134\. Source: Koester.*p\. 184.*p\. 185\.$/);
  });

  it('matches the printed climber rows (p. 157): temperate for both temperate terrains, mountaineers for any terrain', () => {
    expect(lookupBehaviour(LPB_TABLE, 'climber', 'temperate mountainous')!.entry).toMatchObject({ n: 25, ringsKm: { 25: 0.2, 50: 1.6, 75: 3.2, 95: 14.7 }, column: 'temperate' });
    expect(lookupBehaviour(LPB_TABLE, 'climber', 'dry mountainous')).toBeNull();
    expect(lookupBehaviour(LPB_TABLE, 'climber (mountaineer)', 'temperate mountainous')).toMatchObject({
      terrainFallback: true,
      entry: { n: 17, ringsKm: { 25: 0.1, 50: 1.0, 75: 3.0, 95: 10.5 } },
    });
  });

  it('leaves out columns with fewer than four printed percentiles', () => {
    expect(lookupBehaviour(LPB_TABLE, 'mental illness', 'dry mountainous')).toBeNull();
    expect(lookupBehaviour(LPB_TABLE, 'other (base jumper)', 'temperate mountainous')).toBeNull();
    expect(lookupBehaviour(LPB_TABLE, 'hiker', 'urban')).toBeNull();
  });

  it('has no row for categories that were not checked', () => {
    expect(lookupBehaviour(LPB_TABLE, 'gatherer', 'temperate mountainous')).toBeNull();
  });
});
