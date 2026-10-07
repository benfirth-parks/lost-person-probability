# Lost-Person Probability Mapper

**Status: research prototype. Training and retrospective use only. Operational mode is disabled.**

An auditable decision-support engine that builds and updates a probability-of-area (POA) map for a missing person on land, combining a planning point and its uncertainty, scenario hypotheses, intended route, terrain barriers, clues, and the achieved probability of detection (POD) of search assignments. Every surface is immutable and versioned; outside-domain probability is always explicit.

The authoritative brief is `lost-person-mapper-build.md` in the project files. `docs/phase-0-plan.md` maps that brief onto what exists now and what comes next.

## What is here

| Path | Contents |
|---|---|
| `packages/geospatial` | Grid, distances, polygon validation and rasterisation, track-length rasterisation, cost-distance (Dijkstra) |
| `packages/probability-engine` | Distribution invariants, priors (uniform, distance rings with planning-point uncertainty, route corridor, route-weighted, terrain-reachable), scenario mixture, likelihood and no-find updates, cumulative POD, manual adjustments, append-only surface store, evaluation metrics, leakage checks, locked evaluation run |
| `packages/pod-engine` | Exponential sweep-width POD (planned vs achieved), track assessment, versioned cleaning, gap splitting |
| `packages/domain` | Dependency-free SHA-256 and canonical JSON for input hashes |
| `supabase/migrations` | PostGIS schema for the canonical tables, immutability triggers, row-level security, audit log, and the lock/reveal functions |
| `supabase/tests` | Role-by-role access, leakage and immutability tests |
| `packages/importers` | File import of CalTopo GeoJSON exports and GPX tracks. Parsed locally, free text dropped, every skipped feature reported with a reason |
| `packages/exercises` | ALPINE-EX-01, an authored training exercise on synthetic terrain (exercise values only) |
| `server/`, `netlify/functions/api.ts` | `/api/v1` on Netlify Functions: commit surfaces, history, rollback, evaluation create, leakage check, lock, reveal, results. Queries run as the signed-in user so RLS applies; find locations are AES-256-GCM encrypted with the incident id bound in |
| `src/` | React + MapLibre app: cases list, map workspace (scenarios, clues, search and POD, history, evaluate), read-only administration. Runs on an in-browser training data source until Supabase is configured; no external tiles, fonts or requests |
| `demo/` | The earlier single-file workspace, kept as a shareable static page |

All probability maths is pure and deterministic with no UI dependency.

## Commands

```bash
npm install
npm test            # hand-calculated fixtures + property-based invariant tests
npm run typecheck
npm run build:demo  # writes dist/demo.html (self-contained)
npm run build       # writes the app to dist/app
npm run check       # all of the above
npx vite            # app dev server

# API integration tests run when TEST_DATABASE_URL points at a database with the migrations applied

# Database (needs a disposable Postgres 16 + PostGIS; CI uses postgis/postgis:16-3.4)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres scripts/db-test.sh
```

`supabase/local/auth_shim.sql` stands in for Supabase's roles and `auth.uid()` in local tests only. Clients must select clue columns explicitly: the raw-statement ciphertext column is not granted to them.

## Data warnings

- The exercise uses synthetic terrain and **exercise values only**. No distance table, sweep width or clue parameter in this repository is a behavioural statistic.
- Do not commit incident packages, raw records, find locations, credentials or keys. `.gitignore` blocks the obvious paths; review every diff.
- Do not send incident coordinates, clues or subject information to public geocoding, routing, mapping, analytics or AI services.

## Not yet built

Supabase project setup and sign-in wiring (the app does not yet call the API), importers for real retrospective cases, offline PWA packaging. See `docs/phase-0-plan.md`.
