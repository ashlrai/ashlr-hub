# CONTRACT-M66–M69 — the unifying-harness batch

ashlr-hub leverages the ecosystem tools as first-class capabilities. One branch,
verified locally (clean-HOME full suite), pushed once. Read-only/advisory + never
-throws + graceful-degrade throughout; flag-off/tool-absent ⇒ today's behavior.

## M66 — Unified MCP surface (`mcp-registry.ts`, `cli/mcp.ts`)
- `knownConfigPaths()` += `~/.ashlr/settings.json`, so any server registered there
  is auto-aggregated by the gateway alongside the 11 native `ashlr_*` tools.
- `ashlr mcp ecosystem [--write]` detects installed ecosystem MCP servers
  (phantom-mcp `phantom mcp serve`; stack/ashlr-md/ashlr-plugin when present) and
  merges them into `~/.ashlr/settings.json mcpServers` (idempotent, no clobber).
  ⇒ an agent pointed at the hub gateway gets EVERY tool through one endpoint.
- Test: `m66.mcp-ecosystem` (15).

## M67 — binshield first-class (`web/control.ts`, `app.js`, `styles.css`)
- `ControlSnapshot.security = { available, findings[], counts{critical,high,
  medium,low} }` sourced from the cached backlog's `source==='security'` items
  (binshield convention `tags=['security','binshield',<sev>]`) — fast, read-only,
  never re-scans live. Mission Control renders a severity-colored Security panel.
- Test: `m67.security-panel` (12).

## M68 — ashlr-md rendering (`integrations/markdown.ts`)
- `ashlrMdInstalled` / `openInAshlrMd` (`mdopen <file>`, detached) /
  `renderToTempMarkdown` (unique temp name) / `presentMarkdown` — the seam for
  `ashlr inbox`/`digest` to show proposals/digests in the beautiful viewer;
  degrades to terminal when ashlr-md is absent.
- Test: `m68.markdown` (18).

## M69 — stack provisioning detection (`integrations/stack.ts`)
- `stackInstalled` / `stackStatus` (`stack status --json`, best-effort) /
  `stackProjectConfigured` (`.stack.toml`). READ-ONLY/advisory — detects + reports
  wired services; never auto-provisions. (Onboard-flow wiring: deferred follow-up.)
- Test: `m69.stack` (3).

## Verification
Typecheck + `eslint .` (0 errors) clean; the 4 suites green (48); clean-HOME full
suite is the CI-equivalent. 0 new runtime deps. Each integration is opt-in and
degrades gracefully when its tool isn't installed.

## Non-goals
Auto-provisioning (stack apply) · live multi-repo binshield scans on /api/control ·
launching GUI apps in tests · the phantom network-proxy for in-process fetch (M65
covers vault key reveal).
