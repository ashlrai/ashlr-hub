# Grok native generation adapter: evidence and next gate

Research date: 2026-09-08. Research only: no authentication, inference, API keys,
account reads, installation, service activation, or ACP initialization occurred.

## Recommendation

Implement a version-gated **native headless JSON** adapter after an isolated,
authorized acceptance run establishes its installed contract. ACP is unnecessary
for the first generation adapter. Target Universe's existing native read-only
scope, not a new requirement for tool-free operation or filesystem-read
confinement (see `docs/ASHLR-UNIVERSE.md`, native resource generation).

The public contract is concrete enough to design fixtures and the adapter now;
this note does not make Grok runnable or commissioned. Its launcher compatibility
result must continue to distinguish advertised flags from exercised behavior.

## Evidence identities

- Installed executable: `/Users/masonwyatt/.local/bin/grok`, symlink target
  `/Users/masonwyatt/.grok/bin/grok`.
- Help-only observation at `2026-09-08T04:23:35.623Z`:
  `grok 0.2.118 (1e1687c1cf6a)`.
- Executable SHA-256:
  `2de5b9609a03492dd6b9e4cca9637d651fe998bb8371bf9f852e7b28b38c034e`.
- `--no-auto-update --version` and `--no-auto-update --help` exited zero with
  empty stderr. A fresh temporary cwd/GROK_HOME remained empty. Only a minimal
  environment, unchanged HOME, and updater suppression were supplied.
- Official public source snapshot:
  [`72a61251fcffb464bcc687aeb5a998e5a98ec0c9`](https://github.com/xai-org/grok-build/tree/72a61251fcffb464bcc687aeb5a998e5a98ec0c9).
  Its [SOURCE_REV](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/SOURCE_REV)
  is `a549186d9d39311f2d3ee4208db62af8c65aa476`, not the installed revision.
  None of the 41 returned public SOURCE_REV history snapshots matched the
  installed prefix. Public-source behavior below is therefore not installed
  binary acceptance evidence.

## Supported headless interface

The official [headless guide](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)
documents `--prompt-file`, `--output-format json`, `--tools`,
`--disallowed-tools`, `--max-turns`, and native JSONL. A read-only tool selection
is `read_file,grep,list_dir`; shell's internal ID is `run_terminal_cmd`.
Tool allowlisting retains MCP meta-tools, so tool filtering alone does not
establish absence of MCP startup. Denylisting wins over allowlisting.

Single terminal JSON is the smallest first implementation: `text`, `stopReason`,
`sessionId`, `requestId`, optional aggregate usage. Accept only a successful
terminal result with `stopReason: end_turn`; truncation, refusal, cancellation,
nonzero exit, and missing terminal evidence are different outcomes. Native
streaming JSON can add progress later. Do not use the Claude-compatible stream
as an interchangeable accounting contract.

The [native result constructor](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/src/headless.rs#L286)
adds aggregate spend fields when present and emits `type: error` on failure.
It can also include `thought`; Hub should discard that field, not persist or
display it. Unknown future upstream stop reasons currently degrade upstream to
`end_turn`, which makes a tested version range important rather than assuming
unbounded forward compatibility.

The [Messages usage projection](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/src/headless/reducer/messages/usage.rs#L22)
zero-fills missing counters and costs and warns on incomplete usage. This would
lose Hub's unknown-versus-zero distinction; use native output instead.

Accounting must retain `usage_is_incomplete`, distinguish uncached input from
cache-read/cache-creation input, and never double-count per-response counters
with the terminal aggregate. Missing subscription cost is unavailable, not
free. Report the aggregate's documented prompt scope, not all subscription
consumption or all background model work. The headless guide explicitly excludes
compaction and other side-model calls from that aggregate.

## Isolation: what the proposed flags do and do not establish

The [settings reference](https://docs.x.ai/build/settings/reference) documents
GROK_HOME for native config/auth/sessions/plugins/logs, compatibility toggles,
`GROK_WRITE_FILE=0`, and disabling updater, memory, subagents, web fetch, and
tool search. Build a minimal allowlisted environment; never inherit API keys,
custom endpoints, billing overrides, or arbitrary provider variables.
Disable Claude/Cursor compatibility surfaces explicitly. This is an account
configuration choice, not proof that the account is logged in or subscription
capacity is available.

The [sandbox reference](https://docs.x.ai/build/features/sandbox) describes
read-only as allowing filesystem reads and limiting writes, with native home
and temporary exceptions. It is not read confinement, no-tools mode, or a
complete model/web egress boundary; macOS child network restriction is also
limited. Pair sandboxing with an explicit read-tool allowlist and denied shell,
editing, web, and subagent capabilities. Do not describe this as stricter than
Universe's existing documented native contract.

Two source details require acceptance coverage:

1. [Headless session creation](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/src/headless.rs#L530)
   initially loads MCP sources using default-on compatibility. The server-side
   [admission filter](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/session/managed_mcp.rs#L87)
   subsequently rejects disabled vendor sources before merging. That filter
   still reads vendor files for attribution. Separately,
   [MCP loading](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/util/config/mcp.rs#L260)
   includes project `.grok/config.toml` and `.mcp.json`; disabling vendor flags
   does not mean every configuration source disappears. Use a controlled run
   cwd with checked ancestor scope and no injected project configuration.
2. [Hook discovery](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/util/hooks.rs#L37)
   honors vendor hook toggles but also loads Grok-owned global/project sources
   and managed configuration layers. A dedicated checked native home plus a
   controlled cwd addresses ordinary user/project sources; effective managed
   policy must still be accounted for. Do not claim GROK_HOME bypasses policy.

An empty `--tools` value is not a no-tools switch: the
[parser](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-pager/src/headless/cli.rs#L133)
treats an empty list as absent. This is an implementation warning, **not** a
blocker requiring a zero-tools architecture.

## Minimal implementation and commissioning sequence

1. Reuse Hub's account binding, private native profile, process ownership,
   output bounds, timeout, receipt, and resource-settlement helpers. Add a
   Grok-specific argument builder and native terminal parser; do not route
   Grok through a Claude parser or invoke external ACP merely to generate text.
2. Use a private prompt text file (not a `.json` suffix, whose meaning differs),
   explicit model, dedicated GROK_HOME, controlled cwd, `--no-auto-update`,
   `--output-format json`, `--sandbox read-only`, `--permission-mode dontAsk`,
   explicit read-tool selection, `--no-memory`, `--no-plan`, `--no-subagents`,
   disabled web search, and a bounded `--max-turns`. Verify each installed flag
   and effective permission behavior before promoting its compatibility state.
   Do not put prompts on process argv or use shell command interpolation.
3. Add inert fixtures for complete/missing/incomplete usage, cache accounting,
   error-with-spend, malformed/oversized output, refusal/truncation, process
   failure after dispatch, cancellation, and duplicate terminal evidence. A
   killed process without a complete receipt remains uncertain consumption;
   do not invent zero usage or automatically retry a possibly billed request.
4. Separately authorize one bounded live acceptance after profile authentication
   and the intended billing route are established. Capture sanitized actual
   native JSON, check startup child processes/MCP/hooks, test cancellation,
   and establish the accepted binary identity or tested version range. Help
   output and the unmatched public source snapshot cannot replace this gate.
5. Only then commission its worker for routing. Measure useful evaluated output
   and reported token coverage first; do not infer daily/weekly remaining
   subscription quota or equate a plan name with API credit availability.

No ACP initialize was attempted: the public
[stdio startup](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/agent/app.rs#L230)
starts auth refresh and managed-policy initialization before serving protocol
traffic. Therefore it is not a no-contact capability probe under this research
task's restrictions. This does not prevent a deliberately authorized native
headless acceptance run later.
