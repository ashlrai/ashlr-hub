# Ashlr Verse V2 — design language

The target: an app that feels like a precision instrument. Codex-desktop restraint, a Space Grotesk
edge, and the configurability of a tiling-WM setup — "Linux for agentic engineering". Every rule below
is a constraint, not a suggestion. When in doubt, remove something.

## 1. Principles

1. **Monochrome first.** The interface is neutral gray. Color appears only to carry meaning: a status,
   an engine identity, a destructive action. A screen with three accent colors on it is wrong.
2. **Hairlines, not cards.** Separation comes from 1px borders at low contrast and from whitespace.
   No drop shadows except on true overlays (dialog, menu, toast). No nested rounded boxes.
3. **One reading column.** The transcript is a 720px measure centered in its pane, never full-bleed.
   Chrome is dense; content breathes.
4. **Type does the work.** Space Grotesk (display) for anything that should feel engineered — titles,
   seat names, numerals, metrics, labels. Body copy and long prose stay in the UI sans. Never mix
   the two inside one line except where a number is the point.
5. **Quiet motion.** 120–180ms, ease-out, opacity and 2–4px translate only. Nothing bounces, nothing
   slides across the screen. The streaming caret is the only persistent animation.
6. **Honest states.** Unknown is not blank and not zero. Degraded is not an error. Every surface that
   can be empty, loading, stale, or unauthorized has a designed state for it.

## 2. Tokens — replace the current values in `src/web-ui/design/tokens.css`

Keep every existing token NAME (they are used across the whole app). Change values only, and add the
new ones listed. The light palette stays on bare `:root`; dark redefines under both
`@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])` and
`:root[data-theme="dark"]`. No token may be defined only inside a media or theme block.

**Neutral ramp — true neutral, a whisper warm in light, near-black in dark.**
```
light: --gray-0 #ffffff  --gray-50 #fafafa  --gray-100 #f4f4f5  --gray-200 #e8e8ea
       --gray-300 #d6d6da --gray-400 #a1a1aa --gray-500 #71717a --gray-600 #52525b
       --gray-700 #3f3f46 --gray-800 #27272a --gray-900 #18181b --gray-950 #09090b
dark:  --bg-canvas #0b0b0d  --bg-surface #121214  --bg-surface-raised #171719
       --bg-hover #1c1c20  --bg-active #232328  --bg-selected #26262c  --bg-input #111113
       --border-subtle #1f1f23 --border-default #2a2a30 --border-strong #3a3a42
       --text-primary #f4f4f5 --text-secondary #a1a1aa --text-tertiary #71717a
```
Light surfaces: canvas `--gray-50`, surface `#ffffff`, raised `#ffffff`, input `#ffffff`,
hover `--gray-100`, active `--gray-200`, selected `--gray-100`.
Light borders: subtle `#ececee`, default `--gray-200`, strong `--gray-300`.
Light text: primary `--gray-950`, secondary `--gray-600`, tertiary `--gray-500`, disabled `--gray-400`.

**Accent — user-selectable, default a restrained electric indigo.** Define the default as raw channels
so the theme editor can swap one variable:
```
--accent-h 245; --accent-s 72%; --accent-l 58%;
--accent-500: hsl(var(--accent-h) var(--accent-s) var(--accent-l));
--accent-600 / --accent-700: same hue, l -8% / -16%;  --accent-50 / --accent-100: same hue, very high l
--accent-contrast: #ffffff
```
Dark mode raises `--accent-l` by ~6% so the accent stays luminous on near-black.

**Status — muted in light, luminous in dark.** Keep the existing six names and the running=amber /
done=green semantics. Retune to the neutral ramp: lower saturation in light (bg ~ 8% sat), higher
luminance in dark (fg readable on `#121214`, bg at ~14% alpha of the solid).

**Engine identity — new tokens.** One hue per provider, used ONLY for a 2px seat marker, the seat pill
tint, and the usage bar. Never for text.
```
--engine-claude: #c96442   --engine-codex: #10a37f   --engine-grok: #6b7280   --engine-local: #7c5cff
```

**Type.** Fonts are self-hosted TTFs in `src/web-ui/design/fonts/` (Space Grotesk, IBM Plex Sans) and
there is NO network font access — do not add a CDN link or a new font file. `--font-display` stays
Space Grotesk, `--font-ui` stays the IBM Plex Sans stack, `--font-mono` unchanged. Add `--tracking-display: -0.02em` and
`--tracking-label: 0.06em` (uppercase micro-labels). Keep the size ramp; add `--text-2xs-size: 11px`
for micro-labels only.

**Radius.** Tighten: xs 3px, sm 5px, md 7px, lg 10px, xl 14px. Elite reads tighter than friendly.

**Density — new.** `--density-row: 32px` comfortable / 26px compact, `--density-pad: var(--space-3)` /
`var(--space-2)`. Set on `:root[data-density="compact"]`. Every list row and control height derives
from these, never a hardcoded px.

**Elevation.** Only three: `--shadow-menu`, `--shadow-dialog`, `--shadow-toast`. Delete usage of the
rest in Verse. In dark mode shadows are nearly invisible; separation comes from `--border-default`.

## 3. Customization — the "Linux" part

A Settings surface, persisted in `localStorage` under `ashlr.verse.appearance.v1`, applied by writing
attributes/vars on `document.documentElement`:
- **Theme**: system / light / dark (extend the existing `theme-store.ts`, don't fork it).
- **Accent**: eight presets plus a hue slider writing `--accent-h/s/l`.
- **Density**: comfortable / compact → `data-density`.
- **Display font**: Space Grotesk / UI sans / mono → `--font-display`.
- **Radius**: sharp (0–3px) / default / soft → scales the radius tokens.
- **Reduce motion**: forces all durations to 1ms (also respect `prefers-reduced-motion` by default).
Live preview: every change applies immediately, no save button. A "Reset to defaults" link.

## 4. Shell

Three regions, all resizable, all persisted:
- **Rail (56px, fixed):** brand mark, then icon buttons for the five sections — Chat, Autonomy,
  Approvals, Usage, Settings — with an active indicator (2px accent bar on the left edge of the icon,
  not a filled pill). Badge dot on Approvals when items are pending. Bottom: theme quick-toggle.
- **Sidebar (240–360px, collapsible):** section-dependent. For Chat: search field, "New chat", then
  sessions grouped by project with a 2px engine marker, title, and a right-aligned relative time.
  Running sessions show a small pulsing dot, never a spinner.
- **Main:** section content. For Chat: a header strip (title, seat pill, context ring, actions), the
  720px transcript column, and the composer docked at the bottom with the same measure.

Header strips are 48px, bottom-bordered hairline, and contain no filled buttons — only ghost icon
buttons and text. Context is a 16px occupancy ring with a tick at the compaction point and the
percentage beside it in Space Grotesk, not a labelled progress bar. The header and the composer
footer draw the same ring from one reading, so they cannot disagree; its tooltip carries the tokens
(`18,000 of 66,000 tokens`) and where the CLI compacts.

## 5. Chat surface specifics

- **Messages.** The user turn is a quiet rounded block aligned right: `--bg-hover` ground,
  `--radius-lg`, primary text, at most 85% of the measure, no border and no colour of its own. The
  assistant turn is plain primary prose at full measure, with no box at all. Role is conveyed by
  placement and shape, never by colour alone.
- **Turn footer.** A settled turn ends in a muted footer attached to it — its duration in Space
  Grotesk tabular numerals and, when calls failed, "2 failures in this turn — jump to the first". It
  is `--text-2xs` tertiary, stepping up to secondary while the turn is hovered or focused. There is
  no duration line of its own between turns; a clean end draws nothing else.
- **Markdown.** Real typographic hierarchy: h1–h3 in display font, lists with proper hanging indents,
  tables with hairline rules, blockquotes with a left rule. Code blocks: `--bg-code`, 1px border, a
  language label and a copy button revealed on hover in the top-right, no chrome otherwise.
- **Tool calls.** One line per call when collapsed: a 12px glyph, the tool name in mono, a truncated
  argument, an edit's `+12 −3`, and a right-aligned duration. A run of calls collapses into a single
  activity row (`Ran 12 commands · read 8 files · edited 3 files · 1 failed · 2m 14s`) that opens on
  its failed and running calls. Expanded, each shows input and output in a bordered mono block.
  Failures tint the left rule danger and say so in words.
- **Paths.** Every path a tool or file row shows reads relative to the chat's roots (`src/math.ts`),
  else `~`-abbreviated, else (when long) its last three segments behind `…/`. The full path is the
  tooltip. Display only: nothing handed back to a tool, a search or a jump is rewritten.
- **Composer.** Auto-growing textarea to 40% viewport height, hairline border that gains the accent on
  focus, no inner card. Placeholder: "Ask anything — @ to add files, / for commands". Below it one
  footer row of 28px controls, 8px apart. Left is how you write: attach, mic, permission mode. Right
  is where it runs: seat chip, Model picker, Effort, context ring, Send.
  - The seat chip names only the account ("Claude Max", "Local") beside an engine monogram and, where
    the provider reports one, a capacity ring; the model is said once, in the Model picker.
  - Permission-mode labels are short and never ellipsized — Plan, Accept edits, Auto, Bypass — with
    the full name ("Bypass permissions") as the control's accessible name and tooltip. Bypass is red.
  - Effort appears only when the seat can set it, as "Effort: High".
  - Send is the one filled accent button, "Send ⏎". While a turn runs it becomes Queue, with Stop
    beside it as a square ■ icon button whose words are its name and tooltip.
  - Too narrow for its words, the row folds in steps rather than truncating: "Effort:" becomes an
    icon, the seat chip its monogram, the mode its icon, then the pickers move into a ⋯ sheet.
  - The keyboard hint row under the box is `--text-2xs` tertiary and hides once the user has sent
    their first message in the session.
- **Streaming.** A 2px × 1em accent caret trailing the text. No skeletons mid-stream.

## 6. Accessibility, responsiveness, correctness

- Contrast ≥ 4.5:1 for body text and ≥ 3:1 for borders carrying meaning, verified in BOTH themes.
- Every interactive element has a visible `:focus-visible` ring (2px accent, 2px offset) and an
  accessible name. Full keyboard reachability; no positive tabindex.
- Works down to 900px wide: the resources panel collapses first, then the sidebar becomes an overlay.
- Never communicate state by color alone — pair every status color with a glyph or text.
- Respect `prefers-reduced-motion`.

## 7. What "done" looks like

Open the app cold in dark mode. It reads as one designed object: neutral, quiet, sharp-cornered,
with a single accent and Space Grotesk numerals. Nothing is a default browser control. Nothing
jitters. Switch to light — the same object, inverted, equally considered. Open Settings, drag the
accent hue, and the whole app follows instantly.
