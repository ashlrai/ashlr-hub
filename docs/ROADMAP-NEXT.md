# Roadmap — next milestones (M83–M88)

Forward-looking plan authored 2026-06-23, after PR #8 landed Windows support on
`master`. These follow the house **contracts-first** style (goal → hard rule →
surface → verification → non-goals); a binding `CONTRACT-Mxx.md` is authored in
each milestone's scaffold phase when it is actually built. Numbering starts at
**M83** (code/tests currently run to ~M82).

Ordering note: **M84 → M83 → M85** is the critical path to a green CI on every
OS; M86–M88 are independent feature/release tracks.

---

## M84 — Provider-independent tests (CI-green) · closes #9
**Goal:** make the test suite pass on CI with **no local LLM provider running**,
which is the actual environment of `.github/workflows/ci.yml` (`ubuntu-latest`,
no Ollama/LM Studio).

**Why now:** this is the *only* remaining red on CI and it is pre-existing, not
Windows-related. It was masked for a long time because CI runs `Lint` before
`Test` and a `no-explicit-any` lint error short-circuited the run; fixing lint in
PR #8 surfaced it. See #9.

**Hard rule:** do **not** weaken the TITRR assertions. Mock at the provider-client
**seam** so the Test→Iterate→Test→Refine→Repeat loop logic is still exercised — a
skip-guard (the cheaper option) leaves the loop uncovered on CI and is the
fallback only if mocking proves infeasible.

**Surface:**
- `test/m78.titrr.test.ts` — the 5 failing cases (~lines 181, 204, 226, 260, 284)
  call `runGoal()`, which calls `getActiveClient()` (`src/core/run/provider-client.ts:905`).
  Add `vi.doMock('../src/core/run/provider-client.js', () => ({ getActiveClient: () => fakeClient }))`
  before the dynamic-import resets the file already does for the engine mocks.
- Audit for OTHER tests that call `runGoal`/`getActiveClient` without a provider
  mock (grep `getActiveClient`, `runGoal`) and apply the same seam.

**Verification:**
1. `npm test` green on a machine/CI with **no** provider reachable (kill Ollama
   locally to simulate, or rely on the CI run).
2. Local with Ollama up: still green (the mock must not depend on absence).
3. tsc + `eslint .` clean (0 errors).

**Non-goals:** changing the orchestrator's real provider resolution · removing the
local-first "no provider reachable" guard from production code.

**Effort:** S (one file + an audit). **Depends on:** none.

---

## M83 — Windows CI lane (lock in cross-platform)
**Goal:** add `windows-latest` to the CI matrix so the Windows support landed in
PR #8 cannot silently regress.

**Why now:** all the Windows fixes (bin launch, `open`/`classify`/`doctor`/
`mcp-native-engineer`/`verify-commands`, HOME-isolation shim, `maxForks:4`) are
verified **once**, by hand, on one machine. Without a Windows CI lane the next
refactor reintroduces a `split('/')` or a `which` and nobody notices.

**Hard rule:** CI must be green on **both** `ubuntu-latest` and `windows-latest`.
Platform-incompatible tests stay **skip-guarded with a stated reason** (the 21
current skips: real symlinks/EPERM, POSIX mode bits, sandbox-exec, rg/grep) — no
vacuous green, and the false-green guards (e.g. `expect(todoScannerAvailable()).toBe(true)`)
must keep failing loudly where the capability IS expected.

**Surface:**
- `.github/workflows/ci.yml` — `strategy.matrix.os: [ubuntu-latest, windows-latest]`,
  `runs-on: ${{ matrix.os }}`.
- The **Pack smoke** step uses a bash heredoc (`mktemp`, `$PWD`, `./node_modules/.bin/ashlr`)
  — pin it `shell: bash` (works on Windows runners) or gate it to ubuntu, since
  the tarball-exports check is OS-independent.
- Confirm `npm ci` + `npm run build` + `npm test` run clean on the Windows runner
  (note: Windows CI also has **no** Ollama, so this depends on M84).

**Verification:** a green check on `windows-latest` for both Node 20 and 22; the
21 Windows-skips RUN (and pass) on ubuntu; pack-smoke passes on both.

**Non-goals:** changing test logic to pass on Windows (that was M-cross-platform in
PR #8) · adding a provider to the runner.

**Effort:** S. **Depends on:** M84 (else the Windows lane is also red on m78).

---

## M85 — Repo EOL hygiene (`.gitattributes`)
**Goal:** stop CRLF churn. The repo has **no `.gitattributes`**, so Windows
checkouts get CRLF and every edit risks an LF↔CRLF flip — during PR #8 a 4-file,
~45-line change staged as 3000+ lines until normalized with `core.autocrlf=input`.

**Hard rule:** the renormalization must be a **single, isolated commit** with no
logic changes, so history stays reviewable. Verify line endings before/after.

**Surface:**
- Add `.gitattributes` at repo root: `* text=auto eol=lf` (+ explicit binary
  globs for any images/tarballs if present).
- One renormalize commit: `git add --renormalize .` → commit "chore: normalize
  line endings to LF". Document the `git -c core.autocrlf=input add` workaround as
  no-longer-needed in CONTRIBUTING.

**Verification:** fresh checkout on Windows shows a clean `git status`; staging an
edited file emits no "LF will be replaced by CRLF" warning; `npm test` unaffected.

**Non-goals:** reformatting code · changing editorconfig/prettier rules.

**Effort:** XS. **Depends on:** none (do it on a quiet branch — touches every file).

---

## M86 — Goal Loop / roadmap runner — port to v3
**Goal:** re-introduce the fresh-process-per-milestone roadmap runner
(`ashlr roadmap`) — the "looping functionality" from the 0.1.0 line — adapted to
v3's fleet/engine architecture.

**Why:** it was the user's prior work and is **not** in v3 (it lives only on
`backup/local-0.1.0-work`; no `roadmap.ts`/`goal-loop/` on `master`). v3's TITRR
and fleet loops are a different concept and don't replace it.

**Hard rule:** local-first (no cloud without `--allow-cloud`); **one fresh OS
process per milestone** so a crash/leak in milestone N can't corrupt N+1 (the
original crash-isolation rationale); any mutation confirm-gated / inbox-routed.

**Surface:**
- Port from `backup/local-0.1.0-work`: `src/core/goal-loop/{types,state,parse,result,runner}.ts`,
  `src/cli/roadmap.ts`, and `test/goal-loop.*`.
- **Adapt to v3** (this is the real work — v3 rewrote these): the runner must call
  v3's `src/core/run/orchestrator.ts` / `engine-registry.ts` / `foundry` config,
  not the 0.1.0 `model-manager`. Reconcile `AshlrConfig` shape diffs. Wire lazy
  dispatch in `src/cli/index.ts`.

**Verification:** ported `test/goal-loop.*` adapted and green on clean HOME;
`ashlr roadmap` drives a 2-milestone plan end-to-end against a local provider (or
a mocked client per M84's seam).

**Non-goals:** reviving the 0.1.0 provider-picker wholesale (see M87) · changing
v3's fleet/TITRR behavior.

**Effort:** L (architecture adaptation, not a cherry-pick). **Depends on:** M84's
provider-mock seam (for deterministic tests).

---

## M87 — Interactive setup helper (`ashlr setup`)
**Goal:** the second half of the original idea — an interactive flow that detects
where the user's repos live, offers to set `roots`, and wires a local provider.
Complements the **0-repos guidance** shipped in PR #8 (which currently only tells
the user the commands to run by hand).

**Hard rule:** all config writes are **confirm-gated**; **never overwrite existing
`roots`** without explicit confirm; **non-TTY safe** — `--yes` proceeds with the
top detected candidate, no prompt; idempotent (re-running is safe).

**Surface:**
- `src/cli/setup.ts` — scan likely parents (cwd, `~`, `~/coding`, `~/code`,
  `~/projects`, `~/src`) for directories that *contain* git repos as children
  (reuse the `index-engine` walk), rank by repo count, present candidates, write
  `roots` on confirm via `saveConfig`. Offer `models setup` / provider detection
  next (borrow the picker concept from `backup/local-0.1.0-work:src/cli/provider-picker.ts`).
- Wire into `src/cli/onboard.ts` and reference it from the 0-repos guidance
  ("Run `ashlr setup` to do this interactively").

**Verification:** on a fresh HOME with repos under `~/coding/work`, detects the
folder, sets `roots` on confirm, `ashlr status` then tracks repos; `--yes` path
works non-interactively; declining writes nothing.

**Non-goals:** auto-setting roots without confirm · cloud provider signup.

**Effort:** M. **Depends on:** none (0-repos guidance already shipped).

---

## M88 — npm publish readiness (ship to the masses)
**Goal:** the original objective — make `@ashlr/hub` cleanly publishable, so a
user can `npm i -g @ashlr/hub` and get a working `ashlr` on Windows + macOS +
Linux. Package is currently **unpublished** (registry 404) at v3.0.1.

**Hard rule:** **green CI on ubuntu AND windows** gates publish (M83/M84) · **no
secret/credential** in the tarball · the published bin must launch on Windows
(the PR #8 `file://` fix is mandatory and now in `master`).

**Surface:**
- Audit `package.json` `files`/`bin`/`exports` and the existing **Pack smoke** CI
  step (installs the tarball, runs `ashlr help` + the `./types` and `./core`
  entry points) — extend it to assert the bin launches on the Windows runner.
- Version policy (currently `3.0.1`), `prepublishOnly` gate (serial test run),
  `npm publish --dry-run` review, provenance/access settings for the `@ashlr`
  scope.
- README: Windows install + first-run (`ashlr setup` once M87 lands) instructions.

**Verification:** `npm publish --dry-run` clean; installing the packed tarball in
a throwaway dir yields a working `ashlr help` on **both** a Windows and a Linux
box; tarball contains only `dist/ bin/ schema/` (no secrets, no `coverage/`).

**Non-goals:** the actual `npm publish` (a human, intentional act) · marketing.

**Effort:** M. **Depends on:** M83, M84 (green cross-OS CI).

---

### At a glance
| ID | Title | Effort | Depends on | Track |
|----|-------|--------|-----------|-------|
| M84 | Provider-independent tests (closes #9) | S | — | CI-green |
| M83 | Windows CI lane | S | M84 | CI-green |
| M85 | `.gitattributes` EOL hygiene | XS | — | hygiene |
| M86 | Goal Loop / roadmap port to v3 | L | M84 | feature |
| M87 | Interactive `ashlr setup` | M | — | feature |
| M88 | npm publish readiness | M | M83, M84 | release |

**Recommended first sprint (green-CI + ship-ready foundation):** M84 → M83 → M85,
then M88. M86 and M87 are larger features to schedule deliberately.
