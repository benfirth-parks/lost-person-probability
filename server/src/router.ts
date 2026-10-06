import { ZodError, type ZodType } from 'zod';
import { AuthError, verifyAccessToken } from './auth.ts';
import { CommitSurfaceBody, CreateEvaluationBody, LockEvaluationBody, RollbackBody, Uuid } from './schemas.ts';
import * as svc from './service.ts';

export interface RouterDeps extends svc.Services {
  jwtSecret: string;
}

type Handler = (ctx: { req: Request; userId: string; params: string[]; url: URL; deps: RouterDeps }) => Promise<unknown>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new svc.ApiError(400, 'request body must be JSON');
  }
  return schema.parse(raw);
}

const uuid = (v: string | undefined) => Uuid.parse(v);
const idem = (req: Request) => req.headers.get('idempotency-key');

const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/v1\/incidents$/, ({ userId, deps }) => svc.listIncidents(deps, userId)],
  ['GET', /^\/api\/v1\/incidents\/([^/]+)$/, ({ userId, deps, params, url }) =>
    svc.incidentDetail(deps, userId, uuid(params[0]), url.searchParams.get('timeline') === 'full')],
  ['GET', /^\/api\/v1\/incidents\/([^/]+)\/history$/, ({ userId, deps, params }) => svc.history(deps, userId, uuid(params[0]))],
  ['GET', /^\/api\/v1\/incidents\/([^/]+)\/surfaces\/([^/]+)$/, ({ userId, deps, params }) => svc.getSurface(deps, userId, uuid(params[1]))],
  ['POST', /^\/api\/v1\/incidents\/([^/]+)\/surfaces$/, async ({ req, userId, deps, params }) =>
    svc.commitSurface(deps, userId, uuid(params[0]), await body(req, CommitSurfaceBody), idem(req))],
  ['POST', /^\/api\/v1\/incidents\/([^/]+)\/rollback$/, async ({ req, userId, deps, params }) =>
    svc.rollback(deps, userId, uuid(params[0]), await body(req, RollbackBody), idem(req))],
  ['POST', /^\/api\/v1\/evaluations$/, async ({ req, userId, deps }) => svc.createEvaluation(deps, userId, await body(req, CreateEvaluationBody), idem(req))],
  ['POST', /^\/api\/v1\/evaluations\/([^/]+)\/leakage-check$/, ({ userId, deps, params }) => svc.evaluationLeakageCheck(deps, userId, uuid(params[0]))],
  ['POST', /^\/api\/v1\/evaluations\/([^/]+)\/lock$/, async ({ req, userId, deps, params }) =>
    svc.lockEvaluation(deps, userId, uuid(params[0]), await body(req, LockEvaluationBody), idem(req))],
  ['POST', /^\/api\/v1\/evaluations\/([^/]+)\/reveal$/, ({ userId, deps, params }) => svc.revealEvaluation(deps, userId, uuid(params[0]))],
  ['GET', /^\/api\/v1\/evaluations\/([^/]+)\/results$/, ({ userId, deps, params }) => svc.evaluationResults(deps, userId, uuid(params[0]))],
];

/** Postgres errors mapped to HTTP without echoing internals (or anything outcome-related) to the client. */
function pgStatus(code: string | undefined): [number, string] | null {
  switch (code) {
    case '42501':
      return [403, 'not permitted'];
    case 'P0002':
      return [404, 'not found'];
    case '23514':
    case '23502':
      return [422, 'the record failed a validation rule'];
    case '23505':
      return [409, 'duplicate record'];
    case '23503':
      return [422, 'a referenced record does not exist or is not visible to you'];
    case 'P0001':
      return [409, 'the request conflicts with the current state'];
    case '22P02':
      return [400, 'invalid input'];
    default:
      return null;
  }
}

export async function handle(req: Request, deps: RouterDeps): Promise<Response> {
  const url = new URL(req.url);
  const match = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
  if (!match) return json(404, { error: 'no such endpoint' });
  try {
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) throw new AuthError('missing bearer token');
    const caller = verifyAccessToken(auth.slice(7), deps.jwtSecret);
    const params = url.pathname.match(match[1])!.slice(1);
    const result = await match[2]({ req, userId: caller.userId, params, url, deps });
    return json(req.method === 'POST' ? 201 : 200, result);
  } catch (err) {
    if (err instanceof AuthError) return json(401, { error: err.message });
    if (err instanceof ZodError) return json(400, { error: 'invalid request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof svc.ApiError) return json(err.status, { error: err.message, details: err.details });
    const code = (err as { code?: string }).code;
    const mapped = pgStatus(code);
    if (mapped) {
      // Database messages for our own raise statements are safe and useful (e.g. "run is already locked").
      const message = code === 'P0001' || code === '42501' ? (err as Error).message : mapped[1];
      return json(mapped[0], { error: message });
    }
    console.error('unhandled API error', { path: url.pathname, code, name: (err as Error).name });
    return json(500, { error: 'internal error' });
  }
}
