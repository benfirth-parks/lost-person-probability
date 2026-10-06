import { describe, expect, it } from 'vitest';
import { parseCaltopoGeoJson } from '../../../packages/importers/src/index.ts';
import { filterAvailable } from '../../../packages/probability-engine/src/index.ts';
import { INFORMATION_CUTOFF } from '../../../packages/exercises/alpine-ex-01.ts';
import { DEFAULT_IMPORT_PAIRING, importedAssignments, podFor, shareInsideGrid } from './model.ts';

const local = (lng: number, lat: number) => ({ x: lng, y: lat });
const T = Date.parse('2026-07-18T15:00:00-06:00');

function file(trackTimes: number[]) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { id: 'area', type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[2600, 2500], [3500, 2500], [3500, 3300], [2600, 3300], [2600, 2500]]] }, properties: { class: 'Assignment', number: '7' } },
      { id: 'trk', type: 'Feature', geometry: { type: 'LineString', coordinates: trackTimes.map((t, i) => [2650 + i * 40, 2900, 0, t]) }, properties: { title: 'Team 7' } },
    ],
  });
}

describe('imported search effort in the workspace', () => {
  it('gives an area with no paired track zero achieved POD, whatever its plan', () => {
    const result = parseCaltopoGeoJson(file([T, T + 60_000]), local);
    const [a] = importedAssignments({ result, pairs: { area: { trackId: null, ...DEFAULT_IMPORT_PAIRING } } });
    const p = podFor(a!, 30);
    expect(p.planned.summaryPod).toBeGreaterThan(0);
    expect(p.achieved.summaryPod).toBe(0);
  });

  it('uses the paired track for achieved POD', () => {
    const result = parseCaltopoGeoJson(file(Array.from({ length: 20 }, (_, i) => T + i * 30_000)), local);
    const [a] = importedAssignments({ result, pairs: { area: { trackId: 'trk', ...DEFAULT_IMPORT_PAIRING } } });
    expect(a!.track).toHaveLength(20);
    expect(podFor(a!, 30).achieved.summaryPod).toBeGreaterThan(0);
    expect(shareInsideGrid(a!.track)).toBe(1);
  });

  it('dates imported effort by the end of its track so the cutoff filter applies', () => {
    const late = Date.parse(INFORMATION_CUTOFF) + 60_000;
    const result = parseCaltopoGeoJson(file([late - 30_000, late]), local);
    const built = importedAssignments({ result, pairs: { area: { trackId: 'trk', ...DEFAULT_IMPORT_PAIRING } } });
    expect(filterAvailable(built, INFORMATION_CUTOFF)).toHaveLength(0);
  });
});
