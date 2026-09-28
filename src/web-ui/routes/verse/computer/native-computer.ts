/**
 * routes/verse/computer/native-computer.ts — the Verse window's one seam to
 * the desktop shell for computer use (shell contract "computer" v1,
 * desktop/src-tauri/src/computer.rs + shell_contract.js).
 *
 * FEATURE-DETECTED, like the Browser pane's bridge (browser/native-browser.ts):
 * `window.__ASHLR_DESKTOP__.computer` exists only in a desktop shell that
 * implements the contract, and `capabilities.supported` is true only where
 * native can actually capture and post events (macOS). Everywhere else —
 * a plain browser tab, an older shell, another OS — `nativeComputer()` is
 * null and the Verse window never polls the relay, so the sidecar sees "no
 * window" and every computer_* tool fails at once.
 *
 * PROTOCOL. The page sends a closed set of ops (`send`, which the shell emits
 * as `shell-computer`); native answers with `ashlr:computer` window events
 * (dispatched by window.__ASHLR_COMPUTER_EVENT__). Ops that expect an answer
 * carry `req` — for relayed ops the sidecar already set it to the relay
 * command id — and `request()` resolves with the matching `result`, or with a
 * synthetic `timeout` failure. It never rejects: every outcome is a
 * `NativeComputerResult` the runner can forward as-is.
 *
 * Everything takes an injectable window-like object so it is unit-testable.
 */
import type {
  ComputerControlState,
  ComputerErrorCode,
  NativeComputerEvent,
  NativeComputerOp,
} from '../../../../core/verse/computer-types.js';

export const NATIVE_COMPUTER_EVENT = 'ashlr:computer';
export const NATIVE_COMPUTER_MIN_VERSION = 1;
/** How long a native op may take before the page answers `timeout` for it. */
export const NATIVE_OP_TIMEOUT_MS = 60_000;
/** Longest error sentence carried from native (it is shown to the operator and the agent). */
const ERROR_MAX = 500;

export type NativeComputerResult = Extract<NativeComputerEvent, { kind: 'result' }>;
export type NativeComputerStateEvent = Extract<NativeComputerEvent, { kind: 'state' }>;
export type NativeComputerRequestOp = Extract<NativeComputerOp, { req: string }>;

export interface NativeComputer {
  version: number;
  /** Fire-and-forget. False when the shell refused the message. */
  send(op: NativeComputerOp): boolean;
  /** Send an op that expects a `result` and wait for it (never rejects). */
  request(op: NativeComputerRequestOp, timeoutMs?: number): Promise<NativeComputerResult>;
  /** Every `state` event (control active / paused / killed / idle). Returns the unsubscribe. */
  onState(listener: (event: NativeComputerStateEvent) => void): () => void;
}

/** The parts of `window` this module uses — a fake in tests. */
export interface ComputerWindowLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

interface RawBridge {
  version?: unknown;
  capabilities?: unknown;
  send?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ERROR_CODES: ReadonlySet<string> = new Set<ComputerErrorCode>([
  'no-permission',
  'operator-took-over',
  'stopped',
  'not-granted',
  'tier',
  'denied',
  'secure-field',
  'out-of-bounds',
  'not-found',
  'stale-ref',
  'unsupported',
  'invalid',
  'busy',
  'timeout',
  'failed',
]);

const CONTROL_STATES: ReadonlySet<string> = new Set<ComputerControlState>(['idle', 'active', 'paused', 'killed']);
const STATE_REASONS: ReadonlySet<string> = new Set(['operator-input', 'escape', 'kill', 'resume', 'idle']);

function rawBridge(win: unknown): RawBridge | null {
  try {
    const raw = (win as { __ASHLR_DESKTOP__?: { computer?: unknown } } | null)?.__ASHLR_DESKTOP__?.computer;
    return isRecord(raw) ? (raw as RawBridge) : null;
  } catch {
    return null;
  }
}

/**
 * True when this window runs in a shell that implements computer use and can
 * do it on this platform. Cheap and import-free on purpose: VerseApp inlines
 * the same test to decide whether to load this feature's chunk at all.
 */
export function hasNativeComputer(win: unknown = typeof window === 'undefined' ? undefined : window): boolean {
  const raw = rawBridge(win);
  if (!raw || typeof raw.send !== 'function') return false;
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (version < NATIVE_COMPUTER_MIN_VERSION) return false;
  return isRecord(raw.capabilities) && raw.capabilities['supported'] === true;
}

/** Boundary check: the event crossed from native. Anything malformed is dropped. */
export function parseNativeComputerEvent(detail: unknown): NativeComputerEvent | null {
  if (!isRecord(detail)) return null;
  if (detail['kind'] === 'result') {
    const req = detail['req'];
    if (typeof req !== 'string' || req.length === 0 || req.length > 64) return null;
    if (detail['ok'] === true) return { kind: 'result', req, ok: true, data: detail['data'] };
    const code = typeof detail['code'] === 'string' && ERROR_CODES.has(detail['code']) ? (detail['code'] as ComputerErrorCode) : 'failed';
    const error = typeof detail['error'] === 'string' && detail['error'].trim() ? detail['error'].slice(0, ERROR_MAX) : 'The desktop app could not do that.';
    return { kind: 'result', req, ok: false, code, error };
  }
  if (detail['kind'] === 'state') {
    const state = detail['state'];
    if (typeof state !== 'string' || !CONTROL_STATES.has(state)) return null;
    const event: NativeComputerStateEvent = { kind: 'state', state: state as ComputerControlState };
    if (typeof detail['app'] === 'string' && detail['app'].trim()) event.app = detail['app'].slice(0, 120);
    if (typeof detail['reason'] === 'string' && STATE_REASONS.has(detail['reason'])) {
      event.reason = detail['reason'] as NonNullable<NativeComputerStateEvent['reason']>;
    }
    return event;
  }
  return null;
}

/** Every native computer event, parsed. Returns the unsubscribe. */
export function subscribeNativeComputer(handler: (event: NativeComputerEvent) => void, win: ComputerWindowLike): () => void {
  const listener = (event: Event): void => {
    const parsed = parseNativeComputerEvent((event as CustomEvent<unknown>).detail);
    if (parsed) handler(parsed);
  };
  win.addEventListener(NATIVE_COMPUTER_EVENT, listener);
  return () => win.removeEventListener(NATIVE_COMPUTER_EVENT, listener);
}

/**
 * The shell's computer bridge, or null (a browser tab, a shell older than
 * contract v1, or a platform where native cannot capture / post events).
 */
export function nativeComputer(win: ComputerWindowLike = window): NativeComputer | null {
  if (!hasNativeComputer(win)) return null;
  const raw = rawBridge(win)!;
  const version = raw.version as number;
  const rawSend = raw.send as (msg: unknown) => unknown;

  const send = (op: NativeComputerOp): boolean => {
    try {
      return rawSend(op) === true;
    } catch {
      return false;
    }
  };

  return {
    version,
    send,
    request(op, timeoutMs = NATIVE_OP_TIMEOUT_MS) {
      return new Promise<NativeComputerResult>((resolve) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (result: NativeComputerResult): void => {
          if (done) return;
          done = true;
          if (timer !== null) clearTimeout(timer);
          unsubscribe();
          resolve(result);
        };
        const unsubscribe = subscribeNativeComputer((event) => {
          if (event.kind === 'result' && event.req === op.req) finish(event);
        }, win);
        timer = setTimeout(() => finish({ kind: 'result', req: op.req, ok: false, code: 'timeout', error: 'The desktop app did not answer in time.' }), timeoutMs);
        if (!send(op)) finish({ kind: 'result', req: op.req, ok: false, code: 'failed', error: 'The desktop app refused the request.' });
      });
    },
    onState(listener) {
      return subscribeNativeComputer((event) => {
        if (event.kind === 'state') listener(event);
      }, win);
    },
  };
}

/** A fresh request id in the relay's shape (`cc_` + 12 base64url characters) for ops the page starts itself. */
export function localRequestId(random: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = 'cc_';
  const bytes = new Uint8Array(12);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  }
  for (const b of bytes) id += alphabet[b & 63];
  return id;
}

// ---------------------------------------------------------------------------
// Permissions (the `permissions` op's answer)
// ---------------------------------------------------------------------------

export type PermissionStatus = 'granted' | 'missing' | 'unknown';

export interface ComputerPermissions {
  screen: PermissionStatus;
  accessibility: PermissionStatus;
}

export const UNKNOWN_PERMISSIONS: ComputerPermissions = { screen: 'unknown', accessibility: 'unknown' };

function permissionValue(value: unknown): PermissionStatus {
  if (value === true || value === 'granted' || value === 'authorized' || value === 'allowed') return 'granted';
  if (value === false || value === 'denied' || value === 'missing' || value === 'not-determined' || value === 'notDetermined' || value === 'restricted') return 'missing';
  if (isRecord(value)) return permissionValue(value['granted'] ?? value['status']);
  return 'unknown';
}

/**
 * Read native's answer to `{ op: 'permissions' }`. The contract leaves the
 * data's shape open, so this accepts `{ screen, accessibility }` with boolean
 * or status-string values (or `{ granted }` / `{ status }` objects), at the top
 * level or under `permissions`. Anything else is "unknown", never "granted".
 */
export function parsePermissions(data: unknown): ComputerPermissions {
  if (!isRecord(data)) return UNKNOWN_PERMISSIONS;
  const source = isRecord(data['permissions']) ? data['permissions'] : data;
  return {
    screen: permissionValue(source['screen'] ?? source['screenRecording'] ?? source['screen-recording']),
    accessibility: permissionValue(source['accessibility']),
  };
}

export function permissionsMissing(p: ComputerPermissions): boolean {
  return p.screen === 'missing' || p.accessibility === 'missing';
}
