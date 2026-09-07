# Scoped foreground Universe console

## Goal

Make the verified local Universe runtime observable through a usable, explicitly
scoped foreground console without relying on the default Hub application store.

## Phases

- [x] Verify ownership, recent source and session context.
- [x] Explore server, CLI, frontend and independent acceptance seams.
- [x] Select the smallest coherent scoped-console contract.
- [x] Implement parallel lanes and verify source behavior.
- [ ] Verify the exact installed artifact and complete source release handoff.

## Decisions and boundaries

- Preserve the primary Desktop checkout and existing default dashboard behavior.
- Reuse the packaged UI, read projections and authentication/static primitives
  where appropriate; do not add a generic fleet or web framework.
- Explicit absolute Universe root; loopback foreground lifecycle; no implicit
  config initialization, stream garbage collection, providers or service changes.
- No GitHub Actions, registry publication or resident activation.
- Independent authentication/scope/lifecycle and installed browser acceptance.

## Current state

Three agents own backend transport, CLI integration and independent acceptance.
Root owns the scoped frontend, integration, documentation and final verification.
The selected contract is `universe console --root ABS [--port 0] [--json]`, with
a foreground read-only server and packaged UI at `/universe/`. The protected
metadata route is `/api/universe/console`; only Universe overview and graph data
are exposed. Browser execution controls are deferred while the strategic answer
is pending; the working default is scoped observation first.
Working base is merged PR362, `e61982e64a1207b067a7bb36dd3d3449b4f449eb`.

## Frontend design plan

- Reuse the existing laboratory workspace, not a second general dashboard.
- Palette: canvas #f8f9fb, surface #ffffff, primary #101828, muted #475467,
  accent #4655d6, observation badge #2f4bd6; existing dark tokens remain intact.
- Typography: system UI for controls and evidence; existing monospace for the
  explicit root and commands. No fonts, images or new design dependencies.
- Layout choice: compact scope strip above the existing full-width Universe
  evidence view. A sidebar alternative adds navigation with no additional scoped
  destinations, so the strip is the smaller useful layout.
  `scope + read-only status + theme/logout -> experiment -> campaign -> graph/trials`
- Authenticated root is always visible and wraps on narrow screens; root is not
  disclosed before session authentication. Every operational command includes
  the same shell-quoted root. Observation is distinct from starting work.
- Preserve empty, missing, degraded and stale evidence states. Initial auth uses
  scoped metadata; no general snapshot probe, shell observers or SSE connection.
- Two passes: implement and test the isolated flow, then inspect installed desktop
  and narrow-screen screenshots plus actual browser request destinations.

## Observations / errors

- Primary checkout remains at a01fc086 with pre-existing untracked plans.
- Entire resume reported no checkpoint for the prior or new branch.
- No repository-local AGENTS.md was found (expected search exit 1).
- Guessed App/test/build-config filenames were absent; switched to file discovery.

## Source-freeze handoff

Backend, CLI and frontend lanes are frozen. Broader source regressions passed:
1,386 tests in 56 files, plus 47 dedicated backend-boundary tests in four files
and 221 web tests in 35 files (1,654 distinct tests across these selected sets).
TypeScript checks pass. Full lint reports zero errors and 106 pre-existing
warnings; changed-file lint is clean. No Actions, providers or resident services.

The final phase is intentionally pending at this source commit. Exact package,
installed browser, source-push and merge evidence will be finalized outside the
tested tree at `/private/tmp/ashlr-universe-scoped-console-release.sDKl0v/RELEASE-HANDOFF.md`.
