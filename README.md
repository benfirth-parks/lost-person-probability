# Lost-Person Probability Mapper

**Status: research prototype. Training and retrospective use only. Operational mode is disabled.**

An auditable decision-support engine that builds and updates a probability-of-area (POA) map for a missing person on land, combining a planning point and its uncertainty, scenario hypotheses, intended route, terrain barriers, clues, and the achieved probability of detection (POD) of search assignments. Every surface is immutable and versioned; outside-domain probability is always explicit.

The authoritative brief is `lost-person-mapper-build.md` in the project files. `docs/phase-0-plan.md` maps that brief onto what exists now and what comes next.

## What is here (first slice)

| Path | Contents |
|---|---|
| `packages/geospatial` | Grid, distances, polygon validation and rasterisation, track-length rasterisation, cost-distance (Dijkstra) |
| `packages/probability-engine` | Distribution invariants, priors (uniform, distance rings with planning-point uncertainty, route corridor, route-weighted, terrain-reachable), scenario mixture, likelihood and no-find updates, cumulative POD, manual adjustments, append-only surface store, evaluation metrics, leakage checks, locked evaluation run |
| `packages/pod-engine` | Exponential sweep-width POD (planned vs achieved), track assessment, versioned cleaning, gap splitting |
| `packages/domain` | Dependency-free SHA-256 and canonical JSON for input hashes |
| `demo/` | ALPINE-EX-01, an authored training exercise on synthetic terrain, and a single-page workspace built on the engine |

All probability maths is pure and deterministic with no UI dependency.

## Commands

```bash
npm install
npm test            # hand-calculated fixtures + property-based invariant tests
npm run typecheck
npm run build:demo  # writes dist/demo.html (self-contained)
npm run check       # all of the above
```

## Data warnings

- The exercise uses synthetic terrain and **exercise values only**. No distance table, sweep width or clue parameter in this repository is a behavioural statistic.
- Do not commit incident packages, raw records, find locations, credentials or keys. `.gitignore` blocks the obvious paths; review every diff.
- Do not send incident coordinates, clues or subject information to public geocoding, routing, mapping, analytics or AI services.

## Not yet built

Supabase/PostGIS schema and RLS, authentication, Netlify functions, React/MapLibre app shell, importers, offline PWA packaging. See `docs/phase-0-plan.md`.
