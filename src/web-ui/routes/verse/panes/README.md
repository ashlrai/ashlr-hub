# Panes — how to put something in the chat's panel area

The chat's panel area (the **dock**) holds tabs and splits beside the
conversation, or under it (the operator's pick). Every tab in it is a
**pane** from the registry in `pane-registry.ts`. You add a pane, or replace
a first-party one, **without touching the layout**: one file in your own
directory.

```tsx
// routes/verse/reasoning/reasoning.pane.tsx   ← any `*.pane.tsx` under routes/verse is discovered
import { lazyPane, registerPane } from '../panes/pane-registry.js';
import { ReasoningGlyph } from '../dock/dock-icons.js';

registerPane({
  id: 'reasoning',                 // same id as the first-party stub → REPLACES it
  title: 'Reasoning',
  icon: ReasoningGlyph,
  component: lazyPane(() => import('./ReasoningPane.js').then((m) => m.ReasoningPane)),
});
```

That is the whole integration. `panes/index.ts` imports every
`routes/verse/**/*.pane.ts(x)` file (eagerly — it only registers), after the
chat's first paint. Keep the `.pane.tsx` file to the registration and a
`lazyPane()` import, so your pane's code is its own chunk. `lazyPane` is
`React.lazy` for panes: the dock preloads it when the panel opens, a second
mount of a loaded chunk renders in the same frame (no skeleton flash), and a
failed download is retried by "Try again". Plain `React.lazy` also works.

### Or: a self-describing `register.ts`

Units that shipped before the registry landed describe their pane in
`routes/verse/<unit>/register.ts`; `panes/index.ts` discovers that file too
and `register-adapter.ts` registers every export of this shape:

```ts
export const BROWSER_PANE = {
  id: 'browser', label: 'Browser',
  load: () => import('./BrowserPanel.js').then((m) => ({ default: m.BrowserPanel })),
  // optional: commandId, keywords, defaultSlot, chatScoped, icon, shortcut, description
};
```

It replaces the first-party pane of the same id (`changes`/`review` map to
`diff`, `preview` to `browser`) and inherits its key, order, icon and header
toggle. The component receives the full `PaneProps` (a `{ sessionId,
visible }` component just ignores the rest) and gets `sessionId: null` when
no chat is open.

## `registerPane(definition) → unregister`

| field          | type                                   | notes |
| -------------- | -------------------------------------- | ----- |
| `id`           | `string`                               | Lower-case letters, numbers, dashes (`test-runner`). Persisted in layouts, so keep it stable. |
| `title`        | `string`                               | Tab label and menu name: one or two words. |
| `icon`         | `ComponentType<{ size?: number }>`     | A 16px line glyph drawn with `currentColor` (see `dock/dock-icons.tsx`). |
| `component`    | `ComponentType<PaneProps>`             | Usually `lazyPane(() => import(…).then((m) => m.YourPane))`. |
| `shortcut?`    | `string`                               | Your own chord, e.g. `'mod+alt+t'` (`mod` = ⌘ on macOS, Ctrl elsewhere; `ctrl` = ⌃). Must include `mod` or `ctrl`. **Refused** (console warning; the pane still registers, keyless) if it collides with any catalog key live in the chat, a system chord, or another pane's key. |
| `command?`     | `KeyedCommandId`                       | First-party only: the catalog command whose key opens the pane (listed in ⌘K and ⌘/). |
| `when?`        | `(ctx: PaneContext) => boolean`        | Whether the pane applies to the open chat. `false` hides its tab and menu entry (the layout keeps it; it returns when `when` does). A throwing `when` counts as `false`. |
| `needsSession?`| `boolean` (default `true`)             | Without an open chat the dock shows "Open a chat to use …" + your `description` instead of mounting you. |
| `order?`       | `number` (default `100`)               | Menu and header order. First-party panes use 10–80. |
| `description?` | `string`                               | One sentence. The "+ Add a pane" menu and the empty state teach with it. |
| `toggle?`      | `boolean` (default `false`)            | A toggle in the chat header. Reserved for the few everyone uses (Terminal, Browser, Changes). |

**Replacing** a pane: register the same `id`. The newest registration wins
and inherits what it leaves unsaid (`command`, `toggle`, `order`,
`needsSession`, `description`, `shortcut`) from the one below. First-party
panes always sit **under** a unit's registration, whatever the module load
order. The returned function removes exactly that registration; the previous
one comes back.

Registration never throws: a malformed definition is reported on the console
and ignored, so one unit's mistake cannot take the other panes down.

## `PaneProps` — what your component receives

Stable: fields are only ever added.

```ts
interface PaneProps {
  paneId: string;                          // this pane's id
  sessionId: string | null;                // never null when needsSession (the default)
  session: VerseSession | null;
  roots: readonly string[];                // the chat's folders, primary first
  events: readonly VerseEvent[];           // the chat's raw event log
  turnFiles: readonly TurnFileChange[];    // files the latest turn touched
  visible: boolean;                        // false while another tab is on top: stop timers, skip work
  presentation: 'column' | 'bottom' | 'sheet' | 'bottom-sheet';
  requests: PaneRequests;                  // one-shot terminal / preview / diff requests (with a nonce)
  host: PaneHost;                          // see below
}

interface PaneHost {
  sendToChat(text: string): void;          // a paragraph into the composer (never sent by itself)
  addToMessage(text: string): void;        // "Add to message": `path:line: note`
  openPane(id: string): void;
  closePane(id: string): void;
  openTerminal(req): void;                 // a tab at a root; `paste` is pasted, NEVER run
  openTerminalBelow(req): void;            // the same, split under the pane on top
  openDiff(req: { root; scope; file? }): void;
  openSession(sessionId: string): void;
}
```

Need the live transcript? Subscribe in the pane —
`useVerseTranscript(sessionId)` — so a streamed token re-renders your pane,
not the dock.

## What the dock guarantees

- **Keep-alive.** Mounted when its tab first shows, kept mounted (hidden,
  `inert`, `visible: false`) while the tab is open — a terminal keeps its
  scrollback, a browser its page. Moving the panel beside ⇄ below does not
  remount it either.
- **Fenced.** Each pane has its own error boundary ("… could not load" with
  Try again) and Suspense boundary (a skeleton the size of the pane — no
  layout shift).
- **Remembered.** Which panes are open, which is on top and the split are
  remembered **per chat**; sizes and placement are window-wide.
- **Keyboard.** ←/→ Home/End between tabs, Delete closes one, ⌘\ shows or
  hides the panel, each pane's key toggles it, ⇧⌘F is focus mode.

## First-party panes and keys

| id          | title     | key  | body today |
| ----------- | --------- | ---- | ---------- |
| `terminal`  | Terminal  | ⌃\`  | C4 `dock/terminal/TerminalPane.tsx` (slot) |
| `browser`   | Browser   | ⇧⌘B  | C4 `dock/preview/PreviewPane.tsx` (slot) — the old id `preview` still opens it |
| `diff`      | Changes   | ⇧⌘D  | C5 `git/DiffPane.tsx` (slot) |
| `files`     | Files     | ⇧⌘O  | stub: folders + files read / changed |
| `sources`   | Sources   | ⇧⌘S  | stub: pages, searches, files read |
| `reasoning` | Reasoning | ⇧⌘Y  | stub: the chat's thinking, by turn |
| `tasks`     | Tasks     | —    | this turn's calls + other running chats |
| `context`   | Context   | —    | usage, roots, memory, handoff |

Other chat keys: ⌘\ panel · ⌃⇧\` new terminal tab · ⇧⌘F focus mode · ⌘B
chat list. ⇧⌘E is the composer's effort and ⇧⌘R a browser's hard reload,
which is why Files and Reasoning are not on them. `pane-registry.test.tsx`
fails if any two panes, or a pane and a catalog command, share a key.

## Deep links

`?chat=<sessionId>&pane=<paneId>` on the Verse URL (and the desktop command
`open-pane:<paneId>`) opens that chat and that pane — see
`shell/deep-link.ts`.
