import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  achievedPod,
  applyLikelihood,
  assessTrack,
  caseMetrics,
  cellCentre,
  checkInvariants,
  cleanTrack,
  costDistance,
  cumulativePod,
  distanceRingPrior,
  EvaluationRun,
  exponentialPod,
  filterAvailable,
  gaussianKernel,
  kernelLikelihood,
  leakageCheck,
  makeGrid,
  mixture,
  noFindUpdate,
  plannedPod,
  probabilityOfSuccess,
  PROBABILITY_TOLERANCE,
  rasterizePolylineLength,
  routeCorridor,
  routeWeightedPrior,
  setOutsideProbability,
  sha256,
  splitAtGaps,
  SurfaceStore,
  sumValues,
  uniformPrior,
  validatePolygon,
  validateRingTable,
  type DistanceRingTable,
  type Distribution,
} from '../src/index.ts';

const grid2 = makeGrid({ crs: 'test', originX: 0, originY: 0, cellSize: 10, cols: 2, rows: 1 });
const grid10 = makeGrid({ crs: 'test', originX: 0, originY: 0, cellSize: 100, cols: 10, rows: 10 });
const dist = (values: number[], outside: number, grid = grid2): Distribution => ({ grid, values: Float64Array.from(values), outside });
const close = (a: number, b: number, eps = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

/** Exercise-only table for tests. Not behavioural statistics. */
const TEST_TABLE: DistanceRingTable = {
  id: 'test',
  version: '0',
  subjectCategory: 'test',
  source: 'unit-test fixture, no empirical meaning',
  sampleSize: null,
  region: null,
  period: null,
  status: 'exercise_only',
  breaks: [
    { distanceM: 200, cumulativeProbability: 0.5 },
    { distanceM: 400, cumulativeProbability: 0.9 },
  ],
  tailOuterDistanceM: 1000,
};

describe('hand-calculated fixtures', () => {
  it('uniform prior splits in-domain mass equally and keeps outside', () => {
    const d = uniformPrior(grid2, 0.2);
    close(d.values[0]!, 0.4);
    close(d.values[1]!, 0.4);
    close(d.outside, 0.2);
    expect(checkInvariants(d)).toEqual([]);
  });

  it('weighted scenario mixture', () => {
    const a = dist([0.8, 0.2], 0);
    const b = dist([0.1, 0.5], 0.4);
    const m = mixture([
      { id: 'a', weight: 0.25, distribution: a },
      { id: 'b', weight: 0.75, distribution: b },
    ]);
    close(m.distribution.values[0]!, 0.25 * 0.8 + 0.75 * 0.1);
    close(m.distribution.values[1]!, 0.25 * 0.2 + 0.75 * 0.5);
    close(m.distribution.outside, 0.3);
    close(m.contributions.a![0]!, 0.2);
    expect(() => mixture([{ id: 'a', weight: 0.5, distribution: a }])).toThrow(/sum/);
  });

  it('clue likelihood update', () => {
    // prior 0.4/0.4/0.2, LR 3/1/1 → 1.2/0.4/0.2, Z = 1.8
    const r = applyLikelihood(dist([0.4, 0.4], 0.2), { lr: Float64Array.from([3, 1]), lrOutside: 1 });
    close(r.normalizationConstant, 1.8);
    close(r.posterior.values[0]!, 1.2 / 1.8);
    close(r.posterior.values[1]!, 0.4 / 1.8);
    close(r.posterior.outside, 0.2 / 1.8);
  });

  it('one-cell no-find search retains probability', () => {
    // prior 0.5/0.3/0.2, POD 0.6 in cell 0 → 0.2/0.3/0.2, Z = 0.7
    const r = noFindUpdate(dist([0.5, 0.3], 0.2), Float64Array.from([0.6, 0]));
    close(r.normalizationConstant, 0.7);
    close(r.posterior.values[0]!, 0.2 / 0.7);
    close(r.posterior.values[1]!, 0.3 / 0.7);
    close(r.posterior.outside, 0.2 / 0.7);
    expect(r.posterior.values[0]).toBeGreaterThan(0);
  });

  it('multi-cell POD update', () => {
    const r = noFindUpdate(dist([0.5, 0.5], 0), Float64Array.from([0.5, 0.8]));
    // 0.25 / 0.1, Z = 0.35
    close(r.posterior.values[0]!, 0.25 / 0.35);
    close(r.posterior.values[1]!, 0.1 / 0.35);
  });

  it('POS = Σ POA × POD', () => {
    close(probabilityOfSuccess(dist([0.5, 0.3], 0.2), [0.6, 0.5]), 0.3 + 0.15);
  });

  it('repeated search: cumulative POD with explicit dependence', () => {
    close(cumulativePod([0.5, 0.5]), 0.75);
    close(cumulativePod([0.5, 0.5], 1), 0.5);
    close(cumulativePod([0.5, 0.5], 0.5), 0.625);
    // Applying two independent 0.5 searches sequentially equals one 0.75 search.
    const p = dist([0.5, 0.5], 0);
    const seq = noFindUpdate(noFindUpdate(p, Float64Array.from([0.5, 0])).posterior, Float64Array.from([0.5, 0])).posterior;
    const once = noFindUpdate(p, Float64Array.from([0.75, 0])).posterior;
    close(seq.values[0]!, once.values[0]!);
  });

  it('outside-domain probability is never hidden and responds to evidence', () => {
    const r = applyLikelihood(dist([0.4, 0.4], 0.2), { lr: Float64Array.from([1, 1]), lrOutside: 3 });
    close(r.posterior.outside, 0.6 / 1.4);
    const s = setOutsideProbability(dist([0.4, 0.4], 0.2), 0.5, 'expanded scenario: possible exit via pass');
    close(s.posterior.outside, 0.5);
    close(s.posterior.values[0]!, 0.25);
    expect(() => setOutsideProbability(dist([0.4, 0.4], 0.2), 0.5, '')).toThrow(/rationale/);
  });

  it('zero and near-zero values', () => {
    const r = applyLikelihood(dist([0, 1 - 1e-300], 1e-300), { lr: Float64Array.from([1e6, 1]), lrOutside: 1 });
    expect(r.posterior.values[0]).toBe(0); // multiplicative updates cannot revive a zero cell
    expect(checkInvariants(r.posterior)).toEqual([]);
    expect(() => noFindUpdate(dist([1, 0], 0), Float64Array.from([1, 0]), { allowCertainDetection: true })).toThrow(/removed all probability/);
  });

  it('extreme likelihood ratios stay finite and normalized', () => {
    const r = applyLikelihood(dist([0.5, 0.5], 0), { lr: Float64Array.from([1e12, 1e-12]), lrOutside: 1 });
    expect(checkInvariants(r.posterior)).toEqual([]);
    expect(() => applyLikelihood(dist([0.5, 0.5], 0), { lr: Float64Array.from([Infinity, 1]), lrOutside: 1 })).toThrow();
    expect(() => applyLikelihood(dist([0.5, 0.5], 0), { lr: Float64Array.from([-1, 1]), lrOutside: 1 })).toThrow();
  });

  it('POD of 1 requires an explicit certainty flag', () => {
    expect(() => noFindUpdate(dist([0.5, 0.3], 0.2), Float64Array.from([1, 0]))).toThrow(/allowCertainDetection/);
    const r = noFindUpdate(dist([0.5, 0.3], 0.2), Float64Array.from([1, 0]), { allowCertainDetection: true });
    expect(r.posterior.values[0]).toBe(0);
  });
});

describe('distance rings', () => {
  it('validates tables and refuses to invent a tail', () => {
    expect(validateRingTable(TEST_TABLE)).toEqual([]);
    expect(validateRingTable({ ...TEST_TABLE, tailOuterDistanceM: null }).join()).toMatch(/tailOuterDistanceM/);
    expect(validateRingTable({ ...TEST_TABLE, breaks: [{ distanceM: 300, cumulativeProbability: 0.6 }, { distanceM: 200, cumulativeProbability: 0.9 }] })).not.toEqual([]);
  });

  it('a domain smaller than the rings pushes the remainder to outside-domain', () => {
    const big = makeGrid({ crs: 'test', originX: -2000, originY: -2000, cellSize: 50, cols: 80, rows: 80 });
    const small = makeGrid({ crs: 'test', originX: -300, originY: -300, cellSize: 50, cols: 12, rows: 12 });
    const pb = distanceRingPrior({ grid: big, planningPoint: { x: 0, y: 0 }, planningPointSigmaM: 0, table: TEST_TABLE });
    const ps = distanceRingPrior({ grid: small, planningPoint: { x: 0, y: 0 }, planningPointSigmaM: 0, table: TEST_TABLE });
    expect(checkInvariants(pb)).toEqual([]);
    expect(checkInvariants(ps)).toEqual([]);
    expect(pb.outside).toBeLessThan(0.02); // grid covers all rings; only discretisation error remains
    // Analytic: ring 2 (200–400 m) has (0.36 km² − π·0.04 km²)/(π·0.12 km²) ≈ 0.62 of its area in the 600 m square; the 0.1 tail is almost all outside.
    close(ps.outside, 0.4 * (1 - (360000 - Math.PI * 40000) / (Math.PI * 120000)) + 0.1, 0.02);
    // In the big grid the first ring holds ≈ 0.5 of the mass.
    let inner = 0;
    pb.values.forEach((v, i) => {
      const c = cellCentre(big, i);
      if (Math.hypot(c.x, c.y) < 200) inner += v;
    });
    close(inner, 0.5, 0.02);
  });

  it('planning-point uncertainty spreads probability without breaking invariants', () => {
    const g = makeGrid({ crs: 'test', originX: -1500, originY: -1500, cellSize: 50, cols: 60, rows: 60 });
    const sharp = distanceRingPrior({ grid: g, planningPoint: { x: 0, y: 0 }, planningPointSigmaM: 0, table: TEST_TABLE });
    const fuzzy = distanceRingPrior({ grid: g, planningPoint: { x: 0, y: 0 }, planningPointSigmaM: 150, table: TEST_TABLE });
    expect(checkInvariants(fuzzy)).toEqual([]);
    expect(Math.max(...fuzzy.values)).toBeLessThanOrEqual(Math.max(...sharp.values) + 1e-12);
  });
});

describe('route-weighted prior', () => {
  const route = [{ x: 0, y: 500 }, { x: 1000, y: 500 }];
  it('concentrates mass near the route but never all of it', () => {
    const c = routeCorridor({ grid: grid10, route, bufferM: 150, decayLengthM: 100, outsideProbability: 0.1 });
    const u = uniformPrior(grid10, 0.1);
    const r = routeWeightedPrior(c, u, 0.6);
    expect(checkInvariants(r)).toEqual([]);
    const near = r.values[5 * 10 + 5]!;
    const far = r.values[0]!;
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    expect(() => routeWeightedPrior(c, u, 1)).toThrow(/route confidence/);
  });
});

describe('POD engine', () => {
  const area = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 500 }, { x: 0, y: 500 }];
  it('exponential detection function', () => {
    close(exponentialPod(0), 0);
    close(exponentialPod(1), 1 - Math.exp(-1));
  });

  it('planned POD is uniform inside the assignment', () => {
    const p = plannedPod({ grid: grid10, area, sweepWidthM: 20, sweepWidthSource: 'fixture', plannedSpacingM: 20 });
    expect(p.assignmentCellCount).toBe(25);
    close(p.summaryPod, 1 - Math.exp(-1));
    expect(p.pod[99]).toBe(0);
  });

  it('achieved POD reflects only where the track went', () => {
    const track = [{ x: 50, y: 50 }, { x: 450, y: 50 }];
    const p = achievedPod({ grid: grid10, area, sweepWidthM: 20, sweepWidthSource: 'fixture', tracks: [track], clipBufferM: 0 });
    // Cells (0..3, row 0) and half of (4,row0)… track spans x 50→450 in row 0.
    close(p.coverage[1]!, (20 * 100) / 10000, 1e-9);
    expect(p.pod[10]).toBe(0); // row 1 never visited
    expect(p.summaryPod).toBeLessThan(0.05); // an incomplete track cannot claim full coverage
  });

  it('track length rasterisation conserves length inside the grid', () => {
    const line = [{ x: 10, y: 10 }, { x: 990, y: 730 }, { x: 120, y: 900 }];
    const l = rasterizePolylineLength(grid10, line);
    const expected = Math.hypot(980, 720) + Math.hypot(870, 170);
    close(sumValues(l), expected, 1e-6);
  });

  it('track assessment, cleaning and gap splitting', () => {
    const t0 = 0;
    const pts = [
      { x: 0, y: 0, t: t0 },
      { x: 10, y: 0, t: t0 + 10_000 },
      { x: 5000, y: 0, t: t0 + 20_000 }, // impossible jump
      { x: 20, y: 0, t: t0 + 30_000 },
      { x: 30, y: 0, t: t0 + 400_000 }, // gap
    ];
    const r = assessTrack(pts);
    expect(r.quality).toBe('suspect');
    expect(r.impossibleJumps).toContain(2);
    expect(r.gaps).toHaveLength(1);
    const c = cleanTrack(pts);
    expect(c.removed).toEqual([2]);
    expect(splitAtGaps(c.points)).toHaveLength(1);
    expect(pts).toHaveLength(5); // raw track preserved
  });
});

describe('geospatial', () => {
  it('detects self-intersecting polygons', () => {
    expect(validatePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).not.toEqual([]);
    expect(validatePolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toEqual([]);
  });

  it('cost distance respects barriers', () => {
    const g = makeGrid({ crs: 'test', originX: 0, originY: 0, cellSize: 10, cols: 5, rows: 3 });
    const cost = new Float64Array(15).fill(1);
    // wall down column 2 except the top row
    cost[2] = Infinity;
    cost[7] = Infinity;
    const d = costDistance(g, { x: 5, y: 5 }, cost);
    expect(d[2]).toBe(Infinity);
    expect(d[4]!).toBeGreaterThan(40); // must detour via the top row
    expect(Number.isFinite(d[4]!)).toBe(true);
  });
});

describe('surface store', () => {
  it('commits immutable versions, detects branches, and rolls back by appending', () => {
    let t = 0;
    const s = new SurfaceStore('training', () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString());
    const prior = uniformPrior(grid2, 0.2);
    const p = s.commit({ incidentId: 'X', parentSurfaceId: null, surfaceType: 'prior', distribution: prior, normalizationConstant: 1, modelVersion: 'v', inputs: {}, createdBy: 'u1', rationale: '' });
    const up = noFindUpdate(prior, Float64Array.from([0.5, 0]));
    const a = s.commit({ incidentId: 'X', parentSurfaceId: p.id, surfaceType: 'search_update', distribution: up.posterior, normalizationConstant: up.normalizationConstant, modelVersion: 'v', inputs: { pod: [0.5, 0] }, createdBy: 'u1', rationale: 'team 1 no find' });
    const b = s.commit({ incidentId: 'X', parentSurfaceId: p.id, surfaceType: 'search_update', distribution: up.posterior, normalizationConstant: up.normalizationConstant, modelVersion: 'v', inputs: { pod: [0.5, 0] }, createdBy: 'u2', rationale: 'same search entered offline' });
    expect(a.divergentBranch).toBe(false);
    expect(b.divergentBranch).toBe(true);
    expect(s.heads('X')).toHaveLength(2);
    const rb = s.rollback({ incidentId: 'X', headSurfaceId: a.id, targetSurfaceId: p.id, createdBy: 'u1', rationale: 'POD entered for wrong team' });
    expect(rb.iteration).toBe(2);
    expect(s.history('X')).toHaveLength(4);
    close(s.distribution(rb.id).values[0]!, 0.4);
    // Mutating a returned copy cannot change the store.
    s.distribution(p.id).values[0] = 99;
    close(s.distribution(p.id).values[0]!, 0.4);
    expect(() => new SurfaceStore('operational_disabled')).toThrow(/disabled/);
    expect(() => s.commit({ incidentId: 'X', parentSurfaceId: p.id, surfaceType: 'clue_update', distribution: dist([0.5, 0.6], 0), normalizationConstant: 1, modelVersion: 'v', inputs: {}, createdBy: 'u1', rationale: 'x' })).toThrow(/invariant/);
  });
});

describe('evaluation and leakage', () => {
  it('filters by availability time, not observation time', () => {
    const items = [
      { id: 'a', availableAt: '2026-01-01T10:00:00Z', observedAt: '2026-01-01T08:00:00Z' },
      { id: 'b', availableAt: '2026-01-01T13:00:00Z', observedAt: '2026-01-01T09:00:00Z' },
    ];
    expect(filterAvailable(items, '2026-01-01T12:00:00Z').map((i) => i.id)).toEqual(['a']);
    expect(leakageCheck({ cutoff: '2026-01-01T12:00:00Z', items, payload: {} })).toHaveLength(1);
    expect(leakageCheck({ cutoff: '2026-01-01T13:00:00Z', items, payload: { case: { find_location: [1, 2] } } })[0]).toMatch(/outcome/);
  });

  it('outcome cannot be revealed before lock, nor by a trainee', () => {
    const run = new EvaluationRun('X', '2026-01-01T12:00:00Z');
    let calls = 0;
    const provider = () => {
      calls++;
      return { x: 5, y: 5 };
    };
    expect(() => run.reveal(provider, { userId: 'e', role: 'evaluator' })).toThrow(/locked/);
    expect(calls).toBe(0);
    run.lock({ surfaceId: 's', candidate: dist([0.7, 0.1], 0.2), baselines: { uniform: uniformPrior(grid2, 0.2) }, lockedBy: 'e', inputHashes: {} });
    expect(() => run.reveal(provider, { userId: 't', role: 'planner_trainee' })).toThrow(/may not reveal/);
    expect(calls).toBe(0);
    const res = run.reveal(provider, { userId: 'e', role: 'evaluator' });
    close(res.candidate.findProbability, 0.7);
    close(res.baselines.uniform!.findProbability, 0.4);
    expect(res.candidate.rankPercentile).toBe(0);
  });

  it('metrics handle a find outside the domain', () => {
    const m = caseMetrics(dist([0.7, 0.1], 0.2), { x: 500, y: 500 });
    expect(m.findOutsideDomain).toBe(true);
    close(m.findProbability, 0.2);
    close(m.logScore, Math.log(0.2));
  });
});

describe('hashing', () => {
  it('sha256 matches known vectors', () => {
    expect(sha256(new TextEncoder().encode(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

// ---------------------------------------------------------------------------
// Property-based invariants
// ---------------------------------------------------------------------------

const arbDist = (n: number) =>
  fc
    .tuple(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: n, maxLength: n }), fc.double({ min: 0, max: 1, noNaN: true }))
    .filter(([v, o]) => v.reduce((a, b) => a + b, 0) + o > 1e-6)
    .map(([v, o]) => {
      const z = v.reduce((a, b) => a + b, 0) + o;
      const g = makeGrid({ crs: 'p', originX: 0, originY: 0, cellSize: 1, cols: n, rows: 1 });
      return { grid: g, values: Float64Array.from(v, (x) => x / z), outside: o / z } as Distribution;
    })
    .filter((d) => checkInvariants(d).length === 0);

const N = 6;
const arbPod = fc.array(fc.double({ min: 0, max: 0.999, noNaN: true }), { minLength: N, maxLength: N }).map((a) => Float64Array.from(a));
const arbLr = fc.array(fc.double({ min: 1e-6, max: 1e6, noNaN: true }), { minLength: N, maxLength: N }).map((a) => Float64Array.from(a));

describe('properties', () => {
  it('updates keep probabilities finite, non-negative and summing to one', () => {
    fc.assert(
      fc.property(arbDist(N), arbPod, arbLr, (d, pod, lr) => {
        const a = noFindUpdate(d, pod).posterior;
        const b = applyLikelihood(a, { lr, lrOutside: 1 }).posterior;
        return checkInvariants(a).length === 0 && checkInvariants(b).length === 0;
      }),
    );
  });

  it('a searched cell never gains relative to an identical unsearched cell', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 0.49, noNaN: true }), fc.double({ min: 0, max: 0.999, noNaN: true }), (p, d) => {
        const g = makeGrid({ crs: 'p', originX: 0, originY: 0, cellSize: 1, cols: 2, rows: 1 });
        const prior: Distribution = { grid: g, values: Float64Array.from([p, p]), outside: 1 - 2 * p };
        const post = noFindUpdate(prior, Float64Array.from([d, 0])).posterior;
        return post.values[0]! <= post.values[1]! + 1e-15;
      }),
    );
  });

  it('an LR greater than one increases relative odds', () => {
    fc.assert(
      fc.property(arbDist(N), fc.double({ min: 1.0001, max: 1e4, noNaN: true }), fc.integer({ min: 0, max: N - 1 }), (d, k, i) => {
        const j = (i + 1) % N;
        fc.pre(d.values[i]! > 1e-12 && d.values[j]! > 1e-12);
        const lr = new Float64Array(N).fill(1);
        lr[i] = k;
        const post = applyLikelihood(d, { lr, lrOutside: 1 }).posterior;
        return post.values[i]! / post.values[j]! > d.values[i]! / d.values[j]!;
      }),
    );
  });

  it('reordering cells does not change results', () => {
    fc.assert(
      fc.property(arbDist(N), arbPod, fc.constantFrom([5, 4, 3, 2, 1, 0], [1, 0, 3, 2, 5, 4], [2, 0, 1, 5, 3, 4]), (d, pod, perm) => {
        const a = noFindUpdate(d, pod).posterior;
        const dp: Distribution = { ...d, values: Float64Array.from(perm, (k) => d.values[k]!) };
        const b = noFindUpdate(dp, Float64Array.from(perm, (k) => pod[k]!)).posterior;
        return perm.every((k, i) => Math.abs(b.values[i]! - a.values[k]!) < 1e-14);
      }),
    );
  });

  it('serialising and loading a surface preserves values', () => {
    fc.assert(
      fc.property(arbDist(N), (d) => {
        const back = { ...d, ...JSON.parse(JSON.stringify({ values: Array.from(d.values), outside: d.outside })) };
        back.values = Float64Array.from(back.values);
        return back.values.every((v: number, i: number) => Math.abs(v - d.values[i]!) <= PROBABILITY_TOLERANCE) && checkInvariants(back).length === 0;
      }),
    );
  });

  it('kernel clue likelihoods never zero out any cell when credibility < 1', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.99, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (rel, relv) => {
        const k = gaussianKernel(grid10, { x: 300, y: 300 }, 80);
        const f = kernelLikelihood(grid10, k, { reliability: rel, relevance: relv });
        return f.lr.every((v) => v > 0) && f.lrOutside > 0;
      }),
    );
  });
});
