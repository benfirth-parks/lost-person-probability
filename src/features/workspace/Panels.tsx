import { useState } from 'react';
import { checkInvariants, filterAvailable, probabilityOfSuccess, type CaseMetrics, type Distribution } from '../../../packages/probability-engine/src/index.ts';
import { ASSIGNMENTS, CLUES, INFORMATION_CUTOFF, IPP_SIGMA_M, type ExerciseAssignment } from '../../../packages/exercises/alpine-ex-01.ts';
import { parseSearchFile } from '../../../packages/importers/src/index.ts';
import { lngLatToLocal } from '../../lib/georef.ts';
import { clock, pct, prob } from './format.ts';
import { buildPrior, DEFAULT_IMPORT_PAIRING, importedAssignments, podFor, previewClue, previewSearch, shareInsideGrid, weightsValid, zoneSums, type ImportPairing } from './model.ts';
import { miniImage } from './raster.ts';
import { useWorkspace } from './useWorkspace.ts';

export const availableClues = () => filterAvailable(CLUES, INFORMATION_CUTOFF);
export const availableAssignments = () => filterAvailable(ASSIGNMENTS, INFORMATION_CUTOFF);

function Chip({ tone, children }: { tone?: 'ok' | 'warn'; children: React.ReactNode }) {
  return <span className={`chip ${tone ?? ''}`}>{children}</span>;
}

function ZoneTable({ cols }: { cols: { label: string; dist: Distribution }[] }) {
  const sums = cols.map((c) => zoneSums(c.dist));
  const base = sums[0]!;
  return (
    <div className="tablewrap">
      <table className="num">
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c.label} scope="col">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {base.zones.map((z, zi) => (
            <tr key={z.name}>
              <th scope="row">{z.name}</th>
              {sums.map((s, k) => {
                const v = s.zones[zi]!.p;
                const d = v - z.p;
                return (
                  <td key={k}>
                    {pct(v)}
                    {k > 0 && <small className={d >= 0 ? 'up' : 'down'}> {d >= 0 ? '+' : '−'}{pct(Math.abs(d))}</small>}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="outside">
            <th scope="row">Outside domain</th>
            {sums.map((s, k) => (
              <td key={k}>{pct(s.outside)}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function PreviewCard() {
  const w = useWorkspace();
  const [rationale, setRationale] = useState('');
  const p = w.preview;
  if (!p) return null;
  const errs = checkInvariants(p.posterior);
  const min = p.extreme ? 40 : p.kind === 'prior' ? 0 : 10;
  let max = 0;
  for (const v of p.posterior.values) max = Math.max(max, v);
  const cols = p.prior ? [{ label: 'Before', dist: p.prior }, ...(p.sensitivity ?? [{ label: 'After', dist: p.posterior }])] : [{ label: 'Prior', dist: p.posterior }];
  const ok = errs.length === 0 && rationale.trim().length >= min;
  return (
    <section className="preview" aria-label="Preview of an uncommitted update">
      <div>
        <span className="eyebrow">Preview, not yet committed</span>
        <h3>{p.title}</h3>
      </div>
      {p.prior && (
        <div className="minis">
          <figure><img src={miniImage(p.prior, max)} alt="" /><figcaption>Before</figcaption></figure>
          <figure><img src={miniImage(p.posterior, max)} alt="" /><figcaption>After</figcaption></figure>
          <figure><img src={miniImage(p.posterior, max, p.prior)} alt="" /><figcaption>Change: orange gained, blue lost</figcaption></figure>
        </div>
      )}
      <p className="cap">
        Probability by area.{p.sensitivity && ' Low and high recompute the update with reliability and relevance each 0.2 lower or higher.'}
      </p>
      <ZoneTable cols={cols} />
      <ul className="notes">
        {p.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
        <li>Normalization constant {p.normalizationConstant.toPrecision(6)}.</li>
      </ul>
      <div className={`check ${errs.length ? 'bad' : 'ok'}`}>
        {errs.length ? `Invariant check failed: ${errs.join('; ')}. Commit is disabled.` : 'Invariant checks pass: finite, non-negative, sums to 1.'}
      </div>
      <label className="field" htmlFor="rationale">
        Rationale {min ? <small>(required, {min}+ characters)</small> : <small>(optional)</small>}
        <textarea id="rationale" rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Why this update is justified" />
      </label>
      <div className="actions">
        <button className="primary" disabled={!ok} onClick={() => { w.actions.commit(rationale.trim() || 'Initial scenario prior'); setRationale(''); }}>
          Commit as new iteration
        </button>
        <button onClick={() => w.actions.setPreview(null)}>Discard preview</button>
      </div>
    </section>
  );
}

export function ScenariosPanel() {
  const w = useWorkspace();
  const cfg = w.priorCfg;
  const ok = weightsValid(cfg.scenarios);
  const sum = cfg.scenarios.reduce((s, x) => s + x.weight, 0);
  const preview = () => {
    try {
      w.actions.setPreview(buildPrior(cfg));
    } catch (e) {
      w.actions.toast((e as Error).message, true);
    }
  };
  return (
    <>
      <p className="lede">Build the prior as a weighted mix of explicit hypotheses. Weights must add to 1. The unresolved scenario keeps probability for possibilities nobody has named.</p>
      <div className="scen">
        {cfg.scenarios.map((s, i) => (
          <div className="scen-row" key={s.id}>
            <div className="scen-txt">
              <b>{s.id} {s.name}</b>
              <span>{s.describe}</span>
            </div>
            <label className="w" htmlFor={`w${i}`}>
              Weight
              <input id={`w${i}`} type="number" min={0} max={1} step={0.05} value={s.weight}
                onChange={(e) => w.actions.setPriorCfg({ ...cfg, scenarios: cfg.scenarios.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)) })} />
            </label>
          </div>
        ))}
      </div>
      <div className={`sumline ${ok ? 'ok' : 'bad'}`}>Weights sum to <b>{sum.toFixed(2)}</b>{ok ? '' : '. Adjust them to total 1.00.'}</div>
      <details className="rings">
        <summary>Distance rings and route settings</summary>
        <p className="warn">Exercise values. These are not behavioural statistics. A real case needs a table from an approved source with its sample size and region.</p>
        <div className="tablewrap">
          <table className="num">
            <thead><tr><th scope="col">Within (m)</th><th scope="col">Cumulative share</th></tr></thead>
            <tbody>
              {cfg.rings.breaks.map((b, i) => (
                <tr key={i}>
                  <td><input aria-label={`Ring ${i + 1} distance`} type="number" step={100} value={b.distanceM}
                    onChange={(e) => w.actions.setPriorCfg({ ...cfg, rings: { ...cfg.rings, version: 'ex-1-edited', breaks: cfg.rings.breaks.map((x, j) => (j === i ? { ...x, distanceM: Number(e.target.value) } : x)) } })} /></td>
                  <td><input aria-label={`Ring ${i + 1} cumulative share`} type="number" step={0.05} min={0} max={1} value={b.cumulativeProbability}
                    onChange={(e) => w.actions.setPriorCfg({ ...cfg, rings: { ...cfg.rings, version: 'ex-1-edited', breaks: cfg.rings.breaks.map((x, j) => (j === i ? { ...x, cumulativeProbability: Number(e.target.value) } : x)) } })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <label className="field" htmlFor="routeconf">Route confidence for S1 (max 0.90)
          <input id="routeconf" type="number" min={0} max={0.9} step={0.05} value={cfg.routeConfidence}
            onChange={(e) => w.actions.setPriorCfg({ ...cfg, routeConfidence: Number(e.target.value) })} />
        </label>
        <p className="cap">Trailhead position uncertainty: σ = {IPP_SIGMA_M} m. Whatever falls beyond the map edge counts as outside the domain.</p>
      </details>
      <div className="actions"><button className="primary" disabled={!ok} onClick={preview}>Preview prior</button></div>
      <p className="cap">A prior is already committed. Committing another starts a new root in the history; nothing is overwritten.</p>
    </>
  );
}

export function CluesPanel() {
  const w = useWorkspace();
  const avail = availableClues();
  const withheld = CLUES.length - avail.length;
  const [params, setParams] = useState<Record<string, { rel: number; rv: number; sg?: number }>>(() =>
    Object.fromEntries(CLUES.map((c) => [c.id, { rel: c.reliability, rv: c.relevance, sg: c.sigmaM }])),
  );
  return (
    <>
      <p className="lede">Clues available to planners by {clock(INFORMATION_CUTOFF)}. Reliability (is the report accurate?) and relevance (is it about this subject?) are set separately.</p>
      {avail.map((c) => {
        const v = params[c.id]!;
        const set = (k: 'rel' | 'rv' | 'sg', val: number) => setParams({ ...params, [c.id]: { ...v, [k]: val } });
        return (
          <article className="item" key={c.id}>
            <header><b>{c.id}</b> {c.type} {w.applied.includes(c.id) && <Chip tone="ok">applied</Chip>}</header>
            <p>{c.summary}</p>
            <p className="meta">
              Observed {clock(c.observedAt)} · Available {clock(c.availableAt)} ·{' '}
              {c.template === 'point' ? `±${c.sigmaM} m (1σ)` : `bearing ${c.bearingDeg}° ± ${c.halfAngleDeg}°, up to ${c.rangeM! / 1000} km`}
            </p>
            <div className="row3">
              <label>Reliability<input type="number" min={0} max={1} step={0.05} value={v.rel} onChange={(e) => set('rel', Number(e.target.value))} /></label>
              <label>Relevance<input type="number" min={0} max={1} step={0.05} value={v.rv} onChange={(e) => set('rv', Number(e.target.value))} /></label>
              {c.template === 'point' ? <label>σ (m)<input type="number" min={10} step={10} value={v.sg} onChange={(e) => set('sg', Number(e.target.value))} /></label> : <span />}
            </div>
            <button onClick={() => {
              try {
                w.actions.setPreview(previewClue(w.head, c, v.rel, v.rv, c.template === 'point' ? v.sg : undefined));
              } catch (e) {
                w.actions.toast((e as Error).message, true);
              }
            }}>Preview update</button>
          </article>
        );
      })}
      {withheld > 0 && <p className="withheld">{withheld} clue{withheld > 1 ? 's' : ''} withheld: became available after the cutoff.</p>}
    </>
  );
}

function AssignmentCard({ a, sweepWidthM, onSweepWidth, blocked, children }: { a: ExerciseAssignment; sweepWidthM: number; onSweepWidth: (v: number) => void; blocked?: string; children?: React.ReactNode }) {
  const w = useWorkspace();
  const p = podFor(a, sweepWidthM);
  return (
    <article className="item">
      <header><b>{a.id}</b> {a.name} {w.applied.includes(a.id) && <Chip tone="ok">applied</Chip>}</header>
      <p className="meta">{a.resource} · {a.method} · planned spacing {a.plannedSpacingM} m · {a.track.length ? <>track {p.quality}{p.gaps ? ` (${p.gaps} gap${p.gaps > 1 ? 's' : ''})` : ''}</> : 'no track'}</p>
      {children}
      <div className="tablewrap">
        <table className="num">
          <thead><tr><th /><th scope="col">Coverage</th><th scope="col">POD</th><th scope="col">POS</th></tr></thead>
          <tbody>
            <tr><th scope="row">Planned</th><td>{p.planned.summaryCoverage.toFixed(2)}</td><td>{pct(p.planned.summaryPod)}</td><td>{pct(probabilityOfSuccess(w.head, p.planned.pod), 2)}</td></tr>
            <tr><th scope="row">Achieved</th><td>{p.achieved.summaryCoverage.toFixed(2)}</td><td>{pct(p.achieved.summaryPod)}</td><td>{pct(probabilityOfSuccess(w.head, p.achieved.pod), 2)}</td></tr>
          </tbody>
        </table>
      </div>
      <label className="field inline">Effective sweep width (m, exercise value)
        <input type="number" min={1} step={5} value={sweepWidthM} onChange={(e) => onSweepWidth(Number(e.target.value))} />
      </label>
      {blocked && <p className="cap warn-text">{blocked}</p>}
      <button disabled={Boolean(blocked)} onClick={() => w.actions.setPreview(previewSearch(w.head, a, sweepWidthM))}>Preview no-find update</button>
    </article>
  );
}

function ImportSection() {
  const w = useWorkspace();
  const imp = w.imported;
  const [busy, setBusy] = useState(false);
  const cutoff = Date.parse(INFORMATION_CUTOFF);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const result = parseSearchFile(await file.text(), lngLatToLocal);
      const pairs: Record<string, ImportPairing> = {};
      // No automatic pairing: which team walked which area is for the planner to say.
      result.assignments.forEach((a) => (pairs[a.sourceId] = { trackId: null, ...DEFAULT_IMPORT_PAIRING }));
      w.actions.setImported({ fileName: file.name.slice(0, 60), result, pairs });
      w.actions.toast(`Read ${result.assignments.length} assignment${result.assignments.length === 1 ? '' : 's'} and ${result.tracks.length} track${result.tracks.length === 1 ? '' : 's'}.`);
    } catch (e) {
      w.actions.toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const setPair = (id: string, patch: Partial<ImportPairing>) => imp && w.actions.setImported({ ...imp, pairs: { ...imp.pairs, [id]: { ...imp.pairs[id]!, ...patch } } });
  const built = importedAssignments(imp);

  return (
    <section className="import">
      <h3>Import from CalTopo or GPX</h3>
      <p className="cap">Export assignments and tracks from CalTopo as GeoJSON, or a GPS track as GPX. The file is read in this browser and is not uploaded or sent anywhere. Descriptions and comments are dropped.</p>
      <label className="field">
        Search file
        <input type="file" accept=".json,.geojson,.gpx,application/geo+json,application/json,application/gpx+xml" disabled={busy} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      {imp && (
        <>
          <p className="meta">
            {imp.fileName} · {imp.result.assignments.length} areas · {imp.result.tracks.length} tracks · source <code>{imp.result.sourceHash.slice(0, 12)}</code>{' '}
            <button className="small" onClick={() => w.actions.setImported(null)}>Clear</button>
          </p>
          {imp.result.skipped.length > 0 && (
            <details>
              <summary>{imp.result.skipped.length} feature{imp.result.skipped.length === 1 ? '' : 's'} not imported</summary>
              <ul className="cap">{imp.result.skipped.map((s) => <li key={s.sourceId}>{s.sourceId}: {s.reason}</li>)}</ul>
            </details>
          )}
          {imp.result.assignments.length === 0 && <p className="cap">No polygon assignments in this file. Tracks need an assignment area before they can produce POD.</p>}
          {imp.result.assignments.map((src, i) => {
            const a = built[i]!;
            const pair = imp.pairs[src.sourceId]!;
            const track = imp.result.tracks.find((t) => t.sourceId === pair.trackId);
            const inside = track ? shareInsideGrid(track.points) : 1;
            const aerial = src.resourceType === 'AIR' || Boolean(track?.likelyAircraft);
            const blocked = aerial
              ? 'Aerial search has no approved POD model yet, so it cannot update the map. It is shown for reference only.'
              : !track
              ? 'Pair a recorded track first. A planned area alone is not achieved coverage.'
              : Date.parse(a.availableAt) > cutoff
                ? 'This track ends after the information cutoff, so it cannot be used in this run.'
                : inside === 0
                  ? 'This track lies entirely outside the case map, so it covers no cells.'
                  : undefined;
            return (
              <AssignmentCard key={src.sourceId} a={a} sweepWidthM={pair.sweepWidthM} onSweepWidth={(v) => setPair(src.sourceId, { sweepWidthM: v })} blocked={blocked}>
                <div className="pairing">
                  <label className="field inline">Track
                    <select value={pair.trackId ?? ''} onChange={(e) => setPair(src.sourceId, { trackId: e.target.value || null })}>
                      <option value="">None</option>
                      {imp.result.tracks.map((t) => <option key={t.sourceId} value={t.sourceId}>{t.label} ({t.likelyAircraft ? 'aircraft' : t.report.quality})</option>)}
                    </select>
                  </label>
                  <label className="field inline">Planned spacing (m)
                    <input type="number" min={1} step={5} value={pair.plannedSpacingM} onChange={(e) => setPair(src.sourceId, { plannedSpacingM: Number(e.target.value) })} />
                  </label>
                </div>
                <p className="cap">CalTopo status {src.status ?? 'unknown'}{src.resourceType ? ` · ${src.resourceType.toLowerCase()}` : ''}{src.status === 'DRAFT' ? '. A draft assignment may never have been searched; rely only on its track.' : ''}</p>
                {track && inside > 0 && inside < 1 && <p className="cap">{pct(1 - inside, 0)} of this track lies outside the case map and covers nothing.</p>}
              </AssignmentCard>
            );
          })}
        </>
      )}
    </section>
  );
}

export function SearchPanel() {
  const [sw, setSw] = useState<Record<string, number>>(() => Object.fromEntries(ASSIGNMENTS.map((a) => [a.id, a.sweepWidthM])));
  return (
    <>
      <p className="lede">Planned and achieved coverage are kept apart. Only the achieved POD from the GPS track updates the map.</p>
      {availableAssignments().map((a) => (
        <AssignmentCard key={a.id} a={a} sweepWidthM={sw[a.id]!} onSweepWidth={(v) => setSw({ ...sw, [a.id]: v })} />
      ))}
      <p className="cap">POD model: exponential sweep width, POD = 1 − e<sup>−C</sup> with coverage C = W·L/A per cell. Applying both searches assumes they are independent.</p>
      <ImportSection />
    </>
  );
}

export function HistoryPanel() {
  const w = useWorkspace();
  return (
    <>
      <p className="lede">Every committed surface, oldest first. Select one to view it. Rolling back appends a copy of an earlier surface as a new iteration.</p>
      <ol className="hist">
        {w.history.map((r) => {
          const isHead = r.id === w.headId;
          return (
            <li key={r.id} className={r.id === w.viewId ? 'sel' : ''}>
              <button className="hist-btn" onClick={() => w.actions.view(r.id)}>
                <span className="it">#{r.iteration}</span>
                <span className="ty">
                  {r.surfaceType.replace('_', ' ')} {isHead && <Chip>current</Chip>} {r.divergentBranch && <Chip tone="warn">branch</Chip>} {r.lockedAt && <Chip>locked</Chip>}
                </span>
                <span className="by">{r.createdBy} · {clock(r.createdAt)}</span>
              </button>
              <div className="hist-meta">
                {r.rationale || '—'}
                <br />
                <code>outside {pct(r.outsideDomainProbability, 2)} · Z {r.normalizationConstant.toPrecision(5)} · {r.valuesHash.slice(0, 12)}</code>
                {!isHead && <button className="small" onClick={() => w.actions.rollback(r.id)}>Roll back to #{r.iteration}</button>}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function MetricsRow({ label, m }: { label: string; m: CaseMetrics }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{prob(m.findProbability)}</td>
      <td>{m.areaFractionToCapture === null ? 'outside' : `top ${pct(m.areaFractionToCapture)}`}</td>
      <td>{m.logScore.toFixed(2)}</td>
      <td>{pct(m.topAreaProbability.p10)}</td>
    </tr>
  );
}

export function EvaluatePanel() {
  const w = useWorkspace();
  const status = w.run?.status ?? 'open';
  return (
    <>
      <p className="lede">Lock the current surface before the outcome is revealed. The run compares it with a uniform baseline and a distance-ring baseline built from the same inputs.</p>
      <ol className="steps">
        <li className="done">Build and update a surface <span>iteration #{w.store.get(w.headId).iteration}</span></li>
        <li className={status !== 'open' ? 'done' : ''}>Lock the run <span>{status === 'open' ? 'open' : 'locked'}</span></li>
        <li className={status === 'revealed' ? 'done' : ''}>Reveal the find location <span>{status === 'revealed' ? 'revealed' : 'hidden'}</span></li>
      </ol>
      <div className="actions">
        <button className="primary" disabled={status !== 'open'} onClick={w.actions.lock}>Lock run</button>
        <button disabled={status !== 'locked'} onClick={w.actions.reveal}>Reveal outcome</button>
      </div>
      {status === 'locked' && w.role !== 'evaluator' && <p className="cap">Revealing needs the evaluator role. Switch role in the header.</p>}
      {w.revealed && (
        <>
          <div className="tablewrap">
            <table className="num">
              <thead><tr><th /><th scope="col">POA at find</th><th scope="col">Area to reach find</th><th scope="col">Log score</th><th scope="col">Prob. in top 10 % area</th></tr></thead>
              <tbody>
                <MetricsRow label="Your surface" m={w.revealed.candidate} />
                <MetricsRow label="Uniform" m={w.revealed.baselines.uniform!} />
                <MetricsRow label="Distance rings" m={w.revealed.baselines.rings!} />
              </tbody>
            </table>
          </div>
          <p className="cap">Area to reach find: share of the domain covered, highest density first, before reaching the find cell. Lower is better. Log score uses a floor of 10⁻⁹; higher is better. One case says little.</p>
        </>
      )}
      <p className="cap">This local exercise keeps the outcome in the browser in encoded form. With the database connected, it stays encrypted server-side until a run is locked.</p>
    </>
  );
}
