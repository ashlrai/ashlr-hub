/**
 * core/verse/session-controls.ts — per-chat model, effort and permission mode
 * (SPEC-310C §0.6, §2 "Composer"; unit C3).
 *
 * Three things live here, all pure except the defaults file:
 *
 *   1. WHAT A SEAT CAN DO. `controlOptionsFor` lists every model, effort and
 *      permission mode for one seat, each `available` or not WITH a reason.
 *      Nothing is hidden: the picker shows an impossible choice disabled and
 *      says why, so the operator learns the seat's limits instead of guessing.
 *      Every availability below was read from the pinned binaries' own
 *      `--help` on 2026-09-24, not recalled:
 *        claude 2.1.243 / 2.1.257 / 2.1.280
 *          --effort <level>            (low, medium, high, xhigh, max)
 *          --permission-mode <mode>    acceptEdits auto bypassPermissions manual dontAsk plan
 *        codex 0.155.0-alpha.16.3 (ChatGPT.app, the seats' pinned binary)
 *          -s/--sandbox read-only|workspace-write|danger-full-access,
 *          --dangerously-bypass-approvals-and-sandbox (exec AND exec resume),
 *          -c model_reasoning_effort=minimal|low|medium|high|xhigh
 *        grok 0.2.118
 *          --permission-mode default acceptEdits auto dontAsk bypassPermissions plan
 *          --reasoning-effort (models list low / medium / high)
 *
 *   2. HOW A CHOICE BECOMES ARGV. `*PermissionArgs` / `*EffortArgs` are the one
 *      mapping each adapter calls, so the option list and the flags can never
 *      disagree. The DEFAULT (accept-edits, no effort) maps to exactly the argv
 *      every adapter emitted before 3.10 — an untouched chat launches
 *      byte-identically, which the argv snapshot test pins.
 *
 *   3. WHAT A NEW CHAT STARTS WITH. `<root>/control-defaults.json` (0600),
 *      global plus per seat. Bypass is refused there: it is confirmed PER CHAT
 *      and never inherited (types.ts VERSE_PERMISSION_MODES).
 *
 * An engine that cannot honour a mode reports it unavailable rather than
 * approximating it — with one deliberate, documented mapping: grok's
 * "Accept edits" runs as grok's `dontAsk`, because grok's own `acceptEdits`
 * cancels the turn at the first shell command (measured; see adapters/grok.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareCliVersions } from './model-windows.js';
import { writePrivateFileAtomically } from './session-store.js';
import {
  VERSE_DEFAULT_PERMISSION_MODE,
  VERSE_EFFORTS,
  VERSE_PERMISSION_MODES,
  type VerseEffort,
  type VerseEngine,
  type VersePermissionMode,
  type VerseSeat,
  type VerseSession,
  type VerseSessionControls,
} from './types.js';
import type {
  VerseControlOption,
  VerseSessionControlDefaults,
  VerseSessionControlDefaultsUpdate,
  VerseSessionControlsResponse,
  VerseSessionControlsUpdate,
} from './workbench-types.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const PERMISSION_MODE_LABELS: Readonly<Record<VersePermissionMode, string>> = {
  plan: 'Plan',
  'accept-edits': 'Accept edits',
  auto: 'Auto',
  bypass: 'Bypass permissions',
};

export const EFFORT_LABELS: Readonly<Record<VerseEffort, string>> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/**
 * The oldest claude build verified to accept `--effort`: 2.1.243, 2.1.257 and
 * 2.1.280 all list it. An older or unknown pin gets no effort choices —
 * commander rejects unknown options, so guessing would fail EVERY turn.
 */
export const CLAUDE_EFFORT_MIN_CLI = '2.1.243';

const CLAUDE_EFFORTS: ReadonlySet<VerseEffort> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CODEX_EFFORTS: ReadonlySet<VerseEffort> = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const GROK_EFFORTS: ReadonlySet<VerseEffort> = new Set(['low', 'medium', 'high']);

export function isVersePermissionMode(value: unknown): value is VersePermissionMode {
  return typeof value === 'string' && (VERSE_PERMISSION_MODES as readonly string[]).includes(value);
}

export function isVerseEffort(value: unknown): value is VerseEffort {
  return typeof value === 'string' && (VERSE_EFFORTS as readonly string[]).includes(value);
}

/**
 * `VerseSession.controls` as the store accepts it: absent, or an object whose
 * keys are each absent or exact. The store's absent-or-exact rule (a record
 * claiming `permissionMode: 'yolo'` is corrupt and skipped, never guessed at).
 */
export function isVerseSessionControls(value: unknown): value is VerseSessionControls {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'effort' && key !== 'permissionMode') return false;
  }
  return (record['effort'] === undefined || isVerseEffort(record['effort']))
    && (record['permissionMode'] === undefined || isVersePermissionMode(record['permissionMode']));
}

/** The chat's effective values: an absent key is the engine default. */
export function effectiveControls(session: Pick<VerseSession, 'model' | 'controls'>): VerseSessionControlsResponse['controls'] {
  return {
    model: session.model,
    effort: session.controls?.effort ?? null,
    permissionMode: session.controls?.permissionMode ?? VERSE_DEFAULT_PERMISSION_MODE,
  };
}

// ---------------------------------------------------------------------------
// Options per seat
// ---------------------------------------------------------------------------

export interface ControlOptionsContext {
  /** The claude build this seat execs (profile pin, else launch snapshot); null = unknown. */
  claudeCliVersion?: string | null;
}

function permissionOption(
  id: VersePermissionMode,
  available: boolean,
  reason?: string,
): VerseControlOption<VersePermissionMode> {
  return {
    id,
    label: PERMISSION_MODE_LABELS[id],
    available,
    ...(available || !reason ? {} : { reason }),
    ...(id === 'bypass' ? { danger: true } : {}),
  };
}

export function permissionOptionsFor(engine: VerseEngine): VerseControlOption<VersePermissionMode>[] {
  switch (engine) {
    case 'claude':
      return VERSE_PERMISSION_MODES.map((id) => permissionOption(id, true));
    case 'local':
      return VERSE_PERMISSION_MODES.map((id) => (id === 'auto'
        // Auto mode asks Anthropic's server-side classifier to vouch for each
        // action; an Ollama/llama-server endpoint returns no verdict, and the
        // CLI stops the turn after a few ("no safety verdict").
        ? permissionOption(id, false, 'Auto needs Anthropic’s safety check, which a local model can’t provide.')
        : permissionOption(id, true)));
    case 'codex':
      return VERSE_PERMISSION_MODES.map((id) => (id === 'auto'
        // `codex exec` never prompts: it already runs on its own inside the
        // sandbox, so there is no separate automatic mode to switch to.
        ? permissionOption(id, false, 'Codex never asks in a chat — Accept edits already runs on its own.')
        : permissionOption(id, true)));
    case 'grok':
      return VERSE_PERMISSION_MODES.map((id) => permissionOption(id, true));
    default: {
      const never: never = engine;
      return [permissionOption(never, false)];
    }
  }
}

function effortOption(id: VerseEffort, available: boolean, reason: string): VerseControlOption<VerseEffort> {
  return { id, label: EFFORT_LABELS[id], available, ...(available ? {} : { reason }) };
}

export function effortOptionsFor(engine: VerseEngine, ctx: ControlOptionsContext = {}): VerseControlOption<VerseEffort>[] {
  switch (engine) {
    case 'claude': {
      const version = ctx.claudeCliVersion ?? null;
      if (version === null || compareCliVersions(version, CLAUDE_EFFORT_MIN_CLI) < 0) {
        const why = version === null
          ? 'This seat’s Claude Code version is unknown, so effort can’t be set safely.'
          : `Effort needs Claude Code ${CLAUDE_EFFORT_MIN_CLI} or newer; this seat runs ${version}.`;
        return VERSE_EFFORTS.map((id) => effortOption(id, false, why));
      }
      return VERSE_EFFORTS.map((id) => effortOption(id, CLAUDE_EFFORTS.has(id), 'Claude’s lowest effort is Low.'));
    }
    case 'local':
      return VERSE_EFFORTS.map((id) => effortOption(id, false, 'Local models run without an effort setting.'));
    case 'codex':
      return VERSE_EFFORTS.map((id) => effortOption(id, CODEX_EFFORTS.has(id), 'Codex’s highest effort is Extra high.'));
    case 'grok':
      return VERSE_EFFORTS.map((id) => effortOption(id, GROK_EFFORTS.has(id), 'Grok offers Low, Medium and High.'));
    default: {
      const never: never = engine;
      return VERSE_EFFORTS.map((id) => effortOption(id, false, `unknown engine ${String(never)}`));
    }
  }
}

export function modelOptionsFor(seat: Pick<VerseSeat, 'models'>): VerseControlOption[] {
  return seat.models.map((model) => {
    const reason = typeof model.unavailableReason === 'string' ? model.unavailableReason.trim() : '';
    return { id: model.id, label: model.label, available: reason.length === 0, ...(reason ? { reason } : {}) };
  });
}

export function controlOptionsFor(seat: Pick<VerseSeat, 'models' | 'engine'>, ctx: ControlOptionsContext = {}): VerseSessionControlsResponse['options'] {
  return {
    models: modelOptionsFor(seat),
    efforts: effortOptionsFor(seat.engine, ctx),
    permissionModes: permissionOptionsFor(seat.engine),
  };
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

const UPDATE_KEYS = new Set(['model', 'effort', 'permissionMode', 'confirmBypass']);
const DEFAULTS_UPDATE_KEYS = new Set(['seatId', 'effort', 'permissionMode']);

export type ParsedControlsUpdate =
  | { ok: true; update: VerseSessionControlsUpdate }
  | { ok: false; error: string };

/**
 * Shape-check a POST body. Unknown keys are a 400 — a misspelt field silently
 * dropped is a request that "worked" and did something else. Setting
 * `bypass` without `confirmBypass: true` is refused HERE, before any seat is
 * consulted: the palette and the picker both reach this route, and neither
 * may turn every check off with one keystroke.
 */
export function parseControlsUpdate(body: Record<string, unknown>): ParsedControlsUpdate {
  const unknown = Object.keys(body).filter((key) => !UPDATE_KEYS.has(key));
  if (unknown.length > 0) return { ok: false, error: `unknown field(s): ${unknown.join(', ')}` };
  const update: VerseSessionControlsUpdate = {};
  if (body['model'] !== undefined) {
    if (typeof body['model'] !== 'string' || body['model'].trim().length === 0 || body['model'].length > 200) {
      return { ok: false, error: 'model must be a model id' };
    }
    update.model = body['model'].trim();
  }
  if (body['effort'] !== undefined) {
    if (body['effort'] !== null && !isVerseEffort(body['effort'])) {
      return { ok: false, error: `effort must be null or one of: ${VERSE_EFFORTS.join(', ')}` };
    }
    update.effort = body['effort'];
  }
  if (body['permissionMode'] !== undefined) {
    if (!isVersePermissionMode(body['permissionMode'])) {
      return { ok: false, error: `permissionMode must be one of: ${VERSE_PERMISSION_MODES.join(', ')}` };
    }
    update.permissionMode = body['permissionMode'];
  }
  if (body['confirmBypass'] !== undefined && body['confirmBypass'] !== true) {
    return { ok: false, error: 'confirmBypass must be true when present' };
  }
  if (update.permissionMode === 'bypass' && body['confirmBypass'] !== true) {
    return { ok: false, error: 'bypass skips every permission check; confirm it for this chat (confirmBypass: true)' };
  }
  if (body['confirmBypass'] === true) update.confirmBypass = true;
  if (update.model === undefined && update.effort === undefined && update.permissionMode === undefined) {
    return { ok: false, error: 'nothing to change: send model, effort or permissionMode' };
  }
  return { ok: true, update };
}

export type ParsedDefaultsUpdate =
  | { ok: true; update: VerseSessionControlDefaultsUpdate }
  | { ok: false; error: string };

export function parseDefaultsUpdate(body: Record<string, unknown>): ParsedDefaultsUpdate {
  const unknown = Object.keys(body).filter((key) => !DEFAULTS_UPDATE_KEYS.has(key));
  if (unknown.length > 0) return { ok: false, error: `unknown field(s): ${unknown.join(', ')}` };
  const update: VerseSessionControlDefaultsUpdate = {};
  if (body['seatId'] !== undefined) {
    if (typeof body['seatId'] !== 'string' || !/^[\w.:@-]{1,200}$/.test(body['seatId'])) {
      return { ok: false, error: 'seatId must be a seat id' };
    }
    update.seatId = body['seatId'];
  }
  if (body['effort'] !== undefined) {
    if (body['effort'] !== null && !isVerseEffort(body['effort'])) {
      return { ok: false, error: `effort must be null or one of: ${VERSE_EFFORTS.join(', ')}` };
    }
    update.effort = body['effort'];
  }
  if (body['permissionMode'] !== undefined) {
    if (body['permissionMode'] === 'bypass') {
      return { ok: false, error: 'bypass is confirmed per chat and can never be a default' };
    }
    if (!isVersePermissionMode(body['permissionMode'])) {
      return { ok: false, error: `permissionMode must be one of: plan, accept-edits, auto` };
    }
    update.permissionMode = body['permissionMode'] as Exclude<VersePermissionMode, 'bypass'>;
  }
  if (update.effort === undefined && update.permissionMode === undefined) {
    return { ok: false, error: 'nothing to change: send effort or permissionMode' };
  }
  return { ok: true, update };
}

/** Why an option cannot be chosen on this seat, or null when it can. */
export function refusalFor<T extends string>(options: readonly VerseControlOption<T>[], id: T, what: string): string | null {
  const option = options.find((o) => o.id === id);
  if (!option) return `${what} ${id} is not offered on this seat`;
  if (!option.available) return option.reason ? `${option.label}: ${option.reason}` : `${option.label} is unavailable on this seat`;
  return null;
}

// ---------------------------------------------------------------------------
// Argv mapping (the adapters' one source)
// ---------------------------------------------------------------------------

function modeOf(session: Pick<VerseSession, 'controls'>): VersePermissionMode {
  const mode = session.controls?.permissionMode;
  return isVersePermissionMode(mode) ? mode : VERSE_DEFAULT_PERMISSION_MODE;
}

function effortOf(session: Pick<VerseSession, 'controls'>, allowed: ReadonlySet<VerseEffort>): VerseEffort | null {
  const effort = session.controls?.effort;
  // A stored effort the engine does not take (a seat changed underneath the
  // chat, a hand-edited record) is dropped, never passed: an unknown value is
  // an argv parse error that fails the turn before inference.
  return isVerseEffort(effort) && allowed.has(effort) ? effort : null;
}

const CLAUDE_PERMISSION_FLAG: Readonly<Record<VersePermissionMode, string>> = {
  plan: 'plan',
  'accept-edits': 'acceptEdits',
  auto: 'auto',
  bypass: 'bypassPermissions',
};

/**
 * `--permission-mode <mode>` for claude and local seats. Local `auto` has no
 * classifier to ask (see permissionOptionsFor), so a stored `auto` on a local
 * chat falls back to the default instead of launching a turn that stops.
 */
export function claudePermissionArgs(session: Pick<VerseSession, 'controls' | 'engine'>): string[] {
  let mode = modeOf(session);
  if (session.engine === 'local' && mode === 'auto') mode = VERSE_DEFAULT_PERMISSION_MODE;
  return ['--permission-mode', CLAUDE_PERMISSION_FLAG[mode]];
}

/** `--effort <level>` on a claude seat whose pinned build knows it; nothing on local seats or by default. */
export function claudeEffortArgs(session: Pick<VerseSession, 'controls' | 'engine'>, claudeCliVersion: string | null): string[] {
  if (session.engine !== 'claude') return [];
  if (claudeCliVersion === null || compareCliVersions(claudeCliVersion, CLAUDE_EFFORT_MIN_CLI) < 0) return [];
  const effort = effortOf(session, CLAUDE_EFFORTS);
  return effort === null ? [] : ['--effort', effort];
}

/** `-c model_reasoning_effort="<level>"` (a TOML string), or nothing by default. */
export function codexEffortArgs(session: Pick<VerseSession, 'controls'>): string[] {
  const effort = effortOf(session, CODEX_EFFORTS);
  return effort === null ? [] : ['-c', `model_reasoning_effort="${effort}"`];
}

/**
 * Codex permission flags, split by where they go:
 *  - `sandbox`: the value of `--sandbox` on a NEW thread (`exec`), or null
 *    when bypass removes the sandbox altogether;
 *  - `resume`: extra flags for `exec resume`, which has no `--sandbox`. The
 *    default adds NOTHING there, so a resumed default turn is byte-identical
 *    to 3.9; plan pins read-only through the config override;
 *  - `bypass`: `--dangerously-bypass-approvals-and-sandbox` (both forms).
 * Codex has no plan mode of its own; a read-only sandbox is the honest
 * equivalent — it can read and reason but edits and writes are refused.
 */
export function codexPermission(session: Pick<VerseSession, 'controls'>): {
  sandbox: 'read-only' | 'workspace-write' | null;
  resume: string[];
  bypass: string[];
} {
  switch (modeOf(session)) {
    case 'plan':
      return { sandbox: 'read-only', resume: ['-c', 'sandbox_mode="read-only"'], bypass: [] };
    case 'bypass':
      return { sandbox: null, resume: [], bypass: ['--dangerously-bypass-approvals-and-sandbox'] };
    case 'auto': // unavailable on codex; a stored value falls back to the default
    case 'accept-edits':
    default:
      return { sandbox: 'workspace-write', resume: [], bypass: [] };
  }
}

const GROK_PERMISSION_FLAG: Readonly<Record<VersePermissionMode, string>> = {
  plan: 'plan',
  // NOT grok's `acceptEdits` — it cancels the turn at the first shell command
  // with no approver attached (adapters/grok.ts). `dontAsk` is the pre-3.10
  // default and completes.
  'accept-edits': 'dontAsk',
  auto: 'auto',
  bypass: 'bypassPermissions',
};

export function grokPermissionArgs(session: Pick<VerseSession, 'controls'>): string[] {
  return ['--permission-mode', GROK_PERMISSION_FLAG[modeOf(session)]];
}

/** `--reasoning-effort=<level>` (the `=` spelling clap always binds), or nothing by default. */
export function grokEffortArgs(session: Pick<VerseSession, 'controls'>): string[] {
  const effort = effortOf(session, GROK_EFFORTS);
  return effort === null ? [] : [`--reasoning-effort=${effort}`];
}

// ---------------------------------------------------------------------------
// Defaults for new chats
// ---------------------------------------------------------------------------

export const CONTROL_DEFAULTS_FILE = 'control-defaults.json';
const MAX_DEFAULT_SEATS = 64;

function cleanControls(value: unknown): VerseSessionControls {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const out: VerseSessionControls = {};
  if (isVerseEffort(record['effort'])) out.effort = record['effort'];
  // Bypass is never a default, even in a hand-edited file.
  if (isVersePermissionMode(record['permissionMode']) && record['permissionMode'] !== 'bypass') {
    out.permissionMode = record['permissionMode'];
  }
  return out;
}

export function readControlDefaults(root: string): VerseSessionControlDefaults {
  const path = join(root, CONTROL_DEFAULTS_FILE);
  if (!existsSync(path)) return { global: {}, seats: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { global: {}, seats: {} };
    const record = parsed as Record<string, unknown>;
    const seats: Record<string, VerseSessionControls> = {};
    const rawSeats = record['seats'];
    if (rawSeats && typeof rawSeats === 'object' && !Array.isArray(rawSeats)) {
      for (const [seatId, value] of Object.entries(rawSeats as Record<string, unknown>).slice(0, MAX_DEFAULT_SEATS)) {
        const clean = cleanControls(value);
        if (Object.keys(clean).length > 0) seats[seatId] = clean;
      }
    }
    return { global: cleanControls(record['global']), seats };
  } catch {
    // A corrupt defaults file means "no defaults", never a failed chat.
    return { global: {}, seats: {} };
  }
}

export function writeControlDefaults(root: string, update: VerseSessionControlDefaultsUpdate): VerseSessionControlDefaults {
  const current = readControlDefaults(root);
  const target: VerseSessionControls = update.seatId ? { ...(current.seats[update.seatId] ?? {}) } : { ...current.global };
  if (update.effort !== undefined) {
    if (update.effort === null) delete target.effort;
    else target.effort = update.effort;
  }
  if (update.permissionMode !== undefined) {
    if (update.permissionMode === VERSE_DEFAULT_PERMISSION_MODE) delete target.permissionMode;
    else target.permissionMode = update.permissionMode;
  }
  const next: VerseSessionControlDefaults = { global: current.global, seats: { ...current.seats } };
  if (update.seatId) {
    if (Object.keys(target).length === 0) delete next.seats[update.seatId];
    else next.seats[update.seatId] = target;
  } else {
    next.global = target;
  }
  writePrivateFileAtomically(root, join(root, CONTROL_DEFAULTS_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * What a new chat on `seat` starts with: the seat's defaults over the global
 * ones, each dropped when the seat cannot honour it (a global `high` effort
 * means nothing to a local seat). Empty = no `controls` key on the record.
 */
export function initialControlsFor(
  defaults: VerseSessionControlDefaults,
  seat: Pick<VerseSeat, 'id' | 'engine' | 'models'>,
  ctx: ControlOptionsContext = {},
): VerseSessionControls {
  const merged: VerseSessionControls = { ...defaults.global, ...(defaults.seats[seat.id] ?? {}) };
  const options = controlOptionsFor(seat, ctx);
  const out: VerseSessionControls = {};
  if (merged.effort && refusalFor(options.efforts, merged.effort, 'effort') === null) out.effort = merged.effort;
  if (merged.permissionMode && merged.permissionMode !== 'bypass'
    && merged.permissionMode !== VERSE_DEFAULT_PERMISSION_MODE
    && refusalFor(options.permissionModes, merged.permissionMode, 'permission mode') === null) {
    out.permissionMode = merged.permissionMode;
  }
  return out;
}
