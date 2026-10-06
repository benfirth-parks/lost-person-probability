# Phase 0 plan and open questions

Prepared 2026-10-06 against `lost-person-mapper-build.md`.

## Current state

- The recommended private repository `benfirth-parks/lost-person-probability` does not exist yet. This code was built locally and is ready to push to it.
- No incident, clue, assignment, track, terrain, route or outcome samples were supplied, so there is no data dictionary, source inventory or eligibility report yet. Those Phase 0 deliverables are blocked on data, not on code.
- Built so far: the pure engine and a training demo (see README). This front-loads the Phase 1 to 3 maths the brief says must be transparent and tested first, without touching sensitive data or choosing hosting.

## Requirement coverage of this slice

| Brief requirement | Where | Status |
|---|---|---|
| Full probability accounting with explicit outside-domain | `distribution.ts` `checkInvariants`, every prior | Done, tested |
| Tolerance 1e-10 in configuration | `PROBABILITY_TOLERANCE` | Done |
| Uniform baseline | `uniformPrior` | Done |
| Distance rings, sourced table, no invented tail, planning-point uncertainty, density vs ring mass | `distanceRingPrior`, `validateRingTable`, `gaussianOffsets` | Done; table values must come from an approved source |
| Route-weighted, confidence explicit, corridor cannot take all probability | `routeCorridor`, `routeWeightedPrior` (max 0.9) | Done |
| Terrain-cost reachable area | `costDistance`, `reachablePrior` | Engine done; needs approved terrain inputs |
| Scenario mixture with stored contributions | `mixture` | Done |
| Evidence update with stored normaliser, extreme-LR rationale | `applyLikelihood`, `summarizeLikelihood`, demo preview | Done |
| Reliability and relevance kept separate | `ClueCredibility`, `kernelLikelihood` | Done; independence assumption stated |
| No-find update, POD 1 only when certain | `noFindUpdate` | Done |
| Repeated search with dependence adjustment | `cumulativePod`, `combinePodSurfaces` | Done; dependence value needs domain approval |
| Sweep-width POD, planned vs achieved kept apart | `plannedPod`, `achievedPod` | Done |
| Track validation, versioned cleaning, gap detection, raw preserved | `assessTrack`, `cleanTrack`, `splitAtGaps` | Done |
| Immutable versioned surfaces, rollback by new iteration, branch detection | `SurfaceStore` | In-memory contract; DB adapter next |
| Availability-time filtering and leakage checks | `filterAvailable`, `leakageCheck` | Done for packages; API/log/cache tests need the backend |
| Locked evaluation, reveal only after lock and by authorised role | `EvaluationRun`, `research.lock_evaluation_run`, `research.reveal_outcome` | Done in engine and database |
| RLS on every table, deny by default, restricted reads audited | `20261006000400_access_control.sql`, `supabase/tests` | Done, tested per role |
| Operational mode cannot be enabled | check constraints on flags, roles and incident mode | Done, tested |
| Case metrics incl. rank, area-to-capture, top-k area, log score with floor | `caseMetrics` | Done; calibration and Brier need multiple cases |
| Property tests (finite, sum, no-find monotonic, LR odds, reorder, serialise) | `engine.test.ts` | Done |

## Proposed next phases

1. **Repository and CI.** Push this to the private repo on a branch, open a PR, add GitHub Actions running `npm run check`.
2. **Phase 1 backend.** Done locally: migrations for the canonical schema (UUIDs, UTC, PostGIS, RLS deny-by-default), immutable surfaces, append-only audit, restricted outcomes reachable only through `research.reveal_outcome` after lock, and SQL tests for every role. Still to do: a database adapter honouring the `SurfaceStore` contract and the Netlify function that decrypts the outcome.
3. **Phase 1 app shell.** React + Vite + TypeScript + MapLibre with a self-hosted basemap, porting the demo workspace into `/incident/:id/map`, `/scenarios`, `/update`, `/history`, `/evaluation`.
4. **Importer and one de-identified case**, once a case and hosting are approved.

Surface storage: start with one compressed Float64 blob per surface in object storage plus summary rows (`probability_surfaces`), not one row per cell. A 160 × 125 grid is 160 KB raw per surface.

## Questions only you can answer

1. Which historical case is approved for the first vertical slice, and who can supply its de-identified package?
2. Which hosting is approved for de-identified research data (Supabase and Netlify as in your other apps, or something else)?
3. Which distance-ring statistics are licensed and approved, and for which subject categories?
4. Which terrain, trail, water, cliff and land-cover layers are approved, and which local CRS should be used (e.g. UTM 11N for Banff/Yoho/Kootenay)?
5. Can exact find locations live in the prototype database under restricted access, or must they stay offline until reveal?
6. Which sweep-width tables (resource, search object, terrain, visibility) should seed the POD models?
7. What dependence value should be used by default for repeated searches of the same area?

## Modelling choices made in this slice (open to review)

- Clue likelihood uses a two-component model, LR = (1 − q) + q·N·f, where q = reliability × relevance and f is a spatial kernel. Outside-domain LR is 1 − q.
- Extreme-LR threshold is a max/min spread of 100. A credible, tight point clue in a large domain can exceed this, which triggers the rationale requirement.
- Open water is masked out of priors as a stated choice; its ring share is redistributed over the ring's land cells.
- The exercise uses 50 m cells. Cell size for real cases needs a performance and uncertainty review.

## Schema deviations from the brief

- `assignments` and `search_tracks` gain `available_at`, so search effort can be filtered by the cutoff like clues.
- `found_locations_restricted` lives as `restricted.found_locations` in a schema the API never exposes, and holds ciphertext only.
- `prior_models` and `pod_models` allow status `exercise_only` so authored values can never pass as approved statistics.
- `search_tracks` stores `raw_times` and a `fingerprint` with a uniqueness constraint to reject duplicate uploads.
