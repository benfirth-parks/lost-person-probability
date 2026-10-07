import { describe, expect, it } from 'vitest';
import { parseCaltopoGeoJson } from '../../importers/src/index.ts';
import { buildSearchMap, destination, distanceM, ringLine, searchMapFileName, TEMPLATE_FOLDER_IDS, TEMPLATE_FOLDERS, validateSearchMapInput, wedgePolygon, type SearchMapInput } from '../src/index.ts';

const IPP = { lng: -115.8, lat: 51.2 };
// Round test values, not behavioural statistics.
const INPUT: SearchMapInput = {
  label: 'Test Lake 2026-07-18',
  planningPoint: { ...IPP, kind: 'IPP' },
  travelBearingDeg: 90,
  rings: [
    { percent: 25, distanceKm: 1 },
    { percent: 50, distanceKm: 2 },
    { percent: 75, distanceKm: 4 },
    { percent: 95, distanceKm: 10 },
  ],
  ringSource: 'test values',
  dispersion: [{ percent: 25, angleDeg: 90 }, { percent: 50, angleDeg: 120 }],
  dispersionSource: 'test values',
  segments: { sectors: 8, inRings: [25, 50, 75] },
};
const pt = (c: number[]) => ({ lng: c[0]!, lat: c[1]! });

describe('geometry', () => {
  it('moves 1 km due north by 1000 / 6 371 008.8 rad = 0.0089932° of latitude', () => {
    const p = destination(IPP, 0, 1000);
    expect(p.lng).toBeCloseTo(IPP.lng, 12);
    expect(p.lat - IPP.lat).toBeCloseTo(0.0089932, 7);
    expect(distanceM(IPP, p)).toBeCloseTo(1000, 6);
  });

  it('draws a ring as 73 points at 5° steps from due north, closed, all at the radius', () => {
    const ring = ringLine(IPP, 2500);
    expect(ring).toHaveLength(73);
    expect(ring[0]).toEqual(ring[72]);
    expect(ring[0]![0]).toBeCloseTo(IPP.lng, 7);
    // Coordinates are rounded to 1e-7°, about 1 cm.
    for (const c of ring) expect(distanceM(IPP, pt(c))).toBeCloseTo(2500, 1);
  });

  it('draws a 90° wedge as the apex, 19 arc points and the apex again (as in the BYK examples)', () => {
    const w = wedgePolygon(IPP, 90, 90, 1000);
    expect(w).toHaveLength(21);
    expect(pt(w[0]!)).toEqual(pt(w[20]!));
    const bearing = (c: number[]) => {
      const p = pt(c);
      const y = Math.sin(((p.lng - IPP.lng) * Math.PI) / 180) * Math.cos((p.lat * Math.PI) / 180);
      const x = Math.cos((IPP.lat * Math.PI) / 180) * Math.sin((p.lat * Math.PI) / 180) - Math.sin((IPP.lat * Math.PI) / 180) * Math.cos((p.lat * Math.PI) / 180) * Math.cos(((p.lng - IPP.lng) * Math.PI) / 180);
      return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    };
    expect(bearing(w[1]!)).toBeCloseTo(45, 3);
    expect(bearing(w[19]!)).toBeCloseTo(135, 3);
  });
});

describe('buildSearchMap', () => {
  const map = buildSearchMap(INPUT);
  const byClass = (cls: string) => map.features.filter((f) => f.properties.class === cls);

  it('uses the template folders, and every feature sits in one of them', () => {
    const folders = byClass('Folder');
    expect(folders.map((f) => f.properties.title)).toEqual([...TEMPLATE_FOLDERS]);
    const ids = new Set(folders.map((f) => f.id));
    for (const f of map.features) if (f.properties.class !== 'Folder') expect(ids.has(f.properties.folderId as string)).toBe(true);
    expect(new Set(map.features.map((f) => f.id)).size).toBe(map.features.length);
  });

  it("keeps the template's folder ids and marks the planning point as the template does", () => {
    expect(byClass('Folder').map((f) => f.id)).toEqual(TEMPLATE_FOLDERS.map((t) => TEMPLATE_FOLDER_IDS[t]));
    expect(TEMPLATE_FOLDER_IDS['1 - Important Points']).toBe('bfae8b57-66c1-4f19-b300-fa67d2dc0cf1');
    const [m] = byClass('Marker');
    expect(m!.properties).toMatchObject({ title: 'IPP', 'marker-symbol': 'cp', 'marker-color': '#ff0000', 'marker-size': 1, 'marker-rotation': 0, folderId: TEMPLATE_FOLDER_IDS['1 - Important Points'] });
    expect(m!.geometry).toEqual({ type: 'Point', coordinates: [-115.8, 51.2, 0, 0] });
  });

  it('titles rings like the examples, with the mode and sources in the file metadata, not on any feature', () => {
    const rings = map.features.filter((f) => f.geometry?.type === 'LineString');
    expect(rings.map((f) => f.properties.title)).toEqual(['25% 1 km', '50% 2 km', '75% 4 km', '95% 10 km']);
    const odd = buildSearchMap({ ...INPUT, rings: [{ percent: 50, distanceKm: 3.65 }, { percent: 95, distanceKm: 18.3 }], dispersion: [], segments: undefined });
    expect(odd.features.filter((f) => f.geometry?.type === 'LineString').map((f) => f.properties.title)).toEqual(['50% 3.65 km', '95% 18.3 km']);
    for (const f of map.features) expect(f.properties.description).toBeUndefined();
    expect(map.metadata.provenance).toMatch(/training\/research mode.*Rings: test values.*Dispersion around 90° true: test values/s);
  });

  it('cuts 3 ring bands × 8 sectors = 24 draft ground segments out to the 75% ring', () => {
    const segs = byClass('Assignment');
    expect(segs).toHaveLength(24);
    expect(segs[0]!.properties).toMatchObject({ title: 'R1-N', status: 'DRAFT', resourceType: 'GROUND' });
    expect(segs.map((s) => s.properties.title)).toContain('R3-SW');
  });

  it('cuts only the chosen ring bands, keeping each band its ring number: 50–75% and 75–95% give R3 and R4, 16 segments', () => {
    const map = buildSearchMap({ ...INPUT, segments: { sectors: 8, inRings: [75, 95] } });
    const names = map.features.filter((f) => f.properties.class === 'Assignment').map((f) => String(f.properties.title));
    expect(names).toHaveLength(16);
    expect(new Set(names.map((n) => n.split('-')[0]))).toEqual(new Set(['R3', 'R4']));
    // R3-N runs from the 50% ring (2 km) out to the 75% ring (4 km).
    const r3n = map.features.find((f) => f.properties.title === 'R3-N')!;
    const d = (r3n.geometry as { coordinates: number[][][] }).coordinates[0]!.map((c) => distanceM(IPP, pt(c)));
    expect(Math.min(...d)).toBeCloseTo(2000, 0);
    expect(Math.max(...d)).toBeCloseTo(4000, 0);
  });

  it('refuses ring bands that are missing or not chosen at all', () => {
    expect(validateSearchMapInput({ ...INPUT, segments: { sectors: 8, inRings: [] } })).toContain('segments: choose at least one ring band');
    expect(validateSearchMapInput({ ...INPUT, segments: { sectors: 8, inRings: [60] } })).toContain('segments: there is no 60% ring band');
  });

  it('gives the same file for the same input', () => {
    expect(JSON.stringify(buildSearchMap(INPUT))).toBe(JSON.stringify(map));
  });

  it('round-trips through the CalTopo importer: segments come back as valid assignment areas', () => {
    const r = parseCaltopoGeoJson(JSON.stringify(map), (lng, lat) => ({ x: lng * 70_000, y: lat * 111_000 }));
    expect(r.assignments).toHaveLength(24);
    expect(r.skipped.filter((s) => s.reason.includes('invalid'))).toEqual([]);
  });

  it('puts the mode in the file name', () => {
    expect(searchMapFileName(INPUT)).toBe('Test_Lake_2026-07-18_TRAINING_search_map.json');
  });
});

describe('validateSearchMapInput', () => {
  const bad = (patch: Partial<SearchMapInput>) => validateSearchMapInput({ ...INPUT, ...patch });
  it('requires a named source for ring distances and dispersion angles', () => {
    expect(bad({ ringSource: ' ' }).join()).toMatch(/ring source is required/);
    expect(bad({ dispersionSource: '' }).join()).toMatch(/dispersion source is required/);
  });
  it('requires rings to grow outwards', () => {
    expect(bad({ rings: [{ percent: 50, distanceKm: 3 }, { percent: 25, distanceKm: 1 }] }).join()).toMatch(/must both increase/);
  });
  it('needs a direction of travel for dispersion wedges', () => {
    expect(bad({ travelBearingDeg: undefined }).join()).toMatch(/direction of travel/);
  });
  it('refuses labels that look like a name or a phone number', () => {
    expect(bad({ label: 'Jane Smith' }).join()).toMatch(/person's name/);
    expect(bad({ label: 'call 403 555 0199' }).join()).toMatch(/phone number/);
    expect(bad({ label: 'Johnson Canyon 2026-05-01' })).toEqual([]);
  });
  it('throws instead of building from a bad input', () => {
    expect(() => buildSearchMap({ ...INPUT, rings: [] })).toThrow(/at least one range ring/);
  });
});

describe('segment PODs', () => {
  const pods = { 'R1-N': { resourceType: 'DOG_TRAIL', responsivePOD: 'HIGH', unresponsivePOD: 'MEDIUM', cluePOD: 'LOW' } } as const;

  it('writes CalTopo POD fields on the named segment only, and records the source in the file metadata', () => {
    const map = buildSearchMap({ ...INPUT, segmentPods: pods, segmentPodSource: 'test values' });
    const seg = (n: string) => map.features.find((f) => f.properties.title === n)!.properties;
    expect(seg('R1-N')).toMatchObject({ resourceType: 'DOG_TRAIL', responsivePOD: 'HIGH', unresponsivePOD: 'MEDIUM', cluePOD: 'LOW', status: 'DRAFT' });
    expect(seg('R1-NE').responsivePOD).toBeUndefined();
    expect(seg('R1-NE').resourceType).toBe('GROUND');
    expect(map.metadata.provenance).toMatch(/Segment PODs are planned, not achieved: test values/);
  });

  it('refuses PODs without a source, or with values CalTopo does not use', () => {
    expect(validateSearchMapInput({ ...INPUT, segmentPods: pods })).toContain('segment PODs need a source line');
    const bad = { 'R1-N': { ...pods['R1-N'], cluePOD: 'VERY HIGH' } } as never;
    expect(validateSearchMapInput({ ...INPUT, segmentPods: bad, segmentPodSource: 'x' }).join()).toMatch(/LOW, MEDIUM or HIGH/);
  });
});
