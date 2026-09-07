# Resource fleet map notes

## Current evidence

- Baseline is merged native quota commissioning PR #367.
- Existing public resource snapshots and scoped read/control sessions are the
  data and authority boundary; do not add provider calls from browser events.

## Design

## Chosen visual direction

- A capacity-to-work diagram is the defining element, not another score-card
  header. Stable left-to-right shared capacity, worker and assignment lanes;
  queued/unassigned tasks remain explicitly separate.
- Retain product tokens: canvas #f8f9fb, surface #ffffff, ink #101828, muted
  #475467, indigo #4655d6. Semantic amber for blocked/uncertain and existing
  theme tokens for dark mode. No remote fonts or new chart dependency.
- Existing system sans for controls and labels, tabular numerals for counts.
  Left aligned content, restrained edges, native buttons and keyboard inspection.
- Bounded visible nodes with search/paging and explicit omitted counts. Readable
  stacked/list relationships on narrow screens, not a force-directed graph.
- Selection highlights actual relationships and opens an accessible inspector.
  It must not move work or request provider/output data.
- Review against generic dashboard defaults: keep one visually strong diagram;
  retain secondary metric detail rather than adding decorative KPI cards or
  animated simulated traffic. Queue feedback explains actual possible constraints.

## Evidence and interaction findings

- Capacity keys are declared sharing, not identity attestation.
- Only explicit job/receipt worker IDs support task assignment edges. Dispatch
  intent can precede worker assignment. Queued allowlists are not assignments.
- Shared aliases count capacity once; unknown occupancy is not unused capacity.
- Retained query errors survive a new `refreshing` state. Current controls ignore
  that fact; fix Queue/Resume and historical labels until a read actually succeeds.
- Explicit selection should focus the inspector, especially in mobile layout;
  successful submit should reveal that task. Polling must never steal focus.
- Disappeared selection and failed output reload require precise feedback.
