/**
 * Ridge-and-creek area segments bundled with the site (built by
 * scripts/terrain/build_ridge_segments.py into public/terrain/ridges/). Tiles
 * are fetched from this site only; the planning point never leaves the browser.
 */
export interface RidgeIndex {
  version: string;
  source: string;
  method: string;
  tileLat: number;
  tileLng: number;
  south: number;
  west: number;
  /** Boxes (south, west, north, east) the tiles were built for. */
  regions: [number, number, number, number][];
  tiles: string[];
}

type LngLat = { lng: number; lat: number };
/** One tile: polygons as rings of [lng, lat], outer ring first. */
interface Tile {
  v: string;
  p: [number, number][][][];
}

export interface RidgePolygons {
  source: string;
  polygons: LngLat[][][];
}

const M_PER_DEG = 111_320;
/** Segments are stored in the tile holding their middle, so load this far past the ring to catch ones reaching in. */
export const REACH_M = 6000;

const box = (lat: number, lng: number, radiusM: number) => {
  const dLat = radiusM / M_PER_DEG;
  const dLng = radiusM / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return { s: lat - dLat, n: lat + dLat, w: lng - dLng, e: lng + dLng };
};

/** Tile keys ("i_j") overlapping the box around a circle of `radiusM` plus REACH_M. */
export function tilesFor(index: RidgeIndex, lat: number, lng: number, radiusM: number): string[] {
  const b = box(lat, lng, radiusM + REACH_M);
  const i0 = Math.floor((b.s - index.south) / index.tileLat);
  const i1 = Math.floor((b.n - index.south) / index.tileLat);
  const j0 = Math.floor((b.w - index.west) / index.tileLng);
  const j1 = Math.floor((b.e - index.west) / index.tileLng);
  const have = new Set(index.tiles);
  const out: string[] = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (have.has(`${i}_${j}`)) out.push(`${i}_${j}`);
  return out;
}

export const insideCoverage = (index: RidgeIndex, lat: number, lng: number) => index.regions.some(([s, w, n, e]) => lat >= s && lat <= n && lng >= w && lng <= e);

export async function loadRidgeIndex(base = import.meta.env.BASE_URL): Promise<RidgeIndex> {
  const r = await fetch(`${base}terrain/ridges/index.json`);
  if (!r.ok) throw new Error('ridge segments are not available on this site');
  return (await r.json()) as RidgeIndex;
}

/** Polygons from the tiles around the point whose box reaches within `radiusM`. */
export async function loadRidgePolygons(index: RidgeIndex, lat: number, lng: number, radiusM: number, base = import.meta.env.BASE_URL): Promise<RidgePolygons> {
  const tiles = await Promise.all(
    tilesFor(index, lat, lng, radiusM).map(async (k) => {
      const r = await fetch(`${base}terrain/ridges/${k}.json`);
      if (!r.ok) throw new Error(`ridge tile ${k} could not be loaded`);
      return (await r.json()) as Tile;
    }),
  );
  const b = box(lat, lng, radiusM);
  const polygons: LngLat[][][] = [];
  for (const t of tiles) {
    for (const poly of t.p) {
      const outer = poly[0]!;
      let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
      for (const [x, y] of outer) {
        if (y < s) s = y;
        if (y > n) n = y;
        if (x < w) w = x;
        if (x > e) e = x;
      }
      if (n < b.s || s > b.n || e < b.w || w > b.e) continue;
      polygons.push(poly.map((r) => r.map(([x, y]) => ({ lng: x, lat: y }))));
    }
  }
  return { source: `${index.source}. ${index.method} (${index.version})`, polygons };
}
