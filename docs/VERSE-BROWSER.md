<a id="verse-integrated-browser"></a>

# Phantom integrated browser

A browser inside Phantom that you and a chat's agents share. You browse in it;
with your say-so, the chat's agents can look at your local apps through it —
open a page, read its structure, take a screenshot, read its console and
network — and, in the desktop app, act in it: click, type, choose options,
press keys and scroll. Anything that matters waits for you.

- **Pane:** `src/web-ui/routes/verse/browser/` (`BrowserPanel.tsx`, registered
  with the workbench pane registry through `register.ts`).
- **Sidecar:** `src/core/verse/browser-{types,bridge,mcp,api}.ts` under
  `/api/verse/browser/*`; the acting tools are the registry in
  `verse-mcp-browser-act.ts`, their rules in `browser-act-policy.ts`.
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
| Agents: snapshot, network, click, type, select, keys, scroll | macOS (real input into the page) | No: agents can only navigate |
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

When access is on, eligible local seats get the browser tools from their next
turn through Phantom's unified `ashlr-verse` MCP server on loopback. Cloud Devin
does not reach the local Browser pane. Two more switches appear
under the first one: **Click and type** (on with access; switch it off to
leave agents looking only) and **Run scripts (localhost)** (off until you
switch it on). `tools/list` shows only what is switched on, and every call
checks again.

| Tool | Scope | Does |
|---|---|---|
| `browser_status` | look | What the active tab shows, what this shell can do, what you allow, and the chat's dev servers |
| `browser_navigate` | look | Navigates the visible pane while observing; URL must be localhost or an operator-allowed origin, and the Phantom server's own port is refused. Navigation can issue a GET request. |
| `browser_snapshot` | look | An accessibility-style outline of the visible page: role, name, state and a ref (`e12`) per element. Hidden and `aria-hidden` content is left out; password and payment values read `[redacted]` |
| `browser_screenshot` | look | An image of the visible page or of one element (`ref`), at most 1280×800 px, with its scale so pixel coordinates map back to the page. Full-page capture isn't available |
| `browser_read_text` | look | The page's visible text |
| `browser_console` | look | Recent console messages, uncaught errors and failed requests |
| `browser_network` | look | Every fetch / XHR since load: method, URL, status, time, sizes. No bodies or headers |
| `browser_tabs` | look for list; act for new/select/close | Lists tabs or changes the visible tab (a tab this chat may not observe is never named or closed) |
| `browser_back` / `browser_forward` | act | Moves through the active tab's history |
| `browser_click` | act | Click by ref, or by x, y in the last screenshot; double, right (the page's own menu), modifiers |
| `browser_type` | act | Type into a text field; `clear` replaces, `submit` presses Enter |
| `browser_select` | act | Choose drop-down options by value or label |
| `browser_hover` | act | Move the pointer over an element |
| `browser_press_key` | act | One key or combination from a closed table |
| `browser_scroll` | act | Scroll the page or an element, or bring an element into view |
| `browser_wait_for` | act | Wait for text to appear or disappear, or a fixed time (≤ 30 s) |
| `browser_evaluate` | scripts | One JavaScript expression in a localhost page |

Acting requires the desktop app on macOS. In a browser tab, agents can only
navigate loopback pages; the pane cannot deliver native input there.

### How a call travels

```
seat ──turn bearer MCP──▶ /api/verse/agent-tools/mcp ──queue──▶ the pane open on that chat
                                                          (long-poll /commands)
seat ◀──────────── answer ◀── /result ◀───────────────── runs it in the pane you see
```

The sidecar never browses. The pane you have open on that chat carries out
every command, so an agent only sees the browser you are looking at. If no
pane is open, the tool fails at once and tells the agent to ask you.

An action travels one step further: the sidecar first asks the pane what the
target is (`resolve`: its role and name, whether it submits a form, where a
link goes, whether it is a secret field), decides, and only then sends the
action with the element's signature — a page that swapped the element in
between gets a refusal, not a click. In the page, the click or key press is
real input from the desktop shell, and a ring shows where it landed. The
strip under the page lists the agent's recent actions.

### When the agent has to ask you

A card appears in the pane — **Allow once**, **Allow for this chat**, **Deny**
— and the agent waits up to two minutes (no answer is a no) before:

- submitting a form (a submit button, `submit: true`, or Enter in a form field);
- clicking a control labelled delete, pay, buy, send, publish, post, confirm
  (and kin such as checkout, transfer, deploy, merge);
- following a link or a form to another origin;
- acting on a page outside this machine;
- **any** action in a turn that has already read content from outside this
  machine. That content may be steering the agent (prompt injection), so from
  then on you decide. The next turn starts clean.

"Allow for this chat" remembers exactly the reason you allowed (for example
`submit@http://localhost:5173`), shown as a chip you can remove; switching
acting off, or access off, forgets them all.

### Never

Whatever you allow, an agent never types into a password, payment, SSN or
other secret field (the sidecar, the pane's tap and the native layer each
refuse), never picks a file to upload, never downloads, never presses ⌘V
(your clipboard), and has no tool for cookies or storage. Scripts naming
`document.cookie`, `localStorage`, `sessionStorage`, `indexedDB` or `caches`
are refused — a speed bump, not a sandbox: scripts run only on localhost and
only with their switch on.

### You take over

Clicking or typing in the page yourself while an agent is working pauses it:
the pane shows **You took over** and every agent command but status waits
until you press **Resume agent**. The desktop shell tells your input from the
agent's by where it came from (an AppKit monitor sees only real input), so the
agent's own clicks never pause it. Using the address bar, tabs or back /
forward counts too.

## Safety posture

It follows the same rules as Claude's own in-app browser.

- **Acting is bounded and visible.** See the two sections above: what asks
  you, what never happens, and how you take over. The desktop shell runs only
  fixed scripts in a tab (arguments as validated JSON); the injected tap reads
  a field's content in one place and never for a secret field.
- **Localhost by default.** An agent may open and look at loopback pages
  (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`), meaning your own dev
  servers. It cannot open Phantom itself on any spelling of its port.
- **External sites need your explicit allow, per chat.** When an agent asks
  for another origin, the request is refused and appears in the pane as
  **Agent asked for https://… → Allow for this chat**. If you are already on
  such a page, the pane offers **Allow** for it. Allowed origins are
  per-origin and per-chat, and they are forgotten when Phantom restarts.
- **The gate runs twice.** The sidecar checks a URL before queueing a
  navigation. The pane checks the active tab before capturing anything. The
  sidecar checks the URL of every capture again. A page you are browsing
  outside the allowed set is never screenshotted, read or even named to the
  agent.
- **Grants.** Browser access and its act/script scopes live in memory per
  chat. The next eligible turn receives a fresh 32-byte bearer token for the
  unified MCP route. The page never sees it. Turn end, Stop, KILL, or access
  revocation invalidates it; queued browser commands are cancelled. Claimed
  commands must pass a live dispatch fence before a page effect. A native
  action already past that fence may finish. The older
  `/api/verse/browser/mcp/<grant>` endpoint is retired and returns 410.
  Browser `Origin` headers are refused on the unified MCP route.
- **Output hygiene.** Page text, titles, element names, console lines and
  script results are secret-scrubbed, stripped of invisible characters (bidi
  overrides, zero-width), and framed as untrusted output. The block id is
  random per call, so a page cannot forge the closing tag. Displayed URLs are
  scrubbed and neutralised, with secret-looking query values redacted.
- **Isolation in the desktop app.**
  - Browser tabs are separate windows that no Tauri capability matches, so
    websites get no IPC.
  - They use their own website data store, never Phantom's cookies.
  - Navigations are limited to `http` and `https`.
  - `target=_blank` opens in the same tab.
  - Downloads are refused.

When every Agent tools scope is off, the next turn loads no Phantom MCP server.

## Limits

- A native webview is a separate layer above the page. The pane hides it
  whenever a Phantom dialog, menu or listbox opens, whenever the pane is hidden,
  and whenever the window is hidden. Tooltips that overlap the page draw
  underneath it.
- Screenshots and acting are macOS-only for now (`WKWebView takeSnapshot`,
  AppKit events). Other platforms report `unsupported`; the web UI can only
  navigate.
- Full-page screenshots aren't possible (WebKit renders only the viewport);
  the agent scrolls and captures again.
- Hover is best effort: WebKit may ignore a synthesized pointer move while the
  app is in the background; the tool says when the page did not register it.
- `browser_select` and a right click are performed by the page script (a
  native popup menu would block the app), so the page sees them as script
  events rather than trusted input.
- Refs last for one page load; after a navigation or reload the agent takes a
  new snapshot.
- Grants and allowed origins last only as long as the Phantom process. Turn
  access back on after a restart.
