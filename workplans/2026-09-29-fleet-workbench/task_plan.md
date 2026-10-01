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
- Full gate caught outdated desktop source-only contract tests; corrected availability assertions while preserving authority and Linux quarantine guards.
- Large-manifest fixture assertions passed53/53 in isolation; bounded cleanup now uses30seconds to match the real-file boundary assertions.
- New explicit-API regression imports Tier1 code; add its owner rule while preserving all existing CODEOWNERS protections.
- Second full gate caught a new login-shell dependency in the protected authority closure; resolve fleet MCP through the existing PATH and managed launcher without expanding that closure.
- Consumer CLI review found stale engine selection and duplicate /v1 model-probe paths; fixes and regressions required before release.
- Hosted CI is active despite stale local-release documentation. Raycast dependency audit found a new brace-expansion advisory; patch and verify the independent lockfile.

## Status
3.17.0 candidate implemented; independent review and final release verification in progress. Added user scope: study Ponytail, OmniRoute, Graphify and Agent Skills; implement local Wiki module graph and portable plugin context guidance. Adjacent dirty checkouts are preserved.

## 3.18 exhausted-USD Devin correction — October 1, 2026

The new zero-dollar continuation path excludes `devin-cli`. Its exact static
SWE-2 IDs inherit CLI 3000.11.3 catalog evidence, not a fresh account-specific
price observation. Existing positive-budget Devin CLI admission and the hosted
Devin ACU policy remain unchanged. Current account pricing qualification, with
expiry and rechecks, remains a future activation gate. The
[official pricing page](https://devin.ai/pricing) currently advertises eligible
free SWE-2 only through October 16, 2026. No Devin account was activated or
provider request made for this correction.
