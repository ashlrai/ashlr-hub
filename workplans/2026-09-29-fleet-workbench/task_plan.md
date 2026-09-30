# Fleet workbench completion and release

## Goal
Make the existing Ashlr Verse engineering fleet more usable across every connected account, desktop sessions, local models and authenticated phone control; publish a verified product release and site updates.

## Phases
- [x] Inspect clean source, recent history, memory and release conventions; resume Entire.
- [x] Parallel exploration of fleet/runtime, workbench/phone, current provider/model capabilities.
- [x] Preserve the existing architecture; choose concrete changes from observed gaps.
- [x] Implement independent improvements using existing APIs and UI patterns.
- [ ] Independent review, targeted tests, repository release gate, browser verification.
- [ ] Commit, push/review/merge, build and install release, publish registry and desktop artifacts, deploy site.
- [ ] Verify installed/live behavior and record remaining activation or provider gates.

## Decisions
- Extend the current workbench and provider-seat architecture; preserve account identity, provider budgets, signed standing grants and authenticated phone control.
- Investigate arbitrary account/model caps separately from measured execution capacity and signed authority.
- Do not advertise unverified provider/product names or infer subscriptions provide API credits.

## Questions
- Preferred landing surface: session/chat workbench or fleet command dashboard?
- Should unattended operation continue under the current signed grant and enrolled scopes?
- Which exact products are meant by OpenAI Dots and Meta Muse?

## Errors
- Installed desktop startup reproduced admin socket ENOENT race; fix and regressions implemented.
- Shared node_modules lacked WebAuthn client package; npm ci restored the lockfile dependency set.
- New moderate dependency advisories appeared: patch overrides and lock to fast-uri3.1.8/ip-address10.7.2; lock audit reports zero vulnerabilities.
- npm registry authentication expired (E401); finish release artifact before requesting interactive renewal.
- First Meta registry test needed roster fixture extended to include the new opt-in engine; corrected.

## Status
3.17.0 candidate implemented; independent review and final release verification in progress. Added user scope: study Ponytail, OmniRoute, Graphify and Agent Skills; implement local Wiki module graph and portable plugin context guidance. Adjacent dirty checkouts are preserved.
