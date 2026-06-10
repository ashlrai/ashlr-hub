# CONTRACT-M20 — one-command onboarding + self-healing doctor/runtime

The M20 capstone makes Ashlr trivial to adopt (one-command `ashlr init`) and
resilient (self-healing `ashlr doctor --fix` + bounded runtime self-heal).

All source is ESM/NodeNext: **import siblings with the `.js` extension**
(`import { runDoctor } from './doctor.js'`). Build against these EXACT
signatures. Each agent edits ONLY its own file(s). No new runtime deps. No git
commit. Preserve all existing behavior + 2026 tests, and preserve M3 / M11 /
M15 / M18 semantics + tests.

---

## src/core/types.ts — THE CONTRACT (types only) — DONE

Added (existing types unchanged):

```ts
export interface FixAction {
  checkId: string;   // DoctorCheck.id (e.g. 'config' | 'index' | 'local-bin' | 'genome-memory' | 'mcp-plugin')
  label: string;
  applied: boolean;  // a safe automated remediation was performed
  detail: string;    // what was fixed, or why left manual
  manual: boolean;   // fixable-in-principle but needs human action; left untouched
}

export interface OnboardStep {
  name: string;      // 'config' | 'models' | 'editors' | 'symlink' | 'genome' | 'phantom' | 'doctor'
  status: 'ok' | 'wired' | 'detected' | 'skipped' | 'manual';
  detail: string;    // metadata only, never secrets
}

export interface OnboardResult {
  steps: OnboardStep[];
  ready: boolean;       // setup complete enough to run (no blocking failures)
  nextSteps: string[];  // crisp guidance, e.g. 'try: ashlr run / ashlr swarm / ashlr tui'
}

export interface HealPolicy {
  maxRestarts: number;     // hard max heal-triggered retries; bounded, never infinite
  allowDowngrade: boolean; // OOM/model-error may downgrade to a SMALLER LOCAL model
}

export interface HealEvent {
  kind: 'mcp-restart' | 'model-downgrade' | 'rate-backoff';
  detail: string;   // metadata only, never secrets
  attempt: number;  // 1-based attempt number that triggered the heal
}
```

---

## src/core/onboard.ts — one-command onboarding (to implement)

```ts
import type { AshlrConfig, OnboardResult } from './types.js';

export async function onboard(
  cfg: AshlrConfig,
  opts: { wire: boolean; yes: boolean },
): Promise<OnboardResult>;
```

Behavior — **idempotent + NON-TTY-safe** (never hangs on a prompt; the only
mutating step gated behind a flag is editor wiring via `opts.wire`). Default is
**detect + report + safe ensures**. Returns one `OnboardStep` per step below, in
order. Never throws — degrade to a `'manual'` step on any error.

Steps (in display order):
1. **config** — ensure `~/.ashlr/config.json` exists (reuse `loadConfig()` /
   `saveConfig()` / `CONFIG_PATH` from `core/config.js`; `defaultConfig()` when
   absent). status `'ok'`.
2. **models** — detect local models (reuse `listLocalModels(cfg)` +
   `ollamaInstalled()` from `core/run/model-manager.js`) and **report only**.
   If none present, status `'manual'` with guidance to run
   `ashlr models pull <model>` — **NEVER auto-download** (pull stays explicit).
   status `'detected'` when models found.
3. **editors** — detect editors (reuse `detectEditors()` from
   `core/integrations/editors.js`). If `opts.wire`, wire each detected editor via
   `wireEditor(target, {})` (backup-first, idempotent — M18 pattern) → status
   `'wired'`. Otherwise status `'detected'` (report + suggest `--wire`).
4. **symlink** — ensure the `ashlr` → `~/.local/bin` symlink. If present, `'ok'`.
   If missing, status `'manual'` and print/offer `install.sh` guidance —
   creating the symlink itself is also a safe ensure when the source resolves
   (mirror `fixDoctor`'s `local-bin` fix); never modify shell profiles.
5. **genome** — seed an EMPTY genome dir if absent (mkdir-only; reuse the
   genome store dir helper from `core/genome/store.js`). status `'ok'`.
6. **phantom** — phantom status report only (reuse `core/phantom.js`); never
   touches secrets. status `'detected'` or `'ok'`.
7. **doctor** — run `runDoctor(cfg)` and fold the roll-up into the final
   `OnboardStep` (`'ok'` when no failures, else `'manual'`).

`ready` = no blocking failures (config present + doctor has no `fail` that
blocks running). `nextSteps` always ends with a crisp
`try: ashlr run / ashlr swarm / ashlr tui` line.

**MUST NOT:** auto-download models, modify secrets, modify shell profiles, or
perform any outward/network mutation. Mutations limited to: ensure config,
mkdir genome dir, create local-bin symlink, and (only with `opts.wire`)
backup-first editor MCP registration.

---

## src/core/doctor-fix.ts — self-healing `doctor --fix` (to implement)

```ts
import type { AshlrConfig, FixAction } from './types.js';

export async function fixDoctor(cfg: AshlrConfig): Promise<FixAction[]>;
```

Behavior — run `runDoctor(cfg)` (reuse `core/doctor.js`), then for each
**failing or warn** check whose id is in the SAFE-FIXABLE set, apply ONE safe,
local, non-destructive remediation and record a `FixAction`. Pass-status checks
produce no action. Never throws. Each applied fix is logged into
`FixAction.detail`. Returns the actions in check display order.

SAFE-FIXABLE set (maps to existing DoctorCheck ids):
- **`config`** — create missing `~/.ashlr/config.json` from `defaultConfig()` +
  `saveConfig()`. Only when ABSENT; never overwrite an existing config.
- **`index`** — rebuild a stale/missing index via `buildIndex(cfg)` +
  `writeIndex(...)` (reuse `core/index-engine.js`). Rebuild is non-destructive
  (regenerates derived data only).
- **`local-bin`** — create the `ashlr` → `~/.local/bin` symlink when missing and
  the source resolves. Never modify shell profiles (PATH stays manual → if the
  check is "not on PATH", emit a `manual: true` action with guidance).
- **`genome-memory`** — create the genome dir when missing (mkdir-only; reuse
  `core/genome/store.js` dir helper). Never seeds/edits entries.
- **`mcp-plugin`** — register the ashlr MCP gateway into a detected editor
  config via `wireEditor(target, {})` (backup-first + idempotent — M18 pattern).

Every other failing check → a `FixAction` with `applied:false, manual:true` and
a one-line `detail` of what the user must do (mirrors the check's `fix` hint).

**FIX-SAFETY RULES (HARD GUARDRAILS):**
- ONLY safe, local, non-destructive fixes. NEVER delete or overwrite user data.
- NEVER auto-download models (pull stays explicit; provider/model checks are
  always `manual`).
- NEVER modify secrets (phantom checks are always `manual`).
- NEVER modify shell profiles or anything outward/network.
- Editor-config writes are **backup-first + idempotent** (M18 `wireEditor`).
- Each fix is reversible-ish (config create-only, symlink, mkdir, .bak backups)
  and logged in `detail`. Ambiguous → leave as `manual`.

---

## src/core/run/self-heal.ts — bounded runtime self-heal (to implement)

```ts
import type { HealPolicy, HealEvent } from '../types.js';

export async function withHeal<T>(
  fn: (attempt: number) => Promise<T>,
  policy: HealPolicy,
  onHeal: (e: HealEvent) => void,
): Promise<T>;

export function defaultHealPolicy(): HealPolicy;
```

Behavior — a BOUNDED wrapper around a runtime operation `fn` (downstream MCP
spawn, or a single model call). `fn` receives the 1-based attempt number.

- On a recoverable failure, classify it and emit ONE `HealEvent` via `onHeal`,
  then retry — bounded by `policy.maxRestarts` total heal-triggered retries:
  - **MCP downstream crash** → `kind:'mcp-restart'` (restart the downstream;
    extends M3 skip-on-failure — after `maxRestarts`, give up and let the
    caller skip the downstream).
  - **local model OOM/error** → only when `policy.allowDowngrade`,
    `kind:'model-downgrade'` (downgrade to a SMALLER LOCAL model via
    `core/run/router.js` `chooseRoute(...)` — NEVER escalates to cloud, NEVER
    increases cost).
  - **cloud rate-limit** → `kind:'rate-backoff'` exponential backoff — ONLY when
    cloud is already in play (caller already set `allowCloud`); never enables
    cloud on its own.
- Reuse `withRetry` from `core/run/retry.js` for the bounded loop + exponential
  backoff (do not reimplement backoff). `withHeal` adds heal classification +
  `onHeal` events on top of `withRetry`.
- Rethrows the last error when heal attempts are exhausted or the error is not a
  recoverable heal case. **BOUNDED BY CONSTRUCTION** — never loops more than
  `policy.maxRestarts` heal retries; no infinite restart/downgrade loop.

`defaultHealPolicy()` returns a conservative bounded default
(small `maxRestarts`, `allowDowngrade:true`).

**SELF-HEAL GUARDRAILS:** bounded (hard max attempts), opt-out at the call site,
downgrade is to a SMALLER LOCAL model only (never cloud, never higher cost),
cloud backoff only when `allowCloud` already set. Preserve M3 skip-on-failure,
M11 `withRetry`, and M15 routing behavior + their tests.

---

## src/cli/doctor-init.ts — CLI wiring (to extend; preserve existing flags)

- **`cmdInit(args)`** — drive full onboarding through `onboard(cfg, { wire, yes })`:
  - `--wire` → `opts.wire = true` (the only mutating optional step).
  - `--yes` (or non-TTY stdin) → `opts.yes = true`; NON-TTY-safe, no prompts.
  - `--json` → emit `OnboardResult` as JSON (no color), else print the steps +
    a doctor roll-up + the crisp `nextSteps`
    (`you're set up — try: ashlr run / ashlr swarm / ashlr tui`).
  - Preserve the existing idempotent ensure-config behavior + `InitResult` JSON
    shape where reasonable (may be superseded by `OnboardResult` under `--json`).
- **`cmdDoctor(args)`** — accept **`--fix`**:
  - without `--fix` → unchanged (print `DoctorReport`; exit 1 on any `fail`).
  - with `--fix` → run `fixDoctor(cfg)`, then re-run/print: report
    `FixAction[]` split into **fixed** (`applied:true`) vs **needs manual
    action** (`manual:true`). `--json` → emit `FixAction[]`. Exit non-zero only
    if blocking failures remain after fixes.

---

## gateway / run integration — wrap in withHeal (bounded, opt-out)

- **`core/mcp-gateway.ts`** — wrap the downstream spawn/connect in `withHeal`
  (bounded restart, then fall back to existing M3 skip-on-failure). Opt-out via
  an env/flag (e.g. `ASHLR_NO_HEAL`); preserve current skip behavior + tests.
- **`core/run/router.ts`** (or the run call site) — wrap the model call in
  `withHeal` so a local OOM/error can downgrade to a smaller local model for a
  bounded retry, and a cloud rate-limit (only when `allowCloud`) backs off.
  Opt-out flag; preserve M15 local-first + escalation gates + tests.

---

## GUARDRAILS (apply to ALL M20 work)

- `doctor --fix` applies ONLY safe/local/non-destructive fixes
  (symlink / config-create / index-rebuild / genome-dir / MCP-register-with-backup).
  MUST NOT delete/overwrite user data, auto-download models (pull stays
  explicit), modify secrets, or do anything outward.
- `ashlr init` is idempotent + NON-TTY-safe; `--wire` / `--yes` gate the
  optional mutating steps; default = detect + report + safe ensures.
- Self-heal is BOUNDED (hard max attempts), opt-out, never escalates cost
  (downgrade is to a SMALLER LOCAL model; cloud backoff only when `allowCloud`
  already set). Never loops.
- Preserve all existing behavior + 2026 tests. Reuse modules. No new runtime
  deps. No git commit. Each agent edits ONLY its own file(s).
