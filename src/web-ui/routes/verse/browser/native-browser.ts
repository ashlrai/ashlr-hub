/**
 * routes/verse/browser/native-browser.ts — the Browser pane's one seam to the
 * desktop shell (shell contract "browser" v1, desktop/src-tauri/src/
 * browser_pane.rs + shell_contract.js, documented in desktop/README.md).
 *
 * FEATURE-DETECTED, NEVER BUILD-FLAGGED. The same bundle runs in three places:
 *   1. a desktop shell that implements the browser contract →
 *      `window.__ASHLR_DESKTOP__.browser.version >= 1`: real native webviews
 *      (any site, screenshots on macOS, console, element picker);
 *   2. an OLDER desktop shell (installed before `ship:local -- --native`) →
 *      `__ASHLR_DESKTOP__` exists but has no `browser`: iframe fallback;
 *   3. a plain browser tab on `ashlr verse` → no bridge: iframe fallback.
 * `nativeBrowser()` answers which, at call time, and returns null for 2 and 3.
 *
 * PROTOCOL. The page sends a closed set of ops (`send`); native answers with
 * `ashlr:browser` window events. Requests that expect an answer carry a
 * `req` id and resolve through `request()` (or time out). Native never runs
 * page-supplied script in a tab: `query` names one fixed tap function, and
 * its arguments travel as JSON that native re-validates against closed
 * shapes (browser_pane.rs). The one exception, `evaluate`, is loopback-only
 * and needs the operator's per-chat "scripts" switch upstream.
 *
 * ACTING (`act` capability, macOS): `{ act: { kind, … } }` makes native
 * synthesise real mouse / key events into the tab's webview at the element
 * the tap located — the page sees trusted input, exactly as if the operator
 * had clicked. Native reports genuine operator input in a tab as an
 * `operator` event, which pauses the agent (BrowserPanel).
 */

export const NATIVE_BROWSER_EVENT = 'ashlr:browser';
export const NATIVE_BROWSER_MIN_VERSION = 1;

export interface NativeBrowserCapabilities {
  screenshot: boolean;
  picker: boolean;
  console: boolean;
  text: boolean;
  /** Snapshot, resolve, act (synthesised input) and evaluate — a shell that implements them. */
  act: boolean;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One agent action for native to perform (desktop/src-tauri/src/browser_pane.rs `ActSpec`). */
export type NativeActSpec =
  | { kind: 'click'; ref?: string; x?: number; y?: number; button?: 'left' | 'right'; double?: boolean; modifiers?: string[]; expect?: string }
  | { kind: 'type'; ref: string; text: string; submit?: boolean; clear?: boolean; expect?: string }
  | { kind: 'select'; ref: string; values: string[]; expect?: string }
  | { kind: 'hover'; ref?: string; x?: number; y?: number; expect?: string }
  | { kind: 'key'; key: string }
  | { kind: 'scroll'; ref?: string; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; expect?: string };

export type NativeQuery =
  | 'text'
  | 'console'
  | 'info'
  | 'pick-start'
  | 'pick-poll'
  | 'pick-cancel'
  | 'resume'
  | { snapshot: { max_nodes?: number; root_ref?: string } }
  | { network: { limit?: number } }
  | { resolve: { ref: string } | { x: number; y: number } | { focused: true } }
  | { act: NativeActSpec }
  | { evaluate: { expression: string } };

export type NativeBrowserOp =
  | { op: 'open'; tab: string; url: string; bounds: Bounds }
  | { op: 'navigate'; tab: string; url: string }
  | { op: 'back' | 'forward' | 'reload'; tab: string }
  | { op: 'bounds'; tab: string; bounds: Bounds }
  | { op: 'hide' }
  | { op: 'close'; tab: string }
  | { op: 'zoom'; tab: string; factor: number }
  | { op: 'query'; tab: string; req: string; what: NativeQuery }
  | { op: 'screenshot'; tab: string; req: string; clip?: Bounds }
  | { op: 'external'; url: string };

export type NativeBrowserEvent =
  | { kind: 'nav'; tab: string; url: string; loading: boolean }
  | { kind: 'title'; tab: string; title: string }
  | { kind: 'blocked'; tab: string; url: string; reason: string }
  | { kind: 'closed'; tab: string }
  /** Genuine operator input (a click or key press) reached a tab — never the agent's synthesised input. */
  | { kind: 'operator'; tab: string }
  | { kind: 'result'; req: string; ok: true; data: unknown }
  | { kind: 'result'; req: string; ok: false; error: string };

export interface NativeBrowser {
  version: number;
  capabilities: NativeBrowserCapabilities;
  send(op: NativeBrowserOp): boolean;
}

interface RawBridge {
  version?: unknown;
  capabilities?: unknown;
  send?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The shell's browser bridge, or null (a browser tab, or a shell older than contract v1). */
export function nativeBrowser(win: Window = window): NativeBrowser | null {
  let raw: RawBridge | undefined;
  try {
    raw = (win as unknown as { __ASHLR_DESKTOP__?: { browser?: RawBridge } }).__ASHLR_DESKTOP__?.browser;
  } catch {
    return null;
  }
  if (!raw || typeof raw.send !== 'function') return null;
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (version < NATIVE_BROWSER_MIN_VERSION) return null;
  const caps = isRecord(raw.capabilities) ? raw.capabilities : {};
  const send = raw.send as (msg: unknown) => unknown;
  return {
    version,
    capabilities: {
      screenshot: caps['screenshot'] === true,
      picker: caps['picker'] !== false,
      console: caps['console'] !== false,
      text: caps['text'] !== false,
      act: caps['act'] === true,
    },
    send(op) {
      try {
        return send(op) === true;
      } catch {
        return false;
      }
    },
  };
}

/** Boundary check: the event crossed from native. Anything malformed is dropped. */
export function parseNativeBrowserEvent(detail: unknown): NativeBrowserEvent | null {
  if (!isRecord(detail) || typeof detail['kind'] !== 'string') return null;
  const tab = typeof detail['tab'] === 'string' ? detail['tab'] : null;
  switch (detail['kind']) {
    case 'nav':
      return tab && typeof detail['url'] === 'string'
        ? { kind: 'nav', tab, url: detail['url'], loading: detail['loading'] === true }
        : null;
    case 'title':
      return tab && typeof detail['title'] === 'string' ? { kind: 'title', tab, title: detail['title'].slice(0, 300) } : null;
    case 'blocked':
      return tab && typeof detail['url'] === 'string'
        ? { kind: 'blocked', tab, url: detail['url'], reason: typeof detail['reason'] === 'string' ? detail['reason'] : 'refused' }
        : null;
    case 'closed':
      return tab ? { kind: 'closed', tab } : null;
    case 'operator':
      return tab ? { kind: 'operator', tab } : null;
    case 'result': {
      if (typeof detail['req'] !== 'string') return null;
      if (detail['ok'] === true) return { kind: 'result', req: detail['req'], ok: true, data: detail['data'] };
      return { kind: 'result', req: detail['req'], ok: false, error: typeof detail['error'] === 'string' ? detail['error'] : 'failed' };
    }
    default:
      return null;
  }
}

/** Every native browser event, parsed. Returns the unsubscribe. */
export function subscribeNativeBrowser(handler: (event: NativeBrowserEvent) => void, win: Window = window): () => void {
  const listener = (event: Event): void => {
    const parsed = parseNativeBrowserEvent((event as CustomEvent<unknown>).detail);
    if (parsed) handler(parsed);
  };
  win.addEventListener(NATIVE_BROWSER_EVENT, listener);
  return () => win.removeEventListener(NATIVE_BROWSER_EVENT, listener);
}

let reqCounter = 0;

/**
 * Send an op that expects a `result` and wait for it. Rejects on a refused
 * send, a native error or the timeout — with a message fit for the operator.
 */
export function nativeRequest(
  bridge: NativeBrowser,
  build: (req: string) => Extract<NativeBrowserOp, { req: string }>,
  timeoutMs = 10_000,
  win: Window = window,
): Promise<unknown> {
  const req = `r${Date.now().toString(36)}${(++reqCounter).toString(36)}`;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (): void => {
      done = true;
      clearTimeout(timer);
      unsubscribe();
    };
    const unsubscribe = subscribeNativeBrowser((event) => {
      if (done || event.kind !== 'result' || event.req !== req) return;
      finish();
      if (event.ok) resolve(event.data);
      else reject(new Error(event.error === 'unsupported' ? 'This desktop shell cannot do that on this platform.' : event.error));
    }, win);
    const timer = setTimeout(() => {
      if (done) return;
      finish();
      reject(new Error('The desktop browser did not answer in time.'));
    }, timeoutMs);
    if (!bridge.send(build(req))) {
      finish();
      reject(new Error('The desktop shell refused the request.'));
    }
  });
}
