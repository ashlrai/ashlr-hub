/**
 * 3.15 — the Terminal's command blocks (OSC 133 shell integration), links,
 * chat hand-off and the kill switch: core/verse/shell-integration.ts,
 * terminal-blocks.ts, and their wiring in terminal.ts / terminal-api.ts.
 *
 * vitest runs on Node, which has no PTY: shells here are FAKE spawners fed
 * the exact bytes a real zsh/bash emits (captured from a Bun PTY run of the
 * generated scripts). The real-shell run of the scripts themselves is in
 * verse-terminal-shell-integration-315.test.ts (real-io lane).
 *
 * Under test:
 *   - the OSC 133 / 633 / 7 parser: terminators, chunk splits, nonce, escaping;
 *   - blocks: command, cwd, duration, exit code, output (tail-kept, evicted,
 *     full-screen), PROMPT_SP trimmed, a prompt closing an unfinished block;
 *   - reattach: output frames, then blocks pinned to (seq, ordinal), replayed;
 *   - launch: zsh via ZDOTDIR (argv unchanged), bash via --init-file, fish via
 *     --init-command, anything else plain; the user's ZDOTDIR carried; an
 *     unsafe scripts dir means no integration; env still sanitised;
 *   - routes: blocks, block output (ansi/text/chat — chat scrubbed), redact,
 *     open-file (inside the chat's roots only), cwd inside the root, KILL;
 *   - no synchronous fs in the route file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import type { VerseSession } from '../src/core/verse/types.js';
import {
  bashIntegrationScript,
  createShellMarkParser,
  ensureIntegrationFiles,
  fishIntegrationScript,
  integratedLaunch,
  interpretOscPayload,
  unescapeOsc633,
  zshIntegrationFiles,
} from '../src/core/verse/shell-integration.js';
import { commandFromEcho, createBlockTracker, terminalBytesToText, trimPromptSp } from '../src/core/verse/terminal-blocks.js';
import {
  createTerminalManager,
  setTerminalManagerForTest,
  TERMINAL_KILL_SWITCH_REASON,
  type PtyExit,
  type PtyHandle,
  type PtySpawnOptions,
  type TerminalManager,
} from '../src/core/verse/terminal.js';
import { setTerminalApiDepsForTest } from '../src/core/verse/terminal-api.js';
import { invalidateVerseSeatCache, resetVerseEngine } from '../src/core/verse/verse-api.js';
import { resetPreviewCaches } from '../src/core/verse/preview.js';
import type { VerseTerminalBlock, VerseTerminalFrame } from '../src/core/verse/workbench-types.js';
import { findSyncIoInSource } from '../scripts/check-verse-sync-io.mjs';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

// ---------------------------------------------------------------------------
// Bytes a real shell writes (Bun PTY capture of the generated zsh scripts)
// ---------------------------------------------------------------------------

const NONCE = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const osc = (payload: string) => `\x1b]${payload}\x07`;
const PROMPT = `\r\x1b[0m\x1b[27m\x1b[24m\x1b[J${osc('133;A')}USER% ${osc('133;B')}\x1b[K\x1b[?2004h`;
const PROMPT_SP = `\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m${' '.repeat(99)}\r \r`;

function zshRun(command: string, escaped: string, output: string, exit: number, cwd = '/Users/me/proj', nonce = NONCE): string {
  return `${command}\x1b[?2004l\r\r\n${osc(`633;E;${escaped};${nonce}`)}${osc('133;C')}${output}${osc(`133;D;${exit}`)}${osc(`633;P;Cwd=${cwd}`)}${PROMPT}`;
}

const enc = (s: string) => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe('shell marks — the OSC parser', () => {
  it('reads OSC 133 A/B/C/D with BEL or ST terminators, and ignores other OSCs', () => {
    const p = createShellMarkParser(NONCE);
    const marks = p.feed(enc(`x${osc('133;A')}\x1b]133;B\x1b\\${osc('0;title')}${osc('133;C')}out${osc('133;D;127')}`));
    expect(marks.map((m) => m.mark)).toEqual([
      { kind: 'prompt-start' },
      { kind: 'command-start' },
      { kind: 'command-executed' },
      { kind: 'command-finished', exitCode: 127 },
    ]);
    // Offsets are exact: the C mark ends where "out" begins.
    const text = `x${osc('133;A')}\x1b]133;B\x1b\\${osc('0;title')}${osc('133;C')}out`;
    expect(marks[2]!.end).toBe(text.length - 3);
  });

  it('a mark split across chunks reports a negative start (bytes carried from earlier chunks)', () => {
    const p = createShellMarkParser(null);
    expect(p.feed(enc('output\x1b]13'))).toEqual([]);
    const [m] = p.feed(enc('3;D;0\x07rest'));
    expect(m!.mark).toEqual({ kind: 'command-finished', exitCode: 0 });
    expect(m!.start).toBe(-4); // "\x1b]13" came with the first chunk
    expect(m!.end).toBe(6);
  });

  it('trusts a command line only with the tab nonce, and unescapes it', () => {
    expect(interpretOscPayload(`633;E;ls \\x3b echo "a\\\\b";${NONCE}`, NONCE)).toEqual({ kind: 'command-line', command: 'ls ; echo "a\\b"', trusted: true });
    expect(interpretOscPayload('633;E;rm -rf /;forged', NONCE)).toMatchObject({ trusted: false });
    expect(interpretOscPayload('633;E;rm -rf /', NONCE)).toMatchObject({ trusted: false });
    expect(interpretOscPayload(`633;E;x;${NONCE}`, null)).toMatchObject({ trusted: false });
    expect(unescapeOsc633('a\\x0ab\\\\c')).toBe('a\nb\\c');
  });

  it('reads the working directory from OSC 633 P;Cwd and OSC 7, absolute only', () => {
    expect(interpretOscPayload('633;P;Cwd=/Users/me/my\\x3bproj', null)).toEqual({ kind: 'cwd', cwd: '/Users/me/my;proj' });
    expect(interpretOscPayload('7;file://host/Users/me/a%20b', null)).toEqual({ kind: 'cwd', cwd: '/Users/me/a b' });
    expect(interpretOscPayload('633;P;Cwd=relative', null)).toBeNull();
    expect(interpretOscPayload('633;P;Cwd=/a\\x07b', null)).toBeNull();
  });

  it('strips control and bidi characters from a command line and caps it', () => {
    const mark = interpretOscPayload(`633;E;echo \\x1b[31mred\u202e;${NONCE}`, NONCE);
    expect(mark).toEqual({ kind: 'command-line', command: 'echo [31mred', trusted: true });
    const long = interpretOscPayload(`633;E;${'x'.repeat(10_000)};${NONCE}`, NONCE) as { command: string };
    expect(long.command.length).toBe(4096);
  });

  it('abandons a runaway OSC instead of buffering it forever', () => {
    const p = createShellMarkParser(null);
    expect(p.feed(enc(`\x1b]633;E;${'y'.repeat(40 * 1024)}`))).toEqual([]);
    expect(p.feed(enc(`\x07${osc('133;A')}`)).map((m) => m.mark.kind)).toEqual(['prompt-start']);
  });
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function tracker(overrides: Partial<Parameters<typeof createBlockTracker>[0]> = {}) {
  let t = 1_000_000;
  const events: VerseTerminalBlock[] = [];
  const cwds: string[] = [];
  let active = 0;
  const tr = createBlockTracker({
    tabId: 't-1',
    nonce: NONCE,
    now: () => t,
    onBlock: (b) => events.push(b),
    onCwd: (c) => cwds.push(c),
    onActive: () => { active++; },
    ...overrides,
  });
  return { tr, events, cwds, advance: (ms: number) => { t += ms; }, active: () => active };
}

describe('blocks — cut from the byte stream', () => {
  it('a zsh session becomes blocks: command, cwd, duration, exit code, output', () => {
    const { tr, events, cwds, advance, active } = tracker();
    tr.feed(enc(`${osc('633;P;Cwd=/Users/me/proj')}${PROMPT}`), 1);
    expect(active()).toBe(1);
    tr.feed(enc(`echo "a;b"; false\x1b[?2004l\r\r\n${osc(`633;E;echo "a\\x3bb"\\x3b false;${NONCE}`)}${osc('133;C')}a;b\r\n`), 2);
    advance(250);
    tr.feed(enc(`${osc('133;D;1')}${osc('633;P;Cwd=/tmp')}${PROMPT}`), 3);
    const [block] = tr.list();
    expect(block).toMatchObject({
      id: 'b-1',
      tabId: 't-1',
      command: 'echo "a;b"; false',
      cwd: '/Users/me/proj',
      exitCode: 1,
      state: 'done',
      durationMs: 250,
      startSeq: 2,
      ordinal: 0,
      truncated: false,
      fullscreen: false,
    });
    expect(tr.output('b-1')!.bytes.toString()).toBe('a;b\r\n');
    // Started, then finished: two events for the page.
    expect(events.map((e) => e.state)).toEqual(['running', 'done']);
    expect(cwds).toEqual(['/Users/me/proj', '/tmp']);
    expect(tr.cwd).toBe('/tmp');
  });

  it('removes zsh\'s PROMPT_SP (output with no final newline) from the end of a block', () => {
    const { tr } = tracker();
    tr.feed(enc(PROMPT), 1);
    tr.feed(enc(zshRun('printf x', 'printf x', `x${PROMPT_SP}`, 0)), 2);
    expect(tr.output('b-1')!.bytes.toString()).toBe('x');
    expect(trimPromptSp(Buffer.from('plain'))).toEqual(Buffer.from('plain'));
  });

  it('numbers several C marks in one frame (ordinal), so each block pins its own line', () => {
    const { tr } = tracker();
    tr.feed(enc(`${PROMPT}${zshRun('a', 'a', 'A\r\n', 0)}${zshRun('b', 'b', 'B\r\n', 2)}`), 7);
    expect(tr.list().map((b) => [b.command, b.startSeq, b.ordinal, b.exitCode])).toEqual([
      ['a', 7, 0, 0],
      ['b', 7, 1, 2],
    ]);
  });

  it('keeps output split across frames, minus a D mark that began in the previous frame', () => {
    const { tr } = tracker();
    tr.feed(enc(`${PROMPT}ls\r\n${osc(`633;E;ls;${NONCE}`)}${osc('133;C')}one\r\n\x1b]13`), 1);
    tr.feed(enc(`3;D;0\x07${PROMPT}`), 2);
    expect(tr.output('b-1')!.bytes.toString()).toBe('one\r\n');
    expect(tr.list()[0]!.exitCode).toBe(0);
  });

  it('a forged command line (wrong nonce) is ignored: the echoed input is read back instead', () => {
    const { tr } = tracker();
    tr.feed(enc(`${PROMPT}e\bech\x1b[Ko hi\r\n${osc('633;E;rm -rf ~;not-the-nonce')}${osc('133;C')}hi\r\n${osc('133;D;0')}`), 1);
    expect(tr.list()[0]!.command).toBe('echo hi');
    expect(commandFromEcho(Buffer.from('git sta\rgit status'))).toBe('git status');
  });

  it('a prompt while a block is open closes it with no exit code (the shell never said)', () => {
    const { tr } = tracker();
    tr.feed(enc(`${PROMPT}${osc('133;C')}partial`), 1);
    tr.feed(enc(PROMPT), 2);
    expect(tr.list()[0]).toMatchObject({ state: 'done', exitCode: null });
  });

  it('close() (the shell exited) ends an open block', () => {
    const { tr } = tracker();
    tr.feed(enc(`${PROMPT}${osc('133;C')}still going`), 1);
    tr.close();
    expect(tr.list()[0]).toMatchObject({ state: 'done', exitCode: null });
  });

  it('a full-screen program keeps no output (it is a screen, not a transcript)', () => {
    const { tr } = tracker();
    tr.feed(enc(`${PROMPT}${osc('133;C')}\x1b[?1049hvim screen\x1b[?1049l${osc('133;D;0')}`), 1);
    expect(tr.list()[0]!.fullscreen).toBe(true);
    expect(tr.output('b-1')!.bytes.length).toBe(0);
  });

  it('keeps the TAIL of a long block (the error is at the end)', () => {
    const { tr } = tracker({ blockOutputBytes: 10 });
    tr.feed(enc(`${PROMPT}${osc('133;C')}0123456789ABCDEF${osc('133;D;1')}`), 1);
    expect(tr.output('b-1')!.bytes.toString()).toBe('6789ABCDEF');
    expect(tr.list()[0]).toMatchObject({ truncated: true, outputBytes: 16 });
  });

  it('evicts the oldest blocks\' output past the tab budget, keeping their metadata', () => {
    const { tr } = tracker({ totalOutputBytes: 12 });
    tr.feed(enc(`${PROMPT}${zshRun('one', 'one', 'aaaaaaaa', 0)}${zshRun('two', 'two', 'bbbbbbbb', 0)}`), 1);
    const [first, second] = tr.list();
    expect(first).toMatchObject({ command: 'one', evicted: true });
    expect(tr.output('b-1')!.bytes.length).toBe(0);
    expect(second).toMatchObject({ command: 'two', evicted: false });
    expect(tr.output('b-2')!.bytes.toString()).toBe('bbbbbbbb');
  });

  it('drops the oldest blocks past the per-tab cap', () => {
    const { tr } = tracker({ maxBlocks: 2 });
    tr.feed(enc(`${PROMPT}${zshRun('1', '1', '', 0)}${zshRun('2', '2', '', 0)}${zshRun('3', '3', '', 0)}`), 1);
    expect(tr.list().map((b) => b.command)).toEqual(['2', '3']);
    expect(tr.get('b-1')).toBeNull();
  });

  it('renders a block as plain text: colours out, progress-bar redraws collapsed', () => {
    const bytes = Buffer.from('\x1b[32mok\x1b[0m\r\n 10%\r 50%\r100%\r\n\x1b]8;;http://x\x07link\x1b]8;;\x07\r\nab\bc\r\n\r\n');
    expect(terminalBytesToText(bytes)).toBe('ok\n100%\nlink\nac');
  });
});

// ---------------------------------------------------------------------------
// Scripts and launch plans
// ---------------------------------------------------------------------------

describe('shell integration — launching without touching dotfiles', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-si-315-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('zsh keeps its argv and gets our ZDOTDIR; the user\'s own ZDOTDIR is carried so their files still load', () => {
    const plan = integratedLaunch('/bin/zsh', dir, NONCE, { ZDOTDIR: '/Users/me/.config/zsh' })!;
    expect(plan.argv).toEqual(['/bin/zsh', '-l']);
    expect(plan.env).toEqual({ ASHLR_SHELL_NONCE: NONCE, ZDOTDIR: path.join(dir, 'zsh'), ASHLR_USER_ZDOTDIR: '/Users/me/.config/zsh' });
    expect(integratedLaunch('/bin/zsh', dir, NONCE, {})!.env['ASHLR_USER_ZDOTDIR']).toBeUndefined();
  });

  it('bash reads our init file (which sources the login files itself); fish sources ours after its config', () => {
    expect(integratedLaunch('/opt/homebrew/bin/bash', dir, NONCE, {})!.argv).toEqual(['/opt/homebrew/bin/bash', '--init-file', path.join(dir, 'ashlr-integration.bash')]);
    const fish = integratedLaunch('/opt/homebrew/bin/fish', "/tmp/it's", NONCE, {})!;
    expect(fish.argv).toEqual(['/opt/homebrew/bin/fish', '-l', '--init-command', "source '/tmp/it\\'s/ashlr-integration.fish'"]);
    expect(integratedLaunch('/bin/sh', dir, NONCE, {})).toBeNull();
    expect(integratedLaunch('/bin/ksh', dir, NONCE, {})).toBeNull();
  });

  it('the scripts load the user\'s files first, unset the nonce, and never write anywhere', () => {
    const zsh = zshIntegrationFiles();
    for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      expect(zsh[name]).toContain(`builtin source "$__ashlr_user_zdotdir/${name}"`);
    }
    expect(zsh['.zlogin']).toContain('__ashlr_restore_zdotdir');
    expect(zsh['ashlr-integration.zsh']).toContain('builtin unset ASHLR_SHELL_NONCE');
    expect(bashIntegrationScript()).toMatch(/\/etc\/profile[\s\S]*\.bash_profile[\s\S]*\.bash_login[\s\S]*\.profile/);
    expect(bashIntegrationScript()).toContain('unset ASHLR_SHELL_NONCE');
    expect(fishIntegrationScript()).toContain('set -e ASHLR_SHELL_NONCE');
    for (const body of [...Object.values(zsh), bashIntegrationScript(), fishIntegrationScript()]) {
      expect(body).not.toMatch(/>>?\s*["']?\$?(HOME|\{HOME\}|~)/); // no redirect into a dotfile
    }
  });

  it('writes the files privately (0700 dir, 0600 files) and refuses a directory that is not ours to trust', async () => {
    const target = path.join(dir, 'v1');
    await ensureIntegrationFiles(target, 'zsh');
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(target, 'zsh', '.zshrc')).mode & 0o777).toBe(0o600);
    // Idempotent.
    await ensureIntegrationFiles(target, 'zsh');

    const open = path.join(dir, 'open');
    fs.mkdirSync(path.join(open, 'v1'), { recursive: true });
    fs.chmodSync(path.join(open, 'v1'), 0o777);
    await expect(ensureIntegrationFiles(path.join(open, 'v1'), 'bash')).rejects.toThrow(/writable by others/);

    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(dir, 'link'));
    await expect(ensureIntegrationFiles(path.join(dir, 'link'), 'bash')).rejects.toThrow(/not a plain directory/);
  });
});

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

interface FakePty extends PtyHandle {
  opts: PtySpawnOptions;
  written: Uint8Array[];
  closed: boolean;
  emit(text: string): void;
  exit(result: PtyExit): void;
}

function fakeSpawner(): { spawn: (opts: PtySpawnOptions) => FakePty; spawned: FakePty[] } {
  const spawned: FakePty[] = [];
  let nextPid = 7000;
  const spawn = (opts: PtySpawnOptions): FakePty => {
    let resolveExit!: (value: PtyExit) => void;
    const exited = new Promise<PtyExit>((r) => { resolveExit = r; });
    const pty: FakePty = {
      pid: nextPid++,
      opts,
      written: [],
      closed: false,
      write(data) { pty.written.push(data); },
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

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('TerminalManager — blocks, integration, kill switch', () => {
  let root: string;
  let siDir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-term-315-'));
    siDir = path.join(root, '.si', 'v1');
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function manager(overrides: Parameters<typeof createTerminalManager>[0] = {}) {
    const fake = fakeSpawner();
    let kill = false;
    const m = createTerminalManager({
      spawner: fake.spawn,
      registry: null,
      env: async () => ({ PATH: '/usr/bin:/bin', HOME: root }),
      shell: () => '/bin/zsh',
      kill: () => {},
      exists: () => false,
      listDescendants: async () => [],
      frameIntervalMs: 0,
      killGraceMs: 10,
      shellIntegration: { dir: () => siDir },
      killSwitch: async () => kill,
      ...overrides,
    });
    return { m, fake, setKill: (on: boolean) => { kill = on; } };
  }

  function nonceOf(pty: FakePty): string {
    return pty.opts.env['ASHLR_SHELL_NONCE']!;
  }

  it('starts an integrated zsh: our ZDOTDIR, a nonce, and still a sanitised environment', async () => {
    const { m, fake } = manager({
      env: async () => ({ PATH: '/usr/bin', HOME: root }),
    });
    const tab = await m.create({ sessionId: 's', root, cols: 80, rows: 24 });
    const pty = fake.spawned[0]!;
    expect(pty.opts.argv).toEqual(['/bin/zsh', '-l']);
    expect(pty.opts.env['ZDOTDIR']).toBe(path.join(siDir, 'zsh'));
    expect(nonceOf(pty)).toMatch(/^[a-f0-9]{24}$/);
    expect(fs.existsSync(path.join(siDir, 'zsh', 'ashlr-integration.zsh'))).toBe(true);
    expect(tab.shellIntegration).toBe('injected');
    // Only our two variables start ASHLR_; the scripts unset them at once.
    expect(Object.keys(pty.opts.env).filter((k) => k.startsWith('ASHLR_'))).toEqual(['ASHLR_SHELL_NONCE']);
  });

  it('the default environment is login-path\'s sanitised one: ASHLR_*, credentials and seat pins never reach the shell', async () => {
    const saved = { ...process.env };
    try {
      process.env['ASHLR_TOKEN'] = 'x';
      process.env['GITHUB_TOKEN'] = 'ghp_secret';
      process.env['OPENAI_API_KEY'] = 'sk-secret';
      process.env['CLAUDE_CONFIG_DIR'] = '/seat';
      process.env['SSH_AUTH_SOCK'] = '/tmp/agent.sock';
      const { m, fake } = manager({ env: undefined });
      await m.create({ sessionId: 's', root, cols: 80, rows: 24 });
      const env = fake.spawned[0]!.opts.env;
      expect(env['ASHLR_TOKEN']).toBeUndefined();
      expect(env['GITHUB_TOKEN']).toBeUndefined();
      expect(env['OPENAI_API_KEY']).toBeUndefined();
      expect(env['CLAUDE_CONFIG_DIR']).toBeUndefined();
      expect(env['SSH_AUTH_SOCK']).toBe('/tmp/agent.sock');
      expect(env['TERM']).toBe('xterm-256color');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }, 20_000);

  it('no integration for an unsupported shell, when turned off per tab, or when the scripts dir is unsafe', async () => {
    const plainShell = manager({ shell: () => '/bin/sh' });
    const a = await plainShell.m.create({ sessionId: 's', root, cols: 80, rows: 24 });
    expect(plainShell.fake.spawned[0]!.opts.argv).toEqual(['/bin/sh', '-l']);
    expect(a.shellIntegration).toBe('off');

    const off = manager();
    const b = await off.m.create({ sessionId: 's', root, cols: 80, rows: 24, shellIntegration: false });
    expect(off.fake.spawned[0]!.opts.env['ZDOTDIR']).toBeUndefined();
    expect(b.shellIntegration).toBe('off');

    const unsafe = path.join(root, 'shared');
    fs.mkdirSync(path.join(unsafe, 'v1'), { recursive: true });
    fs.chmodSync(unsafe, 0o777);
    const bad = manager({ shellIntegration: { dir: () => path.join(unsafe, 'v1') } });
    const c = await bad.m.create({ sessionId: 's', root, cols: 80, rows: 24 });
    expect(bad.fake.spawned[0]!.opts.argv).toEqual(['/bin/zsh', '-l']);
    expect(bad.fake.spawned[0]!.opts.env['ZDOTDIR']).toBeUndefined();
    expect(c.shellIntegration).toBe('off');
  });

  it('streams block frames after the output that holds their marker, and reports cwd and integration', async () => {
    const { m, fake } = manager();
    const tab = await m.create({ sessionId: 's', root, cols: 80, rows: 24 });
    const pty = fake.spawned[0]!;
    const frames: VerseTerminalFrame[] = [];
    m.subscribe(tab.id, 0, (f) => frames.push(f));
    pty.emit(`${osc('633;P;Cwd=/work')}${PROMPT}`);
    await tick(5);
    pty.emit(zshRun('npm test', 'npm test', 'FAIL src/x.test.ts\r\n', 1, '/work', nonceOf(pty)));
    await tick(5);
    const kinds = frames.map((f) => f.type);
    expect(kinds).toContain('integration');
    const firstBlock = kinds.indexOf('block');
    const outputSeqs = frames.filter((f): f is Extract<VerseTerminalFrame, { type: 'output' }> => f.type === 'output').map((f) => f.seq);
    const block = (frames.filter((f) => f.type === 'block').at(-1) as { block: VerseTerminalBlock }).block;
    expect(block).toMatchObject({ command: 'npm test', exitCode: 1, cwd: '/work', state: 'done' });
    // The frame it points into was sent before it.
    expect(outputSeqs.indexOf(block.startSeq)).toBeGreaterThanOrEqual(0);
    expect(kinds.slice(0, firstBlock)).toContain('output');
    expect(m.get(tab.id)).toMatchObject({ cwd: '/work', shellIntegration: 'active' });
    expect(m.blockOutput(tab.id, block.id)!.bytes.toString()).toBe('FAIL src/x.test.ts\r\n');
  });

  it('reattach: a reload replays the output past its cursor, then every block (with its seq), then the exit', async () => {
    const { m, fake } = manager();
    const tab = await m.create({ sessionId: 's', root, cols: 80, rows: 24 });
    const pty = fake.spawned[0]!;
    pty.emit(PROMPT);
    await tick(5);
    pty.emit(zshRun('ls', 'ls', 'a b\r\n', 0, '/w', nonceOf(pty)));
    await tick(5);
    pty.emit(zshRun('cat nope', 'cat nope', 'cat: nope: No such file\r\n', 1, '/w', nonceOf(pty)));
    await tick(5);

    const replay: VerseTerminalFrame[] = [];
    m.subscribe(tab.id, 0, (f) => replay.push(f));
    const types = replay.map((f) => f.type);
    expect(types.lastIndexOf('output')).toBeLessThan(types.indexOf('block'));
    const blocks = replay.filter((f) => f.type === 'block').map((f) => (f as { block: VerseTerminalBlock }).block);
    expect(blocks.map((b) => [b.command, b.exitCode])).toEqual([['ls', 0], ['cat nope', 1]]);
    expect(replay).toContainEqual({ type: 'cwd', cwd: '/w' });
    expect(replay).toContainEqual({ type: 'integration', state: 'active' });

    // A client that already has everything gets no output again — still the blocks.
    const lastSeq = Math.max(...replay.filter((f) => f.type === 'output').map((f) => (f as { seq: number }).seq));
    const again: VerseTerminalFrame[] = [];
    m.subscribe(tab.id, lastSeq, (f) => again.push(f));
    expect(again.filter((f) => f.type === 'output')).toEqual([]);
    expect(again.filter((f) => f.type === 'block')).toHaveLength(2);

    // The shell exits mid-command: the open block ends with it.
    pty.emit(`${osc(`633;E;sleep 100;${nonceOf(pty)}`)}${osc('133;C')}`);
    await tick(5);
    pty.exit({ code: 0, signal: null });
    await tick(60);
    const last = m.blocks(tab.id).at(-1)!;
    expect(last).toMatchObject({ command: 'sleep 100', state: 'done', exitCode: null });
  });

  it('starts in a requested cwd (a split opening beside its neighbour)', async () => {
    const { m, fake } = manager();
    const sub = path.join(root, 'pkg');
    fs.mkdirSync(sub);
    await m.create({ sessionId: 's', root, cwd: sub, cols: 80, rows: 24 });
    expect(fake.spawned[0]!.opts.cwd).toBe(sub);
    await expect(m.create({ sessionId: 's', root, cwd: path.join(root, 'missing'), cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'TERMINAL_INVALID' });
  });

  it('KILL: an agent launch is refused while the kill switch is engaged; the operator\'s own shell is not', async () => {
    const { m, fake, setKill } = manager();
    setKill(true);
    await expect(m.create({ sessionId: 's', root, cols: 80, rows: 24, appId: 'codex', startCommand: 'codex' })).rejects.toMatchObject({ code: 'TERMINAL_KILL_SWITCH', message: TERMINAL_KILL_SWITCH_REASON });
    expect(fake.spawned).toHaveLength(0);
    await m.create({ sessionId: 's', root, cols: 80, rows: 24 });
    expect(fake.spawned).toHaveLength(1);
  });

  it('KILL: engaging it hangs up open agent tabs only, and says why in the tab', async () => {
    const { m, fake, setKill } = manager({ killCheckIntervalMs: 60_000 });
    const agent = await m.create({ sessionId: 's', root, cols: 80, rows: 24, appId: 'codex', startCommand: 'codex' });
    const mine = await m.create({ sessionId: 's', root, cols: 80, rows: 24 });
    expect(agent.agent).toBe(true);
    expect(mine.agent).toBe(false);
    const frames: VerseTerminalFrame[] = [];
    m.subscribe(agent.id, 0, (f) => frames.push(f));
    expect(await m.enforceKillSwitch()).toEqual([]);
    setKill(true);
    expect(await m.enforceKillSwitch()).toEqual([agent.id]);
    expect(m.get(agent.id)).toBeNull();
    expect(m.get(mine.id)).not.toBeNull();
    expect(fake.spawned[1]!.closed).toBe(false);
    const said = frames.filter((f) => f.type === 'output').map((f) => Buffer.from((f as { dataBase64: string }).dataBase64, 'base64').toString()).join('');
    expect(said).toContain('kill switch is engaged');
    m.closeAll();
  });

  it('the kill-switch watch is itself a timer while an agent tab is open', async () => {
    const { m, setKill } = manager({ killCheckIntervalMs: 20 });
    const agent = await m.create({ sessionId: 's', root, cols: 80, rows: 24, appId: 'codex', startCommand: 'codex' });
    setKill(true);
    await tick(80);
    expect(m.get(agent.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Routes through the real server
// ---------------------------------------------------------------------------

interface HttpResult { status: number; json: unknown }

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

function engineWith(sessions: VerseSession[]): VerseEngineHandle {
  return {
    listSessions: () => sessions,
    getSession: (id: string) => sessions.find((s) => s.id === id) ?? null,
    getEvents: () => [],
    subscribe: () => () => {},
    close: () => {},
  } as unknown as VerseEngineHandle;
}

function sessionAt(id: string, projectPath: string): VerseSession {
  return {
    id,
    title: 'chat',
    projectPath,
    engine: 'claude',
    accountId: 'a',
    seatId: 'claude-a',
    model: 'm',
    nativeSessionId: null,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    status: 'idle',
    turnCount: 0,
    usage: {},
    lastError: null,
  } as unknown as VerseSession;
}

describe('terminal 3.15 routes through the real server', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let project: string;
  let outside: string;
  let handles: Array<{ close(): Promise<void> }> = [];
  let fake: ReturnType<typeof fakeSpawner>;
  let m: TerminalManager;
  let killOn: boolean;
  let opened: Array<[string, number]>;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-terminal-315-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    project = path.join(tmpHome, 'proj');
    outside = path.join(tmpHome, 'elsewhere');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'export {};\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    resetVerseEngine(engineWith([sessionAt('s-1', project)]));
    invalidateVerseSeatCache();
    resetPreviewCaches();
    fake = fakeSpawner();
    killOn = false;
    m = createTerminalManager({
      spawner: fake.spawn,
      registry: null,
      env: async () => ({ PATH: '/usr/bin:/bin', HOME: tmpHome }),
      shell: () => '/bin/zsh',
      kill: () => {},
      exists: () => false,
      listDescendants: async () => [],
      frameIntervalMs: 0,
      shellIntegration: { dir: () => path.join(tmpHome, '.si', 'v1') },
      killSwitch: async () => killOn,
    });
    setTerminalManagerForTest(m);
    opened = [];
    setTerminalApiDepsForTest({
      openExternal: async () => {},
      platform: 'darwin',
      devServers: { listListeners: async () => [] },
      openInEditor: async (abs, line) => { opened.push([abs, line]); },
    });
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
    setTerminalManagerForTest(null);
    setTerminalApiDepsForTest(null);
    resetVerseEngine(null);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function boot() {
    const cfgRoot = path.join(tmpHome, '.ashlr', 'account-connections');
    fs.mkdirSync(cfgRoot, { recursive: true });
    fs.writeFileSync(path.join(cfgRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
    const handle = await startServer(makeConfig(cfgRoot), { port: 0, open: false, allowDispatch: true });
    handles.push(handle);
    return {
      port: handle.port,
      read: readAuthHeaders(handle.port),
      mutate: { 'x-ashlr-token': handle.token, 'content-type': 'application/json' },
    };
  }

  async function openTab(port: number, mutate: Record<string, string>, extra: Record<string, unknown> = {}) {
    const res = await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24, ...extra }));
    return res;
  }

  it('lists blocks and serves a block\'s output as ansi, text, and chat — chat with every secret scrubbed', async () => {
    const { port, read, mutate } = await boot();
    const created = await openTab(port, mutate);
    const tabId = (created.json as { tab: { id: string } }).tab.id;
    const pty = fake.spawned[0]!;
    const nonce = pty.opts.env['ASHLR_SHELL_NONCE']!;
    pty.emit(`${osc(`633;P;Cwd=${project}`)}${PROMPT}`);
    await tick(10);
    pty.emit(zshRun(
      'curl -H "Authorization: Bearer sk-live-abcdefghijklmnopqrstuv" api',
      'curl -H "Authorization: Bearer sk-live-abcdefghijklmnopqrstuv" api',
      '\x1b[31merror\x1b[0m: key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 rejected\r\n',
      22,
      project,
      nonce,
    ));
    await tick(10);

    const list = await request(port, 'GET', `/api/verse/terminal/${tabId}/blocks`, read);
    expect(list.status).toBe(200);
    const [block] = (list.json as { blocks: VerseTerminalBlock[] }).blocks;
    expect(block).toMatchObject({ exitCode: 22, state: 'done', cwd: '~/proj' });

    const ansi = await request(port, 'GET', `/api/verse/terminal/${tabId}/blocks/${block!.id}?format=ansi`, read);
    expect((ansi.json as { output: string }).output).toContain('\x1b[31m');

    const text = await request(port, 'GET', `/api/verse/terminal/${tabId}/blocks/${block!.id}?format=text`, read);
    expect((text.json as { output: string }).output).not.toContain('\x1b');

    const chat = await request(port, 'GET', `/api/verse/terminal/${tabId}/blocks/${block!.id}?format=chat`, read);
    const body = chat.json as { command: string; output: string };
    expect(body.output).toContain('[REDACTED]');
    expect(body.output).not.toContain('sk-ant-api03');
    expect(body.command).not.toContain('sk-live-abcdefghijklmnopqrstuv');
    expect(body.output.startsWith('error: key')).toBe(true);

    expect((await request(port, 'GET', `/api/verse/terminal/${tabId}/blocks/${block!.id}?format=raw`, read)).status).toBe(400);
    expect((await request(port, 'GET', `/api/verse/terminal/${tabId}/blocks/b-999`, read)).status).toBe(404);
  });

  it('redact: selection → chat goes through the same scrub, behind the mutation token', async () => {
    const { port, mutate } = await boot();
    const res = await request(port, 'POST', '/api/verse/terminal/redact', mutate, JSON.stringify({ text: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nok' }));
    expect(res.status).toBe(200);
    expect((res.json as { text: string }).text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect((res.json as { text: string }).text).toContain('ok');
    expect((await request(port, 'POST', '/api/verse/terminal/redact', { 'content-type': 'application/json' }, JSON.stringify({ text: 'x' }))).status).toBe(401);
    expect((await request(port, 'POST', '/api/verse/terminal/redact', mutate, JSON.stringify({ text: 'x', more: 1 }))).status).toBe(400);
  });

  it('open-file: a file:line inside the chat\'s folder opens in the editor; outside, missing, or a directory does not', async () => {
    const { port, mutate } = await boot();
    const tabId = ((await openTab(port, mutate)).json as { tab: { id: string } }).tab.id;
    const post = (body: unknown) => request(port, 'POST', `/api/verse/terminal/${tabId}/open-file`, mutate, JSON.stringify(body));
    expect((await post({ path: 'src/app.ts', line: 12, column: 3 })).status).toBe(200);
    expect(opened).toEqual([[fs.realpathSync(path.join(project, 'src', 'app.ts')), 12]]);
    // Relative to a block's cwd (spelled with ~ as the page receives it).
    expect((await post({ path: 'app.ts', cwd: '~/proj/src' })).status).toBe(200);
    expect((await post({ path: path.join(outside, 'secret.txt') })).status).toBe(403);
    expect((await post({ path: '../elsewhere/secret.txt' })).status).toBe(403);
    expect((await post({ path: 'src/nope.ts' })).status).toBe(404);
    expect((await post({ path: 'src' })).status).toBe(400);
    expect((await post({ path: 'src/app.ts', line: 0 })).status).toBe(400);
    expect(opened).toHaveLength(2);
  });

  it('create with a cwd: inside the chat\'s folder only', async () => {
    const { port, mutate } = await boot();
    expect((await openTab(port, mutate, { cwd: '~/proj/src' })).status).toBe(201);
    expect(fs.realpathSync(fake.spawned[0]!.opts.cwd)).toBe(fs.realpathSync(path.join(project, 'src')));
    expect((await openTab(port, mutate, { cwd: outside })).status).toBe(400);
    expect((await openTab(port, mutate, { cwd: 'relative' })).status).toBe(400);
    expect((await openTab(port, mutate, { shellIntegration: 'yes' })).status).toBe(400);
    const off = await openTab(port, mutate, { shellIntegration: false });
    expect((off.json as { tab: { shellIntegration: string } }).tab.shellIntegration).toBe('off');
  });

  it('KILL: an agent launch is a 409 while the kill switch is engaged', async () => {
    const { port, mutate } = await boot();
    killOn = true;
    const res = await openTab(port, mutate, { appId: 'codex' });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: 'TERMINAL_KILL_SWITCH' });
    expect((await openTab(port, mutate)).status).toBe(201);
  });
});

describe('no synchronous fs on a terminal request path', () => {
  it('the route file and the modules it runs per request have no *Sync( calls', () => {
    for (const file of ['terminal-api.ts', 'terminal.ts', 'terminal-blocks.ts', 'shell-integration.ts']) {
      const source = fs.readFileSync(path.join(process.cwd(), 'src/core/verse', file), 'utf8');
      expect((findSyncIoInSource as (s: string) => unknown[])(source), file).toEqual([]);
    }
  });
});
