import { describe, expect, it } from 'vitest';
import { insideCoverage, tilesFor, type TerrainIndex } from './terrain.ts';

const INDEX: TerrainIndex = { source: 'test', tileLat: 0.2, tileLng: 0.3, south: 49, west: -119, north: 50, east: -118, tiles: ['0_0', '0_1', '1_0', '1_1', '2_2'] };

describe('tilesFor', () => {
  it('picks only the tile holding a small circle well inside it', () => {
    // Tile 0_0 spans 49.0–49.2 N, 119.0–118.7 W.
    expect(tilesFor(INDEX, 49.1, -118.85, 1000)).toEqual(['0_0']);
  });

  it('picks the four tiles around a circle on a shared corner, skipping tiles not in the index', () => {
    expect(tilesFor(INDEX, 49.2, -118.7, 2000)).toEqual(['0_0', '0_1', '1_0', '1_1']);
    expect(tilesFor(INDEX, 49.5, -118.25, 2000)).toEqual(['2_2']);
  });

  it('knows when a point is outside the bundled area', () => {
    expect(insideCoverage(INDEX, 49.5, -118.5)).toBe(true);
    expect(insideCoverage(INDEX, 51, -118.5)).toBe(false);
  });
});
