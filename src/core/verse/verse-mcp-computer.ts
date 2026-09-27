/**
 * core/verse/verse-mcp-computer.ts — the `computer` scope of Verse's MCP
 * server: desktop control for chat seats (3.15, agent-tools P4).
 *
 * `tools` is registered by verse-mcp.ts (one MCP server for every seat,
 * loaded by a literal dynamic import). Each handler turns a tool call into
 * commands on the computer relay (computer-bridge.ts), which the Verse window
 * carries to the desktop shell (desktop/src-tauri/src/computer.rs). This file
 * decides what to ask and what the agent is told; the enforcement that keeps
 * the operator safe is layered:
 *
 *   1. here — the chat must hold a grant for the app at a tier that allows
 *      the action (computer-types.ts `requiredTier`); the target is probed
 *      first so a control labelled delete / send / pay / publish / confirm /
 *      buy, or any action after the turn read untrusted content, gets the
 *      operator's confirmation card; secure text fields are refused;
 *   2. the Verse window — the access sheet, the confirmation card, the
 *      onboarding sheet; nothing reaches native without a window;
 *   3. native — denylist, tier ceiling, secure fields, System Settings'
 *      privacy panes, takeover ("Operator took over") and KILL, re-checked on
 *      every op against what is actually under the pointer / focused.
 *
 * Everything read off the screen (accessibility text, window titles, app
 * names) is secret-scrubbed and framed in a per-call random
 * `<untrusted id=…>` delimiter.
 */
import { randomBytes } from 'node:crypto';

import { scrubSecrets } from '../util/scrub.js';
import {
  allowComputerReasonForChat,
  computerAllowedForChat,
  computerFrameFor,
  computerGrantsFor,
  computerGrantedApp,
  computerTurnReadUntrusted,
  effectiveComputerTier,
  noteComputerUntrustedRead,
  runComputerCommand,
  setComputerFrame,
  type ComputerOutcome,
  type NativeOpInput,
} from './computer-bridge.js';
import {
  COMPUTER_MODIFIERS,
  clickAction,
  computerAppPolicy,
  confirmationVerdict,
  isComputerFrame,
  isUntrustedContentApp,
  requiredTier,
  tierAllows,
  wrapUntrusted,
  type ComputerAction,
  type ComputerFrame,
  type ComputerModifier,
  type ComputerMouseButton,
  type ComputerTier,
  type ConfirmDecision,
  type ConfirmReason,
  type VerseComputerAccessApp,
  type VerseComputerChatGrant,
  type VerseComputerConfirmRequest,
} from './computer-types.js';

// ---------------------------------------------------------------------------
// The registry type — structurally compatible with verse-mcp.ts `VerseMcpTool`
// (built in parallel). The host's context carries more than the chat id; the
// optional members below are used when present, and each has a fallback so
// these tools also run under a host that offers only `sessionId`.
// ---------------------------------------------------------------------------

export type VerseMcpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface VerseMcpToolResult {
  content: VerseMcpContent[];
  isError?: boolean;
}

/** verse-mcp-grants.ts `VerseMcpConfirmRequest`. */
export interface VerseMcpConfirmRequestShape {
  tool: string;
  rule: string;
  reason: string;
  command: string;
  tabId: string | null;
}

export type VerseMcpConfirmOutcomeShape = 'once' | 'chat' | 'deny' | 'timeout' | 'revoked';

type ActionOutcome = 'ok' | 'error' | 'denied' | 'pending';

export interface VerseMcpToolContext {
  /** The chat whose seat called the tool. */
  sessionId: string;
  engine?: string | null;
  /** Aborted when the turn's token is revoked (turn end, Stop, KILL). */
  signal?: AbortSignal;
  desktop?: boolean;
  /** The host's inline confirmation card ("Allow for chat" is keyed by `rule`). */
  confirm?: (req: VerseMcpConfirmRequestShape) => Promise<VerseMcpConfirmOutcomeShape>;
  record?: (action: { tool: string; summary: string; tabId: string | null; outcome: ActionOutcome }) => string;
  settle?: (actionId: string, outcome: ActionOutcome) => void;
  /** The host's per-call untrusted framing. */
  untrusted?: (label: string, body: string) => string;
  /** This turn read content that is not the operator's (shared with the terminal's exfil check). */
  markRemoteRead?: () => void;
  remoteRead?: () => boolean;
}

export interface VerseMcpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface VerseMcpTool {
  name: string;
  scope: 'computer';
  description: string;
  annotations: VerseMcpToolAnnotations;
  inputSchema: Record<string, unknown>;
  /** Answers "desktop app only" under a plain Node server (no screen, no input). */
  desktopOnly?: boolean;
  handler(args: Record<string, unknown>, ctx: VerseMcpToolContext): Promise<VerseMcpToolResult>;
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface ComputerToolDeps {
  run: typeof runComputerCommand;
  grants: typeof computerGrantsFor;
  grantedApp: typeof computerGrantedApp;
  effectiveTier: typeof effectiveComputerTier;
  frame: typeof computerFrameFor;
  setFrame: typeof setComputerFrame;
  turnReadUntrusted: typeof computerTurnReadUntrusted;
  noteUntrusted: typeof noteComputerUntrustedRead;
  allowedForChat: typeof computerAllowedForChat;
  allowForChat: typeof allowComputerReasonForChat;
  /** Per-call delimiter id. */
  nonce(): string;
  /**
   * The apps the operator listed for this chat in the Agent tools sheet
   * (verse-mcp-grants.ts `computerAppsFor`), or null when no such outer list
   * exists (the host has not landed). Bundle ids or names.
   */
  listedApps(sessionId: string): Promise<string[] | null>;
}

/**
 * verse-mcp-grants.ts (PR #565) is loaded by a LITERAL dynamic import inside
 * try, like the MCP host loads this file: the sidecar compiles with or without
 * it, and without it there is no outer list (null).
 */
async function defaultListedApps(sessionId: string): Promise<string[] | null> {
  try {
    const mod = (await import('./verse-mcp-grants.js' as string)) as { computerAppsFor?: (id: string) => unknown };
    if (typeof mod.computerAppsFor !== 'function') return null;
    const apps = mod.computerAppsFor(sessionId);
    return Array.isArray(apps) ? apps.filter((a): a is string => typeof a === 'string') : null;
  } catch {
    return null;
  }
}

export const DEFAULT_COMPUTER_TOOL_DEPS: ComputerToolDeps = {
  run: runComputerCommand,
  grants: computerGrantsFor,
  grantedApp: computerGrantedApp,
  effectiveTier: effectiveComputerTier,
  frame: computerFrameFor,
  setFrame: setComputerFrame,
  turnReadUntrusted: computerTurnReadUntrusted,
  noteUntrusted: noteComputerUntrustedRead,
  allowedForChat: computerAllowedForChat,
  allowForChat: allowComputerReasonForChat,
  nonce: () => randomBytes(9).toString('base64url'),
  listedApps: defaultListedApps,
};

/** Is this app on the operator's Agent-tools list (bundle id or name, case-insensitive)? */
export function onListedApps(listed: readonly string[], bundleId: string, name: string): boolean {
  const b = bundleId.toLowerCase();
  const n = name.toLowerCase();
  return listed.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e.length > 0 && (e === b || e === n);
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const MAX_IMAGE_BASE64 = 12 * 1024 * 1024;
const MAX_TYPE_CHARS = 2000;
const MAX_REASON_CHARS = 300;
const MAX_APPS_PER_REQUEST = 12;

function text(t: string): VerseMcpContent {
  return { type: 'text', text: t };
}

function ok(...content: VerseMcpContent[]): VerseMcpToolResult {
  return { content };
}

function fail(message: string): VerseMcpToolResult {
  return { content: [text(message)], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Strict argument checking: the schema says additionalProperties:false, so do we. */
function unknownKey(args: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) return key;
  return null;
}

function num(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function point(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, y] = value;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

const TIER_WORDS: Record<ComputerTier, string> = { read: 'read only', click: 'click only', full: 'full control' };

/** What the agent is told when native refuses or fails. */
export function computerOutcomeMessage(outcome: Extract<ComputerOutcome, { ok: false }>): string {
  switch (outcome.code) {
    case 'operator-took-over':
      // Native also pauses when the Verse window is hidden or reloads (the relay's home is gone).
      if (/hidden/i.test(outcome.message)) {
        return 'Desktop control is paused because the Verse window is hidden. Ask the operator to bring Verse back and press Resume, then take a fresh screenshot.';
      }
      return 'Operator took over: the operator is using the mouse or keyboard, so desktop control is paused. Wait for them to hand it back with Resume in Verse, then take a fresh screenshot.';
    case 'stopped':
      return `Desktop control was stopped: ${outcome.message} Ask the operator before requesting access again.`;
    case 'no-permission':
      return `${outcome.message} Verse has shown the operator how to grant it; ask them to finish (Screen Recording needs Ashlr to relaunch), then try again.`;
    default:
      return outcome.message;
  }
}

function noAccessYet(): VerseMcpToolResult {
  return fail('This chat has no desktop access yet. Call computer_request_access with the apps you need; the operator approves each one.');
}

const CONFIRM_REASON_TEXT: Record<ConfirmReason, string> = {
  'sensitive-label': 'The control is labelled with a consequential word (delete, send, pay, publish, confirm, buy, …).',
  'untrusted-content': 'This turn read content from another app or a web page, which could carry instructions aimed at the agent.',
};

/**
 * One tool call's view of the world: the relay (carrying the turn's abort
 * signal), untrusted framing, the per-turn taint, the operator's
 * confirmation — the host's inline card when it offers one, the Verse
 * window's card otherwise — and the recent-actions strip.
 */
interface Call {
  sessionId: string;
  run(body: Parameters<ComputerToolDeps['run']>[1]): Promise<ComputerOutcome>;
  untrusted(body: string, source: string): string;
  noteUntrusted(): void;
  tainted(): boolean;
  confirm(req: VerseComputerConfirmRequest): Promise<ConfirmDecision>;
  record(tool: string, summary: string): (outcome: 'ok' | 'error' | 'denied') => void;
}

function bind(deps: ComputerToolDeps, ctx: VerseMcpToolContext): Call {
  const sessionId = ctx.sessionId;
  const relayOpts = ctx.signal ? { signal: ctx.signal } : {};
  return {
    sessionId,
    run: (body) => deps.run(sessionId, body, relayOpts),
    untrusted: (body, source) => {
      const scrubbed = scrubSecrets(body);
      return typeof ctx.untrusted === 'function' ? ctx.untrusted(source, scrubbed) : wrapUntrusted(scrubbed, deps.nonce(), source);
    },
    noteUntrusted: () => {
      deps.noteUntrusted(sessionId);
      ctx.markRemoteRead?.();
    },
    tainted: () => deps.turnReadUntrusted(sessionId) || ctx.remoteRead?.() === true,
    confirm: async (req) => {
      if (typeof ctx.confirm === 'function') {
        const answer = await ctx.confirm({
          tool: `computer_${req.action.replace(/-/g, '_')}`,
          rule: `computer-${req.reason}`,
          reason: CONFIRM_REASON_TEXT[req.reason],
          command: req.summary,
          tabId: null,
        });
        return answer === 'once' || answer === 'chat' ? answer : 'deny';
      }
      const answer = await deps.run(sessionId, { kind: 'confirm', confirm: req }, relayOpts);
      if (!answer.ok) return 'deny';
      const decision = isRecord(answer.data) ? answer.data['decision'] : 'deny';
      return decision === 'once' || decision === 'chat' ? decision : 'deny';
    },
    record: (tool, summary) => {
      const id = typeof ctx.record === 'function'
        ? ctx.record({ tool, summary: scrubSecrets(summary).slice(0, 200), tabId: null, outcome: 'pending' })
        : null;
      return (outcome) => {
        if (id !== null) ctx.settle?.(id, outcome);
      };
    },
  };
}

function needFrame(deps: ComputerToolDeps, sessionId: string): ComputerFrame | VerseMcpToolResult {
  const frame = deps.frame(sessionId);
  return frame ?? fail('Take a screenshot with computer_screenshot first: coordinates are pixels in the latest screenshot.');
}

interface ProbeResult {
  bundleId: string | null;
  name: string;
  path: string | null;
  role: string;
  subrole: string;
  label: string;
  secure: boolean;
  windowTitle: string;
}

function asProbe(data: unknown): ProbeResult {
  const d = isRecord(data) ? data : {};
  const app = isRecord(d['app']) ? d['app'] : {};
  const role = str(d['role'], 80);
  const subrole = str(d['subrole'], 80);
  return {
    bundleId: typeof app['bundleId'] === 'string' ? app['bundleId'] : null,
    name: str(app['name'], 120) || 'an app',
    path: typeof app['path'] === 'string' ? app['path'] : null,
    role,
    subrole,
    label: str(d['label'], 200),
    // Belt and braces: native reports `secure`, but a secure role is secure whatever the flag says.
    secure: d['secure'] === true || role === 'AXSecureTextField' || subrole === 'AXSecureTextField',
    windowTitle: str(d['windowTitle'], 200),
  };
}

function isToolResult(value: unknown): value is VerseMcpToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

/**
 * Probe what an action would land on, check the tier, refuse secure fields,
 * and run the confirmation card when the classifier asks for one. Returns the
 * probe on go-ahead, or the tool result to return instead.
 */
async function gate(
  call: Call,
  deps: ComputerToolDeps,
  action: ComputerAction,
  probeOp: NativeOpInput,
  summary: (probe: ProbeResult) => string,
): Promise<ProbeResult | VerseMcpToolResult> {
  const sessionId = call.sessionId;
  const probed = await call.run({ kind: 'native', op: probeOp });
  if (!probed.ok) return fail(computerOutcomeMessage(probed));
  const probe = asProbe(probed.data);
  // Native answers `app: null` when nothing accessible is under the point / focused.
  if (!isRecord(probed.data) || !isRecord(probed.data['app'])) {
    return fail(action === 'type' || action === 'key'
      ? 'Nothing is focused in a granted app. Click the field first, then try again.'
      : 'Nothing accessible is at that point. Take a fresh screenshot and aim at a control of a granted app.');
  }
  const tier = deps.effectiveTier(sessionId, probe.bundleId, probe.path);
  if (tier === null) {
    const policy = computerAppPolicy(probe.bundleId, probe.path);
    if (policy.ceiling === null) return fail(`That lands on ${probe.name}, which agents may never control. ${policy.reason}`);
    return fail(`That lands on ${probe.name}, which this chat has no access to. Call computer_request_access for it first.`);
  }
  if (!tierAllows(tier, action)) {
    return fail(`${probe.name} is granted ${TIER_WORDS[tier]} for this chat; ${action} needs ${TIER_WORDS[requiredTier(action)]}. ${computerAppPolicy(probe.bundleId, probe.path).reason}`);
  }
  if ((action === 'type' || action === 'key') && probe.secure) {
    return fail('The focused field is a password (secure text) field. Agents never type into those: ask the operator to fill it in.');
  }
  const verdict = confirmationVerdict({
    action,
    label: probe.label,
    turnReadUntrusted: call.tainted(),
    allowedForChat: deps.allowedForChat(sessionId),
  });
  if (!verdict.needed || verdict.reason === null) return probe;
  const confirm: VerseComputerConfirmRequest = {
    action,
    app: probe.name,
    label: probe.label || null,
    reason: verdict.reason,
    summary: summary(probe).slice(0, 300),
  };
  const decision = await call.confirm(confirm);
  if (decision === 'deny') {
    return fail(`The operator did not allow: ${confirm.summary}. Do not retry it; ask the operator what they want instead.`);
  }
  if (decision === 'chat') deps.allowForChat(sessionId, verdict.reason);
  return probe;
}

function quoted(label: string): string {
  return label ? `"${label.slice(0, 80)}"` : 'the control';
}

/** Native reports the app acted on as `{ bundleId, name, pid }` (older shapes: a bare name). */
function actingDone(data: unknown, fallback: string): string {
  const d = isRecord(data) ? data : {};
  const app = isRecord(d['app']) ? str(d['app']['name'], 120) : str(d['app'], 120);
  return app ? `${fallback} in ${app}.` : `${fallback}.`;
}

function imageFrom(data: Record<string, unknown>): { mime: 'image/png' | 'image/jpeg'; b64: string } | null {
  const mime = data['mime'];
  const b64 = data['base64'];
  if ((mime !== 'image/png' && mime !== 'image/jpeg') || typeof b64 !== 'string' || b64.length === 0
    || b64.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  return { mime, b64 };
}

/**
 * Run an acting op after its gate, with the recent-actions strip kept honest:
 * pending while it runs, then ok / error / denied.
 */
async function act(
  call: Call,
  deps: ComputerToolDeps,
  tool: string,
  action: ComputerAction,
  probeOp: NativeOpInput,
  summary: (probe: ProbeResult) => string,
  op: NativeOpInput,
  done: (probe: ProbeResult, data: unknown) => string,
): Promise<VerseMcpToolResult> {
  const probe = await gate(call, deps, action, probeOp, summary);
  if (isToolResult(probe)) return probe;
  // The confirmation card can take minutes: re-read the grants so a Revoke or
  // KILL pressed meanwhile is honoured here, not only by native.
  const tier = deps.effectiveTier(call.sessionId, probe.bundleId, probe.path);
  if (tier === null || !tierAllows(tier, action)) return fail(`Access to ${probe.name} was revoked while waiting; nothing was done.`);
  const fresh = 'grants' in op ? ({ ...op, grants: deps.grants(call.sessionId) } as NativeOpInput) : op;
  const settle = call.record(tool, summary(probe));
  const outcome = await call.run({ kind: 'native', op: fresh });
  if (!outcome.ok) {
    settle(outcome.code === 'denied' || outcome.code === 'tier' || outcome.code === 'secure-field' || outcome.code === 'not-granted' ? 'denied' : 'error');
    return fail(computerOutcomeMessage(outcome));
  }
  settle('ok');
  return ok(text(done(probe, outcome.data)));
}

function annotations(title: string, kind: 'read' | 'act' | 'nav'): VerseMcpToolAnnotations {
  return {
    title,
    readOnlyHint: kind === 'read',
    destructiveHint: kind === 'act',
    idempotentHint: kind === 'read',
    openWorldHint: false,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

const COORD = { type: 'number', minimum: 0, description: 'Pixels in the latest screenshot.' } as const;

export function createComputerTools(deps: ComputerToolDeps = DEFAULT_COMPUTER_TOOL_DEPS): VerseMcpTool[] {
  const scope = 'computer' as const;
  const desktopOnly = true;
  return [
    {
      name: 'computer_list_apps',
      scope,
      desktopOnly,
      description: 'The apps running on the operator\'s Mac, what each could be granted (read only / click only / full control / never), and what this chat holds. Call before computer_request_access.',
      annotations: annotations('List apps', 'read'),
      inputSchema: NO_ARGS,
      handler: async (args, ctx) => {
        const extra = unknownKey(args, []);
        if (extra) return fail(`unknown argument: ${extra.slice(0, 40)}`);
        const call = bind(deps, ctx);
        const outcome = await call.run({ kind: 'native', op: { op: 'list-apps' } });
        if (!outcome.ok) return fail(computerOutcomeMessage(outcome));
        const apps = isRecord(outcome.data) && Array.isArray(outcome.data['apps']) ? outcome.data['apps'] : [];
        const lines = apps.filter(isRecord).slice(0, 80).map((app) => {
          const bundleId = str(app['bundleId'], 200);
          const policy = computerAppPolicy(bundleId || null, str(app['path'], 500) || null);
          const held = deps.effectiveTier(ctx.sessionId, bundleId);
          const can = policy.ceiling === null ? 'never available' : `up to ${TIER_WORDS[policy.ceiling]}`;
          return `- ${str(app['name'], 120)} (${bundleId || 'no bundle id'}): ${can}${held ? `; this chat holds ${TIER_WORDS[held]}` : ''}${app['active'] === true ? ' [frontmost]' : ''}`;
        });
        return ok(text([
          `${lines.length} running app${lines.length === 1 ? '' : 's'}:`,
          call.untrusted(lines.join('\n') || '(none)', 'Running apps'),
          'Browsers are read only (use the Verse Browser pane for the web); terminals and editors are click only.',
        ].join('\n')));
      },
    },

    {
      name: 'computer_request_access',
      scope,
      desktopOnly,
      description: 'Ask the operator to let this chat control specific apps (by bundle id or name). The operator approves each app in a Verse sheet. Browsers can only be granted read only, terminals and editors click only; password managers, the keychain, System Settings privacy panes and Ashlr itself never.',
      annotations: annotations('Request app access', 'nav'),
      inputSchema: {
        type: 'object',
        properties: {
          apps: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 1, maxItems: MAX_APPS_PER_REQUEST, description: 'Bundle ids (com.apple.Notes) or app names (Notes).' },
          reason: { type: 'string', maxLength: MAX_REASON_CHARS, description: 'One sentence the operator sees: what you will do in these apps.' },
        },
        required: ['apps'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const extra = unknownKey(args, ['apps', 'reason']);
        if (extra) return fail(`unknown argument: ${extra.slice(0, 40)}`);
        const wanted = Array.isArray(args['apps']) ? args['apps'].filter((a): a is string => typeof a === 'string' && a.trim().length > 0 && a.length <= 200) : [];
        if (wanted.length === 0 || wanted.length > MAX_APPS_PER_REQUEST) return fail(`apps must list 1-${MAX_APPS_PER_REQUEST} apps.`);
        if (args['reason'] !== undefined && typeof args['reason'] !== 'string') return fail('reason must be a string.');
        const reason = str(args['reason'], MAX_REASON_CHARS).trim();
        const call = bind(deps, ctx);
        const listed = await call.run({ kind: 'native', op: { op: 'list-apps' } });
        if (!listed.ok) return fail(computerOutcomeMessage(listed));
        const running = (isRecord(listed.data) && Array.isArray(listed.data['apps']) ? listed.data['apps'] : []).filter(isRecord);
        const offered: VerseComputerAccessApp[] = [];
        const unknown: string[] = [];
        for (const raw of wanted) {
          const needle = raw.trim().toLowerCase();
          const hit = running.find((a) => str(a['bundleId'], 200).toLowerCase() === needle)
            ?? running.find((a) => str(a['name'], 120).toLowerCase() === needle);
          const bundleId = hit ? str(hit['bundleId'], 200) : /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(raw.trim()) ? raw.trim() : '';
          if (!bundleId) {
            unknown.push(raw.trim().slice(0, 80));
            continue;
          }
          if (offered.some((o) => o.bundleId.toLowerCase() === bundleId.toLowerCase())) continue;
          const policy = computerAppPolicy(bundleId, hit ? str(hit['path'], 500) || null : null);
          offered.push({
            bundleId,
            name: hit ? str(hit['name'], 120) || bundleId : bundleId,
            tier: policy.ceiling,
            category: policy.category,
            reason: policy.reason,
            running: Boolean(hit),
          });
        }
        // The Agent tools sheet is the OUTER bound: an app the operator did not
        // list for this chat is not even offered (the sheet below is the
        // per-app, per-tier yes on top of it).
        const allowList = await deps.listedApps(ctx.sessionId);
        const unlisted: string[] = [];
        if (allowList !== null) {
          for (const app of [...offered]) {
            if (app.tier !== null && !onListedApps(allowList, app.bundleId, app.name)) {
              offered.splice(offered.indexOf(app), 1);
              unlisted.push(app.name);
            }
          }
        }
        const grantable = offered.filter((o) => o.tier !== null);
        const deniedLines = offered.filter((o) => o.tier === null).map((o) => `- ${o.name}: ${o.reason}`);
        if (grantable.length === 0) {
          return fail([
            'Nothing to ask for.',
            ...(deniedLines.length ? ['Never available to agents:', ...deniedLines] : []),
            ...(unknown.length ? [`Not running / unknown: ${unknown.join(', ')} (use a bundle id, or ask the operator to open the app).`] : []),
            ...(unlisted.length ? [`Not on this chat's Agent tools app list: ${unlisted.join(', ')} (ask the operator to add them in the Agent tools sheet).`] : []),
          ].join('\n'));
        }
        const answer = await call.run({ kind: 'access', apps: offered, reason: reason || 'No reason given.' });
        if (!answer.ok) return fail(answer.code === 'declined' ? `The operator declined desktop access: ${answer.message}` : computerOutcomeMessage(answer));
        const granted = (isRecord(answer.data) && Array.isArray(answer.data['granted']) ? answer.data['granted'] : []) as VerseComputerChatGrant[];
        if (granted.length === 0) return fail('The operator did not grant any of those apps. Do not ask again for the same apps in this turn.');
        const lines = [
          'The operator granted:',
          ...granted.map((g) => `- ${g.name} (${g.bundleId}): ${TIER_WORDS[g.tier]}`),
          ...grantable.filter((o) => !granted.some((g) => g.bundleId.toLowerCase() === o.bundleId.toLowerCase())).map((o) => `- ${o.name}: not granted`),
          ...(deniedLines.length ? ['Never available:', ...deniedLines] : []),
          ...(unknown.length ? [`Unknown: ${unknown.join(', ')}`] : []),
          ...(unlisted.length ? [`Not on this chat's Agent tools app list: ${unlisted.join(', ')}`] : []),
          'Next: computer_screenshot. While you act, the operator sees an "Agent controlling …" border and can take over at any moment (then your calls return "Operator took over").',
        ];
        return ok(text(lines.join('\n')));
      },
    },

    {
      name: 'computer_screenshot',
      scope,
      desktopOnly,
      description: 'A screenshot of the granted apps\' windows (other windows are left out), downscaled to about 1280×800. Returns the scale factor; every coordinate you pass to other computer_* tools is a pixel in the LATEST screenshot.',
      annotations: annotations('Screenshot', 'read'),
      inputSchema: {
        type: 'object',
        properties: {
          display: { type: 'integer', minimum: 0, maximum: 15, description: 'Display index (default: the one with the frontmost granted app).' },
          app: { type: 'string', maxLength: 200, description: 'Only this granted app\'s windows.' },
          scale: { type: 'number', minimum: 0.25, maximum: 1, description: 'Shrink further to save tokens (default 1).' },
        },
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const extra = unknownKey(args, ['display', 'app', 'scale']);
        if (extra) return fail(`unknown argument: ${extra.slice(0, 40)}`);
        const grants = deps.grants(ctx.sessionId);
        if (grants.length === 0) return noAccessYet();
        let app: string | undefined;
        if (args['app'] !== undefined) {
          const granted = typeof args['app'] === 'string' ? deps.grantedApp(ctx.sessionId, args['app']) : null;
          if (!granted) return fail('That app is not granted to this chat. Call computer_request_access for it first.');
          app = granted.bundleId;
        }
        const display = args['display'] === undefined ? null : num(args, 'display');
        const scale = args['scale'] === undefined ? null : num(args, 'scale');
        if (args['display'] !== undefined && (display === null || !Number.isInteger(display) || display < 0 || display > 15)) return fail('display must be an integer 0-15.');
        if (args['scale'] !== undefined && (scale === null || scale < 0.25 || scale > 1)) return fail('scale must be between 0.25 and 1.');
        const call = bind(deps, ctx);
        const outcome = await call.run({
          kind: 'native',
          op: { op: 'screenshot', grants, ...(app ? { app } : {}), ...(display !== null ? { display } : {}), ...(scale !== null ? { scale } : {}) },
        });
        if (!outcome.ok) return fail(computerOutcomeMessage(outcome));
        const data = isRecord(outcome.data) ? outcome.data : {};
        const image = imageFrom(data);
        if (!image || !isComputerFrame(data['frame'])) return fail('The desktop returned an unreadable screenshot.');
        const frame = data['frame'];
        deps.setFrame(ctx.sessionId, frame);
        const shown = (Array.isArray(data['apps']) ? data['apps'] : []).filter(isRecord);
        if (shown.some((a) => typeof a['bundleId'] === 'string' && isUntrustedContentApp(a['bundleId']))) call.noteUntrusted();
        const names = shown.map((a) => str(a['name'], 80)).filter(Boolean);
        return ok(
          { type: 'image', data: image.b64, mimeType: image.mime },
          text([
            `Screenshot ${frame.width}×${frame.height} of display ${frame.display}; scale factor ${frame.scale.toFixed(3)} (1 screenshot pixel = ${frame.scale.toFixed(3)} screen points). Use pixels in THIS image for every coordinate.`,
            names.length ? call.untrusted(`Windows shown: ${names.join(', ')}`, 'Screenshot app list') : 'No granted app has a window on this display.',
          ].join('\n')),
        );
      },
    },

    {
      name: 'computer_zoom',
      scope,
      desktopOnly,
      description: 'A closer, sharper look at a region of the latest screenshot (view only; keep using the full screenshot\'s coordinates for actions).',
      annotations: annotations('Zoom', 'read'),
      inputSchema: {
        type: 'object',
        properties: {
          region: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1] in pixels of the latest screenshot.' },
        },
        required: ['region'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const extra = unknownKey(args, ['region']);
        if (extra) return fail(`unknown argument: ${extra.slice(0, 40)}`);
        const grants = deps.grants(ctx.sessionId);
        if (grants.length === 0) return noAccessYet();
        const frame = needFrame(deps, ctx.sessionId);
        if (isToolResult(frame)) return frame;
        const r = args['region'];
        if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => typeof v === 'number' && Number.isFinite(v))) return fail('region must be [x0, y0, x1, y1].');
        const [x0, y0, x1, y1] = r as [number, number, number, number];
        if (x1 <= x0 || y1 <= y0 || x0 < 0 || y0 < 0 || x1 > frame.width || y1 > frame.height) return fail(`region must lie inside the ${frame.width}×${frame.height} screenshot with x1 > x0 and y1 > y0.`);
        const call = bind(deps, ctx);
        const outcome = await call.run({ kind: 'native', op: { op: 'zoom', grants, frame, region: [x0, y0, x1, y1] } });
        if (!outcome.ok) return fail(computerOutcomeMessage(outcome));
        const image = imageFrom(isRecord(outcome.data) ? outcome.data : {});
        if (!image) return fail('The desktop returned an unreadable image.');
        return ok({ type: 'image', data: image.b64, mimeType: image.mime }, text(`Zoom of [${x0}, ${y0}, ${x1}, ${y1}] (view only).`));
      },
    },

    {
      name: 'computer_ax_tree',
      scope,
      desktopOnly,
      description: 'The accessibility tree of a granted app: roles, labels and values of its controls, each with a ref for computer_ax_press and its frame in screenshot pixels. More reliable than guessing from pixels.',
      annotations: annotations('Accessibility tree', 'read'),
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', maxLength: 200, description: 'Bundle id or name of a granted app.' },
          max_depth: { type: 'integer', minimum: 1, maximum: 12, description: 'Default 8.' },
        },
        required: ['app'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const extra = unknownKey(args, ['app', 'max_depth']);
        if (extra) return fail(`unknown argument: ${extra.slice(0, 40)}`);
        const granted = typeof args['app'] === 'string' ? deps.grantedApp(ctx.sessionId, args['app']) : null;
        if (!granted) return deps.grants(ctx.sessionId).length === 0 ? noAccessYet() : fail('That app is not granted to this chat. Call computer_request_access for it first.');
        const depthRaw = num(args, 'max_depth');
        if (args['max_depth'] !== undefined && (depthRaw === null || !Number.isInteger(depthRaw) || depthRaw < 1 || depthRaw > 12)) return fail('max_depth must be an integer 1-12.');
        const maxDepth = depthRaw ?? 8;
        const frame = deps.frame(ctx.sessionId);
        const call = bind(deps, ctx);
        const outcome = await call.run({
          kind: 'native',
          op: { op: 'ax-tree', grants: deps.grants(ctx.sessionId), app: granted.bundleId, maxDepth, ...(frame ? { frame } : {}) },
        });
        if (!outcome.ok) return fail(computerOutcomeMessage(outcome));
        if (isUntrustedContentApp(granted.bundleId)) call.noteUntrusted();
        const data = isRecord(outcome.data) ? outcome.data : {};
        const nodes = (Array.isArray(data['nodes']) ? data['nodes'] : []).filter(isRecord);
        const lines = nodes.slice(0, 500).map(formatAxNode);
        return ok(text([
          `Accessibility tree of ${granted.name} (${nodes.length} node${nodes.length === 1 ? '' : 's'}${data['truncated'] === true ? ', truncated' : ''}; frames are [x, y, w, h] in screenshot pixels${frame ? '' : ' — none yet: take a screenshot first'}). Refs stay valid until the next computer_ax_tree for this app.`,
          call.untrusted(lines.join('\n') || '(no accessible elements)', `Accessibility tree of ${granted.name}`),
        ].join('\n')));
      },
    },

    {
      name: 'computer_ax_press',
      scope,
      desktopOnly,
      description: 'Press a control by its ref from computer_ax_tree (the accessibility "press" action — a button, menu item, checkbox). Needs click-only or full access.',
      annotations: annotations('Press control', 'act'),
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', maxLength: 200 },
          ref: { type: 'string', pattern: '^e[0-9]{1,5}$' },
        },
        required: ['app', 'ref'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const extra = unknownKey(args, ['app', 'ref']);
        if (extra) return fail(`unknown argument: ${extra.slice(0, 40)}`);
        const granted = typeof args['app'] === 'string' ? deps.grantedApp(ctx.sessionId, args['app']) : null;
        if (!granted) return deps.grants(ctx.sessionId).length === 0 ? noAccessYet() : fail('That app is not granted to this chat.');
        const ref = typeof args['ref'] === 'string' && /^e[0-9]{1,5}$/.test(args['ref']) ? args['ref'] : null;
        if (!ref) return fail('ref must look like e12 (from computer_ax_tree).');
        const grants = deps.grants(ctx.sessionId);
        return act(bind(deps, ctx), deps, 'computer_ax_press', 'ax-press',
          { op: 'probe', grants, target: { kind: 'ref', app: granted.bundleId, ref } },
          (p) => `press ${quoted(p.label)} in ${p.name}`,
          { op: 'ax-press', grants, app: granted.bundleId, ref },
          (p, data) => actingDone(data, `Pressed ${quoted(p.label)}`));
      },
    },

    {
      name: 'computer_click',
      scope,
      desktopOnly,
      description: 'Click at a pixel of the latest screenshot. Left single/double/triple clicks need click-only access; right/middle clicks and clicks with modifiers need full control.',
      annotations: annotations('Click', 'act'),
      inputSchema: {
        type: 'object',
        properties: {
          x: COORD,
          y: COORD,
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
          count: { type: 'integer', minimum: 1, maximum: 3, description: 'Default 1 (2 = double click).' },
          modifiers: { type: 'array', items: { type: 'string', enum: [...COMPUTER_MODIFIERS] }, maxItems: 5 },
        },
        required: ['x', 'y'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const extra = unknownKey(args, ['x', 'y', 'button', 'count', 'modifiers']);
        if (extra) return fail(`unknown argument: ${extra.slice(0, 40)}`);
        if (deps.grants(ctx.sessionId).length === 0) return noAccessYet();
        const frame = needFrame(deps, ctx.sessionId);
        if (isToolResult(frame)) return frame;
        const x = num(args, 'x');
        const y = num(args, 'y');
        if (x === null || y === null || x < 0 || y < 0 || x > frame.width || y > frame.height) return fail(`x, y must be inside the ${frame.width}×${frame.height} screenshot.`);
        const button = (args['button'] ?? 'left') as ComputerMouseButton;
        if (button !== 'left' && button !== 'right' && button !== 'middle') return fail('button must be left, right or middle.');
        const count = args['count'] === undefined ? 1 : num(args, 'count');
        if (count === null || !Number.isInteger(count) || count < 1 || count > 3) return fail('count must be 1, 2 or 3.');
        const modsRaw = args['modifiers'] ?? [];
        if (!Array.isArray(modsRaw) || !modsRaw.every((m) => (COMPUTER_MODIFIERS as readonly unknown[]).includes(m))) return fail(`modifiers must be from: ${COMPUTER_MODIFIERS.join(', ')}.`);
        const modifiers = [...new Set(modsRaw as ComputerModifier[])];
        const action = clickAction(button, modifiers);
        const grants = deps.grants(ctx.sessionId);
        const verb = count === 2 ? 'double-click' : count === 3 ? 'triple-click' : button === 'left' ? 'click' : `${button}-click`;
        return act(bind(deps, ctx), deps, 'computer_click', action,
          { op: 'probe', grants, frame, target: { kind: 'point', x, y } },
          (p) => `${modifiers.length ? `${modifiers.join('+')}+` : ''}${verb} ${quoted(p.label)} in ${p.name}`,
          { op: 'click', grants, frame, x, y, button, count, modifiers },
          (p, data) => actingDone(data, `Clicked (${Math.round(x)}, ${Math.round(y)}) on ${quoted(p.label)}`));
      },
    },

    {
      name: 'computer_type',
      scope,
      desktopOnly,
      description: 'Type text into the focused field of the frontmost app (full control only). Never types into password fields.',
      annotations: annotations('Type', 'act'),
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: MAX_TYPE_CHARS } },
        required: ['text'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const extra = unknownKey(args, ['text']);
        if (extra) return fail(`unknown argument: ${extra.slice(0, 40)}`);
        if (deps.grants(ctx.sessionId).length === 0) return noAccessYet();
        const typed = typeof args['text'] === 'string' ? args['text'] : '';
        if (typed.length === 0 || typed.length > MAX_TYPE_CHARS) return fail(`text must be 1-${MAX_TYPE_CHARS} characters.`);
        const grants = deps.grants(ctx.sessionId);
        const n = `${typed.length} character${typed.length === 1 ? '' : 's'}`;
        return act(bind(deps, ctx), deps, 'computer_type', 'type',
          { op: 'probe', grants, target: { kind: 'focus' } },
          (p) => `type ${n} into ${quoted(p.label)} in ${p.name}`,
          { op: 'type', grants, text: typed },
          (_p, data) => actingDone(data, `Typed ${n}`));
      },
    },

    {
      name: 'computer_key',
      scope,
      desktopOnly,
      description: 'Press a key or chord in the frontmost app (full control only), e.g. "Return", "Escape", "Tab", "cmd+s", "cmd+shift+t", "Down".',
      annotations: annotations('Key', 'act'),
      inputSchema: {
        type: 'object',
        properties: { keys: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['keys'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const extra = unknownKey(args, ['keys']);
        if (extra) return fail(`unknown argument: ${extra.slice(0, 40)}`);
        if (deps.grants(ctx.sessionId).length === 0) return noAccessYet();
        const keys = typeof args['keys'] === 'string' ? args['keys'].trim() : '';
        if (!keys || keys.length > 64 || !/^[A-Za-z0-9+\-_=[\];',./`\\ ]+$/.test(keys)) return fail('keys must be a key name or chord like "cmd+shift+t".');
        const grants = deps.grants(ctx.sessionId);
        return act(bind(deps, ctx), deps, 'computer_key', 'key',
          { op: 'probe', grants, target: { kind: 'focus' } },
          (p) => `press ${keys} in ${p.name}${p.label ? ` (focus: ${quoted(p.label)})` : ''}`,
          { op: 'key', grants, keys },
          (_p, data) => actingDone(data, `Pressed ${keys}`));
      },
    },

    {
      name: 'computer_scroll',
      scope,
      desktopOnly,
      description: 'Scroll at a pixel of the latest screenshot (click-only or full access).',
      annotations: annotations('Scroll', 'nav'),
      inputSchema: {
        type: 'object',
        properties: {
          x: COORD,
          y: COORD,
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'integer', minimum: 1, maximum: 50, description: 'Lines (default 3).' },
        },
        required: ['x', 'y', 'direction'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const extra = unknownKey(args, ['x', 'y', 'direction', 'amount']);
        if (extra) return fail(`unknown argument: ${extra.slice(0, 40)}`);
        if (deps.grants(ctx.sessionId).length === 0) return noAccessYet();
        const frame = needFrame(deps, ctx.sessionId);
        if (isToolResult(frame)) return frame;
        const x = num(args, 'x');
        const y = num(args, 'y');
        if (x === null || y === null || x < 0 || y < 0 || x > frame.width || y > frame.height) return fail(`x, y must be inside the ${frame.width}×${frame.height} screenshot.`);
        const direction = args['direction'];
        if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') return fail('direction must be up, down, left or right.');
        const amount = args['amount'] === undefined ? 3 : num(args, 'amount');
        if (amount === null || !Number.isInteger(amount) || amount < 1 || amount > 50) return fail('amount must be an integer 1-50.');
        const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
        const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
        const grants = deps.grants(ctx.sessionId);
        return act(bind(deps, ctx), deps, 'computer_scroll', 'scroll',
          { op: 'probe', grants, frame, target: { kind: 'point', x, y } },
          (p) => `scroll ${direction} in ${p.name}`,
          { op: 'scroll', grants, frame, x, y, dx, dy },
          (_p, data) => actingDone(data, `Scrolled ${direction} ${amount}`));
      },
    },

    {
      name: 'computer_drag',
      scope,
      desktopOnly,
      description: 'Drag with the left button from one pixel of the latest screenshot to another (full control only).',
      annotations: annotations('Drag', 'act'),
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 2, maxItems: 2 },
          to: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 2, maxItems: 2 },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const extra = unknownKey(args, ['from', 'to']);
        if (extra) return fail(`unknown argument: ${extra.slice(0, 40)}`);
        if (deps.grants(ctx.sessionId).length === 0) return noAccessYet();
        const frame = needFrame(deps, ctx.sessionId);
        if (isToolResult(frame)) return frame;
        const from = point(args['from']);
        const to = point(args['to']);
        const inside = (p: [number, number] | null): p is [number, number] => p !== null && p[0] >= 0 && p[1] >= 0 && p[0] <= frame.width && p[1] <= frame.height;
        if (!inside(from) || !inside(to)) return fail(`from and to must be [x, y] inside the ${frame.width}×${frame.height} screenshot.`);
        const grants = deps.grants(ctx.sessionId);
        return act(bind(deps, ctx), deps, 'computer_drag', 'drag',
          { op: 'probe', grants, frame, target: { kind: 'point', x: from[0], y: from[1] } },
          (p) => `drag ${quoted(p.label)} in ${p.name}`,
          { op: 'drag', grants, frame, from, to },
          (_p, data) => actingDone(data, `Dragged from (${Math.round(from[0])}, ${Math.round(from[1])}) to (${Math.round(to[0])}, ${Math.round(to[1])})`));
      },
    },
  ];
}

/** One accessibility node as the agent reads it (inside the untrusted frame). */
export function formatAxNode(node: Record<string, unknown>): string {
  const depth = typeof node['depth'] === 'number' && Number.isFinite(node['depth']) ? Math.max(0, Math.min(12, Math.floor(node['depth']))) : 0;
  const parts = [str(node['ref'], 8), str(node['role'], 60) || 'AXUnknown'];
  const subrole = str(node['subrole'], 60);
  if (subrole) parts.push(`(${subrole})`);
  const title = str(node['title'], 200);
  const description = str(node['description'], 200);
  if (title) parts.push(JSON.stringify(title));
  if (description && description !== title) parts.push(`desc=${JSON.stringify(description)}`);
  const secure = node['secure'] === true || node['role'] === 'AXSecureTextField' || node['subrole'] === 'AXSecureTextField';
  if (secure) parts.push('[secure — value hidden]');
  else {
    const value = str(node['value'], 200);
    if (value) parts.push(`value=${JSON.stringify(value)}`);
  }
  const f = node['frame'];
  if (Array.isArray(f) && f.length === 4 && f.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    parts.push(`[${f.map((v) => Math.round(v as number)).join(', ')}]`);
  }
  if (node['enabled'] === false) parts.push('(disabled)');
  if (node['focused'] === true) parts.push('(focused)');
  return `${'  '.repeat(depth)}${parts.join(' ')}`;
}

/** The `computer` scope for verse-mcp.ts. */
export const tools: VerseMcpTool[] = createComputerTools();

/** Tool names in registration order. */
export const COMPUTER_TOOL_NAMES: readonly string[] = tools.map((t) => t.name);
