import {
  achievedPod,
  applyLikelihood,
  assessTrack,
  caseMetrics,
  checkInvariants,
  cleanTrack,
  distanceRingPrior,
  ENGINE_VERSION,
  EvaluationRun,
  filterAvailable,
  gaussianKernel,
  kernelLikelihood,
  mixture,
  noFindUpdate,
  plannedPod,
  probabilityOfSuccess,
  routeCorridor,
  routeWeightedPrior,
  splitAtGaps,
  sumValues,
  summarizeLikelihood,
  SurfaceStore,
  uniformPrior,
  wedgeKernel,
  type CaseMetrics,
  type Distribution,
  type DistanceRingTable,
  type PodSurface,
  type Point,
  type SurfaceRecord,
} from '../packages/probability-engine/src/index.ts';
import {
  ASSIGNMENTS,
  CASE_CODE,
  CLUES,
  cliff,
  cliffCell,
  creek,
  elevation,
  EXERCISE_RINGS,
  grid,
  INFORMATION_CUTOFF,
  IPP,
  IPP_SIGMA_M,
  lake,
  landMask,
  LAST_SEEN_AT,
  SEALED_OUTCOME,
  trail,
  zoneOf,
  ZONES,
  type ExerciseAssignment,
  type ExerciseClue,
} from './exercise.ts';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Role = 'planner_trainee' | 'evaluator';
const USERS: Record<Role, string> = { planner_trainee: 'trainee-01', evaluator: 'evaluator-01' };

interface Preview {
  kind: 'prior' | 'clue_update' | 'search_update';
  title: string;
  prior: Distribution | null;
  posterior: Distribution;
  normalizationConstant: number;
  inputs: unknown;
  provenance: Record<string, unknown>;
  extreme: boolean;
  sensitivity?: { label: string; dist: Distribution }[];
  pod?: Float64Array;
  notes: string[];
}

const store = new SurfaceStore('training');
let role: Role = 'planner_trainee';
let headId: string | null = null;
let viewId: string | null = null;
let preview: Preview | null = null;
let run: EvaluationRun | null = null;
let revealed: { find: Point; candidate: CaseMetrics; baselines: Record<string, CaseMetrics> } | null = null;
let hoverCell = -1;
let lastPod: Float64Array | null = null;
const committedEvidence = new Set<string>();
const layers = { prob: true, hpd: true, features: true, clues: true, search: true };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const fmtPct = (p: number, d = 1) => `${(p * 100).toFixed(d)}%`;
const fmtP = (p: number) => (p === 0 ? '0' : p < 1e-4 ? p.toExponential(1) : fmtPct(p, p < 0.01 ? 2 : 1));
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Edmonton' });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const head = () => (headId ? store.distribution(headId) : null);
const shown = (): Distribution | null => (preview ? preview.posterior : viewId ? store.distribution(viewId) : null);

// ---------------------------------------------------------------------------
// Scenarios and prior
// ---------------------------------------------------------------------------

interface ScenarioCfg {
  id: string;
  name: string;
  weight: number;
  describe: string;
}
const scenarios: ScenarioCfg[] = [
  { id: 'S1', name: 'Stayed on the trail toward the lake', weight: 0.45, describe: 'Route corridor along the trail (route confidence 60 %) mixed with distance rings.' },
  { id: 'S2', name: 'Left the trail and wandered', weight: 0.4, describe: 'Distance rings from the trailhead, open water excluded.' },
  { id: 'S3', name: 'Unresolved or other', weight: 0.15, describe: 'Uniform over the domain with 30 % reserved outside it.' },
];
let rings: DistanceRingTable = EXERCISE_RINGS;
let routeConfidence = 0.6;

function ringsPrior(): Distribution {
  return distanceRingPrior({ grid, planningPoint: IPP, planningPointSigmaM: IPP_SIGMA_M, table: rings, mask: landMask });
}
function uniformBaseline(): Distribution {
  return uniformPrior(grid, 0.3, landMask);
}

function buildPrior(): Preview {
  const ringDist = ringsPrior();
  const corridor = routeCorridor({ grid, route: trail, bufferM: 300, decayLengthM: 120, outsideProbability: 0.02, mask: landMask });
  const s1 = routeWeightedPrior(corridor, ringDist, routeConfidence);
  const m = mixture([
    { id: 'S1', weight: scenarios[0]!.weight, distribution: s1 },
    { id: 'S2', weight: scenarios[1]!.weight, distribution: ringDist },
    { id: 'S3', weight: scenarios[2]!.weight, distribution: uniformBaseline() },
  ]);
  const contrib: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.contributions)) contrib[k] = sumValues(v) + m.outsideContributions[k]!;
  return {
    kind: 'prior',
    title: 'Scenario-mixture prior',
    prior: null,
    posterior: m.distribution,
    normalizationConstant: 1,
    inputs: { scenarios, rings, routeConfidence, ipp: IPP, ippSigma: IPP_SIGMA_M, mask: 'open-water' },
    provenance: { method: 'scenario-mixture', scenarioMass: contrib, ringTable: `${rings.id}@${rings.version} (${rings.status})` },
    extreme: false,
    notes: [
      `Distance-ring table ${rings.id}@${rings.version} is marked ${rings.status.replace('_', ' ')}.`,
      'Open-water cells hold no probability; their share of each ring is spread over the ring’s land cells.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Clue and search previews
// ---------------------------------------------------------------------------

function clueLikelihood(c: ExerciseClue, reliability: number, relevance: number, sigma?: number) {
  const kernel =
    c.template === 'point'
      ? gaussianKernel(grid, c.location, sigma ?? c.sigmaM!)
      : wedgeKernel(grid, c.location, c.bearingDeg!, c.halfAngleDeg!, c.rangeM!);
  return kernelLikelihood(grid, kernel, { reliability, relevance });
}

function previewClue(c: ExerciseClue, reliability: number, relevance: number, sigma?: number): Preview {
  const prior = head()!;
  const f = clueLikelihood(c, reliability, relevance, sigma);
  const s = summarizeLikelihood(f);
  const r = applyLikelihood(prior, f);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const sens = [
    { label: 'Low', dist: applyLikelihood(prior, clueLikelihood(c, clamp(reliability - 0.2), clamp(relevance - 0.2), sigma)).posterior },
    { label: 'Central', dist: r.posterior },
    { label: 'High', dist: applyLikelihood(prior, clueLikelihood(c, clamp(reliability + 0.2), clamp(relevance + 0.2), sigma)).posterior },
  ];
  return {
    kind: 'clue_update',
    title: `${c.id} ${c.type}`,
    prior,
    posterior: r.posterior,
    normalizationConstant: r.normalizationConstant,
    inputs: { clue: c.id, template: c.template, reliability, relevance, sigma: sigma ?? c.sigmaM ?? null },
    provenance: { evidence: c.id, method: `kernel-likelihood/${c.template}@1`, reliability, relevance, lrMin: s.min, lrMax: s.max },
    extreme: s.extreme,
    sensitivity: sens,
    notes: [
      `Likelihood ratios range from ${s.min.toFixed(2)} to ${s.max.toFixed(1)} (outside domain ${f.lrOutside.toFixed(2)}).`,
      `Credibility q = reliability × relevance = ${(reliability * relevance).toFixed(2)}, assuming the two are independent.`,
      ...(s.extreme ? ['These ratios are extreme. The rationale must explain why.'] : []),
    ],
  };
}

function podFor(a: ExerciseAssignment, sweepWidthM: number): { planned: PodSurface; achieved: PodSurface; quality: string; gaps: number } {
  const planned = plannedPod({ grid, area: a.area, sweepWidthM, sweepWidthSource: 'exercise value', plannedSpacingM: a.plannedSpacingM });
  const report = assessTrack(a.track);
  const cleaned = cleanTrack(a.track);
  const parts = splitAtGaps(cleaned.points);
  const achieved = achievedPod({ grid, area: a.area, sweepWidthM, sweepWidthSource: 'exercise value', tracks: parts, clipBufferM: 50 });
  return { planned, achieved, quality: report.quality, gaps: report.gaps.length };
}

function previewSearch(a: ExerciseAssignment, sweepWidthM: number): Preview {
  const prior = head()!;
  const { achieved } = podFor(a, sweepWidthM);
  const r = noFindUpdate(prior, achieved.pod);
  return {
    kind: 'search_update',
    title: `${a.id} no-find update`,
    prior,
    posterior: r.posterior,
    normalizationConstant: r.normalizationConstant,
    inputs: { assignment: a.id, sweepWidthM, podInputHash: achieved.inputHash },
    provenance: { evidence: a.id, method: 'no-find/exponential-sweep-width@1', achievedSummaryPod: achieved.summaryPod, sweepWidthM },
    extreme: false,
    pod: achieved.pod,
    notes: [
      `Achieved POD from the GPS track: ${fmtPct(achieved.summaryPod)} averaged over the assignment. Cells the track never reached keep POD 0.`,
      `POS of this search on the current surface: ${fmtPct(probabilityOfSuccess(prior, achieved.pod), 2)}.`,
      'Searched cells keep probability in proportion to 1 − POD. Nothing is set to zero.',
    ],
  };
}

function commitPreview(rationale: string) {
  if (!preview) return;
  const p = preview;
  const rec = store.commit({
    incidentId: CASE_CODE,
    parentSurfaceId: p.kind === 'prior' ? null : headId,
    surfaceType: p.kind,
    distribution: p.posterior,
    normalizationConstant: p.normalizationConstant,
    modelVersion: ENGINE_VERSION,
    inputs: p.inputs,
    createdBy: USERS[role],
    rationale,
    provenance: p.provenance,
  });
  if (p.kind !== 'prior') committedEvidence.add(String(p.provenance.evidence));
  if (p.kind === 'search_update') lastPod = p.pod ?? null;
  headId = rec.id;
  viewId = rec.id;
  preview = null;
  renderAll();
  toast(`Committed iteration ${rec.iteration} (${rec.surfaceType.replace('_', ' ')}).`);
}

// ---------------------------------------------------------------------------
// Map rendering
// ---------------------------------------------------------------------------

const RAMP: Array<[number, number, number]> = [
  [0, 32, 77], [36, 61, 112], [87, 92, 109], [124, 123, 120], [166, 157, 117], [208, 192, 103], [253, 234, 69],
];
function ramp(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP[i]!, b = RAMP[i + 1]!;
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
}

const W = grid.cols * grid.cellSize;
const H = grid.rows * grid.cellSize;
const hill = document.createElement('canvas');
hill.width = grid.cols;
hill.height = grid.rows;
(() => {
  const ctx = hill.getContext('2d')!;
  const img = ctx.createImageData(grid.cols, grid.rows);
  for (let r = 0; r < grid.rows; r++)
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c;
      const e = elevation[i]!;
      const ex = elevation[r * grid.cols + Math.min(grid.cols - 1, c + 1)]! - elevation[r * grid.cols + Math.max(0, c - 1)]!;
      const ey = elevation[Math.min(grid.rows - 1, r + 1) * grid.cols + c]! - elevation[Math.max(0, r - 1) * grid.cols + c]!;
      const shade = Math.max(0, Math.min(1, 0.55 + (-ex + ey) / 60));
      const tint = (e - 1400) / 900;
      const o = ((grid.rows - 1 - r) * grid.cols + c) * 4;
      if (landMask[i] === 0) {
        img.data.set([96, 140, 170, 255], o);
      } else {
        const g = 120 + 120 * shade - 25 * tint;
        img.data.set([g * 0.97, g * 0.99, g * 0.94, 255], o);
      }
    }
  ctx.putImageData(img, 0, 0);
})();

const prob = document.createElement('canvas');
prob.width = grid.cols;
prob.height = grid.rows;

let scaleMax = 0;
function hpdMask(d: Distribution, level: number): Uint8Array {
  const idx = Array.from(d.values.keys()).sort((a, b) => d.values[b]! - d.values[a]!);
  const m = new Uint8Array(d.values.length);
  let acc = 0;
  for (const i of idx) {
    if (acc >= level) break;
    m[i] = 1;
    acc += d.values[i]!;
  }
  return acc >= level ? m : new Uint8Array(0);
}

function drawMap() {
  const canvas = $<HTMLCanvasElement>('#map');
  const box = canvas.parentElement!.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(200, box.width);
  const ch = (cw * H) / W;
  canvas.style.height = `${ch}px`;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(hill, 0, 0, cw, ch);
  const k = cw / W;
  const px = (p: Point) => [(p.x - grid.originX) * k, ch - (p.y - grid.originY) * k] as const;
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--map-ink').trim() || '#1d2a33';

  const d = shown();
  if (d && layers.prob) {
    let max = 0;
    for (const v of d.values) if (v > max) max = v;
    scaleMax = max;
    const pctx = prob.getContext('2d')!;
    const img = pctx.createImageData(grid.cols, grid.rows);
    const lo = max / 1e4;
    for (let i = 0; i < d.values.length; i++) {
      const v = d.values[i]!;
      if (v <= lo) continue;
      const t = Math.log10(v / lo) / 4;
      const [r, g, b] = ramp(t);
      const c = i % grid.cols;
      const row = Math.floor(i / grid.cols);
      img.data.set([r, g, b, 25 + 210 * t], ((grid.rows - 1 - row) * grid.cols + c) * 4);
    }
    pctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(prob, 0, 0, cw, ch);
  }
  if (d && layers.hpd) {
    for (const [level, dash] of [[0.5, []], [0.8, [5, 4]]] as const) {
      const m = hpdMask(d, level);
      if (!m.length) continue;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([...dash]);
      ctx.beginPath();
      const cs = grid.cellSize * k;
      for (let i = 0; i < m.length; i++) {
        if (!m[i]) continue;
        const c = i % grid.cols;
        const r = Math.floor(i / grid.cols);
        const x0 = c * cs;
        const y0 = ch - (r + 1) * cs;
        if (c === 0 || !m[i - 1]) { ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + cs); }
        if (c === grid.cols - 1 || !m[i + 1]) { ctx.moveTo(x0 + cs, y0); ctx.lineTo(x0 + cs, y0 + cs); }
        if (r === grid.rows - 1 || !m[i + grid.cols]) { ctx.moveTo(x0, y0); ctx.lineTo(x0 + cs, y0); }
        if (r === 0 || !m[i - grid.cols]) { ctx.moveTo(x0, y0 + cs); ctx.lineTo(x0 + cs, y0 + cs); }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  const line = (pts: Point[], color: string, w: number, dash: number[] = []) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.setLineDash(dash);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (layers.features) {
    line(creek, '#2f6f9a', 2);
    line(trail, '#7a3b12', 2.2, [6, 3]);
    line(cliff, '#3a2a22', 4);
    ctx.fillStyle = '#3a2a22';
    const [cx, cy] = px({ x: lake.cx, y: lake.cy });
    ctx.font = '600 11px "Public Sans", system-ui, sans-serif';
    ctx.fillText('Larch Lake', cx - 26, cy + 4);
    const [tx, ty] = px(cliff[1]!);
    ctx.fillText('cliff band', tx - 10, ty - 10);
    // IPP
    const [ix, iy] = px(IPP);
    ctx.beginPath();
    ctx.arc(ix, iy, IPP_SIGMA_M * k * 2, 0, Math.PI * 2);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#c2410c';
    ctx.beginPath();
    ctx.moveTo(ix, iy - 8);
    ctx.lineTo(ix + 7, iy + 5);
    ctx.lineTo(ix - 7, iy + 5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.fillText('IPP trailhead', ix + 10, iy + 4);
  }
  if (layers.search) {
    for (const a of availableAssignments()) {
      ctx.strokeStyle = '#4c1d95';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      a.area.forEach((p, i) => (i ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      for (const part of splitAtGaps(cleanTrack(a.track).points)) line(part, '#7c3aed', 1.4);
    }
  }
  if (layers.clues) {
    for (const c of availableClues()) {
      const [x, y] = px(c.location);
      ctx.strokeStyle = '#be185d';
      ctx.fillStyle = '#be185d';
      ctx.lineWidth = 1.4;
      if (c.template === 'point') {
        ctx.beginPath();
        ctx.arc(x, y, c.sigmaM! * k * 2, 0, Math.PI * 2);
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const a0 = ((c.bearingDeg! - c.halfAngleDeg! - 90) * Math.PI) / 180;
        const a1 = ((c.bearingDeg! + c.halfAngleDeg! - 90) * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, c.rangeM! * k, a0, a1);
        ctx.closePath();
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '600 11px "IBM Plex Mono", ui-monospace, monospace';
      ctx.fillText(c.id, x + 7, y - 6);
    }
  }
  if (revealed) {
    const [x, y] = px(revealed.find);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x - 7, y - 7); ctx.lineTo(x + 7, y + 7); ctx.moveTo(x + 7, y - 7); ctx.lineTo(x - 7, y + 7);
    ctx.stroke();
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = '700 11px "Public Sans", system-ui, sans-serif';
    ctx.fillText('Find location (revealed)', x + 10, y + 4);
  }
  if (hoverCell >= 0) {
    const c = hoverCell % grid.cols;
    const r = Math.floor(hoverCell / grid.cols);
    const cs = grid.cellSize * k;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(c * cs, ch - (r + 1) * cs, cs, cs);
  }
  // scale bar
  ctx.fillStyle = ink;
  ctx.fillRect(12, ch - 16, 1000 * k, 3);
  ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
  ctx.fillText('1 km', 12, ch - 21);
  renderLegend(d);
}

function renderLegend(d: Distribution | null) {
  const el = $('#legend');
  if (!d) {
    el.innerHTML = '<p class="muted">Commit a prior to see the probability surface.</p>';
    $('#mass').innerHTML = '';
    return;
  }
  const a = (grid.cellSize * grid.cellSize) / 1e4;
  const stops = [1, 0.1, 0.01, 0.001, 0.0001].map((f) => `<span>${fmtP((scaleMax * f) / a)}</span>`).join('');
  el.innerHTML = `
    <div class="ramp" aria-hidden="true"></div>
    <div class="ticks">${stops}</div>
    <p class="cap">Probability per hectare (log scale). Solid outline: smallest area holding 50 % of all probability. Dashed: 80 %.</p>`;
  const inside = sumValues(d.values);
  const errs = checkInvariants(d);
  $('#mass').innerHTML = `
    <div class="massbar" role="img" aria-label="In domain ${fmtPct(inside)}, outside domain ${fmtPct(d.outside)}">
      <span class="in" style="width:${inside * 100}%"></span><span class="out" style="width:${d.outside * 100}%"></span>
    </div>
    <div class="masslabels"><span>In domain <b>${fmtPct(inside)}</b></span><span>Outside domain <b>${fmtPct(d.outside)}</b></span></div>
    <div class="check ${errs.length ? 'bad' : 'ok'}">${errs.length ? esc(errs.join('; ')) : `Σ = 1 ${(inside + d.outside - 1 >= 0 ? '+ ' : '− ')}${Math.abs(inside + d.outside - 1).toExponential(1)} · invariants pass`}</div>`;
}

function renderInspector() {
  const el = $('#inspector');
  const d = shown();
  if (hoverCell < 0 || !d) {
    el.innerHTML = '<span class="muted">Hover or tap a cell to inspect it.</span>';
    return;
  }
  const c = hoverCell % grid.cols;
  const r = Math.floor(hoverCell / grid.cols);
  const a = (grid.cellSize * grid.cellSize) / 1e4;
  const v = d.values[hoverCell]!;
  const pod = preview?.pod ?? lastPod;
  const rank = d.values.reduce((n, x) => n + (x > v ? 1 : 0), 0) / d.values.length;
  el.innerHTML = `
    <span>Cell <b>${c},${r}</b></span>
    <span>${ZONES[zoneOf[hoverCell]!]}</span>
    <span>POA <b>${fmtP(v)}</b></span>
    <span><b>${fmtP(v / a)}</b>/ha</span>
    <span>Top <b>${fmtPct(Math.max(rank, 1 / d.values.length), 1)}</b> of area</span>
    ${pod ? `<span>POD <b>${fmtPct(pod[hoverCell]!, 0)}</b></span>` : ''}
    ${landMask[hoverCell] ? '' : '<span>Open water</span>'}
    ${cliffCell[hoverCell] ? '<span>Cliff</span>' : ''}
    <span class="muted">${Math.round(elevation[hoverCell]!)} m</span>`;
}

function mini(d: Distribution, scaleTo: number, diffFrom?: Distribution): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = grid.cols;
  c.height = grid.rows;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(hill, 0, 0);
  const img = ctx.getImageData(0, 0, grid.cols, grid.rows);
  const lo = scaleTo / 1e4;
  let maxDiff = 0;
  if (diffFrom) for (let i = 0; i < d.values.length; i++) maxDiff = Math.max(maxDiff, Math.abs(d.values[i]! - diffFrom.values[i]!));
  for (let i = 0; i < d.values.length; i++) {
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    const o = ((grid.rows - 1 - row) * grid.cols + col) * 4;
    let rgb: [number, number, number];
    let alpha: number;
    if (diffFrom) {
      const dv = d.values[i]! - diffFrom.values[i]!;
      const t = maxDiff ? Math.sqrt(Math.abs(dv) / maxDiff) : 0;
      if (t < 0.03) continue;
      rgb = dv > 0 ? [217, 119, 6] : [37, 99, 235];
      alpha = 230 * t;
    } else {
      const v = d.values[i]!;
      if (v <= lo) continue;
      const t = Math.log10(v / lo) / 4;
      rgb = ramp(t);
      alpha = 25 + 210 * t;
    }
    const a = alpha / 255;
    for (let k = 0; k < 3; k++) img.data[o + k] = img.data[o + k]! * (1 - a) + rgb[k]! * a;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

const availableClues = () => filterAvailable(CLUES, INFORMATION_CUTOFF);
const availableAssignments = () => filterAvailable(ASSIGNMENTS, INFORMATION_CUTOFF);

function zoneTable(cols: { label: string; dist: Distribution }[]) {
  const sums = cols.map(({ dist }) => {
    const z = new Float64Array(ZONES.length);
    dist.values.forEach((v, i) => (z[zoneOf[i]!]! += v));
    return { z, outside: dist.outside };
  });
  const rows = ZONES.map(
    (name, zi) =>
      `<tr><th scope="row">${name}</th>${sums.map((s, k) => {
        const v = s.z[zi]!;
        const delta = k > 0 ? v - sums[0]!.z[zi]! : 0;
        return `<td>${fmtPct(v)}${k > 0 ? ` <small class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : '−'}${fmtPct(Math.abs(delta))}</small>` : ''}</td>`;
      }).join('')}</tr>`,
  ).join('');
  return `<div class="tablewrap"><table class="num"><thead><tr><th></th>${cols.map((c) => `<th scope="col">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows}<tr class="outside"><th scope="row">Outside domain</th>${sums.map((s) => `<td>${fmtPct(s.outside)}</td>`).join('')}</tr></tbody></table></div>`;
}

function renderPreview() {
  const el = $('#preview');
  if (!preview) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const p = preview;
  el.hidden = false;
  const errs = checkInvariants(p.posterior);
  const cols = p.prior ? [{ label: 'Before', dist: p.prior }, ...(p.sensitivity ?? [{ label: 'After', dist: p.posterior }])] : [{ label: 'Prior', dist: p.posterior }];
  const minRationale = p.extreme ? 40 : p.kind === 'prior' ? 0 : 10;
  el.innerHTML = `
    <div class="pv-head"><span class="eyebrow">Preview, not yet committed</span><h3>${esc(p.title)}</h3></div>
    <div class="minis"></div>
    ${p.sensitivity ? '<p class="cap">Probability by area. Low and high recompute the update with reliability and relevance each 0.2 lower or higher.</p>' : '<p class="cap">Probability by area.</p>'}
    ${zoneTable(cols)}
    <ul class="notes">${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}
      <li>Normalization constant ${p.normalizationConstant.toPrecision(6)}.</li></ul>
    <div class="check ${errs.length ? 'bad' : 'ok'}">${errs.length ? `Invariant check failed: ${esc(errs.join('; '))}. Commit is disabled.` : 'Invariant checks pass: finite, non-negative, sums to 1.'}</div>
    <label class="field" for="rationale">Rationale${minRationale ? ` <small>(required, ${minRationale}+ characters)</small>` : ' <small>(optional)</small>'}
      <textarea id="rationale" rows="2" placeholder="Why this update is justified"></textarea></label>
    <div class="actions"><button id="pv-commit" class="primary" ${errs.length ? 'disabled' : ''}>Commit as new iteration</button><button id="pv-cancel">Discard preview</button></div>`;
  const minis = el.querySelector('.minis')!;
  let max = 0;
  for (const v of p.posterior.values) max = Math.max(max, v);
  const add = (label: string, cv: HTMLCanvasElement) => {
    const f = document.createElement('figure');
    f.append(cv);
    const cap = document.createElement('figcaption');
    cap.textContent = label;
    f.append(cap);
    minis.append(f);
  };
  if (p.prior) {
    add('Before', mini(p.prior, max));
    add('After', mini(p.posterior, max));
    add('Change: orange gained, blue lost', mini(p.posterior, max, p.prior));
  }
  const ta = $<HTMLTextAreaElement>('#rationale');
  const btn = $<HTMLButtonElement>('#pv-commit');
  const sync = () => (btn.disabled = errs.length > 0 || ta.value.trim().length < minRationale);
  ta.addEventListener('input', sync);
  sync();
  btn.addEventListener('click', () => commitPreview(ta.value.trim() || 'Initial scenario prior'));
  $('#pv-cancel').addEventListener('click', () => {
    preview = null;
    renderAll();
  });
}

function renderScenarios() {
  const el = $('#tab-scenarios');
  const sum = scenarios.reduce((s, x) => s + x.weight, 0);
  const ok = Math.abs(sum - 1) < 1e-9;
  el.innerHTML = `
    <p class="lede">Build the prior as a weighted mix of explicit hypotheses. Weights must add to 1. The unresolved scenario keeps probability for possibilities nobody has named.</p>
    <div class="scen">${scenarios
      .map(
        (s, i) => `<div class="scen-row">
          <div class="scen-txt"><b>${s.id} ${esc(s.name)}</b><span>${esc(s.describe)}</span></div>
          <label class="w" for="w${i}">Weight<input id="w${i}" type="number" min="0" max="1" step="0.05" value="${s.weight}"></label></div>`,
      )
      .join('')}</div>
    <div class="sumline ${ok ? 'ok' : 'bad'}">Weights sum to <b>${sum.toFixed(2)}</b>${ok ? '' : '. Adjust them to total 1.00.'}</div>
    <details class="rings"><summary>Distance rings and route settings</summary>
      <p class="warn">Exercise values. These are not behavioural statistics. A real case needs a table from an approved source with its sample size and region.</p>
      <div class="tablewrap"><table class="num"><thead><tr><th scope="col">Within (m)</th><th scope="col">Cumulative share</th></tr></thead><tbody>
      ${rings.breaks.map((b, i) => `<tr><td><input id="rd${i}" type="number" step="100" value="${b.distanceM}" aria-label="Ring ${i + 1} distance"></td><td><input id="rp${i}" type="number" step="0.05" min="0" max="1" value="${b.cumulativeProbability}" aria-label="Ring ${i + 1} cumulative share"></td></tr>`).join('')}
      </tbody></table></div>
      <label class="field" for="routeconf">Route confidence for S1 (max 0.90)<input id="routeconf" type="number" min="0" max="0.9" step="0.05" value="${routeConfidence}"></label>
      <p class="cap">Trailhead position uncertainty: σ = ${IPP_SIGMA_M} m. Probability beyond ${rings.breaks.at(-1)!.distanceM} m is spread out to ${rings.tailOuterDistanceM} m, and whatever falls beyond the map edge counts as outside the domain.</p>
    </details>
    <div class="actions"><button id="prior-preview" class="primary" ${ok ? '' : 'disabled'}>Preview prior</button></div>
    ${headId ? '<p class="cap">A prior is already committed. Committing another starts a new root in the history; nothing is overwritten.</p>' : ''}`;
  scenarios.forEach((s, i) =>
    $<HTMLInputElement>(`#w${i}`).addEventListener('change', (e) => {
      s.weight = Number((e.target as HTMLInputElement).value);
      renderScenarios();
    }),
  );
  rings.breaks.forEach((_, i) => {
    const upd = () => {
      const breaks = rings.breaks.map((b, j) => ({
        distanceM: Number($<HTMLInputElement>(`#rd${j}`).value),
        cumulativeProbability: Number($<HTMLInputElement>(`#rp${j}`).value),
      }));
      rings = { ...rings, breaks, version: 'ex-1-edited' };
    };
    $(`#rd${i}`).addEventListener('change', upd);
    $(`#rp${i}`).addEventListener('change', upd);
  });
  $('#routeconf').addEventListener('change', (e) => (routeConfidence = Number((e.target as HTMLInputElement).value)));
  $('#prior-preview').addEventListener('click', () => {
    try {
      preview = buildPrior();
      renderAll();
    } catch (err) {
      toast((err as Error).message, true);
    }
  });
}

function renderClues() {
  const el = $('#tab-clues');
  const avail = availableClues();
  const withheld = CLUES.length - avail.length;
  el.innerHTML = `
    <p class="lede">Clues available to planners by ${fmtTime(INFORMATION_CUTOFF)}. Reliability (is the report accurate?) and relevance (is it about this subject?) are set separately.</p>
    ${avail
      .map(
        (c) => `<article class="item">
        <header><b>${c.id}</b> ${esc(c.type)} ${committedEvidence.has(c.id) ? '<span class="chip ok">applied</span>' : ''}</header>
        <p>${esc(c.summary)}</p>
        <p class="meta">Observed ${fmtTime(c.observedAt)} · Available ${fmtTime(c.availableAt)} · ${c.template === 'point' ? `±${c.sigmaM} m (1σ)` : `bearing ${c.bearingDeg}° ± ${c.halfAngleDeg}°, up to ${c.rangeM! / 1000} km`}</p>
        <div class="row3">
          <label for="rel-${c.id}">Reliability<input id="rel-${c.id}" type="number" min="0" max="1" step="0.05" value="${c.reliability}"></label>
          <label for="rv-${c.id}">Relevance<input id="rv-${c.id}" type="number" min="0" max="1" step="0.05" value="${c.relevance}"></label>
          ${c.template === 'point' ? `<label for="sg-${c.id}">σ (m)<input id="sg-${c.id}" type="number" min="10" step="10" value="${c.sigmaM}"></label>` : '<span></span>'}
        </div>
        <button data-clue="${c.id}" ${headId ? '' : 'disabled'}>Preview update</button>
      </article>`,
      )
      .join('')}
    ${withheld ? `<p class="withheld">${withheld} clue${withheld > 1 ? 's' : ''} withheld: became available after the cutoff.</p>` : ''}
    ${headId ? '' : '<p class="cap">Commit a prior first.</p>'}`;
  el.querySelectorAll<HTMLButtonElement>('button[data-clue]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = CLUES.find((x) => x.id === b.dataset.clue)!;
      const rel = Number($<HTMLInputElement>(`#rel-${c.id}`).value);
      const rv = Number($<HTMLInputElement>(`#rv-${c.id}`).value);
      const sg = c.template === 'point' ? Number($<HTMLInputElement>(`#sg-${c.id}`).value) : undefined;
      try {
        preview = previewClue(c, rel, rv, sg);
        renderAll();
      } catch (err) {
        toast((err as Error).message, true);
      }
    }),
  );
}

function renderSearch() {
  const el = $('#tab-search');
  const h = head();
  el.innerHTML = `
    <p class="lede">Planned and achieved coverage are kept apart. Only the achieved POD from the GPS track updates the map.</p>
    ${availableAssignments()
      .map((a) => {
        const sw = Number(($<HTMLInputElement>(`#sw-${a.id}`)?.value as string | undefined) ?? a.sweepWidthM);
        const p = podFor(a, sw);
        return `<article class="item">
          <header><b>${a.id}</b> ${esc(a.name)} ${committedEvidence.has(a.id) ? '<span class="chip ok">applied</span>' : ''}</header>
          <p class="meta">${esc(a.resource)} · ${esc(a.method)} · planned spacing ${a.plannedSpacingM} m · track ${p.quality}${p.gaps ? ` (${p.gaps} gap${p.gaps > 1 ? 's' : ''})` : ''}</p>
          <div class="tablewrap"><table class="num compact"><thead><tr><th></th><th scope="col">Coverage</th><th scope="col">POD</th><th scope="col">POS</th></tr></thead><tbody>
            <tr><th scope="row">Planned</th><td>${p.planned.summaryCoverage.toFixed(2)}</td><td>${fmtPct(p.planned.summaryPod)}</td><td>${h ? fmtPct(probabilityOfSuccess(h, p.planned.pod), 2) : '–'}</td></tr>
            <tr><th scope="row">Achieved</th><td>${p.achieved.summaryCoverage.toFixed(2)}</td><td>${fmtPct(p.achieved.summaryPod)}</td><td>${h ? fmtPct(probabilityOfSuccess(h, p.achieved.pod), 2) : '–'}</td></tr>
          </tbody></table></div>
          <label class="field inline" for="sw-${a.id}">Effective sweep width (m, exercise value)<input id="sw-${a.id}" type="number" min="1" step="5" value="${sw}"></label>
          <button data-asg="${a.id}" ${h ? '' : 'disabled'}>Preview no-find update</button>
        </article>`;
      })
      .join('')}
    <p class="cap">POD model: exponential sweep width, POD = 1 − e<sup>−C</sup> with coverage C = W·L/A per cell. Applying both searches assumes they are independent.</p>`;
  el.querySelectorAll<HTMLInputElement>('input[id^="sw-"]').forEach((i) => i.addEventListener('change', () => renderSearch()));
  el.querySelectorAll<HTMLButtonElement>('button[data-asg]').forEach((b) =>
    b.addEventListener('click', () => {
      const a = ASSIGNMENTS.find((x) => x.id === b.dataset.asg)!;
      preview = previewSearch(a, Number($<HTMLInputElement>(`#sw-${a.id}`).value));
      renderAll();
    }),
  );
}

function renderHistory() {
  const el = $('#tab-history');
  const hist = store.history(CASE_CODE);
  if (!hist.length) {
    el.innerHTML = '<p class="lede">No surfaces yet. Every commit adds an iteration here; nothing is edited in place.</p>';
    return;
  }
  el.innerHTML = `<p class="lede">Every committed surface, oldest first. Select one to view it. Rolling back appends a copy of an earlier surface as a new iteration.</p>
    <ol class="hist">${hist
      .map((r: SurfaceRecord) => {
        const isHead = r.id === headId;
        return `<li class="${r.id === viewId ? 'sel' : ''}">
          <button class="hist-btn" data-view="${r.id}"><span class="it">#${r.iteration}</span>
            <span class="ty">${r.surfaceType.replace('_', ' ')}${isHead ? ' <span class="chip">current</span>' : ''}${r.divergentBranch ? ' <span class="chip warn">branch</span>' : ''}${r.lockedAt ? ' <span class="chip">locked</span>' : ''}</span>
            <span class="by">${esc(r.createdBy)} · ${fmtTime(r.createdAt)}</span></button>
          <div class="hist-meta">${esc(r.rationale || '—')}<br><code>outside ${fmtPct(r.outsideDomainProbability, 2)} · Z ${r.normalizationConstant.toPrecision(5)} · ${r.valuesHash.slice(0, 12)}</code>
          ${!isHead && headId && r.id !== headId ? `<button class="small" data-rollback="${r.id}">Roll back to #${r.iteration}</button>` : ''}</div>
        </li>`;
      })
      .join('')}</ol>`;
  el.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      viewId = b.dataset.view!;
      preview = null;
      renderAll();
    }),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-rollback]').forEach((b) =>
    b.addEventListener('click', () => {
      const rec = store.rollback({ incidentId: CASE_CODE, headSurfaceId: headId!, targetSurfaceId: b.dataset.rollback!, createdBy: USERS[role], rationale: `Rollback to ${b.dataset.rollback} from history view` });
      headId = rec.id;
      viewId = rec.id;
      renderAll();
      toast(`Rolled back. Iteration ${rec.iteration} added.`);
    }),
  );
}

function renderEvaluate() {
  const el = $('#tab-evaluate');
  const status = run?.status ?? 'open';
  const metricsRow = (label: string, m: CaseMetrics) => `<tr><th scope="row">${label}</th>
      <td>${fmtP(m.findProbability)}</td>
      <td>${m.rankPercentile === null ? 'outside' : `top ${fmtPct(m.areaFractionToCapture!, 1)}`}</td>
      <td>${m.logScore.toFixed(2)}</td>
      <td>${fmtPct(m.topAreaProbability.p10)}</td></tr>`;
  el.innerHTML = `
    <p class="lede">Lock the current surface before the outcome is revealed. The run compares it with a uniform baseline and a distance-ring baseline built from the same inputs.</p>
    <ol class="steps">
      <li class="${headId ? 'done' : ''}">Build and update a surface <span>${headId ? `iteration #${store.get(headId).iteration}` : 'not started'}</span></li>
      <li class="${status !== 'open' ? 'done' : ''}">Lock the run <span>${status === 'open' ? 'open' : 'locked'}</span></li>
      <li class="${status === 'revealed' ? 'done' : ''}">Reveal the find location <span>${status === 'revealed' ? 'revealed' : 'hidden'}</span></li>
    </ol>
    <div class="actions">
      <button id="lock" class="primary" ${headId && status === 'open' ? '' : 'disabled'}>Lock run</button>
      <button id="reveal" ${status === 'locked' ? '' : 'disabled'}>Reveal outcome</button>
    </div>
    ${status === 'locked' && role !== 'evaluator' ? '<p class="cap">Revealing needs the evaluator role. Switch role in the header.</p>' : ''}
    ${
      revealed
        ? `<div class="tablewrap"><table class="num"><thead><tr><th></th><th scope="col">POA at find</th><th scope="col">Area to reach find</th><th scope="col">Log score</th><th scope="col">Prob. in top 10 % area</th></tr></thead><tbody>
          ${metricsRow('Your surface', revealed.candidate)}${metricsRow('Uniform', revealed.baselines.uniform!)}${metricsRow('Distance rings', revealed.baselines.rings!)}</tbody></table></div>
          <p class="cap">Area to reach find: share of the domain you would cover, highest density first, before reaching the find cell. Lower is better. Log score uses a floor of 10⁻⁹; higher is better. One case says little; real evaluation needs many locked cases.</p>`
        : ''
    }
    <p class="cap">In this demo the outcome ships inside the page in encoded form. In the real application it stays in restricted server storage until a run is locked.</p>`;
  $('#lock').addEventListener('click', () => {
    run = new EvaluationRun(CASE_CODE, INFORMATION_CUTOFF);
    store.lock(headId!);
    run.lock({ surfaceId: headId!, candidate: head()!, baselines: { uniform: uniformBaseline(), rings: ringsPrior() }, lockedBy: USERS[role], inputHashes: { candidate: store.get(headId!).inputHash } });
    renderAll();
    toast('Run locked.');
  });
  $('#reveal').addEventListener('click', () => {
    try {
      revealed = run!.reveal(() => JSON.parse(atob(SEALED_OUTCOME)), { userId: USERS[role], role });
      renderAll();
    } catch (err) {
      toast((err as Error).message, true);
    }
  });
}

function toast(msg: string, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = bad ? 'show bad' : 'show';
  clearTimeout((toast as unknown as { h: number }).h);
  (toast as unknown as { h: number }).h = window.setTimeout(() => (t.className = ''), 3200);
}

function renderStatus() {
  const r = viewId ? store.get(viewId) : null;
  $('#viewing').innerHTML = preview
    ? '<span class="chip warn">Previewing</span> uncommitted result'
    : r
      ? `Showing iteration <b>#${r.iteration}</b> · ${r.surfaceType.replace('_', ' ')}${r.id !== headId ? ' <span class="chip warn">not current</span>' : ''}`
      : 'No surface yet';
}

function renderAll() {
  renderStatus();
  renderScenarios();
  renderClues();
  renderSearch();
  renderHistory();
  renderEvaluate();
  renderPreview();
  drawMap();
  renderInspector();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function selectTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll<HTMLElement>('[role="tabpanel"]').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  try {
    localStorage.setItem('lpm-tab', name);
  } catch {}
}

function init() {
  $('#cutoff').textContent = fmtTime(INFORMATION_CUTOFF);
  $('#lastseen').textContent = fmtTime(LAST_SEEN_AT);
  document.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab!)));
  $<HTMLSelectElement>('#role').addEventListener('change', (e) => {
    role = (e.target as HTMLSelectElement).value as Role;
    renderAll();
  });
  for (const k of Object.keys(layers) as (keyof typeof layers)[]) {
    const cb = $<HTMLInputElement>(`#ly-${k}`);
    cb.checked = layers[k];
    cb.addEventListener('change', () => {
      layers[k] = cb.checked;
      drawMap();
    });
  }
  const canvas = $<HTMLCanvasElement>('#map');
  const pick = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const col = Math.floor(((ev.clientX - r.left) / r.width) * grid.cols);
    const row = grid.rows - 1 - Math.floor(((ev.clientY - r.top) / r.height) * grid.rows);
    const idx = col >= 0 && row >= 0 && col < grid.cols && row < grid.rows ? row * grid.cols + col : -1;
    if (idx !== hoverCell) {
      hoverCell = idx;
      drawMap();
      renderInspector();
    }
  };
  canvas.addEventListener('pointermove', pick);
  canvas.addEventListener('pointerdown', pick);
  window.addEventListener('resize', () => drawMap());
  let saved = 'scenarios';
  try {
    saved = localStorage.getItem('lpm-tab') ?? 'scenarios';
  } catch {}
  selectTab(saved);
  // Open in a working state: the exercise prior committed by the trainee.
  preview = buildPrior();
  commitPreview('Initial scenario prior for exercise briefing');
  $('#toast').className = '';
}

init();
