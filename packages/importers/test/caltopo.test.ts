import { describe, expect, it } from 'vitest';
import { parseCaltopoGeoJson, parseGpx, parseSearchFile } from '../src/index.ts';

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
          properties: { class: 'Assignment', number: '101', title: 'NE bench', status: 'COMPLETED', description: 'Subject Jane Doe last seen here' },
        },
      ]),
      project,
    );
    expect(r.assignments).toHaveLength(1);
    const a = r.assignments[0]!;
    expect(a.label).toBe('101 NE bench');
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
    expect(r.skipped[2]!.reason).toMatch(/intersect/);
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
});

describe('parseSearchFile', () => {
  it('chooses the parser from the content', () => {
    expect(parseSearchFile('  {"type":"FeatureCollection","features":[]}', project).tracks).toEqual([]);
    expect(parseSearchFile('<gpx></gpx>', project).skipped[0]!.reason).toMatch(/no track segments/);
    expect(() => parseSearchFile('a,b,c', project)).toThrow(/unrecognised/);
  });
});
