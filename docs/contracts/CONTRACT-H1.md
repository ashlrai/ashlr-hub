# CONTRACT-H1 — HARDEN & PROVE (the keystone milestone)

H1 proves the FULL autonomous chain works end-to-end on DISPOSABLE repos only,
with the real working tree NEVER mutated and the real `~/.ashlr` NEVER touched.
v2 (M21–M30) is built + unit-tested (2,964 tests) but the chain

```
enroll -> backlog -> daemon tick -> sandboxed swarm -> PENDING inbox proposal
        -> approve -> applyProposal
```

has only been exercised piecemeal. H1 delivers (a) a reusable test fixture for
disposable repos in an isolated tmp HOME, and (b) an end-to-end integration suite
that drives the REAL code paths and asserts the safety guarantees.

H1 adds **NO new outward capability** and **NO production behavior change.** It is
a TESTKIT + TESTS. Build against this contract: each BUILD agent edits ONLY its
own test file(s); do NOT modify any production module under `src/`; preserve all
existing tests; add no new runtime deps; do NOT `git commit`.

---

## ABSOLUTE SAFETY RULES (paramount)

1. **ISOLATED HOME.** Every test relocates `process.env.HOME` to a FRESH
   `os.tmpdir()` dir so every `~/.ashlr` read/write resolves to an ISOLATED home
   — NEVER the real one. The real portfolio (`~/.ashlr/enrollment.json =
   { repos: [] }`) is NEVER enrolled or touched.
2. **DISPOSABLE REPOS ONLY.** Every git repo a test operates on is created under
   `os.tmpdir()` with `makeDisposableRepo`. `applyProposal` / `createSandbox` are
   NEVER called against a non-tmp repo. Tests clean up after themselves.
3. **NO OUTWARD ACTION.** NEVER push / PR / deploy. No network beyond local model
   probes — and tests MUST pass with NO local model available (see Determinism).
4. **NO GUARD WEAKENING.** Do NOT weaken any production guard to make a test
   pass. If a real path can't be exercised deterministically, exercise it with a
   deterministic fixture that still runs the REAL code (real `tick`, real sandbox
   worktree, real `createProposal` / `setStatus` / `applyProposal`) and document
   why.

---

## DETERMINISM STRATEGY (critical)

A live daemon tick runs a real swarm that may spawn local-model engine
subprocesses — nondeterministic, and absent in CI. H1 splits the chain into two
deterministic halves that together exercise the REAL code with **zero live-LLM
dependency**:

- **Discovery / plan half** — drive the REAL `tick(cfg, { dryRun: true })` over a
  deterministically seeded `~/.ashlr/backlog.json` (`seedBacklog`). This proves
  backlog -> selection -> "would propose" wiring through real daemon code and
  creates ZERO proposals — no model, no swarm subprocess.
- **Apply half** — construct a REAL sandbox worktree (`createSandbox`) and a REAL
  `patch` Proposal carrying a KNOWN deterministic unified diff (`makeAddFileDiff`,
  exactly as the swarm's `propose` path would record one). `setStatus(approved)`,
  then real `applyProposal(confirmed:true)`, and assert the patch lands on a NEW
  `ashlr/proposal/<id>` branch with the real working tree byte-unchanged.

No live LLM is ever invoked. No nondeterminism is introduced. (The smoke run used
during scaffolding confirmed this whole real chain passes in ~0.2s.)

---

## THE REUSABLE TESTKIT — `test/helpers/h1-fixture.ts`

Placed under `test/helpers/` (NOT `src/`) so it never enters the published CLI
surface (`package.json#files = [dist, bin, schema]`; tsconfig `include: [src]`).
It is production-safe and strictly typed, but test-only. No runtime deps.

### Fixture API (exact shape)

```ts
// Lifecycle harness
function makeFixture(): H1Fixture;
async function withTmpHome<T>(fn: (fx: H1Fixture) => T | Promise<T>): Promise<T>;

interface H1Fixture {
  readonly home: string;        // tmp HOME (== process.env.HOME for this fixture)
  readonly ashlrDir: string;    // <home>/.ashlr
  makeRepo(opts?: MakeRepoOptions): DisposableRepo;  // auto-tracked for cleanup
  setKill(on: boolean): void;   // writes/removes <home>/.ashlr/KILL
  cleanup(): void;              // unenroll all, clear kill, restore HOME+env, rm -rf
}

// Disposable repo
function makeDisposableRepo(opts?: MakeRepoOptions): DisposableRepo;  // standalone
interface MakeRepoOptions {
  files?: Record<string, string>;  // repo-relative path -> content (initial commit)
  branch?: string;                 // default 'main'
  message?: string;                // default 'init'
  prefix?: string;                 // mkdtemp prefix, default 'ashlr-h1-repo-'
}
interface DisposableRepo {
  readonly dir: string;            // absolute path under os.tmpdir()
  readonly branch: string;
  enroll(): void; unenroll(): void; isEnrolled(): boolean;
  currentBranch(): string; branches(): string[];
  shasumTree(): string;            // content hash of tree, excludes .git
  gitStatus(): string;             // '' == clean working tree
  writeFile(rel: string, content: string): void;
  readFile(rel: string): string;
  destroy(): void;
}

// Deterministic helpers (no model)
function shasumTree(dir: string): string;                       // REAL-TREE-UNCHANGED primitive
function makeAddFileDiff(relPath: string, content: string): string;  // git-apply-able unified diff
function seedBacklog(home: string, repo: string,
  items: Array<{ title: string; detail?: string; value?: number; effort?: number }>): void;
function makeCfg(overrides?: Partial<AshlrConfig>): AshlrConfig; // in-memory cfg, never loadConfig()

type SeedFiles = Record<string, string>;
```

### What the fixture does

- **(a) Relocates HOME** to a fresh `os.tmpdir()` dir, snapshotting + clearing
  `ASHLR_IN_DAEMON` / `ASHLR_IN_SWARM` so a real `tick`/`runDaemon` is not refused
  by the re-entrancy guard. `makeFixture` asserts `homedir() === tmpHome` and
  REFUSES (restores + throws) if relocation didn't take effect — it will never
  silently risk the real `~/.ashlr`.
- **(b) Creates disposable git repos** with a local `user.name`/`user.email` and
  `commit.gpgsign=false` (self-contained; no dependence on global git config),
  seeded files + an initial commit so HEAD always resolves.
- **(c) Enroll / unenroll** the tmp repo against the ISOLATED registry via the
  real `enroll`/`unenroll`/`isEnrolled` from `core/sandbox/policy.ts`.
- **(d) Tears everything down** — `cleanup()` unenrolls + destroys every tracked
  repo, clears the kill switch, `rm -rf`s the tmp HOME, and restores `HOME` +
  re-entrancy env. Idempotent; never throws. `withTmpHome` runs it in a `finally`.

### HOME-isolation timing note (the one production seam needed: NONE)

The whole H1 chain — `sandbox/policy`, `sandbox/worktree`, `sandbox/audit`,
`inbox/store`, `inbox/apply`, `daemon/loop`, `daemon/state`, `portfolio/backlog`
— resolves paths via `os.homedir()` **at call time**, so relocating
`process.env.HOME` before invoking them is fully sufficient. `src/core/config.ts`
is the ONE module that freezes `CONFIG_DIR`/`CONFIG_PATH` from `homedir()` at
module-load time, but the H1 chain does NOT use those constants (the tick consumes
a plain `AshlrConfig` produced by `makeCfg()`, not `loadConfig()`). Therefore **no
production seam is added** — H1 reuses the existing `allowAnyRepo` test hatch on
`assertMayMutate`/`createSandbox` only where a not-enrolled refusal must be probed,
which is already present in production. If a future suite needs
`loadConfig()`/`CONFIG_DIR` under the tmp HOME, it must relocate HOME in a vitest
`setupFiles` entry that runs BEFORE `config.ts` is first imported.

---

## THE E2E SUITES (`test/h1.*.test.ts`) — what each asserts

### `test/h1.chain.test.ts` — BUILD task 1: FULL CHAIN (keystone)

Drives the whole chain on one disposable enrolled repo:

- `tick(dryRun)` over a seeded backlog reports items considered, creates 0
  proposals (discovery wiring, no model).
- `createSandbox` builds an isolated worktree under tmp `~/.ashlr/sandboxes`
  without mutating the source repo tree/index/HEAD/branches.
- A PENDING `patch` proposal is created from `makeAddFileDiff` (status=pending).
- `applyProposal` REFUSES while pending.
- After `setStatus(approved)` + `applyProposal(confirmed:true)`: patch lands on a
  NEW `ashlr/proposal/<id>` branch (ok:true, status=applied).
- **REAL-TREE-UNCHANGED:** `shasumTree(repo)` byte-identical before/after the
  whole chain; `git status --porcelain` stays empty; current branch unchanged.
- The applied change is reachable ONLY from the new branch.

### `test/h1.safety.test.ts` — BUILD task 2: SAFETY GATES

Each gate REFUSES and the real tree is unchanged: ENROLLMENT (empty enrollment
=> `no-enrolled-repos`; apply on non-enrolled refuses; `createSandbox` without
`allowAnyRepo` throws), KILL (`tick` => `kill-switch`; apply refuses; kill checked
before enrollment), BUDGET (`budget-exhausted`; per-tick item cap bounds
`itemsConsidered`), CONFIRM+STATUS (refuses unconfirmed/pending/rejected). A final
group asserts `shasumTree` + `git status` byte-identical across every refusal.

### `test/h1.audit.test.ts` — BUILD task 3: AUDIT TRAIL + ISOLATION

Audit dir resolves UNDER the tmp HOME; a completed chain writes
`inbox:proposal-created` -> `inbox:proposal-approved` -> `inbox:apply (ok)`; a
refused apply writes `inbox:apply (refused)`; the log is append-only; no secrets
in summaries. ISOLATION: `homedir()` stays the tmp HOME; `enrollmentPath()` points
under it; the real `~/.ashlr/enrollment.json` (captured before the suite) is
byte-identical after; `cleanup()` removes the tmp HOME and restores HOME exactly.

### `test/h1.fixture.test.ts` — BUILD task 4: the TESTKIT proves ITSELF

Self-tests: HOME relocation + restore; disposable repo has resolvable HEAD + clean
tree + enroll round-trip; `shasumTree` deterministic, excludes `.git`, detects
byte changes + new files; `makeAddFileDiff` is `git apply`-able with/without
trailing newline; `seedBacklog` matches `loadBacklog()`'s shape and scores
value/effort; `cleanup` idempotent and unenrolls tracked repos.

---

## H1 INVARIANTS (verbatim) + HOW EACH IS PROVEN

- **REAL-TREE-UNCHANGED** — across the WHOLE chain, the disposable repo's working
  tree is byte-identical and git-clean. *Proven by:* `shasumTree(repo)` snapshot
  before == after (SHA-256 over sorted repo-relative path + raw bytes, `.git`
  excluded) AND `git status --porcelain` stays `''` AND `currentBranch()`
  unchanged. Asserted after every gate refusal and after a full successful apply.
- **PROPOSAL-ONLY** — the only sink of autonomous work is a PENDING -> approved ->
  applied proposal; nothing pushes/PRs/deploys. *Proven by:* a `tick` produces
  only PENDING proposals (`status==='pending'`, never auto-applied);
  `applyProposal` is the SOLE outward path and is invoked only by the test after
  an explicit `setStatus(approved)` + `confirmed:true`; `applyProposal` for a
  `patch` never pushes (no `git push` / `gh` invocation; the new branch is local).
- **ENROLLMENT honored** — empty enrollment does nothing; non-enrolled repos
  refuse. *Proven by:* empty-registry `tick` => `no-enrolled-repos`;
  `applyProposal` on a non-enrolled tmp repo refuses (status stays approved, no
  branch); `createSandbox` without `allowAnyRepo` throws.
- **KILL honored** — the kill switch halts everything immediately. *Proven by:*
  `setKill(true)` => `tick` returns `kill-switch`; `applyProposal` refuses even
  for approved+confirmed+enrolled; kill is checked before enrollment.
- **BUDGET honored** — hard daily USD cap + per-tick item cap. *Proven by:*
  pre-seeding `daemon.json` with `todaySpentUsd >= dailyBudgetUsd` => `tick`
  returns `budget-exhausted` with 0 proposals; `itemsConsidered <= perTickItems`.
- **ISOLATED** — the real `~/.ashlr` is never read or written. *Proven by:*
  `homedir() === fixture.home` for the fixture lifetime; `enrollmentPath()` /
  `auditDir()` resolve under the tmp HOME; the real `enrollment.json` captured
  before the suite is byte-identical after.
- **DETERMINISTIC** — no live-LLM dependency; passes with no local model.
  *Proven by:* the chain is exercised via real `tick(dryRun)` (no swarm spawn) +
  real `createSandbox`/`createProposal`/`applyProposal` against a KNOWN diff; the
  suites never invoke a model and assert exact outcomes.

---

## DELIVERABLES

| Path | Role |
| --- | --- |
| `CONTRACT-H1.md` | this contract |
| `test/helpers/h1-fixture.ts` | reusable testkit (fully implemented) |
| `test/h1.chain.test.ts` | BUILD task 1 — full chain (skeleton, `it.todo`) |
| `test/h1.safety.test.ts` | BUILD task 2 — safety gates (skeleton) |
| `test/h1.audit.test.ts` | BUILD task 3 — audit + isolation (skeleton) |
| `test/h1.fixture.test.ts` | BUILD task 4 — testkit self-tests (skeleton) |

No production module is changed. No new runtime dep. No test-only production seam
is added (the existing `allowAnyRepo` hatch suffices). Typecheck, lint, and vitest
collection are clean; the fixture was smoke-validated against the real chain.
