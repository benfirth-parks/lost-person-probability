/**
 * Typed client for /api/v1. Every mutating call sends an Idempotency-Key so
 * a retry after a dropped connection cannot create a duplicate iteration.
 * The access token comes from Supabase Auth once a project is configured;
 * until then the app runs on the local training data source.
 */
export interface ApiOptions {
  baseUrl?: string;
  getAccessToken: () => Promise<string>;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function createApi({ baseUrl = '/api/v1', getAccessToken }: ApiOptions) {
  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${await getAccessToken()}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiRequestError(res.status, json.error ?? res.statusText, json.details ?? json.issues);
    return json as T;
  }
  return {
    incidents: () => request<unknown[]>('GET', '/incidents'),
    incident: (id: string, fullTimeline = false) => request<unknown>('GET', `/incidents/${id}${fullTimeline ? '?timeline=full' : ''}`),
    history: (id: string) => request<unknown[]>('GET', `/incidents/${id}/history`),
    surface: (incidentId: string, surfaceId: string) => request<{ surface: unknown; grid: unknown; valuesBase64: string }>('GET', `/incidents/${incidentId}/surfaces/${surfaceId}`),
    commitSurface: (incidentId: string, body: unknown, key = newIdempotencyKey()) => request<{ id: string; iteration: number }>('POST', `/incidents/${incidentId}/surfaces`, body, key),
    rollback: (incidentId: string, body: { headSurfaceId: string; targetSurfaceId: string; rationale: string }, key = newIdempotencyKey()) =>
      request<{ id: string; iteration: number }>('POST', `/incidents/${incidentId}/rollback`, body, key),
    createEvaluation: (body: { incidentId: string; informationCutoff: string }, key = newIdempotencyKey()) => request<{ id: string }>('POST', '/evaluations', body, key),
    leakageCheck: (runId: string) => request<{ problems: string[]; itemCount: number; packageHash: string }>('POST', `/evaluations/${runId}/leakage-check`),
    lock: (runId: string, body: { surfaceId: string; baselineSurfaceIds: string[] }, key = newIdempotencyKey()) => request<{ status: string }>('POST', `/evaluations/${runId}/lock`, body, key),
    reveal: (runId: string) => request<unknown>('POST', `/evaluations/${runId}/reveal`),
    results: (runId: string) => request<unknown>('GET', `/evaluations/${runId}/results`),
  };
}

/** Encodes a surface for the API: little-endian float64 cells, then outside-domain, base64. */
export function encodeValues(values: Float64Array, outside: number): string {
  const view = new DataView(new ArrayBuffer((values.length + 1) * 8));
  values.forEach((v, i) => view.setFloat64(i * 8, v, true));
  view.setFloat64(values.length * 8, outside, true);
  let s = '';
  const bytes = new Uint8Array(view.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
