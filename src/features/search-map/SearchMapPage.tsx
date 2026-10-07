import { useMemo, useState } from 'react';
import { categories, LPB_CATEGORIES, LPB_TABLE, lookupBehaviour, PERCENTILES, terrains, type BehaviourTable } from '../../../packages/behaviour/src/index.ts';
import {
  buildSearchMap,
  DEFAULT_TRAIL_OPTIONS,
  distanceM,
  GENERATOR_VERSION,
  parseTrailFile,
  searchMapFileName,
  validateSearchMapInput,
  type SearchMap,
  type SearchMapInput,
} from '../../../packages/caltopo-export/src/index.ts';
import { formatLatLng, parseCoordinate } from '../../../packages/geospatial/src/coords.ts';
import type { IntakeFields, IntakeReader } from '../../../packages/intake/src/index.ts';
import { BehaviourTablePanel } from './BehaviourTablePanel.tsx';
import { Intake } from './Intake.tsx';
import { INITIAL_POD_STATE, SegmentPodPanel, segmentPodsFor, type PodState } from './SegmentPodPanel.tsx';

/**
 * Builds a CalTopo search map from incident details: range rings and dispersion
 * wedges looked up in a behaviour table for the subject category and terrain,
 * and first-cut segments. Everything runs in the browser; the only output is
 * the file the planner downloads.
 */

interface Row {
  percent: string;
  value: string;
}

const PERCENTS = PERCENTILES.map(String);
const emptyRows = (): Row[] => PERCENTS.map((percent) => ({ percent, value: '' }));
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

interface FormState {
  label: string;
  coord: string;
  kind: 'IPP' | 'LKP' | 'PLS';
  bearing: string;
  category: string;
  terrain: string;
  /** Rings and angles typed by hand instead of looked up. */
  manual: boolean;
  rings: Row[];
  ringSource: string;
  dispersion: Row[];
  dispersionSource: string;
  sectors: string;
  outTo: string;
  /** Trail corridor half-width (m), piece length (km) and the ring they stop at. */
  trailWidth: string;
  trailPiece: string;
  trailOutTo: string;
}

/** Trail lines read from the planner's file. Kept in memory only. */
interface TrailFile {
  name: string;
  lines: { lng: number; lat: number }[][];
  skipped: number;
}

const INITIAL: FormState = {
  label: '',
  coord: '',
  kind: 'IPP',
  bearing: '',
  category: '',
  terrain: 'temperate mountainous',
  manual: false,
  rings: emptyRows(),
  ringSource: '',
  dispersion: emptyRows(),
  dispersionSource: '',
  sectors: '8',
  outTo: '75',
  trailWidth: String(DEFAULT_TRAIL_OPTIONS.halfWidthM),
  trailPiece: String(DEFAULT_TRAIL_OPTIONS.pieceLengthM / 1000),
  trailOutTo: '75',
};

function toInput(f: FormState, table: BehaviourTable, trails: TrailFile | null): { input: SearchMapInput; notes: string[] } {
  const notes: string[] = [];
  const parsed = parseCoordinate(f.coord);
  const bearing = f.bearing.trim() === '' ? undefined : num(f.bearing);
  let rings: SearchMapInput['rings'] = [];
  let ringSource = '';
  let dispersion: NonNullable<SearchMapInput['dispersion']> = [];
  let dispersionSource = '';
  if (f.manual) {
    rings = f.rings.filter((r) => r.value.trim() !== '').map((r) => ({ percent: num(r.percent), distanceKm: num(r.value) }));
    ringSource = f.ringSource;
    dispersion = f.dispersion.filter((r) => r.value.trim() !== '').map((r) => ({ percent: num(r.percent), angleDeg: num(r.value) }));
    dispersionSource = f.dispersionSource;
  } else if (f.category && f.terrain) {
    const hit = lookupBehaviour(table, f.category, f.terrain);
    if (hit) {
      rings = PERCENTILES.map((p) => ({ percent: p, distanceKm: hit.entry.ringsKm[p] }));
      ringSource = hit.citation;
      if (hit.terrainFallback) notes.push(`No ${f.terrain} row for ${f.category}; using its "any" terrain row.`);
      if (hit.entry.dispersionDeg && bearing !== undefined) {
        dispersion = PERCENTILES.map((p) => ({ percent: p, angleDeg: hit.entry.dispersionDeg![p] }));
        dispersionSource = hit.citation;
      } else if (hit.entry.dispersionDeg) notes.push('Add a direction of travel to draw the dispersion wedges.');
      else notes.push('This table row has no dispersion angles, so no wedges are drawn.');
    }
  }
  return {
    notes,
    input: {
      label: f.label,
      planningPoint: { lat: parsed.ok ? parsed.lat : NaN, lng: parsed.ok ? parsed.lng : NaN, kind: f.kind },
      travelBearingDeg: bearing,
      subjectCategory: f.category || undefined,
      rings,
      ringSource,
      dispersion,
      dispersionSource,
      segments: f.sectors === '0' ? undefined : { sectors: Number(f.sectors), outToPercent: num(f.outTo) },
      trails: trails?.lines.length
        ? { lines: trails.lines, halfWidthM: num(f.trailWidth), pieceLengthM: num(f.trailPiece) * 1000, outToPercent: num(f.trailOutTo) }
        : undefined,
    },
  };
}

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
          const cls = f.properties.class !== 'Assignment' ? 'wedge' : String(f.properties.title).startsWith('T-') ? 'trail' : 'seg';
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

/** The looked-up rings and angles, read-only, with where they came from. */
function LookedUp({ input }: { input: SearchMapInput }) {
  const angle = (p: number) => input.dispersion?.find((d) => d.percent === p)?.angleDeg;
  return (
    <>
      <table className="num sm-rows">
        <thead>
          <tr><th scope="col">Percent of finds</th><th scope="col">Ring (km)</th><th scope="col">Dispersion (°)</th></tr>
        </thead>
        <tbody>
          {input.rings.map((r) => (
            <tr key={r.percent}>
              <th scope="row">{r.percent}%</th>
              <td>{r.distanceKm}</td>
              <td>{angle(r.percent) ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="cap">{input.ringSource}</p>
    </>
  );
}

export function SearchMapPage({ readers }: { readers?: IntakeReader[] } = {}) {
  const [f, setF] = useState<FormState>(INITIAL);
  const [table, setTable] = useState<BehaviourTable>(LPB_TABLE);
  const [trails, setTrails] = useState<TrailFile | null>(null);
  const [trailProblem, setTrailProblem] = useState('');
  const [podState, setPodState] = useState<PodState>(INITIAL_POD_STATE);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const coord = useMemo(() => (f.coord.trim() ? parseCoordinate(f.coord) : null), [f.coord]);
  const { input: baseInput, notes } = useMemo(() => toInput(f, table, trails), [f, table, trails]);
  // Segment names come from the map without PODs; PODs never change which segments exist.
  const segmentNames = useMemo(() => {
    if (validateSearchMapInput(baseInput).length) return [];
    return buildSearchMap(baseInput).features.filter((x) => x.properties.class === 'Assignment').map((x) => String(x.properties.title));
  }, [baseInput]);
  const input = useMemo<SearchMapInput>(() => {
    const p = segmentPodsFor(podState, segmentNames);
    return p ? { ...baseInput, segmentPods: p.pods, segmentPodSource: p.source } : baseInput;
  }, [baseInput, podState, segmentNames]);
  const errors = useMemo(() => {
    const e = validateSearchMapInput(input);
    if (!f.manual && !input.rings.length)
      e.unshift(
        f.category && f.terrain
          ? `${table.name} has no ${f.terrain} figures for ${f.category}. Load them from the book under "Load rows from a source", or enter values by hand`
          : 'choose a subject category and terrain to look up the rings',
      );
    return e.filter((x) => !(x.startsWith('ring source') && !f.manual && !input.rings.length));
  }, [input, f.manual, f.category, f.terrain, table.name]);
  const map = useMemo(() => (errors.length ? null : buildSearchMap(input)), [errors, input]);
  const counts = map && {
    rings: map.features.filter((x) => x.geometry?.type === 'LineString').length,
    wedges: map.features.filter((x) => x.geometry?.type === 'Polygon' && x.properties.class === 'Shape').length,
    segments: map.features.filter((x) => x.properties.class === 'Assignment' && !String(x.properties.title).startsWith('T-')).length,
    trails: map.features.filter((x) => x.properties.class === 'Assignment' && String(x.properties.title).startsWith('T-')).length,
  };

  async function readTrails(file: File | undefined) {
    if (!file) return;
    try {
      const r = parseTrailFile(await file.text());
      if (!r.lines.length) throw new Error('no trail lines found in the file');
      setTrails({ name: file.name, ...r });
      setTrailProblem('');
    } catch (e) {
      setTrails(null);
      setTrailProblem(`${file.name}: ${(e as Error).message}`);
    }
  }
  const withFigures = categories(table);
  // The book's full category list stays visible, so a missing category reads as "no figures yet" rather than as absent.
  const cats = [...new Set([...withFigures, ...(table === LPB_TABLE ? LPB_CATEGORIES : [])])];
  const terrs = terrains(table, f.category || undefined).filter((t) => t !== 'any');

  function applyIntake(x: IntakeFields) {
    setF((cur) => ({
      ...cur,
      coord: x.lat !== undefined && x.lng !== undefined ? formatLatLng(x.lat, x.lng) : cur.coord,
      kind: x.pointKind ?? cur.kind,
      bearing: x.travelBearingDeg !== undefined ? String(x.travelBearingDeg) : cur.bearing,
      category: x.subjectCategory && cats.includes(x.subjectCategory) ? x.subjectCategory : cur.category,
      // The reader says mountainous or flat; take the table's first terrain with that word (temperate before dry).
      terrain: (x.terrain && terrains(table).find((t) => t === x.terrain || t.endsWith(` ${x.terrain}`))) || cur.terrain,
    }));
  }

  function switchToManual() {
    // Start the hand-entry rows from what was looked up, so the planner edits rather than retypes.
    setF((cur) => ({
      ...cur,
      manual: true,
      rings: PERCENTS.map((p) => ({ percent: p, value: String(input.rings.find((r) => String(r.percent) === p)?.distanceKm ?? '') })),
      ringSource: input.ringSource,
      dispersion: PERCENTS.map((p) => ({ percent: p, value: String(input.dispersion?.find((r) => String(r.percent) === p)?.angleDeg ?? '') })),
      dispersionSource: input.dispersionSource ?? '',
    }));
  }

  function download() {
    if (!map) return;
    const blob = new Blob([JSON.stringify(map)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = searchMapFileName(input);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }

  return (
    <section className="page">
      <h2>Search map for CalTopo</h2>
      <p className="lede">
        Builds range rings, dispersion wedges and first-cut segments in the BYK template folders, as a file to import into CalTopo. Rings and angles come from the behaviour
        table for the subject category and terrain: the distances within which 25, 50, 75 and 95% of past subjects in that category were found. They are
        not detection probabilities. It runs in this browser and sends nothing anywhere.
      </p>
      <div className="sm-grid">
        <div className="sm-form">
          <Intake onUse={applyIntake} readers={readers} />

          <h3>2 · Planning point</h3>
          <label className="field" htmlFor="sm-coord">Coordinates (paste decimal degrees, degrees and minutes, or UTM)
            <input id="sm-coord" value={f.coord} placeholder="51.2034, -115.6120  or  11U 594123 5677123" autoComplete="off" spellCheck={false} onChange={(e) => set('coord', e.target.value)} />
          </label>
          {coord && (
            <p className={`cap ${coord.ok ? '' : 'sm-doc-bad'}`} aria-live="polite">
              {coord.ok ? <>Read as <b className="mono">{formatLatLng(coord.lat, coord.lng)}</b> ({coord.format}). {coord.warnings.join(' ')}</> : <>Could not read: {coord.error}.</>}
            </p>
          )}
          <div className="sm-row">
            <label className="field" htmlFor="sm-kind">Point
              <select id="sm-kind" value={f.kind} onChange={(e) => set('kind', e.target.value as FormState['kind'])}>
                <option>IPP</option>
                <option>LKP</option>
                <option>PLS</option>
              </select>
            </label>
            <label className="field" htmlFor="sm-label">Case label (place and date, no names)
              <input id="sm-label" value={f.label} maxLength={40} placeholder="e.g. Aurora Lake 2026-07-18" onChange={(e) => set('label', e.target.value)} />
            </label>
          </div>

          <h3>3 · Subject</h3>
          <div className="sm-row">
            <label className="field" htmlFor="sm-cat">Subject category
              <select id="sm-cat" value={f.category} onChange={(e) => set('category', e.target.value)}>
                <option value="">Choose</option>
                {cats.map((c) => <option key={c} value={c}>{c}{withFigures.includes(c) ? '' : ' (no figures loaded)'}</option>)}
              </select>
            </label>
            <label className="field" htmlFor="sm-terrain">Terrain
              <select id="sm-terrain" value={f.terrain} onChange={(e) => set('terrain', e.target.value)}>
                <option value="">Choose</option>
                {[...new Set([...terrs, ...(f.terrain ? [f.terrain] : [])])].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="field" htmlFor="sm-bearing">Direction of travel (° true)
              <input id="sm-bearing" inputMode="decimal" value={f.bearing} placeholder="blank if unknown" onChange={(e) => set('bearing', e.target.value)} />
            </label>
          </div>

          <h3>4 · Rings and dispersion</h3>
          <BehaviourTablePanel table={table} onChange={setTable} />
          {f.manual ? (
            <>
              <RowsTable rows={f.rings} onChange={(r) => set('rings', r)} unit="km" label="Distance" />
              <label className="field" htmlFor="sm-rsrc">Source of these distances
                <input id="sm-rsrc" value={f.ringSource} onChange={(e) => set('ringSource', e.target.value)} />
              </label>
              <RowsTable rows={f.dispersion} onChange={(r) => set('dispersion', r)} unit="°" label="Angle" />
              <label className="field" htmlFor="sm-dsrc">Source of these angles
                <input id="sm-dsrc" value={f.dispersionSource} onChange={(e) => set('dispersionSource', e.target.value)} />
              </label>
              <button type="button" className="link" onClick={() => set('manual', false)}>Use the behaviour table again</button>
            </>
          ) : (
            <>
              {input.rings.length > 0 && <LookedUp input={input} />}
              <button type="button" className="link" onClick={switchToManual}>Enter values by hand instead</button>
            </>
          )}
          {notes.map((n) => <p key={n} className="cap">{n}</p>)}

          <h3>5 · Unassigned segments</h3>
          <div className="sm-row">
            <label className="field" htmlFor="sm-sectors">Sectors
              <select id="sm-sectors" value={f.sectors} onChange={(e) => set('sectors', e.target.value)}>
                <option value="0">None</option>
                <option value="4">4</option>
                <option value="8">8</option>
                <option value="12">12</option>
                <option value="16">16</option>
              </select>
            </label>
            <label className="field" htmlFor="sm-outto">Out to ring
              <select id="sm-outto" value={f.outTo} onChange={(e) => set('outTo', e.target.value)} disabled={f.sectors === '0'}>
                {PERCENTS.map((p) => <option key={p} value={p}>{p}%</option>)}
              </select>
            </label>
          </div>
          <p className="cap">Segments are ring bands cut into equal sectors around the planning point. They are a starting grid: adjust them to trails, drainages and ridges in CalTopo before assigning.</p>

          <h3>Trail segments</h3>
          <label className="field" htmlFor="sm-trails">Trails file (GPX, or GeoJSON such as a CalTopo export of the trail lines)
            <input id="sm-trails" type="file" accept=".gpx,.json,.geojson,application/gpx+xml,application/geo+json,application/json" onChange={(e) => readTrails(e.target.files?.[0])} />
          </label>
          {trails && (
            <p className="cap">
              {trails.name}: {trails.lines.length} {trails.lines.length === 1 ? 'line' : 'lines'}{trails.skipped ? `, ${trails.skipped} other features skipped` : ''}.{' '}
              <button type="button" className="link" onClick={() => setTrails(null)}>Remove</button>
            </p>
          )}
          {trailProblem && <p className="sm-doc-bad" role="alert">{trailProblem}</p>}
          <div className="sm-row">
            <label className="field" htmlFor="sm-trail-width">Metres either side
              <input id="sm-trail-width" inputMode="numeric" value={f.trailWidth} onChange={(e) => set('trailWidth', e.target.value)} />
            </label>
            <label className="field" htmlFor="sm-trail-piece">Piece length (km)
              <input id="sm-trail-piece" inputMode="decimal" value={f.trailPiece} onChange={(e) => set('trailPiece', e.target.value)} />
            </label>
            <label className="field" htmlFor="sm-trail-outto">Out to ring
              <select id="sm-trail-outto" value={f.trailOutTo} onChange={(e) => set('trailOutTo', e.target.value)}>
                {PERCENTS.map((p) => <option key={p} value={p}>{p}%</option>)}
              </select>
            </label>
          </div>
          <p className="cap">Each trail inside the chosen ring becomes corridor segments T-1, T-2 and so on, cut into pieces of about equal length. The file is read in this browser and goes nowhere else.</p>

          <SegmentPodPanel state={podState} onChange={setPodState} names={segmentNames} />
        </div>

        <div className="sm-out">
          {map && counts ? (
            <>
              <Preview map={map} input={input} />
              <p className="meta">{counts.rings} rings · {counts.wedges} wedges · {counts.segments} segments{counts.trails ? ` · ${counts.trails} trail segments` : ''} · {GENERATOR_VERSION}</p>
              {table.kind === 'exercise' && !f.manual && <p className="sm-exercise">Exercise values. Load a behaviour table from a real source before using these rings for anything but training.</p>}
              <button className="primary" onClick={download}>Download CalTopo file</button>
              <p className="cap">In CalTopo, use Import on the map and choose this file. Every feature carries a title only, with no notes. The training mode is in the file name, and the sources are recorded in the file outside the map features.</p>
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
