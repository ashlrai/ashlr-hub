# Delivered increment

Implemented ordinary builtin trial custody on `auto/p00`, code revision
`c78bbea917ec54fadc424679135014670afe5b25`. The canonical
[verification report](../../artifacts/builtin-trial-custody-verification.md)
contains scope, passing and failed gates, operational behavior and limitations.

The retained full-capture driver is `run-capture.mjs` in this directory. It is
explicitly mutating local diagnostic execution, not a scheduler or a read-only
report viewer. It requires an already-created canonical owned empty 0700 root,
the real inactive KILL gate, and the built installed runtime. Never retry a
nonzero attempt automatically or switch evidence IDs to evade unresolved custody.
The attempted native baseline stopped before dispatch under the real active
KILL switch. Failed evidence was retained privately; no account policy changed.

Next end-state work: resolve the operator stop state before actual capture;
freeze repeated baseline evidence and a separate trusted improvement score;
validate the exact candidate and use existing campaign/archive/local delivery.
Complete protected-scratch reclamation and resident/resource commissioning as
distinct measured work. None is made complete by this increment's passing tests.
