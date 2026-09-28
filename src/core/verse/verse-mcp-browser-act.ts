/**
 * core/verse/verse-mcp-browser-act.ts — the Browser pane tools that let a
 * chat's agents READ the page properly and ACT in it (3.15, agent-tools
 * design phases P2/P3).
 *
 *   reading  (scope `browser`)       browser_snapshot, browser_network,
 *                                    browser_screenshot, browser_tabs list
 *   acting   (scope `browser_act`)   browser_click, browser_type,
 *                                    browser_select, browser_hover,
 *                                    browser_press_key, browser_scroll,
 *                                    browser_wait_for, browser_back,
 *                                    browser_forward, browser_tabs mutations
 *   script   (scope `browser_script`, off by default, localhost only)
 *                                    browser_evaluate
 *
 * `tools` is adapted into the unified bearer-per-turn Verse MCP server.
 * The legacy Browser MCP endpoint keeps its five observe/navigate tools.
 *
 * WHO DECIDES. The sidecar, here, before anything is queued:
 *   1. the scope is on for this chat (the operator's switches in the pane);
 *   2. the page is one this chat may observe (browser-types.ts gate);
 *   3. the target is resolved by the page (`resolve`: role, name, form,
 *      link, sensitive?) and CLASSIFIED (browser-act-policy.ts): refuse,
 *      ask the operator (a card in the pane: Allow once / Allow for chat /
 *      Deny, up to 120 s), or go;
 *   4. the action runs with the element's signature, so a page that swapped
 *      the element between the decision and the click fails instead.
 * The pane and the desktop shell refuse sensitive fields, file inputs and
 * foreign scripts again on their side; this is the layer that asks.
 *
 * WHAT A MODEL READS. Every page-derived string is secret-scrubbed, stripped
 * of invisible characters and wrapped in `<untrusted id=…>` with a fresh
 * random id per call (the page never learns it, so it cannot close the block
 * early). Reading anything from outside this machine TAINTS the turn: every
 * later action in it needs the operator, because that content may be
 * steering the agent.
 *
 * Server-only (node:crypto for the ids); no fs, no child processes, no SDK.
 */
import { randomBytes } from 'node:crypto';

import { scrubSecrets } from '../util/scrub.js';
import {
  BROWSER_REF_RE,
  UNTRUSTED_PREFACE,
  asRequestEntries,
  asResolvedTarget,
  asSnapshotNodes,
  classifyBrowserAction,
  formatRequests,
  formatSnapshot,
  frameUntrusted,
  imagePointToCss,
  neutralisePageText,
  redactUrlQuery,
  type BrowserActionInput,
  type BrowserActionVerdict,
  type BrowserResolvedTarget,
  type BrowserShotGeometry,
  type BrowserTaint,
} from './browser-act-policy.js';
import type { BrowserConfirmOutcome, BrowserOutcome } from './browser-bridge.js';
import { agentUrlVerdict, type VerseBrowserAgentOp, type VerseBrowserConfirmRequest } from './browser-types.js';

// ---------------------------------------------------------------------------
// The registry shape (structurally identical to verse-mcp.ts's; see the header)
// ---------------------------------------------------------------------------

export type VerseMcpScope = 'browser' | 'browser_act' | 'browser_script';

/** MCP tool annotations (2025-03-26+). Hints for the client, never trusted for safety. */
export interface VerseMcpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type VerseMcpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface VerseMcpToolResult {
  content: VerseMcpContent[];
  isError?: boolean;
}

export interface VerseMcpTool<Ctx = BrowserToolContext> {
  name: string;
  description: string;
  scope: VerseMcpScope;
  annotations: VerseMcpToolAnnotations;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: Ctx): Promise<VerseMcpToolResult>;
}

// ---------------------------------------------------------------------------
// What the tools need (injected; browser-mcp.ts wires the real bridge)
// ---------------------------------------------------------------------------

export interface BrowserToolDeps {
  run(
    sessionId: string,
    op: VerseBrowserAgentOp,
    args: { url?: string; limit?: number; args?: Record<string, unknown> },
    timeouts?: { resultMs?: number },
  ): Promise<BrowserOutcome>;
  versePort: number | null;
  allowedOrigins(sessionId: string): string[];
  recordBlocked(sessionId: string, url: string, origin: string): void;
  scopes(sessionId: string): { access: boolean; act: boolean; script: boolean };
  confirm(sessionId: string, request: Omit<VerseBrowserConfirmRequest, 'expiresAt'>): Promise<BrowserConfirmOutcome>;
  taint(sessionId: string): BrowserTaint | null;
  markTaint(sessionId: string, origin: string): void;
  allowances(sessionId: string): string[];
  allowanceRevision(sessionId: string): number;
  addAllowances(sessionId: string, keys: readonly string[]): void;
  snapshotLoad(sessionId: string): string | null;
  setSnapshotLoad(sessionId: string, loadId: string | null): void;
  shot(sessionId: string): BrowserShotGeometry | null;
  setShot(sessionId: string, shot: BrowserShotGeometry | null): void;
  /** A fresh id for one `<untrusted>` block. */
  nonce(): string;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface BrowserToolContext {
  sessionId: string;
  deps: BrowserToolDeps;
}

export function defaultNonce(): string {
  return randomBytes(9).toString('hex');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const MAX_IMAGE_BASE64 = 12 * 1024 * 1024;
/** One native action (typing 2000 characters included) finishes well inside this. */
const ACT_RESULT_MS = 60_000;
const WAIT_MAX_MS = 30_000;
const WAIT_POLL_MS = 500;

function text(t: string): VerseMcpContent {
  return { type: 'text', text: t };
}

function ok(t: string): VerseMcpToolResult {
  return { content: [text(t)] };
}

function toolError(message: string): VerseMcpToolResult {
  return { content: [text(message)], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResult(value: unknown): value is VerseMcpToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function intArg(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

/** Page text → scrubbed, neutralised, framed. The preface sits outside the block. */
function untrusted(ctx: BrowserToolContext, body: string): string {
  return `${UNTRUSTED_PREFACE}\n${frameUntrusted(ctx.deps.nonce(), scrubSecrets(body))}`;
}

/** A page URL as the model reads it: secrets in the query redacted, invisible characters gone. */
function shownUrl(url: string): string {
  return neutralisePageText(scrubSecrets(redactUrlQuery(url))).slice(0, 2000);
}

type Observed = { ok: true; url: string; origin: string; loopback: boolean } | { ok: false; message: string };
type ActionPage = Extract<Observed, { ok: true }> & { tabId: string; loadId: string };

function observe(ctx: BrowserToolContext, url: unknown): Observed {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, message: 'The Browser pane did not say which page it is on, so nothing was used.' };
  }
  const verdict = agentUrlVerdict(url, { versePort: ctx.deps.versePort, allowedOrigins: ctx.deps.allowedOrigins(ctx.sessionId) });
  if (!verdict.ok) {
    return {
      ok: false,
      message: `The active tab shows ${verdict.origin ?? 'a page'} that this chat may not observe, so nothing was read or done. Navigate to a localhost page, or ask the operator to allow that origin for this chat in the Browser pane.`,
    };
  }
  return { ok: true, url: verdict.url, origin: verdict.origin, loopback: verdict.loopback };
}

/** Content from outside this machine now reached the model: later actions in this turn need the operator. */
function noteRead(ctx: BrowserToolContext, seen: Observed): void {
  if (seen.ok && !seen.loopback) ctx.deps.markTaint(ctx.sessionId, seen.origin);
}

/** A friendly sentence for the codes the page and the desktop shell answer with. */
const FAILURES: Readonly<Record<string, string>> = {
  'stale-ref': 'That ref is no longer on the page (it changed or reloaded). Take a new browser_snapshot and use a ref from it.',
  changed: 'The element changed between the check and the action, so nothing was done. Take a new browser_snapshot.',
  'nothing-there': 'There is no element at that point.',
  'nothing-focused': 'Nothing on the page has keyboard focus. Click a field first.',
  'not-visible': 'That element has no size on the page (it is hidden or collapsed).',
  obscured: 'Something else on the page (a dialog, banner or overlay) covers that element, so the click would land on it. Deal with the overlay first.',
  disabled: 'That control is disabled.',
  'sensitive-field': 'That is a password, payment, SSN or secret field. Agents never type into those — ask the operator to fill it in.',
  'not-editable': 'That element does not take text.',
  'read-only': 'That field is read-only.',
  'use-select': 'That is a drop-down: use browser_select.',
  'file-input': 'Agents never choose files to upload. Ask the operator.',
  'not-a-select': 'That element is not a drop-down (<select>).',
  'not-multiple': 'That drop-down takes one option only.',
  'no-such-option': 'None of the drop-down\'s options matches that value or label. Check the options in browser_snapshot.',
  'scroll-failed': 'The page could not be scrolled.',
  'clear-failed': 'The field could not be cleared.',
  'tap-missing': 'The page is still loading (the browser has not attached to it yet). Try again in a moment.',
  unsupported: 'This desktop shell cannot do that on this platform (acting in the pane needs the Ashlr desktop app on macOS).',
  'no-tab': 'No page is open in the Browser pane.',
  timeout: 'The browser did not finish in time.',
  'bad-point': 'That point is outside the page.',
  'newline-in-single-line-field': 'A newline in a single-line field would submit its form. Use submit: true instead.',
  'not-loopback': 'Scripts only run on localhost pages.',
};

function failure(outcome: Extract<BrowserOutcome, { ok: false }>): VerseMcpToolResult {
  const code = outcome.message.trim();
  return toolError(FAILURES[code] ?? outcome.message);
}

async function currentPage(ctx: BrowserToolContext): Promise<ActionPage | VerseMcpToolResult> {
  const status = await ctx.deps.run(ctx.sessionId, 'status', {});
  if (!status.ok) return failure(status);
  const data = isRecord(status.data) ? status.data : {};
  if (data['hidden'] === true) return toolError('The active tab shows a page this chat may not observe, so nothing was done.');
  if (!status.url) return toolError('No page is open in the Browser pane. Open one with browser_navigate first.');
  const seen = observe(ctx, status.url);
  if (!seen.ok) return toolError(seen.message);
  const tabId = data['tabId'];
  const loadId = data['loadId'];
  if (typeof tabId !== 'string' || !/^[a-z0-9]{1,16}$/.test(tabId)
    || typeof loadId !== 'string' || !/^[a-zA-Z0-9]{1,40}$/.test(loadId)) {
    return toolError('The Browser pane could not verify the active tab and page load. Wait for it to finish loading, then try again.');
  }
  return { ...seen, tabId, loadId };
}

/**
 * Ask the operator when the classifier says so. Null = go ahead; a result =
 * stop and tell the agent why.
 */
async function decide(
  ctx: BrowserToolContext,
  tool: string,
  verdict: BrowserActionVerdict,
  card: { action: string; target: string | null; origin: string },
): Promise<VerseMcpToolResult | null> {
  if (verdict.decision === 'refuse') return toolError(verdict.message);
  if (verdict.decision === 'auto') return null;
  const allowanceRevision = ctx.deps.allowanceRevision(ctx.sessionId);
  const answer = await ctx.deps.confirm(ctx.sessionId, {
    action: card.action.slice(0, 200),
    target: card.target ? neutralisePageText(card.target).slice(0, 200) : null,
    origin: card.origin,
    reasons: verdict.reasons.map((r) => r.text),
    tool,
  });
  if (ctx.deps.allowanceRevision(ctx.sessionId) !== allowanceRevision) {
    return toolError('Browser approval changed while the confirmation was open. Nothing was done; ask the operator again.');
  }
  if (answer === 'chat') ctx.deps.addAllowances(ctx.sessionId, verdict.reasons.map((r) => r.allowKey));
  if (answer === 'once' || answer === 'chat') return null;
  const why = verdict.reasons.map((r) => r.text).join('; ');
  if (answer === 'deny') return toolError(`The operator declined this action (${why}). It was not done; do not retry it unless they ask you to.`);
  if (answer === 'timeout') return toolError(`The operator did not answer within 2 minutes (${why}), so the action was not done.`);
  return toolError(`This action needs the operator's approval (${why}), but the Browser pane could not ask them. Nothing was done.`);
}

function classify(ctx: BrowserToolContext, input: Omit<BrowserActionInput, 'taint' | 'allowances'>): BrowserActionVerdict {
  return classifyBrowserAction({ ...input, taint: ctx.deps.taint(ctx.sessionId), allowances: ctx.deps.allowances(ctx.sessionId) });
}

function needScope(ctx: BrowserToolContext, scope: VerseMcpScope): VerseMcpToolResult | null {
  const scopes = ctx.deps.scopes(ctx.sessionId);
  if (scope === 'browser_act' && !scopes.act) {
    return toolError('The operator has switched clicking and typing off for this chat (Browser pane ▸ Agent access). You can still look at the page.');
  }
  if (scope === 'browser_script' && !scopes.script) {
    return toolError('The operator has not allowed page scripts for this chat (Browser pane ▸ Agent access ▸ Scripts). Use browser_snapshot or browser_read_text instead.');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Targets: a ref from the last snapshot, or a point in the last screenshot
// ---------------------------------------------------------------------------

interface Target {
  target: BrowserResolvedTarget;
  /** What the act command names the element by. */
  spec: { ref: string } | { x: number; y: number };
  page: ActionPage;
}

function refArg(args: Record<string, unknown>, key = 'ref'): string | null | VerseMcpToolResult {
  const raw = args[key];
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !BROWSER_REF_RE.test(raw)) {
    return toolError(`${key} must be a ref from browser_snapshot, like "e12".`);
  }
  return raw;
}

async function resolveTarget(ctx: BrowserToolContext, args: Record<string, unknown>, allowPoint: boolean): Promise<Target | VerseMcpToolResult> {
  const ref = refArg(args);
  if (isResult(ref)) return ref;
  const hasPoint = args['x'] !== undefined || args['y'] !== undefined;
  let spec: Target['spec'];
  let shotUrl: string | null = null;
  if (ref) {
    if (hasPoint) return toolError('Pass either ref or x and y, not both.');
    if (!ctx.deps.snapshotLoad(ctx.sessionId)) return toolError('Take a browser_snapshot first: refs come from it.');
    spec = { ref };
  } else if (allowPoint && hasPoint) {
    const x = args['x'];
    const y = args['y'];
    if (typeof x !== 'number' || typeof y !== 'number') return toolError('x and y must both be numbers (pixels in the last browser_screenshot).');
    const shot = ctx.deps.shot(ctx.sessionId);
    if (!shot) return toolError('Take a browser_screenshot first: x and y are pixel positions in it.');
    const css = imagePointToCss(shot, x, y);
    if (!css) return toolError(`(${x}, ${y}) is outside the last screenshot (${shot.width}×${shot.height} px).`);
    spec = css;
    shotUrl = shot.url;
  } else {
    return toolError(allowPoint ? 'Pass ref (from browser_snapshot) or x and y (pixels in the last browser_screenshot).' : 'Pass ref (from browser_snapshot).');
  }
  const outcome = await ctx.deps.run(ctx.sessionId, 'resolve', { args: spec });
  if (!outcome.ok) return failure(outcome);
  const resolvedPage = observe(ctx, outcome.url);
  if (!resolvedPage.ok) return toolError(resolvedPage.message);
  const page = await currentPage(ctx);
  if (isResult(page)) return page;
  if (page.url !== outcome.url) return toolError('The tab navigated while resolving the element. Take a new browser_snapshot.');
  const target = asResolvedTarget(outcome.data);
  if (!target) return toolError('The page gave an unreadable answer about that element.');
  if (target.loadId !== page.loadId) return toolError('The page reloaded while resolving the element. Take a new browser_snapshot.');
  if (shotUrl !== null && shotUrl !== page.url) {
    ctx.deps.setShot(ctx.sessionId, null);
    return toolError('The page has changed since your last browser_screenshot, so its pixels no longer line up. Take a new screenshot.');
  }
  if ('ref' in spec && target.loadId !== ctx.deps.snapshotLoad(ctx.sessionId)) {
    return toolError('The page has reloaded or navigated since your last browser_snapshot, so its refs no longer apply. Take a new snapshot.');
  }
  if (target.hidden) return toolError('That element is hidden on the page.');
  return { target, spec, page };
}

function describe(target: BrowserResolvedTarget): string {
  return `${target.role} [ref=${target.ref}]`;
}

/** After an action: where the page is now (never naming a page the chat may not observe). */
function landed(ctx: BrowserToolContext, before: string, data: Record<string, unknown>): string {
  if (data['left'] === true) return ' The page moved to one this chat may not observe.';
  const now = str(data['url'], 4096);
  if (!now || now === before) return '';
  const seen = observe(ctx, now);
  return seen.ok ? ` The page is now ${shownUrl(seen.url)}.` : ' The page moved to one this chat may not observe.';
}

async function act(ctx: BrowserToolContext, spec: Record<string, unknown>, page: ActionPage): Promise<BrowserOutcome> {
  return ctx.deps.run(ctx.sessionId, 'act', {
    args: { ...spec, approved: { tab: page.tabId, url: page.url, origin: page.origin, loadId: page.loadId } },
  }, { resultMs: ACT_RESULT_MS });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const REF_SCHEMA = { type: 'string', pattern: '^e[1-9][0-9]{0,6}$', description: 'An element ref from browser_snapshot, e.g. "e12".' };
const ELEMENT_SCHEMA = {
  type: 'string',
  maxLength: 200,
  description: 'Your short description of the element ("the Save button"), shown to the operator if the action needs their approval.',
};

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const snapshotTool: VerseMcpTool = {
  name: 'browser_snapshot',
  scope: 'browser',
  description:
    'An accessibility-style outline of what is visible on the page in the Browser pane: one line per element with its role, name, state and a ref (e.g. [ref=e12]) that browser_click / browser_type / browser_select / browser_hover / browser_screenshot take. Hidden and aria-hidden content is left out; password and payment field values always read [redacted]. Refs are valid until the page reloads or navigates. Prefer this over screenshots for finding things.',
  annotations: { title: 'Page outline', readOnlyHint: true, openWorldHint: false },
  inputSchema: schema({
    max_nodes: { type: 'integer', minimum: 20, maximum: 2000, description: 'Most elements to list (default 400).' },
    root_ref: { ...REF_SCHEMA, description: 'Only the part of the page inside this element.' },
  }),
  async handler(args, ctx) {
    const root = refArg(args, 'root_ref');
    if (isResult(root)) return root;
    const maxNodes = intArg(args, 'max_nodes', 20, 2000, 400);
    const outcome = await ctx.deps.run(ctx.sessionId, 'snapshot', { args: { maxNodes, ...(root ? { rootRef: root } : {}) } });
    if (!outcome.ok) return failure(outcome);
    const seen = observe(ctx, outcome.url);
    if (!seen.ok) return toolError(seen.message);
    const data = isRecord(outcome.data) ? outcome.data : {};
    const loadId = str(data['loadId'], 40);
    ctx.deps.setSnapshotLoad(ctx.sessionId, loadId || null);
    const nodes = asSnapshotNodes(data['nodes'], maxNodes);
    noteRead(ctx, seen);
    const title = str(data['title'], 200);
    const body = [title ? `title: ${JSON.stringify(title)}` : null, formatSnapshot(nodes) || '(nothing visible)'].filter(Boolean).join('\n');
    return ok([
      `Snapshot of ${shownUrl(seen.url)} — ${nodes.length} element${nodes.length === 1 ? '' : 's'}${data['truncated'] === true ? ' (truncated: pass a larger max_nodes, or a root_ref for one part of the page)' : ''}. Refs are valid until the page reloads or navigates.`,
      untrusted(ctx, body),
    ].join('\n'));
  },
};

const networkTool: VerseMcpTool = {
  name: 'browser_network',
  scope: 'browser',
  description:
    'Recent fetch / XMLHttpRequest calls made by the page in the Browser pane since it loaded: method, URL, status, time and sizes. Metadata only — never request or response bodies or headers.',
  annotations: { title: 'Network requests', readOnlyHint: true, openWorldHint: false },
  inputSchema: schema({
    limit: { type: 'integer', minimum: 1, maximum: 300, description: 'Most recent requests to list (default 50).' },
    url_pattern: { type: 'string', maxLength: 200, description: 'Only requests whose URL contains this text (case-insensitive).' },
  }),
  async handler(args, ctx) {
    const limit = intArg(args, 'limit', 1, 300, 50);
    const pattern = str(args['url_pattern'], 200).toLowerCase();
    const outcome = await ctx.deps.run(ctx.sessionId, 'network', { args: { limit: 300 } });
    if (!outcome.ok) return failure(outcome);
    const seen = observe(ctx, outcome.url);
    if (!seen.ok) return toolError(seen.message);
    const data = isRecord(outcome.data) ? outcome.data : {};
    const all = asRequestEntries(data['requests']);
    const matched = pattern ? all.filter((e) => e.url.toLowerCase().includes(pattern)) : all;
    const shown = matched.slice(-limit);
    noteRead(ctx, seen);
    return ok([
      `Requests from ${shownUrl(seen.url)}: ${shown.length}${matched.length > shown.length ? ` of ${matched.length}` : ''}${pattern ? ` matching "${pattern}"` : ''}.`,
      untrusted(ctx, formatRequests(shown)),
    ].join('\n'));
  },
};

function asShot(data: Record<string, unknown>): { mime: 'image/png' | 'image/jpeg'; base64: string; width: number; height: number } | null {
  const mime = data['mime'];
  const b64 = data['base64'];
  if ((mime !== 'image/png' && mime !== 'image/jpeg') || typeof b64 !== 'string' || b64.length === 0
    || b64.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const width = typeof data['width'] === 'number' && data['width'] > 0 ? data['width'] : 0;
  const height = typeof data['height'] === 'number' && data['height'] > 0 ? data['height'] : 0;
  return { mime, base64: b64, width, height };
}

const screenshotTool: VerseMcpTool = {
  name: 'browser_screenshot',
  scope: 'browser',
  description:
    'A screenshot of the visible page in the Browser pane (at most 1280×800 px), or of one element (ref). The answer says how image pixels map to the page; browser_click accepts x and y in this image\'s pixels. Needs the Ashlr desktop app on macOS.',
  annotations: { title: 'Screenshot', readOnlyHint: true, openWorldHint: false },
  inputSchema: schema({
    ref: { ...REF_SCHEMA, description: 'Capture just this element (it must be on screen; browser_scroll to it first).' },
    full_page: { type: 'boolean', description: 'Ask for the whole page. Not available in this browser: you get the visible part and a note.' },
  }),
  async handler(args, ctx) {
    let clip: { x: number; y: number; width: number; height: number } | null = null;
    if (args['ref'] !== undefined) {
      const resolved = await resolveTarget(ctx, { ref: args['ref'] }, false);
      if (isResult(resolved)) return resolved;
      const r = resolved.target.rect;
      const vw = resolved.target.vw;
      const vh = resolved.target.vh;
      const x = Math.max(0, r.x);
      const y = Math.max(0, r.y);
      const right = vw > 0 ? Math.min(vw, r.x + r.width) : r.x + r.width;
      const bottom = vh > 0 ? Math.min(vh, r.y + r.height) : r.y + r.height;
      if (right - x < 1 || bottom - y < 1) {
        return toolError(`${describe(resolved.target)} is not on screen. Scroll to it first (browser_scroll with ref).`);
      }
      clip = { x, y, width: right - x, height: bottom - y };
    }
    const outcome = await ctx.deps.run(ctx.sessionId, 'screenshot', clip ? { args: { clip } } : {});
    if (!outcome.ok) return failure(outcome);
    const seen = observe(ctx, outcome.url);
    if (!seen.ok) return toolError(seen.message);
    const data = isRecord(outcome.data) ? outcome.data : {};
    const shot = asShot(data);
    if (!shot) return toolError('The Browser pane returned an unreadable screenshot.');
    const origin = isRecord(data['origin']) ? data['origin'] : {};
    const scale = typeof data['scale'] === 'number' && Number.isFinite(data['scale']) && data['scale'] > 0 ? data['scale'] : null;
    if (scale && shot.width && shot.height) {
      ctx.deps.setShot(ctx.sessionId, {
        scale,
        originX: typeof origin['x'] === 'number' ? origin['x'] : clip?.x ?? 0,
        originY: typeof origin['y'] === 'number' ? origin['y'] : clip?.y ?? 0,
        width: shot.width,
        height: shot.height,
        url: seen.url,
      });
    } else {
      ctx.deps.setShot(ctx.sessionId, null);
    }
    noteRead(ctx, seen);
    const lines = [
      `Screenshot of ${shownUrl(seen.url)}${clip ? ` (element ${String(args['ref'])})` : ''}${shot.width && shot.height ? `: ${shot.width}×${shot.height} px` : ''}.`,
      scale
        ? `1 image px = ${Math.round(scale * 1000) / 1000} CSS px. To click a spot in this image, call browser_click with its pixel x and y (they are mapped back to the page for you).`
        : 'This desktop shell did not report the image scale, so clicking by x and y is unavailable; use refs from browser_snapshot.',
    ];
    if (args['full_page'] === true) {
      lines.unshift('Full-page capture is not available in this browser: this is the visible part of the page. Use browser_scroll and take another screenshot to see more.');
    }
    return { content: [{ type: 'image', data: shot.base64, mimeType: shot.mime }, text(lines.join('\n'))] };
  },
};

const tabsTool: VerseMcpTool = {
  name: 'browser_tabs',
  scope: 'browser',
  description:
    'List, open, switch or close tabs in the Browser pane. list: every tab (pages this chat may not observe are not named). new: open a tab (optionally at a URL; same rules as browser_navigate). select / close: by index from list.',
  annotations: { title: 'Tabs', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  inputSchema: schema({
    action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
    index: { type: 'integer', minimum: 0, maximum: 31, description: 'select / close: the tab\'s index from list.' },
    url: { type: 'string', maxLength: 4096, description: 'new: the address to open (localhost, or an origin the operator allowed).' },
  }, ['action']),
  async handler(args, ctx) {
    const action = args['action'];
    if (action !== 'list' && action !== 'new' && action !== 'select' && action !== 'close') return toolError('action must be list, new, select or close.');
    if (action !== 'list') {
      const denied = needScope(ctx, 'browser_act');
      if (denied) return denied;
    }
    const index = typeof args['index'] === 'number' && Number.isInteger(args['index']) ? args['index'] : null;
    if ((action === 'select' || action === 'close') && (index === null || index < 0 || index > 31)) return toolError(`${action} needs the tab's index from browser_tabs list.`);
    let url: string | undefined;
    if (action === 'new' && typeof args['url'] === 'string' && args['url'].trim()) {
      const verdict = agentUrlVerdict(args['url'].trim(), { versePort: ctx.deps.versePort, allowedOrigins: ctx.deps.allowedOrigins(ctx.sessionId) });
      if (!verdict.ok) {
        if (verdict.code === 'not-allowed' && verdict.origin) ctx.deps.recordBlocked(ctx.sessionId, args['url'].trim(), verdict.origin);
        return toolError(verdict.message);
      }
      url = verdict.url;
      const gate = await decide(ctx, 'browser_tabs', classify(ctx, { kind: 'tab', pageUrl: verdict.url, loopback: verdict.loopback }), {
        action: `Open a new tab at ${verdict.url}`, target: null, origin: verdict.origin,
      });
      if (gate) return gate;
    }
    const outcome = await ctx.deps.run(ctx.sessionId, 'tabs', { args: { action, ...(index !== null ? { index } : {}), ...(url ? { url } : {}) } });
    if (!outcome.ok) return failure(outcome);
    const data = isRecord(outcome.data) ? outcome.data : {};
    const tabs = Array.isArray(data['tabs']) ? data['tabs'].filter(isRecord).slice(0, 32) : [];
    const lines: string[] = [];
    for (const tab of tabs) {
      const i = typeof tab['index'] === 'number' ? tab['index'] : lines.length;
      const tabUrl = str(tab['url'], 4096);
      const seen = tabUrl ? observe(ctx, tabUrl) : null;
      const where = !tabUrl ? 'new tab' : seen?.ok ? shownUrl(seen.url) : '(a page this chat may not observe)';
      const title = seen?.ok ? str(tab['title'], 200) : '';
      if (seen?.ok) noteRead(ctx, seen);
      lines.push(`${i}${tab['active'] === true ? ' (active)' : ''}: ${where}${title ? ` — title: ${title}` : ''}`);
    }
    const head = action === 'list' ? `${tabs.length} tab${tabs.length === 1 ? '' : 's'}:` : action === 'new' ? 'Opened a new tab. Tabs now:' : action === 'select' ? `Switched to tab ${index}. Tabs now:` : `Closed tab ${index}. Tabs now:`;
    return ok([head, untrusted(ctx, lines.join('\n') || '(none)')].join('\n'));
  },
};

function historyTool(direction: 'back' | 'forward'): VerseMcpTool {
  return {
    name: `browser_${direction}`,
    scope: 'browser_act',
    description: `Go ${direction} in the Browser pane's active tab history and wait for the page to load.`,
    annotations: { title: direction === 'back' ? 'Back' : 'Forward', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: schema({}),
    async handler(_args, ctx) {
      const page = await currentPage(ctx);
      if (isResult(page)) return page;
      const gate = await decide(ctx, `browser_${direction}`, classify(ctx, { kind: 'history', pageUrl: page.url, loopback: page.loopback }), {
        action: `Go ${direction}`, target: null, origin: page.origin,
      });
      if (gate) return gate;
      const outcome = await ctx.deps.run(ctx.sessionId, 'history', { args: { direction } });
      if (!outcome.ok) return failure(outcome);
      const data = isRecord(outcome.data) ? outcome.data : {};
      if (data['hidden'] === true) return ok(`Went ${direction}; the tab now shows a page this chat may not observe.`);
      const seen = outcome.url ? observe(ctx, outcome.url) : null;
      if (!seen) return ok(`Went ${direction}.`);
      if (!seen.ok) return ok(`Went ${direction}; the tab now shows a page this chat may not observe.`);
      noteRead(ctx, seen);
      return ok(`Went ${direction} to ${shownUrl(seen.url)}.${data['loading'] === true ? ' (still loading)' : ''}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

const MODIFIERS = ['Shift', 'Alt', 'Control', 'Meta'] as const;

const clickTool: VerseMcpTool = {
  name: 'browser_click',
  scope: 'browser_act',
  description:
    'Click an element in the Browser pane, as a real mouse click. Target it by ref (from browser_snapshot) or by x and y (pixels in the last browser_screenshot). Clicks on localhost pages happen at once; submitting a form, controls labelled delete / pay / buy / send / publish / post / confirm, links to another site, pages outside localhost, and anything after reading an outside page first ask the operator (up to 2 minutes). File pickers and downloads are never clicked.',
  annotations: { title: 'Click', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: schema({
    ref: REF_SCHEMA,
    x: { type: 'number', minimum: 0, description: 'Pixel x in the last browser_screenshot (instead of ref).' },
    y: { type: 'number', minimum: 0, description: 'Pixel y in the last browser_screenshot (instead of ref).' },
    element: ELEMENT_SCHEMA,
    button: { type: 'string', enum: ['left', 'right'], description: 'Default left. A right click opens the page\'s own context menu, never the browser\'s.' },
    double: { type: 'boolean', description: 'Double-click.' },
    modifiers: { type: 'array', items: { type: 'string', enum: [...MODIFIERS] }, maxItems: 4, uniqueItems: true },
  }, ['element']),
  async handler(args, ctx) {
    const scoped = needScope(ctx, 'browser_act');
    if (scoped) return scoped;
    const button = args['button'] === undefined ? 'left' : args['button'];
    if (button !== 'left' && button !== 'right') return toolError('button must be left or right.');
    const modifiers = Array.isArray(args['modifiers']) ? args['modifiers'] : [];
    if (modifiers.length > 4 || modifiers.some((m) => !(MODIFIERS as readonly unknown[]).includes(m)) || new Set(modifiers).size !== modifiers.length) {
      return toolError('modifiers must be distinct values from Shift, Alt, Control, Meta.');
    }
    const resolved = await resolveTarget(ctx, args, true);
    if (isResult(resolved)) return resolved;
    const { target, spec, page } = resolved;
    const verdict = classify(ctx, { kind: 'click', pageUrl: page.url, loopback: page.loopback, target });
    const gate = await decide(ctx, 'browser_click', verdict, {
      action: `${args['double'] === true ? 'Double-click' : button === 'right' ? 'Right-click' : 'Click'} ${str(args['element'], 200) || 'an element'}`,
      target: `${target.role}${target.name ? ` "${target.name}"` : ''}`,
      origin: page.origin,
    });
    if (gate) return gate;
    const outcome = await act(ctx, {
      kind: 'click', ...spec, expect: target.sig,
      ...(button === 'right' ? { button: 'right' } : {}),
      ...(args['double'] === true ? { double: true } : {}),
      ...(modifiers.length ? { modifiers } : {}),
    }, page);
    if (!outcome.ok) return failure(outcome);
    const data = isRecord(outcome.data) ? outcome.data : {};
    const how = args['double'] === true ? 'Double-clicked' : button === 'right' ? 'Right-clicked' : 'Clicked';
    return ok(`${how} ${describe(target)}.${data['synthetic'] === true ? ' (The page got a contextmenu event; the browser\'s own menu does not open.)' : ''}${landed(ctx, page.url, data)}`);
  },
};

const typeTool: VerseMcpTool = {
  name: 'browser_type',
  scope: 'browser_act',
  description:
    'Type text into a text field (ref from browser_snapshot), as real key presses. clear: replace what is there. submit: press Enter afterwards (submitting a form asks the operator first). Password, payment, SSN and other secret fields are never typed into — ask the operator.',
  annotations: { title: 'Type', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: schema({
    ref: REF_SCHEMA,
    text: { type: 'string', minLength: 1, maxLength: 2000 },
    element: ELEMENT_SCHEMA,
    submit: { type: 'boolean', description: 'Press Enter after typing.' },
    clear: { type: 'boolean', description: 'Select and delete the field\'s current text first.' },
  }, ['ref', 'text']),
  async handler(args, ctx) {
    const scoped = needScope(ctx, 'browser_act');
    if (scoped) return scoped;
    const raw = args['text'];
    if (typeof raw !== 'string') return toolError('text must be 1–2000 characters.');
    // Line breaks are one \n each; any other control character (or AppKit's
    // function-key range) would act as a key press, so it is refused — the
    // desktop shell refuses it too.
    const value = raw.replace(/\r\n?/g, '\n');
    if (value.length === 0 || [...value].length > 2000) return toolError('text must be 1–2000 characters.');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\uF700-\uF8FF]/.test(value)) {
      return toolError('text may not contain control characters (use browser_press_key for keys like Escape or Backspace).');
    }
    const resolved = await resolveTarget(ctx, { ref: args['ref'] }, false);
    if (isResult(resolved)) return resolved;
    const { target, spec, page } = resolved;
    const submit = args['submit'] === true;
    const verdict = classify(ctx, { kind: 'type', pageUrl: page.url, loopback: page.loopback, target, text: value, submit });
    const gate = await decide(ctx, 'browser_type', verdict, {
      action: `Type ${value.length} character${value.length === 1 ? '' : 's'} into ${str(args['element'], 200) || 'a field'}${submit ? ' and press Enter' : ''}`,
      target: `${target.role}${target.name ? ` "${target.name}"` : ''}`,
      origin: page.origin,
    });
    if (gate) return gate;
    const outcome = await act(ctx, {
      kind: 'type', ...spec, text: value, expect: target.sig,
      ...(submit ? { submit: true } : {}),
      ...(args['clear'] === true ? { clear: true } : {}),
    }, page);
    if (!outcome.ok) return failure(outcome);
    const data = isRecord(outcome.data) ? outcome.data : {};
    return ok(`Typed ${value.length} character${value.length === 1 ? '' : 's'} into ${describe(target)}${args['clear'] === true ? ' (replacing its text)' : ''}${submit ? ' and pressed Enter' : ''}.${landed(ctx, page.url, data)}`);
  },
};

const selectTool: VerseMcpTool = {
  name: 'browser_select',
  scope: 'browser_act',
  description: 'Choose option(s) in a drop-down (<select>, ref from browser_snapshot) by value or visible label.',
  annotations: { title: 'Select', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: schema({
    ref: REF_SCHEMA,
    values: { type: 'array', items: { type: 'string', maxLength: 200 }, minItems: 1, maxItems: 50 },
    element: ELEMENT_SCHEMA,
  }, ['ref', 'values']),
  async handler(args, ctx) {
    const scoped = needScope(ctx, 'browser_act');
    if (scoped) return scoped;
    const values = args['values'];
    if (!Array.isArray(values) || values.length === 0 || values.length > 50 || values.some((v) => typeof v !== 'string' || v.length > 200)) {
      return toolError('values must be 1–50 strings (option values or labels).');
    }
    const resolved = await resolveTarget(ctx, { ref: args['ref'] }, false);
    if (isResult(resolved)) return resolved;
    const { target, spec, page } = resolved;
    const verdict = classify(ctx, { kind: 'select', pageUrl: page.url, loopback: page.loopback, target });
    const gate = await decide(ctx, 'browser_select', verdict, {
      action: `Choose ${values.length} option${values.length === 1 ? '' : 's'} in ${str(args['element'], 200) || 'a drop-down'}`,
      target: `${target.role}${target.name ? ` "${target.name}"` : ''}`,
      origin: page.origin,
    });
    if (gate) return gate;
    const outcome = await act(ctx, { kind: 'select', ...spec, values, expect: target.sig }, page);
    if (!outcome.ok) return failure(outcome);
    const data = isRecord(outcome.data) ? outcome.data : {};
    const selected = Array.isArray(data['selected']) ? data['selected'].filter((s): s is string => typeof s === 'string').slice(0, 20) : [];
    return ok([`Selected in ${describe(target)}:`, untrusted(ctx, selected.join('\n') || '(nothing)')].join('\n'));
  },
};

const hoverTool: VerseMcpTool = {
  name: 'browser_hover',
  scope: 'browser_act',
  description: 'Move the mouse over an element (ref from browser_snapshot), e.g. to open a hover menu or tooltip.',
  annotations: { title: 'Hover', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: schema({ ref: REF_SCHEMA, element: ELEMENT_SCHEMA }, ['ref']),
  async handler(args, ctx) {
    const scoped = needScope(ctx, 'browser_act');
    if (scoped) return scoped;
    const resolved = await resolveTarget(ctx, { ref: args['ref'] }, false);
    if (isResult(resolved)) return resolved;
    const { target, spec, page } = resolved;
    const gate = await decide(ctx, 'browser_hover', classify(ctx, { kind: 'hover', pageUrl: page.url, loopback: page.loopback, target }), {
      action: `Hover over ${str(args['element'], 200) || 'an element'}`, target: `${target.role}${target.name ? ` "${target.name}"` : ''}`, origin: page.origin,
    });
    if (gate) return gate;
    const outcome = await act(ctx, { kind: 'hover', ...spec, expect: target.sig }, page);
    if (!outcome.ok) return failure(outcome);
    const data = isRecord(outcome.data) ? outcome.data : {};
    const note = data['hovered'] === false ? ' The page did not register the hover (the desktop app may be in the background); a snapshot will show whether a menu opened.' : '';
    return ok(`Hovered over ${describe(target)}.${note}`);
  },
};

const pressKeyTool: VerseMcpTool = {
  name: 'browser_press_key',
  scope: 'browser_act',
  description:
    'Press a key (or combination) in the page\'s focused element, as a real key press: a single character, or Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space — optionally with Shift+, Alt+, Control+ (Meta+ only with a or z). Enter in a form field asks the operator first. Never types into password or payment fields.',
  annotations: { title: 'Press key', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: schema({ key: { type: 'string', maxLength: 32, description: 'e.g. "Enter", "Escape", "Shift+Tab", "a".' } }, ['key']),
  async handler(args, ctx) {
    const scoped = needScope(ctx, 'browser_act');
    if (scoped) return scoped;
    const key = typeof args['key'] === 'string' ? args['key'] : '';
    // What has focus matters (Enter submits; letters in a password field are refused).
    const focused = await ctx.deps.run(ctx.sessionId, 'resolve', { args: { focused: true } });
    let target: BrowserResolvedTarget | null = null;
    let pageUrl: string | null = null;
    if (focused.ok) {
      target = asResolvedTarget(focused.data);
      pageUrl = focused.url ?? null;
    } else if (focused.message.trim() !== 'nothing-focused') {
      return failure(focused);
    }
    const page = await currentPage(ctx);
    if (isResult(page)) return page;
    if (pageUrl && pageUrl !== page.url) return toolError('The tab navigated while checking keyboard focus. Try again.');
    if (target && target.loadId !== page.loadId) return toolError('The page reloaded while checking keyboard focus. Try again.');
    const verdict = classify(ctx, { kind: 'key', pageUrl: page.url, loopback: page.loopback, target, key });
    const gate = await decide(ctx, 'browser_press_key', verdict, {
      action: `Press ${key}${target ? ' in the focused element' : ''}`,
      target: target ? `${target.role}${target.name ? ` "${target.name}"` : ''}` : null,
      origin: page.origin,
    });
    if (gate) return gate;
    const outcome = await act(ctx, { kind: 'key', key }, page);
    if (!outcome.ok) return failure(outcome);
    const data = isRecord(outcome.data) ? outcome.data : {};
    return ok(`Pressed ${key}${target ? ` in ${describe(target)}` : ''}.${landed(ctx, page.url, data)}`);
  },
};

const scrollTool: VerseMcpTool = {
  name: 'browser_scroll',
  scope: 'browser_act',
  description: 'Scroll the page (direction + amount in CSS px, default most of a screen), scroll inside an element (ref + direction), or bring an element into view (ref alone).',
  annotations: { title: 'Scroll', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: schema({
    ref: REF_SCHEMA,
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'number', minimum: 1, maximum: 20000, description: 'CSS px (default about 80% of the window).' },
  }),
  async handler(args, ctx) {
    const scoped = needScope(ctx, 'browser_act');
    if (scoped) return scoped;
    const direction = args['direction'];
    if (direction !== undefined && direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
      return toolError('direction must be up, down, left or right.');
    }
    const ref = refArg(args);
    if (isResult(ref)) return ref;
    if (!ref && direction === undefined) return toolError('Pass a direction, a ref, or both.');
    const amount = typeof args['amount'] === 'number' && Number.isFinite(args['amount']) ? Math.max(1, Math.min(20000, args['amount'])) : undefined;
    let page: ActionPage;
    let spec: Record<string, unknown> = { kind: 'scroll', ...(direction ? { direction } : {}), ...(amount !== undefined ? { amount } : {}) };
    if (ref) {
      const resolved = await resolveTarget(ctx, { ref }, false);
      if (isResult(resolved)) return resolved;
      page = resolved.page;
      spec = { ...spec, ref, expect: resolved.target.sig };
    } else {
      const current = await currentPage(ctx);
      if (isResult(current)) return current;
      page = current;
    }
    // Scrolling changes nothing on the page's server; it is exempt from the taint rule.
    const outcome = await act(ctx, spec, page);
    // The viewport moved: the last screenshot's pixels no longer match the page.
    ctx.deps.setShot(ctx.sessionId, null);
    if (!outcome.ok) return failure(outcome);
    const data = isRecord(outcome.data) ? outcome.data : {};
    const sy = typeof data['sy'] === 'number' ? data['sy'] : null;
    const dh = typeof data['dh'] === 'number' ? data['dh'] : null;
    return ok(`Scrolled${direction ? ` ${String(direction)}` : ` ${ref} into view`}.${sy !== null && dh !== null ? ` Now at y=${sy} of ${dh} px.` : ''}${landed(ctx, page.url, data)}`);
  },
};

const waitForTool: VerseMcpTool = {
  name: 'browser_wait_for',
  scope: 'browser_act',
  description: 'Wait until text appears on the page (text), disappears (text_gone), or a fixed time passes (time_ms). Waits at most 30 s.',
  annotations: { title: 'Wait', readOnlyHint: true, openWorldHint: false },
  inputSchema: schema({
    text: { type: 'string', minLength: 1, maxLength: 500 },
    text_gone: { type: 'string', minLength: 1, maxLength: 500 },
    time_ms: { type: 'integer', minimum: 1, maximum: 30000, description: 'Alone: how long to wait. With text / text_gone: the most to wait (default 10000).' },
  }),
  async handler(args, ctx) {
    const scoped = needScope(ctx, 'browser_act');
    if (scoped) return scoped;
    const appear = typeof args['text'] === 'string' && args['text'] ? args['text'].slice(0, 500) : null;
    const gone = typeof args['text_gone'] === 'string' && args['text_gone'] ? args['text_gone'].slice(0, 500) : null;
    const timeMs = typeof args['time_ms'] === 'number' && Number.isFinite(args['time_ms']) ? Math.max(1, Math.min(WAIT_MAX_MS, Math.floor(args['time_ms']))) : null;
    if (!appear && !gone) {
      if (timeMs === null) return toolError('Pass text, text_gone or time_ms.');
      await ctx.deps.sleep(timeMs);
      return ok(`Waited ${timeMs} ms.`);
    }
    const deadline = ctx.deps.now() + (timeMs ?? 10_000);
    for (;;) {
      const outcome = await ctx.deps.run(ctx.sessionId, 'read-text', { limit: 50_000 });
      if (!outcome.ok) return failure(outcome);
      const seen = observe(ctx, outcome.url);
      if (!seen.ok) return toolError(seen.message);
      noteRead(ctx, seen);
      const data = isRecord(outcome.data) ? outcome.data : {};
      const body = str(data['text'], 50_000);
      // Only a yes / no leaves this loop: the page text itself never reaches the model here.
      const met = (!appear || body.includes(appear)) && (!gone || !body.includes(gone));
      if (met) return ok(appear ? `"${appear}" is on the page.` : `"${gone}" is no longer on the page.`);
      if (ctx.deps.now() + WAIT_POLL_MS > deadline) {
        return toolError(`Timed out after ${Math.round((timeMs ?? 10_000) / 100) / 10} s waiting for ${appear ? `"${appear}" to appear` : `"${gone}" to disappear`}.`);
      }
      await ctx.deps.sleep(WAIT_POLL_MS);
    }
  },
};

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

const evaluateTool: VerseMcpTool = {
  name: 'browser_evaluate',
  scope: 'browser_script',
  description:
    'Evaluate JavaScript in a localhost page, with that page\'s full privileges including cookies, credentialed storage and network access. Requires the operator to enable scripts and confirm this origin. Returns at most 20000 characters; Promises are not awaited.',
  annotations: { title: 'Evaluate', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: schema({ expression: { type: 'string', minLength: 1, maxLength: 10000 } }, ['expression']),
  async handler(args, ctx) {
    const scoped = needScope(ctx, 'browser_script');
    if (scoped) return scoped;
    const expression = typeof args['expression'] === 'string' ? args['expression'] : '';
    if (!expression || expression.length > 10_000) return toolError('expression must be 1–10000 characters.');
    const page = await currentPage(ctx);
    if (isResult(page)) return page;
    if (!page.loopback) return toolError('Scripts only run on localhost pages (the operator\'s own dev servers).');
    const gate = await decide(ctx, 'browser_evaluate', classify(ctx, { kind: 'evaluate', pageUrl: page.url, loopback: true, text: expression }), {
      action: 'Run a script in the page', target: expression.slice(0, 200), origin: page.origin,
    });
    if (gate) return gate;
    const outcome = await ctx.deps.run(ctx.sessionId, 'evaluate', {
      args: { expression, approved: { tab: page.tabId, url: page.url, origin: page.origin, loadId: page.loadId } },
    }, { resultMs: 15_000 });
    if (!outcome.ok) return failure(outcome);
    const seen = observe(ctx, outcome.url ?? page.url);
    if (!seen.ok) return toolError(seen.message);
    const data = isRecord(outcome.data) ? outcome.data : {};
    const type = str(data['type'], 20) || 'unknown';
    return ok([`Result (${type}):`, untrusted(ctx, str(data['value'], 20_000))].join('\n'));
  },
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const tools: VerseMcpTool[] = [
  snapshotTool,
  networkTool,
  screenshotTool,
  tabsTool,
  historyTool('back'),
  historyTool('forward'),
  clickTool,
  typeTool,
  selectTool,
  hoverTool,
  pressKeyTool,
  scrollTool,
  waitForTool,
  evaluateTool,
];

/** The tools this chat's agents may see right now. */
export function toolsForScopes(scopes: { act: boolean; script: boolean }): VerseMcpTool[] {
  return tools.filter((t) => t.scope === 'browser' || (t.scope === 'browser_act' && scopes.act) || (t.scope === 'browser_script' && scopes.script));
}

/** Test seam. */
export const __test = { observe, classify, decide, resolveTarget, FAILURES };
