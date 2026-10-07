import { Map as MlMap, NavigationControl, ScaleControl, setWorkerUrl, type GeoJSONSource, type ImageSource, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useEffect, useRef } from 'react';
import { cellIndexAt, cleanTrack, splitAtGaps, type Distribution, type Point } from '../../../packages/probability-engine/src/index.ts';
import { cliff, creek, grid, IPP, lake, trail, type ExerciseAssignment, type ExerciseClue } from '../../../packages/exercises/alpine-ex-01.ts';
import { gridCorners, lngLatToLocal, localToLngLat } from '../../lib/georef.ts';
import { hpdMask } from './model.ts';
import { hillshade, probabilityImage } from './raster.ts';

export interface Layers {
  prob: boolean;
  hpd: boolean;
  features: boolean;
  clues: boolean;
  search: boolean;
}

interface Props {
  surface: Distribution;
  layers: Layers;
  clues: ExerciseClue[];
  assignments: ExerciseAssignment[];
  find: Point | null;
  onHover: (cell: number) => void;
  onScale: (max: number) => void;
}

// Bundle MapLibre's worker with the app so the map works offline and from any base path.
setWorkerUrl(workerUrl);

type Geo = GeoJSON.FeatureCollection;
const line = (pts: Point[], props: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'LineString', coordinates: pts.map(localToLngLat) },
});
const point = (p: Point, props: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'Point', coordinates: localToLngLat(p) },
});
const ring = (pts: Point[], props: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]!].map(localToLngLat)] },
});
const circle = (c: Point, r: number, n = 48) => Array.from({ length: n }, (_, k) => ({ x: c.x + r * Math.cos((2 * Math.PI * k) / n), y: c.y + r * Math.sin((2 * Math.PI * k) / n) }));

function featuresGeo(): Geo {
  const lakeRing = Array.from({ length: 64 }, (_, k) => ({ x: lake.cx + lake.rx * Math.cos((2 * Math.PI * k) / 64), y: lake.cy + lake.ry * Math.sin((2 * Math.PI * k) / 64) }));
  return {
    type: 'FeatureCollection',
    features: [
      line(trail, { kind: 'trail' }),
      line(creek, { kind: 'creek' }),
      line(cliff, { kind: 'cliff' }),
      ring(lakeRing, { kind: 'lake' }),
      ring(circle(IPP, 120), { kind: 'ipp-uncertainty' }),
      point(IPP, { kind: 'ipp' }),
    ],
  };
}

function cluesGeo(clues: ExerciseClue[]): Geo {
  return {
    type: 'FeatureCollection',
    features: clues.flatMap((c) => {
      const area =
        c.template === 'point'
          ? ring(circle(c.location, 2 * c.sigmaM!), { id: c.id })
          : ring(
              [c.location, ...Array.from({ length: 17 }, (_, k) => {
                const b = ((c.bearingDeg! - c.halfAngleDeg! + (2 * c.halfAngleDeg! * k) / 16) * Math.PI) / 180;
                return { x: c.location.x + c.rangeM! * Math.sin(b), y: c.location.y + c.rangeM! * Math.cos(b) };
              })],
              { id: c.id },
            );
      return [area, point(c.location, { id: c.id, kind: 'clue' })];
    }),
  };
}

function searchGeo(assignments: ExerciseAssignment[]): Geo {
  return {
    type: 'FeatureCollection',
    features: assignments.flatMap((a) => [
      ring(a.area, { id: a.id, kind: 'area' }),
      ...splitAtGaps(cleanTrack(a.track).points).map((part) => line(part, { id: a.id, kind: 'track' })),
    ]),
  };
}

/** Outline of a cell mask as line segments along cell edges. */
function maskOutline(mask: Uint8Array, level: string): GeoJSON.Feature[] {
  if (!mask.length) return [];
  const segs: [number, number][][] = [];
  const cs = grid.cellSize;
  const at = (c: number, r: number) => localToLngLat({ x: grid.originX + c * cs, y: grid.originY + r * cs });
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const c = i % grid.cols;
    const r = Math.floor(i / grid.cols);
    if (c === 0 || !mask[i - 1]) segs.push([at(c, r), at(c, r + 1)]);
    if (c === grid.cols - 1 || !mask[i + 1]) segs.push([at(c + 1, r), at(c + 1, r + 1)]);
    if (r === 0 || !mask[i - grid.cols]) segs.push([at(c, r), at(c + 1, r)]);
    if (r === grid.rows - 1 || !mask[i + grid.cols]) segs.push([at(c, r + 1), at(c + 1, r + 1)]);
  }
  return [{ type: 'Feature', properties: { level }, geometry: { type: 'MultiLineString', coordinates: segs } }];
}

function hoverGeo(cell: number): Geo {
  if (cell < 0) return { type: 'FeatureCollection', features: [] };
  const c = cell % grid.cols;
  const r = Math.floor(cell / grid.cols);
  const x = grid.originX + c * grid.cellSize;
  const y = grid.originY + r * grid.cellSize;
  return { type: 'FeatureCollection', features: [ring([{ x, y }, { x: x + grid.cellSize, y }, { x: x + grid.cellSize, y: y + grid.cellSize }, { x, y: y + grid.cellSize }])] };
}

const empty: Geo = { type: 'FeatureCollection', features: [] };

/**
 * MapLibre workspace map. No external basemap, tiles, glyphs or sprites are
 * requested: the terrain shade and every overlay are drawn locally, so no
 * incident geometry leaves the browser.
 */
export function MapView({ surface, layers, clues, assignments, find, onHover, onScale }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const latest = useRef({ surface, layers, clues, assignments, find });
  latest.current = { surface, layers, clues, assignments, find };

  const sync = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { surface: s, layers: l, clues: c, assignments: a, find: f } = latest.current;
    const { canvas, max } = probabilityImage(s);
    onScale(max);
    (m.getSource('prob') as ImageSource).updateImage({ url: canvas.toDataURL(), coordinates: gridCorners(grid) });
    (m.getSource('hpd') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [...maskOutline(hpdMask(s, 0.5), '50'), ...maskOutline(hpdMask(s, 0.8), '80')] });
    (m.getSource('clues') as GeoJSONSource).setData(cluesGeo(c));
    (m.getSource('search') as GeoJSONSource).setData(searchGeo(a));
    (m.getSource('find') as GeoJSONSource).setData(f ? { type: 'FeatureCollection', features: [point(f)] } : empty);
    const vis = (on: boolean) => (on ? 'visible' : 'none');
    m.setLayoutProperty('prob', 'visibility', vis(l.prob));
    m.setLayoutProperty('hpd-50', 'visibility', vis(l.hpd));
    m.setLayoutProperty('hpd-80', 'visibility', vis(l.hpd));
    for (const id of ['trail', 'creek', 'cliff', 'lake', 'ipp-ring', 'ipp']) m.setLayoutProperty(id, 'visibility', vis(l.features));
    for (const id of ['clue-area', 'clue-pt']) m.setLayoutProperty(id, 'visibility', vis(l.clues));
    for (const id of ['area', 'track']) m.setLayoutProperty(id, 'visibility', vis(l.search));
  };

  useEffect(() => {
    const corners = gridCorners(grid);
    const lngs = corners.map((c) => c[0]);
    const lats = corners.map((c) => c[1]);
    const m = new MlMap({
      container: box.current!,
      style: {
        version: 8,
        sources: {
          hill: { type: 'image', url: hillshade().toDataURL(), coordinates: corners },
          prob: { type: 'image', url: hillshade().toDataURL(), coordinates: corners },
          features: { type: 'geojson', data: featuresGeo() },
          hpd: { type: 'geojson', data: empty },
          clues: { type: 'geojson', data: empty },
          search: { type: 'geojson', data: empty },
          find: { type: 'geojson', data: empty },
          hover: { type: 'geojson', data: empty },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#d9dfdd' } },
          { id: 'hill', type: 'raster', source: 'hill', paint: { 'raster-fade-duration': 0 } },
          { id: 'prob', type: 'raster', source: 'prob', paint: { 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } },
          { id: 'lake', type: 'fill', source: 'features', filter: ['==', ['get', 'kind'], 'lake'], paint: { 'fill-color': '#5f8caa' } },
          { id: 'creek', type: 'line', source: 'features', filter: ['==', ['get', 'kind'], 'creek'], paint: { 'line-color': '#2f6f9a', 'line-width': 2 } },
          { id: 'trail', type: 'line', source: 'features', filter: ['==', ['get', 'kind'], 'trail'], paint: { 'line-color': '#7a3b12', 'line-width': 2.2, 'line-dasharray': [3, 1.5] } },
          { id: 'cliff', type: 'line', source: 'features', filter: ['==', ['get', 'kind'], 'cliff'], paint: { 'line-color': '#3a2a22', 'line-width': 4 } },
          { id: 'ipp-ring', type: 'line', source: 'features', filter: ['==', ['get', 'kind'], 'ipp-uncertainty'], paint: { 'line-color': '#1d2a33', 'line-width': 1 } },
          { id: 'ipp', type: 'circle', source: 'features', filter: ['==', ['get', 'kind'], 'ipp'], paint: { 'circle-color': '#c2410c', 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } },
          { id: 'hpd-80', type: 'line', source: 'hpd', filter: ['==', ['get', 'level'], '80'], paint: { 'line-color': '#1d2a33', 'line-width': 1.5, 'line-dasharray': [3, 2] } },
          { id: 'hpd-50', type: 'line', source: 'hpd', filter: ['==', ['get', 'level'], '50'], paint: { 'line-color': '#1d2a33', 'line-width': 1.8 } },
          { id: 'area', type: 'line', source: 'search', filter: ['==', ['get', 'kind'], 'area'], paint: { 'line-color': '#4c1d95', 'line-width': 1.2, 'line-dasharray': [1, 1.5] } },
          { id: 'track', type: 'line', source: 'search', filter: ['==', ['get', 'kind'], 'track'], paint: { 'line-color': '#7c3aed', 'line-width': 1.4 } },
          { id: 'clue-area', type: 'line', source: 'clues', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#be185d', 'line-width': 1.4, 'line-dasharray': [2, 2] } },
          { id: 'clue-pt', type: 'circle', source: 'clues', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': '#be185d', 'circle-radius': 4.5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } },
          { id: 'hover', type: 'line', source: 'hover', paint: { 'line-color': '#1d2a33', 'line-width': 1.5 } },
          { id: 'find', type: 'circle', source: 'find', paint: { 'circle-color': '#dc2626', 'circle-radius': 7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } },
        ],
      },
      bounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
      fitBoundsOptions: { padding: 8 },
      attributionControl: false,
      maxPitch: 0,
      dragRotate: false,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    let lastCell = -2;
    const hover = (e: MapMouseEvent) => {
      const p = lngLatToLocal(e.lngLat.lng, e.lngLat.lat);
      const cell = cellIndexAt(grid, p);
      if (cell === lastCell) return;
      lastCell = cell;
      (m.getSource('hover') as GeoJSONSource | undefined)?.setData(hoverGeo(cell));
      onHover(cell);
    };
    m.on('mousemove', hover);
    m.on('click', hover);
    m.on('load', () => {
      ready.current = true;
      sync();
    });
    map.current = m;
    return () => {
      ready.current = false;
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(sync, [surface, layers, clues, assignments, find]);

  return <div ref={box} className="map" role="img" aria-label="Probability map of the exercise area. Use the inspector and tables for numeric values." />;
}
