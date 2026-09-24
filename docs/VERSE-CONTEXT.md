# Ashlr Verse — context windows, compaction and orchestration (V3.9)

Verified on this machine, 2026-09-23, from the pinned CLI binaries, each seat's own model catalog,
every September Codex rollout on disk (1,388), Verse's own session store and the providers' published
documentation. **No paid model was prompted to produce any number on this page.**

This page is the authority for every constant in `src/core/verse/context-math.ts` and for the V3.9
context fields in `src/core/verse/types.ts` (which cite it as §1 and §2). If code and this page
disagree, one of them is a bug. The wire shapes are listed in
[`VERSE-CONTRACT-V1.md`](VERSE-CONTRACT-V1.md#v39-additive-contract--context-orchestration); the
user-facing tour is in [`VERSE.md`](VERSE.md#chat).

What 3.8 got wrong, and why this page exists:

| What Verse showed | What was true | Effect |
|---|---|---|
| Every Claude model at a 200k window | Six of the eight run a **1M** window and compact near 967k | The meter went red at 180k and then sat at 100 % while the session grew to 967k — hiding the most expensive range there is |
| Grok at 256k | **500k**, compacting at 400k | The meter read about twice the real fill |
| Codex at 272k | The CLI measures against **258.4k** (95 %) and compacts near 244.8k | The denominator was wrong |
| Codex occupancy = the turn's summed input | Occupancy is the **last call's** prompt | Across 260 recent turns the sum was a median 28.8× the last call, so the meter was pinned at 100 % |
| `claude-opus-5.5` labelled "Opus 5.5" | The CLI resolved the dotted id to **Opus 5** | Every "Opus 5.5" turn ran Opus 5 |
| Local seats: the CLI trusted Verse's window | The CLI assumed **200k** for an Ollama tag | It never compacted before a 64k runner overflowed |

Every stored reading was also clamped to the window, so an overflow was erased on disk. V3.9 stores
readings unclamped and lets the UI decide how to draw them.

---

## 1. Ground truth: windows, compaction points, and where each number comes from

### 1.1 Window sources and precedence

Every window Verse shows carries a `VerseWindowSource` so nothing on screen implies more certainty than
it has:

| Source | Meaning | Examples |
|---|---|---|
| `runtime` | The CLI reported it for **this** turn | Claude/Grok `result.modelUsage.<m>.contextWindow`; Codex rollout `token_count.info.model_context_window` |
| `provider-catalog` | The seat's own served catalog on disk | Codex/Grok `<profile>/native-state/models_cache.json` |
| `cli-catalog` | Read out of the pinned CLI binary's embedded catalog, recorded with the version | The Claude table below (2.1.257 and 2.1.280) |
| `documented` | The provider's published model table | Codex's built-in list when a seat has no catalog yet |
| `fallback` | A named default. The UI marks it as an estimate | `VERSE_DEFAULT_CONTEXT_WINDOWS` |

Precedence for a session's window: **runtime → the seat's current catalog budget for the session's
model and mode → the value stored at creation.** A runtime reading replaces the stored window and its
source becomes `runtime`; the compaction point is then recomputed for that window
(`reconcileAutoCompactAt`, §1.6). Two runtime reactions matter in practice: Claude Code drops a 1M
model to 200k when an account's long-context credit runs out (a 429 reading "Extra usage is required
for long context"), and Grok can raise a window by response header mid-session. A static catalog sees
neither.

**Only the window is read from `modelUsage`.** On `--resume` its token counts accumulate across the
whole CLI session, not the turn (a local turn 2 reported input 16,316: turn 1's 14,942 plus the
compaction in between), so per-turn usage comes from the stream's per-call usage and `result.usage`,
never from `modelUsage`. The row is chosen in order: the key equal to the turn's model (canonicalised,
so a record naming `claude-opus-5.5` still finds `claude-opus-5-5`); the same with `[1m]` stripped;
else the **only** row carrying a numeric `contextWindow` (Grok keys its row differently, §1.4, and
Claude adds side-call rows such as Haiku without one). Anything more ambiguous yields no runtime
window, not a guess.

**Local seats ignore runtime windows.** Verse sets a local seat's window itself (§1.5) and tells the
CLI with `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so the CLI's `modelUsage` only echoes Verse's own number back.
Without that variable it would echo the CLI's 200k guess, which is wrong. The number the CLI is told
and the number the meter draws are the **same** one — the session's stored `usage.contextWindow` —
and before each local turn launches Verse re-resolves the seat's window from live discovery and
corrects the stored value if it changed (§1.5), so a stale record cannot tell the CLI one window
while the meter shows another.

The last-resort fallbacks mirror what each CLI itself assumes for an id it does not know, so the meter
never claims more than the CLI will allow: Claude 200,000 (Claude Code's default for an unrecognized
model), Codex 258,400, Grok 500,000, local 65,536.

### 1.2 Claude Code

Read from the embedded model catalog of the pinned binaries (`~/.local/share/claude/versions/2.1.257`
and `2.1.280`), the served catalog cache (`~/.claude/cache/model-catalog/*.json`) and the 31 `result`
events in `~/.ashlr/agent-logs` that carry `modelUsage`.

| Model id | Window | Default max output | Min CLI | Standard budget | Expansive budget |
|---|---:|---:|---|---|---|
| `claude-fable-5-1` | 1,000,000 | 64,000 | any | 1M, compacts at 367,000 | 1M, compacts at 967,000 |
| `claude-opus-5-5` | 1,000,000 | 128,000 | **2.1.280** | 1M, compacts at 367,000 | 1M, compacts at 967,000 |
| `claude-fable-5` | 1,000,000 | 64,000 | any | 1M, compacts at 367,000 | 1M, compacts at 967,000 |
| `claude-opus-5` | 1,000,000 | 64,000 | any | 1M, compacts at 367,000 | 1M, compacts at 967,000 |
| `claude-opus-4-8` | 1,000,000 | 64,000 | any | 1M, compacts at 367,000 | 1M, compacts at 967,000 |
| `claude-sonnet-5` | 1,000,000 | 64,000 | any | 1M, compacts at 367,000 | 1M, compacts at 967,000 |
| `claude-opus-4-5` | 200,000 | 32,000 | any | 200k, compacts at 167,000 | — |
| `claude-haiku-4-5-20251001` | 200,000 | 32,000 | any | 200k, compacts at 167,000 | — |
| any other id | 200,000 (`fallback`) | unknown | — | 200k, compacts at 167,000 | — |

- **Why 1M without `[1m]`.** Claude Code gives 1M to any model whose catalog entry carries
  `native_1m` when it talks to Anthropic first-party, which is exactly how a seat's launcher runs it.
  Adding `[1m]` would be harmless on these ids and a lie on Haiku 4.5 and Opus 4.5, where the CLI would
  then claim 1M for a 200k model. Verse sends the bare id.
- **Observed at runtime:** `claude-fable-5` reported `contextWindow: 1000000, maxOutputTokens: 64000`
  in 20 result events (19 runs); `claude-opus-4-8[1m]` reported 1,000,000 / 64,000 in 11. The other rows
  rest on the catalog and the resolver code, not on observed turns.
- **Real compactions:** a transcript in `~/.claude/projects` records `compact_boundary` with
  `pre_tokens 967,391 → post_tokens 19,001` after 118 s — the 967k point, to the token.
- **Default max output** is the catalog's default, not its upper bound, read from the binaries' catalogs:
  128,000 for Opus 5.5; 64,000 for Fable 5.1, Fable 5, Opus 5, Opus 4.8 and Sonnet 5; 32,000 for Opus
  4.5 and Haiku 4.5. It **only matters up to 20,000** for the compaction point (the CLI reserves
  `min(max output, 20,000)`), so the whole 1M family shares the same thresholds.
- **Every flag V3.9 added was checked on both binaries** (2.1.257 and 2.1.280) at argument-parsing
  level, with nothing prompted: each binary was spawned with the new flags plus a deliberately
  invalid `--session-id`, and every flag got past option parsing to "Invalid session ID", while a
  control bogus flag was rejected as an unknown option. The flags are `--autocompact`, `--add-dir`,
  `--append-system-prompt=<block>` and `--exclude-dynamic-system-prompt-sections`.
- **`claude-opus-5.5` is an alias, not a model.** Verse 3.5–3.8 offered the dotted id. Claude Code's id
  parser rejects the `.5` suffix and then falls back to `includes('claude-opus-5')`, so the CLI gave it
  the identity `{"modelId":"claude-opus-5.5","marketingName":"Opus 5"}`: those turns ran Opus 5. The
  canonical id is `claude-opus-5-5` (the 2.1.280 binary contains it; no binary contains the dotted
  form). `canonicalModelId` maps the alias; adapters always send the canonical id; stored sessions keep
  the id they were created with, because history is not rewritten.
- **Binary skew.** The claude-a seat is pinned to 2.1.257 (its launcher execs that exact file), and
  2.1.257 does not know `claude-opus-5-5`. A pinned binary never updates itself, so on that seat Opus
  5.5 is **listed but disabled** with `unavailableReason` ("needs Claude Code 2.1.280; this seat runs
  2.1.257"), and the seat carries a note with the re-pin command:
  `ashlr resources profile repin --directory <dir> --executable <path>`. Creating a session on an
  unavailable model is refused (`VERSE_INVALID`, with the reason), and so is a turn on an existing
  session whose model the seat currently lists as unavailable (409 `VERSE_MODEL_UNAVAILABLE`, before
  any CLI starts). The seat's default is always its first runnable model. `POST /sessions` rewrites a
  requested `claude-opus-5.5` to `claude-opus-5-5`, because older clients remember the dotted id per
  project.
- **Re-pinning.** `ashlr resources profile repin` points one existing prepared profile at another
  native executable and changes nothing else: it rewrites only the `executable` locator (the
  launcher's one `const profile=` line and `profile.json`), keeps the provider, and refuses a profile
  that is not unmodified `prepare` output. `--dry-run` validates
  everything and reports the change without writing. Before writing, it backs up `launcher.mjs`,
  `profile.json` and `command.json` as `.prev` files — one rollback set; restoring all three restores
  the old pin. Re-running the same repin after an interruption finishes it, and repinning to the
  executable already pinned reports `unchanged`. It checks no sign-in, and restoring `.prev` does not
  undo any migration the newer CLI made to the seat's native state on its first run, so run
  `ashlr resources launcher check` (or the CLI's own auth status) after re-pinning.
- **Not offered:** `claude-mythos-5` and `claude-mythos-5-1` are in the 2.1.280 catalog (1M); whether
  the account can use them is unknown, so Verse does not list them.

### 1.3 Codex

Read from each seat's **own** `native-state/models_cache.json` (never the unpinned `~/.codex`, whose
catalog depends on a different account — the `identity` hashes differ). codex-b's catalog
(client 0.155.0, fetched 2026-09-23):

| Slug | Visibility | `context_window` | `max_context_window` | Standard: window / compacts | Expansive: window / compacts / told |
|---|---|---:|---:|---|---|
| `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` | list | 272,000 | 872,000 | 258,400 / 244,800 | 828,400 / 784,800 / 872,000 |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | list | 272,000 | 872,000 | 258,400 / 244,800 | 828,400 / 784,800 / 872,000 |
| `gpt-5.5` | list | 272,000 | 272,000 | 258,400 / 244,800 | — |
| `gpt-reserve`, `codex-auto-review` | **hide** | 272,000 | 872,000 | not offered | not offered |

(The global cache additionally lists `gpt-daybreak-blue-latest`; a seat whose catalog carries it gets
it on the same arithmetic.)

- **The denominator is 95 %.** Codex measures occupancy against
  `context_window × effective_context_window_percent / 100` = 258,400. Every one of 151,715
  `token_count` events in 1,388 September rollouts (CLI 0.136–0.155, every model) reports
  `model_context_window: 258400`.
- **The compaction point is 90 % of the raw window** — 244,800, or the entry's
  `auto_compact_token_limit` when the catalog sets one (none does today). Inferred, not read from code:
  of 149,307 calls followed by another call rather than a compaction, the largest was 244,662 — none
  reached 244,800. Codex can compact **earlier** than that: the calls immediately before its 2,939
  compactions ranged from 181,491 to 255,423 (median 227,452), apparently because its check also
  counts tool output added since the last call. The meter's compaction tick is therefore a ceiling,
  not a promise.
- **Expansive is real only where `max_context_window > context_window`.** Verse passes
  `-c model_context_window=<max>` **and** `-c model_auto_compact_token_limit=<90 % of max>` together,
  on both `exec` and `exec resume`. Setting only the window resets codex's token accounting and breaks
  auto-compaction ([openai/codex#16068](https://github.com/openai/codex/issues/16068)). The limit is
  90 % of the raw window — the same ratio codex applies to its default window.
- **No catalog yet.** codex-a has never run a turn, so it has no `models_cache.json`. Its models come
  from Verse's documented list (GPT-6 Astra/Sol/Luna, GPT-5.6 Sol/Terra/Luna, GPT-5.5) with the same
  arithmetic and `windowSource: 'documented'`, and the seat says so: *"Model list is Verse's built-in
  list until this seat's first turn fetches its own catalog."* Seats also run different binaries
  (codex-a 0.136, codex-b 0.155), which is why catalogs are read per seat.
- Hidden slugs are not offered. `gpt-reserve` was offered by 3.8 and should not have been.

### 1.4 Grok

Read from the seat's `native-state/models_cache.json` (grok 0.2.118). That file's `.models` is a
dictionary whose values also carry a per-model `api_key` field; Verse reads **only `.info`**.

| Id | Label (`info.name`) | Window | Compacts at |
|---|---|---:|---:|
| `grok-4.7` | Grok 4.7 | 500,000 | 400,000 |
| `grok-4.7-build-fast` | Grok 4.7 Fast | 500,000 | 400,000 |
| `grok-4.6` | Grok 4.6 | 500,000 | 400,000 |
| `grok-4.5` | Grok 4.5 | 500,000 | 400,000 |

- The compaction point is `auto_compact_threshold_percent` (80 in the catalog) of `context_window`.
  Grok's bundled docs give 85 as the `[session]` default; the seat sets no `[session]` block, and the
  catalog's per-model 80 is what Verse uses. A runtime `compact_boundary` shows which one actually won.
- Grok checks after a turn ("Auto-compact triggers next turn"), so one long turn can run past 400k
  toward 500k.
- No expansive mode: Grok's windows are fixed per built-in model, and its compaction threshold is
  settable only in the seat's `config.toml`, which Verse does not write.
- Runtime: the `result` line's `modelUsage` row can be keyed by a different id than the CLI was given
  (`grok-4.6-build` for `grok-4.6`), so Verse takes the single row that carries a numeric
  `contextWindow`.
- The catalog's `compactions_remaining: 1` is a server-sent quota field whose meaning is unresolved.
  Nothing in Verse is built on it.

### 1.5 Local (Ollama and llama-server)

Local seats run the Claude Code binary against a local Anthropic-compatible endpoint, so the window is
whatever the **runner** serves — and one resolver (`local-models.ts`) decides it, in this order:

1. **llama-server lane** (`ASHLR_VERSE_LOCAL_DISPATCH` / `cfg.verse.localDispatch = 'llama-server'`):
   the per-slot `n_ctx` — `/props.default_generation_settings.n_ctx`, else `/slots[0].n_ctx`, else
   `floor(-c / total_slots)`. The tag's Modelfile is irrelevant on this lane; today every tag gets
   65,536 (a 262,144 context split across 4 slots).
2. **Ollama, `num_ctx` pinned in `/api/show` parameters:** `min(num_ctx, native context_length)`.
   `qwen3.8:27b-ctx64k` pins 65,536 and always loads at 65,536.
3. **Ollama, not pinned:** `min(server default, native)`. The **server default** — what an unpinned
   request actually gets — wins over residency: `OLLAMA_CONTEXT_LENGTH` as the **running** server
   printed it in its config line in `~/.ollama/logs/server.log` (the macOS app does not share Verse's
   environment); the last `vram-based default context … default_num_ctx=N` line in that log; the same
   variable (> 0) in Verse's own environment. Only when none of those is known does the tag's `/api/ps`
   `context_length` count, because a resident runner may have been loaded by **another client** with
   its own `num_ctx` (a summarizer asking for 8k would otherwise shrink the seat to 8k, while Ollama
   reloads the tag at its default for Verse's own request). With none of these, the native
   (trained) length is used and marked `fallback`, because Ollama may allocate far less. A server
   default is only applied when the native length is known to cap it — a 262,144 VRAM default on an
   8k model would be a 32× overstatement. That default is **machine-dependent**:
   `qwen3.8:27b-q8_0` serves 262,144 here only because this machine has 107.5 GiB of VRAM.
4. **`/api/show` failed:** the tag suffix (`/(?:^|[:_-])ctx(\d+)k$/i`, which now also matches
   `-ctx64k`), then 65,536.

Window sources as built: the llama-server slot and a resident `/api/ps` context are `runtime`; a
pinned `num_ctx` and a server default are `provider-catalog`; the trained length, the tag suffix and
65,536 are `fallback`.

The compaction point is the Claude formula over that window with an unknown max output:
`W − 20,000 − 13,000` — **32,536 on a 64k tag**, 229,144 on a 256k one. Below about 33k the formula
reaches zero, so no compaction point is shown rather than a tick at the left edge. Verse passes
`CLAUDE_CODE_MAX_CONTEXT_TOKENS=<W>`, which Claude Code honours for any id that is not a Claude model;
without it the CLI prints *"set CLAUDE_CODE_MAX_CONTEXT_TOKENS to its real window"* and keeps the
session within the 200k it assumes. Local seats also pass `--exclude-dynamic-system-prompt-sections`,
which moves per-machine prompt sections (cwd, env, git status) into the first user message so the
system-prompt prefix is reusable across sessions.

**The window is refreshed before every local turn.** A session stores the window it was created with,
and the adapter passes exactly that stored `usage.contextWindow` as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.
So a record can go stale — a chat created when a tag resolved to 262,144 that now serves 65,536 would
tell the CLI 262,144 and overflow the runner again. Before each local turn launches, the engine
re-resolves the seat's window from live discovery and, when it differs, rewrites the stored window and
its compaction point (and emits a `context` event) first. The meter and the CLI therefore always use
one number, and it is the current one. When discovery cannot resolve the tag at that moment, the
stored window is kept rather than guessed.

**Seats too small to work are listed, not offered.** Claude Code compacts at `W − 33,000`, and its fixed
prompt on a local seat measured about 15k (14,695 and 14,942 context tokens for a one-word reply,
with `--exclude-dynamic-system-prompt-sections`). A window under **56,000**
(`LOCAL_MIN_USABLE_WINDOW` = 15k base prompt + 8k minimum working room + 20k output reserve + 13k
buffer) would compact on every turn, so such a tag is listed **disabled, with the reason**
(`unavailableReason`) instead of being offered — e.g. a 32,768-token `qwen2.5-coder` or a `-ctx32k`
pin. Serve it with a larger `num_ctx` to use it. An existing local chat whose tag now resolves below that
is refused at its next turn (409 `VERSE_MODEL_UNAVAILABLE`, with the reason) before any CLI starts.

A 64k local seat is small on purpose — it is the free lane — and it is tight: the fixed prompt alone
takes about 15k of its 32,536-token compaction point, leaving roughly 17k of working room before the
first compaction. Use an unpinned or larger-`num_ctx` tag for long local sessions.

### 1.6 The formulas (`context-math.ts`)

| Function | Formula | Worked |
|---|---|---|
| `claudeAutoCompactAt(W, maxOut, autocompact)` | `min(W, autocompact ?? W) − min(maxOut ?? 20k, 20k) − 13,000` | 1M at `auto` → 967,000; at 400k → 367,000; 200k → 167,000 |
| `codexEffectiveWindow(raw, pct)` | `floor(raw × (pct ?? 95) / 100)` | 272k → 258,400; 872k → 828,400 |
| `codexAutoCompactAt(raw)` | `floor(raw × 0.9)` | 272k → 244,800; 872k → 784,800 |
| `grokAutoCompactAt(W, pct)` | `floor(W × (pct ?? 80) / 100)` | 500k → 400,000 |
| `budgetFor(option, mode)` | standard = the option's window + compaction point; expansive = `option.expansive` or **null** | a mode a model lacks is absent, never faked |
| `claudeAutocompactFlag(option, mode)` | `400000` for a 1M model in standard; null (= `auto`) otherwise | 200k models get no flag: they already compact near 167k |
| `reconcileAutoCompactAt(…)` | recompute for a runtime window that differs from the budget | claude/local: the formula above; codex: 90 % of the raw window the effective one implies; grok: keep the ratio |

Claude Code's other thresholds, for reference: it warns 20,000 before the compaction point and blocks
input 10,000 after it (1M at `auto`: warns 947k, compacts 967k, blocks 977k). `--autocompact` accepts
100k–1M and is capped at the model's window. A background pre-compaction flag
(`tengu_amber_moleskin`) may start earlier in some modes; it is not fully traced and Verse does not
model it.

### 1.7 Occupancy: what `contextTokens` measures

`contextTokens` is the **prompt size of the most recent model call** — live context occupancy, not a
running total:

- **Claude, Grok, local:** the last call's `input + cache_read + cache_creation` (the buckets are
  disjoint). Grok's own count also includes the previous call's output, so Verse's reading can be one
  output short of Grok's.
- **Codex:** `codex exec --json` never reports per-call usage. `turn.completed.usage` is a sum over
  every model call in the turn (a 20-call turn reports ~20× the live prompt), and on `exec resume`
  codex seeds that sum from the rollout, so it is the **thread's** running total, not the turn's.
  Until the rollout is readable, a reading is flagged `contextTokensExact: false` and drawn with a
  "≤" prefix. The truth is in the seat's own rollout
  (`<native-state>/sessions/YYYY/MM/DD/rollout-<local ts>-<threadId>.jsonl`, found under the seat's
  launcher directory the same way `accounts.ts` already finds codex sessions), which records one
  `token_count` per model call:
  - the **reading** is the last one's `info.last_token_usage.total_tokens` — the last call's prompt
    plus its reply, which is the quantity codex compares with its compaction limit and the size the
    next call starts from — against its `info.model_context_window`;
  - the turn's **usage** — exactly one `usage` event per turn, emitted after the process exits — comes
    from the best evidence the rollout holds: the CLI's own per-turn `token_usage_record` (CLI 0.149+),
    else the sum of this turn's calls, else the printed figure converted to a delta against the
    rollout's running total. A resumed thread is never counted twice: `exec resume` seeds codex's
    counter from the rollout, so the printed `turn.completed` figure is **thread-cumulative**, and
    Verse uses the rollout's per-turn sums instead. With no readable rollout the printed figure is
    used as-is and the reading is marked as an upper bound. A compaction's own request never appears
    as a `token_count`; only the 0.149+ per-turn record counts it, so before CLI 0.149 no codex
    output counts compaction requests — Verse's totals then match the CLI's own, both short by the
    compactions.

  Verse reads the rollout every 2 s while a codex turn runs and once after it, and emits `context`
  events with `exact: true`. Reads are bounded: the first looks at most 2 MB back from the end
  (widening to a hard cap only when the turn began further back), later ones scan only what was
  appended, and a `compacted` line — routinely 2–17 MB, since it embeds the replacement history — is
  classified from its head and never held whole. A pruned, rewritten or missing rollout yields no
  reading, never an error.
- Readings are stored **unclamped.** A reading above the window is information — the CLI is about to
  compact or overflow — and the meter shows it as such rather than pinning at 100 %.

---

## 2. Context modes and the large-window policy

### 2.1 The two modes

| Mode | Claude 1M models | Claude 200k models | Codex (872k-capable) | Codex GPT-5.5 | Grok | Local |
|---|---|---|---|---|---|---|
| **standard** (default for new chats) | compacts at **367k** (`--autocompact 400000`) | compacts at 167k (no flag) | 258.4k / compacts at 244.8k (no flag) | same | 500k / compacts at 400k | resolved window |
| **expansive** (opt-in) | compacts at **967k** (`--autocompact auto`) | — | 828.4k / compacts at 784.8k (`-c` pair) | — | — | — |

- The mode is **per session** (`session.contextMode`). It changes between turns —
  `POST /api/verse/sessions/:id/context-mode`, refused with `VERSE_SESSION_BUSY` while a turn runs —
  and applies from the next one. A mode the session's model has no budget for is rejected
  (`VERSE_INVALID`), not approximated.
- New sessions take the **seat's preferred mode** from `~/.ashlr/verse/preferences.json`
  ("Make default for this seat" in the new-chat dialog), else standard, and **always record it** —
  `contextMode: 'standard'` is written explicitly — so a record with no `contextMode` is reliably one
  created before V3.9.
- **Sessions from before V3.9 keep the window they ran with.** Verse 3.5–3.8 passed no
  `--autocompact`, so an old Claude chat on a 1M model compacted near 967k. A Claude record with no
  `contextMode` therefore resolves to **expansive** when its model has an expansive budget; the engine
  writes `contextMode: 'expansive'` into the record the first time the session is loaded (engine
  start, list, get or a turn), without bumping `updatedAt`, and the adapter passes `--autocompact auto` — exactly the old behaviour, so upgrading
  compacts nothing. The operator can switch such a chat to Standard like any other (see the next
  point for what that costs). Claude 200k models, Codex, Grok and local records with no `contextMode`
  resolve to standard, which is what they already ran at. A pre-V3.9 launch record states no budgets;
  the engine and the adapters borrow them from the same documented model table the live seat uses
  (`legacyModelOptionFallback`), so an old Codex chat on GPT-6 / GPT-5.6 can switch to expansive like
  a new one, and the mode the UI offers is always one the engine accepts.
- Switching mode changes **CLI flags, never prompt content**. Standard → expansive is always free and
  keeps the prompt cache: the compaction window is a client-side threshold, not part of the request.
  **Expansive → standard is free only while the session is below the standard compaction point.**
  Above it — a Claude chat at 600k switched to Standard (compacts ≈367k), or a Codex chat at 500k
  switched back (the `-c` pair is dropped and compaction returns to 244.8k) — the CLI compacts on the
  **next turn**: it reads the whole context to write a summary, which **spends usage on a paid seat**,
  replaces early turns with that summary and starts a new prompt cache. The mode menu says so before
  you switch.
- Verse **never switches mode by itself.** (Recording `expansive` on a pre-V3.9 Claude record is not a
  switch: it writes down the mode that session already ran in.) It may *suggest* expansive (`expansiveAdvice`) — only for a
  standard session whose model has a real expansive budget, and only on evidence: the session has
  already compacted at least twice, or the reachable code only fits the expansive budget (§5). The
  suggestion names its reason and states the usage cost.

### 2.2 Why standard is not the full window

"Bigger is better" fails on both axes that matter.

**Quality degrades with length.** Every published long-context study finds the same shape:

- Chroma's *Context Rot* (Jul 2025, 18 models): accuracy fell as input grew even on trivial tasks; on
  LongMemEval a focused ~300-token prompt beat the full ~113k one.
  ([trychroma.com/research/context-rot](https://www.trychroma.com/research/context-rot))
- Du et al., EMNLP Findings 2025: length alone cost 13.9–85 % even with perfect retrieval and masked
  distractors; having the model quote its evidence first recovered much of it.
  ([arXiv 2510.05381](https://arxiv.org/abs/2510.05381))
- NoLiMa (ICML 2025): most tested models fell below half their short-context score by 32k.
  ([arXiv 2502.05167](https://arxiv.org/abs/2502.05167))
- MRCR v2 8-needle at 512k–1M (vendor numbers via secondary compilations; indicative only): GPT-6 Astra
  96.3 %, GPT-5.6 Sol 73.8 %, Opus 4.7 32 %. No MRCR is published for Opus 5.x.
- The counterpoint, and why expansive exists at all: the Opus 5.5 system card (§8.10–8.12) reports
  ProgramBench — agentic coding episodes up to 1M with no compaction — at Opus 5.5 91.2, Fable 5.1
  87.6, Opus 5 85.4. The newest Claude models hold up in long agentic runs; they are not free there.

**Cost grows with the prefix, every turn.** Each turn re-sends the whole conversation, so a session's
cost grows roughly with the square of its turn count, and the size at which a session is *held* sets
the price of every call after it. Anthropic's own API compaction triggers at **150,000** input tokens by
default ([compaction threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)),
and Claude's `/usage` on this machine attributes 68 % of a day's usage to calls "at >150k context".

**Why 400k (compacting at 367k).** It keeps a large working set — well over twice Anthropic's own
150k default — while bounding the re-read. A session held near 900k re-reads about 2.3× what one held
under 400k does. Grok's native budget is also 400k, so the two frontier engines share one standard
ceiling, and the full window is one click away. Codex's standard is its CLI default: it never crosses
the 272k line where Codex's pricing changes (§2.3).

### 2.3 Cost math

One call just before compaction, with 8k new tokens and 1.5k of output, warm cache, at the API list
prices embedded in the 2.1.280 catalog (1-hour cache writes, which is what a subscription gets within
plan usage). API prices stand in for subscription usage, which Anthropic does not itemise — **how
subscription limits weight cache reads is not documented.**

| Model | Held at 367k (standard) | Held at 967k (expansive) | Ratio | Cache miss at 367k vs 967k (idle > 1 h) |
|---|---:|---:|---:|---|
| Opus 5.5 ($4 / $20, read $0.20, 1h write $8 per MTok) | $0.166 | $0.286 | 1.7× | $2.97 vs $7.77 |
| Fable 5.1 ($10 / $50, read $0.25, write $20) | $0.325 | $0.475 | 1.5× | $7.42 vs $19.41 |
| Opus 5 ($5 / $25, read $0.50, write $10) | $0.297 | $0.597 | 2.0× | $3.71 vs $9.71 |
| Sonnet 5 ($2 / $10, read $0.20, write $4) | $0.119 | $0.239 | 2.0× | $1.48 vs $3.88 |

- The ratio compounds: every turn after the session passes 367k pays it again, and each compaction is
  itself a full-window read plus a summary.
- The cache-miss column is why an idle long session is the single most expensive thing Verse can let
  happen: past the cache TTL (1 h on a subscription, 5 min once usage credits are in play) the next turn
  re-writes the whole prefix.
- **Codex:** above 272k, GPT-5.6 reportedly bills the whole request at 2× input and 1.5× output and
  counts 2× against usage limits; GPT-6 Astra is reportedly exempt. Both claims rest on single
  secondary sources — check the usage meter. OpenAI attributed its own cut of Codex from 372k to 272k
  to cache reads growing with context. Standard mode never crosses 272k; expansive does by design.
  So the token ratio the mode menu quotes for Codex (784.8k / 244.8k ≈ 3.2× the re-read near the
  limit) is **not** a usage ceiling there: if the single-source 2× metering holds, a turn held near
  785k counts roughly 6× a standard one against plan limits. The Codex copy says so, with the same
  hedge.
- **Grok:** above 200k every rate doubles for the whole request
  ([docs.x.ai pricing](https://docs.x.ai/developers/pricing)). That includes Grok's standard budget
  (compacting at 400k), which Verse cannot lower per invocation — the handoff banner (§4) is the lever.
- **Fable in `-p` mode** can bill usage credits on some plans without a consent prompt
  ([model config](https://code.claude.com/docs/en/model-config)). Watch the seat's credit state.

### 2.4 When expansive is worth it

Use expansive when the task needs more than ~150k tokens **visible at once** and cannot be split:
a whole-repo migration or upgrade, a cross-cutting refactor with shared invariants, a large-diff or
architecture review, correlating several logs or traces, or checking a spec against the code. Prefer
Opus 5.5 (best ProgramBench score, under half of Fable 5.1's per-token price) and, on Codex, GPT-6
Astra (strongest reported long-context retrieval). In an expansive run, state the invariants at both
the start and the end of the prompt and ask the model to quote its evidence before editing — the one
intervention the length studies found to recover accuracy.

### 2.5 When neither: split

When the work divides, several lean contexts beat one overloaded one. Anthropic's multi-agent research
system beat a single agent by 90 % at about 15× the tokens, with token usage explaining 80 % of the
variance ([anthropic.com](https://www.anthropic.com/engineering/multi-agent-research-system)). A working
set too large for any single budget gets the fit verdict **split** (§5): fan the work out across
sessions, or narrow the scope, instead of enlarging one context.

---

## 3. Compaction per engine

Every CLI compacts its own conversation; Verse observes, counts and explains it, and never replaces it.
Each native compaction becomes a persisted `compaction` event (`session.compactionCount` increments)
and a divider in the transcript.

| Engine | How Verse sees it | Counts |
|---|---|---|
| Claude, local | stream-json `{"type":"system","subtype":"compact_boundary","compact_metadata":{trigger, pre_tokens, post_tokens?, duration_ms?}}` | the CLI's own: "Auto-compacted 967k → 19k in 1m 58s" |
| Grok | the same `system/compact_boundary` line in `streaming-messages-json` | the CLI's own |
| Codex | `exec --json` has **no** compaction item; the rollout records a top-level `compacted` line. Verse counts those written during the turn and emits one event each (trigger `auto`), mid-turn from the live poll once the reading after it lands, else after the turn | **bracketing readings**: `preTokens` is the last `token_count` before the `compacted` line, `postTokens` the first after it (codex writes one straight after compacting); `durationMs` is null. The divider then reads like Claude's ("Auto-compacted 240k → 35k"); a side with no reading stays null, and with neither it says "Codex compacted its context" |

- A compaction **is** a model call on the seat's account: the CLI reads the whole window and writes a
  summary. It happens inside a turn the operator started; Verse never triggers one on its own.
- **Compact now.** On **every** Claude and local session the operator can compact on demand, from the
  chip beside the meter — the Standard / Expansive chip, or a chip reading **Context** on a model with
  one budget (a local chat, Opus 4.5, Haiku 4.5), whose menu holds just this item; it is disabled until
  the chat has had a turn — and from the handoff banner (§4) when that shows. Verse sends `/compact` as an ordinary turn, through the same `startTurn` gate as every turn. Headless `/compact`
  was verified on a local seat — the CLI emitted `compact_boundary` with trigger `manual`,
  14,988 → 1,750 tokens, in about 156 s on a 27B model over a 15k context — the divider reads
  "Compacted on request …" and the meter then shows the post-compaction figure. On a local seat it is free (but slow); **on a paid seat it spends
  usage**, because the CLI reads the whole window to write the summary. That spend is not itemised
  per turn: a `/compact` turn's `result.usage` is all zeros and `modelUsage` is cumulative (§1.1).
  Not offered on Codex or Grok, whose headless manual compaction Verse has not verified.
- After a compaction the meter drops. The divider says why, so the drop is never unexplained.
- The meter warns at **80 %** of the compaction point and turns red at **95 %** — *before* the CLI
  compacts, not after (the old fixed 70 / 90 % of the window went red after Grok and Codex had
  already compacted). Standard Claude 1M: warns ≈ 294k, red ≈ 349k. Codex: ≈ 196k / 233k. Grok:
  320k / 380k.
- Two compactions is Verse's threshold for "early turns now survive only as summaries"
  (`HANDOFF_COMPACTION_THRESHOLD`), which feeds both the handoff advice (§4) and the expansive
  suggestion (§2.1).
- **Compact now** is the only manual compaction, and only the operator presses it. The handoff (§4)
  is the alternative that starts clean instead of summarising in place.

---

## 4. Handoff — continue in a fresh chat

A long session eventually costs more per turn than it is worth: it is near its compaction point, it has
compacted repeatedly, or it has sat idle past the cache TTL with a large context. `handoffAdvice`
reads those signals (pure; nothing spends) and the UI shows a banner under the meter:

| Signal | Level |
|---|---|
| Occupancy past the window | urge |
| ≥ 80 % of the compaction point | suggest |
| ≥ 2 compactions | suggest |
| Idle ≥ 1 h with ≥ 100k tokens in context | suggest |

The occupancy and idle signals need an **exact** reading. An upper bound (a codex figure drawn with
"≤", §1.7) can sum every call in a turn — a median 29× the real prompt — so it never raises "past the
window", "near compaction" or the idle warning; the meter's tone is `unknown` when such a bound passes
the compaction point, and the advice waits for the rollout reading. The compaction count still counts.

**What the handoff is.** A deterministic note built from the session's own event log
(`session-handoff.ts`, `POST /api/verse/sessions/:id/handoff-preview`). It is a POST only because it
runs `git`; it spends nothing. Being a POST, it is dispatch-gated like every other POST: on a
read-only server (`allowDispatch` off) it answers 404. Sections, highest priority first:

1. the operator's focus line, if given (≤ 500 chars);
2. the goal — the first user message;
3. the latest asks — the last three user messages;
4. the state — the last assistant message abridged to its head and tail, or verbatim (capped at 6,000
   characters) when the operator asked the seat to summarize first;
5. files the agent read or edited, from tool inputs (Read / Edit / Write / MultiEdit / NotebookEdit,
   Codex `file_change`, and Grok's equivalents), deduplicated, ≤ 60;
6. commands run, the most recent ≤ 15;
7. errors, the most recent ≤ 5;
8. the roots, each with a bounded `git -C <root> diff --stat HEAD` (3 s and 4 KB per root, 6 s in
   all);
9. compactions so far.

The note prefers paths to contents: the next agent has the filesystem, and a file it reads itself is
current where a pasted copy is already stale. It is capped at 12,000 characters
(`VERSE_HANDOFF_MAX_CHARS`, ≈ 3k tokens); when it would exceed that, whole sections are dropped
lowest-priority first and **named** in `stats.truncated`. Every section is passed through
`scrubSecrets` before it is measured, so the cap holds on the text actually returned. The same log
always produces the same note.

**The flow.**

1. **Continue in a fresh chat…** opens the handoff dialog with the preview in an editable box, its
   stats (characters, estimated tokens, turns covered, files touched, what was cut), and a target
   seat / model / mode picker showing the fit verdict for the note's size. Any seat is a valid target —
   a Claude session can continue on Codex, which no single-vendor CLI can do.
2. **Ask *seat* to summarize first** (optional; the button names the seat) sends one ordinary turn to
   the *current* session — it spends, is labelled as such, and runs through the same gate as every
   turn — then re-builds the preview with that reply included verbatim. The turn's text is the fixed
   `VERSE_HANDOFF_SUMMARY_REQUEST` (`types.ts`), which asks for a note covering goal, decisions and
   their reasons, state, files, verification commands and open risks, under 600 words, with no file
   edits or commands. The handoff builder recognises that exact text — and the `/compact` turn that
   **Compact now** sends — and leaves both out of the goal and "latest asks", so the new chat is told
   to continue the work, not to write another handoff note.
3. **Create** makes the new session with `handoffFromSessionId`. The server resolves the source's title
   itself and pins `handoffFrom`; the new transcript opens with "Continued from *title*". Creating
   is free.
4. The new session's composer is pre-filled with the note. **Nothing is sent until the operator presses
   send** — that first turn is the only spend, and it is the operator's.

This is not `src/core/verse/handoff.ts`, which is the typed planner-to-worker handoff for the local
fan-out (6,000-character cap). The two share rules — deterministic, paths rather than contents,
nothing spent to build them — not code.

---

## 5. Context fit

`GET /api/verse/context-fit` answers "how big is the code this session can reach?" for a folder or a
workspace, so the new-chat dialog can show a verdict per model before anything runs. It takes
`?workspaceId=` or `?projectPath=` with `extraRoots` **repeated** once per root (a comma is legal in a
path); an unknown or duplicated query parameter is a 400, and a root deleted since it was added is a
400 rather than a count of zero.

- For each root: `git -C <root> ls-files -z`, stat sizes, skip files over 1 MB and known binary
  extensions, at most 20,000 files and 5 s per root. `estTokens = bytes / 4` (the estimator is named in
  the response, `'bytes/4'`, so a better one can be introduced honestly). A root that hit a cap is
  marked `truncated` and its estimate is a floor. Results are cached for 60 s per root and HEAD commit.
- `fitVerdict(workingSet, model, overhead)` adds the engine's fixed session overhead — the base
  prompt a fresh session already occupies (`sessionOverheadTokens(engine)`): **local 15,000**
  (measured, §1.5), **claude 25,000**, **codex 15,000**, **grok 20,000** — and compares against the
  **standard compaction point**. Only the local figure is a measurement; the other three are
  estimates (Claude from the same CLI measured without the dynamic-section flag, rounded up; Codex and
  Grok report no base prompt), and the UI labels every verdict as an estimate. An unknown engine
  uses 25,000:

| Verdict | Condition | Meaning |
|---|---|---|
| **fits** | ≤ 60 % of the standard compaction point | room to work |
| **tight** | ≤ 100 % of it | fits, but the session will compact soon |
| **expansive** | only the expansive budget holds it | worth the mode for coupled work (§2.4) |
| **split** | no single budget holds it | fan out or narrow the scope (§2.5) |

The verdict is null when a model's budget is unknown — never guessed. It answers "could all the
reachable code sit in one context", which is the question that decides expansive versus split for
cross-cutting work; most tasks touch a fraction of it. On a 64k local seat (compacts at 32,536, no
expansive) a working set **fits** up to about 4.5k tokens and is **tight** up to about 17.5k, so a
handoff note (≤ 12,000 characters, ≈ 3k tokens) fits, while almost any real repository or workspace
shows **split** — which is true: its code cannot all be in view at once there.

---

## 6. Shared project memory

Seats run in isolated homes (each launcher pins `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME` to its
own `native-state`), so none of the vendors' own memory features reach them, and a Claude session and a
Codex session on the same project start knowing nothing the other learned. Verse gives every seat on a
project one shared directory instead:

```
~/.ashlr/verse/memory/<basename-slug>-<sha256(realpath)[0:12]>/MEMORY.md     (dir 0700, files 0600)
```

- **Outside the repository on purpose.** Memory never lands in a working tree, never appears in a diff,
  and is not a workspace root. The hash of the real path keeps two checkouts named `api` apart.
- **One fixed block per session.** At creation Verse snapshots a short instruction block — where
  memory lives; read `MEMORY.md` before substantial work; keep it a concise index (≤ 200 lines) of
  durable facts **with their reasons** (decisions, conventions, gotchas, plan status); update it at
  milestones; never store secrets — plus the current `MEMORY.md`, secrets scrubbed and truncated with
  a marker, ≤ 6 KB in all, with control characters (NUL above all) stripped so the block is always safe
  to pass on a command line. The **same bytes** are sent every turn, so the prompt prefix stays
  cache-stable; agents read the live file from the directory. The snapshot is pinned in the launch
  record (`VerseSeatLaunch.memory`), like the roots.
- **Per engine:**

| Engine | Reach | How the block is delivered |
|---|---|---|
| Claude, local | read + write | `--add-dir <dir>` grants the directory; `--append-system-prompt=<block>` carries the block |
| Codex | read + write | `-c sandbox_workspace_write.writable_roots=[…]` grants the directory (the existing extra-roots override); `-c developer_instructions=<block>` carries the block. Both are `-c` overrides because `exec resume` accepts `-c` but not `--add-dir`, and turn 1 and turn N must launch with the same settings |
| Grok | **read-only: the snapshot in the block** | `--rules=<block>` (Grok's "extra rules to append to the system prompt", alias `--append-system-prompt`; Grok wraps the text in a `<human_rules>` block appended to its default prompt). Grok's CLI can be granted nothing beyond `--cwd`, so the directory is never granted and the block says memory is read-only for this seat (`writable: false`) |

- **What it costs.** Memory is not free on a paid seat. The block (≤ 6 KB, roughly 1.5k tokens) is
  part of the system prompt of every turn of every new session on a memory-enabled project — Claude,
  Codex and Grok alike; it is served from the prompt cache after the first turn, but cached tokens
  still count. On writable seats the block also asks the agent to read `MEMORY.md` before
  substantial work and update it at milestones, which is extra tool calls and output. On a local seat
  it costs nothing but context room. To opt out, switch memory off for the project — or for every
  project — in the Resources panel (`POST /api/verse/preferences` with `{projectPath, memoryEnabled}`
  or `{memoryEnabled}`); existing sessions keep the setting they were created with.
- **On by default**, with a per-project opt-out (`preferences.memory`). A session records whether memory
  was offered (`session.memoryEnabled`): every new session says `true` or `false` — `false` when
  memory is off for the project or could not be set up — and only records from before V3.9 lack the
  field. A project whose memory is disabled never gets it, and a preference change never gives a
  running session a directory it was created without.
- **The operator owns it.** The Resources panel shows the memory for the current project — view,
  edit, save, clear, the other files the agents created there, and the enable switch.
  `POST /api/verse/memory` writes atomically, 0600. The file's content is capped at 64 KiB
  (`VERSE_MEMORY_MAX_BYTES`); that route alone accepts a request body of up to 2 × 64 KiB + 8 KiB
  (139,264 bytes), so a full-size file still fits after JSON escaping. Every other POST keeps the
  64 KiB body cap.
- **The editor sees a sanitized view.** Every API response passes `sanitizePublicJson`, which rewrites
  the home directory as `~` and replaces secret-shaped text with `[REDACTED]`. `GET` and `POST /memory`
  therefore add `contentSanitized: true` whenever the content sent differs from the file on disk
  (absent otherwise). A save whose content holds **more** `[REDACTED]` markers than the file on disk —
  one that would write the placeholders over the real values — is refused with **409
  `VERSE_MEMORY_REDACTED`**; edit `MEMORY.md` directly in that case. The `~` rewrite is not refused
  (it names the same path for every reader), and a file that already contains the literal marker stays
  editable.
- **What it is not:** it is not the vendors' auto-memory and not a background consolidation job. Codex
  memories, Claude's auto-dream and Grok's memory all run extra model calls on their own schedule, which
  spends; Verse leaves them off.

---

## 7. Session search

`GET /api/verse/search?q=&limit=` — keyword search across past sessions, from the sidebar. Terms (up
to 8, in a query of up to 200 characters) are AND-ed and case-insensitive; only user and assistant
messages are searched, not tool output; scores decay with age (a 14-day half-life), and a session
contributes at most 3 hits. The scan is bounded — the newest ≤ 200 sessions and ≤ 20 MB of message
text — and the response says how many sessions it scanned and whether it stopped early. `limit`
defaults to 20, at most 50; each hit carries a ≤ 240-character, whitespace-collapsed,
`scrubSecrets`'d snippet around the first match. No index, no embeddings, no network, no spend: it
reads Verse's own session store.

---

## 8. Efficiency

Computed **client-side** from usage Verse already stores — no new server state:

- **Cache-hit ratio** = `cacheRead / (input + cacheRead + cacheCreation)`. Adapters report
  `inputTokens` excluding cached tokens, so the buckets are disjoint. Per session in the Resources panel
  and aggregated per seat in Usage. Null until something has been read.
- **Average and peak context per turn**, and the **compaction count**.
- **Idle-cache warning** once a session holding more than its fixed prompt has been idle past
  `CACHE_IDLE_TTL_MS` (1 h): the next turn re-reads the whole context uncached. Idle is timed from the
  last turn in the event log, not from `updatedAt`: a rename or a mode switch moves `updatedAt` but
  sends nothing to the provider, so it does not warm the cache.
- The window's **source** (§1.1), so an estimate is visibly an estimate.

What breaks the prompt cache, so the numbers make sense: switching model; changing effort (except on
Opus 5.5 and Fable 5.1); connecting or disconnecting MCP servers or plugins; a compaction; a CLI
upgrade (a re-pin). Verse holds the rest constant by design: an empty, fixed MCP set, the memory block
snapshotted at creation, and on local seats the dynamic prompt sections moved out of the system prompt.
Switching to expansive does not break it; switching back to standard does only when the session is
already past the standard compaction point, because the next turn then compacts (§2.1).

---

## 9. Honesty rules

- **Null is unknown, never zero.** An unknown window shows `n/a`; an unknown compaction point draws no
  tick; an unknown budget gives no fit verdict.
- **Every window carries its source.** `fallback` is marked as an estimate.
- **An upper bound is labelled as one:** `contextTokensExact: false` draws "≤", and never claims more
  than it knows — no "over the window" tone and no near-compaction or idle advice from a bound (§4).
- **Readings are stored unclamped.** Over-window is a state the meter shows, not a number it hides.
- **The runtime wins.** A CLI's own reading replaces any catalog value (except on local seats, where the
  CLI would only echo Verse's number).
- **A mode a model lacks is absent,** never approximated. No expansive on Grok, local, GPT-5.5 or the
  200k Claude models.
- **Unavailable models are listed with their reason,** not hidden, so the operator learns why.
- **Advice suggests, never acts.** Verse never switches mode, compacts, summarizes or sends a handoff on
  its own.
- **Nothing is invented from a single source.** Figures resting on one secondary source (Codex's 2×
  above 272k, Astra's exemption) are labelled as such.
- **The model never sees the meter.** No remaining-context countdown is injected into prompts —
  Anthropic's migration guidance warns that one makes Fable 5.1 economise prematurely ("context
  anxiety"); the meter is UI-only.
- **Secrets never reach a prompt or a response.** The handoff note and the memory block are
  `scrubSecrets`'d; the Grok catalog's `api_key` fields are never read; API output passes
  `sanitizePublicJson`.

---

## 10. What spends, and what does not

Every model call goes through Verse's one chokepoint, `startTurn`, which carries the local-only gate
(`policy/local-only.ts`): under local-only, paid seats are refused and loopback seats are allowed.
Nothing in V3.9 adds a model call.

| Free — deterministic, no model call | Spends — only when the operator presses send |
|---|---|
| Window discovery (reads catalog files on disk) | Every turn on a paid seat |
| The meter, its tick, `context` telemetry (reads rollout files) | Native compactions, inside a turn (the CLI's own summary call) |
| **Compact now** on a local seat | **Compact now** on a paid Claude seat — one `/compact` turn |
| Compaction events and the dividers | "Ask *seat* to summarize first" — one ordinary turn |
| Handoff preview (event log + `git diff --stat`) | A handoff's first turn in the new session |
| Creating a session, including a handoff session | Expansive mode's larger re-read on every later turn |
| Context fit (`git ls-files` + `stat`) | The memory block's ≤ 6 KB on every turn (cached after the first), plus the agent's `MEMORY.md` reads and updates — on by default; opt out per project or globally (§6) |
| Session search, memory read/write, preferences, efficiency stats | Switching an expansive session to standard **above** the standard compaction point — the next turn compacts (§2.1) |
| Switching mode below the standard compaction point (a flag; the cost lands on later turns) | |

Local seats run on this machine and cost nothing at the margin.

---

## 11. Known limits and open questions

- **Compact now on a paid seat** was not run for real (it would spend); headless `/compact` was
  verified on a local seat, which runs the same Claude Code binary. Its spend on a paid seat is not
  itemised per turn (§3).
- **Codex `developer_instructions` on resume:** Verse sends the memory block on **every** `exec` and
  `exec resume`, and must keep doing so. Codex diffs each turn's developer context against a baseline
  it persists in the rollout, and in ~4,000 local rollouts an unchanged section was never re-emitted, so
  an identical block should be a no-op — but no local rollout has yet carried a non-empty
  `developer_instructions` or an `exec resume` thread, so that is unverified without a paid run. Sending
  it on turn 1 only would be **wrong**: compaction rebuilds the developer context from the current
  process's settings, so a resume launched without the key would lose the memory at its first
  compaction. If a real multi-turn rollout ever shows the block repeating, the fix is upstream in
  Codex, not turn-1-only (the reasoning is in the `memoryOverrides` comment in
  `src/core/verse/adapters/codex.ts`).
- **A codex seat with no catalog yet** runs on Verse's built-in list, which leads with GPT-6 Astra;
  an older binary (codex-a runs 0.136, whose bundled catalog has no GPT-6 or GPT-5.6) may reject that
  id on the first turn.
- **Grok's threshold:** the catalog's 80 % vs the documented 85 % `[session]` default. Verse uses 80;
  a runtime `compact_boundary` settles it per seat. `compactions_remaining` is unexplained and unused.
- **Codex can compact below its tick** (observed from 181,491). The tick is a ceiling.
- **GPT-5.6 Sol at 872k** is in the catalog, while an upstream issue
  ([openai/codex#39144](https://github.com/openai/codex/issues/39144)) reports 272k in practice. The
  runtime reading will show which.
- **Ollama's default window depends on the machine's VRAM.** A tag that serves 256k here can serve far
  less elsewhere; the resolver reads the running server, not an assumption.
- **The claude-a seat is pinned to 2.1.257.** Opus 5.5 stays unavailable there until the seat is
  re-pinned to 2.1.280 or later (`ashlr resources profile repin`). Sessions created under the old
  `claude-opus-5.5` id keep that id in their record (they ran Opus 5), but their turns now ask for
  the real `claude-opus-5-5`, which a 2.1.257 binary does not know. Verse refuses such a turn up
  front (409 `VERSE_MODEL_UNAVAILABLE`, with the reason) rather than starting a CLI that would answer
  `[claude-code:unrecognized_model]`. Re-pin the seat, or continue the session in a fresh chat on a
  runnable model.
- **The meter measures the prompt, not the reply.** A single huge reply can still push a session past
  its compaction point within one turn.

## Sources

Local (read-only):

- Claude Code binaries `~/.local/share/claude/versions/2.1.257` and `2.1.280` (embedded model catalog,
  `--autocompact`, `--append-system-prompt`, `--add-dir`, `--exclude-dynamic-system-prompt-sections`,
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `compact_boundary` — every flag Verse passes exists in both, and
  each new one was also accepted by both binaries' option parsers, §1.2);
  `~/.claude/cache/model-catalog/*.json` (`min_claude_code_version: 2.1.280` for `claude-opus-5-5`);
  `~/.ashlr/agent-logs/*.log` (runtime `modelUsage`); `~/.claude/projects` (observed compactions).
- Seat catalogs `~/.ashlr/native-profiles/{codex-b,grok-a}/native-state/models_cache.json`; seat pins in
  each `profile.json`.
- All 1,388 September Codex rollouts under `~/.codex/sessions` (151,715 `token_count` events, 149,307
  uncompacted calls, 2,939 compactions), re-scanned 2026-09-23.
- Ollama 0.33.3 `/api/tags`, `/api/show`, `/api/ps`, `~/.ollama/logs/server.log`; llama-server `/props`,
  `/slots`.
- Verse's own store `~/.ashlr/verse/sessions/`.

Published:

- Claude Code: [model config](https://code.claude.com/docs/en/model-config) (1M defaults, the ≈ 967k
  point, `--autocompact`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`),
  [prompt caching](https://code.claude.com/docs/en/prompt-caching) (TTL, invalidators),
  [costs](https://code.claude.com/docs/en/costs).
- Anthropic: [compaction threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold),
  [effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
  [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).
- Codex: [openai/codex#16068](https://github.com/openai/codex/issues/16068),
  [openai/codex#39144](https://github.com/openai/codex/issues/39144).
- xAI: [pricing](https://docs.x.ai/developers/pricing); Grok's bundled docs
  (`native-state/docs/user-guide/14-headless-mode.md`).
- Long-context evidence: [Chroma, Context Rot](https://www.trychroma.com/research/context-rot);
  [arXiv 2510.05381](https://arxiv.org/abs/2510.05381); [NoLiMa, arXiv 2502.05167](https://arxiv.org/abs/2502.05167).
