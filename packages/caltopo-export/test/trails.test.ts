import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bufferLine, buildSearchMap, clipToBand, clipToCircle, joinLines, distanceM, lineLength, localFrame, parseTrailFile, splitEvenly, TEMPLATE_FOLDER_IDS, trailCorridors, type SearchMapInput, type XY } from '../src/index.ts';

const IPP = { lng: -115.8, lat: 51.2 };

function ringArea(r: [number, number][]): number {
  let s = 0;
  for (let i = 1; i < r.length; i++) s += r[i - 1]![0] * r[i]![1] - r[i]![0] * r[i - 1]![1];
  return Math.abs(s / 2);
}

function distToLine(p: XY, line: readonly XY[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

describe('local frame', () => {
  it('puts a point 1 km north at y = 1000 m and returns it unchanged', () => {
    const f = localFrame(IPP);
    const north = { lng: IPP.lng, lat: IPP.lat + (1000 / 6_371_008.8) * (180 / Math.PI) };
    const xy = f.toXY(north);
    expect(xy.x).toBeCloseTo(0, 9);
    expect(xy.y).toBeCloseTo(1000, 6);
    const back = f.toLngLat(xy);
    expect(back.lat).toBeCloseTo(north.lat, 12);
    expect(distanceM(IPP, north)).toBeCloseTo(1000, 6);
  });
});

describe('clipToCircle', () => {
  it('cuts a line from x = -200 to 200 to the part inside radius 100: x = -100 to 100', () => {
    const parts = clipToCircle([{ x: -200, y: 0 }, { x: 200, y: 0 }], 100);
    expect(parts).toHaveLength(1);
    expect(parts[0]![0]!.x).toBeCloseTo(-100, 9);
    expect(parts[0]![1]!.x).toBeCloseTo(100, 9);
  });

  it('gives two parts for a line that leaves the circle and comes back', () => {
    const parts = clipToCircle([{ x: 0, y: 0 }, { x: 0, y: 200 }, { x: 50, y: 200 }, { x: 50, y: 0 }], 100);
    expect(parts).toHaveLength(2);
    expect(lineLength(parts[0]!)).toBeCloseTo(100, 9);
    // Second part runs from (50, √(100² − 50²)) = (50, 86.60) back down to (50, 0).
    expect(lineLength(parts[1]!)).toBeCloseTo(Math.sqrt(100 ** 2 - 50 ** 2), 9);
  });

  it('drops a line entirely outside', () => {
    expect(clipToCircle([{ x: 200, y: 0 }, { x: 300, y: 0 }], 100)).toEqual([]);
  });
});

describe('clipToBand', () => {
  it('keeps x = 100 to 200 and x = -200 to -100 of a line from -300 to 300 in the band 100–200 m', () => {
    const parts = clipToBand([{ x: -300, y: 0 }, { x: 300, y: 0 }], 100, 200);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.map((p) => p.x)).toEqual([expect.closeTo(-200, 9), expect.closeTo(-100, 9)]);
    expect(parts[1]!.map((p) => p.x)).toEqual([expect.closeTo(100, 9), expect.closeTo(200, 9)]);
  });

  it('never keeps a point outside the band, and never more length than the line (property)', () => {
    const pt = fc.record({ x: fc.double({ min: -500, max: 500, noNaN: true }), y: fc.double({ min: -500, max: 500, noNaN: true }) });
    fc.assert(
      fc.property(fc.array(pt, { minLength: 2, maxLength: 8 }), fc.double({ min: 0, max: 200, noNaN: true }), fc.double({ min: 1, max: 300, noNaN: true }), (line, inner, extra) => {
        const outer = inner + extra;
        const parts = clipToBand(line, inner, outer);
        for (const l of parts) for (const p of l) {
          const r = Math.hypot(p.x, p.y);
          expect(r).toBeGreaterThanOrEqual(inner - 1e-6);
          expect(r).toBeLessThanOrEqual(outer + 1e-6);
        }
        expect(parts.reduce((s, l) => s + lineLength(l), 0)).toBeLessThanOrEqual(lineLength(line) + 1e-6);
      }),
    );
  });
});

describe('joinLines', () => {
  it('joins a trail drawn in two parts, whichever way each part runs', () => {
    const a = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const b = [{ x: 300, y: 0 }, { x: 100, y: 0 }];
    const j = joinLines([a, b]);
    expect(j).toHaveLength(1);
    expect(lineLength(j[0]!)).toBeCloseTo(300, 9);
  });

  it('does not join through a junction where three trails meet', () => {
    const o = { x: 0, y: 0 };
    expect(joinLines([[o, { x: 100, y: 0 }], [o, { x: 0, y: 100 }], [o, { x: -100, y: 0 }]])).toHaveLength(3);
  });
});

describe('splitEvenly', () => {
  it('cuts 2500 m at a 1000 m target into round(2.5) = 3 pieces of 833.33 m', () => {
    const pieces = splitEvenly([{ x: 0, y: 0 }, { x: 1500, y: 0 }, { x: 1500, y: 1000 }], 1000);
    expect(pieces).toHaveLength(3);
    for (const p of pieces) expect(lineLength(p)).toBeCloseTo(2500 / 3, 6);
    expect(pieces[1]![0]).toEqual(pieces[0]![pieces[0]!.length - 1]);
  });

  it('keeps a line shorter than half the target as one piece', () => {
    expect(splitEvenly([{ x: 0, y: 0 }, { x: 300, y: 0 }], 1000)).toHaveLength(1);
  });

  it('never loses or adds length (property)', () => {
    const pt = fc.record({ x: fc.double({ min: -5000, max: 5000, noNaN: true }), y: fc.double({ min: -5000, max: 5000, noNaN: true }) });
    fc.assert(
      fc.property(fc.array(pt, { minLength: 2, maxLength: 12 }), fc.integer({ min: 100, max: 3000 }), (line, target) => {
        fc.pre(lineLength(line) > 1);
        const total = splitEvenly(line, target).reduce((s, p) => s + lineLength(p), 0);
        // Points closer than 1 µm are merged, so allow a few µm.
        expect(total).toBeCloseTo(lineLength(line), 4);
      }),
    );
  });
});

describe('bufferLine', () => {
  it('buffers a straight 100 m line by 10 m to a stadium of 100·20 + π·10² = 2314.16 m², less the rounding of the ends', () => {
    const rings = bufferLine([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10);
    expect(rings).toHaveLength(1);
    const a = ringArea(rings[0]!);
    expect(a).toBeLessThanOrEqual(2314.16);
    // The ends are polygons whose sides stay within 0.25 m of the circle: a 10 m circle loses at most 2π·10·0.25 = 15.7 m².
    expect(a).toBeGreaterThan(2314.16 - 15.71);
    expect(rings[0]![0]).toEqual(rings[0]![rings[0]!.length - 1]);
  });

  it('makes one corridor with no gaps for a tight switchback', () => {
    const rings = bufferLine([{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 0, y: 30 }], 50);
    expect(rings).toHaveLength(1);
  });

  it('leaves a hole inside a loop wider than the corridor', () => {
    const rings = bufferLine([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }, { x: 0, y: 0 }], 50);
    expect(rings).toHaveLength(2);
    expect(ringArea(rings[1]!)).toBeCloseTo(900 * 900, -2);
  });

  it('keeps every corridor corner within the half-width of the trail, to the centimetre (property)', () => {
    const pt = fc.record({ x: fc.integer({ min: -2000, max: 2000 }), y: fc.integer({ min: -2000, max: 2000 }) });
    fc.assert(
      fc.property(fc.array(pt, { minLength: 2, maxLength: 8 }), fc.integer({ min: 5, max: 200 }), (line, w) => {
        fc.pre(lineLength(line) > 0);
        for (const ring of bufferLine(line, w)) for (const [x, y] of ring) expect(distToLine({ x, y }, line)).toBeLessThanOrEqual(w + 0.02);
      }),
      { numRuns: 50 },
    );
  });
});

describe('trailCorridors', () => {
  it('turns 3 km of trail running east from the IPP into three 1 km corridors, stopping at a 2 km radius', () => {
    const f = localFrame(IPP);
    const trail = [IPP, f.toLngLat({ x: 3000, y: 0 })];
    const c = trailCorridors(IPP, [trail], { halfWidthM: 50, pieceLengthM: 1000, bands: [{ innerM: 0, outerM: 2000 }] });
    expect(c.map((x) => x.name)).toEqual(['T-1', 'T-2']);
    for (const x of c) expect(x.trailLengthM).toBeCloseTo(1000, 3);
  });

  it('covers only the chosen bands: 3 km of trail east, band 1–2 km, gives one 1 km piece from x = 1000 to 2000', () => {
    const f = localFrame(IPP);
    const c = trailCorridors(IPP, [[IPP, f.toLngLat({ x: 3000, y: 0 })]], { halfWidthM: 50, pieceLengthM: 1000, bands: [{ innerM: 1000, outerM: 2000 }] });
    expect(c).toHaveLength(1);
    expect(c[0]!.trailLengthM).toBeCloseTo(1000, 3);
    const xs = c[0]!.rings[0]!.map((p) => f.toXY(p).x);
    expect(Math.min(...xs)).toBeCloseTo(950, 0);
    expect(Math.max(...xs)).toBeCloseTo(2050, 0);
  });

  it('treats touching bands as one, so a trail is not cut at the ring between them', () => {
    const f = localFrame(IPP);
    const c = trailCorridors(IPP, [[IPP, f.toLngLat({ x: 1500, y: 0 })]], { halfWidthM: 50, pieceLengthM: 1500, bands: [{ innerM: 0, outerM: 1000 }, { innerM: 1000, outerM: 2000 }] });
    expect(c).toHaveLength(1);
    expect(c[0]!.trailLengthM).toBeCloseTo(1500, 3);
  });

  it('does not change the trails it is given', () => {
    const trail = [IPP, { lng: IPP.lng + 0.01, lat: IPP.lat }];
    const copy = structuredClone(trail);
    trailCorridors(IPP, [trail], { halfWidthM: 50, pieceLengthM: 1000, bands: [{ innerM: 0, outerM: 2000 }] });
    expect(trail).toEqual(copy);
  });
});

describe('parseTrailFile', () => {
  it('reads GPX routes and tracks without times', () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1"><rte><rtept lat="51.2" lon="-115.8"/><rtept lat="51.21" lon="-115.8"/></rte>
      <trk><trkseg><trkpt lat="51.2" lon="-115.8"></trkpt><trkpt lat="51.2" lon="-115.79"></trkpt></trkseg></trk></gpx>`;
    const r = parseTrailFile(gpx);
    expect(r.lines).toHaveLength(2);
    expect(r.lines).toContainEqual([{ lat: 51.2, lng: -115.8 }, { lat: 51.21, lng: -115.8 }]);
  });

  it('reads GeoJSON LineString and MultiLineString and skips other shapes', () => {
    const gj = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-115.8, 51.2, 0, 0], [-115.79, 51.2, 0, 0]] }, properties: {} },
        { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[-115.8, 51.2], [-115.8, 51.21]], [[-115.8, 51.2], [-115.81, 51.2]]] }, properties: {} },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-115.8, 51.2] }, properties: {} },
      ],
    });
    const r = parseTrailFile(gj);
    expect(r.lines).toHaveLength(3);
    expect(r.skipped).toBe(1);
  });

  it('refuses a file that is neither', () => {
    expect(() => parseTrailFile('hello')).toThrow(/expected GPX or GeoJSON/);
  });
});

describe('search map with trails', () => {
  const f = localFrame(IPP);
  // Round test values, not behavioural statistics.
  const input: SearchMapInput = {
    label: 'Test Lake 2026-07-18',
    planningPoint: { ...IPP, kind: 'IPP' },
    rings: [
      { percent: 50, distanceKm: 2 },
      { percent: 95, distanceKm: 10 },
    ],
    ringSource: 'test values',
    trails: { lines: [[IPP, f.toLngLat({ x: 0, y: 3000 })]], halfWidthM: 50, pieceLengthM: 1000, inRings: [50] },
  };

  it('adds draft ground assignments T-1, T-2 in 8 - Unassigned Segments and notes the width in the file metadata', () => {
    const map = buildSearchMap(input);
    const t = map.features.filter((x) => String(x.properties.title).startsWith('T-'));
    expect(t.map((x) => x.properties.title)).toEqual(['T-1', 'T-2']);
    for (const x of t) {
      expect(x.properties).toMatchObject({ class: 'Assignment', status: 'DRAFT', resourceType: 'GROUND', folderId: TEMPLATE_FOLDER_IDS['8 - Unassigned Segments'] });
      expect(x.properties.description).toBeUndefined();
      expect(x.geometry?.type).toBe('Polygon');
    }
    expect(map.features.find((x) => x.properties.class === 'Marker')!.properties.description).toBeUndefined();
    expect(map.metadata.provenance).toMatch(/Trail segments: 50 m either side/);
  });

  it('refuses a trail ring band that does not exist', () => {
    expect(() => buildSearchMap({ ...input, trails: { ...input.trails!, inRings: [75] } })).toThrow(/no 75% ring band/);
  });
});
