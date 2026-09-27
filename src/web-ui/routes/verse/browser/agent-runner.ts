/**
 * routes/verse/browser/agent-runner.ts — how the Browser pane carries out
 * one agent command (core/verse/browser-mcp.ts + verse-mcp-browser-act.ts
 * queued it; browser-bridge.ts relayed it). Pure apart from the executor it
 * is handed.
 *
 * The pane re-applies the sidecar's gate BEFORE capturing or acting: a tab
 * showing a page this chat may not observe (the operator's own external
 * browsing) is never screenshotted, read, snapshotted or acted on — the
 * refusal leaves the machine, the page does not. The sidecar checks every
 * answer's URL again.
 *
 * Every op's arguments are rebuilt here from a CLOSED shape (anything else is
 * refused) before they reach the desktop shell, which validates them again.
 * While the operator has taken over the pane (they clicked or typed in it),
 * every command but `status` and `confirm` is refused until they press
 * Resume. What the sidecar decided needs the operator arrives as a `confirm`
 * command, answered by the card the executor shows.
 */
import {
  agentUrlVerdict,
  isLoopbackHost,
  type VerseBrowserAgentCommand,
  type VerseBrowserCommandResult,
  type VerseBrowserConfirmRequest,
  type VerseBrowserConsoleEntry,
  type VerseBrowserDecision,
  type VerseBrowserNetworkEntry,
} from '../../../../core/verse/browser-types.js';
import type { NativeActSpec, NativeQuery } from './native-browser.js';
import type { BrowserScreenshot } from './send-to-chat.js';

export interface BrowserExecutorCapabilities {
  screenshot: boolean;
  text: boolean;
  console: boolean;
  /** Snapshot, resolve, act, network, evaluate (a desktop shell that implements them). */
  act: boolean;
}

export interface BrowserClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTabSummary {
  index: number;
  url: string | null;
  title: string | null;
  active: boolean;
}

/** What the pane exposes to the runner (BrowserPanel builds one per render). */
export interface BrowserExecutor {
  mode: 'native' | 'frame';
  capabilities: BrowserExecutorCapabilities;
  /** The active tab's page, or nulls when no page is open. */
  current(): { url: string | null; title: string | null; tabs: number };
  navigate(url: string): Promise<{ url: string; title: string | null; loading: boolean }>;
  screenshot(clip?: BrowserClip): Promise<BrowserScreenshot & { scale?: number; origin?: { x: number; y: number } }>;
  text(limit: number): Promise<{ url: string; title: string | null; text: string; truncated: boolean }>;
  console(): Promise<{ url: string; console: VerseBrowserConsoleEntry[]; network: VerseBrowserNetworkEntry[] }>;
  /** A tap query / native action in the active tab (snapshot, network, resolve, act, evaluate). */
  query(what: Exclude<NativeQuery, string>, timeoutMs: number): Promise<unknown>;
  history(direction: 'back' | 'forward'): Promise<{ url: string | null; title: string | null; loading: boolean }>;
  tabs(): BrowserTabSummary[];
  openTab(url: string | null): Promise<void>;
  selectTab(index: number): boolean;
  closeTab(index: number): boolean;
  /** Show the operator the confirmation card and wait for their answer. */
  confirm(request: VerseBrowserConfirmRequest): Promise<VerseBrowserDecision>;
  /** The operator took over the pane; the agent waits for Resume. */
  paused(): boolean;
}

const FRAME_LIMIT =
  'This Browser pane is running in the web UI (an embedded frame), which cannot see into or act in the page. Snapshots, screenshots, page text, console and clicking need the Ashlr desktop app. You can still open localhost pages with browser_navigate.';
const OLD_SHELL =
  'This desktop app is too old to read the page structure or act in it. Ask the operator to update the Ashlr desktop app.';
const PAUSED =
  'The operator took over the browser (they clicked or typed in it), so agent actions are paused. Wait until they press Resume in the Browser pane, then try again.';
const NOT_OBSERVABLE =
  'The active tab shows a page this chat may not observe, so nothing was captured or done. Navigate to a localhost page, or ask the operator to allow that origin for this chat.';

const REF_RE = /^e[1-9][0-9]{0,6}$/;
const SIG_RE = /^[a-z0-9]{1,16}$/;
const MODIFIERS = new Set(['Shift', 'Alt', 'Control', 'Meta']);
/** A native act can type 2000 characters; the sidecar waits 60 s. */
const ACT_TIMEOUT_MS = 55_000;
const QUERY_TIMEOUT_MS = 10_000;

/** Verse's own port, from its page address ("" → the scheme default). */
export function versePortOf(origin: string): number | null {
  try {
    const url = new URL(origin);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function fail(id: string, error: string, url?: string | null): VerseBrowserCommandResult {
  return { id, ok: false, error, ...(url ? { url } : {}) };
}

function message(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'The browser could not do that.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function int(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function coord(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000 ? value : null;
}

function refOf(value: unknown): string | null {
  return typeof value === 'string' && REF_RE.test(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Closed argument shapes (anything else → null → refused)
// ---------------------------------------------------------------------------

export function parseResolveArgs(args: unknown): { ref: string } | { x: number; y: number } | { focused: true } | null {
  if (!isRecord(args)) return null;
  const keys = Object.keys(args).sort().join(',');
  if (keys === 'ref') {
    const ref = refOf(args['ref']);
    return ref ? { ref } : null;
  }
  if (keys === 'x,y') {
    const x = coord(args['x']);
    const y = coord(args['y']);
    return x !== null && y !== null ? { x, y } : null;
  }
  if (keys === 'focused' && args['focused'] === true) return { focused: true };
  return null;
}

function target(args: Record<string, unknown>): { ref: string } | { x: number; y: number } | null {
  if (args['ref'] !== undefined) {
    if (args['x'] !== undefined || args['y'] !== undefined) return null;
    const ref = refOf(args['ref']);
    return ref ? { ref } : null;
  }
  const x = coord(args['x']);
  const y = coord(args['y']);
  return x !== null && y !== null ? { x, y } : null;
}

function only(args: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(args).every((k) => allowed.includes(k));
}

function expectOf(args: Record<string, unknown>): { expect?: string } | null {
  if (args['expect'] === undefined) return {};
  return typeof args['expect'] === 'string' && SIG_RE.test(args['expect']) ? { expect: args['expect'] } : null;
}

export function parseActArgs(args: unknown): NativeActSpec | null {
  if (!isRecord(args) || typeof args['kind'] !== 'string') return null;
  const expect = expectOf(args);
  if (!expect) return null;
  switch (args['kind']) {
    case 'click': {
      if (!only(args, ['kind', 'ref', 'x', 'y', 'button', 'double', 'modifiers', 'expect'])) return null;
      const t = target(args);
      if (!t) return null;
      const button = args['button'];
      if (button !== undefined && button !== 'left' && button !== 'right') return null;
      if (args['double'] !== undefined && typeof args['double'] !== 'boolean') return null;
      const mods = args['modifiers'];
      if (mods !== undefined && (!Array.isArray(mods) || mods.length > 4 || new Set(mods).size !== mods.length || mods.some((m) => typeof m !== 'string' || !MODIFIERS.has(m)))) return null;
      return {
        kind: 'click', ...t, ...expect,
        ...(button === 'right' ? { button: 'right' as const } : {}),
        ...(args['double'] === true ? { double: true } : {}),
        ...(Array.isArray(mods) && mods.length ? { modifiers: mods as string[] } : {}),
      };
    }
    case 'type': {
      if (!only(args, ['kind', 'ref', 'text', 'submit', 'clear', 'expect'])) return null;
      const ref = refOf(args['ref']);
      const text = args['text'];
      if (!ref || typeof text !== 'string' || text.length === 0 || [...text].length > 2000) return null;
      if ((args['submit'] !== undefined && typeof args['submit'] !== 'boolean') || (args['clear'] !== undefined && typeof args['clear'] !== 'boolean')) return null;
      return { kind: 'type', ref, text, ...expect, ...(args['submit'] === true ? { submit: true } : {}), ...(args['clear'] === true ? { clear: true } : {}) };
    }
    case 'select': {
      if (!only(args, ['kind', 'ref', 'values', 'expect'])) return null;
      const ref = refOf(args['ref']);
      const values = args['values'];
      if (!ref || !Array.isArray(values) || values.length === 0 || values.length > 50 || values.some((v) => typeof v !== 'string' || v.length > 200)) return null;
      return { kind: 'select', ref, values: values as string[], ...expect };
    }
    case 'hover': {
      if (!only(args, ['kind', 'ref', 'x', 'y', 'expect'])) return null;
      const t = target(args);
      return t ? { kind: 'hover', ...t, ...expect } : null;
    }
    case 'key': {
      if (!only(args, ['kind', 'key'])) return null;
      const key = args['key'];
      return typeof key === 'string' && key.length > 0 && key.length <= 32 ? { kind: 'key', key } : null;
    }
    case 'scroll': {
      if (!only(args, ['kind', 'ref', 'direction', 'amount', 'expect'])) return null;
      const ref = args['ref'] === undefined ? null : refOf(args['ref']);
      if (args['ref'] !== undefined && !ref) return null;
      const direction = args['direction'];
      if (direction !== undefined && direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') return null;
      if (!ref && direction === undefined) return null;
      const amount = args['amount'];
      if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1 || amount > 20_000)) return null;
      return {
        kind: 'scroll', ...expect,
        ...(ref ? { ref } : {}),
        ...(direction ? { direction: direction as 'up' | 'down' | 'left' | 'right' } : {}),
        ...(typeof amount === 'number' ? { amount } : {}),
      };
    }
    default:
      return null;
  }
}

function parseClip(value: unknown): BrowserClip | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !only(value, ['x', 'y', 'width', 'height'])) return null;
  const x = coord(value['x']);
  const y = coord(value['y']);
  const w = coord(value['width']);
  const h = coord(value['height']);
  return x !== null && y !== null && w !== null && h !== null && w >= 1 && h >= 1 ? { x, y, width: w, height: h } : null;
}

export function parseConfirmArgs(args: unknown): VerseBrowserConfirmRequest | null {
  if (!isRecord(args)) return null;
  const s = (key: string, max: number): string | null => (typeof args[key] === 'string' ? (args[key] as string).slice(0, max) : null);
  const action = s('action', 200);
  const origin = s('origin', 300);
  const tool = s('tool', 60);
  const expiresAt = s('expiresAt', 40);
  const reasons = Array.isArray(args['reasons']) ? args['reasons'].filter((r): r is string => typeof r === 'string').slice(0, 8).map((r) => r.slice(0, 300)) : null;
  if (!action || !origin || !tool || !expiresAt || !reasons) return null;
  const target = args['target'] === null || args['target'] === undefined ? null : s('target', 200);
  return { action, origin, tool, expiresAt, reasons, target };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

const NEEDS_PAGE = new Set(['screenshot', 'read-text', 'console', 'snapshot', 'network', 'resolve', 'act', 'evaluate']);
const NEEDS_ACT = new Set(['snapshot', 'network', 'resolve', 'act', 'evaluate']);

export async function executeAgentCommand(
  command: VerseBrowserAgentCommand,
  exec: BrowserExecutor,
  verseOrigin: string,
): Promise<VerseBrowserCommandResult> {
  const gate = { versePort: versePortOf(verseOrigin), allowedOrigins: command.allowedOrigins };
  const here = exec.current();
  const observable = here.url !== null && agentUrlVerdict(here.url, gate).ok;
  const args = isRecord(command.args) ? command.args : {};
  const seen = (url: unknown): boolean => typeof url === 'string' && agentUrlVerdict(url, gate).ok;

  if (command.op !== 'status' && command.op !== 'confirm' && exec.paused()) return fail(command.id, PAUSED);

  try {
    if (NEEDS_PAGE.has(command.op)) {
      if (exec.mode === 'frame') return fail(command.id, FRAME_LIMIT);
      if (NEEDS_ACT.has(command.op) && !exec.capabilities.act) return fail(command.id, OLD_SHELL);
      if (!here.url) return fail(command.id, 'No page is open in the Browser pane. Open one with browser_navigate first.');
      if (!observable) return fail(command.id, NOT_OBSERVABLE);
    }

    switch (command.op) {
      case 'status':
        return {
          id: command.id,
          ok: true,
          // A page the agent may not observe is not even named.
          ...(observable && here.url ? { url: here.url } : {}),
          data: {
            title: observable ? here.title : null,
            hidden: here.url !== null && !observable,
            native: exec.mode === 'native',
            capabilities: exec.capabilities,
            tabs: here.tabs,
            paused: exec.paused(),
          },
        };

      case 'navigate': {
        const verdict = agentUrlVerdict(command.url ?? '', gate);
        if (!verdict.ok) return fail(command.id, verdict.message);
        const landed = await exec.navigate(verdict.url);
        return { id: command.id, ok: true, url: landed.url, data: { title: seen(landed.url) ? landed.title : null, loading: landed.loading } };
      }

      case 'screenshot': {
        if (!exec.capabilities.screenshot) return fail(command.id, 'This desktop shell cannot take screenshots on this platform (macOS only for now).');
        const clip = parseClip(args['clip']);
        if (clip === null) return fail(command.id, 'That screenshot area is not valid.');
        const shot = await exec.screenshot(clip);
        // The page may have moved on while the snapshot was taken.
        const now = exec.current().url;
        if (!seen(now)) return fail(command.id, NOT_OBSERVABLE);
        return { id: command.id, ok: true, url: now!, data: shot };
      }

      case 'read-text': {
        const limit = Math.max(500, Math.min(50_000, command.limit ?? 20_000));
        const read = await exec.text(limit);
        if (!seen(read.url)) return fail(command.id, 'The page changed to one this chat may not observe while it was being read.');
        return { id: command.id, ok: true, url: read.url, data: { title: read.title, text: read.text, truncated: read.truncated } };
      }

      case 'console': {
        const logs = await exec.console();
        if (!seen(logs.url)) return fail(command.id, 'The page changed to one this chat may not observe while it was being read.');
        const limit = Math.max(1, Math.min(200, command.limit ?? 50));
        return { id: command.id, ok: true, url: logs.url, data: { console: logs.console.slice(-limit), network: logs.network.slice(-limit) } };
      }

      case 'snapshot': {
        if (!only(args, ['maxNodes', 'rootRef'])) return fail(command.id, 'Invalid snapshot arguments.');
        const maxNodes = args['maxNodes'] === undefined ? 400 : int(args['maxNodes'], 20, 2000);
        const rootRef = args['rootRef'] === undefined ? undefined : refOf(args['rootRef']);
        if (maxNodes === null || rootRef === null) return fail(command.id, 'Invalid snapshot arguments.');
        const data = await exec.query({ snapshot: { max_nodes: maxNodes, ...(rootRef ? { root_ref: rootRef } : {}) } }, QUERY_TIMEOUT_MS);
        return answer(command.id, data, seen);
      }

      case 'network': {
        const limit = args['limit'] === undefined ? 100 : int(args['limit'], 1, 500);
        if (limit === null || !only(args, ['limit'])) return fail(command.id, 'Invalid network arguments.');
        return answer(command.id, await exec.query({ network: { limit } }, QUERY_TIMEOUT_MS), seen);
      }

      case 'resolve': {
        const resolved = parseResolveArgs(args);
        if (!resolved) return fail(command.id, 'Invalid element target.');
        return answer(command.id, await exec.query({ resolve: resolved }, QUERY_TIMEOUT_MS), seen);
      }

      case 'act': {
        const spec = parseActArgs(args);
        if (!spec) return fail(command.id, 'Invalid action.');
        const data = await exec.query({ act: spec }, ACT_TIMEOUT_MS);
        const record = isRecord(data) ? data : {};
        // An action can take the page somewhere this chat may not observe:
        // say so without naming it.
        if (typeof record['url'] === 'string' && !seen(record['url'])) {
          return { id: command.id, ok: true, url: here.url!, data: { kind: spec.kind, left: true } };
        }
        return { id: command.id, ok: true, url: typeof record['url'] === 'string' ? record['url'] : here.url!, data: record };
      }

      case 'evaluate': {
        const expression = args['expression'];
        if (typeof expression !== 'string' || expression.length === 0 || expression.length > 10_000 || !only(args, ['expression'])) {
          return fail(command.id, 'Invalid expression.');
        }
        try {
          if (!isLoopbackHost(new URL(here.url!).hostname)) return fail(command.id, 'Scripts only run on localhost pages.');
        } catch {
          return fail(command.id, 'Scripts only run on localhost pages.');
        }
        const data = await exec.query({ evaluate: { expression } }, 15_000);
        return { id: command.id, ok: true, url: here.url!, data };
      }

      case 'tabs': {
        const action = args['action'];
        if (!only(args, ['action', 'index', 'url'])) return fail(command.id, 'Invalid tabs arguments.');
        if (action === 'new') {
          let url: string | null = null;
          if (args['url'] !== undefined) {
            const verdict = agentUrlVerdict(typeof args['url'] === 'string' ? args['url'] : '', gate);
            if (!verdict.ok) return fail(command.id, verdict.message);
            url = verdict.url;
          }
          await exec.openTab(url);
        } else if (action === 'select' || action === 'close') {
          const index = int(args['index'], 0, 31);
          if (index === null) return fail(command.id, 'Invalid tab index.');
          const tab = exec.tabs()[index];
          if (!tab) return fail(command.id, `There is no tab ${index}.`);
          if (action === 'close' && tab.url !== null && !seen(tab.url)) {
            return fail(command.id, 'That tab shows a page this chat may not observe; only the operator can close it.');
          }
          if (!(action === 'select' ? exec.selectTab(index) : exec.closeTab(index))) return fail(command.id, `Tab ${index} could not be ${action === 'select' ? 'selected' : 'closed'}.`);
        } else if (action !== 'list') {
          return fail(command.id, 'Invalid tabs action.');
        }
        const tabs = exec.tabs().map((t) => (t.url !== null && !seen(t.url) ? { ...t, url: null, title: null, hidden: true } : t));
        return { id: command.id, ok: true, data: { tabs } };
      }

      case 'history': {
        const direction = args['direction'];
        if ((direction !== 'back' && direction !== 'forward') || !only(args, ['direction'])) return fail(command.id, 'Invalid direction.');
        if (!here.url) return fail(command.id, 'No page is open in the Browser pane.');
        const landed = await exec.history(direction);
        if (landed.url && !seen(landed.url)) return { id: command.id, ok: true, data: { hidden: true, loading: landed.loading } };
        return { id: command.id, ok: true, ...(landed.url ? { url: landed.url } : {}), data: { title: landed.title, loading: landed.loading } };
      }

      case 'confirm': {
        const request = parseConfirmArgs(args);
        if (!request) return fail(command.id, 'Invalid confirmation request.');
        const decision = await exec.confirm(request);
        return { id: command.id, ok: true, data: { decision } };
      }

      default:
        return fail(command.id, 'Unknown browser command.');
    }
  } catch (err) {
    return fail(command.id, message(err));
  }
}

/** A tap answer that names its page: only forwarded when the page is observable. */
function answer(id: string, data: unknown, seen: (url: unknown) => boolean): VerseBrowserCommandResult {
  const record = isRecord(data) ? data : {};
  if (!seen(record['url'])) return fail(id, 'The page changed to one this chat may not observe while it was being read.');
  return { id, ok: true, url: record['url'] as string, data: record };
}
