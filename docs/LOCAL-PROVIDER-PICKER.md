# Local Provider Picker — plan & handoff

**Status:** design agreed · not yet implemented
**Last session:** 2026-06-20
**Goal:** At onboarding, let the user *choose and set up* a local model runtime
(no bundled dependency, no vendor lock-in) so `ashlr run`/`swarm` default to free
local compute instead of falling through `providerChain` to paid Anthropic cloud.

---

## Context captured this session

- Machine had **no local provider** installed → `providerChain`
  (`lmstudio → ollama → anthropic`) was falling all the way through to **paid cloud**.
- Installed **Ollama 0.30.9** via `winget install Ollama.Ollama` →
  `C:\Users\User\AppData\Local\Programs\Ollama\ollama.exe`.
- Server confirmed up on `:11434`. Pulling `llama3.2:3b` (~2 GB) as the starter model.
- Note: winget updated the *user* PATH; a pre-existing shell won't see `ollama`
  until reopened. New shells are fine.

---

## Design decisions (agreed)

1. **Runtime ≠ model — two sequential questions.** The provider abstraction
   (`providerChain`, `probeEndpoint`) is keyed on the *runtime* (Ollama, LM Studio,
   llama.cpp), not the *model* (qwen, llama3, phi). The picker asks runtime first,
   then offers a model pull. Never present a model (e.g. "Qwen") as a sibling of a
   runtime (e.g. "Ollama").
2. **No vendor lock-in, lean into it.** Never `npm install` a provider / never bundle.
   Shell out to the user's OS package manager (`winget`/`brew`/`curl | sh`) or the
   vendor's official installer — same posture as the existing `pullModel`
   (`execFile('ollama', …)`) and the `gh`/`vercel` integrations. Pitch: *"ashlr ships
   no model runtime — it speaks the two open local-inference protocols (OpenAI
   `/v1/models` + Ollama `/api/tags`), so bring any runtime; here's a one-key path to
   the popular ones."*
3. **Lives in `ashlr init`, NOT npm postinstall / install.sh.** A prompting
   postinstall breaks CI / `npm ci` / non-interactive installs and reads as hostile.
   `install.sh` stays symlink-only. Add the picker to the existing `stepModels`
   onboarding step (TTY only) + a standalone re-entry command.
4. **Preserve invariants.** `onboard.ts` "NEVER auto-download models" stays true:
   the picker *offers*, the user *confirms*. Model pull still routes through the
   existing explicit `pullModel`. Runtime install is equally confirm-gated
   (`--yes` skips prompt; CI/non-interactive = detect-only, current behavior).

---

## Milestones & tasks

### M-LP1 — Cross-platform foundation (prereq; partly in flight)
Blocks accurate detection on Windows. Untracked `test/helpers/platform.ts` suggests
this is already started.

- [ ] Fix `ollamaInstalled()` in `src/core/run/model-manager.ts:201` — uses POSIX
      `which`; needs `where` on `win32`. Add a `whichBin(name)` helper that picks
      `where`/`which` by `process.platform`.
- [ ] Make `startOllama()` (`model-manager.ts:277`) not mac-first — current
      `open -a Ollama` path is dead on Windows; the `ollama serve` detached fallback
      works but should be the primary on non-mac.
- [ ] Unit tests for both across `win32`/`darwin`/`linux` (use the new platform helper).

### M-LP2 — Provider installer registry (pure data + gated runner)
- [ ] New `src/core/run/provider-installer.ts` exporting a `ProviderInstaller[]`:
      `{ id, label, detect(), installCmd: Partial<Record<NodeJS.Platform,string[]>>,
      docsUrl, recommendedModels }` for `ollama`, `lmstudio`, `llamacpp`.
- [ ] `detect()` reuses `probeEndpoint` (running) + `whichBin` (installed-but-stopped).
- [ ] `installProvider(id, {confirm})` — confirm-gated `execFile` shell-out per
      platform; prints the exact command first; never runs without confirm/`--yes`.
      Never throws (returns `{ok, detail}` like `pullModel`).
- [ ] `scanExistingProviders()` — probe all known runtimes, return what's live.
- [ ] Tests: detect/scan/install-plan per platform; install runner is confirm-gated.

### M-LP3 — Wire into onboarding + standalone command
- [ ] Extend `stepModels` (`src/core/onboard.ts`) — when interactive (TTY) and no
      local model found, render the **runtime picker** (Ollama / LM Studio /
      llama.cpp / scan / manual-skip). Non-interactive & `--yes` → keep current
      detect-only report.
- [ ] After a runtime is ready, **model step** (only for ollama/llamacpp; LM Studio
      self-manages via GUI): offer `recommendedModels` → existing `pullModel`.
- [ ] New `ashlr models setup` (alias `ashlr models install`) — standalone re-entry
      to the same picker, runnable any time.
- [ ] `--json` output for both (emit a `ProviderSetupResult`).

### M-LP4 — Docs & polish
- [ ] README: replace "Optional: Ollama or LM Studio" with the picker story +
      the open-protocols / no-lock-in framing.
- [ ] `ashlr doctor` hint: when `activeProvider` resolves to a *cloud* entry because
      no local runtime is up, surface "run `ashlr models setup`" instead of silent
      paid fallthrough.
- [ ] Changelog / milestone entry (M31?) consistent with M-series convention.

---

## UX reference (agreed mock)

**Step 1 — runtime**
```
part of what we love about ashlr: local models save you paid compute.
no model runtime is bundled — ashlr just speaks the open local protocols.
pick one to set up (or bring your own):

  1) Ollama          easiest · winget install Ollama.Ollama
  2) LM Studio       GUI · great for browsing models
  3) llama.cpp       advanced · most control
  4) Scan existing   I already run one → detect & wire it
  5) Manual / skip   show docs, I'll do it myself
```

**Step 2 — model** (ollama/llamacpp only)
```
runtime ready. pull a starter model? (downloads now)
  1) qwen2.5-coder:7b   best for code (recommended)
  2) llama3.2:3b        small & fast
  3) skip
```

---

## Open questions for next session
- Should `llama.cpp` ship in v1 of the picker or land as a fast-follow? (LM Studio +
  Ollama cover ~all users; llama.cpp adds install complexity.)
- Milestone number/name to slot this under in the M-series (M31 vs an H-series item).
- Do we auto-append the chosen runtime to `providerChain` if a user has a custom
  chain that omits it? (Default chain already lists both local ids, so usually a no-op.)
