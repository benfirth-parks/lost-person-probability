# CLAUDE.md

Research prototype for land-search probability-of-area mapping. Training and retrospective use only. The build brief (`lost-person-mapper-build.md` in the project files) is authoritative unless a newer requirement is in this repo.

## Before editing

- Inspect the repo, tests, and any supplied samples first. Propose a plan before changing files.
- Work in small phases. After each: `npm run check` (typecheck, tests, demo build). Show the full diff and test output before committing.
- Never commit to `main` without review and approval. Use a branch and a PR.

## Hard rules

- Operational mode stays disabled (`SurfaceStore` refuses `operational_disabled`).
- Never overwrite a surface, clue interpretation, assignment or adjustment. New iteration every time.
- Never set searched cells to zero unless detection was genuinely certain (`allowCertainDetection`).
- Never hide outside-domain probability. Probabilities must sum to 1 within `PROBABILITY_TOLERANCE` (1e-10).
- Never treat planned coverage as achieved coverage.
- Never let the find location reach a retrospective run before lock (API, UI, cache keys, filenames, logs, map bounds).
- Never fabricate historical cases or behavioural statistics. Exercise values must be labelled as such.
- No names, contact details, medical information or identifiable narratives in the research interface.
- No external geocoding, routing, mapping, analytics or AI calls with incident data.
- No black-box movement model before transparent baselines are evaluated.

## Code conventions

- Probability maths lives in `packages/*/src` as pure functions; inputs are never mutated.
- Every new algorithm gets a hand-calculated fixture and, where it applies, a property test.
- Record method, parameters, normalisation constant, model version, input hash, user and time with every surface.

## Terms

POA probability of area · POD probability of detection (conditional on the subject being there) · POS = Σ POA·POD · IPP initial planning point · LKP last known point · PLS place last seen · LR likelihood ratio · coverage C = W·L/A.
