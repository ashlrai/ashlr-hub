# Recorded controller mission topology

Base: `427a1b0f2b6b9a669e83c9fd8712656145346cda`.
Branch: `codex/universe-mission-topology` in an isolated worktree.

## Goal and contract

Make campaign structure understandable through a selectable dependency diagram
and persistent evidence panel. This is observation, not new execution authority
or a live worker monitor. Preserve explicit refresh, account allocations,
declared scheduling priority, deadlines and existing delivery gates.

Expose optional bounded topology from the same verified enrollment as controller
outcomes: campaign ID, direct dependencies and effective prerequisites. No private
paths, pins or digests. Legacy observations without topology remain supported;
absence means unavailable relationships, not zero dependencies.

## Parallel work

- Explore/runtime agent: same-observation projection, client validation, tests.
- Visual agent: diagram, selected evidence panel, keyboard/responsive tests.
- Independent review agent: delivery gates, stale evidence, graph completeness.
- Primary: integration, docs, local console/browser acceptance, release.

## Design

Reuse Space Grotesk headings, IBM Plex Sans text and existing semantic tokens.
Navy `#172746`, midnight `#0e1730`, ice `#edf1f9`, indigo `#526fe8`.
Dependency layers and connectors encode recorded ordering; separate detail labels
explain inherited delivery prerequisites. Preserve complete text relationships
even when dense diagram edges are bounded. No decorative motion or fake telemetry.

## Verification

Test legacy/malformed projections, ID bijection, cycles, bounded dense graphs,
transitive delivery gates, selection refresh and keyboard interaction. Run local
typecheck, lint, web/backend suites, build and documentation checks. Verify desktop
and mobile browser behavior against an explicit inert fixture using the actual
scoped console. No GitHub Actions, provider requests or resident-service changes.
