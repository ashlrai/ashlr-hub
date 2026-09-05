# Notes

- The current Hub checkout is intentionally dirty on `codex/v333-iteration`; all existing work is preserved.
- M546 remains the normative rollover specification. M550 is an implementation slice, not commissioning.
- The isolated Locus producer worktree remains uncommitted and read-only with respect to live Locus state.
- The prior contract tranche passed exact final focused, type, build, lint, Rust, SAST, secret, and dependency gates.
- M549 emits only audience-scoped opaque HMAC bindings under an existing caller key. Purpose, policy generation, audience, workspace, lifetime, lineage, and attestation are domain-separated and rechecked from exact canonical bytes; no private label or path is returned.
- M552 is the verified publication path: it owns caller bytes/context before callbacks, verifies M549 before M547, constrains the complete observation interval to the capability window, re-verifies at commit, and seals the admission provenance into M548. The direct path remains explicitly unverified and cannot share a lineage with verified admission.
- M550 implements strict canonical epoch manifest/head formats, exact prior-tip lineage, deterministic operation identifiers, a pure external-anchor CAS outcome classifier, and mandatory reread classification. It deliberately contains no persistent writer, adapter, key, configuration, network, daemon, or activation path.
- M551 reports only `locally-quiescent-unverified` from exact caller observations. It never proves a stopped runtime, authenticates evidence, commissions an anchor, or permits a write.
- Independent integrated red-team review found no P0 or P1 issue. The final M547-M552 matrix passed 116/116; the broader continuity matrix passed 196/196 before scanner-only fixture cleanup; typecheck, build, and lint passed with zero errors (108 existing full-tree warnings).
- Final scoped ESLint and Semgrep passed with zero findings. Exact-tranche Gitleaks passed; a whole-repository scan still reports known test-fixture and generated-output patterns outside this tranche. Cached `npm audit --offline --audit-level=low` reports 0 vulnerabilities across 434 dependencies; two online refresh attempts stalled and were terminated without a result.
- Residual commissioning work is intentionally open: real durable epoch writing/fsync/locks, authenticated external CAS, legacy-root monitoring, pointer recovery, crash/contention acceptance, writer-protocol upgrades, key lifecycle, policy-generation anchoring, M548 rollover beyond 4,096 records, and live runtime wiring.
- No commit, push, publication, key provisioning, external mutation, observer activation, or live commissioning occurred.
