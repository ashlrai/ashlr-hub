/**
 * 3.15 — the generated shell-integration scripts, run by the REAL shells.
 *
 * The unit tests (verse-terminal-blocks-315) feed recorded bytes; this runs
 * /bin/zsh and /bin/bash (macOS ships bash 3.2 — the oldest we must support)
 * on the scripts, in a throwaway HOME with its own dotfiles, and cuts their
 * output into blocks with the real tracker. No PTY under Node: `-i` makes the
 * shell interactive over pipes, which runs the same precmd/preexec (zsh) and
 * PROMPT_COMMAND/DEBUG (bash) hooks a PTY session does.
 *
 * Proves: the user's own startup files still load (and the right ones for a
 * login shell), our variables are gone from the user's environment
 * (nonce unset, ZDOTDIR restored), and every command becomes a block with its
 * command line, exit code and output.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureIntegrationFiles, integratedLaunch, type IntegratedShell } from '../src/core/verse/shell-integration.js';
import { createBlockTracker, terminalBytesToText } from '../src/core/verse/terminal-blocks.js';

const NONCE = '0123456789abcdef01234567';

let home: string;
let dir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-si-home-'));
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-si-dir-')), 'v1');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

async function runShell(shell: string, kind: IntegratedShell, script: string, userEnv: Record<string, string> = {}): Promise<Buffer> {
  await ensureIntegrationFiles(dir, kind);
  const launch = integratedLaunch(shell, dir, NONCE, userEnv)!;
  // Long options first (bash refuses `-i --init-file`).
  const argv = [...launch.argv.slice(1), '-i'];
  const child = spawn(launch.argv[0]!, argv, {
    cwd: home,
    env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb', LANG: 'en_US.UTF-8', ...userEnv, ...launch.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (d: Buffer) => chunks.push(d));
  child.stderr.on('data', (d: Buffer) => chunks.push(d));
  child.stdin.end(script);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('shell did not exit')); }, 20_000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  return Buffer.concat(chunks);
}

function blocksOf(bytes: Buffer) {
  const tracker = createBlockTracker({ tabId: 't-x', nonce: NONCE });
  // Arbitrary chunking: marks straddle chunk edges in real life.
  for (let i = 0; i < bytes.length; i += 7) tracker.feed(bytes.subarray(i, i + 7), 1 + Math.floor(i / 7));
  tracker.close();
  return tracker.list().map((b) => ({ ...b, text: terminalBytesToText(tracker.output(b.id)!.bytes) }));
}

describe.skipIf(!fs.existsSync('/bin/zsh'))('zsh', () => {
  it('loads the user\'s .zshenv and .zshrc, restores ZDOTDIR, unsets the nonce, and marks every command', async () => {
    fs.writeFileSync(path.join(home, '.zshenv'), 'export FROM_ZSHENV=1\n');
    fs.writeFileSync(path.join(home, '.zshrc'), 'export FROM_ZSHRC=1\nPS1="mine%# "\n');
    const out = await runShell('/bin/zsh', 'zsh', [
      'echo "semi;colon" $FROM_ZSHENV$FROM_ZSHRC',
      'false',
      'echo zd=${ZDOTDIR-unset} n=${ASHLR_SHELL_NONCE-unset}',
      'cd /',
      'exit 0',
      '',
    ].join('\n'));
    const blocks = blocksOf(out);
    expect(blocks.map((b) => [b.command, b.exitCode])).toEqual([
      ['echo "semi;colon" $FROM_ZSHENV$FROM_ZSHRC', 0],
      ['false', 1],
      ['echo zd=${ZDOTDIR-unset} n=${ASHLR_SHELL_NONCE-unset}', 0],
      ['cd /', 0],
      ['exit 0', null],
    ]);
    expect(blocks[0]!.text).toBe('semi;colon 11');
    expect(blocks[2]!.text).toBe('zd=unset n=unset');
    expect(blocks[3]!.cwd).toBe(fs.realpathSync(home));
  }, 30_000);

  it('a user who keeps their files in their own ZDOTDIR still gets them', async () => {
    const own = path.join(home, '.config', 'zsh');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, '.zshrc'), 'export FROM_OWN=1\n');
    const out = await runShell('/bin/zsh', 'zsh', 'echo own=$FROM_OWN zd=$ZDOTDIR\nexit\n', { ZDOTDIR: own });
    const [first] = blocksOf(out);
    expect(first!.text).toBe(`own=1 zd=${own}`);
  }, 30_000);
});

describe.skipIf(!fs.existsSync('/bin/bash'))('bash', () => {
  it('reads what a login shell reads (.bash_profile), unsets the nonce, and marks every command with its full line', async () => {
    fs.writeFileSync(path.join(home, '.bash_profile'), 'export FROM_PROFILE=1\nPS1="mine$ "\n');
    fs.writeFileSync(path.join(home, '.bashrc'), 'export FROM_BASHRC=1\n');
    const out = await runShell('/bin/bash', 'bash', [
      'echo a; echo b $FROM_PROFILE${FROM_BASHRC-}',
      'ls /definitely-not-here',
      'echo n=${ASHLR_SHELL_NONCE-unset}',
      'exit',
      '',
    ].join('\n'));
    const blocks = blocksOf(out);
    expect(blocks.map((b) => [b.command, b.exitCode])).toEqual([
      ['echo a; echo b $FROM_PROFILE${FROM_BASHRC-}', 0],
      ['ls /definitely-not-here', expect.any(Number)],
      ['echo n=${ASHLR_SHELL_NONCE-unset}', 0],
      ['exit', null],
    ]);
    // .bash_profile, not .bashrc: exactly what `bash -l` would have read.
    expect(blocks[0]!.text).toBe('a\nb 1');
    expect(blocks[1]!.exitCode).not.toBe(0);
    expect(blocks[1]!.text).toContain('definitely-not-here');
    expect(blocks[2]!.text).toBe('n=unset');
  }, 30_000);

  it('keeps the user\'s PROMPT_COMMAND running', async () => {
    fs.writeFileSync(path.join(home, '.bash_profile'), 'PROMPT_COMMAND="echo -n PC; "\n');
    const out = await runShell('/bin/bash', 'bash', 'true\nexit\n');
    expect(out.toString()).toContain('PC');
    expect(blocksOf(out)[0]).toMatchObject({ command: 'true', exitCode: 0 });
  }, 30_000);
});
