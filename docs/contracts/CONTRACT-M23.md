# CONTRACT-M23 — The Approval Inbox (the single outward gate)

M23 adds the **approval inbox**: the single human control plane through which
EVERY proposed outward action must pass. The autonomous org (M24+) creates
PROPOSALS here; nothing outward (PR, merge, deploy, patch-applied-to-a-real-
branch) happens until Mason explicitly approves via `ashlr inbox approve`.

Build against THIS contract. Each agent edits ONLY its file(s). Do not change
the signatures below. No new runtime deps. No git commit. Preserve all existing
behavior + 2266 tests.

---

## Types (DONE — `src/core/types.ts`, do not redefine)

Already added to `src/core/types.ts` (consume via `import type … from './types.js'`):

```ts
export type ProposalKind = 'patch' | 'pr' | 'deploy' | 'note';

export type ProposalStatus =
  | 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';

export interface Proposal {
  id: string;
  repo: string | null;
  origin: 'backlog' | 'swarm' | 'manual';
  kind: ProposalKind;
  title: string;
  summary: string;
  diff?: string;
  sandboxId?: string;
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
  result?: string;
}

export interface ApplyResult {
  ok: boolean;
  status: ProposalStatus;
  detail: string;
}
```

Also added to `DashboardSnapshot`:

```ts
  /** M23: number of proposals awaiting Mason's approval in the inbox gate. */
  inbox: { pending: number };
```

---

## `src/core/inbox/store.ts` — proposal store (NEW FILE)

Persists proposals at `~/.ashlr/inbox/<id>.json` (one file per proposal).
Pure persistence: NEVER applies anything, NEVER mutates a repo, NEVER advances
status on its own. No secrets in any persisted field. Mirror the atomic-write +
`mkdirSync(dir,{recursive:true})` + JSON pattern in `core/portfolio/backlog.ts`.

```ts
export function inboxDir(): string;
// Absolute path to ~/.ashlr/inbox (under the ashlr home dir). Created lazily.

export function createProposal(
  p: Omit<Proposal, 'id' | 'status' | 'createdAt'>,
): Proposal;
// Assigns a fresh unique id + createdAt=now(ISO) + status='pending', persists
// to ~/.ashlr/inbox/<id>.json, returns the stored Proposal. NEVER applies.

export function listProposals(filter?: { status?: ProposalStatus }): Proposal[];
// All persisted proposals (most-recent first by createdAt). Optional status
// filter. Read-only. Never throws — unreadable/corrupt files are skipped.

export function loadProposal(id: string): Proposal | null;
// The proposal by id, or null if absent/unreadable. Read-only.

export function setStatus(id: string, status: ProposalStatus, result?: string): void;
// Persist a new status (and optional result detail) for an existing proposal.
// Sets decidedAt=now(ISO) when moving to 'approved' or 'rejected'. Persistence
// only — does NOT apply anything. No-op if the proposal does not exist.

export function pendingCount(): number;
// Count of proposals with status==='pending'. Read-only. Never throws (0 on error).
```

---

## `src/core/inbox/apply.ts` — the ONLY outward path (NEW FILE)

`applyProposal` is the single funnel for every outward mutation in v2.

```ts
export async function applyProposal(
  id: string,
  opts: { confirmed: boolean },
): Promise<ApplyResult>;
```

**REFUSE (return `{ ok:false, status:<unchanged>, detail }`, mutate nothing) unless ALL hold:**
1. the proposal EXISTS (`loadProposal(id) !== null`);
2. its `status === 'approved'`; AND
3. `opts.confirmed === true`.

A `pending`/`rejected`/`applied`/`failed` proposal is NEVER applied. There is no
auto-apply anywhere — not on create, not on list/show, not by the daemon.

**Enrollment + kill switch:** before any mutation call `assertMayMutate(repo)`
(`core/sandbox/policy.ts`). Honor the kill switch / `isEnrolled`. A non-enrolled
or repo===null mutating kind refuses (note is exempt — it never mutates).

**By kind (only after the gate + enrollment pass):**
- `'patch'` — apply `proposal.diff` to a **NEW branch** in the target repo
  (`BRANCH_PREFIX` from `core/sandbox/*`): create the branch off current HEAD,
  apply the diff, commit on that branch. NEVER touch the user's current branch,
  index, or working tree. NEVER `--force`. NEVER push. Local only.
- `'pr'` — create a branch + commit, then the **explicit gated** `createPr`
  (M18, `core/integrations/github.ts`). PR creation stays EXPLICIT/gated.
- `'deploy'` — the **gated ship/deploy** path (the existing M17/M18 ship gate).
  No deploy outside that gate.
- `'note'` — no-op record. Mutates nothing.

**Always:** audit the attempt (`core/sandbox/audit.ts`), bound the work, then
`setStatus(id, 'applied', detail)` on success or `setStatus(id, 'failed', detail)`
on error. Never throws — failures are returned as `{ ok:false, status:'failed', detail }`.
No secrets in proposals/audit.

---

## `src/cli/inbox.ts` — CLI (NEW FILE)

```ts
export async function cmdInbox(args: string[]): Promise<number>;
// Returns a process exit code (0 ok, non-zero on error). Mirror cmdBacklog.
```

Subcommands (first positional arg):
- `ashlr inbox` (no subcmd) — list PENDING proposals + counts (pending/approved/
  rejected/applied/failed). Read-only.
- `inbox show <id>` — full detail of one proposal incl. the diff. Read-only.
- `inbox approve <id> [--yes]` — confirm-gate (prompt unless `--yes`), then
  `setStatus(id,'approved')` and call `applyProposal(id,{confirmed:true})`.
  This is the ONLY place apply is triggered. Print the ApplyResult detail.
- `inbox reject <id>` — `setStatus(id,'rejected')`; discard. Applies nothing.

Wire `cmdInbox` into the CLI dispatcher (`src/cli/index.ts` / `args.ts`) like the
existing `backlog` command. Use `cli/ui.ts` for output + the existing confirm prompt.

---

## Surfaces — populate the new `inbox.pending` field

- **Dashboard** (`src/core/dashboard.ts`, `buildSnapshot`): set
  `inbox: { pending: pendingCount() }` on the returned `DashboardSnapshot`.
  Degrade to `{ pending: 0 }` on any error (snapshot NEVER throws).
- **TUI** (`src/tui/*`): add an **Inbox** tab to `TuiTab` and render pending
  proposals (read-only; approval is done via CLI/Raycast, not in the TUI).
- **Web** (`src/core/web/api.ts` + dashboard): add an **Inbox** section/route
  exposing pending proposals (read) and the pending count. Approve via CLI.
- Pending count is daily-digest-ready (surfaced wherever the snapshot is digested).

---

## Guardrails (the gate's integrity is paramount)

- PENDING NEVER AUTO-APPLIES. `applyProposal` runs ONLY when `status==='approved'`
  AND triggered by the explicit `inbox approve` (confirm/`--yes`) — never on
  create, never on list/show, never by the daemon. The ONLY outward mutation in
  v2 funnels through `applyProposal`.
- apply respects enrollment (`assertMayMutate`) + kill switch; `'patch'` applies
  on a NEW branch (never the user's working tree/current branch), NEVER force,
  NEVER push; `'pr'` uses the explicit M18 gated `createPr`; `'deploy'` uses the
  gated ship path. No force-push, no deletion of user branches.
- During BUILD/INTEGRATE/VERIFY: NEVER create a real PR / push / deploy. Test
  `'patch'` apply against a TMP repo (local branch only); test `'pr'`/`'deploy'`
  as command-construction / dry-run (mock `gh`/ship). Real outward stays Mason's gate.
- No secrets in proposals/inbox/audit. Reuse existing modules; no new runtime
  deps; no git commit. Preserve all existing behavior + 2266 tests.

RULES: build against this contract; each agent edits ONLY its file(s).
