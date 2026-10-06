// Thin Netlify Function: all /api/v1/* requests go through the shared router.
// Secrets come from the Netlify environment and are never exposed to the client.
import type { Config } from '@netlify/functions';
import { createPool } from '../../server/src/db.ts';
import { loadOutcomeKeys } from '../../server/src/outcome-crypto.ts';
import { handle, type RouterDeps } from '../../server/src/router.ts';

let deps: RouterDeps | null = null;

function init(): RouterDeps {
  const env = process.env;
  if (!env.SUPABASE_DB_URL || !env.SUPABASE_JWT_SECRET) throw new Error('SUPABASE_DB_URL and SUPABASE_JWT_SECRET must be set');
  return { pool: createPool(env.SUPABASE_DB_URL), jwtSecret: env.SUPABASE_JWT_SECRET, outcomeKeys: loadOutcomeKeys(env) };
}

export default async (req: Request) => handle(req, (deps ??= init()));

export const config: Config = { path: '/api/v1/*' };
