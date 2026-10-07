import fc from 'fast-check';
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { formatLatLng, parseCoordinate } from '../src/coords.ts';

const ok = (s: string) => {
  const r = parseCoordinate(s);
  if (!r.ok) throw new Error(`${s}: ${r.error}`);
  return r;
};

describe('parseCoordinate', () => {
  it('reads decimal degrees however they are pasted', () => {
    for (const s of ['51.2034, -115.6120', '51.2034,-115.6120', '51.2034 -115.6120', '51.2034N 115.6120W', 'N51.2034 W115.6120', '51.2034° N, 115.6120° W']) {
      const r = ok(s);
      expect([r.lat, r.lng, r.format], s).toEqual([51.2034, -115.612, 'decimal']);
    }
  });

  it('reads degrees and decimal minutes: 12.204′ = 0.2034°', () => {
    for (const s of ['N51 12.204 W115 36.720', "51°12.204'N 115°36.720'W", '51 12.204 N, 115 36.720 W']) {
      const r = ok(s);
      expect(r.format, s).toBe('degrees-minutes');
      expect(r.lat, s).toBeCloseTo(51.2034, 7);
      expect(r.lng, s).toBeCloseTo(-115.612, 7);
    }
  });

  it('reads degrees, minutes and seconds: 12′12.24″ = 0.2034°', () => {
    const r = ok(`51°12'12.24"N 115°36'43.2"W`);
    expect(r.format).toBe('degrees-minutes-seconds');
    expect(r.lat).toBeCloseTo(51.2034, 7);
    expect(r.lng).toBeCloseTo(-115.612, 7);
  });

  it('reads UTM with a band letter, a hemisphere letter or E/N suffixes', () => {
    // On zone 11's central meridian (117° W) the easting is exactly 500 000 m.
    const [, n] = proj4('WGS84', '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs', [-117, 51]);
    for (const s of [`11U 500000 ${n!.toFixed(1)}`, `11N 500000E ${n!.toFixed(1)}N`, `Zone 11 500000 ${n!.toFixed(1)}`]) {
      const r = ok(s);
      expect(r.format, s).toBe('utm');
      expect(r.lat, s).toBeCloseTo(51, 6);
      expect(r.lng, s).toBeCloseTo(-117, 6);
    }
    // One degree of latitude near 51° is about 111.2 km on the ground, × 0.9996 scale on the central meridian.
    expect(n! - proj4('WGS84', '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs', [-117, 50])[1]!).toBeGreaterThan(111_000);
    expect(ok('11U 594123 5677123').warnings).toEqual([]);
    expect(ok('11 594123 5677123').warnings).toEqual(['No band letter given; read as northern hemisphere.']);
  });

  it('swaps longitude-first input and says so', () => {
    const r = ok('-115.6120, 51.2034');
    expect([r.lat, r.lng]).toEqual([51.2034, -115.612]);
    expect(r.warnings).toContain('Read as longitude first, then latitude.');
  });

  it('warns about a missing minus sign on a Canadian longitude', () => {
    expect(ok('51.2034, 115.6120').warnings[0]).toMatch(/should be negative/);
  });

  it('refuses things that are not coordinates', () => {
    for (const s of ['', 'Exercise Lake', '91.5, -115', '51 75 N 115 30 W', '403-555-0142', '61U 500000 5650000']) expect(parseCoordinate(s).ok, s).toBe(false);
  });

  it('round-trips any Canadian point through its own decimal text', () => {
    fc.assert(
      fc.property(fc.double({ min: 41.7, max: 83, noNaN: true }), fc.double({ min: -141, max: -52.6, noNaN: true }), (lat, lng) => {
        const r = ok(formatLatLng(lat, lng, 6));
        expect(r.lat).toBeCloseTo(lat, 5);
        expect(r.lng).toBeCloseTo(lng, 5);
      }),
    );
  });

  it('round-trips through UTM', () => {
    fc.assert(
      fc.property(fc.double({ min: 49, max: 53, noNaN: true }), fc.double({ min: -119.9, max: -114.1, noNaN: true }), (lat, lng) => {
        const [e, n] = proj4('WGS84', '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs', [lng, lat]);
        const r = ok(`11U ${e!.toFixed(2)} ${n!.toFixed(2)}`);
        expect(r.lat).toBeCloseTo(lat, 6);
        expect(r.lng).toBeCloseTo(lng, 6);
      }),
    );
  });
});
