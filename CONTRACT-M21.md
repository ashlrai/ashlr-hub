# CONTRACT-M21 — Git-Worktree Sandbox + Audit + Enrollment/Kill-Switch

The SAFETY FOUNDATION for the v2 Autonomous Engineering Org. Builds the primitives
M22–M30 depend on. NOTHING here runs the org. Build against these EXACT signatures;
each agent edits ONLY its file(s).

## Shared types (src/core/types.ts — DONE, do not re-edit)

```ts
interface Sandbox     { id:string; sourceRepo:string; worktreePath:string; branch:string; baseHead:string; createdAt:string }
interface SandboxDiff { sandboxId:string; files:number; insertions:number; deletions:number; patch:string }
interface AuditEntry  { ts:string; action:string; repo:string|null; sandboxId:string|null; summary:string; result:'ok'|'refused'|'error' }
interface Enrollment  { repos:string[] }
// SwarmOptions extended with optional: sandbox?:boolean   (SEAM ONLY; default OFF)
```

---

## src/core/sandbox/policy.ts — enrollment registry + kill switch (gate)

```ts
export function isEnrolled(repo:string):boolean;
export function enroll(repo:string):void;
export function unenroll(repo:string):void;
export function listEnrolled():string[];
export function killSwitchOn():boolean;
export function setKill(on:boolean):void;
export function assertMayMutate(repo:string, opts?:{allowAnyRepo?:boolean}):void; // throws if kill on OR repo not enrolled
```

Rules:
- Enrollment registry persisted in `cfg.autonomy` (loadConfig/saveConfig, ~/.ashlr) and/or
  `~/.ashlr/enrollment.json`. **DEFAULT EMPTY** — `listEnrolled()` returns `[]` until something
  is enrolled, so no real repo is mutable by default.
- `enroll(repo)` / `unenroll(repo)` normalize `repo` to an absolute path; idempotent
  (enrolling twice is a no-op, unenrolling an absent repo is a no-op).
- Kill switch backed by `~/.ashlr/KILL` (file present => on) and/or a cfg flag. `setKill(true)`
  turns it on, `setKill(false)` off. `killSwitchOn()` reflects current state.
- `assertMayMutate(repo, opts)` THROWS when: `killSwitchOn()` is true (always, regardless of
  enrollment), OR `repo` is not enrolled AND `opts.allowAnyRepo` is not true. The
  `allowAnyRepo` hatch exists ONLY so tests can operate on a tmp repo without enrollment —
  it NEVER overrides the kill switch.
- proposal-only is the default posture. No network, no push, no branch deletion of user branches.

---

## src/core/sandbox/audit.ts — append-only audit trail

```ts
export function audit(entry:Omit<AuditEntry,'ts'>):void;   // appends one JSONL line; sets ts
export function readAudit(limit?:number):AuditEntry[];      // most-recent first; limit caps count
export function auditDir():string;                          // ~/.ashlr/audit
```

Rules:
- `auditDir()` is `~/.ashlr/audit`, created lazily (mkdir recursive).
- `audit()` sets `ts` itself (caller passes `Omit<AuditEntry,'ts'>`), serializes to one line,
  APPENDS to `~/.ashlr/audit/<YYYY-MM-DD>.jsonl`. **Append-only** — never truncate, never
  rewrite, never delete a prior line. **NEVER write secrets** — `summary` is metadata only.
- `readAudit(limit)` reads across date files, parses JSONL, returns newest-first; `limit`
  caps the number returned (undefined => all). Malformed lines are skipped, never throw.
- Every sandbox-mutating op AND every refused/errored attempt MUST be audited by its caller.

---

## src/core/sandbox/worktree.ts — isolated git-worktree sandbox

```ts
export function createSandbox(sourceRepo:string, opts?:{allowAnyRepo?:boolean}):Sandbox;
export function sandboxDiff(sb:Sandbox):SandboxDiff;
export function removeSandbox(sb:Sandbox):void;
export function sandboxesDir():string;
export function listSandboxes():Sandbox[];
```

Rules:
- `sandboxesDir()` is `~/.ashlr/sandboxes`, created lazily. Sandboxes live ONLY here.
- `createSandbox(sourceRepo, opts)`:
  - FIRST call `assertMayMutate(sourceRepo, opts)` — refuses (throws + audits `result:'refused'`)
    if the kill switch is on OR the repo is not enrolled and `opts.allowAnyRepo` is not set.
    The `allowAnyRepo` hatch is the internal TEST seam (tmp repo, no enrollment).
  - Verify `sourceRepo` is a git repo (reuse core/git.ts `isRepo`).
  - Read the source HEAD commit (`baseHead`) WITHOUT mutating it.
  - Generate a unique `id`; create a NEW scratch branch (e.g. `ashlr/sandbox/<id>`) and add an
    isolated worktree under `~/.ashlr/sandboxes/<id>/` via `git worktree add -b <branch>
    <path> <baseHead>` run in `sourceRepo`. This MUST NOT modify the source working tree,
    index, HEAD, or any user branch.
  - Persist sandbox metadata (so `listSandboxes()` can recover it) and audit `result:'ok'`.
  - Return the `Sandbox`.
- `sandboxDiff(sb)`: run `git diff` of the worktree vs `sb.baseHead` INSIDE `sb.worktreePath`
  (capture file/insertion/deletion counts via `--numstat` or `--shortstat` plus the unified
  patch). Read-only; never mutates. Returns `SandboxDiff`.
- `removeSandbox(sb)`: `git worktree remove <path> --force` then delete the scratch branch
  (`git branch -D <branch>`), both run against `sourceRepo`; then clean up persisted metadata.
  MUST NOT touch the source working tree/index/HEAD/user branches. Audit `result:'ok'`.
  Tolerate an already-removed worktree (idempotent cleanup), never throw on a missing dir.
- `listSandboxes()`: enumerate persisted sandbox metadata under `sandboxesDir()`; returns `[]`
  when none. Never throws on a malformed/partial entry (skip it).

### ISOLATION + DESTRUCTIVE-SAFETY (the whole point)
- Sandbox worktrees live ONLY under `~/.ashlr/sandboxes/`. Creating/removing them MUST NOT
  modify the source repo's working tree, index, HEAD, or the user's branches.
- Use `git worktree add` on a NEW scratch branch off the current HEAD; `git worktree remove`
  + scratch-branch delete on cleanup.
- NEVER `git reset --hard` / `git checkout` in the source repo. NEVER push. NEVER delete user
  branches. NEVER touch a repo that is not ENROLLED (except via the explicit `allowAnyRepo`
  test hatch on a tmp repo in tests).
- Kill switch on => refuse all sandbox-mutating ops. Enrollment default empty => no real repo
  touchable. Audit is append-only; no secrets in audit entries.
- All git invoked via `node:child_process` arg ARRAYS (execFile, no shell) — no shell injection.

---

## src/cli/sandbox.ts — CLI surface

```ts
export async function cmdSandbox(args:string[]):Promise<number>; // list | diff <id> | cleanup <id>
export async function cmdAudit(args:string[]):Promise<number>;   // tail of the audit trail (optional limit)
export async function cmdEnroll(args:string[]):Promise<number>;  // list | add <repo> | remove <repo> | kill on|off
```

Rules:
- `cmdSandbox`: `list` prints `listSandboxes()`; `diff <id>` prints `sandboxDiff(sb)`;
  `cleanup <id>` calls `removeSandbox(sb)`. Returns 0 on success, non-zero on bad args/not-found.
- `cmdAudit`: prints `readAudit(limit?)` newest-first (default limit applied). Returns 0.
- `cmdEnroll`: `list` => `listEnrolled()`; `add <repo>` => `enroll(repo)`; `remove <repo>` =>
  `unenroll(repo)`; `kill on|off` => `setKill(true|false)`. Reuse `cli/ui.ts` for output.
  Returns 0 on success, non-zero on bad args.
- Wire all three into the CLI dispatcher (cli/index.ts) under `sandbox`, `audit`, `enroll`.

---

## GUARDRAILS (apply to ALL agents)
- Preserve all existing behavior + 2110 tests. Reuse modules (core/git.ts isRepo/exec helpers,
  core/config.ts loadConfig/saveConfig ~/.ashlr, core/swarm/runner.ts, cli/ui.ts). No new
  runtime deps. `node:child_process` (execFile, arg arrays, no shell) + `node:fs` builtins.
- Swarm `sandbox` option is a SEAM only — default OFF; swarm behaves exactly as today until
  M24 wires it.
- TEST ONLY on TEMP git repos (os.tmpdir) — NEVER the real 69-repo portfolio. Prove the source
  tree is byte-untouched after create/diff/remove.
- No git commit of ashlr-hub by build agents.
