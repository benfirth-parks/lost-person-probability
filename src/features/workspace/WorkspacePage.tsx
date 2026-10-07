import { useEffect, useMemo, useState } from 'react';
import { checkInvariants, sumValues } from '../../../packages/probability-engine/src/index.ts';
import { cliffCell, elevation, grid, landMask, zoneOf, ZONES } from '../../../packages/exercises/alpine-ex-01.ts';
import { pct, prob } from './format.ts';
import { MapView, type Layers } from './MapView.tsx';
import { availableAssignments, availableClues, CluesPanel, EvaluatePanel, HistoryPanel, PreviewCard, ScenariosPanel, SearchPanel } from './Panels.tsx';
import { DECADES, RAMP_CSS } from './raster.ts';
import { useWorkspace } from './useWorkspace.ts';

const TABS = [
  ['scenarios', 'Scenarios', ScenariosPanel],
  ['clues', 'Clues', CluesPanel],
  ['search', 'Search & POD', SearchPanel],
  ['history', 'History', HistoryPanel],
  ['evaluate', 'Evaluate', EvaluatePanel],
] as const;
type Tab = (typeof TABS)[number][0];

const CELL_HA = (grid.cellSize * grid.cellSize) / 1e4;

function Inspector({ cell }: { cell: number }) {
  const w = useWorkspace();
  const d = w.shown;
  if (cell < 0) return <div className="inspector muted">Hover or tap a cell to inspect it.</div>;
  const v = d.values[cell]!;
  const pod = w.preview?.pod ?? w.lastPod;
  const higher = d.values.reduce((n, x) => n + (x > v ? 1 : 0), 0) / d.values.length;
  return (
    <div className="inspector" aria-live="polite">
      <span>Cell <b>{cell % grid.cols},{Math.floor(cell / grid.cols)}</b></span>
      <span>{ZONES[zoneOf[cell]!]}</span>
      <span>POA <b>{prob(v)}</b></span>
      <span><b>{prob(v / CELL_HA)}</b>/ha</span>
      <span>Top <b>{pct(Math.max(higher, 1 / d.values.length))}</b> of area</span>
      {pod && <span>POD <b>{pct(pod[cell]!, 0)}</b></span>}
      {!landMask[cell] && <span>Open water</span>}
      {cliffCell[cell] ? <span>Cliff</span> : null}
      <span className="muted">{Math.round(elevation[cell]!)} m</span>
    </div>
  );
}

function Legend({ max }: { max: number }) {
  const w = useWorkspace();
  const d = w.shown;
  const inside = sumValues(d.values);
  const errs = checkInvariants(d);
  const drift = inside + d.outside - 1;
  return (
    <div className="under">
      <div>
        <div className="ramp" style={{ background: RAMP_CSS }} aria-hidden="true" />
        <div className="ticks">
          {Array.from({ length: DECADES + 1 }, (_, k) => (
            <span key={k}>{prob(max / 10 ** k / CELL_HA)}</span>
          ))}
        </div>
        <p className="cap">Probability per hectare (log scale). Solid outline: smallest area holding 50 % of all probability. Dashed: 80 %.</p>
      </div>
      <div>
        <div className="massbar" role="img" aria-label={`In domain ${pct(inside)}, outside domain ${pct(d.outside)}`}>
          <span className="in" style={{ width: `${inside * 100}%` }} />
          <span className="out" style={{ width: `${d.outside * 100}%` }} />
        </div>
        <div className="masslabels">
          <span>In domain <b>{pct(inside)}</b></span>
          <span>Outside domain <b>{pct(d.outside)}</b></span>
        </div>
        <div className={`check ${errs.length ? 'bad' : 'ok'}`}>
          {errs.length ? errs.join('; ') : `Σ = 1 ${drift >= 0 ? '+' : '−'} ${Math.abs(drift).toExponential(1)} · invariants pass`}
        </div>
      </div>
    </div>
  );
}

export function WorkspacePage() {
  const w = useWorkspace();
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem('lpm-tab') as Tab) || 'scenarios';
    } catch {
      return 'scenarios';
    }
  });
  const [layers, setLayers] = useState<Layers>({ prob: true, hpd: true, features: true, clues: true, search: true });
  const [cell, setCell] = useState(-1);
  const [max, setMax] = useState(0);
  const clues = useMemo(availableClues, []);
  const assignments = useMemo(availableAssignments, []);
  useEffect(() => {
    try {
      localStorage.setItem('lpm-tab', tab);
    } catch {
      /* storage unavailable */
    }
  }, [tab]);
  const viewing = w.store.get(w.viewId);
  const Panel = TABS.find((t) => t[0] === tab)![2];

  return (
    <div className="grid">
      <section className="mapcol" aria-label="Map workspace">
        <div className="mapframe">
          <div className="maptop">
            <span>
              {w.preview ? (
                <><span className="chip warn">Previewing</span> uncommitted result</>
              ) : (
                <>Showing iteration <b>#{viewing.iteration}</b> · {viewing.surfaceType.replace('_', ' ')}{viewing.id !== w.headId && <> <span className="chip warn">not current</span></>}</>
              )}
            </span>
            <div className="layers" aria-label="Layers">
              {([['prob', 'Probability'], ['hpd', '50/80 % areas'], ['features', 'Terrain features'], ['clues', 'Clues'], ['search', 'Assignments & tracks']] as const).map(([k, label]) => (
                <label key={k}>
                  <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <MapView surface={w.shown} layers={layers} clues={clues} assignments={assignments} find={w.revealed?.find ?? null} onHover={setCell} onScale={setMax} />
          <Inspector cell={cell} />
        </div>
        <Legend max={max} />
      </section>
      <section className="panel" aria-label="Planning worksheet">
        <div className="tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="tabpanel" role="tabpanel">
          <PreviewCard key={w.preview ? `${w.preview.title}-${w.preview.normalizationConstant}` : "none"} />
          <Panel />
        </div>
      </section>
    </div>
  );
}
