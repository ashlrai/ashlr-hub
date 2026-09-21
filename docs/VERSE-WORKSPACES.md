# Workspaces, GitHub and per-account tooling — build contract

What exists, what does not, and the order to build it. Written after surveying the code, so the
"already there" column is fact rather than optimism.

## Where this stands today

| Capability | State |
|---|---|
| Pick a project for a chat | **exists** — `NewChatDialog` lists enrolled repos plus a free-text absolute path |
| More than one folder per project | **missing** — `VerseSession.projectPath` is a single string, and the adapters pass one `--cwd` |
| GitHub | **partly** — `src/core/integrations/github.ts` has PRs, issues, auto-merge; none of it is reachable from Verse |
| MCP servers | **read-only** — `src/core/mcp-registry.ts` can `discoverMcpServers()` and `redactEnv()`; nothing can add, remove or scope one |
| Per-account CLI health | **exists, unsurfaced** — the account probes already report auth state and version per account |
| Identity / tenant scoping | **exists outside the hub** — Locus (`src/core/integrations/locus.ts`) already models principal, tenant and sealed sessions, and the hub treats it as the source of truth for scope |

## 1. Multi-folder workspaces

Codex lets a project carry several directories; a session bound to one path cannot express "this
service plus the shared library it depends on", which is most real work here.

Introduce a `VerseWorkspace`: a named set of roots, one of them primary. A session binds to a
workspace rather than a path. `projectPath` stays as the primary root so every existing session
record, adapter and test keeps working — this is additive, and a migration that rewrites saved
sessions is not acceptable for chat history.

The adapters already have the seam: the Claude CLI takes repeated `--add-dir`, and Codex takes
`--cd` plus sandbox-writable roots. Grant the extra roots the same sandbox treatment as the primary,
or the agent will read files it cannot edit and produce diffs that will not apply.

Each root needs its own git identity — branch, dirty state, remote — because a turn that edits two
repos produces two diffs, and the transcript must attribute them correctly. The per-turn file
activity summary already groups by path and is the natural place to show which root each file is in.

## 2. GitHub, reachable from the app

`github.ts` already does the hard part. What is missing is surfacing it per workspace root: the
remote and default branch, open PRs and their CI state, and the issues that could seed work.

The valuable seam is the one the hub already has and Verse does not expose: an approved proposal of
kind `pr` pushes a branch and opens a real pull request. The Approvals view names the repo and the
kind; it should also show the branch it will create and the PR it will open, before the click.

Auth comes from the `gh` CLI, which is already installed and already used. Do not add a second
credential path.

## 3. MCP and CLI management, per account

This is the piece with the most leverage and the most risk, because an MCP server is arbitrary code
with the agent's privileges.

Read first: `discoverMcpServers()` already finds every configured server across the known config
paths, and `redactEnv()` already exists because those specs carry secrets. Surface which servers
each seat would load, since a server configured for one account should not silently apply to another.

Scoping matters more than convenience: a server appropriate for a personal account may be wrong for
a client's. Locus already models exactly this — principal, tenant, sealed session — so scope should
be asked of Locus rather than reinvented in the hub, and the hub should hold opaque references
rather than copies of anything sensitive. `src/core/integrations/locus.ts` already treats it as an
external authority; keep that shape.

Adding or editing a server is a privileged, outward-facing change. It belongs behind the same
mutation gate as the other control-plane writes, and it should show the full command and environment
(redacted) before it is saved — never a one-click install of something the operator has not read.

Per-account CLI health is nearly free: the probes already report auth state, plan and CLI version
per account. A version drift is worth surfacing loudly, because the Claude usage probe is pinned to
an exact CLI version and fails closed when it moves.

## Order, and why

1. **Multi-folder workspaces** — unblocks the most actual work, and every later item wants a
   workspace to hang off.
2. **GitHub surfacing** — the backend exists; this is mostly UI plus the honest pre-approval
   disclosure of what a `pr` proposal will do.
3. **MCP and CLI management** — most valuable, but it is privileged configuration, so it goes last
   and behind the mutation gate with Locus owning scope.

## Constraint worth stating up front

Adding roots multiplies what an autonomous agent can reach. Enrollment currently bounds scope per
repo; a workspace of five roots must not become a way to widen that without the operator noticing.
Every root in a workspace should be enrolled on its own merits, and the Autonomy scope panel should
show workspace membership so the blast radius is legible.
