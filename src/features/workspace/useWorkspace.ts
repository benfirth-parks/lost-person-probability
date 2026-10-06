import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import {
  ENGINE_VERSION,
  EvaluationRun,
  SurfaceStore,
  type CaseMetrics,
  type Distribution,
  type Point,
  type SurfaceRecord,
} from '../../../packages/probability-engine/src/index.ts';
import { CASE_CODE, EXERCISE_RINGS, INFORMATION_CUTOFF, SEALED_OUTCOME } from '../../../packages/exercises/alpine-ex-01.ts';
import { buildPrior, DEFAULT_SCENARIOS, ringsPrior, uniformBaseline, type PriorConfig, type Preview } from './model.ts';

export type Role = 'planner_trainee' | 'evaluator';
export const USERS: Record<Role, string> = { planner_trainee: 'trainee-01', evaluator: 'evaluator-01' };

/**
 * Local training data source: an in-memory append-only SurfaceStore for the
 * authored exercise. The API data source (src/lib/api.ts) offers the same
 * operations against the database once a Supabase project is configured.
 */
interface State {
  store: SurfaceStore;
  role: Role;
  headId: string;
  viewId: string;
  preview: Preview | null;
  run: EvaluationRun | null;
  revealed: { find: Point; candidate: CaseMetrics; baselines: Record<string, CaseMetrics> } | null;
  applied: string[];
  lastPod: Float64Array | null;
  priorCfg: PriorConfig;
  toast: { text: string; bad: boolean; n: number } | null;
}

function commitTo(store: SurfaceStore, p: Preview, parent: string | null, user: string, rationale: string): SurfaceRecord {
  return store.commit({
    incidentId: CASE_CODE,
    parentSurfaceId: p.kind === 'prior' ? null : parent,
    surfaceType: p.kind,
    distribution: p.posterior,
    normalizationConstant: p.normalizationConstant,
    modelVersion: ENGINE_VERSION,
    inputs: p.inputs,
    createdBy: user,
    rationale,
    provenance: p.provenance,
  });
}

function initial(): State {
  const store = new SurfaceStore('training');
  const priorCfg: PriorConfig = { scenarios: DEFAULT_SCENARIOS.map((s) => ({ ...s })), rings: EXERCISE_RINGS, routeConfidence: 0.6 };
  const rec = commitTo(store, buildPrior(priorCfg), null, USERS.planner_trainee, 'Initial scenario prior for exercise briefing');
  return { store, role: 'planner_trainee', headId: rec.id, viewId: rec.id, preview: null, run: null, revealed: null, applied: [], lastPod: null, priorCfg, toast: null };
}

export function useWorkspaceState() {
  const [s, setS] = useState<State>(initial);
  // Store mutations happen in event handlers (never inside state updaters, which React may run twice).
  const ref = useRef(s);
  ref.current = s;
  const patch = useCallback((p: Partial<State>) => setS((cur) => ({ ...cur, ...p })), []);
  const toast = useCallback((text: string, bad = false) => setS((cur) => ({ ...cur, toast: { text, bad, n: (cur.toast?.n ?? 0) + 1 } })), []);

  const actions = useMemo(
    () => ({
      setRole: (role: Role) => patch({ role }),
      setPriorCfg: (priorCfg: PriorConfig) => patch({ priorCfg }),
      setPreview: (preview: Preview | null) => patch({ preview }),
      view: (viewId: string) => patch({ viewId, preview: null }),
      toast,
      commit: (rationale: string) => {
        const cur = ref.current;
        if (!cur.preview) return;
        const p = cur.preview;
        try {
          const rec = commitTo(cur.store, p, cur.headId, USERS[cur.role], rationale);
          patch({
            headId: rec.id,
            viewId: rec.id,
            preview: null,
            applied: p.evidenceId ? [...cur.applied, p.evidenceId] : cur.applied,
            lastPod: p.kind === 'search_update' ? (p.pod ?? null) : cur.lastPod,
          });
          toast(`Committed iteration ${rec.iteration} (${rec.surfaceType.replace('_', ' ')}).`);
        } catch (e) {
          toast((e as Error).message, true);
        }
      },
      rollback: (targetId: string) => {
        const cur = ref.current;
        const rec = cur.store.rollback({ incidentId: CASE_CODE, headSurfaceId: cur.headId, targetSurfaceId: targetId, createdBy: USERS[cur.role], rationale: `Rollback to ${targetId} from history` });
        patch({ headId: rec.id, viewId: rec.id, preview: null });
        toast(`Rolled back. Iteration ${rec.iteration} added.`);
      },
      lock: () => {
        const cur = ref.current;
        const run = new EvaluationRun(CASE_CODE, INFORMATION_CUTOFF);
        cur.store.lock(cur.headId);
        run.lock({
          surfaceId: cur.headId,
          candidate: cur.store.distribution(cur.headId),
          baselines: { uniform: uniformBaseline(), rings: ringsPrior(cur.priorCfg.rings) },
          lockedBy: USERS[cur.role],
          inputHashes: { candidate: cur.store.get(cur.headId).inputHash },
        });
        patch({ run });
        toast('Run locked.');
      },
      reveal: () => {
        const cur = ref.current;
        try {
          const revealed = cur.run!.reveal(() => JSON.parse(atob(SEALED_OUTCOME)), { userId: USERS[cur.role], role: cur.role });
          patch({ revealed });
        } catch (e) {
          toast((e as Error).message, true);
        }
      },
    }),
    [patch, toast],
  );

  const head: Distribution = s.store.distribution(s.headId);
  const shown: Distribution = s.preview ? s.preview.posterior : s.store.distribution(s.viewId);
  return { ...s, head, shown, history: s.store.history(CASE_CODE), actions };
}

export type Workspace = ReturnType<typeof useWorkspaceState>;
export const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace(): Workspace {
  const w = useContext(WorkspaceContext);
  if (!w) throw new Error('useWorkspace outside WorkspaceContext');
  return w;
}
