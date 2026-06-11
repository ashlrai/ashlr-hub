# CONTRACT-H6 — HARDEN & PROVE: AUDIT COMPLETENESS & SECRET-SCRUB PARITY

Milestone H6 of Ashlr v2.1 "Harden & Prove". Builds on **H1** (`test/helpers/h1-fixture.ts`)
and **H2** (`test/helpers/h2-faults.ts`) and **REUSES BOTH testkits** — no new fixture/fault
helper is required. New tests live under `test/h6.*.test.ts`. New read-only CLI viewer lives
in `src/cli/audit.ts`.

**H6 closes the CONFIRMED gaps** surfaced by the read-only prep scout
(`~/.ashlr/docs/HARDEN-PREP-NOTES.md`, the **H6** section + the **"Findings surfaced by H4"**
section). Every change is **MINIMAL, LOCAL-ONLY, DEFENSE-IN-DEPTH**: each one STRENGTHENS an
existing guarantee and NONE weakens a guard or adds any outward capability. No new runtime
dependency. Node builtins only.

### THE H6 META-GUARANTEE

> **Every state-changing safety action leaves an append-only, secret-free audit record on
> EVERY path (CLI or programmatic), and the local secret-scrub guards are at PARITY — the
> weaker `graph.ts` scrub adopts `index.ts`'s full pattern set, and `index.ts` gains the bare
> `sk_live_`/`sk_test_` Stripe pattern — all without weakening proposal-only, sandbox-required,
> enrollment, kill-switch, containment, or local-first/no-cloud-egress.**

---

## ABSOLUTE SAFETY RULES (paramount — inherited verbatim from H1/H2/H3/H4/H5)

- **ISOLATED HOME.** Every test relocates `process.env.HOME` to a FRESH `os.tmpdir()` dir via
  the H1 fixture (`makeFixture`/`withTmpHome`), so every `~/.ashlr` read/write resolves to an
  ISOLATED home — **NEVER the real one**. The real portfolio (`{repos:[]}`) is NEVER touched.
- **DISPOSABLE REPOS.** All git/enroll ops run on disposable repos created by `fx.makeRepo()`.
- **DETERMINISTIC.** No live model; no network. Every `it()` has a real `expect()` plus
  `expect.hasAssertions()` (the H2–H5 reviews caught false-green stubs — do NOT repeat).
- **NO GUARD WEAKENED.** Every production change is local-only, defense-in-depth, and adds NO
  outward capability. The audit additions emit **metadata only, never a secret value** (the
  existing `stripSecrets()` in `audit.ts` is the final backstop; callers pass only an action
  verb, a repo path or `null`, and an `ok`/`refused`/`error` result). The H4 safety regression
  suite (`test/h4.*`) + `ashlr verify-safety` MUST still pass after the deliberate assertion
  flips in PART B (see §B.4).

---

## PART A — AUDIT COMPLETENESS

### A.1 — THE GAP

`audit()` (`src/core/sandbox/audit.ts:91`, append-only JSONL under `~/.ashlr/audit/<date>.jsonl`,
`stripSecrets()` before write) covers **26 call sites** but MISSES three state-changing safety
actions. Each toggles the enrollment registry or the kill switch — the exact gate H4 proves —
yet leaves NO forensic record:

| Action            | Source                                                     | Today |
|-------------------|------------------------------------------------------------|-------|
| enroll **add**    | `policy.ts` `enroll()` (:125) / `cli/sandbox.ts:407`       | NOT audited |
| enroll **remove** | `policy.ts` `unenroll()` (:138) / `cli/sandbox.ts:426`     | NOT audited |
| kill-switch toggle| `policy.ts` `setKill()` (:90) / `cli/sandbox.ts:445`       | NOT audited |

### A.2 — THE FIX (emit `audit()` INSIDE `policy.ts`)

Emit `audit()` **inside** `enroll` / `unenroll` / `setKill` in `src/core/sandbox/policy.ts` so
**EVERY** path (CLI `cmdEnroll`, or any programmatic caller incl. the H1 fixture, daemon, or a
future onboard flow) is captured — not just the CLI surface. This is the single-source-of-truth
choice (mirrors how H5 audits the sweep at the primitive, not the command).

**Record shape (metadata only — NEVER a secret value):**

| Function    | `action`         | `repo`              | `sandboxId` | `summary`                         | `result` |
|-------------|------------------|---------------------|-------------|-----------------------------------|----------|
| `enroll`    | `enroll:add`     | resolved abs path   | `null`      | `enrolled <abs>` (idempotent no-op still emits) | `ok` |
| `unenroll`  | `enroll:remove`  | resolved abs path   | `null`      | `unenrolled <abs>`                | `ok`     |
| `setKill`   | `kill:on`/`kill:off` | `null`          | `null`      | `kill switch <on\|off>`           | `ok`     |

- The **`repo` field is a path, NEVER a token** — a repo path is not a secret. The `summary`
  is metadata only; `stripSecrets()` runs over it as the standard backstop.
- **Import discipline.** `policy.ts` today imports only node builtins + `../types.js`. The fix
  adds `import { audit } from './audit.js'`. `audit.ts` imports only node builtins + a `type`
  from `../types.js` — so there is **NO import cycle** (audit.ts does not import policy.ts).
  This MUST be re-verified by an H6 test (A-test 5).
- **Never throws.** `audit()` already swallows all errors internally; the `enroll`/`unenroll`/
  `setKill` contracts ("never throw except the intentional assert", which these three are not)
  are preserved because `audit()` cannot throw.
- **Idempotency UNCHANGED.** `enroll`/`unenroll` keep their early-return-on-no-change write
  behavior. DECISION (pinned by A-test 2): the `audit()` call is placed so a **no-op enroll/
  unenroll STILL emits an `ok` record** (the action was requested and permitted) — auditing
  intent, not just disk mutation. `setKill` likewise emits on every call (idempotent on disk).

### A.3 — THE READ-ONLY VIEWER (`ashlr audit` in `src/cli/audit.ts`)

A NEW module `src/cli/audit.ts` exporting `cmdAudit(args: string[]): Promise<number>` — a
**READ-ONLY** viewer over `readAudit()`. **Mutates nothing. No outward call. No model.**

> **NOTE — pre-existing `cmdAudit` in `cli/sandbox.ts`.** A minimal `cmdAudit`
> (`--limit`/`-n`, `--json`, positional numeric) already exists in `src/cli/sandbox.ts:325`
> and is wired in the dispatcher via `loadAuditCmd` (`cli/index.ts:294`). H6 MOVES the viewer
> into its own `src/cli/audit.ts` and EXTENDS it with the H6 filters below, then **re-points
> the `loadAuditCmd` loader at `./audit.js`**. The old `cmdAudit`/`formatAuditEntry` block in
> `cli/sandbox.ts` is removed (its `AuditEntry` import + the `loadAuditModule` lazy loader move
> with it). `cmdSandbox` and `cmdEnroll` stay in `cli/sandbox.ts` unchanged (apart from the
> A.2 audit emission, which is in `policy.ts`, not here).

**Surface (all read-only flags; superset of the old one — no removed behavior):**

| Flag                        | Effect |
|-----------------------------|--------|
| `--limit N` / `-n N` / `N`  | Cap to the newest N records (existing behavior, preserved). |
| `--json`                    | Emit the records as a JSON array (existing behavior, preserved). |
| `--action <verb>`           | **NEW** — filter to records whose `action` equals (or `startsWith` `verb:`) the value, e.g. `--action enroll` matches `enroll:add`+`enroll:remove`; `--action kill:on` matches exactly. |
| `--result <ok\|refused\|error>` | **NEW** — filter to records with that outcome. |
| `--since <ISO-or-YYYY-MM-DD>`   | **NEW** — drop records whose `ts` is strictly before the given instant. Unparseable value => print an error to stderr, return `2`, read nothing. |

- Filtering happens **in `cmdAudit` over the `readAudit()` result** (read-only post-filter);
  `readAudit()` itself is unchanged. `--limit` is applied AFTER the action/result/since filters
  so "newest N matching" is the intuitive result (pinned by A-test 9).
- Unknown flags => stderr usage + return `2`. Module-not-built => the existing `moduleNotBuilt`
  pattern, return `1`. Empty / no-match => friendly "No audit entries found." (non-`--json`)
  or `[]` (`--json`), return `0`.
- Dispatcher: `loadAuditCmd` in `src/cli/index.ts` is re-pointed from `./sandbox.js`'s
  `cmdAudit` to `./audit.js`'s `cmdAudit`. The `audit` case in the command switch is unchanged.

---

## PART B — SECRET-SCRUB PARITY (the two H4-surfaced findings, now STRENGTHENED)

### B.1 — `graph.ts` scrub is WEAKER than `index.ts` (FINDING → FIX)

`knowledge/graph.ts:272-276` `scrubSecrets` uses **ONE** assignment-style regex
(`SECRET_PATTERN`) and misses bare JWT / AKIA / base64 / hex blobs. `knowledge/index.ts:110-139`
exports a frozen 6-pattern `SECRET_PATTERNS` array + `scrubSecrets`.

**FIX — graph.ts adopts index.ts's pattern set (PARITY):**
- `graph.ts` imports the exported `SECRET_PATTERNS` **and** `scrubSecrets` from
  `./index.js` and uses the imported `scrubSecrets` at the `detail:` emit site (the existing
  `crossRepo` `detail` scrub). The module-private `SECRET_PATTERN` single-regex is removed.
- **PARITY DIRECTION (review-finding, pinned).** "Parity" means graph.ts adopts index.ts's
  **superset** of high-entropy shapes (bare JWT / AKIA / base64 / hex / `sk_live_`). The OLD
  graph regex additionally matched bare LOW-entropy assignments like `token=abc123` / `auth=xyz`;
  index.ts's compound-name + high-entropy patterns intentionally do NOT, so those narrow shapes
  are **dropped** in this direction. This is SAFE because the only string graph.ts scrubs is the
  structurally-constrained `detail` string `${dep} shared across N repos: basename@version`
  (dep names + repo@version, never free-form text) — a bare `token=…` literal cannot occur there.
  The milestone's intended strengthening (bare JWT / AKIA / base64 / hex / `sk_live_`) IS
  achieved; the dropped low-entropy assignments are non-occurring at the call site.
- **`SECRET_PATTERNS` is LOAD-BEARING (not decorative).** graph.ts's `scrubSecrets` asserts the
  imported parity array is non-empty (`if (SECRET_PATTERNS.length === 0) throw`) before
  delegating to index's `scrubSecrets`, so a wiped/empty upstream pattern set surfaces as a
  throw at the graph.ts call site rather than a silent no-op. The import is real code, not a
  `void`-ed symbol kept only to satisfy a source marker.
- **`ashlr verify-safety` CHECK 4 pins LIVE CODE (DECISION — Option B taken).** CHECK 4
  (`verify-safety.ts`) now asserts the graph.ts source (a) defines `function scrubSecrets`,
  (b) IMPORTS the parity scrub from `./index.js` (`from './index.js'` + `scrubSecrets` +
  `SECRET_PATTERNS`), so the self-check tracks the GENUINE delegation/strengthening — NOT a
  vestigial `key|token|secret|password` assignment-regex string that, post-B.1, lived only in a
  comment. A cosmetic comment edit can no longer trip CHECK 4; only removing the real parity
  import will. The prior plan (a comment-carrying wrapper to avoid touching verify-safety) was
  REPLACED by this honest live-code marker per the H6 review finding.

### B.2 — `index.ts` misses a bare Stripe `sk_live_<underscores>` token (FINDING → FIX)

`index.ts` `SECRET_PATTERNS` misses a bare `sk_live_…` / `sk_test_…` token because underscores
break the base64 char class and the `\w` boundary.

**FIX — add a pattern to `SECRET_PATTERNS`:**
```
/\bsk_(live|test)_[A-Za-z0-9_]{16,}\b/g
```
- Appended to the `SECRET_PATTERNS` array, growing it from 6 → 7 entries. `verify-safety.ts:370`
  asserts `SECRET_PATTERNS.length >= 6`, so this STAYS green (7 ≥ 6). The synthSecret round-trip
  in CHECK 4 is unaffected (it does not contain an `sk_live_` token).
- Placement: appended AFTER the existing high-entropy patterns; order is irrelevant since all
  patterns are applied. Add a `// H6:` comment referencing this milestone + the H4 finding.

### B.3 — PARITY OUTCOME

After B.1 + B.2: `graph.ts` and `index.ts` use the **same** `SECRET_PATTERNS` (graph imports
index's), and that shared set now ALSO redacts bare `sk_live_`/`sk_test_`. The two scrubs are at
PARITY — the H4 §6.8 FINDING is closed.

### B.4 — DELIBERATE FLIP OF THE PINNED H4 ASSERTIONS (intended strengthening, NOT regression)

These H4 assertions PINNED the OLD (weaker) behavior. B.1/B.2 STRENGTHEN the guards, so the
assertions FLIP. Each flip is **deliberate**, gets an inline comment referencing **H6**, and the
H4 suite + `verify-safety` MUST pass after.

**In `test/h4.local-first-secret.test.ts`:**

1. **`6.8` behavioral block (~lines 508-510)** — currently asserts graph.ts MISSES bare blobs:
   ```ts
   expect(graphScrub(SECRET_JWT)).toContain(SECRET_JWT);    // graph misses bare JWT
   expect(graphScrub(SECRET_AWS)).toContain(SECRET_AWS);    // graph misses bare AKIA
   expect(graphScrub(SECRET_BASE64)).toContain(SECRET_BASE64); // graph misses bare blob
   ```
   FLIP to assert the secret IS NOW redacted (parity):
   ```ts
   // H6 PARITY: graph.ts adopted index.ts SECRET_PATTERNS — bare blobs now redacted.
   expect(graphScrub(SECRET_JWT)).not.toContain(SECRET_JWT);
   expect(graphScrub(SECRET_AWS)).not.toContain(SECRET_AWS);
   expect(graphScrub(SECRET_BASE64)).not.toContain(SECRET_BASE64);
   ```
   - **`graphScrub` helper (~line 430)** reconstructs graph's regex from a single
     `const SECRET_PATTERN = /…/;`. After B.1 graph.ts no longer defines that literal, so the
     helper MUST be updated to exercise graph's NEW imported pattern set (e.g. re-run the
     `SECRET_PATTERNS` array, or import graph's exported `scrubSecrets` if exposed). This is a
     test-harness update tracked here so the flip is faithful (still the REAL graph behavior).
   - The `6.8` STATIC assertions at `:503-504` (`graphPatternBlock` `not.toContain('AKIA'/'eyJ')`)
     reference the removed `SECRET_PATTERN` block. Update them in lockstep (assert the new
     import/parity instead) with an H6 comment.

2. **The `sk_live_` FINDING (the `SECRET_SK_BODY`/`SECRET_SK` note ~lines 254-262 + §6.6 usage)**
   — the H4 note documents that `index.ts` redacts a `sk-` (hyphen) token via its base64 body but
   does NOT redact `sk_live_<underscores>`. H6 B.2 adds the `sk_(live|test)_` pattern. Add a
   `SECRET_SK_LIVE` constant (e.g. `sk_live_<16+ underscores/alnum>`) and assert it IS redacted in
   §6.6's stored-chunk loop, with an H6 comment. Leave the existing `sk-` (hyphen) case intact —
   it still passes.

> **These are the ONLY intended assertion flips.** No OTHER H4 assertion changes. After the
> flips, `npm test` (H4 + H6) and `ashlr verify-safety` are GREEN.

---

## PRODUCTION STUBS (this scaffold)

| File | Stub state | Final state |
|------|-----------|-------------|
| `src/core/sandbox/policy.ts` | `// H6-STUB:` markers in `enroll`/`unenroll`/`setKill` showing WHERE `audit()` is emitted (no behavior change yet) + `import { audit }` commented | `audit()` emitted on each, per §A.2 |
| `src/cli/audit.ts` | NEW file: `cmdAudit` exported, parses all flags, delegates to a `// H6-STUB:` filter that today returns `readAudit()` unfiltered; viewer printing wired | Action/result/since filters implemented per §A.3 |
| `src/cli/index.ts` | unchanged in scaffold | `loadAuditCmd` re-pointed to `./audit.js` (§A.3) |
| `src/cli/sandbox.ts` | unchanged in scaffold | old `cmdAudit`/`formatAuditEntry`/`loadAuditModule` removed (§A.3) |
| `src/core/knowledge/graph.ts` | `// H6-STUB:` comment at `scrubSecrets`/`SECRET_PATTERN` marking the planned import-of-index parity | imports + uses index's `SECRET_PATTERNS`/`scrubSecrets` (§B.1) |
| `src/core/knowledge/index.ts` | `// H6-STUB:` comment at `SECRET_PATTERNS` marking the planned `sk_(live\|test)_` addition | `sk_(live\|test)_` pattern appended (§B.2) |

**The scaffold compiles and the existing suite stays GREEN** — stubs are comment-only or
behavior-preserving; no assertion is flipped until the implementation step.

---

## TEST PLAN — `test/h6.*.test.ts` (skeletons in this scaffold)

All tests REUSE `test/helpers/h1-fixture.ts` (`withTmpHome`/`makeFixture`/`makeRepo`) and, where
a static-source read is needed, `test/helpers/h4-static.ts` (`readSource`/`stripComments`). Every
`it()` carries a real `expect()` and the file/`describe` carries `expect.hasAssertions()` in a
`beforeEach`. Skeletons are authored `it.todo(...)` OR `it(..., () => { expect.hasAssertions();
/* TODO H6 */ })` so the scaffold run is **honestly pending**, never false-green.

### `test/h6.audit-completeness.test.ts` (PART A)

1. **enroll add → audit `enroll:add` `ok`, repo=abs, no secret** — enroll a disposable repo via
   `policy.enroll`; `readAudit()` shows a fresh `enroll:add` `ok` record whose `repo` is the
   resolved abs path and whose serialized line contains NO token-shaped secret.
2. **idempotent enroll STILL emits** — enroll twice; TWO `enroll:add` records (auditing intent).
3. **unenroll → audit `enroll:remove` `ok`** — symmetric to (1).
4. **setKill(true)/(false) → audit `kill:on`/`kill:off` `ok`, repo=null** — toggle both ways.
5. **NO import cycle** — `[STATIC]` assert `audit.ts` does NOT import `policy` (read both
   sources; `policy.ts` imports `./audit.js`, `audit.ts` imports neither `policy` nor `cli`).
6. **programmatic path audited (not just CLI)** — call `policy.enroll` directly (the H1 fixture
   path) and confirm the record exists — proving the emit is at the primitive, not the command.
7. **audit NEVER throws from enroll/unenroll/setKill** — relocate HOME to an unwritable/odd path
   spy or assert the call returns normally even if audit's dir is missing (audit swallows).
8. **`cmdAudit --action enroll` filter** — seed records via real enroll/unenroll/setKill, run
   `cmdAudit(['--action','enroll','--json'])`, parse stdout, assert ONLY `enroll:*` records.
9. **`cmdAudit --result` + `--since` + `--limit` compose** — newest-N-matching after filters.
10. **`cmdAudit` read-only** — snapshot the audit dir bytes before/after a `cmdAudit` run; the
    on-disk audit files are byte-identical (the viewer mutates nothing).
11. **`cmdAudit` bad `--since` → exit 2, reads nothing**; unknown flag → exit 2.

### `test/h6.scrub-parity.test.ts` (PART B)

1. **graph.ts NOW redacts bare JWT/AKIA/base64** — exercise graph's REAL (post-fix) scrub over
   `SECRET_JWT`/`SECRET_AWS`/`SECRET_BASE64`; each `[REDACTED]`, raw gone (the flipped 6.8).
2. **index.ts NOW redacts bare `sk_live_`/`sk_test_`** — `scrubSecrets('sk_live_<16+>')` →
   `[REDACTED]`, raw gone; plus the `sk_test_` variant. The old `sk-` hyphen case still redacts.
3. **PARITY [STATIC]** — `graph.ts` source imports `SECRET_PATTERNS`/`scrubSecrets` from
   `./index.js`; both files now share the set; `SECRET_PATTERNS.length === 7`.
4. **`verify-safety` CHECK 4 still GREEN [STATIC]** — graph.ts source still matches
   `/function scrubSecrets/` + `/SECRET_PATTERN/` + `/key|token|secret|password/`; index still
   pins `AKIA`/`eyJ` and `SECRET_PATTERNS.length >= 6`. (Guards the §B.1 constraint.)
5. **end-to-end via `buildGraph` `detail` [optional, behavioral]** — if a cross-repo `detail`
   carrying a bare blob can be seeded on disposable repos, assert the emitted `detail` is
   `[REDACTED]`. Otherwise the STATIC + real-scrub path (1) is the faithful proof (per H4 §6.8).

---

## DEFINITION OF DONE (H6)

- [ ] `audit()` emitted inside `policy.ts` `enroll`/`unenroll`/`setKill` (every path captured),
      metadata-only, no secret value, no import cycle, never throws.
- [ ] `src/cli/audit.ts` read-only viewer with `--limit`/`--json`/`--action`/`--result`/`--since`;
      `loadAuditCmd` re-pointed; old `cmdAudit` removed from `cli/sandbox.ts`.
- [ ] `graph.ts` imports + uses index's `SECRET_PATTERNS`/`scrubSecrets` (parity).
- [ ] `index.ts` `SECRET_PATTERNS` gains `/\bsk_(live|test)_[A-Za-z0-9_]{16,}\b/g` (6 → 7).
- [ ] H4 §6.8 + `sk_live_` assertions FLIPPED deliberately with H6 comments; H4 suite GREEN.
- [ ] `test/h6.audit-completeness.test.ts` + `test/h6.scrub-parity.test.ts` GREEN, real `expect()`
      + `expect.hasAssertions()` per `it()`, isolated tmp HOME, disposable repos, no live model.
- [ ] `ashlr verify-safety` GREEN; `npm test` GREEN; `npm run lint` + `tsc` clean.
- [ ] Real `~/.ashlr` never touched; NO outward capability added; NO guard weakened; NO new dep.
