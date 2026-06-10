# CONTRACT — M17: Verified + Unattended-Safe Swarms

Build against this contract. Each agent edits ONLY its own file(s). All new
types live in `src/core/types.ts` (already added; do NOT redefine). No new
runtime deps — `node:crypto` is a builtin and is allowed. Preserve all existing
behavior and the 1619 tests. No git commit of ashlr-hub.

---

## Types (already in `src/core/types.ts` — import, do not redefine)

```ts
export interface OutputSignature {
  alg: 'hmac-sha256' | 'phantom';
  hash: string;    // content digest (hex), no secrets
  sig: string;     // keyed signature (hex), no secrets
  signer: string;  // opaque identity, no secrets
  ts: string;      // ISO
}

export type EscalationReasonKind =
  | 'verify-failed' | 'over-budget' | 'tamper' | 'risk' | 'low-confidence';

export interface EscalationEvent {
  taskId: string | null;   // null = swarm-level
  kind: EscalationReasonKind;
  detail: string;          // no secrets
  ts: string;              // ISO
}

export interface RollbackSnapshot {
  project: string | null;
  isRepo: boolean;
  head: string | null;     // HEAD sha, null if not repo/unresolved
  dirty: boolean;
  stashRef: string | null; // stash ref/name holding dirty tree, null if clean
  ts: string;              // ISO
}

// SwarmTaskRun extended (optional):
//   signature?: OutputSignature
// SwarmRun extended (optional, + status union):
//   status: ... | 'needs-approval'
//   escalations?: EscalationEvent[]
//   rollback?: RollbackSnapshot
```

---

## `src/core/swarm/sign.ts`

```ts
export function signOutput(content: string, cfg: AshlrConfig): OutputSignature;
export function verifyOutput(content: string, sig: OutputSignature, cfg: AshlrConfig): boolean;
export function ensureLocalKey(): string; // returns key file path; creates 0600 if missing
```

Rules:
- `signOutput`: compute `hash` = content digest (sha256 hex) and `sig` =
  HMAC-SHA256(content) keyed by the signing key. Key source: phantom if enabled
  (best-effort; `alg: 'phantom'`, `signer` = phantom key id), else the local key
  (`alg: 'hmac-sha256'`, `signer: 'local'`). `ts` = ISO now. Output contains
  ONLY hashes — never the key or any payload secret.
- `verifyOutput`: recompute over `content` with the key implied by `sig.alg` and
  compare in constant time (`crypto.timingSafeEqual`). Returns `false` (never
  throws) on any mismatch, missing key, or malformed signature.
- `ensureLocalKey`: returns the path `~/.ashlr/keys/swarm.key`. If missing,
  generate with `crypto.randomBytes` and write mode `0600` (dir `~/.ashlr/keys`
  created `0700`). The key is NEVER logged, printed, or committed.

---

## `src/core/swarm/gate.ts`

```ts
export function riskScan(text: string): { risky: boolean; reason: string };
export function shouldEscalate(ctx: {
  verifyFailed?: boolean;
  overBudget?: boolean;
  tamper?: boolean;
  risk?: boolean;
  lowConfidence?: boolean;
}): EscalationReasonKind | null;
```

Rules:
- `riskScan`: heuristic match for destructive/outward ops in a task goal/result
  — `rm -rf`, `git push --force` / `--force-with-lease`, `deploy`, SQL `DROP`,
  and secret/credential exfiltration patterns. Returns `{ risky: true, reason }`
  with a short human reason on first hit, else `{ risky: false, reason: '' }`.
  Case-insensitive; never throws.
- `shouldEscalate`: returns the FIRST applicable `EscalationReasonKind` (priority
  order: `tamper` → `verify-failed` → `over-budget` → `risk` → `low-confidence`)
  or `null` when no condition is set. PURE — no side effects. It only decides;
  the caller is responsible for persisting the `EscalationEvent`, setting status
  `'needs-approval'`, and STOPPING. Never auto-approves.

---

## `src/core/swarm/rollback.ts`

```ts
export function snapshotProject(project: string | null): RollbackSnapshot;
export async function rollbackTo(
  snap: RollbackSnapshot,
  opts: { force: boolean },
): Promise<{ ok: boolean; detail: string }>;
```

Rules:
- `snapshotProject`: READ-ONLY, NEVER throws. If `project` is null or not a git
  repo → `{ project, isRepo: false, head: null, dirty: false, stashRef: null, ts }`.
  Else record `head` (HEAD sha), `dirty` (porcelain non-empty). If dirty, create
  a stash/ref capturing the dirty tree (e.g. `git stash create` + a named ref so
  it is not lost) and record `stashRef`; if clean, `stashRef: null`. Degrades to
  the non-repo shape on any failure — must never throw.
- `rollbackTo`: GIT-BASED restore, CONFIRM-gated BY THE CALLER (this function
  assumes confirmation already happened). Refuses (returns `{ ok: false, detail }`,
  never throws) when: not a repo, or the tree is dirty and `opts.force` is false
  (would discard uncommitted work). Otherwise restores `snap.head` (and the
  stashed tree when present). Prints/returns exactly what it restored. NEVER runs
  `git push --force`, NEVER deletes branches, NEVER force-resets without
  `opts.force`.

---

## `src/cli/swarm.ts` — add subcommands

- `ashlr swarm verify <id>` — load the swarm; for every task with a `signature`,
  call `verifyOutput(task.result, task.signature, cfg)`. Print per-task PASS/FAIL.
  Exit 0 if all valid, 1 if any signature fails or swarm not found.
- `ashlr swarm approve <id>` — EXPLICIT human action. Only valid when the swarm is
  `'needs-approval'`. Clears the gate and resumes the swarm. No auto-approval path
  exists anywhere else. Exit 0 on resume, 1 if not found / not awaiting approval.
- `ashlr swarm rollback <id> [--yes] [--force]` — load `swarm.rollback`. Print
  exactly what will be restored (HEAD sha, whether a stash is reapplied), then
  CONFIRM: refuse unless `--yes` (or interactive yes). Refuses on non-repo or
  dirty-without-`--force`. Calls `rollbackTo(snap, { force })`. NEVER automatic.
  Exit 0 on success, 1 on refusal/failure/not-found, 2 on bad usage.

---

## Guardrails (top priority — rollback can be destructive)

- ROLLBACK is the ONLY potentially-destructive op. It MUST require explicit
  `ashlr swarm rollback <id>` + a confirm prompt (or `--yes`), NEVER runs
  automatically, NEVER force-resets without `--force`, refuses on non-git /
  detached / ambiguous state, and prints exactly what it will restore first.
  No `git push --force`, no deleting branches.
- Signing/keys: local key via `crypto.randomBytes`, stored `0600` under
  `~/.ashlr/keys`, NEVER logged/printed/committed. The phantom path never exposes
  secret values. Signatures contain only hashes — no payload secrets.
- Escalation gates PAUSE (status `'needs-approval'`) — they never auto-approve.
  Approval is the separate explicit `approve` command. Only escalate (never
  auto-proceed) on: downstream verify failure, over-budget, low-confidence/failed
  verifyTask on a critical task, or a risk heuristic hit.
- Recursion guard (`ASHLR_IN_SWARM`) + hard budget remain intact.
- Reuse existing modules (`core/git.ts`, `core/run/verify.ts`, `core/phantom.ts`,
  `core/swarm/{runner,store,planner}.ts`). No new runtime deps. No git commit.
- RULE: build against this contract; each agent edits ONLY its file(s).
```
