import { describe, expect, it } from 'vitest';
import { BehaviourTable, CSV_HEADER, EXERCISE_TABLE, lookupBehaviour, parseBehaviourCsv } from '../src/index.ts';

// Test rows use invented round numbers, not research values.
const META = { name: 'Test table', source: 'Unit test fixture', kind: 'agency' as const };

describe('behaviour tables', () => {
  it('the exercise table is valid and says what it is', () => {
    expect(BehaviourTable.safeParse(EXERCISE_TABLE).success).toBe(true);
    const l = lookupBehaviour(EXERCISE_TABLE, 'Hiker', 'Mountainous')!;
    expect(l.citation).toMatch(/exercise values, not research data/);
    expect(l.entry.ringsKm).toEqual({ 25: 1, 50: 2, 75: 4, 95: 10 });
  });

  it('reads a CSV, converting miles to km (1 mi = 1.609344 km)', () => {
    const r = parseBehaviourCsv(`${CSV_HEADER}\nhiker,mountainous,100,1,2,3,10,10,20,40,80\nchild,any,,0.5,1,2,4,,,,`, META, 'mi');
    if (!r.ok) throw new Error(JSON.stringify(r.problems));
    expect(r.table.entries[0]).toEqual({
      category: 'hiker',
      terrain: 'mountainous',
      n: 100,
      ringsKm: { 25: 1.609, 50: 3.219, 75: 4.828, 95: 16.093 },
      dispersionDeg: { 25: 10, 50: 20, 75: 40, 95: 80 },
    });
    expect(r.table.entries[1]).toEqual({ category: 'child', terrain: 'any', ringsKm: { 25: 0.805, 50: 1.609, 75: 3.219, 95: 6.437 } });
  });

  it('falls back to the category\'s "any" row and says so', () => {
    const r = parseBehaviourCsv('child,any,,0.5,1,2,4', META);
    if (!r.ok) throw new Error('parse');
    expect(lookupBehaviour(r.table, 'child', 'flat')).toMatchObject({ terrainFallback: true });
    expect(lookupBehaviour(r.table, 'hiker', 'flat')).toBeNull();
  });

  it('names every problem with its line', () => {
    const r = parseBehaviourCsv(`${CSV_HEADER}\nhiker,flat,,4,3,2,1\nhunter,flat,,1,2,x,4\nangler,flat,,1,2,3,4,10,20\nhiker,flat,,1,2,3,4`, META);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.line)).toEqual([2, 3, 4]);
    expect(r.problems[0]!.message).toMatch(/must increase/);
  });

  it('refuses the same category and terrain twice', () => {
    const r = parseBehaviourCsv('hiker,flat,,1,2,3,4\nhiker,flat,,1,2,3,5', META);
    expect(r.ok).toBe(false);
  });
});
