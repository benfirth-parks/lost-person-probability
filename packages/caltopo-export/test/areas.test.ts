import { describe, expect, it } from 'vitest';
import { areaSegmentsInBands, buildSearchMap, CRUMB_M2, localFrame, TEMPLATE_FOLDER_IDS, type LngLat, type SearchMapInput } from '../src/index.ts';

const IPP = { lng: -115.8, lat: 51.2 };
const f = localFrame(IPP);
/** Axis-aligned rectangle in metres around the IPP, as a closed lng/lat ring. */
const rect = (x0: number, y0: number, x1: number, y1: number): LngLat[] =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => f.toLngLat({ x: x!, y: y! }));

function areaM2(rings: LngLat[][]): number {
  const one = (r: LngLat[]) => {
    const p = r.map(f.toXY);
    let s = 0;
    for (let i = 1; i < p.length; i++) s += p[i - 1]!.x * p[i]!.y - p[i]!.x * p[i - 1]!.y;
    return Math.abs(s / 2);
  };
  return one(rings[0]!) - rings.slice(1).reduce((s, r) => s + one(r), 0);
}

// A 720-sided ring polygon of radius r has area ½·720·r²·sin(2π/720) = 0.99998731·πr².
const POLY = 0.5 * 720 * Math.sin((2 * Math.PI) / 720);

describe('areaSegmentsInBands', () => {
  it('keeps the disc of a 0–500 m band from a 4 km square: 0.5·720·500²·sin(0.5°) = 785,388 m²', () => {
    const s = areaSegmentsInBands(IPP, [[rect(-2000, -2000, 2000, 2000)]], [{ innerM: 0, outerM: 500 }]);
    expect(s).toHaveLength(1);
    expect(s[0]!.name).toBe('A-1');
    expect(s[0]!.areaM2).toBeCloseTo(POLY * 500 ** 2, -1);
    expect(areaM2(s[0]!.rings)).toBeCloseTo(POLY * 500 ** 2, -1);
  });

  it('cuts at the edges of the ticked bands only: 0–500 and 500–1000 m together give one disc of 1 km radius', () => {
    const s = areaSegmentsInBands(IPP, [[rect(-2000, -2000, 2000, 2000)]], [{ innerM: 500, outerM: 1000 }, { innerM: 0, outerM: 500 }]);
    expect(s).toHaveLength(1);
    expect(s[0]!.areaM2).toBeCloseTo(POLY * 1000 ** 2, -1);
  });

  it('gives a disc and a ring for bands that do not touch, the nearer first, the ring with the inner circle as a hole', () => {
    const s = areaSegmentsInBands(IPP, [[rect(-2000, -2000, 2000, 2000)]], [{ innerM: 600, outerM: 900 }, { innerM: 0, outerM: 300 }]);
    expect(s.map((x) => x.name)).toEqual(['A-1', 'A-2']);
    expect(s[0]!.areaM2).toBeCloseTo(POLY * 300 ** 2, -1);
    expect(s[1]!.rings).toHaveLength(2);
    expect(s[1]!.areaM2).toBeCloseTo(POLY * (900 ** 2 - 600 ** 2), -1);
  });

  it('keeps half the disc of a square east of the planning point, and lakes stay out as holes', () => {
    const lake = rect(200, -100, 400, 100); // 200 × 200 = 40,000 m²
    const s = areaSegmentsInBands(IPP, [[rect(0, -2000, 2000, 2000), lake]], [{ innerM: 0, outerM: 1000 }]);
    expect(s).toHaveLength(1);
    expect(s[0]!.rings).toHaveLength(2);
    expect(s[0]!.areaM2).toBeCloseTo((POLY * 1000 ** 2) / 2 - 40_000, -1);
  });

  it('names segments nearest edge first', () => {
    const far = rect(600, -100, 800, 100);
    const near = rect(-300, -100, -100, 100);
    const s = areaSegmentsInBands(IPP, [[far], [near]], [{ innerM: 0, outerM: 1000 }]);
    expect(s.map((x) => Math.round(f.toXY(x.rings[0]![0]!).x) < 0)).toEqual([true, false]);
  });

  it('drops crumbs under 0.5 ha left where a ring clips a corner, and nothing outside the bands', () => {
    // This square's corner reaches 14 m inside the 1 km ring: a few hundred m² inside.
    const d = 1000 / Math.SQRT2 - 10;
    const sliver = rect(d, d, d + 800, d + 800);
    expect(CRUMB_M2).toBe(5000);
    expect(areaSegmentsInBands(IPP, [[sliver]], [{ innerM: 0, outerM: 1000 }])).toHaveLength(0);
    expect(areaSegmentsInBands(IPP, [[rect(3000, 3000, 4000, 4000)]], [{ innerM: 0, outerM: 1000 }])).toHaveLength(0);
    // Its corner 293 m inside the ring leaves well over 0.5 ha, which is kept.
    expect(areaSegmentsInBands(IPP, [[rect(500, 500, 1500, 1500)]], [{ innerM: 0, outerM: 1000 }])).toHaveLength(1);
  });

  it('does not change the polygons it is given', () => {
    const polys = [[rect(-500, -500, 500, 500)]];
    const copy = structuredClone(polys);
    areaSegmentsInBands(IPP, polys, [{ innerM: 0, outerM: 300 }]);
    expect(polys).toEqual(copy);
  });
});

describe('search map with area segments', () => {
  // Round test values, not behavioural statistics.
  const input: SearchMapInput = {
    label: 'Test Lake 2026-07-18',
    planningPoint: { ...IPP, kind: 'IPP' },
    rings: [
      { percent: 25, distanceKm: 0.5 },
      { percent: 50, distanceKm: 1 },
      { percent: 95, distanceKm: 3 },
    ],
    ringSource: 'test values',
    areas: { polygons: [[rect(-2000, -2000, 0, 2000)], [rect(0, -2000, 2000, 2000)]], inRings: [50], source: 'test polygons' },
  };

  it('adds draft ground assignments A-1, A-2 in the 25–50% band, with the source in the file metadata', () => {
    const map = buildSearchMap(input);
    const a = map.features.filter((x) => String(x.properties.title).startsWith('A-'));
    expect(a.map((x) => x.properties.title)).toEqual(['A-1', 'A-2']);
    for (const x of a) {
      expect(x.properties).toMatchObject({ class: 'Assignment', status: 'DRAFT', resourceType: 'GROUND', folderId: TEMPLATE_FOLDER_IDS['8 - Unassigned Segments'] });
      expect(x.properties.description).toBeUndefined();
      // Half of the 500–1000 m ring each, the 500 m circle as a hole edge.
      expect(areaM2((x.geometry as { coordinates: number[][][] }).coordinates.map((r) => r.map((c) => ({ lng: c[0]!, lat: c[1]! }))))).toBeCloseTo((POLY * (1000 ** 2 - 500 ** 2)) / 2, -2);
    }
    expect(map.metadata.provenance).toMatch(/Area segments follow ridges, creeks and lakes: test polygons/);
  });

  it('refuses a band that does not exist or a missing source', () => {
    expect(() => buildSearchMap({ ...input, areas: { ...input.areas!, inRings: [75] } })).toThrow(/area segments: there is no 75% ring band/);
    expect(() => buildSearchMap({ ...input, areas: { ...input.areas!, source: ' ' } })).toThrow(/area segments need a source/);
  });
});
