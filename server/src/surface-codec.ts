import { gunzipSync, gzipSync } from 'node:zlib';
import { hashFloat64 } from '../../packages/domain/src/hash.ts';

/** Storage format for surface blobs: in-domain cell values then the outside-domain value, float64 LE, gzipped. */
export const SURFACE_FORMAT = 'float64-le+gzip';

export function encodeSurface(values: Float64Array, outside: number): Buffer {
  const buf = new Float64Array(values.length + 1);
  buf.set(values);
  buf[values.length] = outside;
  const view = new DataView(new ArrayBuffer(buf.length * 8));
  buf.forEach((v, i) => view.setFloat64(i * 8, v, true));
  return gzipSync(Buffer.from(view.buffer), { level: 6 });
}

export function decodeSurface(blob: Uint8Array, cellCount: number): { values: Float64Array; outside: number } {
  const raw = gunzipSync(blob);
  if (raw.length !== (cellCount + 1) * 8) throw new Error(`surface blob has ${raw.length} bytes, expected ${(cellCount + 1) * 8}`);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const values = new Float64Array(cellCount);
  for (let i = 0; i < cellCount; i++) values[i] = view.getFloat64(i * 8, true);
  return { values, outside: view.getFloat64(cellCount * 8, true) };
}

/** Same hash as the engine's SurfaceStore, so client and server fingerprints agree. */
export function surfaceHash(values: Float64Array, outside: number): string {
  return hashFloat64(values, [outside]);
}

/** Values travel over the API as base64 of little-endian float64 (cells, then outside). */
export function valuesFromBase64(b64: string): { values: Float64Array; outside: number } {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length % 8 !== 0 || raw.length < 16) throw new Error('values must be base64 float64 data');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const n = raw.length / 8 - 1;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = view.getFloat64(i * 8, true);
  return { values, outside: view.getFloat64(n * 8, true) };
}

export function valuesToBase64(values: Float64Array, outside: number): string {
  const view = new DataView(new ArrayBuffer((values.length + 1) * 8));
  values.forEach((v, i) => view.setFloat64(i * 8, v, true));
  view.setFloat64(values.length * 8, outside, true);
  return Buffer.from(view.buffer).toString('base64');
}
