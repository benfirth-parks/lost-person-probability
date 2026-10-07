import type pg from 'pg';
import { hashValue } from '../../packages/domain/src/hash.ts';
import { caseMetrics, leakageCheck, type CaseMetrics } from '../../packages/probability-engine/src/evaluation.ts';
import { checkInvariants, type Distribution } from '../../packages/probability-engine/src/distribution.ts';
import { makeGrid, type Grid } from '../../packages/geospatial/src/grid.ts';
import { asUser, type Tx } from './db.ts';
import { decryptFindLocation, type OutcomeKey } from './outcome-crypto.ts';
import type { CommitSurfaceBody } from './schemas.ts';
import { decodeSurface, encodeSurface, SURFACE_FORMAT, surfaceHash, valuesFromBase64, valuesToBase64 } from './surface-codec.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface Services {
  pool: pg.Pool;
  outcomeKeys: Map<string, OutcomeKey>;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Wraps a mutating operation so a replay with the same key returns the first
 * response, and a reuse of the key for a different request is refused.
 */
async function idempotent<T>(tx: Tx, userId: string, key: string | null, operation: string, request: unknown, run: () => Promise<T>): Promise<T> {
  if (!key) throw new ApiError(400, 'Idempotency-Key header is required for this request');
  const requestHash = hashValue({ operation, request });
  const prior = await tx.query('select operation, request_hash, response from research.idempotency_keys where user_id = $1 and key = $2', [userId, key]);
  if (prior.rowCount) {
    const row = prior.rows[0];
    if (row.operation !== operation || row.request_hash !== requestHash) throw new ApiError(409, 'Idempotency-Key was already used for a different request');
    return row.response as T;
  }
  const result = await run();
  await tx.query('insert into research.idempotency_keys (user_id, key, operation, request_hash, response) values ($1, $2, $3, $4, $5)', [
    userId,
    key,
    operation,
    requestHash,
    JSON.stringify(result),
  ]);
  return result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listIncidents(s: Services, userId: string) {
  return asUser(s.pool, userId, async (tx) => {
    const r = await tx.query(
      `select i.id, i.case_code, i.mode, i.incident_type, a.code as operating_area, i.information_cutoff, i.status, i.data_completeness,
              (select subject_category from research.subjects su where su.incident_id = i.id limit 1) as subject_category,
              (select status from research.evaluation_runs e where e.incident_id = i.id order by e.locked_at desc nulls last limit 1) as evaluation_status
         from research.search_incidents i join research.operating_areas a on a.id = i.operating_area_id
        order by i.case_code`,
    );
    return r.rows;
  });
}

const CLUE_COLUMNS = `id, incident_id, clue_type, observed_at, reported_at, available_at, st_asgeojson(geometry)::jsonb as geometry,
  uncertainty, source_type, source_identifier_code, reliability_class, relevance_class, standardized_summary, status, version, supersedes_id`;

/**
 * Incident brief. By default every time-stamped input is cut at the
 * information cutoff, even for roles that may see the full timeline; they must
 * ask for it explicitly, and RLS still decides whether they get it.
 */
export async function incidentDetail(s: Services, userId: string, incidentId: string, fullTimeline: boolean) {
  return asUser(s.pool, userId, async (tx) => {
    const inc = await tx.query('select * from research.search_incidents where id = $1', [incidentId]);
    if (!inc.rowCount) throw new ApiError(404, 'incident not found');
    const cutoff = inc.rows[0].information_cutoff as Date;
    const cut = fullTimeline ? '' : 'and available_at <= $2';
    const args = fullTimeline ? [incidentId] : [incidentId, cutoff];
    const [subjects, points, routes, domains, clues, assignments] = await Promise.all([
      tx.query('select subject_category, age_band, party_size, experience_class, mobility_factors, clothing_visibility_class from research.subjects where incident_id = $1', [incidentId]),
      tx.query(`select id, point_type, st_asgeojson(geometry)::jsonb as geometry, horizontal_uncertainty_m, observed_at, available_at, source_type, confidence from research.planning_points where incident_id = $1 ${cut}`, args),
      tx.query(`select id, st_asgeojson(geometry)::jsonb as geometry, route_type, destination, direction, confidence, available_at from research.intended_routes where incident_id = $1 ${cut}`, args),
      tx.query('select id, grid, spatial_representation, outside_probability, outside_rationale, coordinate_reference from research.search_domains where incident_id = $1', [incidentId]),
      tx.query(`select ${CLUE_COLUMNS} from research.clues where incident_id = $1 ${cut} order by available_at`, args),
      tx.query(`select id, name, resource_type, search_method, search_object, planned_spacing, planned_sweep_width, available_at, status, st_asgeojson(geometry)::jsonb as geometry from research.assignments where incident_id = $1 ${cut} order by available_at`, args),
    ]);
    // Deliberately no outcome fields: the incident row has none, and restricted.found_locations is unreachable.
    const i = inc.rows[0];
    return {
      incident: { id: i.id, caseCode: i.case_code, mode: i.mode, incidentType: i.incident_type, informationCutoff: i.information_cutoff, status: i.status },
      timeline: fullTimeline ? 'full' : 'to_cutoff',
      subjects: subjects.rows,
      planningPoints: points.rows,
      intendedRoutes: routes.rows,
      searchDomains: domains.rows,
      clues: clues.rows,
      assignments: assignments.rows,
    };
  });
}

function gridOf(row: { grid: Grid }): Grid {
  return makeGrid(row.grid);
}

async function loadSurface(tx: Tx, surfaceId: string): Promise<{ meta: Record<string, unknown>; dist: Distribution }> {
  const r = await tx.query(
    `select s.*, d.grid, sd.data, sd.cell_count
       from research.probability_surfaces s
       join research.search_domains d on d.id = s.search_domain_id
       join research.probability_surface_data sd on sd.surface_id = s.id
      where s.id = $1`,
    [surfaceId],
  );
  if (!r.rowCount) throw new ApiError(404, 'surface not found');
  const row = r.rows[0];
  const { values, outside } = decodeSurface(row.data, row.cell_count);
  if (surfaceHash(values, outside) !== row.values_hash) throw new ApiError(500, `surface ${surfaceId} failed its integrity check`);
  const { data: _d, cell_count: _c, grid: _g, ...meta } = row;
  return { meta, dist: { grid: gridOf(row), values, outside } };
}

export async function getSurface(s: Services, userId: string, surfaceId: string) {
  return asUser(s.pool, userId, async (tx) => {
    const { meta, dist } = await loadSurface(tx, surfaceId);
    return { surface: meta, grid: dist.grid, valuesBase64: valuesToBase64(dist.values, dist.outside) };
  });
}

export async function history(s: Services, userId: string, incidentId: string) {
  return asUser(s.pool, userId, async (tx) => {
    const r = await tx.query(
      `select s.id, s.iteration, s.parent_surface_id, s.surface_type, s.outside_domain_probability, s.normalization_constant,
              s.values_hash, s.input_hash, s.rationale, s.created_at, s.locked_at, u.display_code as created_by,
              m.component || '@' || m.version as model_version,
              pu.evidence_type, pu.evidence_id, pu.method, pu.parameters,
              exists (select 1 from research.probability_surfaces c where c.parent_surface_id = s.parent_surface_id and c.id <> s.id) as divergent_branch
         from research.probability_surfaces s
         join research.model_versions m on m.id = s.model_version_id
         left join research.application_users u on u.user_id = s.created_by
         left join research.probability_updates pu on pu.posterior_surface_id = s.id
        where s.incident_id = $1
        order by s.created_at, s.iteration`,
      [incidentId],
    );
    return r.rows;
  });
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

async function modelVersionId(tx: Tx, ref: { component: string; version: string }): Promise<string> {
  const r = await tx.query('select id from research.model_versions where component = $1 and version = $2', [ref.component, ref.version]);
  if (!r.rowCount) throw new ApiError(422, `model version ${ref.component}@${ref.version} is not registered`);
  return r.rows[0].id;
}

async function insertSurface(
  tx: Tx,
  userId: string,
  args: {
    incidentId: string;
    domainId: string;
    parentId: string | null;
    surfaceType: string;
    dist: Distribution;
    normalizationConstant: number;
    modelVersionId: string;
    inputHash: string;
    rationale: string;
  },
) {
  const errors = checkInvariants(args.dist);
  if (errors.length) throw new ApiError(422, 'probability invariants failed', errors);
  let iteration = 0;
  if (args.parentId) {
    const p = await tx.query('select iteration from research.probability_surfaces where id = $1 and incident_id = $2', [args.parentId, args.incidentId]);
    if (!p.rowCount) throw new ApiError(404, 'parent surface not found');
    iteration = p.rows[0].iteration + 1;
  }
  let inside = 0;
  for (const v of args.dist.values) inside += v;
  const valuesHash = surfaceHash(args.dist.values, args.dist.outside);
  const r = await tx.query(
    `insert into research.probability_surfaces
       (incident_id, search_domain_id, iteration, parent_surface_id, surface_type, storage_uri, storage_format, values_hash,
        in_domain_probability, outside_domain_probability, normalization_constant, probability_sum, model_version_id, input_hash, rationale, created_by)
     values ($1, $2, $3, $4, $5, 'db:research.probability_surface_data', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning id, iteration, created_at`,
    [
      args.incidentId, args.domainId, iteration, args.parentId, args.surfaceType, SURFACE_FORMAT, valuesHash,
      Math.min(1, inside), args.dist.outside, args.normalizationConstant, 1, args.modelVersionId, args.inputHash, args.rationale, userId,
    ],
  );
  const surface = r.rows[0];
  await tx.query('insert into research.probability_surface_data (surface_id, storage_format, cell_count, data) values ($1, $2, $3, $4)', [
    surface.id,
    SURFACE_FORMAT,
    args.dist.values.length,
    encodeSurface(args.dist.values, args.dist.outside),
  ]);
  return { id: surface.id as string, iteration: surface.iteration as number, valuesHash, createdAt: surface.created_at as Date };
}

export async function commitSurface(s: Services, userId: string, incidentId: string, body: CommitSurfaceBody, idemKey: string | null) {
  return asUser(s.pool, userId, (tx) =>
    idempotent(tx, userId, idemKey, 'commit-surface', { incidentId, body }, async () => {
      const d = await tx.query('select id, grid from research.search_domains where id = $1 and incident_id = $2', [body.searchDomainId, incidentId]);
      if (!d.rowCount) throw new ApiError(404, 'search domain not found for this incident');
      const grid = gridOf(d.rows[0]);
      let parsed: { values: Float64Array; outside: number };
      try {
        parsed = valuesFromBase64(body.valuesBase64);
      } catch (e) {
        throw new ApiError(400, (e as Error).message);
      }
      if (parsed.values.length !== grid.cols * grid.rows)
        throw new ApiError(422, `expected ${grid.cols * grid.rows} cell values, got ${parsed.values.length}`);
      const dist: Distribution = { grid, values: parsed.values, outside: parsed.outside };
      let parentHash = '';
      if (body.parentSurfaceId) {
        const p = await tx.query('select values_hash from research.probability_surfaces where id = $1', [body.parentSurfaceId]);
        parentHash = p.rows[0]?.values_hash ?? '';
      }
      const mv = await modelVersionId(tx, body.modelVersion);
      const inputHash = hashValue({ inputs: body.inputs ?? null, parentHash, modelVersion: body.modelVersion, surfaceType: body.surfaceType });
      const surface = await insertSurface(tx, userId, {
        incidentId,
        domainId: body.searchDomainId,
        parentId: body.parentSurfaceId,
        surfaceType: body.surfaceType,
        dist,
        normalizationConstant: body.normalizationConstant,
        modelVersionId: mv,
        inputHash,
        rationale: body.rationale,
      });
      if (body.evidence) {
        await tx.query(
          `insert into research.probability_updates (incident_id, prior_surface_id, posterior_surface_id, update_type, evidence_type, evidence_id,
             method, parameters, rationale, preview_hash, committed_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [incidentId, body.parentSurfaceId, surface.id, body.surfaceType, body.evidence.evidenceType, body.evidence.evidenceId,
           body.evidence.method, JSON.stringify(body.evidence.parameters), body.rationale, body.evidence.previewHash, userId],
        );
      }
      if (body.surfaceType === 'manual_adjustment' && body.adjustment) {
        await tx.query(
          `insert into research.manual_adjustments (incident_id, prior_surface_id, posterior_surface_id, adjustment_method, parameters, rationale, approved_by)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [incidentId, body.parentSurfaceId, surface.id, body.adjustment.method, JSON.stringify(body.adjustment.parameters), body.rationale, userId],
        );
      }
      return { ...surface, inputHash, outsideDomainProbability: dist.outside };
    }),
  );
}

export async function rollback(s: Services, userId: string, incidentId: string, b: { headSurfaceId: string; targetSurfaceId: string; rationale: string }, idemKey: string | null) {
  return asUser(s.pool, userId, (tx) =>
    idempotent(tx, userId, idemKey, 'rollback', { incidentId, b }, async () => {
      const target = await loadSurface(tx, b.targetSurfaceId);
      const head = await tx.query('select search_domain_id, values_hash from research.probability_surfaces where id = $1 and incident_id = $2', [b.headSurfaceId, incidentId]);
      if (!head.rowCount || target.meta.incident_id !== incidentId) throw new ApiError(404, 'surface not found for this incident');
      return insertSurface(tx, userId, {
        incidentId,
        domainId: head.rows[0].search_domain_id,
        parentId: b.headSurfaceId,
        surfaceType: 'rollback',
        dist: target.dist,
        normalizationConstant: 1,
        modelVersionId: target.meta.model_version_id as string,
        inputHash: hashValue({ rollbackTo: b.targetSurfaceId, targetHash: target.meta.values_hash, parentHash: head.rows[0].values_hash }),
        rationale: b.rationale,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export async function createEvaluation(s: Services, userId: string, b: { incidentId: string; informationCutoff: string }, idemKey: string | null) {
  return asUser(s.pool, userId, (tx) =>
    idempotent(tx, userId, idemKey, 'create-evaluation', b, async () => {
      const r = await tx.query(
        'insert into research.evaluation_runs (incident_id, information_cutoff, created_by) values ($1, $2, $3) returning id, status',
        [b.incidentId, b.informationCutoff, userId],
      );
      return r.rows[0] as { id: string; status: string };
    }),
  );
}

/** Builds the allowed-information package for a run's cutoff and checks it for leakage. */
export async function evaluationLeakageCheck(s: Services, userId: string, runId: string) {
  return asUser(s.pool, userId, async (tx) => {
    const run = await tx.query('select incident_id, information_cutoff from research.evaluation_runs where id = $1', [runId]);
    if (!run.rowCount) throw new ApiError(404, 'evaluation run not found');
    const { incident_id: incidentId, information_cutoff: cutoff } = run.rows[0];
    const q = async (sql: string) => (await tx.query(sql, [incidentId, cutoff])).rows;
    const items = [
      ...(await q(`select id, available_at from research.clues where incident_id = $1 and available_at <= $2`)),
      ...(await q(`select id, available_at from research.assignments where incident_id = $1 and available_at <= $2`)),
      ...(await q(`select id, available_at from research.planning_points where incident_id = $1 and available_at <= $2`)),
      ...(await q(`select id, available_at from research.intended_routes where incident_id = $1 and available_at <= $2`)),
    ].map((r) => ({ id: r.id as string, availableAt: (r.available_at as Date).toISOString() }));
    const payload = await incidentDetailInTx(tx, incidentId);
    const problems = leakageCheck({ cutoff: (cutoff as Date).toISOString(), items, payload });
    return { cutoff, itemCount: items.length, problems, packageHash: hashValue(payload) };
  });
}

async function incidentDetailInTx(tx: Tx, incidentId: string) {
  const i = await tx.query('select id, case_code, mode, incident_type, information_cutoff, status from research.search_incidents where id = $1', [incidentId]);
  const c = await tx.query(`select ${CLUE_COLUMNS} from research.clues where incident_id = $1 and available_at <= $2`, [incidentId, i.rows[0].information_cutoff]);
  return { incident: i.rows[0], clues: c.rows };
}

export async function lockEvaluation(s: Services, userId: string, runId: string, b: { surfaceId: string; baselineSurfaceIds: string[]; modelVersions: Record<string, string> }, idemKey: string | null) {
  return asUser(s.pool, userId, (tx) =>
    idempotent(tx, userId, idemKey, 'lock-evaluation', { runId, b }, async () => {
      const hashes = await tx.query('select id, input_hash, values_hash from research.probability_surfaces where id = any($1::uuid[])', [[b.surfaceId, ...b.baselineSurfaceIds]]);
      const inputHashes = Object.fromEntries(hashes.rows.map((r) => [r.id, { input: r.input_hash, values: r.values_hash }]));
      const r = await tx.query('select status, locked_at from research.lock_evaluation_run($1, $2, $3, $4, $5)', [
        runId,
        b.surfaceId,
        b.baselineSurfaceIds,
        JSON.stringify({ ...b.modelVersions, commit: process.env.COMMIT_REF ?? 'local' }),
        JSON.stringify(inputHashes),
      ]);
      return r.rows[0] as { status: string; locked_at: string };
    }),
  );
}

export interface RevealResult {
  findLocation: { crs: string; x: number; y: number };
  candidate: CaseMetrics;
  baselines: Record<string, CaseMetrics>;
}

/**
 * Reveal: the database releases the ciphertext only for a locked run and an
 * authorised role, and audits the read; the key never leaves this process.
 * Metrics are computed here with the engine and stored once. Revealing again
 * is naturally idempotent, and the plaintext find location is never written
 * anywhere (so this operation deliberately bypasses the idempotency table).
 */
export async function revealEvaluation(s: Services, userId: string, runId: string): Promise<RevealResult> {
  return asUser(s.pool, userId, async (tx) => {
    const out = await tx.query('select encrypted_geometry from research.reveal_outcome($1)', [runId]);
    const run = await tx.query('select incident_id, locked_surface_id, baseline_surface_ids, metrics from research.evaluation_runs where id = $1', [runId]);
    const { incident_id: incidentId, locked_surface_id: lockedId, baseline_surface_ids: baselineIds, metrics } = run.rows[0];
    if (!out.rowCount) throw new ApiError(409, 'no restricted find location is stored for this incident');
    const find = decryptFindLocation(out.rows[0].encrypted_geometry, incidentId, s.outcomeKeys);
    if (metrics) return { findLocation: find, candidate: metrics.candidate, baselines: metrics.baselines };
    const locked = await loadSurface(tx, lockedId);
    if (find.crs !== locked.dist.grid.crs) throw new ApiError(500, 'find location CRS does not match the search-domain grid');
    const baselines: Record<string, CaseMetrics> = {};
    for (const id of baselineIds as string[]) baselines[id] = caseMetrics((await loadSurface(tx, id)).dist, find);
    const result: RevealResult = { findLocation: find, candidate: caseMetrics(locked.dist, find), baselines };
    await tx.query('select research.record_evaluation_metrics($1, $2)', [runId, JSON.stringify({ candidate: result.candidate, baselines })]);
    return result;
  });
}

export async function evaluationResults(s: Services, userId: string, runId: string) {
  return asUser(s.pool, userId, async (tx) => {
    const r = await tx.query('select id, incident_id, status, information_cutoff, locked_surface_id, baseline_surface_ids, locked_at, outcome_revealed_at, metrics from research.evaluation_runs where id = $1', [runId]);
    if (!r.rowCount) throw new ApiError(404, 'evaluation run not found');
    return r.rows[0];
  });
}
