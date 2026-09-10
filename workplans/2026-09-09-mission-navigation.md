# Mission graph navigation

Base: `6729471ba6d46b588bbfc908f8e0d0ff9af7444f`.
Branch: `codex/universe-mission-navigation`, isolated from the original checkout.

## Goal

Navigate the supported 64-campaign graph without changing recorded evidence or
execution semantics. Search campaign IDs/reasons, combine with recorded-state
filters, select results, and locate nodes within the graph's scroll container.
Keep the diagram's layout and declared order unchanged. Keep selected evidence
visible when excluded by filters. Prioritize genuine selected connections inside
the existing 256-edge display bound; never invent relationships.

## Workstreams

- Explore/helper agent: stable pure filtering and selected-edge partition tests.
- UI agent: compact finder, pagination, board-only reveal and component tests.
- Review agent: independent correctness, selection, accessibility and edge audit.
- Primary: historical-observation integration tests, docs, real browser checks,
  source publication and installed-candidate verification.

## Design and verification

Reuse the existing navy/ice tokens, Space Grotesk/IBM Plex Sans, native controls
and persistent detail panel. A quiet finder band supports the dependency canvas;
do not add decorative animations or change meaning of recorded states.

Test search literals, filter composition, no matches, stable order/layout,
selection retention, controller switching, keyboard reveal and dense graphs.
Verify desktop/mobile browser geometry and graph-only scrolling with inert
campaigns. Run local web tests, typecheck, lint, docs and clean build. No backend,
provider, account, ledger, scheduling, resident-service or GitHub Actions changes.

## Acceptance

- 967/967 web tests and 86/86 scoped console/server tests passed locally.
- Type checking, documentation checks and build passed. Repository lint passed
  with 105 existing warnings and no errors; changed-source lint is clean.
- Independent review passed 48 targeted tests. Its result-description finding
  was fixed with explicit state/reason associations and a regression assertion.
- Real scoped-console browser checks used 16 inert, held campaigns: combined
  literal reason/state search, 15 matches across two pages, excluded-selection
  retention, reset and selected-node reveal passed.
- Keyboard locate retained page scroll at 295px while focusing the selected
  diagram node. Pointer automation initially scrolled to its off-screen target;
  that is browser target acquisition, not application scrolling.
- Light/dark desktop and 390px/320px dark mobile layouts were inspected; no
  horizontal page overflow or browser error logs. Mobile controls stayed inside
  the viewport. Temporary fixture and browser are not a production fleet.
