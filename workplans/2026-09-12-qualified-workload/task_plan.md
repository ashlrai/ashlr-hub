# Candidate-linked qualification workload

Base: clean integration `58b1b0466c14d7deea20d4177b13edd9e7c0b1a1`.
Previous goal turn was verified progress: calibration/comparison implementation,
474-test gate, clean build and retained documentation. The broad goal stays active.

- [x] Explore exact installed runtime, versioned reports, qualification controls and native evidence with three agents.
- [x] Implement candidate-linked during-call mutation checks in the installed workload, preserving original activity custody and deadline.
- [x] Verify healthy candidate and deliberate stale-guard controls, plus report/CLI/calibration compatibility.
- [x] Integrate tested source, clean build, and document remaining scoring/activation requirements.

The global KILL switch remains active at prior live observation and is not to be
cleared or redirected. Local hermetic fixtures are tests, not live fleet activation.
No model/provider calls, account allocation changes, GitHub Actions or publication.

## Design under exploration

Version the installed workload so during-call qualification evidence cannot be
confused with the older19-check measurement. Preserve the15 measured regions;
extra qualification processes are owned but separately labelled. Each qualifier
must first succeed in the same child, then refuse exactly one trusted in-call
mutation, preserve the changed fixture, and confirm shutdown. Transport errors
alone do not prove semantic refusal. New scoring remains separate and uncommissioned.

## Status

Implementation originated in isolated `firm-qualification`, branch
`codex/preparation-during-call-qualification`. It is now integrated locally as
ef80e60d and fd8250e7. The rebuilt bundle, manifest, Node/native pins, target,
launch semantics and three host/acceptance source files exactly match the tested
candidate. Focused integration passed589 tests/zero skips/40.95seconds; selected
installed controls passed13 with2 expensive scenarios explicitly excluded. The original
532-test compatibility gate passed. Native session65147 is terminal1: all four
current/stale controls passed, but the full workload exhausted its900-second
deadline and also retained a termination-authority diagnostic. It is not a pass.

The product now supports explicitly configured1800000ms closed diagnostic
captures, with ordinary worker trials and command evaluators still capped at
900000ms. Capture records and fixture scope accept that bounded original deadline;
per-session/tool bounds and original campaign deadline enforcement remain intact.
Build, typechecks and focused boundary tests passed. Source/runtime assets frozen.
Campaign seed invocation honors its original deadline but still rejects this
diagnostic envelope as scored seed evidence; no accepted seed measurement claimed.

Fresh five-case native acceptance started08:01:03UTC in session41730 and is
terminal0:5 passed, zero skipped,1250.74seconds. Full23 checks/two qualifications
passed with confirmed cleanup. Final source compatibility session44423 is also
terminal0:589 tests/17files/zero skipped/40.11seconds. Preserve exact results and
failed first attempt. The legacy installed suite was corrected to v2 and reviewed;
its repeatability and post-settlement full-success cases are not rerun here.

## Errors

Entire resume found no checkpoint; repository and prior verification artifacts
provide current context.

Native full-run deadline exhaustion required a supported product budget extension,
not a test-only timeout increase. Earlier guessed handoff paths were corrected by
repository search; current shared handoff is `workplans/2026-09-10-firm/task_plan.md`.
