/**
 * 3.11 cloud lane — PTY launcher and output parser (src/core/cloud/launcher.ts).
 *
 * The parser runs against real captured output (Claude Code 2.1.280, the
 * samples in types.ts and SPEC.md). Launches use an injected runner: no
 * claude, no script(1), nothing paid is ever started. HOME is relocated per
 * test for the seat command.json reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  cloudLaunchEnv,
  cloudPtyArgv,
  cloudSeatCommandPath,
  launchCloudSession,
  parseCloudLaunchOutput,
  readCloudSeatArgv,
  shellQuote,
  stripTerminalSequences,
  trustCloudCheckoutFolder,
} from '../src/core/cloud/launcher.js';
import { cloudHome } from '../src/core/cloud/store.js';

/** As captured from `script -q /dev/null claude --cloud …`: colour, a cursor-hide, an OSC 8 hyperlink and CRLF endings. */
const SUCCESS_RAW = [
  '\u001b[?25l\u001b[32m✓\u001b[39m Created cloud session: Fix the flaky tracker test\r\n',
  'View: \u001b]8;;https://claude.ai/code/session_01AbCdEf9XyZ?from=cli&m=0\u0007https://claude.ai/code/session_01AbCdEf9XyZ?from=cli&m=0\u001b]8;;\u0007\r\n',
  'Resume with: \u001b[1mclaude --teleport session_01AbCdEf9XyZ\u001b[22m\r\n',
  '\u001b[?25h',
].join('');

const AUTH_RAW = '\u001b[31mError: Claude Code cloud sessions require authentication with a Claude.ai account. API key authentication is not sufficient. Please run /login to authenticate…\u001b[39m\r\n';

let home: string;
let savedHome: string | undefined;
let savedAshlrHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
  savedAshlrHome = process.env['ASHLR_HOME'];
  delete process.env['ASHLR_HOME'];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-launcher-')));
  process.env['HOME'] = home;
});

afterEach(() => {
  process.env['HOME'] = savedHome;
  if (savedAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = savedAshlrHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeSeatCommand(content: string): void {
  const file = cloudSeatCommandPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}

describe('parseCloudLaunchOutput', () => {
  it('parses the real success output', () => {
    expect(parseCloudLaunchOutput(SUCCESS_RAW)).toEqual({
      ok: true,
      sessionId: 'session_01AbCdEf9XyZ',
      url: 'https://claude.ai/code/session_01AbCdEf9XyZ?from=cli&m=0',
      title: 'Fix the flaky tracker test',
    });
  });

  it('parses the plain three lines from types.ts', () => {
    const plain = 'Created cloud session: Tidy docs\nView: https://claude.ai/code/session_abc123?from=cli&m=0\nResume with: claude --teleport session_abc123\n';
    expect(parseCloudLaunchOutput(plain)).toMatchObject({ ok: true, sessionId: 'session_abc123', title: 'Tidy docs' });
  });

  it('falls back to the teleport id when the View line is missing', () => {
    expect(parseCloudLaunchOutput('Created cloud session: T\nResume with: claude --teleport session_zz9\n'))
      .toEqual({ ok: true, sessionId: 'session_zz9', url: 'https://claude.ai/code/session_zz9', title: 'T' });
  });

  it('classifies the real auth error', () => {
    const res = parseCloudLaunchOutput(AUTH_RAW);
    expect(res).toMatchObject({ ok: false, failure: 'auth' });
    if (!res.ok) expect(res.message).toMatch(/Claude\.ai account/);
  });

  it.each([
    ['Error: Cloud sessions are not enabled for your account.', 'not-enabled'],
    ['Error: You have hit your usage limit. Try again later.', 'rate-limited'],
    ['API Error: rate limit exceeded', 'rate-limited'],
    ['You are out of credits.', 'rate-limited'],
    ['fatal: not a git repository (or any of the parent directories): .git', 'no-remote'],
    ['Error: no remote configured for this repository', 'no-remote'],
    ['Error: the current branch must be pushed to origin first', 'no-remote'],
  ])('classifies %j as %s', (text, failure) => {
    expect(parseCloudLaunchOutput(`\u001b[31m${text}\u001b[0m\r\n`)).toMatchObject({ ok: false, failure });
  });

  it('marks other errors unknown with the CLI\'s words, machine paths removed', () => {
    const res = parseCloudLaunchOutput('Error: EACCES opening /Users/mason/.ashlr/native-profiles/claude-a/x\n');
    expect(res).toMatchObject({ ok: false, failure: 'unknown' });
    if (!res.ok) {
      expect(res.message).toContain('EACCES');
      expect(res.message).not.toContain('/Users/mason');
    }
  });

  it('marks unrecognised non-error output unparsed, and empty output unknown', () => {
    expect(parseCloudLaunchOutput('Welcome to Claude Code!\n')).toMatchObject({ ok: false, failure: 'unparsed' });
    expect(parseCloudLaunchOutput('Created cloud session: but no id\n')).toMatchObject({ ok: false, failure: 'unparsed' });
    expect(parseCloudLaunchOutput('\u001b[?25l\u001b[?25h')).toMatchObject({ ok: false, failure: 'unknown' });
  });
});

describe('stripTerminalSequences', () => {
  it('removes CSI, OSC (BEL and ST forms), bare escapes and stray control bytes', () => {
    expect(stripTerminalSequences('\u001b[1;31mred\u001b[0m \u001b]0;title\u001b\\ok\u001b7\u0008!\r\n')).toBe('red ok!\n');
  });
});

describe('seat argv', () => {
  it('reads the claude-a command.json argv', () => {
    expect(readCloudSeatArgv()).toBeNull();
    writeSeatCommand(JSON.stringify(['/usr/local/bin/node', '/Users/x/.ashlr/native-profiles/claude-a/launcher.mjs']));
    expect(readCloudSeatArgv()).toEqual(['/usr/local/bin/node', '/Users/x/.ashlr/native-profiles/claude-a/launcher.mjs']);
    expect(cloudSeatCommandPath()).toBe(path.join(home, '.ashlr', 'native-profiles', 'claude-a', 'command.json'));
  });

  it.each([
    ['not json', '{'],
    ['a shell string', JSON.stringify('node launcher.mjs')],
    ['an empty array', '[]'],
    ['a non-string element', JSON.stringify(['node', 3])],
    ['an empty element', JSON.stringify(['node', ''])],
  ])('refuses %s', (_label, content) => {
    writeSeatCommand(content);
    expect(readCloudSeatArgv()).toBeNull();
  });
});

describe('cloudPtyArgv', () => {
  const seat = ['/opt/node', '/p/launcher.mjs'];
  const prompt = "Fix it's \"quoted\" $(rm -rf ~) `x`\nsecond line";

  it('on macOS passes the prompt as ONE argv element after --cloud, with no shell', () => {
    expect(cloudPtyArgv(seat, prompt, 'darwin')).toEqual(['/usr/bin/script', '-q', '/dev/null', '/opt/node', '/p/launcher.mjs', '--cloud', prompt]);
  });

  it('on Linux single-quotes every word into script -qec', () => {
    const argv = cloudPtyArgv(seat, prompt, 'linux')!;
    expect(argv.slice(0, 2)).toEqual(['script', '-qec']);
    expect(argv[3]).toBe('/dev/null');
    expect(argv[2]).toBe(`'/opt/node' '/p/launcher.mjs' '--cloud' ${shellQuote(prompt)}`);
  });

  it('the Linux quoting survives a real POSIX shell byte for byte', () => {
    if (process.platform === 'win32') return;
    const command = `printf '%s' ${shellQuote(prompt)}`;
    const res = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    expect(res.stdout).toBe(prompt);
  });

  it('keeps a prompt that starts with a dash from reading as an option', () => {
    expect(cloudPtyArgv(seat, '--help me', 'darwin')!.at(-1)).toBe(' --help me');
  });

  it('has no form for other platforms', () => {
    expect(cloudPtyArgv(seat, 'x', 'win32')).toBeNull();
  });
});

describe('cloudLaunchEnv', () => {
  it('keeps only the native launcher\'s variables plus the PTY basics', () => {
    const env = cloudLaunchEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-secret', ASHLR_VERSE_TOKEN: 't', LANG: 'en_US.UTF-8' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'en_US.UTF-8', SHELL: '/bin/sh', TERM: 'xterm-256color' });
  });
});

describe('launchCloudSession', () => {
  const seatArgv = (): string[] => ['/opt/node', '/p/launcher.mjs'];

  it('runs the PTY argv in the checkout with the timeout and parses the session', async () => {
    const calls: Array<{ argv: string[]; cwd: string; timeoutMs: number }> = [];
    const res = await launchCloudSession({ cwd: '/tmp/co', prompt: 'Do it' }, {
      seatArgv, platform: 'darwin', timeoutMs: 1234,
      run: async (argv, opts) => { calls.push({ argv, ...opts }); return { output: SUCCESS_RAW, code: 0, timedOut: false }; },
    });
    expect(res).toMatchObject({ ok: true, sessionId: 'session_01AbCdEf9XyZ' });
    expect(calls).toEqual([{ argv: ['/usr/bin/script', '-q', '/dev/null', '/opt/node', '/p/launcher.mjs', '--cloud', 'Do it'], cwd: '/tmp/co', timeoutMs: 1234 }]);
  });

  it('reports seat-unavailable without spawning when there is no seat argv', async () => {
    let ran = false;
    const res = await launchCloudSession({ cwd: '/tmp', prompt: 'x' }, { seatArgv: () => null, run: async () => { ran = true; return { output: '', code: 0, timedOut: false }; } });
    expect(res).toEqual({ ok: false, failure: 'seat-unavailable', message: "The Claude seat isn't set up on this Mac." });
    expect(ran).toBe(false);
  });

  it('reads the real seat command.json by default', async () => {
    writeSeatCommand(JSON.stringify(['/opt/node', '/p/launcher.mjs']));
    let seen: string[] = [];
    await launchCloudSession({ cwd: '/tmp', prompt: 'x' }, { platform: 'linux', run: async (argv) => { seen = argv; return { output: SUCCESS_RAW, code: 0, timedOut: false }; } });
    expect(seen[2]).toBe(`'/opt/node' '/p/launcher.mjs' '--cloud' 'x'`);
  });

  it('maps a timeout with no session to timeout, but keeps a session printed before the hang', async () => {
    const timedOut = await launchCloudSession({ cwd: '/tmp', prompt: 'x' }, { seatArgv, platform: 'darwin', timeoutMs: 90_000, run: async () => ({ output: 'Connecting…', code: null, timedOut: true }) });
    expect(timedOut).toMatchObject({ ok: false, failure: 'timeout' });
    if (!timedOut.ok) expect(timedOut.message).toContain('90 seconds');
    const printed = await launchCloudSession({ cwd: '/tmp', prompt: 'x' }, { seatArgv, platform: 'darwin', run: async () => ({ output: SUCCESS_RAW, code: null, timedOut: true }) });
    expect(printed).toMatchObject({ ok: true });
    const auth = await launchCloudSession({ cwd: '/tmp', prompt: 'x' }, { seatArgv, platform: 'darwin', run: async () => ({ output: AUTH_RAW, code: null, timedOut: true }) });
    expect(auth).toMatchObject({ ok: false, failure: 'auth' });
  });

  it('classifies a non-zero exit from its output, and survives a throwing runner', async () => {
    expect(await launchCloudSession({ cwd: '/tmp', prompt: 'x' }, { seatArgv, platform: 'darwin', run: async () => ({ output: AUTH_RAW, code: 1, timedOut: false }) }))
      .toMatchObject({ ok: false, failure: 'auth' });
    expect(await launchCloudSession({ cwd: '/tmp', prompt: 'x' }, { seatArgv, platform: 'darwin', run: async () => { throw new Error('boom'); } }))
      .toMatchObject({ ok: false, failure: 'unknown' });
  });

  it('refuses an empty prompt and an unsupported platform', async () => {
    expect(await launchCloudSession({ cwd: '/tmp', prompt: '  ' }, { seatArgv })).toMatchObject({ ok: false, failure: 'unknown' });
    expect(await launchCloudSession({ cwd: '/tmp', prompt: 'x' }, { seatArgv, platform: 'win32' })).toMatchObject({ ok: false, failure: 'unknown' });
  });

  it('the default runner enforces the timeout and kills the process group (fake seat, no claude)', async () => {
    if (process.platform !== 'linux' || spawnSync('script', ['--version']).status !== 0) return;
    // The "seat" is a shell that starts a grandchild sleeper; the timeout must take both down.
    const marker = path.join(home, 'survivor');
    const res = await launchCloudSession({ cwd: home, prompt: 'x' }, {
      seatArgv: () => ['/bin/sh', '-c', `(sleep 3; touch ${marker}) & sleep 30`, 'sh'],
      timeoutMs: 500,
    });
    expect(res).toMatchObject({ ok: false, failure: 'timeout' });
    await new Promise((r) => setTimeout(r, 3_500));
    expect(fs.existsSync(marker)).toBe(false);
  }, 10_000);

  it('the default runner captures the PTY output of a fake seat that prints a session', async () => {
    if (process.platform !== 'linux' || spawnSync('script', ['--version']).status !== 0) return;
    const res = await launchCloudSession({ cwd: home, prompt: 'Tidy docs' }, {
      // `sh -c '…' sh --cloud <prompt>`: $2 is the prompt, proving it arrives as one argument.
      seatArgv: () => ['/bin/sh', '-c', 'printf "Created cloud session: %s\\nView: https://claude.ai/code/session_fake1\\nResume with: claude --teleport session_fake1\\n" "$2"', 'sh'],
      timeoutMs: 5_000,
    });
    expect(res).toEqual({ ok: true, sessionId: 'session_fake1', url: 'https://claude.ai/code/session_fake1', title: 'Tidy docs' });
  }, 10_000);
});

describe('trustCloudCheckoutFolder', () => {
  function seatWithConfig(config: unknown): string {
    const state = path.join(home, '.ashlr', 'native-profiles', 'claude-a', 'native-state');
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(path.dirname(state), 'profile.json'), JSON.stringify({ nativeStatePath: state }));
    const configPath = path.join(state, '.claude.json');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    return configPath;
  }

  it('marks a Verse checkout trusted without disturbing the rest of the config', () => {
    const configPath = seatWithConfig({ theme: 'dark', projects: { '/elsewhere': { hasTrustDialogAccepted: true, x: 1 } } });
    const folder = path.join(cloudHome(), 'checkouts', 'ashlrai__ashlr-hub');
    trustCloudCheckoutFolder(folder);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(after.theme).toBe('dark');
    expect(after.projects['/elsewhere']).toEqual({ hasTrustDialogAccepted: true, x: 1 });
    expect(after.projects[folder]).toEqual({ hasTrustDialogAccepted: true });
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('never trusts a folder outside the cloud checkouts root', () => {
    const configPath = seatWithConfig({ projects: {} });
    trustCloudCheckoutFolder(path.join(home, 'Desktop', 'some-repo'));
    trustCloudCheckoutFolder(path.join(cloudHome(), 'checkouts-evil', 'x'));
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).projects).toEqual({});
  });

  it('is a silent no-op without a seat profile or with an unreadable config', () => {
    expect(() => trustCloudCheckoutFolder(path.join(cloudHome(), 'checkouts', 'a__b'))).not.toThrow();
    const configPath = seatWithConfig({});
    fs.writeFileSync(configPath, '{not json');
    expect(() => trustCloudCheckoutFolder(path.join(cloudHome(), 'checkouts', 'a__b'))).not.toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{not json');
  });
});
