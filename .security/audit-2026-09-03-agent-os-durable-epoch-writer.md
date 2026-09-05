# Security audit: Agent OS durable epoch writer

Date: 2026-09-03

Scope: M550-M556 implementation and tests only. This is a source-level audit, not an external-anchor, daemon, operating-system, or deployment acceptance.

## Result

No open P0 or P1 finding remains in the scoped tranche. The code is suitable for continued source integration, but it is not commissioned and grants no external CAS, policy, execution, or effect authority.

## Material findings closed

1. Pointer replay could rely on a stale anchor observation. It now performs a fresh injected anchor reread inside both locks and requires exact canonical agreement.
2. Rename-before-parent-fsync replay could report durable state without closing the containing-directory barrier. Replay now fsyncs and exactly rereads before success.
3. An injected platform label could imply unsupported Windows durability. Runtime Windows execution now fails closed.
4. Attempt verification did not require authenticated active-epoch context. Both public receipt verification and state transition now require it.
5. Post-genesis epochs could reuse genesis source or snapshot sentinels and semantically reset lineage. Epochs after one now reject them.

## Automated evidence

| Gate | Result |
| --- | --- |
| Focused plus adjacent Vitest matrix | 183 passed, 1 skipped |
| Independent red-team Vitest matrix | 164 passed |
| Complete repository Vitest suite | 15,562 passed, 45 skipped; 696 files passed, 1 skipped |
| TypeScript typecheck | Passed |
| ESLint | Zero errors; existing warnings only |
| Production build | Passed; 183 modules transformed |
| Semgrep, exact 14-file scope | Zero findings |
| Gitleaks, `src/core/vision` | Zero findings |
| npm audit, offline cache | Zero known vulnerabilities across 434 dependencies |
| Git diff whitespace check | Passed |

## OWASP-oriented review

| Area | Assessment |
| --- | --- |
| Access and authority | Public results are fail-closed and cannot grant write/effect authority; pointer mutation requires both locks plus a fresh exact anchor read. |
| Cryptographic integrity | Canonical encodings and domain separation are explicit; signed-artifact and control-digest formats cannot be substituted. No key management is implemented. |
| Injection and path traversal | Callers do not receive a generic arbitrary-path writer; derived names are bounded and store identity is pinned and rechecked. |
| Security misconfiguration | No config or daemon path is wired. Windows is rejected rather than assigned weaker guarantees. |
| Authentication failures | M555 requires an injected authenticated exact active-epoch closure context; no default or bypass is supplied. |
| Integrity and rollback | No-clobber artifacts, exact rereads, fsync barriers, and external-head equality protect the claimed local transition. Same-user rollback resistance is explicitly out of scope. |
| Logging and monitoring | Degraded and conflict states are explicit. No secret or raw prompt telemetry was added. |
| Availability | Partial staging blocks safely and remains inspectable. Automated cleanup/quarantine is intentionally absent. |
| Network request risks | No concrete network or anchor adapter exists in scope. |

## Residual commissioning gates

- Select and independently accept a concrete authenticated external-anchor adapter, trust root, credential delivery, retry semantics, and exact reread behavior.
- Integrate M555 production and verification into M553; add durable epoch snapshot/attempt stores and authenticated closure persistence.
- Specify recovery or quarantine for partial staging without deleting evidence or allowing namespace reuse.
- Prove crash and contention behavior with separate processes and the real external CAS implementation.
- Establish legacy-writer exclusion and a stopped-runtime upgrade protocol.
- Establish equivalent parent-directory durability before enabling Windows.
- Treat the process lease and observation lock as cooperative local controls, not defenses against a hostile same-user process.
- Refresh the dependency audit online before any release; this run used the local npm advisory cache.
- Complete daemon, config, key, canary, rollback, and live acceptance as separate governed steps.

No central security findings tracker existed at the expected workspace path, so no external tracker was modified.
