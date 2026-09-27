# Verse integrated browser

A browser inside Verse that you and a chat's agents share. You browse in it;
with your say-so, the chat's agents can look at your local apps through it:
open a page, take a screenshot, read the page text, and read its console and
failed requests.

- **Pane:** `src/web-ui/routes/verse/browser/` (`BrowserPanel.tsx`, registered
  with the workbench pane registry through `register.ts`).
- **Sidecar:** `src/core/verse/browser-{types,bridge,mcp,api}.ts` under
  `/api/verse/browser/*`.
- **Desktop shell:** `desktop/src-tauri/src/browser_pane.rs` and
  `browser_tap.js`. The protocol is in `desktop/README.md` §7.

## What you get

| | Desktop app (new shell) | Web UI, or an older desktop shell |
|---|---|---|
| Engine | A native webview per tab, drawn over the pane | `<iframe>` |
| Sites | Any site | Loopback dev servers (`http://localhost:*`, `http://127.0.0.1:*`). Anything else gets **Open in your browser** |
| Address bar, back/forward/reload, tabs (up to 8) | Yes | Yes. Back/forward only walk addresses opened in the pane |
| Device sizes (fill / 1280 / 820 / 390) and zoom | Yes | Yes |
| Screenshot | macOS | No: a page cannot capture another origin's frame |
| Console, uncaught errors, failed requests | Yes | No: a cross-origin frame cannot be read |
| Element picker (selector + HTML snippet) | Yes | No |
| Send to chat | Page + console + screenshot + picked element | Page, plus a note on what could not be captured |
| Dev servers found for the chat's folders | Yes | Yes |

The web UI feature-detects the shell with `window.__ASHLR_DESKTOP__.browser`.
When it is missing, the pane uses the `<iframe>` column above. You don't
need to change any setting.

**Send to chat** puts the capture in the chat's message box and never sends
it. A screenshot is uploaded as a normal chat attachment (up to 8 MB) and
referenced by its `@path`. Logs and picked HTML go in fenced blocks.

### Shipping the native part

The native webview, screenshots, console capture and picker live in the Rust
shell. A web-only ship doesn't update them. To ship them, run:

```
npm run ship:local -- --native
```

Until then, the pane works in its `<iframe>` mode.

## Agents

Agent access is **off** for every chat. To turn it on, use the switch at the
bottom of the pane: **Agents in this chat can use this browser**. The switch
needs the mutation token.

When access is on, the chat's **Claude and local seats** get five tools from
their next turn. They reach the tools through one MCP server,
`ashlr-browser`, which Verse serves on loopback:

| Tool | Does |
|---|---|
| `browser_status` | What the active tab shows, what this shell can capture, and the chat's dev servers |
| `browser_navigate` | Opens a URL in the active tab and waits for it to load |
| `browser_screenshot` | Returns an image of the active tab |
| `browser_read_text` | Returns the page's visible text, framed as untrusted content |
| `browser_console` | Returns recent console messages, uncaught errors and failed requests |

Codex and Grok seats don't load these tools yet.

### How a call travels

```
seat ──MCP──▶ /api/verse/browser/mcp/<grant> ──queue──▶ the pane open on that chat
                                                          (long-poll /commands)
seat ◀──────────── answer ◀── /result ◀───────────────── runs it in the pane you see
```

The sidecar never browses. The pane you have open on that chat carries out
every command, so an agent only sees the browser you are looking at. If no
pane is open, the tool fails at once and tells the agent to ask you.

## Safety posture

It follows the same rules as Claude's own in-app browser.

- **Read-mostly by construction.** There is no click, type, fill, submit,
  script, cookie or storage tool. An agent can't submit a form, enter a
  credential or act as you on a site. `navigate` is the only command that
  changes what the pane shows. The desktop shell runs only fixed scripts in a
  tab, and the injected tap never reads form-field values.
- **Localhost by default.** An agent may open and look at loopback pages
  (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`), meaning your own dev
  servers. It cannot open Verse itself on any spelling of its port.
- **External sites need your explicit allow, per chat.** When an agent asks
  for another origin, the request is refused and appears in the pane as
  **Agent asked for https://… → Allow for this chat**. If you are already on
  such a page, the pane offers **Allow** for it. Allowed origins are
  per-origin and per-chat, and they are forgotten when Verse restarts.
- **The gate runs twice.** The sidecar checks a URL before queueing a
  navigation. The pane checks the active tab before capturing anything. The
  sidecar checks the URL of every capture again. A page you are browsing
  outside the allowed set is never screenshotted, read or even named to the
  agent.
- **Grants.** Turning access on mints a random 32-byte grant for that chat. It
  exists only in memory and reaches only the chat's next Claude launch, in
  `--mcp-config`, with the tools pre-approved through
  `--allowedTools=mcp__ashlr-browser`. The page never sees it. Turning access
  off, or restarting Verse, revokes it at once. The grant is the MCP route's
  only credential:
  - it is the one workbench POST that skips the mutation token;
  - a request with a browser `Origin` header is refused;
  - GET answers 405.
- **Output hygiene.** Page text and console output are secret-scrubbed and
  labelled as untrusted page content, so an agent treats instructions inside
  a page as data.
- **Isolation in the desktop app.**
  - Browser tabs are separate windows that no Tauri capability matches, so
    websites get no IPC.
  - They use their own website data store, never Verse's cookies.
  - Navigations are limited to `http` and `https`.
  - `target=_blank` opens in the same tab.
  - Downloads are refused.

A Claude turn with access **off** launches byte-identical to before: it loads
no MCP servers under `--strict-mcp-config`.

## Limits

- A native webview is a separate layer above the page. The pane hides it
  whenever a Verse dialog, menu or listbox opens, whenever the pane is hidden,
  and whenever the window is hidden. Tooltips that overlap the page draw
  underneath it.
- Screenshots are macOS-only for now (`WKWebView takeSnapshot`). Other
  platforms report `unsupported`.
- Grants and allowed origins last only as long as the Verse process. Turn
  access back on after a restart.
