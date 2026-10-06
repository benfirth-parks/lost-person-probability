import proj4 from 'proj4';
import type { Grid, Point } from '../../packages/geospatial/src/grid.ts';

/**
 * Georeference for the authored exercise: its local metre grid is placed in
 * UTM zone 11N so MapLibre can draw it. Projection happens here, in the
 * browser, with no external service.
 */
const UTM11 = '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs';
export const EXERCISE_OFFSET = { e: 590000, n: 5660000 };

const fwd = proj4(UTM11, 'WGS84');

export function localToLngLat(p: Point): [number, number] {
  const [lng, lat] = fwd.forward([p.x + EXERCISE_OFFSET.e, p.y + EXERCISE_OFFSET.n]);
  return [lng!, lat!];
}

export function lngLatToLocal(lng: number, lat: number): Point {
  const [e, n] = fwd.inverse([lng, lat]);
  return { x: e! - EXERCISE_OFFSET.e, y: n! - EXERCISE_OFFSET.n };
}

/** Corner coordinates (top-left, top-right, bottom-right, bottom-left) for a MapLibre image source over the grid. */
export function gridCorners(g: Grid): [[number, number], [number, number], [number, number], [number, number]] {
  const x0 = g.originX;
  const y0 = g.originY;
  const x1 = x0 + g.cols * g.cellSize;
  const y1 = y0 + g.rows * g.cellSize;
  return [localToLngLat({ x: x0, y: y1 }), localToLngLat({ x: x1, y: y1 }), localToLngLat({ x: x1, y: y0 }), localToLngLat({ x: x0, y: y0 })];
}
