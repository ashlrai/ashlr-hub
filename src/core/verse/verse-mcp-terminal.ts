/**
 * core/verse/verse-mcp-terminal.ts — the terminal tools a chat seat sees
 * (3.15 agent tools, P1; scope `terminal`). Registry entries of verse-mcp.ts.
 *
 *   terminal_list        the tabs this chat's agent may use
 *   terminal_open        open an agent-owned tab (Agent badge) in a chat folder
 *   terminal_run         type a command, wait for it (exit code, cwd, output tail)
 *   terminal_read        a block's output, or the tab's recent output
 *   terminal_send_keys   raw text / named keys (interactive programs)
 *   terminal_wait_for    wait until the output matches a pattern
 *   terminal_interrupt   Ctrl-C
 *   terminal_close       close an agent-owned tab
 *
 * VISIBLE, ALWAYS. Every command runs in a Verse terminal tab the operator can
 * watch (terminal.ts) — never a hidden process. An agent-typed command is
 * preceded by a dim "▸ <seat> typed:" line drawn in the tab's view only (it
 * never reaches the shell), so the operator can tell it from their own.
 *
 * WHOSE TABS. The agent types only into tabs it opened (agent-owned), or an
 * operator shell the operator explicitly shared with this chat — and only
 * while the chat's terminal mode is "share my shells" (verse-mcp-grants.ts).
 * Any operator keystroke in such a tab pauses the agent there until the
 * operator presses "Resume agent" (takeover); a running terminal_run returns
 * at once, saying so.
 *
 * DESTRUCTIVE COMMANDS (verse-mcp-destructive.ts) wait up to 120 s for the
 * operator's [Allow once] [Allow for chat] [Deny]; no answer is a refusal the
 * model can read. Exfil-shaped commands ask too once the turn has read
 * content from a non-loopback origin.
 *
 * OUTPUT is plain text (escape sequences out), secret-scrubbed, and framed in
 * a per-call random `<untrusted id=…>` block. With shell integration, a run is
 * the command's own block (OSC 133: exit code, cwd); without it, a run ends
 * when the output has been quiet for 1.5 s (no exit code).
 *
 * Desktop only: under Node there is no PTY, and every tool here says so.
 */
import type { TerminalManager } from './terminal.js';
import { scrubSecrets } from '../util/scrub.js';
import { terminalBytesToText } from './terminal-blocks.js';
import { classifyCommand, confirmationFor, fetchesRemote } from './verse-mcp-destructive.js';
import {
  agentTabOwner,
  agentTabsOf,
  forgetAgentTab,
  onTabTakeover,
  registerAgentTab,
  sharedTabsOf,
  tabAccess,
  tabTakenOver,
} from './verse-mcp-grants.js';
import { textContent, toolError, type VerseMcpTool, type VerseMcpToolContext, type VerseMcpToolResult } from './verse-mcp.js';
import type { VerseTerminalBlock, VerseTerminalStreamFrame, VerseTerminalTab } from './workbench-types.js';

export const TERMINAL_RUN_DEFAULT_TIMEOUT_MS = 120_000;
export const TERMINAL_RUN_MAX_TIMEOUT_MS = 600_000;
/** Without shell integration, a run is over once output has been quiet this long. */
export const TERMINAL_QUIET_MS = 1_500;
/** How many tabs one chat's agent may have open at once. */
export const MAX_AGENT_TABS_PER_CHAT = 4;
const RUN_OUTPUT_TAIL_CHARS = 8_000;
const MAX_COMMAND_CHARS = 8_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const SEND_KEYS_SETTLE_MS = 400;

export interface VerseMcpTerminalDeps {
  manager(): TerminalManager;
  /** The chat's folders (first = primary), or null for an unknown chat. */
  sessionRoots(sessionId: string): Promise<string[] | null>;
  /** Physical path of a directory (null when missing) — for root comparisons. */
  physicalPath(path: string): Promise<string | null>;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

const defaultDeps: VerseMcpTerminalDeps = {
  manager: () => { throw new Error('terminal manager not loaded'); },
  sessionRoots: async (sessionId) => {
    const [{ getVerseEngine }, { sessionRoots }] = await Promise.all([import('./verse-api.js'), import('./preview.js')]);
    const session = (await getVerseEngine()).getSession(sessionId);
    return session ? sessionRoots(session) : null;
  },
  physicalPath: async (path) => {
    const [{ physicalPathAsync }, { withFolderIo }] = await Promise.all([import('./path-guard.js'), import('./folder-io.js')]);
    return withFolderIo(() => physicalPathAsync(path));
  },
  now: () => Date.now(),
  sleep: defaultSleep,
};

let deps: VerseMcpTerminalDeps = defaultDeps;
let managerRef: TerminalManager | null = null;

async function manager(): Promise<TerminalManager> {
  if (deps !== defaultDeps) return deps.manager();
  if (!managerRef) managerRef = (await import('./terminal.js')).getTerminalManager();
  return managerRef;
}

/** Test hook (null restores the defaults). */
export function setVerseMcpTerminalDepsForTest(next: Partial<VerseMcpTerminalDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  managerRef = null;
}

const SEAT_LABELS: Record<string, string> = { claude: 'Claude', local: 'Local model', codex: 'Codex', grok: 'Grok', devin: 'Devin' };

function seatLabel(ctx: VerseMcpToolContext): string {
  return (ctx.engine && SEAT_LABELS[ctx.engine]) || 'Agent';
}

function intArg(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function strArg(args: Record<string, unknown>, key: string, max: number): string | null {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

function tail(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: `…${text.slice(text.length - max + 1)}`, truncated: true } : { text, truncated: false };
}

function header(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function withOutput(fields: Record<string, unknown>, label: string, body: string, ctx: VerseMcpToolContext, extra: string[] = []): VerseMcpToolResult {
  return { content: [textContent([header(fields), ...extra, ctx.untrusted(label, scrubSecrets(body) || '(no output)')].join('\n'))] };
}

const TAKEN_OVER = 'The operator took over this terminal (they typed in it). Stop using it: wait for them to press "Resume agent", or open your own tab with terminal_open.';

/** Forget agent tabs whose shells are gone (closed by the operator, idle-killed). */
function pruneGone(m: TerminalManager, sessionId: string): void {
  for (const tabId of agentTabsOf(sessionId)) if (!m.get(tabId)) forgetAgentTab(tabId);
}

type TabCheck = { ok: true; tab: VerseTerminalTab; access: 'agent' | 'shared' } | { ok: false; result: VerseMcpToolResult };

function usableTab(m: TerminalManager, ctx: VerseMcpToolContext, tabId: string | null, opts: { write: boolean }): TabCheck {
  if (!tabId) return { ok: false, result: toolError('tab_id is required (see terminal_list).') };
  const tab = m.get(tabId);
  const access = tab ? tabAccess(ctx.sessionId, tabId) : null;
  if (!tab || !access) {
    if (!tab && agentTabOwner(tabId)) forgetAgentTab(tabId);
    return { ok: false, result: toolError(`Tab ${tabId.slice(0, 40)} is not one this chat's agent may use. Call terminal_list, or open your own with terminal_open.`) };
  }
  if (opts.write && tabTakenOver(tabId)) return { ok: false, result: toolError(TAKEN_OVER) };
  if (opts.write && tab.exited) return { ok: false, result: toolError(`The shell in ${tabId} has exited. Open a new tab with terminal_open.`) };
  return { ok: true, tab, access };
}

function runningBlock(m: TerminalManager, tabId: string): VerseTerminalBlock | null {
  const blocks = m.blocks(tabId);
  const last = blocks[blocks.length - 1];
  return last && last.state === 'running' ? last : null;
}

/** Ask the operator when the text about to be submitted is destructive. Null = go ahead. */
async function gate(ctx: VerseMcpToolContext, tool: string, command: string, tabId: string): Promise<VerseMcpToolResult | null> {
  const confirmation = confirmationFor(classifyCommand(command, { remoteRead: ctx.remoteRead() }));
  if (!confirmation) return null;
  const shown = scrubSecrets(command);
  const actionId = ctx.record({ tool, summary: `asks to run: ${shown}`, tabId, outcome: 'pending' });
  const answer = await ctx.confirm({ tool, rule: confirmation.rule, reason: confirmation.reason, command: shown, tabId });
  if (answer === 'once' || answer === 'chat') {
    ctx.settle(actionId, 'ok');
    return null;
  }
  ctx.settle(actionId, 'denied');
  if (answer === 'deny') return toolError(`The operator denied this command (${confirmation.reason}) It was not run. Do not retry it; ask the operator how they want to proceed.`);
  if (answer === 'timeout') return toolError('The operator did not answer the confirmation within 120 seconds, so the command was not run. Ask them in the chat before trying again.');
  return toolError('This turn ended before the operator answered, so the command was not run.');
}

interface Capture {
  bytes(): Buffer;
  lastOutputAt(): number;
  newBlock(): VerseTerminalBlock | null;
  exited(): boolean;
  wait(ms: number): Promise<void>;
  stop(): void;
}

/** Watch a tab from now on: live output (not the replay), blocks that did not exist yet, the exit. */
function capture(m: TerminalManager, tabId: string, ctx: VerseMcpToolContext): Capture {
  const before = new Set(m.blocks(tabId).map((b) => b.id));
  const chunks: Buffer[] = [];
  let size = 0;
  let last = deps.now();
  let block: VerseTerminalBlock | null = null;
  let gone = false;
  let wakers: Array<() => void> = [];
  const wake = (): void => {
    const current = wakers;
    wakers = [];
    for (const w of current) w();
  };
  const listener = (frame: VerseTerminalStreamFrame): void => {
    if (frame.type === 'output') {
      const buf = Buffer.from(frame.dataBase64, 'base64');
      chunks.push(buf);
      size += buf.length;
      while (size > MAX_CAPTURE_BYTES && chunks.length > 1) size -= chunks.shift()!.length;
      last = deps.now();
    } else if (frame.type === 'block' && !before.has(frame.block.id)) {
      if (!block || block.id === frame.block.id) block = frame.block;
    } else if (frame.type === 'exit') {
      gone = true;
    }
    wake();
  };
  // after = MAX: no scrollback replay — only what happens from here on.
  const unsubscribe = m.subscribe(tabId, Number.MAX_SAFE_INTEGER, listener, () => { gone = true; wake(); });
  const offTakeover = onTabTakeover((id) => { if (id === tabId) wake(); });
  const onAbort = (): void => wake();
  ctx.signal.addEventListener('abort', onAbort);
  return {
    bytes: () => Buffer.concat(chunks, size),
    lastOutputAt: () => last,
    newBlock: () => block,
    exited: () => gone,
    wait: (ms) => new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; resolve(); } };
      wakers.push(finish);
      void deps.sleep(ms).then(finish);
    }),
    stop: () => {
      unsubscribe();
      offTakeover();
      ctx.signal.removeEventListener('abort', onAbort);
      wake();
    },
  };
}

async function openAgentTab(m: TerminalManager, ctx: VerseMcpToolContext, rootArg: string | null, title: string | null): Promise<{ tab: VerseTerminalTab } | { error: VerseMcpToolResult }> {
  pruneGone(m, ctx.sessionId);
  if (agentTabsOf(ctx.sessionId).length >= MAX_AGENT_TABS_PER_CHAT) {
    return { error: toolError(`This chat's agent already has ${MAX_AGENT_TABS_PER_CHAT} terminal tabs open. Reuse one (terminal_list) or close one with terminal_close.`) };
  }
  const roots = await deps.sessionRoots(ctx.sessionId);
  if (!roots || roots.length === 0) return { error: toolError('This chat has no folder to open a terminal in.') };
  let root = roots[0]!;
  if (rootArg) {
    const wanted = await deps.physicalPath(rootArg);
    const physicalRoots = await Promise.all(roots.map(async (r) => ({ r, p: (await deps.physicalPath(r)) ?? r })));
    const hit = physicalRoots.find(({ r, p }) => r === rootArg || (wanted !== null && p === wanted));
    if (!hit) return { error: toolError(`root must be one of this chat's folders: ${roots.join(', ')}`) };
    root = hit.r;
  }
  let tab: VerseTerminalTab;
  try {
    tab = await m.create({
      sessionId: ctx.sessionId,
      root,
      cols: 120,
      rows: 32,
      agent: true,
      title: title ? `${title}` : `Agent · ${seatLabel(ctx)}`,
    });
  } catch (err) {
    return { error: toolError(`The terminal could not be opened: ${err instanceof Error ? err.message : String(err)}`) };
  }
  registerAgentTab(tab.id, ctx.sessionId);
  // Give the shell its first prompt (and the integration its first marker),
  // so a terminal_run right after this sees blocks.
  const watch = capture(m, tab.id, ctx);
  const started = deps.now();
  try {
    while (deps.now() - started < 4_000 && !watch.exited()) {
      const current = m.get(tab.id);
      if (current?.shellIntegration === 'active') break;
      if (current?.shellIntegration === 'off' && watch.bytes().length > 0 && deps.now() - watch.lastOutputAt() > 300) break;
      await watch.wait(100);
    }
  } finally {
    watch.stop();
  }
  return { tab: m.get(tab.id) ?? tab };
}

function tabLine(m: TerminalManager, tab: VerseTerminalTab, access: 'agent' | 'shared'): string {
  const running = tab.shellIntegration === 'active' ? runningBlock(m, tab.id) : null;
  const bits = [
    `${tab.id}`,
    access === 'agent' ? 'yours' : 'shared by the operator',
    `"${tab.title}"`,
    `cwd ${tab.cwd ?? tab.root}`,
    tab.exited ? 'EXITED' : running ? `running: ${scrubSecrets(running.command).slice(0, 120)}` : 'idle',
    tab.shellIntegration === 'active' ? 'exit codes: yes' : 'exit codes: no (no shell integration)',
  ];
  if (tabTakenOver(tab.id)) bits.push('TAKEN OVER by the operator — do not type here');
  return `- ${bits.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

async function terminalList(_args: Record<string, unknown>, ctx: VerseMcpToolContext): Promise<VerseMcpToolResult> {
  const m = await manager();
  pruneGone(m, ctx.sessionId);
  const mine = agentTabsOf(ctx.sessionId).map((id) => m.get(id)).filter((t): t is VerseTerminalTab => t !== null);
  const shared = sharedTabsOf(ctx.sessionId).map((id) => m.get(id)).filter((t): t is VerseTerminalTab => t !== null);
  const hidden = m.list().filter((t) => t.sessionId === ctx.sessionId && !mine.some((x) => x.id === t.id) && !shared.some((x) => x.id === t.id)).length;
  const lines = [
    ...(mine.length + shared.length === 0 ? ['No terminal tabs yet. terminal_run opens one for you, or call terminal_open.'] : []),
    ...mine.map((t) => tabLine(m, t, 'agent')),
    ...shared.map((t) => tabLine(m, t, 'shared')),
  ];
  if (hidden > 0) lines.push(`${hidden} other terminal${hidden === 1 ? ' is' : 's are'} the operator's own and not shared with you.`);
  lines.push(`You may open up to ${MAX_AGENT_TABS_PER_CHAT} tabs of your own.`);
  return { content: [textContent(lines.join('\n'))] };
}

async function terminalOpen(args: Record<string, unknown>, ctx: VerseMcpToolContext): Promise<VerseMcpToolResult> {
  const m = await manager();
  const opened = await openAgentTab(m, ctx, strArg(args, 'root', 4096), strArg(args, 'title', 60));
  if ('error' in opened) return opened.error;
  ctx.record({ tool: 'terminal_open', summary: `opened a terminal in ${opened.tab.root}`, tabId: opened.tab.id, outcome: 'ok' });
  return {
    content: [textContent(header({
      tab_id: opened.tab.id,
      root: opened.tab.root,
      shell_integration: opened.tab.shellIntegration === 'active',
    }))],
  };
}

/** The tab a run without tab_id uses: an idle agent tab of this chat, else a new one. */
async function defaultRunTab(m: TerminalManager, ctx: VerseMcpToolContext): Promise<{ tab: VerseTerminalTab } | { error: VerseMcpToolResult }> {
  pruneGone(m, ctx.sessionId);
  const candidates = agentTabsOf(ctx.sessionId)
    .map((id) => m.get(id))
    .filter((t): t is VerseTerminalTab => t !== null && !t.exited && !tabTakenOver(t.id) && runningBlock(m, t.id) === null)
    .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  if (candidates[0]) return { tab: candidates[0] };
  return openAgentTab(m, ctx, null, null);
}

async function terminalRun(args: Record<string, unknown>, ctx: VerseMcpToolContext): Promise<VerseMcpToolResult> {
  const m = await manager();
  const command = typeof args['command'] === 'string' ? args['command'].trim() : '';
  if (!command) return toolError('command is required.');
  if (command.length > MAX_COMMAND_CHARS) return toolError(`command is limited to ${MAX_COMMAND_CHARS} characters; write a script file and run that instead.`);
  if (/[\r\n]/.test(command)) return toolError('command must be one line. Join steps with && or ;, or write a script file.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(command)) return toolError('command contains control characters. Use terminal_send_keys for keys like Ctrl-C or arrows.');
  const timeoutMs = intArg(args, 'timeout_ms', 1_000, TERMINAL_RUN_MAX_TIMEOUT_MS, TERMINAL_RUN_DEFAULT_TIMEOUT_MS);
  const wait = args['wait'] === 'none' ? 'none' : 'exit';

  let tab: VerseTerminalTab;
  const requested = strArg(args, 'tab_id', 40);
  if (requested) {
    const check = usableTab(m, ctx, requested, { write: true });
    if (!check.ok) return check.result;
    tab = check.tab;
  } else {
    const chosen = await defaultRunTab(m, ctx);
    if ('error' in chosen) return chosen.error;
    tab = chosen.tab;
  }
  const busy = tab.shellIntegration === 'active' ? runningBlock(m, tab.id) : null;
  if (busy) {
    return toolError(`A command is still running in ${tab.id} (${busy.id}: ${scrubSecrets(busy.command).slice(0, 120)}). Wait for it (terminal_wait_for / terminal_read), stop it (terminal_interrupt), or run in another tab.`);
  }

  const refused = await gate(ctx, 'terminal_run', command, tab.id);
  if (refused) return refused;
  if (tabTakenOver(tab.id)) return toolError(TAKEN_OVER);
  if (ctx.signal.aborted) return toolError('This turn\'s access to Verse tools has ended.');

  const actionId = ctx.record({ tool: 'terminal_run', summary: scrubSecrets(command), tabId: tab.id, outcome: 'pending' });
  const watch = capture(m, tab.id, ctx);
  const started = deps.now();
  try {
    m.annotate(tab.id, `\r\n\x1b[2;3m▸ ${seatLabel(ctx)} typed:\x1b[0m\r\n`);
    m.write(tab.id, new TextEncoder().encode(`${command}\r`));
  } catch (err) {
    watch.stop();
    ctx.settle(actionId, 'error');
    return toolError(`The command could not be typed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (fetchesRemote(command)) ctx.markRemoteRead();

  const integrated = m.get(tab.id)?.shellIntegration === 'active';
  let stillRunning = true;
  let note: string | null = null;
  try {
    for (;;) {
      const elapsed = deps.now() - started;
      const block = watch.newBlock();
      if (block?.state === 'done') { stillRunning = false; break; }
      if (watch.exited()) { stillRunning = false; note = 'The shell exited.'; break; }
      if (tabTakenOver(tab.id)) { note = TAKEN_OVER; break; }
      if (ctx.signal.aborted) { note = 'This turn ended while the command was running; it keeps running in the tab.'; break; }
      if (wait === 'none' && (block || elapsed >= 1_000)) break;
      if (!integrated && watch.bytes().length > 0 && deps.now() - watch.lastOutputAt() >= TERMINAL_QUIET_MS && elapsed >= 500) {
        stillRunning = false;
        note = 'This shell has no integration, so there is no exit code: the run ended when the output went quiet for 1.5 s. It may still be running — check with terminal_read.';
        break;
      }
      if (elapsed >= timeoutMs) { note = `Still running after ${Math.round(timeoutMs / 1000)} s. Check on it with terminal_read or terminal_wait_for, or stop it with terminal_interrupt.`; break; }
      await watch.wait(Math.min(250, Math.max(10, timeoutMs - elapsed)));
    }
  } finally {
    watch.stop();
  }

  const block = watch.newBlock();
  let output: string;
  let truncated = false;
  if (block) {
    const found = m.blockOutput(tab.id, block.id);
    output = found ? terminalBytesToText(found.bytes) : terminalBytesToText(watch.bytes());
    truncated = found?.truncated ?? false;
  } else {
    output = terminalBytesToText(watch.bytes());
  }
  const cut = tail(output, RUN_OUTPUT_TAIL_CHARS);
  const finalBlock = block ? (m.blocks(tab.id).find((b) => b.id === block.id) ?? block) : null;
  const exitCode = finalBlock?.exitCode ?? null;
  ctx.settle(actionId, stillRunning ? 'pending' : exitCode === null || exitCode === 0 ? 'ok' : 'error');
  return withOutput({
    tab_id: tab.id,
    block_id: finalBlock?.id ?? null,
    exit_code: exitCode,
    cwd: finalBlock?.cwd ?? m.get(tab.id)?.cwd ?? null,
    still_running: stillRunning,
    truncated: truncated || cut.truncated,
  }, 'The command output', cut.text, ctx, note ? [note] : []);
}

async function terminalRead(args: Record<string, unknown>, ctx: VerseMcpToolContext): Promise<VerseMcpToolResult> {
  const m = await manager();
  const check = usableTab(m, ctx, strArg(args, 'tab_id', 40), { write: false });
  if (!check.ok) return check.result;
  const maxChars = intArg(args, 'max_chars', 200, 100_000, 20_000);
  const blockId = strArg(args, 'block_id', 20);
  if (blockId) {
    const found = m.blockOutput(check.tab.id, blockId);
    if (!found) return toolError(`No block ${blockId} in ${check.tab.id}.`);
    const cut = tail(terminalBytesToText(found.bytes), maxChars);
    return withOutput({
      tab_id: check.tab.id,
      block_id: found.block.id,
      command: scrubSecrets(found.block.command),
      state: found.block.state,
      exit_code: found.block.exitCode,
      cwd: found.block.cwd,
      truncated: found.truncated || cut.truncated,
    }, 'The block output', cut.text, ctx);
  }
  const after = intArg(args, 'after_seq', 0, Number.MAX_SAFE_INTEGER, 0);
  const chunks: Buffer[] = [];
  let lastSeq = after;
  // subscribe replays the scrollback synchronously; take it and leave.
  const unsubscribe = m.subscribe(check.tab.id, after, (frame) => {
    if (frame.type === 'output') {
      chunks.push(Buffer.from(frame.dataBase64, 'base64'));
      lastSeq = Math.max(lastSeq, frame.seq);
    }
  });
  unsubscribe();
  const cut = tail(terminalBytesToText(Buffer.concat(chunks)), maxChars);
  const running = check.tab.shellIntegration === 'active' ? runningBlock(m, check.tab.id) : null;
  return withOutput({
    tab_id: check.tab.id,
    next_seq: lastSeq,
    running_block_id: running?.id ?? null,
    exited: check.tab.exited !== null,
    truncated: cut.truncated,
  }, 'The terminal output', cut.text, ctx);
}

const NAMED_KEYS: Record<string, string> = {
  enter: '\r', return: '\r', tab: '\t', escape: '\x1b', esc: '\x1b', backspace: '\x7f', delete: '\x1b[3~', space: ' ',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
};

/** A named key (`enter`, `up`, `ctrl-c`, …) → its bytes, or null. */
export function keyBytes(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (NAMED_KEYS[key] !== undefined) return NAMED_KEYS[key]!;
  const ctrl = /^(?:ctrl|control|c)[-+]([a-z])$/.exec(key);
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96);
  return null;
}

async function terminalSendKeys(args: Record<string, unknown>, ctx: VerseMcpToolContext): Promise<VerseMcpToolResult> {
  const m = await manager();
  const check = usableTab(m, ctx, strArg(args, 'tab_id', 40), { write: true });
  if (!check.ok) return check.result;
  const text = typeof args['text'] === 'string' ? args['text'] : '';
  if (text.length > 4_000) return toolError('text is limited to 4000 characters.');
  const keys = Array.isArray(args['keys']) ? args['keys'] : [];
  if (keys.length > 50) return toolError('keys is limited to 50 entries.');
  let sequence = '';
  for (const k of keys) {
    const bytes = typeof k === 'string' ? keyBytes(k) : null;
    if (bytes === null) return toolError(`Unknown key: ${String(k).slice(0, 30)}. Use names like enter, tab, escape, up, down, left, right, backspace, ctrl-c, ctrl-d.`);
    sequence += bytes;
  }
  if (!text && !sequence) return toolError('Give text, keys, or both.');
  // Text that is submitted (a newline in it, or an Enter key) is a command line: classify it.
  const submitted = /[\r\n]/.test(text) || sequence.includes('\r');
  if (submitted) {
    const line = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length > 0).join('; ');
    if (line) {
      const refused = await gate(ctx, 'terminal_send_keys', line, check.tab.id);
      if (refused) return refused;
      if (fetchesRemote(line)) ctx.markRemoteRead();
    }
  }
  const watch = capture(m, check.tab.id, ctx);
  try {
    m.write(check.tab.id, new TextEncoder().encode(text.replace(/\r?\n/g, '\r') + sequence));
    ctx.record({ tool: 'terminal_send_keys', summary: `typed ${scrubSecrets(text).slice(0, 80)}${keys.length ? ` + ${keys.join(' ')}` : ''}`, tabId: check.tab.id, outcome: 'ok' });
    await watch.wait(SEND_KEYS_SETTLE_MS);
  } catch (err) {
    return toolError(`The keys could not be sent: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    watch.stop();
  }
  const cut = tail(terminalBytesToText(watch.bytes()), 4_000);
  return withOutput({ tab_id: check.tab.id, sent: true }, 'The terminal output since the keys were sent', cut.text, ctx);
}

function compilePattern(raw: string): RegExp {
  try {
    return new RegExp(raw, 'm');
  } catch {
    return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm');
  }
}

function matchLine(text: string, pattern: RegExp): string | null {
  for (const line of text.split('\n')) {
    const bounded = line.length > 2_000 ? line.slice(0, 2_000) : line;
    if (pattern.test(bounded)) return bounded;
  }
  return null;
}

async function terminalWaitFor(args: Record<string, unknown>, ctx: VerseMcpToolContext): Promise<VerseMcpToolResult> {
  const m = await manager();
  const check = usableTab(m, ctx, strArg(args, 'tab_id', 40), { write: false });
  if (!check.ok) return check.result;
  const raw = strArg(args, 'pattern', 300);
  if (!raw) return toolError('pattern is required (a regular expression, or plain text).');
  const pattern = compilePattern(raw);
  const timeoutMs = intArg(args, 'timeout_ms', 100, TERMINAL_RUN_MAX_TIMEOUT_MS, 30_000);
  const afterArg = args['after_seq'];
  // Recent output first: a server that printed "ready" just before this call still counts.
  const chunks: Buffer[] = [];
  const after = typeof afterArg === 'number' && Number.isFinite(afterArg) ? Math.max(0, Math.floor(afterArg)) : 0;
  const unsubscribe = m.subscribe(check.tab.id, after, (frame) => {
    if (frame.type === 'output') chunks.push(Buffer.from(frame.dataBase64, 'base64'));
  });
  unsubscribe();
  const recentText = terminalBytesToText(Buffer.concat(chunks));
  const recent = typeof afterArg === 'number' ? recentText : recentText.slice(-8_000);
  const already = matchLine(scrubSecrets(recent), pattern);
  if (already !== null) return withOutput({ tab_id: check.tab.id, matched: true }, 'The matching line', already, ctx);

  const watch = capture(m, check.tab.id, ctx);
  const started = deps.now();
  try {
    for (;;) {
      const text = scrubSecrets(terminalBytesToText(watch.bytes()));
      const hit = matchLine(text, pattern);
      if (hit !== null) return withOutput({ tab_id: check.tab.id, matched: true }, 'The matching line', hit, ctx);
      if (watch.exited()) return withOutput({ tab_id: check.tab.id, matched: false, exited: true }, 'The output while waiting', tail(text, 4_000).text, ctx);
      if (ctx.signal.aborted) return toolError('This turn\'s access to Verse tools has ended.');
      const elapsed = deps.now() - started;
      if (elapsed >= timeoutMs) {
        return withOutput({ tab_id: check.tab.id, matched: false, timed_out: true }, 'The output while waiting', tail(text, 4_000).text, ctx,
          [`No line matched /${raw}/ within ${Math.round(timeoutMs / 1000)} s.`]);
      }
      await watch.wait(Math.min(250, timeoutMs - elapsed));
    }
  } finally {
    watch.stop();
  }
}

async function terminalInterrupt(args: Record<string, unknown>, ctx: VerseMcpToolContext): Promise<VerseMcpToolResult> {
  const m = await manager();
  const check = usableTab(m, ctx, strArg(args, 'tab_id', 40), { write: true });
  if (!check.ok) return check.result;
  m.write(check.tab.id, new Uint8Array([3]));
  ctx.record({ tool: 'terminal_interrupt', summary: 'pressed Ctrl-C', tabId: check.tab.id, outcome: 'ok' });
  return { content: [textContent(`Sent Ctrl-C to ${check.tab.id}.`)] };
}

async function terminalClose(args: Record<string, unknown>, ctx: VerseMcpToolContext): Promise<VerseMcpToolResult> {
  const m = await manager();
  const check = usableTab(m, ctx, strArg(args, 'tab_id', 40), { write: false });
  if (!check.ok) return check.result;
  if (check.access !== 'agent') return toolError('That is the operator\'s own shell, shared with you: you cannot close it.');
  try {
    m.kill(check.tab.id);
  } finally {
    forgetAgentTab(check.tab.id);
  }
  ctx.record({ tool: 'terminal_close', summary: `closed ${check.tab.title}`, tabId: check.tab.id, outcome: 'ok' });
  return { content: [textContent(`Closed ${check.tab.id}.`)] };
}

const TAB_ID = { type: 'string', description: 'A tab id from terminal_list / terminal_open (t-…).' };

const ann = (title: string, flags: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean; openWorld?: boolean }): VerseMcpTool['annotations'] => ({
  title,
  readOnlyHint: flags.readOnly ?? false,
  destructiveHint: flags.destructive ?? false,
  idempotentHint: flags.idempotent ?? false,
  openWorldHint: flags.openWorld ?? false,
});

export const tools: VerseMcpTool[] = [
  {
    name: 'terminal_list',
    scope: 'terminal',
    desktopOnly: true,
    description: 'The Verse terminal tabs you may use on this chat: your own tabs and any shell the operator shared with you — with each tab\'s directory, whether a command is running, and whether the operator has taken it over.',
    annotations: ann('List terminals', { readOnly: true, idempotent: true }),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: terminalList,
  },
  {
    name: 'terminal_open',
    scope: 'terminal',
    desktopOnly: true,
    description: 'Open a new terminal tab of your own (the operator sees it with an "Agent" badge) in one of this chat\'s folders. terminal_run opens one automatically when you have none.',
    annotations: ann('Open a terminal', {}),
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'One of this chat\'s folders (default: its primary folder).' },
        title: { type: 'string', maxLength: 60, description: 'Tab title, e.g. "dev server".' },
      },
      additionalProperties: false,
    },
    handler: terminalOpen,
  },
  {
    name: 'terminal_run',
    scope: 'terminal',
    desktopOnly: true,
    description: 'Type a one-line shell command into a terminal tab and wait for it to finish. Returns the exit code, the directory it ran in and the end of its output. Without tab_id it uses (or opens) a tab of your own. For a long-running process (a dev server, a watcher) pass wait:"none" and follow it with terminal_wait_for / terminal_read. Destructive commands wait for the operator to allow them.',
    annotations: ann('Run a command', { destructive: true, openWorld: true }),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'One line, as you would type it at the prompt.' },
        tab_id: TAB_ID,
        timeout_ms: { type: 'integer', minimum: 1000, maximum: TERMINAL_RUN_MAX_TIMEOUT_MS, description: `How long to wait for it to finish (default ${TERMINAL_RUN_DEFAULT_TIMEOUT_MS}). It keeps running after that.` },
        wait: { type: 'string', enum: ['exit', 'none'], description: '"exit" (default) waits for the command to finish; "none" returns once it started.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    handler: terminalRun,
  },
  {
    name: 'terminal_read',
    scope: 'terminal',
    desktopOnly: true,
    description: 'Read output from a terminal tab: one command block (block_id, from terminal_run), or the tab\'s recent output (optionally only after next_seq from a previous read).',
    annotations: ann('Read terminal output', { readOnly: true, idempotent: true }),
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        block_id: { type: 'string', description: 'b-… from terminal_run.' },
        after_seq: { type: 'integer', minimum: 0, description: 'Only output after this sequence number (next_seq of an earlier read).' },
        max_chars: { type: 'integer', minimum: 200, maximum: 100000, description: 'Default 20000 (the end of the output is kept).' },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
    handler: terminalRead,
  },
  {
    name: 'terminal_send_keys',
    scope: 'terminal',
    desktopOnly: true,
    description: 'Type raw text and/or named keys into a terminal tab — for interactive programs (answering a prompt, a REPL, a TUI). Keys: enter, tab, escape, backspace, delete, up, down, left, right, home, end, pageup, pagedown, space, ctrl-<letter>. Returns the output that followed.',
    annotations: ann('Send keys', { destructive: true, openWorld: true }),
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        text: { type: 'string', maxLength: 4000, description: 'Typed as-is (a newline is Enter).' },
        keys: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Named keys, sent after the text.' },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
    handler: terminalSendKeys,
  },
  {
    name: 'terminal_wait_for',
    scope: 'terminal',
    desktopOnly: true,
    description: 'Wait until a line of a tab\'s output matches a pattern (a regular expression, or plain text) — e.g. a dev server\'s "ready" line. Recent output counts, so a line printed just before the call matches.',
    annotations: ann('Wait for output', { readOnly: true }),
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: TAB_ID,
        pattern: { type: 'string', maxLength: 300 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: TERMINAL_RUN_MAX_TIMEOUT_MS, description: 'Default 30000.' },
        after_seq: { type: 'integer', minimum: 0, description: 'Only consider output after this sequence number.' },
      },
      required: ['tab_id', 'pattern'],
      additionalProperties: false,
    },
    handler: terminalWaitFor,
  },
  {
    name: 'terminal_interrupt',
    scope: 'terminal',
    desktopOnly: true,
    description: 'Press Ctrl-C in a terminal tab (stop the running command).',
    annotations: ann('Interrupt', {}),
    inputSchema: { type: 'object', properties: { tab_id: TAB_ID }, required: ['tab_id'], additionalProperties: false },
    handler: terminalInterrupt,
  },
  {
    name: 'terminal_close',
    scope: 'terminal',
    desktopOnly: true,
    description: 'Close one of your own terminal tabs (stops whatever runs in it). You cannot close a shell the operator shared with you.',
    annotations: ann('Close a terminal', { destructive: true, idempotent: true }),
    inputSchema: { type: 'object', properties: { tab_id: TAB_ID }, required: ['tab_id'], additionalProperties: false },
    handler: terminalClose,
  },
];
