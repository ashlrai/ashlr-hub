# Ashlr Universe implementation report

## Delivered scope

Universe is now an executable local experiment layer in Hub, with one persisted
model shared by the CLI, TypeScript interface, authenticated API, and console.
The North Star uses the operator-selected objective: verified engineering yield,
meaning useful accepted changes per measured token and hour.

The implementation includes immutable experiment definitions, pinned Git source,
isolated candidate workspaces, a separately pinned evaluator, frozen measured
artifacts, per-niche selection, retained lineage, and reuse of prior winners.
Small budgets rotate through the candidate population. Start, trial, and final
records preserve interrupted or failed work without promoting partial results.

Four parallel workstreams covered runtime/storage, UI/API, research/independent
verification, and CLI/SDK/packaging/integration. Existing utilities supplied the
private record store, process lock, bounded subprocess runner, and OS profile.
No new runtime dependencies were added.

## Execution evidence

The built `bin/ashlr universe demo --json` completed two generations and all five
demo checks passed. It produced actual stable-deduplication modules, independently
tested seven cases for each passing candidate, and rejected the order-breaking
candidate in both generations.

| Niche | Generation 1 bytes | Generation 2 bytes | Correctness |
| --- | ---: | ---: | --- |
| Compact | 274 | 47 | 7 cases passed in both |
| Readable | 317 | 210 | 7 cases passed in both |

These are deterministic demonstration measurements, not model-generated
engineering yield, product acceptance, or revenue. Tokens and model cost remain
null. Every second-generation trial references the preceding niche winner.

The built console was tested in the in-app browser against these same records:
read-token login, archive inspection, rejected-candidate evidence, generation
switching, historical versus current elites, and parent lineage all worked.
Visual review also removed duplicate error stacks and excessive duration precision.

## Local verification

- Focused core, executable demo, confinement, CLI, API, North Star, and CLI registry:
  **68 tests passed across 7 files**.
- Existing invariant suite: **449 passed, 5 skipped across 41 files**.
- Complete web suite: **119 tests passed across 31 files**.
- Portable package declaration regressions: **7 passed, 52 filtered/skipped**.
  Three exact Universe documentation paths were added to the closed allowlist;
  an arbitrary documentation path is still rejected.
- Full TypeScript checks and production build passed.
- Repository ESLint passed with existing warnings; changed-file ESLint and the
  real-IO membership guard passed. The guard retains its unrelated existing
  advisory for the stream-file-sink fixture.
- Diff whitespace checks passed.
- Extracted npm tarball smoke test passed: public `@ashlr/hub/universe` imports,
  read-only status, CLI help, and the full two-generation demo with all five
  checks. This was a local test artifact, not a published release.

Independent macOS confinement tests use only disposable sentinel files. They
prove denied reads/writes outside approved directories, permitted candidate and
scratch writes, and denied evaluator writes/chmod of frozen artifacts.

## Deliberate boundaries and next work

- Execution is macOS-only in this implementation. Unsupported platforms reject
  before creating execution state. Linux needs a separately verified profile;
  the older generic profile does not establish the required file isolation.
- Inputs are operator-supplied local programs, not unrestricted hostile code.
  Network access and provider credentials are not supplied. Cancellation covers
  the invocation-owned process group, not deliberately detached descendants.
- The demo uses fixed visible cases. Independent evaluation is not the same as
  hidden, held-out testing; future model-driven search needs both.
- Objective/evaluator changes require a new experiment identity. Read projection
  recomputes selection and verifies comparator and retained-artifact integrity.
- Next product integration: model-authored mutation through existing adapters,
  real repository acceptance, measured token attribution, and portfolio-level
  resource allocation. The five-engine roadmap is in `docs/ASHLR-UNIVERSE.md`.
- Legacy daemon quarantine and the fleet kill switch were left unchanged.
- No GitHub Actions were used. Source integration uses a normal protected PR.
  This work does not inherit the prior 3.4.0 package's release receipt, and is not
  an npm publication or resident-fleet activation.

Entire is enabled in manual-commit mode; branch resume found no previous checkpoint.
The implementation commit has no associated Entire checkpoint; no session capture
is claimed from the enabled configuration alone.
Commit and PR identifiers are recorded by Git/GitHub rather than embedded here
self-referentially.
