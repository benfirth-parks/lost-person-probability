import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EXERCISE_SWEEP_TABLE, lookupSweepWidth, plannedSegmentPod, podClass, SweepWidthTable, type SweepWidthTable as Table } from '../src/segment-pod.ts';

// Round test values, not research data.
const TABLE: Table = {
  name: 'test',
  source: 'test values',
  kind: 'exercise',
  entries: [
    { resource: 'GROUND', vegetation: 'open', slope: 'any', widthM: { responsive: 40, unresponsive: 20, clue: 10 } },
    { resource: 'GROUND', vegetation: 'open', slope: 'steep', widthM: { responsive: 30, unresponsive: 15, clue: 5 } },
  ],
};

describe('plannedSegmentPod', () => {
  it('gives C = W/S and POD = 1 − e^(−C): W 40, 20, 10 m at 20 m spacing → C 2, 1, 0.5 → POD 0.8647, 0.6321, 0.3935', () => {
    const r = plannedSegmentPod(TABLE, { resource: 'GROUND', vegetation: 'open', slope: 'gentle', spacingM: 20 })!;
    expect(r.status).toBe('planned');
    expect(r.coverage).toEqual({ responsive: 2, unresponsive: 1, clue: 0.5 });
    expect(r.pod.responsive).toBeCloseTo(0.864665, 6);
    expect(r.pod.unresponsive).toBeCloseTo(0.632121, 6);
    expect(r.pod.clue).toBeCloseTo(0.393469, 6);
    expect(r.podClass).toEqual({ responsive: 'HIGH', unresponsive: 'MEDIUM', clue: 'LOW' });
  });

  it('uses the steep row when there is one, and the "any" row otherwise', () => {
    expect(lookupSweepWidth(TABLE, 'GROUND', 'open', 'steep')!.widthM.responsive).toBe(30);
    expect(lookupSweepWidth(TABLE, 'GROUND', 'open', 'gentle')!.widthM.responsive).toBe(40);
  });

  it('returns null when the table has no row, rather than guessing', () => {
    expect(plannedSegmentPod(TABLE, { resource: 'AIR', vegetation: 'open', slope: 'gentle', spacingM: 100 })).toBeNull();
  });

  // Below 1 for any spacing wider than W/36; tighter than that, 1 − e^(−C) rounds to 1 in floating point.
  it('stays in [0, 1] and falls as spacing widens (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 5000, noNaN: true }), fc.double({ min: 1, max: 5000, noNaN: true }), (a, b) => {
        const plan = { resource: 'GROUND' as const, vegetation: 'open' as const, slope: 'gentle' as const };
        const pa = plannedSegmentPod(TABLE, { ...plan, spacingM: Math.min(a, b) })!.pod.responsive;
        const pb = plannedSegmentPod(TABLE, { ...plan, spacingM: Math.max(a, b) })!.pod.responsive;
        expect(pa).toBeLessThanOrEqual(1);
        expect(pb).toBeGreaterThan(0);
        expect(pa).toBeGreaterThanOrEqual(pb);
      }),
    );
  });
});

describe('podClass', () => {
  it('bins at 0.4 and 0.7 by default', () => {
    expect([0.39, 0.4, 0.69, 0.7].map((p) => podClass(p))).toEqual(['LOW', 'MEDIUM', 'MEDIUM', 'HIGH']);
  });
  it('refuses bins out of order', () => {
    expect(() => podClass(0.5, { medium: 0.7, high: 0.4 })).toThrow();
  });
});

describe('EXERCISE_SWEEP_TABLE', () => {
  it('is a valid table labelled as exercise values, with a row for every resource and vegetation', () => {
    expect(SweepWidthTable.safeParse(EXERCISE_SWEEP_TABLE).success).toBe(true);
    expect(EXERCISE_SWEEP_TABLE.kind).toBe('exercise');
    expect(EXERCISE_SWEEP_TABLE.source).toMatch(/not research data/i);
    expect(EXERCISE_SWEEP_TABLE.entries).toHaveLength(12);
  });
});
