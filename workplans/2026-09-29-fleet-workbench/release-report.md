# Fleet workbench release candidate 3.17.0

This source candidate implements the scope in task_plan.md. A source build and focused tests have passed; full release and live verification are still pending at the candidate commit. Publication must use the exact clean candidate and successful full gate.

## Validation evidence locations
- Clean install: /tmp/ashlr-fleet-clean-install-final.log
- Focused API routing: /tmp/ashlr-fleet-dispatch-tests.log
- First-paint budget: /tmp/ashlr-first-paint-317.log (351.5KiB desktop,249.2KiB phone, within existing caps)
- Full final gate will be retained at /tmp/ashlr-fleet-prepublish-317.log.
- Required-check discovery now preserves existing App pins and holds unproven, filtered or incomplete PR workflow provenance for review. Proven Dependabot maintenance checks are excluded from new requirements; 102 focused authority/protection tests passed before integration. No GitHub ruleset was changed.
- Hosted CI at the earlier candidate exposed three obsolete MCP UI expectations; those contracts were updated to distinguish account-configured servers from the separate per-run fleet MCP setup.

## Completed adjacent release
- Ashlr Plugin 1.36.3: PR142 merged, GitHub tarball public, 3,592 root and 690 server tests plus platform CI passed. Dedicated managed ashlr-mcp launcher installed and MCP initialization verified with 40 tools; npm authentication remains E401.
- Phantom 0.7.9: official arm64 release attestation and source SHA verified; dedicated user-local launcher installed. No vault, pin, credential or keychain mutation.
- Local Qwen runtime answered a short arithmetic inference at the existing loopback endpoint; this is not an autonomous edit/merge acceptance run.

## Remaining evidence gates
- Full prepublish suite, clean artifact/native signing, exact-SHA installed desktop/browser acceptance.
- npm interactive authorization, registry metadata and clean consumer install.
- GitHub release assets, explicit Vercel production promotion and live bytes/routes/responsive checks.
- Human Touch ID reapproval for changed authority surface.
- Physical phone pairing/interaction and provider-specific Meta entitlement.
- No verified external Dots/Grok Bot dispatch adapter or measured comparative superiority/token savings.

A final external release receipt will record exact SHAs, artifacts, deployment and acceptance evidence after these gates.
