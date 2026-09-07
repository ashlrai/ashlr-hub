# Resource console evidence and design notes

## Current evidence

- Prior resource balancer is merged and locally packaged; real accounts are not commissioned.
- Existing Universe console offers isolated session authentication, explicit scoped
  reads, packaged React assets, and configuration-free foreground startup.
- Resource receipts do not yet expose PID, heartbeat, or intermediate progress.
  A reserved receipt may outlive the actual process; it is occupancy, not liveness.
- Desktop checkout has preexisting untracked workplans and must remain untouched.

## Design direction to review

An engineering dispatch desk: a central routing diagram linking capacity groups,
worker instances, and selected/occupied task lanes. Keep controls and evidence
adjacent so the operator can understand a routing refusal without switching views.
Use neutral work surfaces with blue/cyan routing emphasis and amber uncertainty;
do not decorate the page with fictional KPIs or identical summary cards.

## Sources

Current repository source, tests, previous delivery receipts, and skill guidance.
Provider behavior is unchanged from the previous resource-balancer increment;
no new provider protocol or subscription entitlement is assumed.

## Reviewed visual system

- Palette: canvas `#f8f9fb`, surface `#ffffff`, text `#101828`, routing/focus
  `#4655d6`, active `#92660a`, uncertainty `#6b3fc9`, inheriting dark equivalents.
- Type: existing platform-native UI sans for controls/content; monospace only for
  technical identifiers. 30/24/17/14/12px hierarchy, ordinary sentence-case labels.
- Layout: left-to-right dispatch topology above a two-column workspace: capacity
  group lanes and task queue/activity on the left, contextual inspector/composer
  on the right. Left-aligned dense evidence; mobile stacks without hiding controls.
- Distinctive element: actual shared-account routing paths and per-window evidence,
  not decorative KPI cards or synthetic progress indicators. Motion only answers
  interaction or changes in observed state; respect reduced-motion preferences.
- Critique: dropped generic hero/KPI cards and invented "live" counts. The board
  itself is the primary interface, with explicit owned/external occupancy labels.

## Integration map

- Root: shared types, scoped HTTP server, CLI route and operating documentation.
- UI lane: dedicated app/view/query modules, lazy bootstrap and scoped SSE guard.
- Evidence lane: sanitized aggregate projection and fixed-scope bounded read worker.
- Supervisor lane: durable bounded intents, asynchronous ownership, automatic
  capacity retry, pause/cancel/output and shutdown/restart acceptance.

## Verification and visual critique

- Actual browser accepted read/control authentication, submit -> owned dispatch ->
  completion -> explicit output, and pause -> queued task -> resume -> cancel.
- Final visual refinement places up to four selectable owned assignments beside
  supervisor controls, with expansion for the remainder. External reservations
  never enter this strip. Keyboard selection has a regression test.
- Desktop light/dark and 390px responsive layouts inspected. At 390px the body
  and document widths both remain 390px; no horizontal page overflow. Browser
  warning/error log was empty. Screenshots use clearly named inert fixture workers.
- Corrected over-specific routing prose: runtime shared denials can report
  unavailable despite original ready health; overflow is claimed only when its
  actual sentinel window exists.
- Independent review fixed writable-workspace control-file overlap, task identity
  conflict isolation, uncertain owned shutdown and worst-case queue metadata space.
- A CLI help regression expected the old command list; updated to include console.
- Agents reached the shared usage limit after implementing their changes. Root
  completed the final regressions and packaging without account switching/reset.
