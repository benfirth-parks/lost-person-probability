import type { Distribution } from '../../../packages/probability-engine/src/index.ts';
import { elevation, grid, landMask } from '../../../packages/exercises/alpine-ex-01.ts';

/** Colour-blind-safe sequential ramp (cividis-like); low = dark blue, high = yellow. No red–green. */
const RAMP: Array<[number, number, number]> = [
  [0, 32, 77], [36, 61, 112], [87, 92, 109], [124, 123, 120], [166, 157, 117], [208, 192, 103], [253, 234, 69],
];
export const RAMP_CSS = `linear-gradient(90deg, ${[...RAMP].reverse().map(([r, g, b]) => `rgb(${r},${g},${b})`).join(', ')})`;
export const DECADES = 4;

export function ramp(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP[i]!;
  const b = RAMP[i + 1]!;
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
}

const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** Row 0 of the grid is the south edge; canvas row 0 is the top. */
const pixel = (i: number) => {
  const col = i % grid.cols;
  const row = Math.floor(i / grid.cols);
  return ((grid.rows - 1 - row) * grid.cols + col) * 4;
};

let hillshadeCache: HTMLCanvasElement | null = null;
export function hillshade(): HTMLCanvasElement {
  if (hillshadeCache) return hillshadeCache;
  const c = canvas(grid.cols, grid.rows);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(grid.cols, grid.rows);
  for (let r = 0; r < grid.rows; r++)
    for (let col = 0; col < grid.cols; col++) {
      const i = r * grid.cols + col;
      const ex = elevation[r * grid.cols + Math.min(grid.cols - 1, col + 1)]! - elevation[r * grid.cols + Math.max(0, col - 1)]!;
      const ey = elevation[Math.min(grid.rows - 1, r + 1) * grid.cols + col]! - elevation[Math.max(0, r - 1) * grid.cols + col]!;
      const shade = Math.max(0, Math.min(1, 0.55 + (-ex + ey) / 60));
      const tint = (elevation[i]! - 1400) / 900;
      const g = 120 + 120 * shade - 25 * tint;
      img.data.set(landMask[i] ? [g * 0.97, g * 0.99, g * 0.94, 255] : [96, 140, 170, 255], pixel(i));
    }
  ctx.putImageData(img, 0, 0);
  return (hillshadeCache = c);
}

/** Probability per cell on a log scale spanning DECADES below the maximum. */
export function probabilityImage(d: Distribution): { canvas: HTMLCanvasElement; max: number } {
  let max = 0;
  for (const v of d.values) if (v > max) max = v;
  const c = canvas(grid.cols, grid.rows);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(grid.cols, grid.rows);
  const lo = max / 10 ** DECADES;
  for (let i = 0; i < d.values.length; i++) {
    const v = d.values[i]!;
    if (v <= lo) continue;
    const t = Math.log10(v / lo) / DECADES;
    const [r, g, b] = ramp(t);
    img.data.set([r, g, b, 25 + 210 * t], pixel(i));
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, max };
}

/** Small preview: hillshade with either the surface or the change from `from` (orange gained, blue lost). */
export function miniImage(d: Distribution, scaleTo: number, from?: Distribution): string {
  const c = canvas(grid.cols, grid.rows);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(hillshade(), 0, 0);
  const img = ctx.getImageData(0, 0, grid.cols, grid.rows);
  const lo = scaleTo / 10 ** DECADES;
  let maxDiff = 0;
  if (from) for (let i = 0; i < d.values.length; i++) maxDiff = Math.max(maxDiff, Math.abs(d.values[i]! - from.values[i]!));
  for (let i = 0; i < d.values.length; i++) {
    let rgb: [number, number, number];
    let a: number;
    if (from) {
      const dv = d.values[i]! - from.values[i]!;
      const t = maxDiff ? Math.sqrt(Math.abs(dv) / maxDiff) : 0;
      if (t < 0.03) continue;
      rgb = dv > 0 ? [217, 119, 6] : [37, 99, 235];
      a = 0.9 * t;
    } else {
      const v = d.values[i]!;
      if (v <= lo) continue;
      const t = Math.log10(v / lo) / DECADES;
      rgb = ramp(t);
      a = (25 + 210 * t) / 255;
    }
    const o = pixel(i);
    for (let k = 0; k < 3; k++) img.data[o + k] = img.data[o + k]! * (1 - a) + rgb[k]! * a;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}
