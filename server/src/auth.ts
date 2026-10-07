import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a Supabase access token (HS256, signed with the project JWT
 * secret) and returns its subject. Only `authenticated` tokens are accepted.
 */
export interface Caller {
  readonly userId: string;
  readonly claims: Record<string, unknown>;
}

export class AuthError extends Error {}

const b64url = (b: Buffer) => b.toString('base64url');

export function verifyAccessToken(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Caller {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw new AuthError('malformed token');
  }
  if (header.alg !== 'HS256') throw new AuthError('unsupported token algorithm');
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new AuthError('invalid token signature');
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) throw new AuthError('token expired');
  if (claims.role !== 'authenticated') throw new AuthError('token is not for an authenticated user');
  const sub = claims.sub;
  if (typeof sub !== 'string' || !/^[0-9a-f-]{36}$/i.test(sub)) throw new AuthError('token has no valid subject');
  return { userId: sub, claims };
}

/** Test and local-development helper. */
export function signAccessToken(sub: string, secret: string, ttlSeconds = 3600): string {
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64url(Buffer.from(JSON.stringify({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const s = b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${s}`;
}
