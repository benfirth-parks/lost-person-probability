/**
 * API integration tests against a real Postgres + PostGIS database with the
 * migrations applied. Skipped unless TEST_DATABASE_URL points at a disposable
 * server where the connecting role may create databases.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyLikelihood, caseMetrics, gaussianKernel, kernelLikelihood, makeGrid, uniformPrior, type Distribution } from '../../packages/probability-engine/src/index.ts';
import { signAccessToken } from '../src/auth.ts';
import { decryptFindLocation, encryptFindLocation, loadOutcomeKeys } from '../src/outcome-crypto.ts';
import { handle, type RouterDeps } from '../src/router.ts';
import { valuesFromBase64, valuesToBase64 } from '../src/surface-codec.ts';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const root = join(import.meta.dirname, '..', '..');

const U = {
  admin: '00000000-0000-0000-0000-0000000000a1',
  evaluator: '00000000-0000-0000-0000-0000000000e1',
  trainee: '00000000-0000-0000-0000-0000000000c1',
  outsider: '00000000-0000-0000-0000-0000000000c2',
};
const INCIDENT = '30000000-0000-0000-0000-000000000001';
const DOMAIN = '70000000-0000-0000-0000-000000000001';
const CLUE = '40000000-0000-0000-0000-000000000001';
const SECRET = randomBytes(32).toString('hex');
const KEYSPEC = `k1:${randomBytes(32).toString('base64')}`;
const grid = makeGrid({ crs: 'EPSG:32611', originX: 500000, originY: 5700000, cellSize: 100, cols: 20, rows: 15 });
const FIND = { crs: 'EPSG:32611', x: 500000 + 7 * 100 + 50, y: 5700000 + 9 * 100 + 50 };

let dbName = '';
let deps: RouterDeps;
let ownerPool: pg.Pool;

async function call(method: string, path: string, who: keyof typeof U | null, body?: unknown, key?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who) headers.authorization = `Bearer ${signAccessToken(U[who], SECRET)}`;
  if (key) headers['idempotency-key'] = key;
  const res = await handle(new Request(`http://local${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), deps);
  return { status: res.status, body: (await res.json()) as any };
}

const commitBody = (d: Distribution, extra: Record<string, unknown>) => ({
  searchDomainId: DOMAIN,
  valuesBase64: valuesToBase64(d.values, d.outside),
  normalizationConstant: 1,
  modelVersion: { component: 'probability-engine', version: '0.1.0' },
  inputs: { test: true },
  ...extra,
});

describe.skipIf(!ADMIN_URL)('API against Postgres', () => {
  beforeAll(async () => {
    dbName = `lpm_api_${process.pid}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    await admin.end();
    const url = ADMIN_URL!.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    ownerPool = new pg.Pool({ connectionString: url, max: 2 });
    await ownerPool.query(readFileSync(join(root, 'supabase/local/auth_shim.sql'), 'utf8'));
    for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) await ownerPool.query(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));
    const keys = loadOutcomeKeys({ OUTCOME_KEYS: KEYSPEC });
    await ownerPool.query(`
      insert into research.application_users (user_id, display_code, role) values
        ('${U.admin}', 'admin-01', 'administrator'), ('${U.evaluator}', 'evaluator-01', 'evaluator'),
        ('${U.trainee}', 'trainee-01', 'planner_trainee'), ('${U.outsider}', 'trainee-02', 'planner_trainee');
      insert into research.operating_areas (id, code, name, local_time_zone, local_crs)
        values ('10000000-0000-0000-0000-000000000001', 'EX', 'Exercise area', 'America/Edmonton', 'EPSG:32611');
      insert into research.model_versions (component, version) values ('probability-engine', '0.1.0');
      insert into research.search_incidents (id, case_code, mode, incident_type, operating_area_id, information_cutoff, status,
          coordinate_sensitivity, privacy_classification, source_system, source_record_id)
        values ('${INCIDENT}', 'RT-API-01', 'retrospective', 'overdue_hiker', '10000000-0000-0000-0000-000000000001',
          '2026-07-18 22:00:00+00', 'ready', 'restricted', 'deidentified', 'fixture', 'fx-1');
      insert into research.incident_members (incident_id, user_id) values ('${INCIDENT}', '${U.trainee}'), ('${INCIDENT}', '${U.evaluator}');
      insert into research.search_domains (id, incident_id, geometry, spatial_representation, cell_size_m, coordinate_reference,
          outside_probability, outside_rationale, model_version_id, created_by, grid)
        select '${DOMAIN}', '${INCIDENT}', 'SRID=4326;MULTIPOLYGON(((-117 51,-116.97 51,-116.97 51.015,-117 51.015,-117 51)))', 'raster', 100,
          'EPSG:32611', 0.1, 'fixture', id, '${U.admin}', '${JSON.stringify(grid)}'::jsonb from research.model_versions;
      insert into research.clues (id, incident_id, clue_type, available_at, uncertainty, source_type, reliability_class, relevance_class,
          standardized_summary, restricted_payload_ciphertext, status, created_by) values
        ('${CLUE}', '${INCIDENT}', 'witness_sighting', '2026-07-18 20:00:00+00', '{}', 'witness', 'B', 'medium', 'Sighting near creek', 'secret-statement', 'active', '${U.admin}'),
        ('40000000-0000-0000-0000-000000000002', '${INCIDENT}', 'located_item', '2026-07-19 01:00:00+00', '{}', 'team', 'A', 'high', 'Item found upstream', null, 'active', '${U.admin}');`);
    await ownerPool.query(
      `insert into restricted.found_locations (incident_id, encrypted_geometry, source_system, source_record_id, access_class) values ($1, $2, 'fixture', 'fx-1', 'protected_outcome')`,
      [INCIDENT, encryptFindLocation(FIND, INCIDENT, keys.get('k1')!)],
    );
    deps = { pool: new pg.Pool({ connectionString: url, max: 4 }), jwtSecret: SECRET, outcomeKeys: keys };
  });

  afterAll(async () => {
    await deps?.pool.end();
    await ownerPool?.end();
    if (dbName) {
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`drop database if exists ${dbName} with (force)`);
      await admin.end();
    }
  });

  const prior = uniformPrior(grid, 0.1);
  const clueFix = applyLikelihood(prior, kernelLikelihood(grid, gaussianKernel(grid, { x: FIND.x - 150, y: FIND.y }, 200), { reliability: 0.7, relevance: 0.6 }));
  const ids: Record<string, string> = {};

  it('rejects missing and forged tokens', async () => {
    expect((await call('GET', '/api/v1/incidents', null)).status).toBe(401);
    const res = await handle(new Request('http://local/api/v1/incidents', { headers: { authorization: `Bearer ${signAccessToken(U.trainee, 'wrong-secret')}` } }), deps);
    expect(res.status).toBe(401);
  });

  it('lists cases only for members', async () => {
    expect((await call('GET', '/api/v1/incidents', 'trainee')).body).toHaveLength(1);
    expect((await call('GET', '/api/v1/incidents', 'outsider')).body).toHaveLength(0);
    expect((await call('GET', `/api/v1/incidents/${INCIDENT}`, 'outsider')).status).toBe(404);
  });

  it('cuts the brief at the information cutoff and never sends clue ciphertext or outcome data', async () => {
    const t = await call('GET', `/api/v1/incidents/${INCIDENT}`, 'trainee');
    expect(t.body.clues.map((c: any) => c.id)).toEqual([CLUE]);
    const tFull = await call('GET', `/api/v1/incidents/${INCIDENT}?timeline=full`, 'trainee');
    expect(tFull.body.clues).toHaveLength(1); // RLS still applies
    const e = await call('GET', `/api/v1/incidents/${INCIDENT}`, 'evaluator');
    expect(e.body.clues).toHaveLength(1); // cut by default even for evaluators
    const eFull = await call('GET', `/api/v1/incidents/${INCIDENT}?timeline=full`, 'evaluator');
    expect(eFull.body.clues).toHaveLength(2);
    for (const r of [t, tFull, e, eFull]) {
      const text = JSON.stringify(r.body);
      expect(text).not.toContain('secret-statement');
      expect(text).not.toMatch(/encrypted|found_location|v1:k1/);
      expect(text).not.toContain(String(FIND.x));
    }
  });

  it('commits a prior and a clue update, and returns values bit-for-bit', async () => {
    const p = await call('POST', `/api/v1/incidents/${INCIDENT}/surfaces`, 'trainee', commitBody(prior, { parentSurfaceId: null, surfaceType: 'prior' }), 'key-prior-0001');
    expect(p.status).toBe(201);
    expect(p.body.iteration).toBe(0);
    ids.prior = p.body.id;
    const c = await call(
      'POST',
      `/api/v1/incidents/${INCIDENT}/surfaces`,
      'trainee',
      commitBody(clueFix.posterior, {
        parentSurfaceId: ids.prior,
        surfaceType: 'clue_update',
        normalizationConstant: clueFix.normalizationConstant,
        rationale: 'Witness credible; clothing matches',
        evidence: { evidenceType: 'clue', evidenceId: CLUE, method: 'kernel-likelihood/point@1', parameters: { reliability: 0.7, relevance: 0.6 }, previewHash: 'preview-abcdef' },
      }),
      'key-clue-0001',
    );
    expect(c.status).toBe(201);
    expect(c.body.iteration).toBe(1);
    ids.clue = c.body.id;
    const g = await call('GET', `/api/v1/incidents/${INCIDENT}/surfaces/${ids.clue}`, 'trainee');
    const back = valuesFromBase64(g.body.valuesBase64);
    expect(back.values).toEqual(clueFix.posterior.values);
    expect(back.outside).toBe(clueFix.posterior.outside);
  });

  it('refuses invalid surfaces and enforces idempotency keys', async () => {
    const bad = { ...prior, values: prior.values.map((v, i) => (i === 0 ? v + 0.01 : v)) };
    const r1 = await call('POST', `/api/v1/incidents/${INCIDENT}/surfaces`, 'trainee', commitBody(bad, { parentSurfaceId: null, surfaceType: 'prior' }), 'key-bad-00001');
    expect(r1.status).toBe(422);
    expect(r1.body.details.join()).toMatch(/sum/);
    const small = uniformPrior(makeGrid({ ...grid, cols: 5 }), 0.1);
    const r2 = await call('POST', `/api/v1/incidents/${INCIDENT}/surfaces`, 'trainee', commitBody(small, { parentSurfaceId: null, surfaceType: 'prior' }), 'key-bad-00002');
    expect(r2.status).toBe(422);
    const r3 = await call('POST', `/api/v1/incidents/${INCIDENT}/surfaces`, 'trainee', commitBody(prior, { parentSurfaceId: null, surfaceType: 'prior' }));
    expect(r3.status).toBe(400);
    const r4 = await call('POST', `/api/v1/incidents/${INCIDENT}/surfaces`, 'trainee', commitBody(prior, { parentSurfaceId: ids.prior, surfaceType: 'search_update' }), 'key-bad-00003');
    expect(r4.status).toBe(400); // no rationale, no evidence
    const replay = await call('POST', `/api/v1/incidents/${INCIDENT}/surfaces`, 'trainee', commitBody(prior, { parentSurfaceId: null, surfaceType: 'prior' }), 'key-prior-0001');
    expect(replay.body.id).toBe(ids.prior);
    const reuse = await call('POST', `/api/v1/incidents/${INCIDENT}/surfaces`, 'trainee', commitBody(prior, { parentSurfaceId: null, surfaceType: 'prior', inputs: { other: 1 } }), 'key-prior-0001');
    expect(reuse.status).toBe(409);
    const outsider = await call('POST', `/api/v1/incidents/${INCIDENT}/surfaces`, 'outsider', commitBody(prior, { parentSurfaceId: null, surfaceType: 'prior' }), 'key-outsider-01');
    expect(outsider.status).toBe(404);
  });

  it('records history and rolls back by appending', async () => {
    const rb = await call('POST', `/api/v1/incidents/${INCIDENT}/rollback`, 'trainee', { headSurfaceId: ids.clue, targetSurfaceId: ids.prior, rationale: 'Clue later judged unrelated' }, 'key-rollback-01');
    expect(rb.status).toBe(201);
    expect(rb.body.iteration).toBe(2);
    const h = await call('GET', `/api/v1/incidents/${INCIDENT}/history`, 'trainee');
    expect(h.body.map((r: any) => r.surface_type)).toEqual(['prior', 'clue_update', 'rollback']);
    expect(h.body[1].created_by).toBe('trainee-01');
    expect(h.body[1].evidence_id).toBe(CLUE);
  });

  it('runs the locked evaluation workflow end to end', async () => {
    expect((await call('POST', '/api/v1/evaluations', 'trainee', { incidentId: INCIDENT, informationCutoff: '2026-07-18T22:00:00Z' }, 'key-eval-tr-01')).status).toBe(403);
    const run = await call('POST', '/api/v1/evaluations', 'evaluator', { incidentId: INCIDENT, informationCutoff: '2026-07-18T22:00:00Z' }, 'key-eval-0001');
    expect(run.status).toBe(201);
    const runId = run.body.id;
    const leak = await call('POST', `/api/v1/evaluations/${runId}/leakage-check`, 'evaluator');
    expect(leak.body.problems).toEqual([]);
    expect(leak.body.itemCount).toBe(1);

    const early = await call('POST', `/api/v1/evaluations/${runId}/reveal`, 'evaluator');
    expect(early.status).toBe(403);
    expect(early.body.error).toMatch(/before the run is locked/);
    expect((await call('POST', `/api/v1/evaluations/${runId}/reveal`, 'trainee')).status).toBe(403);

    const lock = await call('POST', `/api/v1/evaluations/${runId}/lock`, 'evaluator', { surfaceId: ids.clue, baselineSurfaceIds: [ids.prior] }, 'key-lock-0001');
    expect(lock.status).toBe(201);
    expect(lock.body.status).toBe('locked');
    expect((await call('POST', `/api/v1/evaluations/${runId}/reveal`, 'trainee')).status).toBe(403);

    const rev = await call('POST', `/api/v1/evaluations/${runId}/reveal`, 'evaluator');
    expect(rev.status).toBe(201);
    expect(rev.body.findLocation).toEqual(FIND);
    const expected = caseMetrics(clueFix.posterior, FIND);
    expect(rev.body.candidate.findProbability).toBeCloseTo(expected.findProbability, 15);
    expect(rev.body.baselines[ids.prior!].findProbability).toBeCloseTo(0.9 / 300, 15);
    expect(rev.body.candidate.findProbability).toBeGreaterThan(rev.body.baselines[ids.prior!].findProbability);

    const again = await call('POST', `/api/v1/evaluations/${runId}/reveal`, 'evaluator');
    expect(again.body.candidate).toEqual(rev.body.candidate);
    const res = await call('GET', `/api/v1/evaluations/${runId}/results`, 'trainee');
    expect(res.body.status).toBe('revealed');
    expect(JSON.stringify(res.body)).not.toContain(String(FIND.x));

    const audit = await ownerPool.query("select action from audit.audit_events where action in ('lock', 'restricted_read') order by id");
    expect(audit.rows.map((r) => r.action)).toEqual(['lock', 'restricted_read', 'restricted_read']);
    const stored = await ownerPool.query("select count(*)::int as n from research.idempotency_keys where response::text like $1", [`%${FIND.x}%`]);
    expect(stored.rows[0].n).toBe(0); // plaintext find location never persisted
  });
});

describe('outcome encryption', () => {
  it('binds ciphertext to its incident and key', () => {
    const keys = loadOutcomeKeys({ OUTCOME_KEYS: KEYSPEC });
    const token = encryptFindLocation(FIND, INCIDENT, keys.get('k1')!);
    expect(decryptFindLocation(token, INCIDENT, keys)).toEqual(FIND);
    expect(() => decryptFindLocation(token, '30000000-0000-0000-0000-000000000099', keys)).toThrow();
    expect(() => decryptFindLocation(token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), INCIDENT, keys)).toThrow();
    expect(() => loadOutcomeKeys({ OUTCOME_KEYS: 'k1:short' })).toThrow();
  });
});
