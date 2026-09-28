/**
 * routes/verse/fleet/native-fleet.ts — the page side of the desktop app's
 * fleet operations (shell contract item 8, desktop/src-tauri/src/fleet_ops.rs).
 *
 * `window.__ASHLR_DESKTOP__.fleet.send({ id, op })` asks native to start /
 * restart / stop the resident daemon or install the custody helper. Native
 * confirms every raise in a NATIVE dialog this page cannot answer, runs the
 * operator's own `ashlr` CLI (or macOS's admin prompt for custody), and
 * reports progress as `ashlr:fleet` window events. In a plain browser (no
 * desktop shell, or an older one) `nativeFleetAvailable()` is false and the
 * Fleet tab shows the Terminal command instead.
 */

export type NativeFleetOp = 'resident-start' | 'resident-restart' | 'resident-stop' | 'custody-install';
export type NativeFleetPhase = 'confirming' | 'running' | 'done' | 'failed' | 'cancelled';

export interface NativeFleetEvent {
  id: string;
  op: NativeFleetOp;
  phase: NativeFleetPhase;
  message: string;
  command?: string;
  exitCode?: number;
  output?: string;
}

interface FleetBridge {
  version: number;
  ops?: readonly string[];
  send: (msg: { id: string; op: NativeFleetOp; checkout?: string }) => boolean;
}

function bridge(): FleetBridge | null {
  if (typeof window === 'undefined') return null;
  const desktop = (window as unknown as { __ASHLR_DESKTOP__?: { fleet?: FleetBridge } }).__ASHLR_DESKTOP__;
  const fleet = desktop?.fleet;
  return fleet && typeof fleet.send === 'function' && fleet.version >= 1 ? fleet : null;
}

/** The desktop app can run `op` natively. */
export function nativeFleetAvailable(op?: NativeFleetOp): boolean {
  const b = bridge();
  if (!b) return false;
  return op === undefined || !Array.isArray(b.ops) || b.ops.includes(op);
}

const TERMINAL: ReadonlySet<NativeFleetPhase> = new Set(['done', 'failed', 'cancelled']);

function isFleetEvent(value: unknown): value is NativeFleetEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['id'] === 'string' && typeof v['op'] === 'string' && typeof v['phase'] === 'string' && typeof v['message'] === 'string';
}

let counter = 0;

/**
 * Run one native op. `onProgress` sees every event (confirming, running, …);
 * the promise resolves with the terminal one. Rejects only when the bridge is
 * missing or refused the message. A run with no answer in `timeoutMs`
 * resolves as failed (native keeps the op; the page just stops waiting).
 */
export function runNativeFleetOp(
  op: NativeFleetOp,
  opts: { checkout?: string; onProgress?: (event: NativeFleetEvent) => void; timeoutMs?: number } = {},
): Promise<NativeFleetEvent> {
  const b = bridge();
  if (!b) return Promise.reject(new Error('This needs the Ashlr desktop app.'));
  counter += 1;
  const id = `fleet-${Date.now().toString(36)}-${counter}`;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!isFleetEvent(detail) || detail.id !== id) return;
      opts.onProgress?.(detail);
      if (TERMINAL.has(detail.phase)) {
        window.removeEventListener('ashlr:fleet', onEvent);
        if (timer) clearTimeout(timer);
        resolve(detail);
      }
    };
    window.addEventListener('ashlr:fleet', onEvent);
    timer = setTimeout(() => {
      window.removeEventListener('ashlr:fleet', onEvent);
      resolve({ id, op, phase: 'failed', message: 'The desktop app did not answer in time. Check the Fleet tab again in a moment.' });
    }, opts.timeoutMs ?? (op === 'custody-install' ? 25 * 60_000 : 5 * 60_000));
    const sent = b.send(opts.checkout ? { id, op, checkout: opts.checkout } : { id, op });
    if (!sent) {
      window.removeEventListener('ashlr:fleet', onEvent);
      if (timer) clearTimeout(timer);
      reject(new Error('The desktop app refused that request.'));
    }
  });
}
