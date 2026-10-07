import { useMemo, useState } from 'react';
import {
  buildSearchMap,
  distanceM,
  GENERATOR_VERSION,
  searchMapFileName,
  validateSearchMapInput,
  type SearchMap,
  type SearchMapInput,
} from '../../../packages/caltopo-export/src/index.ts';

/**
 * Builds a CalTopo search map (range rings, dispersion wedges, first-cut
 * segments) from initial details typed into this form. Everything runs in the
 * browser: no details are sent anywhere, and the only output is the file the
 * planner downloads.
 */

interface Row {
  percent: string;
  value: string;
}

const PERCENTS = ['25', '50', '75', '95'];
const emptyRows = (): Row[] => PERCENTS.map((percent) => ({ percent, value: '' }));
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

function toInput(f: FormState): SearchMapInput {
  const rings = f.rings.filter((r) => r.value.trim() !== '').map((r) => ({ percent: num(r.percent), distanceKm: num(r.value) }));
  const dispersion = f.dispersion.filter((r) => r.value.trim() !== '').map((r) => ({ percent: num(r.percent), angleDeg: num(r.value) }));
  return {
    label: f.label,
    planningPoint: { lat: num(f.lat), lng: num(f.lng), kind: f.kind },
    travelBearingDeg: f.bearing.trim() === '' ? undefined : num(f.bearing),
    rings,
    ringSource: f.ringSource,
    dispersion,
    dispersionSource: f.dispersionSource,
    segments: f.sectors === '0' ? undefined : { sectors: Number(f.sectors), outToPercent: num(f.outTo) },
  };
}

interface FormState {
  label: string;
  lat: string;
  lng: string;
  kind: 'IPP' | 'LKP' | 'PLS';
  bearing: string;
  rings: Row[];
  ringSource: string;
  dispersion: Row[];
  dispersionSource: string;
  sectors: string;
  outTo: string;
}

const INITIAL: FormState = {
  label: '',
  lat: '',
  lng: '',
  kind: 'IPP',
  bearing: '',
  rings: emptyRows(),
  ringSource: '',
  dispersion: emptyRows(),
  dispersionSource: '',
  sectors: '8',
  outTo: '75',
};

/** Plan view in metres around the planning point, for a quick check before download. */
function Preview({ map, input }: { map: SearchMap; input: SearchMapInput }) {
  const pp = input.planningPoint;
  const maxR = Math.max(...input.rings.map((r) => r.distanceKm * 1000));
  const toXY = (c: number[]) => {
    const p = { lng: c[0]!, lat: c[1]! };
    const d = distanceM(pp, p);
    const dx = distanceM(pp, { lng: p.lng, lat: pp.lat }) * Math.sign(p.lng - pp.lng);
    const dy = Math.sign(p.lat - pp.lat) * Math.sqrt(Math.max(0, d * d - dx * dx));
    return `${(dx / maxR) * 100},${(-dy / maxR) * 100}`;
  };
  return (
    <svg className="sm-preview" viewBox="-110 -110 220 220" role="img" aria-label="Preview of rings, wedges and segments around the planning point">
      {map.features.map((f) => {
        if (f.geometry?.type === 'Polygon') {
          const cls = f.properties.class === 'Assignment' ? 'seg' : 'wedge';
          return <polygon key={f.id} className={cls} points={f.geometry.coordinates[0]!.map(toXY).join(' ')} />;
        }
        if (f.geometry?.type === 'LineString') return <polyline key={f.id} className="ring" points={f.geometry.coordinates.map(toXY).join(' ')} />;
        return null;
      })}
      <circle cx="0" cy="0" r="2.2" className="pp" />
      <text x="0" y={-104} textAnchor="middle" className="n">N</text>
      <title>{`North is up. Outer ring ${Math.round(maxR) / 1000} km.`}</title>
    </svg>
  );
}

function RowsTable({ rows, onChange, unit, label }: { rows: Row[]; onChange: (rows: Row[]) => void; unit: string; label: string }) {
  return (
    <table className="num sm-rows">
      <thead>
        <tr><th scope="col">Percent of finds</th><th scope="col">{label} ({unit})</th></tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.percent}>
            <th scope="row">{r.percent}%</th>
            <td>
              <input
                inputMode="decimal"
                aria-label={`${label} for ${r.percent}%`}
                value={r.value}
                onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SearchMapPage() {
  const [f, setF] = useState<FormState>(INITIAL);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const input = useMemo(() => toInput(f), [f]);
  const errors = useMemo(() => validateSearchMapInput(input), [input]);
  const map = useMemo(() => (errors.length ? null : buildSearchMap(input)), [errors, input]);
  const counts = map && {
    rings: map.features.filter((x) => x.geometry?.type === 'LineString').length,
    wedges: map.features.filter((x) => x.geometry?.type === 'Polygon' && x.properties.class === 'Shape').length,
    segments: map.features.filter((x) => x.properties.class === 'Assignment').length,
  };

  function download() {
    if (!map) return;
    const blob = new Blob([JSON.stringify(map)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = searchMapFileName(input);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <section className="page">
      <h2>Search map for CalTopo</h2>
      <p className="lede">
        Builds range rings, dispersion wedges and first-cut segments in the BYK template folders, as a file to import into CalTopo. It runs in this browser and sends nothing anywhere. Ring
        distances and dispersion angles must come from a source you name; the tool has none of its own.
      </p>
      <div className="sm-grid">
        <div className="sm-form">
          <label className="field">Case label (place and date, no names)
            <input value={f.label} maxLength={40} placeholder="e.g. Aurora Lake 2026-07-18" onChange={(e) => set('label', e.target.value)} />
          </label>
          <div className="sm-row">
            <label className="field">Point
              <select value={f.kind} onChange={(e) => set('kind', e.target.value as FormState['kind'])}>
                <option>IPP</option>
                <option>LKP</option>
                <option>PLS</option>
              </select>
            </label>
            <label className="field">Latitude
              <input inputMode="decimal" value={f.lat} placeholder="51.1234" onChange={(e) => set('lat', e.target.value)} />
            </label>
            <label className="field">Longitude
              <input inputMode="decimal" value={f.lng} placeholder="-115.5678" onChange={(e) => set('lng', e.target.value)} />
            </label>
          </div>
          <label className="field">Direction of travel (degrees true, needed for dispersion wedges)
            <input inputMode="decimal" value={f.bearing} placeholder="leave blank if unknown" onChange={(e) => set('bearing', e.target.value)} />
          </label>

          <h3>Range rings</h3>
          <RowsTable rows={f.rings} onChange={(r) => set('rings', r)} unit="km" label="Distance" />
          <label className="field">Source of these distances (table and subject category)
            <input value={f.ringSource} placeholder="e.g. ISRID, hiker, mountainous" onChange={(e) => set('ringSource', e.target.value)} />
          </label>

          <h3>Dispersion angles</h3>
          <RowsTable rows={f.dispersion} onChange={(r) => set('dispersion', r)} unit="°" label="Angle" />
          <label className="field">Source of these angles
            <input value={f.dispersionSource} onChange={(e) => set('dispersionSource', e.target.value)} />
          </label>

          <h3>Unassigned segments</h3>
          <div className="sm-row">
            <label className="field">Sectors
              <select value={f.sectors} onChange={(e) => set('sectors', e.target.value)}>
                <option value="0">None</option>
                <option value="4">4</option>
                <option value="8">8</option>
                <option value="12">12</option>
                <option value="16">16</option>
              </select>
            </label>
            <label className="field">Out to ring
              <select value={f.outTo} onChange={(e) => set('outTo', e.target.value)} disabled={f.sectors === '0'}>
                {PERCENTS.map((p) => <option key={p} value={p}>{p}%</option>)}
              </select>
            </label>
          </div>
          <p className="cap">Segments are ring bands cut into equal sectors around the planning point. They are a starting grid: adjust them to trails, drainages and ridges in CalTopo before assigning.</p>
        </div>

        <div className="sm-out">
          {map && counts ? (
            <>
              <Preview map={map} input={input} />
              <p className="meta">{counts.rings} rings · {counts.wedges} wedges · {counts.segments} segments · {GENERATOR_VERSION}</p>
              <button className="primary" onClick={download}>Download CalTopo file</button>
              <p className="cap">In CalTopo, use Import on the map and choose this file. Every feature notes that it was generated in training/research mode and names its source.</p>
            </>
          ) : (
            <div className="sm-todo" aria-live="polite">
              <b>To build the file:</b>
              <ul>{errors.map((e) => <li key={e}>{e.charAt(0).toUpperCase() + e.slice(1)}.</li>)}</ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
