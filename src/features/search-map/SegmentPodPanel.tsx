import {
  DEFAULT_POD_BINS,
  EXERCISE_SWEEP_TABLE,
  plannedSegmentPod,
  RESOURCE_LABELS,
  RESOURCES,
  SLOPES,
  VEGETATION,
  type Resource,
  type SegmentPlan,
  type SegmentPod,
  type SweepWidthTable,
} from '../../../packages/pod-engine/src/segment-pod.ts';
import type { SegmentPodFields } from '../../../packages/caltopo-export/src/index.ts';

/** Starting spacing for each resource. A planning choice the planner edits, not a statistic. */
export const DEFAULT_SPACING_M: Record<Resource, number> = { GROUND: 20, DOG_TRAIL: 100, AIR: 200 };

export interface PodState {
  enabled: boolean;
  defaults: SegmentPlan;
  /** Per-segment changes from the defaults. */
  overrides: Record<string, Partial<SegmentPlan>>;
  bins: { medium: number; high: number };
}

export const INITIAL_POD_STATE: PodState = {
  enabled: true,
  defaults: { resource: 'GROUND', vegetation: 'moderate', slope: 'gentle', spacingM: DEFAULT_SPACING_M.GROUND },
  overrides: {},
  bins: { ...DEFAULT_POD_BINS },
};

const TABLE: SweepWidthTable = EXERCISE_SWEEP_TABLE;

export function planFor(s: PodState, name: string): SegmentPlan {
  return { ...s.defaults, ...s.overrides[name] };
}

/** CalTopo fields for every named segment, plus the source line for the file metadata. */
export function segmentPodsFor(s: PodState, names: string[]): { pods: Record<string, SegmentPodFields>; source: string } | null {
  if (!s.enabled || !names.length) return null;
  const pods: Record<string, SegmentPodFields> = {};
  for (const n of names) {
    const plan = planFor(s, n);
    const r = plan.spacingM > 0 ? plannedSegmentPod(TABLE, plan, s.bins) : null;
    if (!r) continue;
    pods[n] = { resourceType: plan.resource, responsivePOD: r.podClass.responsive, unresponsivePOD: r.podClass.unresponsive, cluePOD: r.podClass.clue };
  }
  const label = TABLE.kind === 'exercise' ? `${TABLE.name} (exercise values, not research data)` : `${TABLE.name}. ${TABLE.source}`;
  return { pods, source: `sweep widths from ${label}; POD = 1 − e^(−W/spacing); LOW below ${pct(s.bins.medium)}, HIGH from ${pct(s.bins.high)}.` };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function PlanFields({ plan, onChange, idPrefix }: { plan: SegmentPlan; onChange: (p: Partial<SegmentPlan>) => void; idPrefix: string }) {
  return (
    <>
      <select aria-label="Resource" id={`${idPrefix}-res`} value={plan.resource}
        onChange={(e) => { const resource = e.target.value as Resource; onChange({ resource, spacingM: DEFAULT_SPACING_M[resource] }); }}>
        {RESOURCES.map((r) => <option key={r} value={r}>{RESOURCE_LABELS[r]}</option>)}
      </select>
      <select aria-label="Vegetation" id={`${idPrefix}-veg`} value={plan.vegetation} onChange={(e) => onChange({ vegetation: e.target.value as SegmentPlan['vegetation'] })}>
        {VEGETATION.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
      <select aria-label="Slope" id={`${idPrefix}-slope`} value={plan.slope} onChange={(e) => onChange({ slope: e.target.value as SegmentPlan['slope'] })}>
        {SLOPES.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
      <input aria-label="Spacing in metres" id={`${idPrefix}-sp`} inputMode="numeric" size={5} value={Number.isFinite(plan.spacingM) ? String(plan.spacingM) : ''}
        onChange={(e) => onChange({ spacingM: Number(e.target.value) })} />
    </>
  );
}

const cell = (r: SegmentPod | null, o: 'responsive' | 'unresponsive' | 'clue') => (r ? `${pct(r.pod[o])} ${r.podClass[o]}` : '–');

/** Section 6: planned POD per segment, written to CalTopo's responsive, unresponsive and clue POD fields. */
export function SegmentPodPanel({ state, onChange, names }: { state: PodState; onChange: (s: PodState) => void; names: string[] }) {
  const setDefaults = (p: Partial<SegmentPlan>) => onChange({ ...state, defaults: { ...state.defaults, ...p } });
  const setOne = (n: string, p: Partial<SegmentPlan>) => onChange({ ...state, overrides: { ...state.overrides, [n]: { ...state.overrides[n], ...p } } });
  return (
    <>
      <h3>6 · Planned POD</h3>
      <label className="sm-check">
        <input type="checkbox" checked={state.enabled} onChange={(e) => onChange({ ...state, enabled: e.target.checked })} /> Set planned POD on each segment
      </label>
      {state.enabled && (
        <>
          <p className="sm-exercise" role="note">
            Sweep widths are {TABLE.name}: {TABLE.source}
          </p>
          <div className="sm-row sm-pod-defaults">
            <span className="cap">All segments:</span>
            <PlanFields plan={state.defaults} onChange={setDefaults} idPrefix="pod-all" />
            <span className="cap">m spacing</span>
          </div>
          <p className="cap">
            Planned coverage is sweep width ÷ spacing, assuming the spacing is held across the whole segment; POD = 1 − e<sup>−coverage</sup>. CalTopo takes LOW, MEDIUM or HIGH:
            below {pct(state.bins.medium)} is LOW and from {pct(state.bins.high)} is HIGH (this tool's cut-offs, not a standard). These are plans; what a team actually covered comes from its track.
          </p>
          {names.length > 0 && (
            <div className="sm-pod-table-wrap">
              <table className="sm-pod-table">
                <thead>
                  <tr><th>Segment</th><th>Resource · vegetation · slope · spacing (m)</th><th>Responsive</th><th>Unresponsive</th><th>Clue</th></tr>
                </thead>
                <tbody>
                  {names.map((n) => {
                    const plan = planFor(state, n);
                    const r = plan.spacingM > 0 ? plannedSegmentPod(TABLE, plan, state.bins) : null;
                    return (
                      <tr key={n}>
                        <th scope="row">{n}</th>
                        <td><PlanFields plan={plan} onChange={(p) => setOne(n, p)} idPrefix={`pod-${n}`} /></td>
                        <td>{cell(r, 'responsive')}</td>
                        <td>{cell(r, 'unresponsive')}</td>
                        <td>{cell(r, 'clue')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
