# Commissioning discovery

Starting point: merged fleet-map PR 368, master
`37be46483ac556163ccf2af56a38d5fbd62b6c40`. Prior changes proved installed scoped
UI/runtime behavior with inert fixtures, not full account commissioning.

Original canonical checkout remains on its existing branch with untracked
workplans. Work continues in the clean reusable Universe integration worktree.

## Actual execution, 2026-09-07

- Codex metadata probe reported 92% usage. The private calibration pool kept its
  10% reserve: the three-case benchmark stopped with `no-capacity`, zero evaluated
  cases, no receipt and no model request. No reserve or account was changed.
- Qwen3-Coder 30B made two real requests using the existing loopback runtime. Both
  candidates failed the fixed evaluator (51/58 checks), including the second
  attempt with linked feedback. No artifact was accepted or delivered. Reported
  total: 4,283 tokens. Model requests are execution evidence, not useful yield.
- The comparator bug is real: a terminal supervisor sample can mask an occupied
  ledger receipt in ordering, despite the fleet model correctly retaining active
  status. Root will fix this directly and verify with separate regression tests.

## Release and integration findings

- Universe currently generates through local-chat only. Resource-pool native
  workers do not yet feed Universe's evaluated candidate pipeline.
- npm latest/candidate remain 3.3.2; the installed global binary is 3.1.0.
- Actions remain disabled. The historical npm provenance consumer requires CI;
  there is no supported no-Actions publication contract yet. Do not bypass it.
- Resident adapters/broker remain unavailable. Enabling a launch service is not
  sufficient for unattended operation. No global services were changed.
- Canonical docs need a discoverable index, accurate scope/capability language,
  and verified links in both source and the installed package.
