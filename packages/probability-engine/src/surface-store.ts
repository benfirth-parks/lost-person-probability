import { hashFloat64, hashValue } from '../../domain/src/hash.ts';
import type { Grid } from '../../geospatial/src/grid.ts';
import { assertValid, sumValues, type Distribution } from './distribution.ts';

export type SurfaceType = 'prior' | 'clue_update' | 'search_update' | 'manual_adjustment' | 'rollback';
export type ProductMode = 'retrospective' | 'training' | 'operational_disabled';

/** An immutable, committed probability surface (mirrors the `probability_surfaces` table). */
export interface SurfaceRecord {
  readonly id: string;
  readonly incidentId: string;
  readonly mode: ProductMode;
  readonly iteration: number;
  readonly parentSurfaceId: string | null;
  readonly surfaceType: SurfaceType;
  readonly grid: Grid;
  readonly outsideDomainProbability: number;
  readonly inDomainProbability: number;
  readonly probabilitySum: number;
  readonly normalizationConstant: number;
  readonly modelVersion: string;
  /** Hash of every input that produced this surface (parameters, evidence, parent hash). */
  readonly inputHash: string;
  /** Hash of the stored values; recomputed on read to detect corruption. */
  readonly valuesHash: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly rationale: string;
  /** Evidence and method that caused this iteration. */
  readonly provenance: Readonly<Record<string, unknown>>;
  /** True when another surface already had the same parent (divergent branch). */
  readonly divergentBranch: boolean;
  readonly lockedAt: string | null;
}

export interface CommitInput {
  readonly incidentId: string;
  readonly parentSurfaceId: string | null;
  readonly surfaceType: SurfaceType;
  readonly distribution: Distribution;
  readonly normalizationConstant: number;
  readonly modelVersion: string;
  readonly inputs: unknown;
  readonly createdBy: string;
  readonly rationale: string;
  readonly provenance?: Record<string, unknown>;
}

export class SurfaceStoreError extends Error {}

/**
 * Append-only store of probability surfaces. Nothing is updated in place:
 * every change is a new record linked to its parent. Values are copied in
 * and out so that callers cannot mutate committed data. The in-memory
 * implementation defines the contract a database adapter must honour.
 */
export class SurfaceStore {
  private readonly records = new Map<string, SurfaceRecord>();
  private readonly values = new Map<string, Float64Array>();
  private readonly order: string[] = [];
  private seq = 0;

  constructor(
    readonly mode: ProductMode,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (mode === 'operational_disabled') throw new SurfaceStoreError('operational mode is disabled in this release');
  }

  commit(input: CommitInput): SurfaceRecord {
    assertValid(input.distribution);
    if (!input.createdBy) throw new SurfaceStoreError('every surface must identify the responsible user');
    if (!(input.normalizationConstant > 0) || !Number.isFinite(input.normalizationConstant))
      throw new SurfaceStoreError('normalization constant must be stored and positive');
    if (input.surfaceType !== 'prior' && input.rationale.trim().length === 0)
      throw new SurfaceStoreError('updates require a rationale');
    let iteration = 0;
    let divergentBranch = false;
    let parentHash = '';
    if (input.parentSurfaceId !== null) {
      const parent = this.records.get(input.parentSurfaceId);
      if (!parent) throw new SurfaceStoreError(`parent surface ${input.parentSurfaceId} not found`);
      if (parent.incidentId !== input.incidentId) throw new SurfaceStoreError('parent belongs to a different incident');
      iteration = parent.iteration + 1;
      parentHash = parent.valuesHash;
      divergentBranch = [...this.records.values()].some((r) => r.parentSurfaceId === input.parentSurfaceId);
    } else if (input.surfaceType !== 'prior') {
      throw new SurfaceStoreError('only a prior may have no parent');
    }
    const values = Float64Array.from(input.distribution.values);
    const valuesHash = hashFloat64(values, [input.distribution.outside]);
    const inputHash = hashValue({ inputs: input.inputs, parentHash, modelVersion: input.modelVersion, surfaceType: input.surfaceType });
    const inDomain = sumValues(values);
    const id = `srf_${(++this.seq).toString().padStart(4, '0')}_${valuesHash.slice(0, 8)}`;
    const record: SurfaceRecord = Object.freeze({
      id,
      incidentId: input.incidentId,
      mode: this.mode,
      iteration,
      parentSurfaceId: input.parentSurfaceId,
      surfaceType: input.surfaceType,
      grid: input.distribution.grid,
      outsideDomainProbability: input.distribution.outside,
      inDomainProbability: inDomain,
      probabilitySum: inDomain + input.distribution.outside,
      normalizationConstant: input.normalizationConstant,
      modelVersion: input.modelVersion,
      inputHash,
      valuesHash,
      createdBy: input.createdBy,
      createdAt: this.now(),
      rationale: input.rationale,
      provenance: Object.freeze({ ...(input.provenance ?? {}) }),
      divergentBranch,
      lockedAt: null,
    });
    this.records.set(id, record);
    this.values.set(id, values);
    this.order.push(id);
    return record;
  }

  get(id: string): SurfaceRecord {
    const r = this.records.get(id);
    if (!r) throw new SurfaceStoreError(`surface ${id} not found`);
    return r;
  }

  /** Returns a copy of the surface as a Distribution after verifying its stored hash. */
  distribution(id: string): Distribution {
    const r = this.get(id);
    const v = Float64Array.from(this.values.get(id)!);
    if (hashFloat64(v, [r.outsideDomainProbability]) !== r.valuesHash) throw new SurfaceStoreError(`surface ${id} failed its integrity check`);
    return { grid: r.grid, values: v, outside: r.outsideDomainProbability };
  }

  /** Rollback creates a new iteration whose values equal an earlier surface. The original history stays. */
  rollback(args: { incidentId: string; headSurfaceId: string; targetSurfaceId: string; createdBy: string; rationale: string }): SurfaceRecord {
    const target = this.get(args.targetSurfaceId);
    return this.commit({
      incidentId: args.incidentId,
      parentSurfaceId: args.headSurfaceId,
      surfaceType: 'rollback',
      distribution: this.distribution(target.id),
      normalizationConstant: 1,
      modelVersion: target.modelVersion,
      inputs: { rollbackTo: target.id, targetHash: target.valuesHash },
      createdBy: args.createdBy,
      rationale: args.rationale,
      provenance: { rollbackTo: target.id },
    });
  }

  lock(id: string): SurfaceRecord {
    const r = this.get(id);
    if (r.lockedAt) return r;
    const locked = Object.freeze({ ...r, lockedAt: this.now() });
    this.records.set(id, locked);
    return locked;
  }

  history(incidentId: string): SurfaceRecord[] {
    return this.order.map((id) => this.records.get(id)!).filter((r) => r.incidentId === incidentId);
  }

  /** Surfaces with no children. More than one head means divergent branches awaiting reconciliation. */
  heads(incidentId: string): SurfaceRecord[] {
    const all = this.history(incidentId);
    const parents = new Set(all.map((r) => r.parentSurfaceId));
    return all.filter((r) => !parents.has(r.id));
  }
}
