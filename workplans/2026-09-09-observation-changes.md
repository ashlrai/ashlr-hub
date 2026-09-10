# Changes between observations

Base: `cd5a7b9c9af160362390a3db66ef8152405df08f` (mission navigation).
Branch: `codex/universe-observation-changes`; original checkout preserved.

## Plan

Make explicit refresh useful by comparing the last two accepted observations in
the current inspector session. Preserve the pair on failed refresh; discard it
on submitted controller identity changes. Do not persist, poll or start work.

Three parallel agents own pure comparison, responsive presentation and independent
review. Primary owns atomic inspector integration, lifecycle regression tests,
documentation, local verification and release evidence.

Compare public projected fields by campaign identity; show recorded before/after
values without inferring events, worker liveness, readiness or production value.
Registration changes cannot establish continuity. Missing/degraded evidence and
non-increasing observation times require explicit caveats. Observed timestamps
alone are not substantive changes. Local graph filters do not alter comparisons.

## Design

Reuse the technical control-room identity: Space Grotesk headings, IBM Plex Sans
data, navy/ice surfaces and existing accent tokens. One compact evidence band
above the mission topology, two observation times, native expandable before/after
details. Stack labeled values on narrow screens. No decorative animation or new
network-dependent assets. Keep the diagram as the dominant visual.

## Verification

Test reason-only/intent-only changes, membership and topology, unchanged reports,
registration boundaries, clock order, failed refresh recovery, overlapping same-ID
requests and identity switching. Run web suite, scoped console tests, type checks,
lint, docs and clean build locally. Browser-check actual scoped console with an
isolated inert store. Publish exact reviewed source and verify checksum-pinned
local candidate with rollback identity. No GitHub Actions, provider activation,
account allocation, backend/ledger schema or public landing-page changes.

## Local acceptance

- 1,005 web tests and 86 scoped console/server tests passed, with no skipped tests.
- Independent review passed 52 focused tests; clarified full prerequisite labels.
- Type checks, docs, build and lint passed (105 existing repository warnings).
- Browser used the real scoped console with 16 inert held campaigns. A deliberate
  fixture-only drain record produced exactly four control/status field changes
  and zero changed campaigns. No worker or model requests were dispatched.
- Native Enter and Space opened/closed the before/after disclosure. Subsequent
  unchanged refresh advanced the baseline without retaining old differences.
- Light/dark desktop and 390px mobile inspected; 320px geometry checked. No page
  overflow; before/after values stayed in viewport. Browser error logs empty.
