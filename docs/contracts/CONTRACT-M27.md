# CONTRACT-M27 — Quality & Standards Enforcement (`ashlr health`)

Status: CONTRACT + SCAFFOLD. This file defines exact module boundaries,
signatures, the CLI surface, and the five HARD safety invariants every M27 agent
MUST build against. The type definitions and compiling stubs already exist
(`src/core/quality/*`, `src/cli/health.ts`, types in `src/core/types.ts`,
`qualityDir()` in `src/core/config.ts`). The Build/Integrate phase fills the
`TODO(build)` bodies and wires the dispatcher.

Ashlr v2 pillar E. `ashlr health` is a continuous portfolio-wide quality review.
For each ENROLLED repo it computes a per-repo HEALTH SCORE (weighted 0-100 +
letter grade) across dimensions (tests, docs, dependency freshness/vulns,
security findings, code-debt TODO/FIXME, issues/CI, project conventions), tracks
the score over time (trend snapshots under `~/.ashlr/quality/`), and — only on an
explicit `propose` action — emits safe-fix advisories into the M23 Approval
Inbox. It COMPOUNDS over time: each run persists a `HealthReport` snapshot the
next run diffs against for per-repo score deltas.

It REUSES (does not reinvent) the M22 read-only scanners, the M23 inbox store,
the enrollment policy gate, the M26 learn-store snapshot pattern, and the M25/M26
provider-client local-first path.

---

## Module boundaries (`src/core/quality/`)

### `conventions.ts` — read-only project-standards probes (one repo)

```ts
export function probeConventions(repo: string): ConventionFinding[];
```

- Pure FS reads (`existsSync` / `statSync`) over a FIXED, small set of top-level
  presence checks: README (presence + thinness < 300 bytes), LICENSE, lockfile
  (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` / `bun.lockb`),
  `.gitignore`, a test dir/script signal (`test`/`tests`/`__tests__`/`spec` dir
  or a package.json `"test"` script), a CI config (`.github/workflows` /
  `.gitlab-ci.yml` / etc.).
- NO writes, NO git mutations, NO installs, NO shell. NEVER mutates a repo.
- No deep tree traversal; bounded; NEVER throws (returns `[]` on error).
- Mirrors the read-only presence/size heuristics in
  `core/portfolio/scanners.ts#scanDocs`.
- Enrollment-scoping is the CALLER's job (`health.ts`); this is a pure probe.

### `health.ts` — deterministic scoring engine (NO LLM, READ-ONLY)

```ts
export function gradeFor(score: number): HealthGrade;            // A>=90,B>=80,C>=70,D>=60,else F
export async function computeHealth(repo: string): Promise<HealthScore>;
export async function computeReport(opts?: HealthOptions): Promise<HealthReport>;
```

- `computeHealth(repo)` runs all six `SCANNERS` (in parallel; each individually
  bounded + never-throws per the M22 scanner contract) plus
  `probeConventions(repo)`, buckets outputs onto the seven `HealthDimension`s
  (`issue→issuesCi`, `todo→codeDebt`, `test→tests`, `dep→deps`, `doc→docs`,
  `security→security`, convention misses → `conventions`), scores each dimension
  0..100, rolls them up via the normalized `DIMENSION_WEIGHTS` into a weighted
  overall 0..100 + `gradeFor()` grade, and records the worst offenders (top
  `MAX_WORST_OFFENDERS` WorkItems by `score`). Deterministic, NO LLM, READ-ONLY.
- `computeReport({ repos?, maxRepos? })` selects the repo set (see invariant #2),
  scores each (sequentially, mirroring `buildBacklog` to avoid a gh/npm
  thundering-herd), ranks worst-first, computes `averageScore`/`averageGrade`,
  and returns `delta: {}` (the store/CLI layer fills it from the prior snapshot).
- Reuses M22 scanner bounds; caps repos per run (`DEFAULT_MAX_REPOS = 100`).
  Makes ZERO connections beyond what the M22 scanners already do.

### `fixes.ts` — deterministic advisory safe-fixes + PROPOSAL emission

```ts
export function deriveSafeFixes(score: HealthScore): SafeFix[];
export function emitFixProposals(fixes: SafeFix[]): Proposal[];
```

- `deriveSafeFixes(score)` is a PURE function of a `HealthScore` — it walks the
  failed convention probes + worst offenders and emits deterministic advisory
  fixes (e.g. "add a LICENSE", "add `.gitignore`", "pin/upgrade vulnerable dep
  X", "add a test for Y"), deduped by `key`, sorted highest-impact first,
  bounded to `MAX_FIXES_PER_REPO = 10`. Every fix defaults to
  `proposalKind: 'note'`. NO I/O, NEVER mutates.
- `emitFixProposals(fixes)` routes each `SafeFix` to `createProposal({ repo,
  origin: 'manual', kind: 'note', title, summary })` → a PENDING proposal
  (status `'pending'`, NEVER auto-advanced/applied). Returns the created
  `Proposal[]`. Best-effort, never throws.
- MUST NOT mutate repos / write CONFIG / push / open a PR / deploy. There is NO
  apply path here.
- OPTIONAL SANDBOX-PATCH (STRETCH, documented only): a `proposalKind: 'patch'`
  fix would require generating its diff in an M21 sandbox worktree
  (`src/core/sandbox/worktree.ts` `createSandbox`/`removeSandbox`) and attaching
  it as a PENDING `'patch'` proposal with the `sandboxId` — NEVER written to the
  real tree, NEVER pushed. The DEFAULT is advisory `'note'`s.

### `store.ts` — HealthReport snapshot persistence (the ONLY writer under `~/.ashlr/quality/`)

```ts
export function reportsDir(): string;                            // ~/.ashlr/quality/reports
export function saveReport(report: HealthReport): string | null;
export function listReports(): HealthReport[];                   // most-recent first, bounded (MAX_REPORTS=200)
export function loadPreviousReport(before?: string): HealthReport | null;
```

- `reportsDir()` = `join(qualityDir(), 'reports')` where `qualityDir()` (added to
  `src/core/config.ts`) = `join(CONFIG_DIR, 'quality')`.
- `saveReport` writes one pretty-printed `HealthReport` per run to
  `reportsDir()/<generatedAt-ms>.json` via atomic tmp-write + rename (mirrors
  `core/learn/store.ts` / `core/inbox/store.ts`). Returns the path or null.
- `loadPreviousReport(before)` returns the newest snapshot strictly before
  `before` (so a just-saved current report isn't compared to itself) — the prior
  used for per-repo score deltas.
- Never throws; the ONLY filesystem destination is under `~/.ashlr/quality/`.

---

## CLI surface (`src/cli/health.ts`)

```text
ashlr health [--json] [--allow-cloud]          # score all enrolled repos, ranked worst-first
ashlr health <repo> [--json] [--allow-cloud]   # one-repo detail w/ per-dimension breakdown
ashlr health propose [<repo>] [--json]         # emit safe-fix NOTE proposals into the inbox
```

Exported entry point: `export async function cmdHealth(args: string[]): Promise<number>`
(exit codes: 0 success, 1 runtime error, 2 bad usage). Mirrors `src/cli/reflect.ts`:
a lazy `importCore()` for graceful degradation, `makeColors`/`pad`/`isTty` from
`./ui.js`, `--json` and `--allow-cloud` flags.

- `--allow-cloud` is OFF by default and ONLY affects the optional narrative
  (routed through `getActiveClient(cfg, { allowCloud })` — local unless
  `--allow-cloud` + key). Scores are ALWAYS computed locally. A privacy warning
  prints on `--allow-cloud` (mirrors reflect.ts).
- A positional `<repo>` is `resolve()`'d and checked via `isEnrolled()` AT THE
  CLI LAYER before any scan; a non-enrolled path HARD-ERRORS (exit 1).
- `propose` derives safe fixes (for the scoped repo, or all enrolled) and
  emits them as PENDING `'note'` proposals; prints `ashlr inbox` as the review path.

### Required dispatcher wiring (Integrate phase — NOT this scaffold)

`src/cli/index.ts` MUST add (matching the EXACT `loadReflectCmd` pattern):

```ts
const loadHealthCmd = lazyCmd(
  () => import('./health.js'),
  (m) => m.cmdHealth as Cmd,
  'health command requires src/cli/health.ts (M27 module not yet built).',
);
// …in the dispatch switch:
case 'health': {
  const cmdHealth = await loadHealthCmd();
  process.exitCode = await cmdHealth(rest);
  break;
}
```

…plus `cmdHelp` entries:

```text
['health',                 'Score the quality/health of all ENROLLED repos (read-only); ranked worst-first.'],
['health <repo>',          'Show one ENROLLED repo's health detail with the per-dimension breakdown.'],
['health propose',         'Emit deterministic safe-fix advisories as PENDING inbox proposals (never auto-applies).'],
```

The M25 review caught this dispatcher wiring being missed — it is a REQUIRED
integration step.

---

## HARD SAFETY INVARIANTS (verbatim) — enforcement + verification

### 1. READ-ONLY
`health` only READS enrolled repos (via the existing read-only scanners +
lightweight convention probes) and WRITES only under `~/.ashlr/quality/` (score
snapshots) and — only on an explicit propose action — the Approval Inbox via
`createProposal()`. It NEVER mutates a user repo or working tree.

- **Enforced by**: `conventions.ts` does pure `existsSync`/`statSync` reads;
  `health.ts` composes the M22 `SCANNERS` (read-only by contract) + probes and
  writes nothing; `store.ts` writes ONLY under `qualityDir()` via atomic
  tmp+rename; `fixes.ts` only calls `createProposal()` (pure persistence under
  `~/.ashlr/inbox/`). No `fs.write*`/`git`/`npm install`/spawn-with-mutation
  exists in any M27 module.
- **Verifier proves**: grep M27 modules for `writeFile`/`mkdir`/`rename` →
  destinations are exclusively `qualityDir()`/inbox store; a test runs
  `computeReport` over a tmp git repo and asserts the repo working tree
  (`git status --porcelain`, file mtimes) is byte-for-byte unchanged.

### 2. ENROLLMENT-SCOPED
Operates only over enrolled repos (default enrollment is EMPTY → health reports
nothing, no disk scan). Any user-supplied `--repo` / positional path MUST be
filtered through `isEnrolled()` (`resolve()` first) at BOTH the core and CLI
layers and HARD-ERROR on a non-enrolled path. (This is the exact gap the M25
review caught — do NOT repeat it.)

- **Enforced by**: `health.ts#computeReport` defaults to `listEnrolled()`; an
  explicit `opts.repos` entry is `resolve()`'d, checked via `isEnrolled()`, and
  THROWS `repo not enrolled for health review: <abs>` on a miss. `health.ts#cmdHealth`
  independently `resolve()`s a positional `<repo>` and calls `isEnrolled()`
  before any scan, returning exit 1 on a miss. Defense-in-depth at BOTH layers.
- **Verifier proves**: with mocked `listEnrolled() → []`, `computeReport()`
  returns an empty report and NO scanner is invoked (spy asserts zero calls); a
  test passes a non-enrolled tmp path and asserts `computeReport({ repos: [p] })`
  THROWS and `cmdHealth([p])` returns 1; a test with the path enrolled succeeds.

### 3. PROPOSAL-ONLY
Safe-fix suggestions land as PENDING Approval Inbox proposals (status `'pending'`,
NEVER auto-advanced/applied). The default proposal kind is `'note'` (advisory, no
diff). M27 does NOT apply patches and does NOT mutate working trees. IF a
deterministic fix diff is generated, it MUST be produced in an M21 sandbox
worktree (`src/core/sandbox/*`) and attached to a `'patch'` proposal as PENDING —
never written to the real tree, never pushed. There is NO code path where health
writes to a repo, pushes, opens a PR, or deploys.

- **Enforced by**: `fixes.ts#emitFixProposals` calls only `createProposal()`
  (which hard-assigns `status: 'pending'` and never advances). `SafeFix.proposalKind`
  is typed `Extract<ProposalKind,'note'|'patch'>`; default `'note'`. No
  `setStatus`/`applyProposal`/push/PR/deploy call exists in any M27 module.
- **Verifier proves**: a test runs `emitFixProposals(fixes)` against a tmp HOME
  and asserts every created proposal has `status === 'pending'`, `kind === 'note'`,
  `origin === 'manual'`; grep proves M27 imports none of `applyProposal`,
  `setStatus`, `createPr`, deploy helpers.

### 4. LOCAL-FIRST
No cloud calls. The scanners already shell out locally (`gh` for issues, `npm`
for deps with `--ignore-scripts`). Health scoring is deterministic and uses NO
LLM by default. Any optional LLM narrative must route through
`getActiveClient(cfg, { allowCloud })` — local only unless `--allow-cloud` + key
(mirror M25/M26). Default path makes ZERO non-localhost connections beyond what
the existing M22 scanners already do.

- **Enforced by**: `computeHealth`/`computeReport` import no provider client and
  call no model. The only synthesis path is the optional narrative in the CLI via
  `getActiveClient(cfg, { allowCloud: parsed.allowCloud })`, which itself refuses
  a cloud provider unless `allowCloud` + an API key are present.
- **Verifier proves**: grep M27 core for `getActiveClient`/`fetch`/`http` → only
  the CLI references `getActiveClient`, gated behind `--allow-cloud`; a test runs
  the default report path with no network and asserts success + no narrative
  (`report.narrative === undefined`).

### 5. BOUNDED
Reuse the M22 scanner bounds (timeouts, caps, `--ignore-scripts`). Cap repos/work
per run. No unbounded loops. No new runtime deps.

- **Enforced by**: M27 composes the already-bounded `SCANNERS` (15–20s timeouts,
  output/hit caps, `--ignore-scripts`). `computeReport` caps repos at
  `DEFAULT_MAX_REPOS = 100` (`opts.maxRepos`); `computeHealth` caps worst
  offenders at `MAX_WORST_OFFENDERS = 5`; `deriveSafeFixes` caps at
  `MAX_FIXES_PER_REPO = 10`; `store.listReports` caps at `MAX_REPORTS = 200`.
  Only node builtins + existing modules are imported (no new deps).
- **Verifier proves**: `package.json` diff shows no new dependency; a test feeds
  `computeReport({ repos: [...121 enrolled...], maxRepos: 100 })` and asserts at
  most 100 repos are scored; cap constants are asserted by unit tests.

---

## Types (single-sourced in `src/core/types.ts`, M27 block appended)

`HealthDimension`, `HealthGrade`, `ConventionFinding`, `HealthDimensionScore`,
`HealthScore`, `HealthReport`, `SafeFix`, `HealthOptions`. (See the file's M27
section.) `Proposal`/`ProposalKind`/`WorkItem`/`WorkSource` are REUSED unchanged
— `origin: 'manual'`, `kind: 'note'` for advisory proposals (no type-union change).

### `HealthScore` / `HealthReport` shape

```ts
interface HealthScore {
  repo: string;                       // absolute path of the enrolled repo
  score: number;                      // weighted overall 0..100
  grade: HealthGrade;                 // 'A'|'B'|'C'|'D'|'F' (A>=90,B>=80,C>=70,D>=60,else F)
  dimensions: HealthDimensionScore[]; // per-dimension breakdown (tests/docs/deps/security/codeDebt/issuesCi/conventions)
  conventions: ConventionFinding[];   // read-only convention probe results
  worstOffenders: WorkItem[];         // top findings dragging the grade down (bounded)
  ts: string;                         // ISO timestamp
}

interface HealthReport {
  generatedAt: string;                // ISO timestamp
  repos: string[];                    // absolute paths scored (enrolled only)
  scores: HealthScore[];              // ranked worst-first
  averageScore: number;               // mean 0..100 (0 when empty)
  averageGrade: HealthGrade;          // grade of averageScore
  delta: Record<string, number>;      // per-repo overall-score delta vs previous snapshot
  narrative?: string;                 // optional LLM narrative (absent on default path)
  narrativeLocal?: boolean;           // true when narrative was local-model produced
}
```

---

## Tests (Build phase)

Focused vitest tests in `test/` named `m27.*.test.ts`, using tmpdir + tmp git
repos + mocked `listEnrolled`/scanners (NEVER the real `~/.ashlr` or real
portfolio). Cover: enrollment-scoping (empty default, non-enrolled hard-error at
core + CLI), read-only (working tree unchanged), proposal-only (pending/note/
manual), local-first (no network, no narrative by default), bounded (maxRepos cap,
constants), and deterministic scoring/grade boundaries.
