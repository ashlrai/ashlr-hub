/**
 * 3.15 — the terminal's command history, its settings, plain language →
 * command, and the multiplexed stream's pure halves.
 *
 *   - terminal-history.ts: one record per finished command, secrets scrubbed
 *     BEFORE disk, 0600, ranked prefix → cwd → repo → success → recency,
 *     bounded (compaction keeps the newest), clear, off = nothing written;
 *   - terminal.ts: a closed block reaches `onCommandFinished` and the
 *     listeners (the hook other units reuse), a running one does not;
 *   - terminal-settings.ts: defaults, lenient read, strict update, 0600;
 *   - terminal-assist.ts: what is sent (scrubbed, capped), what comes back
 *     (JSON / fenced / bare line), local first, Grok only in `auto`, `off`
 *     calls nothing, risky commands flagged;
 *   - terminal-api.ts: the `tabs=` list and the tagged frame format.
 *
 * No real model, no network: every model is a fake. HOME is a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig, ChatMessage } from '../src/core/types.js';
import {
  addTerminalCommandListener,
  createTerminalManager,
  recordFinishedCommand,
  type PtyExit,
  type PtyHandle,
  type PtySpawnOptions,
} from '../src/core/verse/terminal.js';
import {
  createTerminalHistory,
  findRepoRoot,
  parseHistoryLine,
  setTerminalHistoryForTest,
  TERMINAL_HISTORY_FILE,
} from '../src/core/verse/terminal-history.js';
import {
  loadTerminalSettings,
  parseTerminalSettings,
  parseTerminalSettingsUpdate,
  resetTerminalSettingsCacheForTest,
  TERMINAL_SETTINGS_FILE,
  updateTerminalSettings,
} from '../src/core/verse/terminal-settings.js';
import {
  ASSIST_BLOCK_OUTPUT_CHARS,
  buildAssistMessages,
  isRiskyCommand,
  parseAssistReply,
  runTerminalAssist,
  TerminalAssistError,
  type AssistModelCall,
} from '../src/core/verse/terminal-assist.js';
import { formatTerminalMuxFrame, parseMuxTabs } from '../src/core/verse/terminal-api.js';
import type { VerseTerminalBlock, VerseTerminalTab } from '../src/core/verse/workbench-types.js';

const SECRET = 'sk-ant-api03-' + 'A'.repeat(90);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-term-hist-'));
  resetTerminalSettingsCacheForTest();
});
afterEach(() => {
  setTerminalHistoryForTest(null);
  resetTerminalSettingsCacheForTest();
  fs.rmSync(dir, { recursive: true, force: true });
});

function lines(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe('terminal history — what is written', () => {
  it('appends one scrubbed record per command, 0600, with its repo', async () => {
    const repo = path.join(dir, 'repo');
    const sub = path.join(repo, 'src');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(sub);
    const h = createTerminalHistory({ dir, enabled: async () => true, now: () => Date.parse('2026-09-27T10:00:00Z') });
    expect(await h.record({ cmd: `curl -H "x-api-key: ${SECRET}" https://api`, cwd: sub, exit: 0, durMs: 812.4 })).toBe(true);
    const file = path.join(dir, TERMINAL_HISTORY_FILE);
    const [line] = lines(file);
    expect(line).toBeDefined();
    expect(line).not.toContain(SECRET);
    const rec = JSON.parse(line!);
    expect(rec).toMatchObject({ cwd: sub, repo, exit: 0, durMs: 812, ts: '2026-09-27T10:00:00.000Z' });
    expect(rec.cmd).toContain('[REDACTED');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('skips empty and huge commands, and records nothing when turned off', async () => {
    let on = true;
    const h = createTerminalHistory({ dir, enabled: async () => on });
    expect(await h.record({ cmd: '   ', cwd: null, exit: 0, durMs: 1 })).toBe(false);
    expect(await h.record({ cmd: 'x'.repeat(5000), cwd: null, exit: 0, durMs: 1 })).toBe(false);
    on = false;
    expect(await h.record({ cmd: 'ls', cwd: null, exit: 0, durMs: 1 })).toBe(false);
    expect(await h.query({})).toEqual([]);
    expect(lines(path.join(dir, TERMINAL_HISTORY_FILE))).toHaveLength(0);
  });

  it('honours terminal-settings.json by default (history: false writes nothing)', async () => {
    await updateTerminalSettings({ history: false }, dir);
    const h = createTerminalHistory({ dir });
    expect(await h.record({ cmd: 'ls', cwd: null, exit: 0, durMs: 1 })).toBe(false);
    await updateTerminalSettings({ history: true }, dir);
    expect(await h.record({ cmd: 'ls', cwd: null, exit: 0, durMs: 1 })).toBe(true);
  });

  it('compacts past the cap, keeping the newest, and clear deletes the file', async () => {
    let t = Date.parse('2026-09-27T00:00:00Z');
    const h = createTerminalHistory({ dir, enabled: async () => true, maxLines: 20, now: () => (t += 1000) });
    for (let i = 0; i < 30; i++) await h.record({ cmd: `echo ${i}`, cwd: null, exit: 0, durMs: 1 });
    await h.idle();
    const kept = lines(path.join(dir, TERMINAL_HISTORY_FILE));
    expect(kept.length).toBeLessThanOrEqual(22);
    expect(kept.length).toBeGreaterThanOrEqual(20);
    expect(JSON.parse(kept.at(-1)!).cmd).toBe('echo 29');
    // What was compacted away is gone from the ranking too.
    const all = await h.query({ limit: 500 });
    expect(all.some((e) => e.cmd === 'echo 0')).toBe(false);
    expect(all[0]!.cmd).toBe('echo 29');

    await h.clear();
    expect(fs.existsSync(path.join(dir, TERMINAL_HISTORY_FILE))).toBe(false);
    expect(await h.query({})).toEqual([]);
    // A record after a clear starts a fresh file.
    await h.record({ cmd: 'pwd', cwd: null, exit: 0, durMs: 1 });
    expect(lines(path.join(dir, TERMINAL_HISTORY_FILE))).toHaveLength(1);
  });

  it('a clear is never undone by an append already in flight', async () => {
    const h = createTerminalHistory({ dir, enabled: async () => true });
    const pending = h.record({ cmd: 'first', cwd: null, exit: 0, durMs: 1 });
    const cleared = h.clear();
    await Promise.all([pending, cleared]);
    expect(await h.query({})).toEqual([]);
  });

  it('reads a hand-edited file leniently (bad lines are skipped)', async () => {
    fs.writeFileSync(path.join(dir, TERMINAL_HISTORY_FILE), [
      JSON.stringify({ cmd: 'git status', cwd: '/w', repo: '/w', exit: 0, durMs: 5, ts: '2026-09-01T00:00:00Z' }),
      'not json',
      JSON.stringify({ cmd: '', ts: 'x' }),
      JSON.stringify({ cmd: 'make', ts: '2026-09-02T00:00:00Z', exit: 'nope' }),
    ].join('\n'));
    const h = createTerminalHistory({ dir, enabled: async () => true });
    const entries = await h.query({});
    expect(entries.map((e) => e.cmd)).toEqual(['git status', 'make']);
    expect(entries[1]!.exit).toBeNull();
    expect(parseHistoryLine('{"cmd":1}')).toBeNull();
  });

  it('finds the repo a directory is in (a worktree .git file counts)', async () => {
    const wt = path.join(dir, 'wt');
    fs.mkdirSync(path.join(wt, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere');
    expect(await findRepoRoot(path.join(wt, 'a', 'b'))).toBe(wt);
    expect(await findRepoRoot('relative/path')).toBeNull();
  });
});

describe('terminal history — ranking', () => {
  async function seeded() {
    let t = Date.parse('2026-09-27T00:00:00Z');
    const repoOf = async (cwd: string) => (cwd.startsWith('/repo') ? '/repo' : null);
    const h = createTerminalHistory({ dir, enabled: async () => true, now: () => (t += 1000), repoOf });
    const run = (cmd: string, cwd: string, exit: number | null) => h.record({ cmd, cwd, exit, durMs: 1 });
    await run('git status', '/elsewhere', 0);
    await run('git stash', '/repo/sub', 0);
    await run('git switch main', '/repo', 1);
    await run('git log --oneline', '/repo', 0);
    await run('npm run gate', '/repo', 0);
    await run('echo git', '/repo', 0);
    await run('git status', '/elsewhere', 0);
    return h;
  }

  it('prefix beats a word match; then same cwd, same repo, success, recency', async () => {
    const h = await seeded();
    const entries = await h.query({ q: 'git', cwd: '/repo' });
    expect(entries.map((e) => e.cmd)).toEqual([
      'git log --oneline', // prefix, here, repo, ok
      'git switch main', // prefix, here, repo, failed
      'git stash', // prefix, same repo only
      'git status', // prefix, elsewhere
      'echo git', // word match only
    ]);
    expect(entries[0]).toMatchObject({ here: true, sameRepo: true, count: 1, okCount: 1 });
    // One row per distinct command, with how often it ran.
    expect(entries.find((e) => e.cmd === 'git status')).toMatchObject({ count: 2, okCount: 2, here: false });
  });

  it('an empty query lists everything (the ghost-text source), limit applies, `~/` cwds are understood', async () => {
    const h = await seeded();
    const all = await h.query({ cwd: '/repo', limit: 3 });
    expect(all).toHaveLength(3);
    expect(all.every((e) => e.here)).toBe(true);
    const home = await h.query({ q: 'git', cwd: '~/definitely-not-there' });
    expect(home[0]!.here).toBe(false);
  });

  it('multi-word queries need every word (case-insensitive)', async () => {
    const h = await seeded();
    expect((await h.query({ q: 'RUN gate' })).map((e) => e.cmd)).toEqual(['npm run gate']);
  });
});

// ---------------------------------------------------------------------------
// The manager hands finished commands on
// ---------------------------------------------------------------------------

interface FakePty extends PtyHandle {
  opts: PtySpawnOptions;
  emit(text: string): void;
  exit(result: PtyExit): void;
}

function fakeSpawner() {
  const spawned: FakePty[] = [];
  const spawn = (opts: PtySpawnOptions): FakePty => {
    let resolveExit!: (value: PtyExit) => void;
    const exited = new Promise<PtyExit>((r) => { resolveExit = r; });
    const pty: FakePty = {
      pid: 5000 + spawned.length,
      opts,
      write() {},
      resize() {},
      close() {},
      exited,
      emit(text) { opts.onData(new TextEncoder().encode(text)); },
      exit(result) { resolveExit(result); },
    };
    spawned.push(pty);
    return pty;
  };
  return { spawn, spawned };
}

const osc = (payload: string) => `\x1b]${payload}\x07`;
const PROMPT = `${osc('133;A')}% ${osc('133;B')}`;

describe('terminal manager — finished commands', () => {
  it('calls onCommandFinished once per CLOSED block (never for a running one)', async () => {
    const fake = fakeSpawner();
    const finished: Array<[VerseTerminalTab, VerseTerminalBlock]> = [];
    const m = createTerminalManager({
      spawner: fake.spawn,
      registry: null,
      env: async () => ({ PATH: '/usr/bin', HOME: dir }),
      shell: () => '/bin/zsh',
      kill: () => {},
      exists: () => false,
      listDescendants: async () => [],
      frameIntervalMs: 0,
      shellIntegration: null,
      onCommandFinished: (tab, block) => { finished.push([tab, block]); },
    });
    await m.create({ sessionId: 's', root: dir, cols: 80, rows: 24 });
    const pty = fake.spawned[0]!;
    pty.emit(`${osc(`633;P;Cwd=${dir}`)}${PROMPT}`);
    pty.emit(`ls -la\r\n${osc('133;C')}total 0\r\n`);
    expect(finished).toHaveLength(0);
    pty.emit(`${osc('133;D;2')}${PROMPT}`);
    expect(finished).toHaveLength(1);
    expect(finished[0]![1]).toMatchObject({ command: 'ls -la', exitCode: 2, state: 'done', cwd: dir });
    expect(finished[0]![0].root).toBe(dir);
    m.closeAll();
  });

  it('recordFinishedCommand: listeners hear every command; history gets the non-empty ones', async () => {
    const h = createTerminalHistory({ dir, enabled: async () => true });
    setTerminalHistoryForTest(h);
    const heard: string[] = [];
    const off = addTerminalCommandListener((_tab, block) => heard.push(block.command));
    const tab = { id: 't-1', root: dir, cwd: null } as unknown as VerseTerminalTab;
    const block = (command: string, finishedAt = '2026-09-27T01:02:03.000Z') => ({ command, cwd: '/w', exitCode: 0, durationMs: 3, finishedAt }) as unknown as VerseTerminalBlock;
    await recordFinishedCommand(tab, block('make test'));
    await recordFinishedCommand(tab, block(''));
    off();
    await recordFinishedCommand(tab, block('after', '2026-09-27T01:05:00.000Z'));
    expect(heard).toEqual(['make test', '']);
    const entries = await h.query({});
    expect(entries.map((e) => e.cmd)).toEqual(['after', 'make test']);
    expect(entries[1]).toMatchObject({ cwd: '/w', ts: '2026-09-27T01:02:03.000Z' });
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('terminal settings', () => {
  it('defaults, a lenient read, a strict update, 0600', async () => {
    expect(await loadTerminalSettings(dir)).toEqual({ history: true, assist: 'auto' });
    expect(parseTerminalSettings({ history: 'no', assist: 'weird' })).toEqual({ history: true, assist: 'auto' });
    expect(parseTerminalSettingsUpdate({ history: false })).toEqual({ history: false });
    expect(parseTerminalSettingsUpdate({ assist: 'local' })).toEqual({ assist: 'local' });
    expect(parseTerminalSettingsUpdate({ history: 'false' })).toBeNull();
    expect(parseTerminalSettingsUpdate({ other: 1 })).toBeNull();
    expect(parseTerminalSettingsUpdate({})).toBeNull();
    expect(await updateTerminalSettings({ assist: 'off' }, dir)).toEqual({ history: true, assist: 'off' });
    resetTerminalSettingsCacheForTest();
    expect(await loadTerminalSettings(dir)).toEqual({ history: true, assist: 'off' });
    const file = path.join(dir, TERMINAL_SETTINGS_FILE);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Assist
// ---------------------------------------------------------------------------

const CFG = {} as AshlrConfig;

function model(text: string, name = 'local:qwen'): { call: AssistModelCall; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  return {
    seen,
    call: async (messages) => {
      seen.push(messages);
      return { text, model: name };
    },
  };
}

describe('terminal assist — what is sent', () => {
  it('request, cwd (~), OS, shell and the tails of the last blocks — all scrubbed', () => {
    const [system, user] = buildAssistMessages({
      request: `deploy with ${SECRET}`,
      cwd: path.join(os.homedir(), 'proj'),
      os: 'macOS (darwin 25, arm64)',
      shell: 'zsh',
      blocks: [
        { command: 'old', exitCode: 0, output: 'x' },
        { command: 'a', exitCode: 0, output: 'y' },
        { command: 'b', exitCode: 0, output: 'z' },
        { command: `export TOKEN=${SECRET}`, exitCode: 1, output: `${'n'.repeat(5000)}\nError: ${SECRET}` },
      ],
    });
    expect(system!.content).toContain('Shell: zsh');
    expect(system!.content).toContain('Current directory: ~/proj');
    expect(system!.content).toContain('macOS (darwin 25, arm64)');
    expect(user!.content).not.toContain(SECRET);
    expect(user!.content).not.toContain('$ old'); // only the last three
    expect(user!.content).toContain('(exit 1)');
    // Output is cut to its tail.
    expect(user!.content.length).toBeLessThan(3 * ASSIST_BLOCK_OUTPUT_CHARS + 600);
  });
});

describe('terminal assist — what comes back', () => {
  it('reads JSON, fenced JSON, a code block, or a bare line', () => {
    expect(parseAssistReply('{"command":"ls -la","explanation":"Lists files.","risky":false}')).toEqual({ command: 'ls -la', explanation: 'Lists files.', risky: false });
    expect(parseAssistReply('Sure!\n```json\n{"command": "$ du -sh *", "risky": true}\n```')).toEqual({ command: 'du -sh *', explanation: null, risky: true });
    expect(parseAssistReply('Try:\n```bash\nfind . -name "*.log"\n```')).toEqual({ command: 'find . -name "*.log"', explanation: null, risky: false });
    expect(parseAssistReply('`git status`')).toEqual({ command: 'git status', explanation: null, risky: false });
    expect(parseAssistReply('   ')).toBeNull();
    // Control characters (a forged escape sequence) never reach the editor.
    expect(parseAssistReply('{"command":"echo \\u001b[31mhi\\u202e"}')!.command).toBe('echo [31mhi');
  });

  it('flags destructive commands on its own', () => {
    for (const cmd of ['rm -rf build', 'git push --force origin main', 'git reset --hard HEAD~1', 'sudo launchctl', 'curl -fsSL x | sh', 'find . -delete', 'psql -c "DROP TABLE users"']) {
      expect(isRiskyCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ['ls -la', 'git status', 'npm test', 'rmdir empty', 'echo "rm"']) {
      expect(isRiskyCommand(cmd), cmd).toBe(false);
    }
  });
});

describe('terminal assist — which model', () => {
  const ctx = { request: 'list big files', cwd: '/w', shell: 'zsh', blocks: [] };

  it('asks the local model first and never Grok when it answers', async () => {
    const local = model('{"command":"du -ah . | sort -h | tail"}');
    const grok = model('{"command":"nope"}', 'grok:grok-4');
    const res = await runTerminalAssist(CFG, ctx, 'auto', { local: async () => local.call, grok: async () => grok.call });
    expect(res).toEqual({ command: 'du -ah . | sort -h | tail', explanation: null, provider: 'local:qwen', risky: false });
    expect(grok.seen).toHaveLength(0);
  });

  it('auto: no local model → Grok when configured; local: never Grok', async () => {
    const grok = model('{"command":"rm -rf dist","risky":false}', 'grok:grok-4');
    const res = await runTerminalAssist(CFG, ctx, 'auto', { local: async () => null, grok: async () => grok.call });
    expect(res.provider).toBe('grok:grok-4');
    expect(res.risky).toBe(true); // the server's own check
    await expect(runTerminalAssist(CFG, ctx, 'local', { local: async () => null, grok: async () => grok.call }))
      .rejects.toMatchObject({ code: 'ASSIST_NO_MODEL' });
    expect(grok.seen).toHaveLength(1);
  });

  it('a local model that errors falls through to Grok in auto; with nothing left it is ASSIST_FAILED', async () => {
    const failing: AssistModelCall = async () => { throw new Error('boom'); };
    const grok = model('{"command":"ls"}', 'grok:grok-4');
    expect((await runTerminalAssist(CFG, ctx, 'auto', { local: async () => failing, grok: async () => grok.call })).command).toBe('ls');
    await expect(runTerminalAssist(CFG, ctx, 'auto', { local: async () => failing, grok: async () => null })).rejects.toMatchObject({ code: 'ASSIST_FAILED' });
  });

  it('off calls nothing; an empty answer is ASSIST_EMPTY', async () => {
    let asked = false;
    const probe = async () => { asked = true; return null; };
    await expect(runTerminalAssist(CFG, ctx, 'off', { local: probe, grok: probe })).rejects.toBeInstanceOf(TerminalAssistError);
    expect(asked).toBe(false);
    const empty = model('   ');
    await expect(runTerminalAssist(CFG, ctx, 'local', { local: async () => empty.call })).rejects.toMatchObject({ code: 'ASSIST_EMPTY' });
  });
});

// ---------------------------------------------------------------------------
// The multiplexed stream: request and frame formats
// ---------------------------------------------------------------------------

describe('multiplexed stream — formats', () => {
  it('parses `tabs=id:seq,…` strictly', () => {
    expect(parseMuxTabs('/api/verse/terminal/stream?tabs=t-abc:5,t-def')).toEqual([['t-abc', 5], ['t-def', 0]]);
    expect(parseMuxTabs('/x?tabs=t-abc%3A5%2Ct-def%3A2')).toEqual([['t-abc', 5], ['t-def', 2]]);
    // A repeat keeps the last cursor, once.
    expect(parseMuxTabs('/x?tabs=t-a:1,t-a:3')).toEqual([['t-a', 3]]);
    for (const bad of ['/x', '/x?tabs=', '/x?tabs=nope', '/x?tabs=t-a:-1', '/x?tabs=t-a:1&tabs=t-b', '/x?tabs=t-a:1x', '/x?tabs=../etc']) {
      expect(() => parseMuxTabs(bad), bad).toThrow();
    }
    const nine = Array.from({ length: 9 }, (_, i) => `t-${i}`).join(',');
    expect(() => parseMuxTabs(`/x?tabs=${nine}`)).toThrow(/at most/);
  });

  it('tags every frame with its tab; output bytes are raw, the rest scrubbed', () => {
    const out = formatTerminalMuxFrame('t-a', { type: 'output', seq: 3, dataBase64: 'aGk=' });
    expect(out).toBe('event: output\ndata: {"tab":"t-a","type":"output","seq":3,"dataBase64":"aGk="}\n\n');
    const cwd = formatTerminalMuxFrame('t-a', { type: 'cwd', cwd: path.join(os.homedir(), 'p') });
    expect(cwd).toContain('"cwd":"~/p"');
    expect(formatTerminalMuxFrame('t-b', { type: 'gone' })).toBe('event: gone\ndata: {"tab":"t-b","type":"gone"}\n\n');
  });
});
