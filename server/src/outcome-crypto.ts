import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Find locations are encrypted with AES-256-GCM before they reach the
 * database. The key is held only by the server environment; the database
 * and the client never see it. The incident id is bound in as associated
 * data, so a ciphertext copied onto another incident fails to decrypt.
 *
 * Format: v1:<keyId>:<iv>:<tag>:<ciphertext>, each part base64url.
 */
export interface OutcomeKey {
  readonly id: string;
  readonly key: Buffer; // 32 bytes
}

export interface FindLocation {
  /** CRS of the incident's search-domain grid. */
  readonly crs: string;
  readonly x: number;
  readonly y: number;
}

export function loadOutcomeKeys(env: Record<string, string | undefined>): Map<string, OutcomeKey> {
  // OUTCOME_KEYS="keyId1:base64key,keyId2:base64key"; the first is used for new encryptions.
  const spec = env.OUTCOME_KEYS ?? '';
  const keys = new Map<string, OutcomeKey>();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, b64] = part.split(':');
    const key = Buffer.from(b64 ?? '', 'base64');
    if (!id || key.length !== 32) throw new Error('OUTCOME_KEYS entries must be keyId:base64(32 bytes)');
    keys.set(id, { id, key });
  }
  return keys;
}

export function encryptFindLocation(loc: FindLocation, incidentId: string, key: OutcomeKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv);
  cipher.setAAD(Buffer.from(incidentId, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(loc), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', key.id, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

export function decryptFindLocation(token: string, incidentId: string, keys: Map<string, OutcomeKey>): FindLocation {
  const [v, keyId, iv, tag, ct] = token.split(':');
  if (v !== 'v1' || !keyId || !iv || !tag || !ct) throw new Error('unrecognised outcome ciphertext');
  const key = keys.get(keyId);
  if (!key) throw new Error(`outcome key ${keyId} is not configured`);
  const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(incidentId, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  const loc = JSON.parse(pt) as FindLocation;
  if (typeof loc.x !== 'number' || typeof loc.y !== 'number' || typeof loc.crs !== 'string') throw new Error('malformed find location');
  return loc;
}
