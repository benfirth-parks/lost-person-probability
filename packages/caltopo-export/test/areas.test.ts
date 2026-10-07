import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { areaSegments, circleRing, localFrame, pieceAreaM2, ringAreaM2, ringCentroid, splitToSize, type XY } from '../src/index.ts';

const IPP = { lng: -115.8, lat: 51.2 };
const f = localFrame(IPP);
const line = (...pts: [number, number][]) => pts.map(([x, y]) => f.toLngLat({ x, y }));
const areaOf = (rings: { lng: number; lat: number }[][]) => {
  const xy = rings.map((r) => r.map((p) => f.toXY(p)).map((q: XY) => [q.x, q.y] as [number, number]));
  return ringAreaM2(xy[0]!) - xy.slice(1).reduce((s, h) => s + ringAreaM2(h), 0);
};

// A 180-gon of radius 1000 m: (180 / 2) · sin(2°) · 1000² = 3,140,954.7 m².
const CIRCLE_1KM = 90 * Math.sin((2 * Math.PI) / 180) * 1e6;

describe('circleRing', () => {
  it('has the area of a regular 180-gon', () => {
    expect(ringAreaM2(circleRing(1000))).toBeCloseTo(CIRCLE_1KM, 3);
  });

  it('has its centroid at the centre; a 2 × 1 rectangle has it at (1, 0.5)', () => {
    const c = ringCentroid(circleRing(1000));
    expect(Math.hypot(c.x, c.y)).toBeLessThan(1e-6);
    expect(ringCentroid([[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]])).toEqual({ x: 1, y: 0.5 });
  });
});

describe('areaSegments', () => {
  it('cuts a 1 km circle along a stream through the middle into two halves of (3,140,955 − 2 × 2,000) / 2 m²', () => {
    const r = areaSegments(IPP, [line([-2000, 0], [2000, 0])], { radiusM: 1000, maxAreaM2: 2_000_000 });
    expect(r.segments.map((s) => s.name)).toEqual(['A-1', 'A-2']);
    for (const s of r.segments) expect(s.areaM2).toBeCloseTo((CIRCLE_1KM - 4000) / 2, -1);
    for (const s of r.segments) expect(areaOf(s.rings)).toBeCloseTo(s.areaM2, -1);
    expect(r.sliverCount).toBe(0);
  });

  it('does not split along a line that ends inside the area; only its 2 m × 500 m strip is removed', () => {
    const r = areaSegments(IPP, [line([0, 0], [0, 500])], { radiusM: 1000, maxAreaM2: 5_000_000 });
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.areaM2).toBeCloseTo(CIRCLE_1KM - 1000, -1);
  });

  it('with no lines, halves the circle twice to get under 1 km²: four quarters of 785,239 m²', () => {
    const r = areaSegments(IPP, [], { radiusM: 1000, maxAreaM2: 1_000_000 });
    expect(r.segments).toHaveLength(4);
    for (const s of r.segments) expect(s.areaM2).toBeCloseTo(CIRCLE_1KM / 4, -1);
  });

  it('reports slivers between two close parallel streams instead of hiding them', () => {
    const r = areaSegments(IPP, [line([-2000, 0], [2000, 0]), line([-2000, 3], [2000, 3])], { radiusM: 1000, maxAreaM2: 5_000_000 });
    expect(r.segments).toHaveLength(2);
    expect(r.sliverCount).toBe(1);
    expect(r.sliverAreaM2).toBeGreaterThan(0);
  });

  it('names segments nearest the planning point first', () => {
    const r = areaSegments(IPP, [line([-3000, 500], [3000, 500])], { radiusM: 2000, maxAreaM2: 50_000_000 });
    const d = r.segments.map((s) => {
      const c = ringCentroid(s.rings[0]!.map((p) => f.toXY(p)).map((q) => [q.x, q.y] as [number, number]));
      return Math.hypot(c.x, c.y);
    });
    expect(d[0]!).toBeLessThan(d[1]!);
  });

  it('refuses sizes outside the allowed ranges', () => {
    expect(() => areaSegments(IPP, [], { radiusM: 10, maxAreaM2: 1e6 })).toThrow(/radius/);
    expect(() => areaSegments(IPP, [], { radiusM: 1000, maxAreaM2: 10 })).toThrow(/largest segment/);
  });

  it('property: every segment fits the size limit, and segments + slivers + cut strips account for the whole circle', () => {
    const pt = fc.tuple(fc.integer({ min: -2500, max: 2500 }), fc.integer({ min: -2500, max: 2500 }));
    fc.assert(
      fc.property(fc.array(fc.tuple(pt, pt), { maxLength: 4 }), fc.integer({ min: 200_000, max: 3_000_000 }), (segs, maxA) => {
        const lines = segs.filter(([a, b]) => a[0] !== b[0] || a[1] !== b[1]).map(([a, b]) => line(a, b));
        const r = areaSegments(IPP, lines, { radiusM: 1500, maxAreaM2: maxA });
        const circle = ringAreaM2(circleRing(1500));
        const total = r.segments.reduce((s, x) => s + x.areaM2, 0) + r.sliverAreaM2;
        const strip = segs.reduce((s, [a, b]) => s + 2 * Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
        for (const s of r.segments) expect(s.areaM2).toBeLessThanOrEqual(maxA + 1);
        // Each cut rounds its new corners to the nearest centimetre, so allow 1 m² per piece.
        const slack = 5 + r.segments.length + r.sliverCount;
        expect(total).toBeLessThanOrEqual(circle + slack);
        expect(total).toBeGreaterThanOrEqual(circle - strip - slack);
      }),
      { numRuns: 60 },
    );
  });
});

describe('splitToSize', () => {
  it('leaves a piece already under the limit alone', () => {
    const p = { outer: circleRing(100), holes: [] };
    expect(splitToSize(p, 1e6)).toEqual([p]);
    expect(pieceAreaM2(p)).toBeLessThan(1e6);
  });
});
