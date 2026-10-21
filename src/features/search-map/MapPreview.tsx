import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import { localFrame, type CaltopoFeature, type SearchMap, type SearchMapInput } from '../../../packages/caltopo-export/src/index.ts';

/**
 * Live map of the file the generator will write, redrawn as the form changes:
 * rings, dispersion wedges, area and trail segments with their titles, over a
 * hillshade bundled with the site (public/terrain/shade/, built by
 * scripts/terrain/build_hillshade.py). Shade images come from this site only;
 * nothing about the planning point is sent anywhere else.
 *
 * Drawn in metres east and north of the planning point (the same flat frame the
 * trail and area segments are cut in), north up.
 */

interface ShadeIndex {
  tiles: string[];
  south: number;
  west: number;
  tileLat: number;
  tileLng: number;
  source: string;
}

type Kind = 'ring' | 'wedge' | 'area' | 'sector' | 'trail';
interface Shape {
  id: string;
  kind: Kind;
  title: string;
  /** SVG path in metres, y down. */
  d: string;
  /** Box in metres, y down. */
  box: { x0: number; y0: number; x1: number; y1: number };
  label: { x: number; y: number };
  areaKm2?: number;
  pod?: string;
}

const LAYERS = [
  ['shade', 'Terrain shading'],
  ['ring', 'Range rings'],
  ['wedge', 'Dispersion'],
  ['segments', 'Area segments'],
  ['trail', 'Trail segments'],
  ['labels', 'Titles'],
] as const;
type Layer = (typeof LAYERS)[number][0];

/** Most shade tiles drawn at once; zoomed further out, shading is hidden. */
const MAX_SHADE_TILES = 36;

let shadeIndex: Promise<ShadeIndex | null> | null = null;
function loadShadeIndex(): Promise<ShadeIndex | null> {
  shadeIndex ??= fetch(`${import.meta.env.BASE_URL}terrain/shade/index.json`)
    .then((r) => (r.ok ? (r.json() as Promise<ShadeIndex>) : null))
    .catch(() => null);
  return shadeIndex;
}

function kindOf(f: CaltopoFeature): Kind | null {
  const t = String(f.properties.title ?? '');
  if (f.geometry?.type === 'LineString') return 'ring';
  if (f.geometry?.type !== 'Polygon') return null;
  if (f.properties.class !== 'Assignment') return 'wedge';
  if (t.startsWith('T-')) return 'trail';
  if (t.startsWith('A-')) return 'area';
  return 'sector';
}

const ringArea = (r: { x: number; y: number }[]) => {
  let s = 0;
  for (let i = 1; i < r.length; i++) s += r[i - 1]!.x * r[i]!.y - r[i]!.x * r[i - 1]!.y;
  return s / 2;
};

/** A point inside the outer ring for the title: the middle of the widest run across the middle row. */
function labelPoint(r: { x: number; y: number }[]): { x: number; y: number } {
  const ys = r.map((p) => p.y);
  const y = (Math.min(...ys) + Math.max(...ys)) / 2;
  const xs: number[] = [];
  for (let i = 1; i < r.length; i++) {
    const a = r[i - 1]!;
    const b = r[i]!;
    if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
  }
  xs.sort((p, q) => p - q);
  let best = { x: r[0]!.x, y: r[0]!.y };
  let w = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1]! - xs[i]! > w) {
      w = xs[i + 1]! - xs[i]!;
      best = { x: (xs[i]! + xs[i + 1]!) / 2, y };
    }
  }
  return best;
}

function niceDistance(m: number): number {
  const p = 10 ** Math.floor(Math.log10(m));
  return [5, 2, 1].map((k) => k * p).find((v) => v <= m) ?? p;
}

export function MapPreview({ map, input }: { map: SearchMap; input: SearchMapInput }) {
  const pp = input.planningPoint;
  const frame = useMemo(() => localFrame(pp), [pp.lat, pp.lng]);
  const maxR = Math.max(...input.rings.map((r) => r.distanceKm * 1000));

  const shapes = useMemo<Shape[]>(() => {
    const out: Shape[] = [];
    for (const f of map.features) {
      const kind = kindOf(f);
      if (!kind || !f.geometry) continue;
      const rings = f.geometry.type === 'Polygon' ? f.geometry.coordinates : [(f.geometry as { coordinates: number[][] }).coordinates];
      const xy = rings.map((r) => r.map((c) => {
        const p = frame.toXY({ lng: c[0]!, lat: c[1]! });
        return { x: p.x, y: -p.y };
      }));
      const outer = xy[0]!;
      const d = xy.map((r) => `M${r.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}${kind === 'ring' ? '' : 'Z'}`).join('');
      const xs = outer.map((p) => p.x);
      const ys = outer.map((p) => p.y);
      const p = f.properties;
      out.push({
        id: f.id,
        kind,
        title: String(p.title ?? ''),
        d,
        box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
        label: kind === 'ring' ? { x: 0, y: Math.min(...ys) } : labelPoint(outer),
        areaKm2: kind === 'ring' ? undefined : Math.abs(xy.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * Math.abs(ringArea(r)), 0)) / 1e6,
        pod: p.responsivePOD ? `${p.resourceType ?? ''} POD ${p.responsivePOD}`.trim() : undefined,
      });
    }
    return out;
  }, [map, frame]);

  // View: centre and width in metres. Reset when the planning point or outer ring changes.
  const fit = () => ({ cx: 0, cy: 0, w: maxR * 2.3 });
  const [view, setView] = useState(fit);
  useEffect(() => setView(fit()), [pp.lat, pp.lng, maxR]);
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ shade: true, ring: true, wedge: true, segments: true, trail: true, labels: true });
  const [hover, setHover] = useState<Shape | null>(null);
  const [full, setFull] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [px, setPx] = useState({ w: 600, h: 600 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setPx({ w: e!.contentRect.width, h: e!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [full]);
  const h = (view.w * px.h) / px.w;
  const mPerPx = view.w / px.w;
  const vb = { x: view.cx - view.w / 2, y: view.cy - h / 2, w: view.w, h };

  // Hillshade tiles in view.
  const [shade, setShade] = useState<ShadeIndex | null>(null);
  useEffect(() => {
    let live = true;
    loadShadeIndex().then((s) => live && setShade(s));
    return () => {
      live = false;
    };
  }, []);
  const shadeTiles = useMemo(() => {
    if (!shade || !layers.shade) return [];
    const a = frame.toLngLat({ x: vb.x, y: -(vb.y + vb.h) });
    const b = frame.toLngLat({ x: vb.x + vb.w, y: -vb.y });
    const i0 = Math.floor((a.lat - shade.south) / shade.tileLat);
    const i1 = Math.floor((b.lat - shade.south) / shade.tileLat);
    const j0 = Math.floor((a.lng - shade.west) / shade.tileLng);
    const j1 = Math.floor((b.lng - shade.west) / shade.tileLng);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_SHADE_TILES) return [];
    const have = new Set(shade.tiles);
    const out: { key: string; x: number; y: number; w: number; h: number }[] = [];
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const key = `${i}_${j}`;
        if (!have.has(key)) continue;
        const sw = frame.toXY({ lat: shade.south + i * shade.tileLat, lng: shade.west + j * shade.tileLng });
        const ne = frame.toXY({ lat: shade.south + (i + 1) * shade.tileLat, lng: shade.west + (j + 1) * shade.tileLng });
        out.push({ key, x: sw.x, y: -ne.y, w: ne.x - sw.x, h: ne.y - sw.y });
      }
    return out;
  }, [shade, layers.shade, frame, vb.x, vb.y, vb.w, vb.h]);

  // Pan by dragging, zoom with the wheel about the pointer.
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, cx: d.cx - (e.clientX - d.x) * mPerPx, cy: d.cy - (e.clientY - d.y) * mPerPx }));
  };
  const onUp = () => {
    drag.current = null;
  };
  const zoom = (k: number, at?: { x: number; y: number }) =>
    setView((v) => {
      const w = Math.min(Math.max(v.w * k, 200), maxR * 20);
      const ax = at?.x ?? v.cx;
      const ay = at?.y ?? v.cy;
      return { w, cx: ax + (v.cx - ax) * (w / v.w), cy: ay + (v.cy - ay) * (w / v.w) };
    });
  const onWheel = (e: RWheelEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const at = { x: vb.x + ((e.clientX - r.left) / r.width) * vb.w, y: vb.y + ((e.clientY - r.top) / r.height) * vb.h };
    zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, at);
  };
  useEffect(() => {
    // React's wheel listener is passive; stop the page scrolling while zooming the map.
    const el = box.current?.querySelector('svg');
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, [full]);

  const show = (s: Shape) => (s.kind === 'area' || s.kind === 'sector' ? layers.segments : s.kind === 'trail' ? layers.trail : layers[s.kind]);
  const fontM = 11 * mPerPx;
  const scale = niceDistance(view.w / 5);
  const visible = shapes.filter(show);
  const inView = (s: Shape) => s.box.x1 >= vb.x && s.box.x0 <= vb.x + vb.w && s.box.y1 >= vb.y && s.box.y0 <= vb.y + vb.h;

  return (
    <div className={full ? 'sm-map full' : 'sm-map'}>
      <div className="sm-map-bar">
        <button type="button" onClick={() => zoom(1 / 1.5)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoom(1.5)} aria-label="Zoom out">−</button>
        <button type="button" onClick={() => setView(fit())}>Fit</button>
        <button type="button" onClick={() => setFull((x) => !x)}>{full ? 'Close' : 'Full screen'}</button>
        <span className="sm-map-layers">
          {LAYERS.map(([k, label]) => (
            <label key={k}>
              <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((l) => ({ ...l, [k]: e.target.checked }))} /> {label}
            </label>
          ))}
        </span>
      </div>
      <div className="sm-map-view" ref={box}>
        <svg
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          role="img"
          aria-label="Live preview of the CalTopo file: rings, wedges and segments around the planning point, north up"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => {
            onUp();
            setHover(null);
          }}
          onWheel={onWheel}
        >
          {shadeTiles.map((t) => (
            <image key={t.key} href={`${import.meta.env.BASE_URL}terrain/shade/${t.key}.png`} x={t.x} y={t.y} width={t.w} height={t.h} preserveAspectRatio="none" className="shade" />
          ))}
          {visible.map((s) => (
            <path
              key={s.id}
              d={s.d}
              className={`${s.kind}${hover?.id === s.id ? ' hot' : ''}`}
              fillRule="evenodd"
              vectorEffect="non-scaling-stroke"
              onPointerEnter={() => s.kind !== 'ring' && setHover(s)}
              onPointerLeave={() => setHover((h0) => (h0?.id === s.id ? null : h0))}
            />
          ))}
          {layers.labels &&
            visible.filter(inView).map((s) => {
              const wide = (s.box.x1 - s.box.x0) / mPerPx;
              if (s.kind !== 'ring' && wide < 28) return null;
              return (
                <text key={`t-${s.id}`} x={s.label.x} y={s.kind === 'ring' ? s.label.y - fontM * 0.4 : s.label.y} fontSize={fontM} className={`lbl ${s.kind}`} textAnchor="middle" dominantBaseline="middle">
                  {s.title}
                </text>
              );
            })}
          <circle cx={0} cy={0} r={5 * mPerPx} className="pp" />
          <g transform={`translate(${vb.x + 14 * mPerPx} ${vb.y + vb.h - 16 * mPerPx})`} className="scale">
            <line x1={0} y1={0} x2={scale} y2={0} vectorEffect="non-scaling-stroke" />
            <text x={scale / 2} y={-6 * mPerPx} fontSize={fontM} textAnchor="middle">
              {scale >= 1000 ? `${scale / 1000} km` : `${scale} m`}
            </text>
          </g>
          <text x={vb.x + vb.w - 16 * mPerPx} y={vb.y + 18 * mPerPx} fontSize={fontM * 1.2} textAnchor="middle" className="north">N ↑</text>
        </svg>
        {hover && (
          <div className="sm-map-tip" role="status">
            <b>{hover.title}</b>
            {hover.areaKm2 !== undefined && <> · {hover.areaKm2 < 1 ? `${Math.round(hover.areaKm2 * 100)} ha` : `${hover.areaKm2.toFixed(2)} km²`}</>}
            {hover.pod && <> · {hover.pod}</>}
          </div>
        )}
      </div>
      <p className="cap">
        This is the file as it will import into CalTopo, redrawn as you change the form. Drag to move, scroll or use + and − to zoom, and point at a segment for its size.
        {shade && layers.shade ? ` Shading: ${shade.source}.` : ''}
      </p>
    </div>
  );
}
