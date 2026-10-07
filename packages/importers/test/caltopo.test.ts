import { describe, expect, it } from 'vitest';
import { parseCaltopoGeoJson, parseGpx, parseSearchFile, segmentTrack, selfOverlapArea } from '../src/index.ts';

// Hand-checkable projection: 1 degree = 1000 m on both axes.
const project = (lng: number, lat: number) => ({ x: lng * 1000, y: lat * 1000 });
const T = Date.parse('2026-07-18T16:00:00Z');

const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });

describe('CalTopo GeoJSON import', () => {
  it('turns a polygon assignment into a planned area and drops free text', () => {
    const r = parseCaltopoGeoJson(
      fc([
        {
          id: 'a1',
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
          properties: { class: 'Assignment', letter: 'C', number: '101', title: 'NE bench', status: 'COMPLETED', resourceType: 'ground', description: 'Subject Jane Doe last seen here' },
        },
      ]),
      project,
    );
    expect(r.assignments).toHaveLength(1);
    const a = r.assignments[0]!;
    expect(a.label).toBe('C101 NE bench');
    expect(a.resourceType).toBe('GROUND');
    expect(a.status).toBe('COMPLETED');
    expect(a.kind).toBe('planned_area');
    expect(a.area).toEqual([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }]);
    expect(JSON.stringify(r)).not.toContain('Jane');
    expect(r.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads track times from the fourth coordinate or from coordTimes', () => {
    const r = parseCaltopoGeoJson(
      fc([
        { id: 't1', type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0, 1500, T], [0.06, 0, 1500, T + 60_000]] }, properties: { class: 'Shape', title: 'Team 2 GPS' } },
        { id: 't2', type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [0, 0.03]] }, properties: { coordTimes: [new Date(T).toISOString(), new Date(T + 30_000).toISOString()] } },
      ]),
      project,
    );
    expect(r.tracks.map((t) => t.sourceId)).toEqual(['t1', 't2']);
    expect(r.tracks[0]!.points).toEqual([{ x: 0, y: 0, t: T }, { x: 60, y: 0, t: T + 60_000 }]);
    expect(r.tracks[0]!.report.lengthM).toBeCloseTo(60, 9);
    expect(r.tracks[0]!.report.quality).toBe('good');
    expect(r.tracks[0]!.likelyAircraft).toBe(false);
    expect(r.tracks[1]!.report.durationS).toBe(30);
  });

  it('reports every feature it does not import, with a reason', () => {
    const r = parseCaltopoGeoJson(
      fc([
        { id: 'line-asg', type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { class: 'Assignment' } },
        { id: 'drawn', type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { class: 'Shape' } },
        { id: 'bowtie', type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] }, properties: { class: 'Assignment' } },
        { id: 'holed', type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]]] }, properties: { class: 'Assignment' } },
        { id: 'm1', type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { class: 'Marker' } },
      ]),
      project,
    );
    expect(r.assignments).toHaveLength(0);
    expect(r.tracks).toHaveLength(0);
    expect(r.skipped.map((s) => s.sourceId)).toEqual(['line-asg', 'drawn', 'bowtie', 'holed', 'm1']);
    expect(r.skipped[1]!.reason).toMatch(/no timestamps/);
    expect(r.skipped[2]!.reason).toMatch(/zero area/);
  });

  it('ignores folders and treats an untimed fourth coordinate as no time (shape of a real CalTopo export)', () => {
    const r = parseCaltopoGeoJson(
      fc([
        { geometry: null, id: 'f1', type: 'Feature', properties: { class: 'Folder', title: '7 - Ground Assignments' } },
        { geometry: { type: 'LineString', coordinates: [[-115.5, 51.1, 0, 0], [-115.4, 51.2, 0, 0]] }, id: 's1', type: 'Feature', properties: { class: 'Shape', folderId: 'f1' } },
      ]),
      project,
    );
    expect(r.skipped.map((s) => s.sourceId)).toEqual(['s1']);
    expect(r.skipped[0]!.reason).toMatch(/no timestamps/);
  });

  it('caps labels so a long title cannot carry a narrative', () => {
    const r = parseCaltopoGeoJson(
      fc([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { class: 'Assignment', title: 'x'.repeat(200) } }]),
      project,
    );
    expect(r.assignments[0]!.label.length).toBe(40);
  });

  it('rejects files that are not GeoJSON feature collections', () => {
    expect(() => parseCaltopoGeoJson('not json', project)).toThrow(/JSON/);
    expect(() => parseCaltopoGeoJson('{"type":"Feature"}', project)).toThrow(/FeatureCollection/);
  });
});

describe('GPX import', () => {
  const pt = (lon: number, lat: number, t: number | null) => `<trkpt lat="${lat}" lon="${lon}">${t === null ? '' : `<time>${new Date(t).toISOString()}</time>`}</trkpt>`;
  const gpx = (...segs: string[][]) => `<?xml version="1.0"?><gpx version="1.1"><trk><name>Team 2</name>${segs.map((s) => `<trkseg>${s.join('')}</trkseg>`).join('')}</trk></gpx>`;

  it('keeps each segment as its own track', () => {
    const r = parseGpx(gpx([pt(0, 0, T), pt(0.06, 0, T + 60_000)], [pt(1, 1, T + 600_000), pt(1, 1.03, T + 630_000)]), project);
    expect(r.tracks).toHaveLength(2);
    expect(r.tracks[0]!.points[1]).toEqual({ x: 60, y: 0, t: T + 60_000 });
    expect(r.skipped).toEqual([]);
  });

  it('skips a segment with an untimed point instead of guessing', () => {
    const r = parseGpx(gpx([pt(0, 0, T), pt(0.06, 0, null)]), project);
    expect(r.tracks).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/no valid time/);
  });

  it('flags impossible speeds through the track report', () => {
    const r = parseGpx(gpx([pt(0, 0, T), pt(1, 0, T + 10_000)]), project);
    expect(r.tracks[0]!.report.quality).toBe('suspect');
  });

  it('marks a track whose median speed is above ground pace as likely aircraft', () => {
    // 250 m every 10 s = 25 m/s (90 km/h), like a helicopter search pattern.
    const r = parseGpx(gpx(Array.from({ length: 6 }, (_, i) => pt(i * 0.25, 0, T + i * 10_000))), project);
    expect(r.tracks[0]!.likelyAircraft).toBe(true);
  });
});

describe('parseSearchFile', () => {
  it('chooses the parser from the content', () => {
    expect(parseSearchFile('  {"type":"FeatureCollection","features":[]}', project).tracks).toEqual([]);
    expect(parseSearchFile('<gpx></gpx>', project).skipped[0]!.reason).toMatch(/no track segments/);
    expect(() => parseSearchFile('a,b,c', project)).toThrow(/unrecognised/);
  });
});

describe('assignment outlines from real CalTopo maps', () => {
  // Square units of 100 m so areas are easy to check by hand.
  const k = (a: number[][]) => a.map(([x, y]) => [x! / 10, y! / 10]);
  const asg = (id: string, ring: number[][]) => ({ id, type: 'Feature', geometry: { type: 'Polygon', coordinates: [k(ring)] }, properties: { class: 'Assignment' } });

  it('drops repeated vertices left by snapping to a trail', () => {
    const r = parseCaltopoGeoJson(fc([asg('a', [[0, 0], [4, 0], [4, 0], [4, 4], [4, 4], [0, 4], [0, 0]])]), project);
    expect(r.assignments[0]!.area).toHaveLength(4);
    expect(r.assignments[0]!.selfCrossing).toBe(false);
  });

  it('accepts an outline that crosses itself without losing area, and says so', () => {
    // The top edge doubles back into a small twisted ear; every point keeps winding ±1.
    const ear = [[0, 0], [4, 0], [4, 4], [2, 4], [3, 5], [3, 4.5], [1, 4.5], [1.5, 3.8], [0, 4], [0, 0]];
    const r = parseCaltopoGeoJson(fc([asg('ear', ear)]), project);
    expect(r.skipped).toEqual([]);
    expect(r.assignments[0]!.selfCrossing).toBe(true);
  });

  it('rejects an outline that overlaps itself, naming the area it would lose', () => {
    // Goes round the 400 m square, then round the inner 200 m square again: the inner
    // square has winding 2, so the even-odd fill would drop 200 m × 200 m = 40 000 m².
    const wrap = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 1], [3, 1], [3, 3], [1, 3], [1, 0.5], [0, 0]];
    const pts = k(wrap).slice(0, -1).map(([x, y]) => project(x!, y!));
    expect(selfOverlapArea(pts)).toBe(40_000);
    const r = parseCaltopoGeoJson(fc([asg('wrap', wrap)]), project);
    expect(r.assignments).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/drop about 40000 m²/);
  });
});

describe('segmentTrack', () => {
  // One point every 5 s along x. Hand-built legs: walk, drive, stand, walk.
  function legs(spec: Array<[seconds: number, metresPerSecond: number]>) {
    const pts = [{ x: 0, y: 0, t: T }];
    for (const [secs, v] of spec) for (let i = 0; i < secs / 5; i++) {
      const p = pts[pts.length - 1]!;
      pts.push({ x: p.x + v * 5, y: 0, t: p.t + 5000 });
    }
    return pts;
  }

  it('keeps walking, and leaves out sustained driving and standing still', () => {
    const { segments, movement } = segmentTrack(legs([[600, 1], [300, 10], [300, 0], [600, 1]]));
    expect(segments).toHaveLength(2);
    // Run edges blur by up to half the 60 s window.
    expect(movement.vehicleS).toBeGreaterThan(240);
    expect(movement.vehicleS).toBeLessThan(360);
    expect(movement.stationaryS).toBeGreaterThan(240);
    expect(movement.stationaryS).toBeLessThan(360);
    expect(movement.onFootS + movement.vehicleS + movement.stationaryS).toBeCloseTo(1800, 6);
    // No kept segment contains a driving step.
    for (const seg of segments) for (let i = 1; i < seg.length; i++) expect(seg[i]!.x - seg[i - 1]!.x).toBeLessThan(50);
  });

  it('keeps a short pause as part of the walk', () => {
    const { segments, movement } = segmentTrack(legs([[600, 1], [30, 0], [600, 1]]));
    expect(segments).toHaveLength(1);
    expect(movement.stationaryS).toBe(0);
  });

  it('counts nothing for a device that never moved', () => {
    const { segments, movement } = segmentTrack(legs([[900, 0]]));
    expect(segments).toEqual([]);
    expect(movement.onFootS).toBe(0);
  });
});
