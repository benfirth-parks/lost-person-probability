import { describe, expect, it } from 'vitest';
import { insideCoverage, REACH_M, tilesFor, type RidgeIndex } from './ridges.ts';

const INDEX: RidgeIndex = {
  version: 'test',
  source: 'test',
  method: 'test',
  tileLat: 0.2,
  tileLng: 0.3,
  south: 49,
  west: -119.4,
  regions: [[50.4, -117, 52.2, -114.8]],
  tiles: ['11_12', '11_13', '11_14', '10_13', '12_13'],
};

describe('ridge tiles', () => {
  it('picks the tile holding the point and the neighbours within the ring plus reach', () => {
    // Tile 11_13 spans 51.2–51.4° and −115.5 to −115.2°; its middle is 11 km from the north and south edges
    // and 0.15° · 111.32 km · cos(51.3°) = 10.4 km from the east and west edges, more than the 6 km reach.
    expect(REACH_M).toBe(6000);
    expect(tilesFor(INDEX, 51.3, -115.35, 0)).toEqual(['11_13']);
    // A 10 km ring plus the reach crosses into all four neighbours.
    expect(tilesFor(INDEX, 51.3, -115.35, 10_000).sort()).toEqual(['10_13', '11_12', '11_13', '11_14', '12_13']);
  });

  it('says whether a point is inside the parks the tiles cover', () => {
    expect(insideCoverage(INDEX, 51.2, -115.5)).toBe(true);
    expect(insideCoverage(INDEX, 49.5, -113)).toBe(false);
  });
});
