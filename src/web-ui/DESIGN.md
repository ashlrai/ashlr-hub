# ashlr-hub operator console — design system & foundation guide

This is the foundation for the new operator UI: React + TypeScript + Vite,
replacing the 7,901-line vanilla `app.js` monolith. It ships one fully-built
reference view (**Fleet Dashboard**) and a real shell — routing, data layer,
auth, command palette — for every other view to be built on top of the same
way. Read this before adding a view.

The backend (`src/core/web/server.ts`, `api.ts`, `control.ts`,
`visibility.ts`) is untouched and stays that way — it was already good. This
document only covers `src/web-ui/**`.

---

## 1. Where things live

```
src/web-ui/
  index.html            Vite entry (built to dist/core/web/public/next/)
  main.tsx               ReactDOM root
  tsconfig.json          isolated TS config (DOM+Node libs, react-jsx, bundler resolution)
  app/
    App.tsx              auth gate + providers + HashRouter
    routes.tsx            route table, driven by nav-config.ts
    nav-config.ts          SINGLE source of truth for nav hierarchy — sidebar
                            and command palette both read this
    SkipToContent.tsx
  design/
    tokens.css             all design tokens (colors, type, spacing, radius,
                            elevation, motion) — the one source of truth
    global.css              reset + base typography + focus-visible + skeleton
  components/
    layout/                 Shell, Sidebar, Topbar
    primitives/              Epistemic, StatusBadge, Skeleton, RefreshIndicator,
                              Dialog, Toast — the vocabulary every view is built from
    auth/                    SessionGate, MutationTokenDialog
    command-palette/         CommandPalette, commands.ts (registry)
  data/
    api-types.ts             type-only re-exports from src/core/**
    client.ts                 apiGet / apiPost / eventsUrl
    auth-store.ts             read-session + mutation-token authority (no React)
    cache.ts                   the resource cache (no React)
    sse.ts                     one EventSource, fans out to cache invalidation
    queries.ts                one QueryDef per backend resource
    mutations.ts               one wrapped function per mutating route
    hooks.ts                   useQuery / useAuthPhase / useMutationHold (React glue)
  hooks/
    useScrollRestore.ts
  routes/
    PlaceholderView.tsx        what every not-yet-built nav leaf renders
    fleet-dashboard/            the reference view — copy this pattern
  test/
    setup.ts                   jsdom/testing-library setup (npm run test:web)
```

---

## 2. Design tokens

**Single source of truth: `design/tokens.css`.** It replaces three token
sets that used to disagree — `public/index.html:18-68` (accent `#00d4ff`),
`public/styles.css:10-102` (accent `#38bdf8`), and the `STATUS_COLOR` map
hardcoded in `public/app.js:40-49`. Do not add a fourth. Every new component
reads `var(--token-name)` — never a hex literal, never a hardcoded `px` font
size.

### Type scale
No size below 12px anywhere (`--text-xs-size: 12px`). Full scale:
`--text-xs` (12/16), `--text-sm` (13/18), `--text-base` (14/20, the default
body size — dense operator UI, not a marketing page), `--text-md` (15/22),
`--text-lg` (17/24), `--text-xl` (20/28), `--text-2xl` (24/32), `--text-3xl`
(30/38). Each has a paired `-size` and `-line` var. `--font-ui` for
interface text, `--font-mono` for ids/tokens/logs/code.

### Spacing / radius / elevation / motion
- Spacing: 4px base unit, `--space-0` through `--space-24`.
- Radius: `--radius-xs` (4px) through `--radius-full` (9999px).
- Elevation: `--shadow-sm/md/lg/xl` + `--shadow-focus-ring`. Dark mode
  redefines these with darker/subtler shadows rather than reusing light
  values at low opacity.
- Motion: `--duration-instant/fast/base/slow` + two easing curves.
  `@media (prefers-reduced-motion: reduce)` collapses every duration to
  `0.01ms` in one place — components never check the media query
  themselves, they just use the duration token.

### Status-color semantics — the inversion this resolves

The audit found `running` was green in `app.js` but blue in `styles.css`;
`done` was blue in `app.js` but emerald in `styles.css`. Two different files
disagreed about what the same word meant. Resolved as:

| Tone | Color | Used for |
|---|---|---|
| `neutral` | gray | pending, queued, waiting, cancelled |
| `info` | blue | informational, non-status blue (kept separate so it never collides with a real status) |
| `running` | **amber** | running, active, in_progress, building, applying |
| `success` | **green** | done, success, applied, merged, ready, approved, ship |
| `warning` | amber-orange | review, degraded, paused |
| `danger` | red | failed, error, rejected, harmful |
| `unknown` | violet | epistemic — see §5 |

**Why amber for running, not blue or green:** motion vs. resolution. A
thing that is still happening is not yet resolved — it isn't "good" (green)
and it isn't informational chrome (blue, which is reserved for links/focus/
brand elsewhere in the system so "this is clickable" never visually
collides with "this is a status"). Amber-for-in-progress /
green-for-succeeded is the same convention Vercel's deployment states and
GitHub Actions runs use — both cited as reference points for this rebuild.
`done` is unambiguously green because it's the ONE color in the whole
system that means "resolved, good."

This mapping lives in exactly one place:
`components/primitives/StatusBadge.tsx`'s `statusToTone()`. Route every
status string through it — never `switch` on a raw status string in a view.
`StatusBadge.test.tsx` locks the semantics in as a regression test; if a
future edit flips `running`/`done` back, that test fails.

Phases (swarm DAG stages, goal milestones) use a **separate** categorical
palette (`--phase-1` through `--phase-6`, via `<PhaseDot index={n}/>`) —
deliberately different hues from status colors so "phase 3 of 6" never
reads as a health signal.

### Light / dark
Full light palette lives on bare `:root`. Dark mode is defined **twice**,
kept in sync: once under `@media (prefers-color-scheme: dark)` guarded by
`:root:not([data-theme="light"])` (OS signal, unless overridden), and once
under `:root[data-theme="dark"]` (explicit in-app toggle, wins either
direction). No token is ever defined only inside one of those blocks — grep
`tokens.css` for `--border-subtle` and you'll find it on bare `:root` first,
every time. This was the specific bug in the old `styles.css` (`.theme-light`
overrode 16 vars but missed `--border-subtle`, `--bg-input`, `--bg-active`,
producing near-black inputs with near-black text) — the fix isn't a patch,
it's that the *pattern itself* (full base palette + two additive overrides)
makes that class of bug structurally impossible: there's no such thing as a
theme-only variable to forget.

The toggle lives in `components/layout/Topbar.tsx`, cycling
system → light → dark, persisted to `localStorage` (this is a UI
preference, not a secret — unlike the tokens in §4/§5, it's fine to
persist).

---

## 3. Component conventions

- **CSS Modules**, colocated (`Foo.tsx` + `Foo.module.css`). No CSS-in-JS,
  no Tailwind — Vite handles CSS Modules with zero extra config, keeping
  runtime deps at zero for styling.
- **Primitives own their accessibility.** `Dialog.tsx` implements focus
  trap / return-focus / Escape-to-close once; `MutationTokenDialog` and
  `CommandPalette` both build on it instead of re-implementing modal
  behavior. If you need a new modal, extend `Dialog`, don't hand-roll one.
- **`useSyncExternalStore` for framework-free state.** `auth-store.ts` and
  `cache.ts` have zero React imports and are plain, independently
  unit-testable modules; `data/hooks.ts` is the only file that bridges them
  into React. If you add another cross-cutting store, follow that split.
  **The one sharp edge:** `useSyncExternalStore`'s `getSnapshot` must return
  a *new* object reference whenever the observable state changes — it
  compares with `Object.is`, not a deep equal. `cache.ts` replaces its
  snapshot object wholesale on every transition (`setSnapshot`) rather than
  mutating fields on a long-lived entry; a version that mutated in place
  shipped a real bug where the UI never got past the loading skeleton
  (caught by the DOM tests + a live-server check while building this).
- **Skeleton vs. RefreshIndicator.** `status === 'loading'` (no data yet at
  all) → skeleton. `status === 'refreshing'` (stale data still present) →
  keep rendering the real content, add a small `<RefreshIndicator/>` next
  to whatever section is stale. Never blank a populated view back to a
  skeleton.

---

## 4. Routing — and why it's hash-based

`react-router-dom`'s `HashRouter`, driven entirely by
`app/nav-config.ts`'s `NAV_GROUPS`. This is a deliberate choice, not a
default:

`src/core/web/static.ts` (off-limits to this foundation) special-cases only
the literal path `"/"` to resolve to `index.html`; every other path is
resolved as a literal file on disk and 404s if nothing matches. A
`BrowserRouter`-style pushState route like `/work/runs/r_123` would 404 on
refresh or on a pasted link, because the server has no SPA catch-all and
this foundation is explicitly not allowed to add one.

`HashRouter` sidesteps the problem entirely — the fragment after `#` never
reaches the server — while still giving genuinely hierarchical, bookmarkable,
shareable URLs (`#/work/runs/r_123`), which is what the brief asked for
("real client-side routing with deep links, not just hash-to-view"). Two
illustrative param routes (`/work/runs/:id`, `/work/swarms/:id`, wired in
`routes.tsx`) prove a resource-id deep link resolves correctly end-to-end
even though those detail views aren't built yet.

**When the legacy `public/index.html` is retired and this becomes the root
app**, `static.ts`'s `"/"` special case will cover it directly and a real
SPA catch-all could be added to `server.ts` if pushState routing is ever
wanted instead — that's a call for whoever does the cutover, not baked in
here.

**Nav hierarchy.** The audit found 14 flat, ~70%-overlapping hash links
(`#fleet-dashboard`, `#control`, `#fleet`, `#fleet-activity`, `#overview`,
`#daemon`, …). `nav-config.ts` groups them into Overview / Work / Inbox /
Control / Intelligence / Portfolio / Goals. Both the sidebar
(`Sidebar.tsx`) and the command palette's nav commands
(`command-palette/commands.ts`) derive from this ONE list — add a route
once, it shows up in both places automatically.

---

## 5. Data layer

**Types are never hand-copied.** `data/api-types.ts` does
`export type { DashboardSnapshot } from '../../core/types.js'` (and
similarly for `ControlSnapshot` from `web/control.js`). `import type` is
fully erased at build time (zero runtime bytes) and can never drift from
the backend — if `tsc --noEmit -p src/web-ui/tsconfig.json` fails after a
backend type change, that's the signal working as intended, not a bug in
the frontend config. (Note: `src/web-ui/tsconfig.json` includes both `dom`
and `node` lib types for this reason — pulling in the backend's type graph
transitively needs Node ambient globals even though nothing here runs in
Node.)

**Every resource is a `QueryDef`** (`data/queries.ts`):
```ts
export const dashboardSnapshotQuery: QueryDef<DashboardSnapshot> = {
  key: 'dashboard-snapshot',
  fetch: (signal) => apiGet<DashboardSnapshot>('/api/snapshot', signal),
};
```
A view reads it with one hook call:
```tsx
const { data, status, error, updatedAt } = useQuery(dashboardSnapshotQuery);
```
`status` is `'idle' | 'loading' | 'refreshing' | 'success' | 'error'`.
`data` is never cleared by a refetch — see the Skeleton-vs-RefreshIndicator
rule above.

**SSE feeds the cache, not the view.** `data/sse.ts` opens exactly one
`EventSource` against `/api/events`, listens for the server's named events
(`runs`, `swarms`, `inbox`, `daemon`, `daemon-observation`,
`fleet-activity-ping`, `fleet-activity-observation`, `snapshot`), and maps
each to a cache key via `EVENT_TO_CACHE_KEYS`, calling `invalidate(key)`.
Any mounted `useQuery` for that key re-fetches in the background
automatically — a view never touches `EventSource` directly. **The real
latency floor is the server's own poll interval** (`SSE_POLL_MS` in
`api.ts`, ~1.5s at time of writing) — nothing here tries to beat that, and
it shouldn't.

**Adding a new resource:** add a `QueryDef` to `queries.ts`, add its cache
key to `EVENT_TO_CACHE_KEYS` in `sse.ts` if it should live-update, call
`useQuery(yourQuery)` in the view. Do not call `apiGet` directly from a
view component.

**Adding a new mutation:** add a wrapped function to `mutations.ts`
(pulls the held token from `auth-store`, touches the hold, invalidates the
cache keys it affects) and, if it should be reachable from ⌘K, add a
`Command` with `requiresMutationToken: true` in
`command-palette/commands.ts`.

**Mutating routes 404, not 401/403, when `--allow-dispatch` is off.**
`client.ts`'s `apiPost` maps that specifically to `DispatchDisabledError` so
the UI can say "this server was started without dispatch enabled" instead
of a generic failure.

---

## 6. Auth — two tokens, two lifecycles

Mirrors `server.ts` exactly; see `data/auth-store.ts`'s header comment for
the full model. Short version:

- **Read authority**: `POST /api/session` exchanges the raw read token
  (never persisted — held in a local variable only long enough to make that
  one call) for an HttpOnly session cookie (server-managed, 15 min TTL).
  The per-tab **client proof** that binds the cookie is not itself a secret
  (it has no authority without the signed cookie) and is kept in
  `sessionStorage` so a page reload can keep using a still-valid cookie
  instead of re-prompting — `App.tsx`'s bootstrap effect probes a real
  protected GET on mount to find out.
- **Mutation authority**: the raw `x-ashlr-token` header, required on every
  mutating call, **never** written to any storage (`localStorage`,
  `sessionStorage`, cookies) — held in an in-memory variable only, for a
  20-minute idle-bounded "hold" (`MutationTokenDialog.tsx` +
  `auth-store.ts`'s `setMutationToken`/`touchMutationHold`), so approving a
  run of proposals is one paste, not one `window.prompt()` per click (the
  audit's #1 reason operators abandoned the UI for the CLI). The Topbar
  shows a Locked/Unlocked indicator with a one-click "lock now" — nothing
  about the hold is silent.
- **First run / expired session** shows `SessionGate.tsx` — what the token
  is, where to find it (`ashlr serve`'s stdout), and why it's safe — never a
  bare `⚠ HTTP 401`.

---

## 7. Epistemic honesty — the one thing the old UI got right

`components/primitives/Epistemic.tsx`. When a field's `sourceQuality`
(`{ sourceState, complete, reason? }` — the shape recurring across
`ControlDaemon`, daemon observation, goals, and others in the backend, even
though it isn't hoisted to one named exported type there) reports
`degraded`/`missing`/`unknown`, or `complete: false`, this component
displays the literal string `"unknown"` and **omits** (not disables —
omits) any control passed via `renderControl`. `routes/fleet-dashboard/
DaemonPanel.tsx` is the reference use: daemon runtime state, PID, spend,
and direction mode are all epistemic-wrapped against `ControlSnapshot`'s
`daemon.sourceQuality`, verified with both a degraded-state DOM test and a
live check against a real `ashlr serve` instance.

**Every view that surfaces a `sourceQuality`-bearing field should wrap it
in `<Epistemic/>`.** This is meant to be the default, not an opt-in.

---

## 8. Accessibility baseline

- `:focus-visible` everywhere (`design/global.css`), never a suppressed
  outline without a replacement.
- Real skip link (`app/SkipToContent.tsx`) — deliberately a `<button>` that
  imperatively focuses `#main-content`, not `<a href="#main-content">`:
  under `HashRouter`, a literal `#`-href anchor would rewrite
  `location.hash` and hijack the route instead of just scrolling.
- `aria-live="polite"` on the freshness indicator and the toast region;
  `role="alert"` on inline form errors.
- Command palette and dialogs are fully keyboard-operable (arrow keys,
  Enter, Escape, focus trap) and screen-reader-labeled
  (`role="dialog"`/`aria-modal`, `role="listbox"`/`option`).
- `@media (prefers-reduced-motion: reduce)` collapses all motion tokens to
  near-zero in one place (`design/tokens.css`) rather than per-component.
- Data rows that need keyboard reachability carry `data-focus-key` (see
  §9) so background refreshes don't strand focus.

---

## 9. Scroll / focus / expanded-state survival

`hooks/useScrollRestore.ts` is a React port of the one correct piece of
`app.js`'s render loop (`captureMainViewState`/`restoreMainViewState`,
`app.js:692-718`), fixing the bug in the original: it captured
`window.scrollY`, but the actual scroll container was `.main`
(`styles.css:4543` set `body.live-shell{overflow:hidden}`), so
`window.scrollY` always read `0` and position reset on every ~8-15s poll.

Here, `components/layout/Shell.tsx` passes the real `<main>` element's
`ref` directly — there's no ambiguity about which element scrolls, and it's
the ONE scroll container for the whole app (every routed view renders
inside it; no view should introduce its own `overflow: auto` container).
Keyed by route pathname, so switching views and back restores each one's
own position independently. Survives: `scrollTop`, which element had focus
(via a `data-focus-key` attribute you put on focusable rows), and open/
closed state of any `<details data-state-key>` in the view (see
`fleet-dashboard/RunsPanel.tsx` for both patterns in use).

**A flexbox trap worth knowing about if `.main` ever stops scrolling
correctly again:** flex children default to `min-height: auto`, which
refuses to shrink below content size — without `min-height: 0` on `.body`
and `.main` in `Shell.module.css`, a tall view forces the whole document to
grow and scroll instead of `.main` scrolling internally (this exact
regression was caught live against a real server while building this
foundation, before the `min-height: 0` fix landed — it's the modern
equivalent of the old `body.live-shell{overflow:hidden}` workaround, except
here the fix makes `.main` unambiguously correct rather than just hiding
the symptom).

---

## 10. Command palette (⌘K)

`components/command-palette/CommandPalette.tsx` +
`command-palette/commands.ts`. Two command groups: **Navigate** (generated
1:1 from `nav-config.ts`, so it can never list a route the sidebar doesn't
also have) and **Actions** (hand-declared, e.g. pause/resume fleet).
Actions with `requiresMutationToken: true` transparently hand off to
`MutationTokenDialog` if no hold is active, then re-arm on demand — the
palette itself never asks for the token.

**Adding a command:** navigation commands need nothing (add the leaf to
`nav-config.ts`); action commands get one entry in the `actionCommands`
array in `commands.ts`.

---

## 11. Adding a new view — the full checklist

1. Add the leaf to `app/nav-config.ts` with `implemented: true`.
2. Create `routes/<your-view>/<YourView>.tsx` (+ colocated `.module.css`
   and any sub-panels — follow `routes/fleet-dashboard/`'s layout).
3. Pull data via `useQuery(yourQueryDef)` (add the `QueryDef` to
   `data/queries.ts` first if it doesn't exist yet); never call `apiGet`
   directly.
4. Handle `status`: `'loading'` → skeleton, `'error'` → inline error banner
   (never a full-page error — the shell stays usable), `'refreshing'` →
   real content + `<RefreshIndicator/>`, `'success'` → real content.
5. Wrap any `sourceQuality`-bearing field in `<Epistemic/>`.
6. Route every status string through `statusToTone()` /
   `<StatusBadge/>` — don't invent a new color mapping.
7. Wire the real component into `app/routes.tsx` in place of the
   `PlaceholderView` fallback for that leaf.
8. Add a DOM test (`npm run test:web`) mocking `fetch` the way
   `routes/fleet-dashboard/FleetDashboardView.test.tsx` does.

---

## 12. Verification commands

```
npm run typecheck        # backend (tsc --noEmit) + web-ui (its own isolated tsconfig)
npm run typecheck:web    # web-ui only
npm run lint              # whole repo, including src/web-ui (own eslint block, react-hooks rules)
npm run test:web          # DOM tests (jsdom + @testing-library/react)
npm run build              # tsc -> copy-assets -> vite build -> ... (full published-package pipeline)
npm run dev:web            # Vite dev server; proxies /api to a real `ashlr serve` — set
                            # ASHLR_DEV_API_PROXY_TARGET=http://127.0.0.1:<port> to the port
                            # `ashlr serve` printed (it's random per run)
```

The built app is served at **`/next/index.html`** by the existing
`ashlr serve` (not `/next/` — `static.ts`'s `"/"` special case is the only
path that resolves without a filename, and this foundation doesn't touch
`static.ts`). The legacy app keeps serving unmodified at `/`.
