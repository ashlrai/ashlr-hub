# CONTRACT-M31 — Agent-Native Surface: native MCP tools + orient

**Pillar:** Ashlr v2.2 — make ashlr's intelligence first-class INSIDE agent
sessions. CLI-first: the `ashlr` CLI is the PRIMARY agent contract (stable
`--json` shapes, exit-code discipline, `ashlr orient`, `ashlr docs --agent`);
the MCP gateway is the SECOND transport over the SAME capabilities.

**Mason's hard rule:** new surfaces NEVER weaken the v2 safety posture.
Read-only intelligence flows freely; writes are append-only (genome hub) or
proposal-only (inbox, `pending`, human-gated). There is NO agent-reachable
approve/reject/apply path, ever.

---

## 1. Native tool registry (`src/core/mcp-native.ts`)

SDK-free module (plain objects; `@modelcontextprotocol/sdk` stays confined to
`mcp-gateway.ts`/`mcp-registry.ts` per the existing file-header invariant).

```ts
export type NativeToolSafety = 'read' | 'append' | 'proposal';
export interface NativeToolDef {
  name: string;                 // ashlr_<verb> — single underscore, reserved prefix
  description: string;
  inputSchema: object;          // JSON Schema (object type, named properties)
  safety: NativeToolSafety;
}
export function listNativeTools(): { name; description; inputSchema }[];
export function isNativeTool(name: string): boolean;
export function callNativeTool(name: string, args: unknown):
  Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
```

`callNativeTool` pipeline (every call, no exceptions):

1. validate args against the tool's schema (lightweight, zero-dep);
2. safety gate — `append` and `proposal` tools REFUSE when `killSwitchOn()`
   (`src/core/sandbox/policy.ts`); `read` tools answer even with KILL present;
3. run the handler (each handler is try/caught — `callNativeTool` NEVER throws;
   failures return `isError: true` content);
4. serialize → `scrubSecrets()` (`src/core/knowledge/index.ts`) → 32 KB cap
   (head+tail truncation, marked);
5. `audit({ action: 'mcp:native-call', summary: '<tool> keys=<argKeys>', result })`
   — argument KEYS only, never values (mirrors `redactArgs` in `src/cli/mcp.ts`).

### The three safety classes

| Class | Gate | Tools |
|---|---|---|
| `read` | none (read-only of local stores) | `ashlr_orient`, `ashlr_ask`, `ashlr_recall`, `ashlr_backlog`, `ashlr_health`, `ashlr_status`, `ashlr_impact`, `ashlr_pulse`, `ashlr_inbox_list` |
| `append` | kill switch | `ashlr_learn` (genome hub, `hubOnly` FORCED true) |
| `proposal` | kill switch | `ashlr_inbox_propose` (creates `pending` Proposal, origin `'agent'`; `'deploy'` kind EXCLUDED) |

## 2. The 11 tools

| Tool | Params | Delegates to |
|---|---|---|
| `ashlr_orient` | `{ repo? }` | `buildOrientation()` (`src/core/orient.ts`, new) |
| `ashlr_ask` | `{ question!, repo? }` | `ask(q, { repo, allowCloud: false })` — **allowCloud hardcoded false** |
| `ashlr_recall` | `{ query!, limit? 1–20 }` | `recall(query, cfg, { limit })` |
| `ashlr_learn` | `{ text!, title?, project?, tags? }` | `selectGenomeSync(cfg).appendHubEntry({ …, hubOnly: true })` |
| `ashlr_backlog` | `{ repo?, limit? }` | `selectBacklogSource(cfg).loadBacklog()` — persisted only, NEVER scans |
| `ashlr_health` | `{ repo? }` | `computeHealth(repo)` (enrollment-guarded by core) else `loadPreviousReport()` |
| `ashlr_status` | `{}` | `buildSnapshot(cfg)` reduced to metadata |
| `ashlr_impact` | `{ target! }` | `impact(target)` |
| `ashlr_pulse` | `{ window? '1d'\|'7d'\|'30d' }` | `buildRollup(window, cfg)` |
| `ashlr_inbox_list` | `{ status? }` | `selectInboxStore(cfg).listProposals(filter)` — diff capped |
| `ashlr_inbox_propose` | `{ kind! patch\|pr\|note, title!, summary!, repo?, diff? }` | `selectInboxStore(cfg).createProposal({ origin: 'agent', … })` |

## 3. Gateway threading (`src/core/mcp-gateway.ts`)

- `tools/list`: native tools PREPENDED to the aggregated downstream list.
- `tools/call`: `isNativeTool(name)` routes to `callNativeTool` BEFORE the
  downstream route map.
- Reserved-name guard: a downstream-namespaced key colliding with a native name
  is skipped with a stderr WARN (native wins). Structural protection: native
  names use `_`, downstream keys always contain `__`.
- Ready banner reports `N downstream + M native tool(s)`.

## 4. CLI-first surface

- `ashlr orient [--repo <r>] [--json]` (`src/cli/orient.ts`, new) — composite
  session-start context: genome hits + health + backlog + pending proposals +
  dirty/stale summary. Read-only; every section best-effort; never throws.
- `ashlr docs --agent [--json]` — llms.txt-style cheat sheet of the
  agent-relevant commands: purpose, `--json` shape name, exit codes, safety
  class. Generated from the same registry data; no drift.
- `ashlr wire --claude-md` — print a ready-to-paste CLAUDE.md snippet teaching
  agents the CLI-first usage (`ashlr orient` at session start, `ashlr ask`,
  `ashlr learn` for learnings, `ashlr inbox` is human-only).
- `ashlr completions zsh|bash` (`src/cli/completions.ts`, new) — static
  completion scripts from the command table.
- Unknown command → "did you mean" suggestion (edit distance over the table).
- `ashlr mcp list` shows a "native (built-in)" section; `mcp doctor` reports
  the native tool count.
- Web API parity (read-only ONLY): `GET /api/orient`, `/api/health`,
  `/api/backlog`, `/api/impact` in `src/core/web/api.ts`. NO mutation routes.

## 5. HARD SAFETY INVARIANTS + verification

1. **No approval path.** No native tool name matches `/approve|reject|apply/`;
   `ashlr_inbox_propose` creates `status: 'pending'` only; approval remains
   `ashlr inbox` (human CLI).
   → `test/m31.safety.test.ts` asserts the name regex over the registry AND
   that a created proposal is pending and its repo untouched.
2. **Kill switch gates all writes.** With `~/.ashlr/KILL` present,
   `ashlr_learn` / `ashlr_inbox_propose` return refused (audited `refused`);
   reads still answer. → m31.safety.
3. **allowCloud unreachable.** `ashlr_ask` hardcodes `allowCloud: false`; no
   native tool accepts a cloud flag. → m31.safety (schema sweep + handler test).
4. **Append-only learning.** `ashlr_learn` grows `hub.jsonl` by exactly one
   line; `hubOnly` is forced — no file ever lands in a repo working tree.
   → m31.safety.
5. **No secrets out.** Seeded secret-shaped tokens are `[REDACTED]` in tool
   output AND in the audit line (scrub parity). → m31.safety.
6. **Every call audited.** ok / refused / error each append one
   `mcp:native-call` entry (arg keys only). → m31.safety.
7. **Output bounded.** 32 KB cap with visible truncation marker. → m31.native-tools.
8. **SDK confinement.** `mcp-native.ts` and `orient.ts` import nothing from
   `@modelcontextprotocol/sdk`. → grep-prove in m31.native-tools.
9. **Non-regression.** `Proposal['origin']` gains `'agent'` (additive);
   full existing suite stays green; gateway behavior with zero native calls
   is unchanged for downstream routing.

## 6. Deliverables checklist

- [x] `src/core/mcp-native.ts` — registry + pipeline.
- [x] `src/core/orient.ts` — `buildOrientation()`.
- [x] `src/core/types.ts` — `OrientResult`, `NativeToolSafety`, `NativeToolDef`,
      `Proposal.origin += 'agent'`.
- [x] `src/core/mcp-gateway.ts` — native threading + reserved-name guard.
- [x] `src/cli/orient.ts`, `src/cli/completions.ts`, `src/cli/help.ts`
      (docs --agent), `src/cli/index.ts` wiring (orient/docs/completions cases,
      did-you-mean), `src/cli/mcp.ts` native section, `src/cli/wire.ts`
      `--claude-md`.
- [x] `src/core/web/api.ts` — read-only orient/health/backlog/impact routes.
- [x] Tests: `test/m31.native-tools.test.ts`, `test/m31.orient.test.ts`,
      `test/m31.safety.test.ts`, `test/m31.gateway-native.test.ts`,
      `test/m31.api.test.ts`, `test/m31.cli-agent.test.ts`.
- [x] Docs: README agent-native section, CHANGELOG M31 entry.
