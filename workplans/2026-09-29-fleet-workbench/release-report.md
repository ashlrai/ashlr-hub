# Fleet workbench release candidate3.17.0

This source candidate implements the scope in task_plan.md. A source build and focused tests have passed; full release and live verification are still pending at the candidate commit. Publication must use the exact clean candidate and successful full gate.

## Validation evidence locations
- Clean install: /tmp/ashlr-fleet-clean-install-final.log
- Focused API routing: /tmp/ashlr-fleet-dispatch-tests.log
- First-paint budget: /tmp/ashlr-first-paint-317.log (351.5KiB desktop,249.2KiB phone, within existing caps)
- Full final gate will be retained at /tmp/ashlr-fleet-prepublish-317.log.

## Remaining evidence gates
- Full prepublish suite, clean artifact/native signing, exact-SHA installed desktop/browser acceptance.
- npm interactive authorization, registry metadata and clean consumer install.
- GitHub release assets, explicit Vercel production promotion and live bytes/routes/responsive checks.
- Human Touch ID reapproval for changed authority surface.
- Physical phone pairing/interaction and provider-specific Meta entitlement.
- No verified external Dots/Grok Bot dispatch adapter or measured comparative superiority/token savings.

A final external release receipt will record exact SHAs, artifacts, deployment and acceptance evidence after these gates.
