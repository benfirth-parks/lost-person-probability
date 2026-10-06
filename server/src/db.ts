import pg from 'pg';

/**
 * Runs `fn` in a transaction as the calling user: SET LOCAL ROLE
 * authenticated plus the JWT subject, so every query is filtered by the same
 * row-level-security policies the database tests prove. The server never
 * queries research data with elevated rights.
 */
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 4 });
}

export async function asUser<T>(pool: pg.Pool, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [
      userId,
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query('set local role authenticated');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
