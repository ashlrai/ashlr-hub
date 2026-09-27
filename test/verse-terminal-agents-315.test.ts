/**
 * 3.15 — the terminal for many agents (pure + fake-PTY half):
 *
 *   - terminal-assist.ts: the fix-chip prompt (scrubbed, tail-cut) and the
 *     parser (≤ 3, one line, nothing destructive, fails closed);
 *   - terminal-agent-hooks.ts: which apps report a status, the per-launch hook
 *     files (private dir, token only in the script, Claude `--settings` /
 *     Codex `-c notify`), the hook body reader and the screen heuristic;
 *   - terminal.ts: an agent tab's status from hooks (token-checked) and from
 *     its output (running → quiet → idle, a question → needs you, Enter →
 *     running), the Needs-you item and the notifier's events, the agent
 *     exiting, long commands announced — and hooks removed with the tab;
 *   - terminal-blocks.ts: loopback URLs a command prints;
 *   - terminal-launch.ts: launch.json validation.
 *
 * The real server + a real hook script calling back over loopback is in
 * verse-terminal-agents-routes-315.test.ts (real-io lane).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildFixPrompt, parseFixSuggestions, suggestFixCommands, tailBytes } from '../src/core/verse/terminal-assist.js';
import {
  agentHookScript,
  agentKindForApp,
  claudeHookSettings,
  installAgentHooks,
  needsYouLine,
  readHookBody,
  removeAgentHooks,
  shellJoinArgs,
} from '../src/core/verse/terminal-agent-hooks.js';
import { needsYouItems, resetTerminalActivityForTest, terminalActivitySnapshot } from '../src/core/verse/terminal-activity.js';
import { createBlockTracker, findLocalUrls } from '../src/core/verse/terminal-blocks.js';
import { parseLaunchFile } from '../src/core/verse/terminal-launch.js';
import { createTerminalManager, type PtyExit, type PtyHandle, type PtySpawnOptions } from '../src/core/verse/terminal.js';
import { isNeedsYouItem, type VerseTerminalBlock, type VerseTerminalStreamFrame } from '../src/core/verse/workbench-types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const osc = (payload: string) => `\x1b]${payload}\x07`;
const NONCE = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const PROMPT = `\r\x1b[0m\x1b[27m\x1b[24m\x1b[J${osc('133;A')}USER% ${osc('133;B')}\x1b[K\x1b[?2004h`;

// ---------------------------------------------------------------------------
// terminal-assist
// ---------------------------------------------------------------------------

describe('terminal-assist — fix chips from the local model', () => {
  it('sends only the scrubbed tail of the output, with the command and exit code', () => {
    const output = `${'noise line\n'.repeat(2_000)}Error: key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 rejected\n`;
    const { system, user } = buildFixPrompt({ command: 'npm test', output, exitCode: 1, cwd: '~/proj' });
    expect(system).toMatch(/JSON only/);
    expect(user).toContain('Command: npm test');
    expect(user).toContain('Exit code: 1');
    expect(user).not.toContain('sk-ant-api03');
    expect(user).toContain('[REDACTED]');
    expect(Buffer.byteLength(user)).toBeLessThan(4 * 1024 + 200);
    expect(tailBytes('short')).toBe('short');
    // Never splits a multi-byte character.
    expect(tailBytes('é'.repeat(3_000), 101)).not.toContain('�');
  });

  it('keeps at most three one-line, distinct, non-destructive suggestions and fails closed', () => {
    const raw = JSON.stringify({
      suggestions: [
        { command: 'npm install', why: 'The module is missing.' },
        { command: 'npm install', why: 'dup' },
        { command: 'sudo npm install -g x', why: 'no' },
        { command: 'rm -rf node_modules', why: 'no' },
        { command: 'git reset --hard', why: 'no' },
        { command: 'line one\nline two', why: 'multi-line becomes one line' },
        { command: 'npm test', why: 'the failing command itself' },
        { command: 'npm ci', why: 'Clean install.' },
        { command: 'npx tsc', why: 'Fourth good one' },
      ],
    });
    const out = parseFixSuggestions(raw, 'npm test');
    expect(out.map((s) => s.command)).toEqual(['npm install', 'line one line two', 'npm ci']);
    expect(parseFixSuggestions('not json')).toEqual([]);
    expect(parseFixSuggestions('Sure! ```json\n{"suggestions":[{"command":"ls","why":"x"}]}\n```').map((s) => s.command)).toEqual(['ls']);
    expect(parseFixSuggestions('{"suggestions":"nope"}')).toEqual([]);
    expect(parseFixSuggestions(JSON.stringify({ suggestions: [{ command: 'x'.repeat(400) }] }))).toEqual([]);
  });

  it('suggestFixCommands runs the injected completion once', async () => {
    const calls: string[] = [];
    const out = await suggestFixCommands({ command: 'pnpm dev', output: 'command not found: pnpm', exitCode: 127, cwd: null }, async (_s, u) => {
      calls.push(u);
      return '{"suggestions":[{"command":"npm i -g pnpm","why":"pnpm is not installed."}]}';
    });
    expect(calls).toHaveLength(1);
    expect(out).toEqual([{ command: 'npm i -g pnpm', why: 'pnpm is not installed.' }]);
  });
});

// ---------------------------------------------------------------------------
// terminal-agent-hooks
// ---------------------------------------------------------------------------

describe('terminal-agent-hooks — per-launch hooks, never a global config', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-agent-hooks-')); fs.chmodSync(dir, 0o700); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('knows which apps report a status', () => {
    expect(agentKindForApp('claude-code')).toBe('claude-code');
    expect(agentKindForApp('codex')).toBe('codex');
    expect(agentKindForApp('devin')).toBe('devin');
    expect(agentKindForApp('grok')).toBe('grok');
    expect(agentKindForApp('aider')).toBeNull();
    expect(agentKindForApp(null)).toBeNull();
  });

  it('Claude Code: a private dir, the token only in the script, and --settings with our four hooks', async () => {
    const token = 'f'.repeat(48);
    const install = await installAgentHooks({ kind: 'claude-code', tabId: 't-abc', token, baseUrl: 'http://127.0.0.1:4321', root: dir });
    expect(install).not.toBeNull();
    expect(install!.dir).toBe(path.join(dir, 't-abc'));
    expect(fs.statSync(install!.dir).mode & 0o777).toBe(0o700);
    const settingsPath = install!.args[1]!;
    expect(install!.args).toEqual(['--settings', settingsPath]);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'PostToolUse', 'Stop', 'UserPromptSubmit']);
    expect(settings.hooks['Stop']![0]!.hooks[0]!.command).toMatch(/hook\.sh' idle$/);
    expect(fs.readFileSync(settingsPath, 'utf8')).not.toContain(token);
    const script = fs.readFileSync(path.join(install!.dir, 'hook.sh'), 'utf8');
    expect(script).toContain(token);
    expect(script).toContain('http://127.0.0.1:4321/api/verse/terminal/t-abc/agent-state?state=');
    expect(fs.statSync(path.join(install!.dir, 'hook.sh')).mode & 0o077).toBe(0);
    await removeAgentHooks(install!.dir);
    expect(fs.existsSync(install!.dir)).toBe(false);
  });

  it('Codex: -c notify for this one process; Devin and Grok get no hooks; a remote base URL is refused', async () => {
    const codex = await installAgentHooks({ kind: 'codex', tabId: 't-cdx', token: 'a'.repeat(48), baseUrl: 'http://127.0.0.1:1', root: dir });
    expect(codex!.args[0]).toBe('-c');
    expect(JSON.parse(codex!.args[1]!.slice('notify='.length))).toEqual(['/bin/sh', path.join(dir, 't-cdx', 'hook.sh'), 'idle']);
    expect(shellJoinArgs(codex!.args)).toMatch(/^-c 'notify=\["\/bin\/sh",/);
    expect(await installAgentHooks({ kind: 'devin', tabId: 't-d', token: 'a'.repeat(48), baseUrl: 'http://127.0.0.1:1', root: dir })).toBeNull();
    expect(await installAgentHooks({ kind: 'grok', tabId: 't-g', token: 'a'.repeat(48), baseUrl: 'http://127.0.0.1:1', root: dir })).toBeNull();
    await expect(installAgentHooks({ kind: 'codex', tabId: 't-x', token: 'a', baseUrl: 'http://evil.example:1', root: dir })).rejects.toThrow();
  });

  it('refuses a hooks root another user (or anyone) could read', async () => {
    fs.chmodSync(dir, 0o755);
    await expect(installAgentHooks({ kind: 'claude-code', tabId: 't-abc', token: 'f'.repeat(48), baseUrl: 'http://127.0.0.1:1', root: dir })).rejects.toThrow(/readable by others/);
  });

  it('the script never blocks the agent: exits 0, prints nothing, knows only three states', () => {
    const script = agentHookScript('http://127.0.0.1:1/api/verse/terminal/t-a/agent-state', 'tok');
    expect(script).toMatch(/case "\$state" in running\|idle\|needs-you\)/);
    expect(script.trim().endsWith('exit 0')).toBe(true);
    expect(script).toContain('-m 3');
    expect(claudeHookSettings('/x/hook.sh')).toMatchObject({ hooks: { Notification: [{ hooks: [{ timeout: 5 }] }] } });
  });

  it('reads a Notification body: a question is needs-you with its message, "waiting for your input" is idle', () => {
    expect(readHookBody({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }, 'needs-you'))
      .toEqual({ state: 'needs-you', message: 'Claude needs your permission to use Bash' });
    expect(readHookBody({ message: 'Claude is waiting for your input' }, 'needs-you')).toEqual({ state: 'idle', message: null });
    expect(readHookBody({ notification_type: 'idle_prompt', message: 'x' }, 'needs-you')).toEqual({ state: 'idle', message: null });
    expect(readHookBody({ 'last-assistant-message': 'secret-ish' }, 'idle')).toEqual({ state: 'idle', message: null });
    expect(readHookBody('garbage', 'running')).toEqual({ state: 'running', message: null });
    expect(readHookBody({ message: `a\x1b[31m-b‮${'x'.repeat(400)}` }, 'needs-you').message!.length).toBe(200);
  });

  it('reads a question off the screen', () => {
    expect(needsYouLine('Working…\nApply this patch? (y/n)')).toBe('Apply this patch? (y/n)');
    expect(needsYouLine('Do you want to run `npm install`?\n> ')).toBe('Do you want to run `npm install`?');
    expect(needsYouLine('Allow command `rm build/`?')).toBe('Allow command `rm build/`?');
    expect(needsYouLine('compiling…\ndone in 2.1s')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// terminal.ts — agent tabs
// ---------------------------------------------------------------------------

interface FakePty extends PtyHandle {
  opts: PtySpawnOptions;
  written: string[];
  closed: boolean;
  emit(text: string): void;
  exit(result: PtyExit): void;
}

function fakeSpawner() {
  const spawned: FakePty[] = [];
  let pid = 9000;
  const spawn = (opts: PtySpawnOptions): FakePty => {
    let resolveExit!: (value: PtyExit) => void;
    const exited = new Promise<PtyExit>((r) => { resolveExit = r; });
    const pty: FakePty = {
      pid: pid++,
      opts,
      written: [],
      closed: false,
      write(data) { pty.written.push(new TextDecoder().decode(data)); },
      resize() {},
      close() { pty.closed = true; },
      exited,
      emit(text) { opts.onData(enc(text)); },
      exit(result) { resolveExit(result); },
    };
    spawned.push(pty);
    return pty;
  };
  return { spawn, spawned };
}

describe('terminal manager — agent tabs report running / idle / needs you', () => {
  let root: string;
  let clock: number;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-agent-tab-'));
    clock = 1_000_000;
    resetTerminalActivityForTest();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    resetTerminalActivityForTest();
  });

  function manager(installed: string[] = [], removed: string[] = []) {
    const fake = fakeSpawner();
    const m = createTerminalManager({
      spawner: fake.spawn,
      registry: null,
      env: async () => ({ PATH: '/usr/bin:/bin', HOME: root }),
      shell: () => '/bin/zsh',
      kill: () => {},
      exists: () => false,
      listDescendants: async () => [],
      frameIntervalMs: 0,
      startCommandWaitMs: 5,
      shellIntegration: { dir: () => path.join(root, '.si') },
      killSwitch: async () => false,
      agentQuietMs: 20,
      now: () => clock,
      installAgentHooks: async (opts) => {
        installed.push(`${opts.kind}:${opts.tabId}:${opts.baseUrl}`);
        return opts.kind === 'claude-code'
          ? { args: ['--settings', `/tmp/hooks/${opts.tabId}/claude-settings.json`], dir: `/tmp/hooks/${opts.tabId}` }
          : null;
      },
      removeAgentHooks: async (d) => { removed.push(d); },
    });
    return { m, fake };
  }

  function states(frames: VerseTerminalStreamFrame[]): Array<string | null> {
    return frames.filter((f) => f.type === 'agent-state').map((f) => (f as { agentState: { state: string } | null }).agentState?.state ?? null);
  }

  it('Claude Code with hooks: the launch carries --settings; a hook with the right token sets the state; a wrong one does not', async () => {
    const installed: string[] = [];
    const removed: string[] = [];
    const { m, fake } = manager(installed, removed);
    const tab = await m.create({ sessionId: 's-1', root, cols: 80, rows: 24, appId: 'claude-code', startCommand: 'claude', agentStatus: { hooksBaseUrl: 'http://127.0.0.1:7777' } });
    expect(installed).toEqual([`claude-code:${tab.id}:http://127.0.0.1:7777`]);
    expect(tab.agentState).toBeNull();
    const pty = fake.spawned[0]!;
    pty.emit('prompt% ');
    await tick(80);
    expect(pty.written.join('')).toBe(`claude --settings /tmp/hooks/${tab.id}/claude-settings.json\r`);
    // The token lives in the hook script only: read it the way the manager checks it.
    expect(m.reportAgentState(tab.id, 'wrong', 'running', null)).toBe(false);
    expect(m.reportAgentState('t-nope', 'x', 'running', null)).toBe(false);
    m.kill(tab.id);
    expect(removed).toEqual([`/tmp/hooks/${tab.id}`]);
  });

  it('heuristic (Devin): the CLI settles → idle; Enter → running; quiet → idle; a question → needs you, filed in Needs you and the notifier', async () => {
    const { m, fake } = manager();
    const frames: VerseTerminalStreamFrame[] = [];
    const tab = await m.create({ sessionId: 's-1', root, cols: 80, rows: 24, appId: 'devin', startCommand: 'devin', agentStatus: { hooksBaseUrl: null } });
    m.subscribe(tab.id, 0, (f) => frames.push(f));
    const pty = fake.spawned[0]!;
    pty.emit('Devin ready\r\n> ');
    await tick(60);
    expect(m.get(tab.id)!.agentState).toMatchObject({ agent: 'devin', state: 'idle', channel: 'heuristic', source: 'output' });

    clock += 1_000;
    m.write(tab.id, enc('fix the tests\r'));
    expect(m.get(tab.id)!.agentState!.state).toBe('running');
    clock += 20_000;
    pty.emit('Reading files…\r\n');
    await tick(60);
    expect(m.get(tab.id)!.agentState!.state).toBe('idle');
    // Ran ≥ 15 s: the notifier hears it went idle.
    expect(terminalActivitySnapshot().events.map((e) => e.kind)).toEqual(['agent-idle']);

    m.write(tab.id, enc('go on\r'));
    clock += 1_000;
    pty.emit('Edit src/app.ts? (y/n) ');
    await tick(60);
    const state = m.get(tab.id)!.agentState!;
    expect(state).toMatchObject({ state: 'needs-you', message: 'Edit src/app.ts? (y/n)' });
    const items = needsYouItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: `chats:agent-waiting:${tab.id}`, kind: 'agent-waiting', source: 'chats', target: { kind: 'terminal', tabId: tab.id, sessionId: 's-1' } });
    expect(isNeedsYouItem(items[0])).toBe(true);
    expect(terminalActivitySnapshot().events.at(-1)).toMatchObject({ kind: 'agent-needs-you', tabId: tab.id, agent: 'devin' });

    // Answering clears it (and the old question on screen is not read again).
    m.write(tab.id, enc('y\r'));
    expect(m.get(tab.id)!.agentState!.state).toBe('running');
    expect(needsYouItems()).toEqual([]);
    await tick(60);
    expect(m.get(tab.id)!.agentState!.state).toBe('idle');
    expect(states(frames)).toEqual(['idle', 'running', 'idle', 'running', 'needs-you', 'running', 'idle']);
    m.closeAll();
  });

  it('the agent exiting (its launch block finishes) returns the tab to a plain shell', async () => {
    const { m, fake } = manager();
    const tab = await m.create({ sessionId: 's-1', root, cols: 80, rows: 24, appId: 'grok', startCommand: 'grok', agentStatus: { hooksBaseUrl: null } });
    const pty = fake.spawned[0]!;
    const nonce = pty.opts.env['ASHLR_SHELL_NONCE']!;
    pty.emit(PROMPT);
    await tick(10);
    pty.emit(`grok\r\n${osc(`633;E;grok;${nonce}`)}${osc('133;C')}Grok ready\r\n`);
    await tick(60);
    expect(m.get(tab.id)!.agentState!.state).toBe('idle');
    pty.emit(`${osc('133;D;0')}${PROMPT}`);
    await tick(10);
    expect(m.get(tab.id)!.agentState).toBeNull();
    m.closeAll();
  });

  it('a long command in a plain shell is announced for the notifier (≥ 30 s), a short one is not; never its command line', async () => {
    const { m, fake } = manager();
    const tab = await m.create({ sessionId: 's-1', root, cols: 80, rows: 24 });
    const pty = fake.spawned[0]!;
    const nonce = pty.opts.env['ASHLR_SHELL_NONCE']!;
    pty.emit(PROMPT);
    const run = (cmd: string, ms: number, exit: number) => {
      pty.emit(`${osc(`633;E;${cmd};${nonce}`)}${osc('133;C')}out\r\n`);
      clock += ms;
      pty.emit(`${osc(`133;D;${exit}`)}${PROMPT}`);
    };
    run('echo quick', 2_000, 0);
    run('npm run build --token=sk-live-secret', 134_000, 1);
    await tick(10);
    const events = terminalActivitySnapshot().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'command-finished', tabId: tab.id, exitCode: 1, durationMs: 134_000, blockId: 'b-2' });
    expect(JSON.stringify(events)).not.toContain('sk-live');
    m.closeAll();
  });
});

// ---------------------------------------------------------------------------
// Loopback URLs
// ---------------------------------------------------------------------------

describe('blocks — loopback URLs a command prints', () => {
  it('finds them through colour codes, normalises 0.0.0.0, ignores other hosts', () => {
    expect(findLocalUrls('  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  ➜  Network: http://192.168.1.2:5173/')).toEqual(['http://localhost:5173/']);
    expect(findLocalUrls('listening on http://0.0.0.0:3000.')).toEqual(['http://localhost:3000']);
    expect(findLocalUrls('see https://example.com and http://127.0.0.1:8080/app?x=1')).toEqual(['http://127.0.0.1:8080/app?x=1']);
    expect(findLocalUrls('http://localhost:99999/')).toEqual([]);
  });

  it('a running block learns its URL even when a frame cuts it in half, and is re-emitted', () => {
    const events: VerseTerminalBlock[] = [];
    const tr = createBlockTracker({ tabId: 't-1', nonce: NONCE, onBlock: (b) => events.push(b) });
    tr.feed(enc(PROMPT), 1);
    tr.feed(enc(`${osc(`633;E;npm run dev;${NONCE}`)}${osc('133;C')}VITE ready\r\n  Local: http://localhost:51`), 2);
    expect(tr.list()[0]!.localUrls).toBeUndefined();
    tr.feed(enc('73/\r\n'), 3);
    expect(tr.list()[0]!.localUrls).toEqual(['http://localhost:5173/']);
    expect(events.at(-1)!.localUrls).toEqual(['http://localhost:5173/']);
    expect(events.at(-1)!.state).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// launch.json
// ---------------------------------------------------------------------------

describe('launch configurations — .ashlr/verse/launch.json', () => {
  const valid = {
    version: 1,
    configurations: [
      {
        name: 'Dev',
        tabs: [
          { split: 'down', panes: [{ cwd: 'web', command: 'npm run dev' }, { command: 'npm test -- --watch' }] },
          { panes: [{ agent: 'claude-code' }] },
        ],
      },
    ],
  };

  it('reads a valid file', () => {
    expect(parseLaunchFile(JSON.stringify(valid), '/p')).toEqual([{
      name: 'Dev',
      root: '/p',
      tabs: [
        { split: 'down', panes: [{ cwd: 'web', command: 'npm run dev', agent: null }, { cwd: null, command: 'npm test -- --watch', agent: null }] },
        { split: 'right', panes: [{ cwd: null, command: null, agent: 'claude-code' }] },
      ],
    }]);
  });

  it.each([
    ['not json', '{', /not valid JSON/],
    ['a version', JSON.stringify({ configurations: [] }), /version/],
    ['unknown key', JSON.stringify({ ...valid, run: true }), /unknown key "run"/],
    ['a multi-line command', JSON.stringify({ version: 1, configurations: [{ name: 'x', tabs: [{ panes: [{ command: 'a\nrm -rf ~' }] }] }] }), /one line/],
    ['a cwd that climbs out', JSON.stringify({ version: 1, configurations: [{ name: 'x', tabs: [{ panes: [{ cwd: '../..' }] }] }] }), /inside the project/],
    ['an absolute cwd', JSON.stringify({ version: 1, configurations: [{ name: 'x', tabs: [{ panes: [{ cwd: '/etc' }] }] }] }), /relative/],
    ['an unknown agent', JSON.stringify({ version: 1, configurations: [{ name: 'x', tabs: [{ panes: [{ agent: 'rm' }] }] }] }), /terminal agent/],
    ['three panes', JSON.stringify({ version: 1, configurations: [{ name: 'x', tabs: [{ panes: [{}, {}, {}] }] }] }), /one or two panes/],
    ['duplicate names', JSON.stringify({ version: 1, configurations: [{ name: 'x', tabs: [{ panes: [{}] }] }, { name: 'x', tabs: [{ panes: [{}] }] }] }), /two configurations/],
    ['command and agent', JSON.stringify({ version: 1, configurations: [{ name: 'x', tabs: [{ panes: [{ command: 'ls', agent: 'codex' }] }] }] }), /not both/],
  ])('refuses %s', (_label, text, error) => {
    expect(() => parseLaunchFile(text, '/p')).toThrow(error);
  });
});
