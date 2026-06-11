# CONTRACT-H4 — HARDEN & PROVE: SAFETY-INVARIANT REGRESSION SUITE

Milestone H4 of Ashlr v2.1 "Harden & Prove". Builds on **H1** (commit `3c91de0`,
the keystone — `test/helpers/h1-fixture.ts`) and **H2** (commit `595ecf2` —
`test/helpers/h2-faults.ts`). It **REUSES BOTH testkits** — no new fault/fixture
helper is required (a tiny `test/helpers/h4-static.ts` source-read helper is added
only for the grep-guard technique; see below).

**H4 is a CONSOLIDATED, ALWAYS-ON safety-invariant REGRESSION SUITE.** Where H1
proves the chain end-to-end, H2 proves crash-recovery, and H3 proves the caps
under load, **H4 pins every HARD safety guarantee in place** so that any future
change which weakens a guarantee FAILS CI. It enumerates **54 guards across 7
invariants** (42 already covered by prior milestones, **12 UNTESTED** — the H4
priority) and gives each invariant ONE focused test file asserting EVERY guard in
it. It also ships ONE small new production surface: a READ-ONLY `ashlr
verify-safety` self-check that runs the structural guards at runtime and prints a
pass/fail report.

### THE H4 INVARIANT (the meta-guarantee this milestone installs)

> **Every hard-safety guard has a regression test; weakening any guarantee fails CI.**

H4 does NOT add outward capability. The only new production code is
`src/cli/verify-safety.ts` — a read-only self-check that **mutates nothing and
makes no outward call** (see VERIFY-SAFETY COMMAND below). Tests assert the REAL
guards: they either CALL the real functions on disposable repos, or — for
grep-guards — READ the real source file as TEXT and assert the absence/presence of
a token. **No guard is ever weakened to make a test pass.** Where a guard is found
missing/weak, that is a FINDING surfaced here (see FINDINGS), fixed only if the fix
is minimal, local-only, and justified.

---

## ABSOLUTE SAFETY RULES (paramount — inherited verbatim from H1/H2/H3)

- **ISOLATED HOME.** Every test that touches state relocates `process.env.HOME`
  to a FRESH `os.tmpdir()` dir via the H1 fixture (`makeFixture`/`withTmpHome`),
  so every `~/.ashlr` read/write (enrollment, KILL, sandboxes, inbox, daemon
  state) resolves to an ISOLATED home — **NEVER the real one**. The fixture
  asserts `homedir() === tmpHome` and refuses to run otherwise.
- **REAL PORTFOLIO UNTOUCHED.** The real `~/.ashlr/enrollment.json = { repos: [] }`
  is never enrolled or read. Only DISPOSABLE git repos under `os.tmpdir()`
  (`makeRepo`) are ever enrolled/sandboxed; each test cleans up after itself.
- **NO OUTWARD ACTION.** No test pushes, opens a PR, or deploys. Tests that drive
  `applyProposal` do so ONLY to assert it REFUSES (the apply gates) or to apply a
  KNOWN `patch` onto a NEW namespaced branch in a disposable repo — never the
  user's branch, never a network op. `applyPr`/`deploy` are asserted via REFUSAL
  and dispatch-shape, never by performing a real PR/deploy.
- **DETERMINISTIC.** No live-LLM dependency, no network, no real model subprocess.
  Where the daemon/swarm path is exercised, `runSwarm`/`runGoal` are MOCKED
  exactly as the M24/H1/H3 suites do. The grep-guards are pure source reads.
- **EXPLICIT ASSERTIONS.** Every `it()` has real `expect()` calls. Each suite's
  `beforeEach` calls `expect.hasAssertions()` so a vacuous/false-green stub fails
  (the H2/H3 reviews caught TODO stubs that passed without asserting — H4 forbids
  this structurally).

---

## THE STATIC GREP-GUARD TECHNIQUE (read first)

Several hard guarantees are best asserted **statically** — by reading the real
source file as a STRING and asserting a token is absent or present. This is how
H4 proves negative-space invariants like "the daemon imports no outward
primitive". The technique:

1. Resolve the absolute path of the REAL source file from the test file
   (`fileURLToPath(import.meta.url)` → walk to repo root → `src/...`). The tiny
   `test/helpers/h4-static.ts` helper exposes `readSource(relPathFromSrc)` and
   `importLines(src)` (the set of `import ... from '...'` specifiers) so suites do
   not re-implement the read.
2. Assert ABSENCE: e.g. `expect(importLines(loopSrc)).not.toContain(
   '../inbox/apply.js')` and assert the source text contains no `createPr` /
   `git push` / `deploy(` / `applyProposal(` call token. ABSENCE is checked on
   IMPORT SPECIFIERS (not arbitrary substrings) plus call-token scans, so a
   passing-mention in a COMMENT does not cause a false failure — comments are
   stripped before the call-token scan.
3. Assert PRESENCE: e.g. the kill-switch check token appears BEFORE the work in
   the relevant function, or that `index.ts` and `graph.ts` both define a
   `scrubSecrets`.

Static guards are clearly marked **[STATIC]** in the guard tables below. A static
guard FAILS CI the moment someone adds the forbidden import/call — which is
exactly the regression we want to catch.

---

## THE 7 INVARIANTS → 7 TEST FILES

| # | Invariant | Test file | Guards | Untested→now |
|---|-----------|-----------|-------:|-------------:|
| 1 | PROPOSAL-ONLY | `test/h4.proposal-only.test.ts` | 11 | 3 |
| 2 | SANDBOX-REQUIRED | `test/h4.sandbox-required.test.ts` | 6 | 2 |
| 3 | ENROLLMENT | `test/h4.enrollment.test.ts` | 7 | 0 |
| 4 | KILL-SWITCH | `test/h4.kill-switch.test.ts` | 6 | 1 |
| 5 | LOCAL-FIRST / NO-CLOUD-EGRESS | `test/h4.local-first.test.ts` | 7 | 2 |
| 6 | SECRET-SCRUB | `test/h4.secret-scrub.test.ts` | 8 | 2 |
| 7 | SANDBOX-CONTAINMENT | `test/h4.sandbox-containment.test.ts` | 9 | 2 |
| — | verify-safety self-check | `test/h4.verify-safety.test.ts` | (covers the new surface) | — |
| **Σ** | | | **54** | **12** |

All cited line numbers are against the repo at H4 authoring time (post-H3). The
intent of a guard is what's pinned; if a refactor shifts a line, the test still
asserts the BEHAVIOR/TOKEN, and the line in the table is updated.

---

## INVARIANT 1 — PROPOSAL-ONLY (`test/h4.proposal-only.test.ts`)

`applyProposal` is the ONLY outward mutation path; it is reached ONLY via an
explicit human `inbox approve`. The daemon + advance + captureSandbox surfaces
emit ONLY PENDING proposals and import NO outward primitive.

| G# | Guard | Source | Tested? |
|----|-------|--------|---------|
| 1.1 | `applyProposal` REFUSES when proposal does not exist (`loadProposal===null`) | `inbox/apply.ts:280-294` | tested (h1/m23) — re-assert |
| 1.2 | REFUSES unless `status==='approved'` | `inbox/apply.ts:297-310` | tested — re-assert |
| 1.3 | REFUSES unless `opts.confirmed===true` | `inbox/apply.ts:313-326` | tested — re-assert |
| 1.4 | REFUSES (via `assertMayMutate`) unenrolled/kill before any mutating kind | `inbox/apply.ts:357-373` | tested — re-assert |
| 1.5 | per-kind `patch` apply lands on NEW `ashlr/proposal/<id>` branch, never user branch | `inbox/apply.ts:380-387,97-216` | tested (h1) — re-assert |
| 1.6 | **per-kind `pr` dispatch is GATED (createPr), never auto** — refusal/shape | `inbox/apply.ts:389-398,222-259` | **UNTESTED #1** |
| 1.7 | **per-kind `deploy` dispatch is GATED (ship module), refuses when absent** | `inbox/apply.ts:400-436` | **UNTESTED #1** |
| 1.8 | `note` kind is a no-op record (never mutates a repo) | `inbox/apply.ts:329-339` | tested — re-assert |
| 1.9 | **[STATIC] `daemon/loop.ts` imports NO `apply`/`push`/`createPr`/`deploy` primitive** | `daemon/loop.ts:31-39` (import block) | **UNTESTED #2** |
| 1.10 | daemon `tick` (live) emits ONLY PENDING proposals via `runSwarm({propose:true})`; no apply | `daemon/loop.ts:283-396` | tested (h1) — re-assert |
| 1.11 | **swarm runner `propose=false` creates NO proposal (negative)** | `swarm/runner.ts:961-985`, `daemon/loop.ts:118-119` | **UNTESTED #11** |

Notes on the untested-now guards:
- **1.6 / 1.7 (prep #1):** assert the `switch(proposal.kind)` dispatch refuses
  cleanly per kind. For `pr`, drive an approved+confirmed `pr` proposal on a
  disposable repo and assert that WITHOUT a network/`gh` it returns
  `ok:false` with the gated-createPr failure detail (the `createPr` is the M18
  gate; we never actually open a PR). For `deploy`, assert it returns the
  "ship module … not yet available" / gated refusal — never silently performs a
  deploy. **FINDING (prep discrepancy):** the prep note lists a `refund` kind;
  the real `ProposalKind` union is `'patch' | 'pr' | 'deploy' | 'note'`
  (`types.ts:1707`) — there is NO `refund`. The test asserts the ACTUAL four
  kinds and additionally asserts the `default:` exhaustiveness arm
  (`inbox/apply.ts:438-444`) refuses an unknown kind, which is the real guard a
  hypothetical `refund` would hit.
- **1.9 (prep #2) [STATIC]:** read `daemon/loop.ts` and assert its IMPORT
  specifiers contain none of `inbox/apply`, `integrations/github` (createPr),
  ship/deploy, and that the comment-stripped source contains no `applyProposal(`,
  `createPr(`, `git push`, `deploy(` call token. The only inbox import allowed is
  `inbox/store` (`pendingCount`, read-only).
- **1.11 (prep #11):** the daemon dry-run path (`opts.dryRun`) and the
  `propose=false` runner path create ZERO proposals. Assert `pendingCount()` is
  unchanged across a `tick(cfg,{dryRun:true})` and across a mocked
  `runSwarm({propose:false})`.

---

## INVARIANT 2 — SANDBOX-REQUIRED (`test/h4.sandbox-required.test.ts`)

When a sandbox is MANDATORY the swarm aborts (ZERO tasks) rather than touch the
real tree; `createSandbox` refuses non-git / unresolvable-HEAD / unenrolled.

| G# | Guard | Source | Tested? |
|----|-------|--------|---------|
| 2.1 | `requireSandbox = sandbox && requireSandbox`; abort returns `status:'failed'`, ZERO tasks, tree untouched | `swarm/runner.ts:1127-1155` | tested (m24/h1) — re-assert |
| 2.2 | abort when `project===null` under requireSandbox | `swarm/runner.ts:1198-1201` | tested — re-assert |
| 2.3 | **abort "sandbox worktree module unavailable" path (module absent)** | `swarm/runner.ts:1197-1204` | **UNTESTED #3** |
| 2.4 | `createSandbox` REFUSES non-git repo (`isRepo` false) | `sandbox/worktree.ts:180-189` | tested (m21) — re-assert |
| 2.5 | `createSandbox` REFUSES unresolvable HEAD | `sandbox/worktree.ts:192-202` | tested — re-assert |
| 2.6 | **`createSandbox` REFUSES unenrolled repo without `allowAnyRepo`** | `sandbox/worktree.ts:166-177` → `policy.ts:180-182` | **UNTESTED #5** |

Notes:
- **2.3 (prep #3):** the `_createSandbox` binding is lazy/best-effort in the
  runner. Drive `runSwarm({sandbox:true,requireSandbox:true})` with the worktree
  module binding forced absent (mock the lazy loader to leave `_createSandbox`
  null, matching how H2 exercises the lazy seams), assert the run returns the
  "sandbox worktree module unavailable" abort with ZERO tasks and a tree that
  `shasumTree` proves unchanged.
- **2.6 (prep #5):** create a disposable repo that is NOT enrolled; call
  `createSandbox(repo)` (no `allowAnyRepo`) and assert it THROWS the
  "repo not enrolled" error AND audits `result:'refused'` AND leaves no worktree
  under `sandboxesDir()`. Then confirm `createSandbox(repo,{allowAnyRepo:true})`
  succeeds (the documented test hatch) so the refusal is specifically the
  enrollment gate.

---

## INVARIANT 3 — ENROLLMENT (`test/h4.enrollment.test.ts`)

`isEnrolled`/`assertMayMutate` gate every mutating call site; the registry
DEFAULTS EMPTY ⇒ nothing happens. (Well-tested already — H4 pins it permanently.)

| G# | Guard | Source | Tested? |
|----|-------|--------|---------|
| 3.1 | registry default empty: `listEnrolled()===[]` on a fresh HOME | `policy.ts:43-63,151-153` | tested — re-assert |
| 3.2 | malformed/absent `enrollment.json` ⇒ `{repos:[]}` (never throws) | `policy.ts:43-63` | tested — re-assert |
| 3.3 | `enroll`/`unenroll` normalize to absolute via `resolve()`; idempotent | `policy.ts:125-145` | tested — re-assert |
| 3.4 | `assertMayMutate` THROWS for unenrolled repo (no `allowAnyRepo`) | `policy.ts:180-182` | tested — re-assert |
| 3.5 | daemon `tick` does NOTHING with empty enrollment (`reason:'no-enrolled-repos'`) | `daemon/loop.ts:198-215` | tested (h1) — re-assert |
| 3.6 | `createSandbox` routes through `assertMayMutate` (enrollment gate at call site) | `sandbox/worktree.ts:166-177` | tested — re-assert |
| 3.7 | `applyProposal` routes mutating kinds through `assertMayMutate` (enrollment at call site) | `inbox/apply.ts:357-373` | tested — re-assert |

---

## INVARIANT 4 — KILL-SWITCH (`test/h4.kill-switch.test.ts`)

`killSwitchOn()` is checked before work everywhere; the kill switch overrides
EVERYTHING — including `allowAnyRepo`.

| G# | Guard | Source | Tested? |
|----|-------|--------|---------|
| 4.1 | `assertMayMutate` THROWS when kill on, regardless of enrollment | `policy.ts:174-177` | tested — re-assert |
| 4.2 | daemon `tick` first checks kill ⇒ `reason:'kill-switch'`, zero work | `daemon/loop.ts:153-168` | tested (h1/h2) — re-assert |
| 4.3 | `runDaemon` loop re-checks kill each iteration + after sleep | `daemon/loop.ts:509-535` | tested — re-assert |
| 4.4 | per-item dispatch re-checks kill before each `runSwarm` | `daemon/loop.ts:324-327` | tested (h2) — re-assert |
| 4.5 | `createSandbox` refuses (via `assertMayMutate`) when kill on | `sandbox/worktree.ts:166-177` | tested — re-assert |
| 4.6 | **`allowAnyRepo` NEVER overrides the kill switch (negative)** | `policy.ts:174-180` | **UNTESTED #4** |

Notes:
- **4.6 (prep #4):** call `assertMayMutate(repo,{allowAnyRepo:true})` with the
  kill switch ON and assert it STILL throws "autonomy kill switch is ON" — the
  kill check (`policy.ts:175`) precedes the enrollment/`allowAnyRepo` check
  (`policy.ts:180`), so the test hatch can never reach mutation while kill is set.
  Repeat through `createSandbox(repo,{allowAnyRepo:true})` (kill on ⇒ throws +
  audits refused).

---

## INVARIANT 5 — LOCAL-FIRST / NO-CLOUD-EGRESS (`test/h4.local-first.test.ts`)

`getActiveClient` cloud-gates; every LLM caller defaults local; `reflect.ts` has
no network at all.

| G# | Guard | Source | Tested? |
|----|-------|--------|---------|
| 5.1 | cloud provider + `!allowCloud` ⇒ THROWS "Pass --allow-cloud" | `provider-client.ts:852-858` | tested (m4) — re-assert |
| 5.2 | `allowCloud` true but API key absent ⇒ THROWS "API_KEY is not set" | `provider-client.ts:860-868` | tested — re-assert |
| 5.3 | cloud provider + key present ⇒ THROWS "does not yet implement cloud" (no silent egress) | `provider-client.ts:871-877` | tested — re-assert |
| 5.4 | no reachable provider ⇒ THROWS local-first message (no cloud fallback) | `provider-client.ts:845-849` | tested — re-assert |
| 5.5 | **cloud-gate throws PER provider (each id in `CLOUD_PROVIDERS`)** | `provider-client.ts:17-39,852` | **UNTESTED #9** |
| 5.6 | daemon swarm budget defaults `allowCloud:false` | `daemon/loop.ts:356-360` | tested — re-assert |
| 5.7 | **[STATIC] `reflect.ts` has NO network (no `fetch`, no `getActiveClient`, no http import)** | `learn/reflect.ts` (whole file) | **UNTESTED #9 sib** |

Notes:
- **5.5 (prep #9):** iterate every id in the real `CLOUD_PROVIDERS` set and assert
  `getActiveClient(cfg,{allowCloud:false,provider:<id>})` REJECTS with the
  cloud-gate error — so the gate is uniform, not just for the one provider the
  happy path picks. Then assert `{allowCloud:true,provider:<id>}` with the key
  absent rejects with the key-missing error (key env vars from
  `CLOUD_PROVIDER_ENV` are cleared in the test for isolation).
- **5.7 (prep #9):** [STATIC] read `learn/reflect.ts` and assert the
  comment-stripped source contains no `fetch(`, no `getActiveClient`, and no
  network import (`node:http`/`https`/`undici`); the doc-comment already PROMISES
  "ZERO network connections" (`reflect.ts:16,344`) — this guard pins that promise.

---

## INVARIANT 6 — SECRET-SCRUB (`test/h4.secret-scrub.test.ts`)

`scrubSecrets` runs before store/embed; secret-file skip-lists drop env/key
files; specific secret shapes are redacted.

| G# | Guard | Source | Tested? |
|----|-------|--------|---------|
| 6.1 | `index.ts` scrubs chunk text before store/embed (`scrubbedText`) | `knowledge/index.ts:123-128,481` | tested (m25) — re-assert |
| 6.2 | `index.ts` skips secret FILENAMES (`.env*`,`*.pem`,`*.key`,…) | `knowledge/index.ts:74,241` | tested — re-assert |
| 6.3 | `index.ts` skips secret BASENAMES (`SECRET_FILES`) | `knowledge/index.ts:82-90,242` | tested — re-assert |
| 6.4 | `graph.ts` scrubs detail via `scrubSecrets` before emit | `knowledge/graph.ts:274-276,450` | tested — re-assert |
| 6.5 | `graph.ts` skips secret files (`shouldSkip`/`SECRET_FILES`) | `knowledge/graph.ts:65-86` | tested — re-assert |
| 6.6 | **specific patterns redacted: JWT, AWS access key, long base64/hex (index.ts)** | `knowledge/index.ts:106-122` | **UNTESTED #9-secret** |
| 6.7 | `password`/`api_key`/`token` assignments redacted (both impls) | `index.ts:106-122`, `graph.ts:272` | tested-ish — assert both |
| 6.8 | **[STATIC] index.ts vs graph.ts scrub-pattern PARITY (consolidate-or-cover)** | `index.ts:106-122` vs `graph.ts:272` | **UNTESTED #10** |

Notes:
- **6.6 (prep #9):** feed concrete secret-shaped strings (a real-shaped JWT
  `eyJ…​.…​.…`, an `AKIA…` AWS key, a ≥40-char base64 blob, a ≥32-char hex token)
  through `index.ts`'s scrub path and assert each is `[REDACTED]` and the raw
  value never survives into the stored chunk.
- **6.8 (prep #10) [STATIC] + FINDING:** the two impls DIFFER. `index.ts` uses a
  6-pattern array (JWT/AWS/base64/hex + key-assignments); `graph.ts` uses ONE
  broad `key|token|secret|password…\s*[:=]\s*\S+` regex (`graph.ts:272`). The
  graph regex catches assignment-style secrets but NOT a bare JWT/AWS/base64 blob
  that the index catches. H4 asserts BOTH impls redact the OVERLAP set
  (assignment-style secrets) AND documents the gap: graph.ts does not redact bare
  high-entropy blobs. **This is a FINDING** (graph.ts is weaker). The test pins
  current behavior of each and a `// FINDING` assertion makes the divergence
  explicit; a consolidation (graph.ts adopting the index pattern array) is the
  recommended local-only fix, deferred to BUILD with justification rather than
  silently weakening either test.

---

## INVARIANT 7 — SANDBOX-CONTAINMENT (`test/h4.sandbox-containment.test.ts`)

`removeSandbox` re-derives the safe branch + path from the id and REFUSES git ops
on any namespace/containment mismatch; `resolve()` defeats symlink escape;
`listSandboxes` skips malformed meta.

| G# | Guard | Source | Tested? |
|----|-------|--------|---------|
| 7.1 | `removeSandbox` re-derives `safeBranch`/`safeWorktree` from id (not raw meta) | `sandbox/worktree.ts:353-363` | tested (m21) — re-assert |
| 7.2 | guardsPass = namespace ∧ branchMatch ∧ contained; git ops only when pass | `worktree.ts:363-389` | tested — re-assert |
| 7.3 | refusal still does LOCAL dir cleanup (rmSync home), audits `refused` | `worktree.ts:365-374,391-407` | tested — re-assert |
| 7.4 | **containment guard A fails alone: branch NOT in namespace ⇒ refuse git ops** | `worktree.ts:357,363` | **UNTESTED #6a** |
| 7.5 | **containment guard B fails alone: branch ≠ safeBranch ⇒ refuse** | `worktree.ts:358,363` | **UNTESTED #6b** |
| 7.6 | **containment guard C fails alone: worktreePath NOT contained ⇒ refuse** | `worktree.ts:359-361,363` | **UNTESTED #6c** |
| 7.7 | **non-namespaced branch never `branch -D`'d (BRANCH_PREFIX guard)** | `worktree.ts:357,388`; `createSandbox:242` | **UNTESTED #7** |
| 7.8 | **`listSandboxes` SKIPS malformed `sandbox.json`, never crashes the sweep** | `worktree.ts:110-144,418-437` | **UNTESTED #8** |
| 7.9 | **symlink `worktreePath` defeated by `resolve()` (escape blocked)** | `worktree.ts:359-361` | **UNTESTED #12** |

Notes (prep #6/#7/#8/#12):
- **7.4–7.6:** craft a real sandbox via `createSandbox(repo,{allowAnyRepo:true})`,
  then mutate ONE field of its `Sandbox` meta object in-memory before calling
  `removeSandbox` so EACH containment guard fails IN ISOLATION:
  (A) set `branch` to a user-looking `feature/x` (not in `ashlr/sandbox/`),
  (B) set `branch` to a same-namespace but WRONG id (`ashlr/sandbox/deadbeef`),
  (C) point `worktreePath` outside `sandboxesDir()`.
  In every case assert: (i) the audit record is `result:'refused'` with the
  "metadata failed branch-prefix/containment guard" summary, (ii) the user repo's
  REAL branches are unchanged (`repo.branches()` still contains the user branch
  and the genuine `ashlr/sandbox/<id>` ref is NOT force-deleted via the tampered
  path), (iii) the local sandbox home IS rmSync'd (cleanup still runs).
- **7.7:** assert that no `git branch -D` is ever issued against a branch lacking
  the `ashlr/sandbox/` prefix — verified by seeding a same-named user branch and
  proving it survives a tampered remove, plus the [STATIC] presence of the
  `branch.startsWith(BRANCH_PREFIX)` guard in `createSandbox`'s cleanup path.
- **7.8:** write a malformed `sandbox.json` (invalid JSON, then a JSON object
  missing required fields) into a `sandboxesDir()/<id>/` dir and assert
  `listSandboxes()` returns the VALID entries only, never throwing.
- **7.9:** create a sandbox, then replace its on-disk `worktreePath` with a
  SYMLINK pointing OUTSIDE `sandboxesDir()` (e.g. to a sibling tmp dir) and assert
  `removeSandbox` REFUSES the git ops because `resolve(sb.worktreePath)` resolves
  the symlink target out of the contained root — the escape is blocked, the
  symlink target dir is never `worktree remove`'d.

---

## VERIFY-SAFETY COMMAND (`ashlr verify-safety` → `src/cli/verify-safety.ts`)

**The only new production surface.** A READ-ONLY self-check that runs the
structural safety guards AT RUNTIME and prints a pass/fail report. It is the
runtime analogue of the H4 suite: a human (or CI) can run `ashlr verify-safety`
on any machine and confirm the invariants hold for the INSTALLED build.

**HARD CONTRACT — what verify-safety MUST do:**
- **MUTATES NOTHING.** It writes no file, creates no sandbox, enrolls nothing,
  toggles no kill switch, creates no proposal. It performs only reads
  (`listEnrolled`, `killSwitchOn`, source reads) + pure checks.
- **MAKES NO OUTWARD CALL.** No network, no `git push`, no PR, no deploy, no model
  spawn. It is local-only and side-effect-free by construction.
- **READ-ONLY STRUCTURAL CHECKS** it runs (each → a pass/fail line):
  1. ENROLLMENT default-empty semantics: `readRegistry()` parsing of an
     absent/malformed registry yields `{repos:[]}` (checked against a synthesized
     in-memory input, NOT by writing the real registry).
  2. KILL-SWITCH precedence: a structural assertion that `assertMayMutate`
     enforces kill BEFORE `allowAnyRepo` (verified by a source check that the kill
     check precedes the enrollment check in `policy.ts`, and by a dry, in-memory
     simulation that never touches `~/.ashlr/KILL`).
  3. DAEMON exports no outward primitive: read `daemon/loop.ts` and assert its
     import specifiers + call tokens contain no apply/push/createPr/deploy
     (the same [STATIC] grep-guard as test 1.9).
  4. SCRUB patterns match: assert `index.ts`/`graph.ts` `scrubSecrets` redact a
     synthesized secret string (run in-memory; no file written).
  5. PROVIDER cloud-gate present: assert `provider-client.ts` defines the
     `CLOUD_PROVIDERS` gate and the `!allowCloud` throw path.
- **OUTPUT:** a human-readable report (one `PASS`/`FAIL` line per check) plus a
  final summary; `--json` emits a machine-readable `{ ok, checks: [...] }`.
- **EXIT CODES:** `0` all checks pass, `1` one or more FAIL (so CI can gate on it),
  `2` bad usage.

**Signature** (matches the repo's `Cmd` shape, `src/cli/index.ts:59`):

```ts
export async function cmdVerifySafety(args: string[]): Promise<number>;
```

**Dispatcher wiring is NOT done in this scaffold** — integration owns adding the
`loadVerifySafetyCmd` lazy import, the `case 'verify-safety':` arm, and the
`cmdHelp` entry to `src/cli/index.ts` (same pattern as every other command). The
scaffold ships a typed, JSDoc'd stub that typechecks + lints clean; BUILD fills
the check bodies with REAL assertions (never a vacuous pass).

The `test/h4.verify-safety.test.ts` suite drives `cmdVerifySafety` on the real
build and asserts: it returns `0` on a healthy build, it MUTATES NOTHING (snapshot
`~/.ashlr` / disposable HOME before+after — byte-identical), it makes no network
call, and `--json` shape is well-formed. It also asserts a FAIL exit (`1`) can be
produced (e.g. by pointing a check at a deliberately-broken synthesized input)
so the command is proven to actually gate, not always-green.

---

## REUSE OF H1 / H2 TESTKITS

- **H1 (`test/helpers/h1-fixture.ts`):** `makeFixture`/`withTmpHome` (isolated
  HOME), `makeRepo`/`makeDisposableRepo` (disposable git repos),
  `makeAddFileDiff` (the deterministic `patch` payload for apply-side guards),
  `shasumTree` (REAL-TREE-UNCHANGED across every refusal), `makeCfg`,
  `todoSeedFiles`. REUSED verbatim — H4 adds no fixture surface.
- **H2 (`test/helpers/h2-faults.ts`):** `seedPendingProposal`, `makeOrphanSandbox`,
  `listOrphanSandboxes`, `sandboxHomeExists`, `ensureSandboxesDir` — used to seed
  sandboxes/proposals for the containment + proposal-only guards without driving a
  live swarm.
- **NEW (`test/helpers/h4-static.ts`, test-only):** `readSource(rel)` and
  `importLines(src)` / `stripComments(src)` for the [STATIC] grep-guards. Pure
  source reads; no production code, no runtime deps, no outward capability.

---

## FINDINGS (surfaced, not silently fixed)

1. **`refund` kind does not exist.** The prep note (#1) lists per-kind apply
   refusals for `patch/pr/deploy/refund`. The real `ProposalKind` union is
   `'patch' | 'pr' | 'deploy' | 'note'` (`types.ts:1707`). H4 tests the four
   ACTUAL kinds + the `default:` exhaustiveness refusal (`apply.ts:438-444`).
2. **graph.ts scrub is weaker than index.ts.** `graph.ts:272` redacts only
   assignment-style `key|token|secret|password…=value`; it does NOT redact a bare
   JWT / `AKIA…` / long base64 blob that `index.ts:106-122` catches (Invariant 6,
   G6.8). Recommended local-only fix: graph.ts adopts the index pattern array.
   Deferred to BUILD with justification; H4 pins both behaviors so the gap is
   visible and any "fix" is a deliberate, reviewed change.
3. **`allowAnyRepo` lacks the `ASHLR_TEST_ALLOW_ANY_REPO` env-guard** that
   `advance.ts:156` has (cross-ref H5 prep). Out of H4 scope (H5 owns the
   env-gating fix); H4's KILL-SWITCH G4.6 nonetheless proves `allowAnyRepo` can
   NEVER override kill, which is the load-bearing safety property here.

---

## DEFINITION OF DONE (H4)

- 7 invariant suites + 1 verify-safety suite, all green, each `it()` with real
  `expect()` and `expect.hasAssertions()` in `beforeEach`.
- All 54 guards asserted; the 12 previously-untested guards explicitly covered.
- `src/cli/verify-safety.ts` exists, typed + JSDoc'd, lints clean, returns the
  documented exit codes, and is proven side-effect-free + outward-call-free by its
  suite. Dispatcher wiring deferred to integration.
- `npx tsc --noEmit` and `eslint` clean. No new runtime deps. Real `~/.ashlr`
  never touched.
</content>
</invoke>
