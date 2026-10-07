/**
 * Terrain lines bundled with the site (built by scripts/terrain/extract_canvec.py
 * into public/terrain/). Tiles are fetched from this site only; the planning
 * point never leaves the browser.
 */
export interface TerrainIndex {
  source: string;
  tileLat: number;
  tileLng: number;
  south: number;
  west: number;
  north: number;
  east: number;
  tiles: string[];
}

export type TerrainKind = 'stream' | 'lake' | 'road' | 'trail';
type Tile = Partial<Record<TerrainKind, [number, number][][]>>;

export interface TerrainLines {
  source: string;
  lines: { lng: number; lat: number }[][];
  counts: Record<TerrainKind, number>;
}

const M_PER_DEG = 111_320;

/** Tile keys ("i_j") whose cells overlap the box around a circle of `radiusM`. */
export function tilesFor(index: TerrainIndex, lat: number, lng: number, radiusM: number): string[] {
  const dLat = radiusM / M_PER_DEG;
  const dLng = radiusM / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  const i0 = Math.floor((lat - dLat - index.south) / index.tileLat);
  const i1 = Math.floor((lat + dLat - index.south) / index.tileLat);
  const j0 = Math.floor((lng - dLng - index.west) / index.tileLng);
  const j1 = Math.floor((lng + dLng - index.west) / index.tileLng);
  const have = new Set(index.tiles);
  const out: string[] = [];
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (have.has(`${i}_${j}`)) out.push(`${i}_${j}`);
  return out;
}

export const insideCoverage = (index: TerrainIndex, lat: number, lng: number) =>
  lat >= index.south && lat <= index.north && lng >= index.west && lng <= index.east;

/** Lines whose bounding box overlaps the box around the circle, so the splitter does less work. */
function nearby(line: [number, number][], lat: number, lng: number, radiusM: number): boolean {
  const dLat = (radiusM * 1.05) / M_PER_DEG;
  const dLng = (radiusM * 1.05) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  const xs = line.map((p) => p[0]);
  const ys = line.map((p) => p[1]);
  return Math.min(...xs) <= lng + dLng && Math.max(...xs) >= lng - dLng && Math.min(...ys) <= lat + dLat && Math.max(...ys) >= lat - dLat;
}

export async function loadTerrainIndex(base = import.meta.env.BASE_URL): Promise<TerrainIndex> {
  const r = await fetch(`${base}terrain/index.json`);
  if (!r.ok) throw new Error('terrain data is not available on this site');
  return (await r.json()) as TerrainIndex;
}

export async function loadTerrainLines(index: TerrainIndex, lat: number, lng: number, radiusM: number, base = import.meta.env.BASE_URL): Promise<TerrainLines> {
  const counts: Record<TerrainKind, number> = { stream: 0, lake: 0, road: 0, trail: 0 };
  const lines: TerrainLines['lines'] = [];
  const tiles = await Promise.all(
    tilesFor(index, lat, lng, radiusM).map(async (k) => {
      const r = await fetch(`${base}terrain/${k}.json`);
      if (!r.ok) throw new Error(`terrain tile ${k} could not be loaded`);
      return (await r.json()) as Tile;
    }),
  );
  const seen = new Set<string>();
  for (const t of tiles) {
    for (const kind of Object.keys(counts) as TerrainKind[]) {
      for (const l of t[kind] ?? []) {
        // A line crossing a tile edge is stored in each tile it touches.
        const key = JSON.stringify([l[0], l[l.length - 1], l.length]);
        if (seen.has(key) || !nearby(l, lat, lng, radiusM)) continue;
        seen.add(key);
        lines.push(l.map(([x, y]) => ({ lng: x, lat: y })));
        counts[kind]++;
      }
    }
  }
  return { source: index.source, lines, counts };
}
