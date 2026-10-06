import { z } from 'zod';

/** Shared request schemas for the v1 API. Response shapes are typed in service.ts. */

// Any 8-4-4-4-12 hex identifier (Postgres uuid); zod's uuid() also demands an RFC version nibble.
export const Uuid = z.guid();

export const ModelVersionRef = z.object({ component: z.string().min(1), version: z.string().min(1) });

export const CommitSurfaceBody = z
  .object({
    searchDomainId: Uuid,
    parentSurfaceId: Uuid.nullable(),
    surfaceType: z.enum(['prior', 'clue_update', 'search_update', 'manual_adjustment']),
    /** base64 of little-endian float64: every cell in grid order, then outside-domain. */
    valuesBase64: z.string().min(16),
    normalizationConstant: z.number().positive().finite(),
    modelVersion: ModelVersionRef,
    inputs: z.unknown(),
    rationale: z.string().max(4000).default(''),
    evidence: z
      .object({
        evidenceType: z.string().min(1),
        evidenceId: Uuid,
        method: z.string().min(1),
        parameters: z.record(z.string(), z.unknown()),
        previewHash: z.string().min(8),
      })
      .optional(),
    adjustment: z
      .object({ method: z.string().min(1), parameters: z.record(z.string(), z.unknown()) })
      .optional(),
  })
  .superRefine((b, ctx) => {
    if ((b.surfaceType === 'prior') !== (b.parentSurfaceId === null))
      ctx.addIssue({ code: 'custom', message: 'a prior has no parent and every update has one', path: ['parentSurfaceId'] });
    if (b.surfaceType !== 'prior' && b.rationale.trim().length === 0)
      ctx.addIssue({ code: 'custom', message: 'updates require a rationale', path: ['rationale'] });
    if ((b.surfaceType === 'clue_update' || b.surfaceType === 'search_update') && !b.evidence)
      ctx.addIssue({ code: 'custom', message: 'clue and search updates must identify their evidence', path: ['evidence'] });
    if (b.surfaceType === 'manual_adjustment' && (!b.adjustment || b.rationale.trim().length < 10))
      ctx.addIssue({ code: 'custom', message: 'manual adjustments need a method and a rationale of 10+ characters', path: ['adjustment'] });
  });
export type CommitSurfaceBody = z.infer<typeof CommitSurfaceBody>;

export const RollbackBody = z.object({
  headSurfaceId: Uuid,
  targetSurfaceId: Uuid,
  rationale: z.string().trim().min(10),
});

export const CreateEvaluationBody = z.object({ incidentId: Uuid, informationCutoff: z.string().datetime({ offset: true }) });

export const LockEvaluationBody = z.object({
  surfaceId: Uuid,
  baselineSurfaceIds: z.array(Uuid).max(10).default([]),
  modelVersions: z.record(z.string(), z.string()).default({}),
});
