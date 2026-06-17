# CONTRACT-M59 — `ashlr fleet init` + typed intelligence + loop posture

**Pillar:** Ashlr v5 Open Fleet — adoption ergonomics + close the M53 loose end.

**Mason's hard rule:** `fleet init` NEVER overwrites an existing `cfg.foundry`
block; default is print-only, `--write` merges only when foundry is absent.
Auto-merge stays OFF in the starter. No behavior change to the daemon.

---

## 1. `ashlr fleet init [--write]` (`src/cli/fleet.ts`)

- Print (default): emit a conservative starter `cfg.foundry` (installed backends
  builtin/claude/codex/hermes, OS confinement on, auto-merge OFF) + a pointer to
  `docs/FOUNDRY-CONFIG.md`.
- `--write`: merge the starter into `~/.ashlr/config.json` via `saveConfig`
  ONLY when `cfg.foundry` is absent; otherwise refuse (exit 1) without touching it.
- No mergeAuthority models or API engines are guessed (user pins those + sets keys).

## 2. Typed `cfg.foundry.intelligence` (`types.ts`) — M53 cleanup

- M53 read `intelligence` via an untyped bracket cast (it could not edit types.ts
  then). Now a first-class typed field `{ anomalyK?, minFrontierSuccessRate? }`;
  the 3 access sites (`learned-router.ts`, `daemon/loop.ts` ×2) use typed access.
  Behavior-identical (truthiness gate unchanged).

## 3. Loop posture line (`src/cli/loop.ts`)

- `ashlr loop` prints an honest one-line posture: `intelligence: on/off ·
  auto-merge(main): on/off · mid→branch: on/off`. Cheap; no heavy computation.

## HARD RULES + verification (`test/m59.*`)

1. **Print never writes** — `fleet init` (no flag) prints the block + returns 0,
   touches no config. → `m59.fleet-init` (print path; --write NOT invoked because
   resolveConfigDir uses os.homedir(), not $HOME — manual verification).
2. **Starter keeps auto-merge OFF** — printed block has `"enabled": false`.
   → `m59.fleet-init`.
3. **intelligence is typed** — the 3 sites compile against the new field.
   → project typecheck.
4. **No daemon behavior change** — flag-off byte-identical. → full suite.

## Deliverables checklist

- [ ] `src/cli/fleet.ts`: `init` subcommand + help line.
- [ ] `types.ts`: `cfg.foundry.intelligence`; access sites de-casted.
- [ ] `src/cli/loop.ts`: posture line.
- [ ] Tests: `m59.fleet-init`.

## Non-goals

Interactive config editing · guessing mergeAuthority models / API keys ·
overwriting an existing foundry block.
