/**
 * ALPINE-EX-01: an authored training exercise on synthetic terrain.
 *
 * Nothing here is a historical case or a behavioural statistic. Terrain is
 * procedurally generated; distances, sweep widths and clue parameters are
 * exercise values chosen to make the mechanics visible.
 */
import {
  cellCentre,
  cellCount,
  distanceToPolyline,
  makeGrid,
  type DistanceRingTable,
  type Grid,
  type Point,
  type TrackPoint,
} from '../probability-engine/src/index.ts';

export const CASE_CODE = 'ALPINE-EX-01';
export const INFORMATION_CUTOFF = '2026-07-18T16:00:00-06:00';
export const LAST_SEEN_AT = '2026-07-18T09:30:00-06:00';

export const grid: Grid = makeGrid({ crs: 'local-exercise (m)', originX: -2000, originY: -1500, cellSize: 50, cols: 160, rows: 125 });

export const IPP: Point = { x: 800, y: 600 };
export const IPP_SIGMA_M = 60;

export const trail: Point[] = [
  { x: 800, y: 600 }, { x: 1300, y: 950 }, { x: 1750, y: 1250 }, { x: 2250, y: 1600 }, { x: 2700, y: 2050 },
  { x: 3050, y: 2400 }, { x: 3500, y: 2800 }, { x: 3900, y: 3150 }, { x: 4150, y: 3380 },
];
export const creek: Point[] = [
  { x: 1500, y: 4400 }, { x: 1750, y: 3700 }, { x: 2000, y: 3000 }, { x: 2150, y: 2300 }, { x: 2250, y: 1600 },
  { x: 2550, y: 1000 }, { x: 3000, y: 450 }, { x: 3500, y: 0 },
];
export const cliff: Point[] = [{ x: 3300, y: 1150 }, { x: 3900, y: 1450 }, { x: 4600, y: 1650 }, { x: 5600, y: 1800 }];
export const lake = { cx: 4550, cy: 3650, rx: 420, ry: 300 };

function hash2(i: number, j: number): number {
  let h = (i * 374761393 + j * 668265263) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * s(xf) + (c - a) * s(yf) + (a - b - c + d) * s(xf) * s(yf);
}

export const inLake = (p: Point) => ((p.x - lake.cx) / lake.rx) ** 2 + ((p.y - lake.cy) / lake.ry) ** 2 <= 1;

const N = cellCount(grid);
export const elevation = new Float64Array(N);
export const openWater = new Uint8Array(N);
export const cliffCell = new Uint8Array(N);
export const zoneOf = new Uint8Array(N);
export const ZONES = ['Trail corridor', 'Creek drainage', 'North basin', 'East slopes', 'South & west slopes'];

for (let i = 0; i < N; i++) {
  const c = cellCentre(grid, i);
  const dCreek = distanceToPolyline(c, creek);
  let e = 1450 + c.y * 0.12 + Math.abs(c.x - 3000) * 0.05;
  e += 160 * valueNoise(c.x / 900, c.y / 900) + 60 * valueNoise(c.x / 300 + 7, c.y / 300 + 3);
  e -= 70 * Math.exp(-dCreek / 220);
  if (distanceToPolyline(c, cliff) < 60) e += 40;
  elevation[i] = e;
  openWater[i] = inLake(c) ? 1 : 0;
  cliffCell[i] = distanceToPolyline(c, cliff) < 45 ? 1 : 0;
  const dTrail = distanceToPolyline(c, trail);
  zoneOf[i] = dTrail < 200 ? 0 : dCreek < 250 ? 1 : c.y > 3000 ? 2 : c.x > 3000 ? 3 : 4;
}

/** Cells allowed to hold probability: open water excluded (stated modelling choice). */
export const landMask = openWater.map((w) => (w ? 0 : 1));

/** Exercise ring table. Deliberately labelled as not behavioural statistics. */
export const EXERCISE_RINGS: DistanceRingTable = {
  id: 'exercise-rings',
  version: 'ex-1',
  subjectCategory: 'Day hiker (exercise)',
  source: 'Authored exercise values for ALPINE-EX-01. Not derived from any dataset.',
  sampleSize: null,
  region: null,
  period: null,
  status: 'exercise_only',
  breaks: [
    { distanceM: 1000, cumulativeProbability: 0.25 },
    { distanceM: 2000, cumulativeProbability: 0.5 },
    { distanceM: 3200, cumulativeProbability: 0.75 },
    { distanceM: 5000, cumulativeProbability: 0.95 },
  ],
  tailOuterDistanceM: 8000,
};

export type ClueTemplate = 'point' | 'wedge';
export interface ExerciseClue {
  id: string;
  type: string;
  template: ClueTemplate;
  summary: string;
  observedAt: string;
  availableAt: string;
  location: Point;
  sigmaM?: number;
  bearingDeg?: number;
  halfAngleDeg?: number;
  rangeM?: number;
  reliability: number;
  relevance: number;
}

export const CLUES: ExerciseClue[] = [
  {
    id: 'C-01',
    type: 'Witness sighting',
    template: 'point',
    summary: 'Hiker matching the clothing description seen at the creek crossing, walking upstream off the trail.',
    observedAt: '2026-07-18T12:40:00-06:00',
    availableAt: '2026-07-18T14:10:00-06:00',
    location: { x: 2250, y: 1700 },
    sigmaM: 180,
    reliability: 0.7,
    relevance: 0.6,
  },
  {
    id: 'C-02',
    type: 'Directional report',
    template: 'wedge',
    summary: 'Party camped at the lake heard faint calls from roughly due west.',
    observedAt: '2026-07-18T15:20:00-06:00',
    availableAt: '2026-07-18T15:50:00-06:00',
    location: { x: 4100, y: 3500 },
    bearingDeg: 265,
    halfAngleDeg: 25,
    rangeM: 2800,
    reliability: 0.5,
    relevance: 0.5,
  },
  {
    id: 'C-03',
    type: 'Located item',
    template: 'point',
    summary: 'Withheld',
    observedAt: '2026-07-18T17:50:00-06:00',
    availableAt: '2026-07-18T18:40:00-06:00',
    location: { x: 1900, y: 3300 },
    sigmaM: 100,
    reliability: 0.9,
    relevance: 0.8,
  },
];

export interface ExerciseAssignment {
  id: string;
  name: string;
  resource: string;
  method: string;
  availableAt: string;
  area: Point[];
  plannedSpacingM: number;
  sweepWidthM: number;
  track: TrackPoint[];
}

function buffer(line: Point[], w: number): Point[] {
  // Simple offset polygon for a mostly-monotone line (exercise geometry only).
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)]!;
    const b = line[Math.min(line.length - 1, i + 1)]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    left.push({ x: line[i]!.x + nx * w, y: line[i]!.y + ny * w });
    right.push({ x: line[i]!.x - nx * w, y: line[i]!.y - ny * w });
  }
  return [...left, ...right.reverse()];
}

function walk(points: Point[], startMs: number, speed: number, gaps: Array<[number, number]> = []): TrackPoint[] {
  // Densify at 20 m, timestamp at constant speed, then drop points inside gap intervals (GPS off).
  const out: TrackPoint[] = [];
  let t = startMs;
  let dist = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(l / 20));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const f = k / n;
      const d = dist + f * l;
      if (gaps.some(([g0, g1]) => d > g0 && d < g1)) continue;
      out.push({ x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y), t: t + (f * l * 1000) / speed });
    }
    dist += l;
    t += (l * 1000) / speed;
  }
  return out;
}

const T0 = Date.parse('2026-07-18T12:30:00-06:00');
const lawn: Point[] = [];
for (let k = 0; k < 11; k++) {
  const x = 2650 + k * 50;
  lawn.push(k % 2 ? { x, y: 3250 } : { x, y: 2550 }, k % 2 ? { x, y: 2550 } : { x, y: 3250 });
}

export const ASSIGNMENTS: ExerciseAssignment[] = [
  {
    id: 'A-01',
    name: 'Hasty search, trail to lake',
    resource: 'Hasty team (2)',
    method: 'Route search with calling',
    availableAt: '2026-07-18T15:30:00-06:00',
    area: buffer(trail, 70),
    plannedSpacingM: 70,
    sweepWidthM: 40,
    track: walk(trail, T0, 1.2, [[2600, 3400]]),
  },
  {
    id: 'A-02',
    name: 'Grid, northeast bench',
    resource: 'Ground team (5)',
    method: 'Line search',
    availableAt: '2026-07-18T15:45:00-06:00',
    area: [{ x: 2600, y: 2500 }, { x: 3500, y: 2500 }, { x: 3500, y: 3300 }, { x: 2600, y: 3300 }],
    plannedSpacingM: 50,
    sweepWidthM: 30,
    track: walk(lawn, T0 + 3600_000, 0.6),
  },
];

/** Outcome for the reveal step, kept encoded so it is not visible while reading the page. */
export const SEALED_OUTCOME = btoa(JSON.stringify({ x: 2025, y: 2880 }));
