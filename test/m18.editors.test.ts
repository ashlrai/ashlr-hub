/**
 * M18 — hermetic editor MCP registration tests.
 *
 * These tests never invoke a vendor CLI or touch a real user registry. Codex
 * command execution is injected; Claude and Cursor use isolated JSON files.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import {
  ASHLR_HUB_MCP_SERVER,
  detectEditors,
  setEditorConfigTestHooksForTests,
  terminateWindowsProcessTreeForTests,
  wireEditor,
  type WireEditorOptions,
} from '../src/core/integrations/editors.js';
import { cmdWire } from '../src/cli/wire.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-editors-'));
  tempRoots.push(root);
  return root;
}

function jsonConfig(name: string, value: unknown): string {
  const configPath = path.join(tempRoot(), name);
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return configPath;
}

function readJson(configPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
}

type Runner = NonNullable<WireEditorOptions['runCommand']>;
type RunnerResult = Awaited<ReturnType<Runner>>;

interface CapturedCall {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function result(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return { ok: false, code: 1, stdout: '', stderr: '', ...overrides };
}

function codexEntry(command = 'ashlr', args = ['mcp']): RunnerResult {
  return result({
    ok: true,
    code: 0,
    stdout: JSON.stringify({
      name: ASHLR_HUB_MCP_SERVER,
      enabled: true,
      transport: { type: 'stdio', command, args, env: null },
    }),
  });
}

type AdversarialCodexMode = 'timeout' | 'stdout' | 'stderr';

function installTermIgnoringCodex(root: string, mode: AdversarialCodexMode): {
  scriptPath: string;
  mutationPath: string;
} {
  const scriptPath = path.join(root, 'term-ignoring-codex.cjs');
  const mutationPath = path.join(root, 'late-mutation');
  fs.writeFileSync(path.join(root, 'mode'), mode, 'utf8');
  const source = `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (process.argv.includes('get')) {
  process.stderr.write("Error: No MCP server named '${ASHLR_HUB_MCP_SERVER}' found.\\n");
  process.exit(1);
}

process.on('SIGTERM', () => {});
const mutationPath = path.join(process.env.CODEX_HOME, 'late-mutation');
const mutate = () => fs.writeFileSync(mutationPath, 'mutation after reported failure\\n');
const helperSource = [
  "const fs = require('node:fs');",
  "process.on('SIGTERM', () => {});",
  "setTimeout(() => fs.writeFileSync(" + JSON.stringify(mutationPath) + ", 'helper mutation after reported failure\\\\n'), 400);",
  "if (process.send) process.send('ready');",
  "setInterval(() => {}, 1000);",
].join('\\n');
const helper = spawn(process.execPath, ['-e', helperSource], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
helper.once('message', () => {
  setTimeout(mutate, 400);
  const mode = fs.readFileSync(path.join(process.env.CODEX_HOME, 'mode'), 'utf8');
  if (mode === 'stdout' || mode === 'stderr') {
    process[mode].write(Buffer.alloc(300 * 1024, 'x'));
  }
});
setInterval(() => {}, 1000);
`;
  fs.writeFileSync(scriptPath, source, { encoding: 'utf8', mode: 0o700 });
  return { scriptPath, mutationPath };
}

async function exerciseTermIgnoringCodex(mode: AdversarialCodexMode): Promise<{
  detail: string;
  elapsedMs: number;
  mutationPath: string;
}> {
  const root = tempRoot();
  const configPath = path.join(root, 'config.toml');
  const { scriptPath, mutationPath } = installTermIgnoringCodex(root, mode);
  setEditorConfigTestHooksForTests({
    commandExecutable: process.execPath,
    commandArgumentPrefix: [scriptPath],
    // Keep the preliminary read on the production deadline. Only the mutating
    // add command is forced into the short timeout exercised by this test.
    commandTimeoutMs: args => args[1] === 'add' && mode === 'timeout' ? 150 : 15_000,
    commandTerminationGraceMs: 50,
  });
  const started = performance.now();
  const wired = await wireEditor('codex', { configPath });
  return { detail: wired.detail, elapsedMs: performance.now() - started, mutationPath };
}

function fakeChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => true);
  return child;
}

function sequenceRunner(
  responses: RunnerResult[],
  calls: CapturedCall[] = [],
): Runner {
  return async (executable, args, options) => {
    calls.push({ executable, args, env: options.env });
    const next = responses.shift();
    if (!next) throw new Error('unexpected command invocation');
    return next;
  };
}

afterEach(() => {
  setEditorConfigTestHooksForTests();
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

describe('detectEditors', () => {
  it('returns a duplicate-free supported subset', () => {
    const editors = detectEditors();
    expect(new Set(editors).size).toBe(editors.length);
    expect(editors.every(editor => ['claude', 'codex', 'cursor'].includes(editor))).toBe(true);
  });
});

describe('Claude user registry', () => {
  it('writes the supported user-scoped ashlr-hub entry and preserves the legacy plugin', async () => {
    const original = {
      firstStartVersion: '2.1.243',
      mcpServers: {
        ashlr: { command: 'legacy-plugin', args: ['mcp'] },
        other: { command: 'other-tool' },
      },
    };
    const configPath = jsonConfig('.claude.json', original);

    const wired = await wireEditor('claude', { configPath });
    const parsed = readJson(configPath);
    const servers = parsed['mcpServers'] as Record<string, Record<string, unknown>>;

    expect(wired.ok).toBe(true);
    expect(servers['ashlr']).toEqual(original.mcpServers.ashlr);
    expect(servers['other']).toEqual(original.mcpServers.other);
    expect(servers[ASHLR_HUB_MCP_SERVER]).toEqual({
      type: 'stdio',
      command: 'ashlr',
      args: ['mcp'],
      env: {},
    });
    expect(parsed['firstStartVersion']).toBe('2.1.243');
    expect(readJson(`${configPath}.bak`)).toEqual(original);
  });

  it('is idempotent and does not rotate backups on a no-op', async () => {
    const configPath = jsonConfig('.claude.json', {});
    const first = await wireEditor('claude', { configPath });
    const afterFirst = fs.readFileSync(configPath, 'utf8');
    const second = await wireEditor('claude', { configPath });
    const backupNames = fs.readdirSync(path.dirname(configPath))
      .filter(name => name.startsWith('.claude.json.bak'));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.detail).toContain('already wired');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(afterFirst);
    expect(backupNames).toEqual(['.claude.json.bak']);
  });

  it('rotates an existing backup through private exclusive publication', async () => {
    const configPath = jsonConfig('.claude.json', { generation: 1 });
    fs.writeFileSync(`${configPath}.bak`, '{"backup":"older"}\n', 'utf8');

    const wired = await wireEditor('claude', { configPath });
    const backupNames = fs.readdirSync(path.dirname(configPath))
      .filter(name => name.startsWith('.claude.json.bak.'));

    expect(wired.ok).toBe(true);
    expect(readJson(`${configPath}.bak`)).toEqual({ generation: 1 });
    expect(backupNames).toHaveLength(1);
    expect(readJson(path.join(path.dirname(configPath), backupNames[0]!))).toEqual({ backup: 'older' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(`${configPath}.bak`).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(path.dirname(configPath), backupNames[0]!)).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed on malformed JSON without writing a backup', async () => {
    const configPath = path.join(tempRoot(), '.claude.json');
    fs.writeFileSync(configPath, '{"mcpServers":', 'utf8');
    const before = fs.readFileSync(configPath, 'utf8');

    const wired = await wireEditor('claude', { configPath });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('refusing to write');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('fails closed when mcpServers is not an object', async () => {
    const configPath = jsonConfig('.claude.json', { mcpServers: 'invalid' });
    const wired = await wireEditor('claude', { configPath });
    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('mcpServers must be a JSON object');
  });

  it('refuses to overwrite a conflicting ashlr-hub entry', async () => {
    const original = {
      mcpServers: {
        [ASHLR_HUB_MCP_SERVER]: {
          type: 'http',
          command: 'ashlr',
          args: ['mcp'],
          env: { UNEXPECTED: 'value' },
        },
      },
    };
    const configPath = jsonConfig('.claude.json', original);

    const wired = await wireEditor('claude', { configPath });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('refusing to overwrite');
    expect(readJson(configPath)).toEqual(original);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('creates a new user registry with private permissions', async () => {
    const configPath = path.join(tempRoot(), '.claude.json');
    const wired = await wireEditor('claude', { configPath });
    expect(wired.ok).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });

  it.skipIf(process.platform === 'win32')('refuses an existing symlink without touching its target', async () => {
    const root = tempRoot();
    const configPath = path.join(root, '.claude.json');
    const externalPath = path.join(root, 'external.json');
    const external = '{"external":"must-survive"}\n';
    fs.writeFileSync(externalPath, external, 'utf8');
    fs.symlinkSync(externalPath, configPath);

    const wired = await wireEditor('claude', { configPath });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('failed to read config');
    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(externalPath, 'utf8')).toBe(external);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked backup without touching its target', async () => {
    const root = tempRoot();
    const configPath = path.join(root, '.claude.json');
    const externalPath = path.join(root, 'external-backup.json');
    const original = '{"original":"must-survive"}\n';
    const external = '{"external":"must-survive"}\n';
    fs.writeFileSync(configPath, original, 'utf8');
    fs.writeFileSync(externalPath, external, 'utf8');
    fs.symlinkSync(externalPath, `${configPath}.bak`);

    const wired = await wireEditor('claude', { configPath });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('could not prepare config');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    expect(fs.lstatSync(`${configPath}.bak`).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(externalPath, 'utf8')).toBe(external);
  });

  it.skipIf(process.platform === 'win32')('refuses a user-controlled symlink in the config ancestor chain', async () => {
    const root = tempRoot();
    const realRoot = path.join(root, 'real');
    const nested = path.join(realRoot, 'nested');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(nested, { recursive: true });
    fs.symlinkSync(realRoot, alias);
    const configPath = path.join(alias, 'nested', '.claude.json');
    const original = '{"original":"must-survive"}\n';
    fs.writeFileSync(configPath, original, 'utf8');

    const wired = await wireEditor('claude', { configPath });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('user-controlled symlink');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('preserves an external replacement that lands before publication', async () => {
    const configPath = jsonConfig('.claude.json', { original: 'captured' });
    const displacedPath = `${configPath}.displaced`;
    const replacement = '{"replacement":"must-survive"}\n';
    setEditorConfigTestHooksForTests({
      beforeJsonConfigPublish: () => {
        fs.renameSync(configPath, displacedPath);
        fs.writeFileSync(configPath, replacement, 'utf8');
      },
    });

    const wired = await wireEditor('claude', { configPath });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('changed before publication');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(replacement);
    expect(readJson(displacedPath)).toEqual({ original: 'captured' });
    expect(readJson(`${configPath}.bak`)).toEqual({ original: 'captured' });
    expect(fs.readdirSync(path.dirname(configPath)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('does not follow a symlink created while a missing config is prepared', async () => {
    const root = tempRoot();
    const configPath = path.join(root, '.claude.json');
    const externalPath = path.join(root, 'external.json');
    const external = '{"external":"must-survive"}\n';
    fs.writeFileSync(externalPath, external, 'utf8');
    setEditorConfigTestHooksForTests({
      beforeJsonConfigPublish: () => fs.symlinkSync(externalPath, configPath),
    });

    const wired = await wireEditor('claude', { configPath });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('changed before publication');
    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(externalPath, 'utf8')).toBe(external);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
    expect(fs.readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('Cursor JSON registry', () => {
  it('uses the distinct ashlr-hub key without removing an ashlr entry', async () => {
    const configPath = jsonConfig('mcp.json', {
      mcpServers: { ashlr: { command: 'legacy-cursor-adapter' } },
    });

    const wired = await wireEditor('cursor', { configPath });
    const servers = readJson(configPath)['mcpServers'] as Record<string, unknown>;

    expect(wired.ok).toBe(true);
    expect(servers['ashlr']).toEqual({ command: 'legacy-cursor-adapter' });
    expect(servers[ASHLR_HUB_MCP_SERVER]).toEqual({ command: 'ashlr', args: ['mcp'] });
  });
});

describe('Codex official CLI registration', () => {
  it('uses codex mcp add, scopes it with CODEX_HOME, and verifies the result', async () => {
    const root = tempRoot();
    const configPath = path.join(root, 'config.toml');
    const calls: CapturedCall[] = [];
    const runCommand = sequenceRunner([
      result({ stderr: `Error: No MCP server named '${ASHLR_HUB_MCP_SERVER}' found.` }),
      result({ ok: true, code: 0, stdout: `Added global MCP server '${ASHLR_HUB_MCP_SERVER}'.` }),
      codexEntry(),
    ], calls);

    const wired = await wireEditor('codex', { configPath, runCommand });

    expect(wired.ok).toBe(true);
    expect(calls.map(call => call.args)).toEqual([
      ['mcp', 'get', ASHLR_HUB_MCP_SERVER, '--json'],
      ['mcp', 'add', ASHLR_HUB_MCP_SERVER, '--', 'ashlr', 'mcp'],
      ['mcp', 'get', ASHLR_HUB_MCP_SERVER, '--json'],
    ]);
    expect(calls.every(call => call.executable === 'codex')).toBe(true);
    expect(calls.every(call => call.env['CODEX_HOME'] === root)).toBe(true);
  });

  it('backs up an existing config.toml before invoking add', async () => {
    const root = tempRoot();
    const configPath = path.join(root, 'config.toml');
    const original = '[mcp_servers.existing]\ncommand = "keep-me"\n';
    fs.writeFileSync(configPath, original, 'utf8');
    const runCommand = sequenceRunner([
      result({ stderr: `Error: No MCP server named '${ASHLR_HUB_MCP_SERVER}' found.` }),
      result({ ok: true, code: 0 }),
      codexEntry(),
    ]);

    const wired = await wireEditor('codex', { configPath, runCommand });

    expect(wired.ok).toBe(true);
    expect(fs.readFileSync(`${configPath}.bak`, 'utf8')).toBe(original);
  });

  it('fails closed when codex mcp add fails', async () => {
    const root = tempRoot();
    const configPath = path.join(root, 'config.toml');
    const original = 'model = "gpt-5"\n';
    fs.writeFileSync(configPath, original, 'utf8');
    const calls: CapturedCall[] = [];
    const runCommand = sequenceRunner([
      result({ stderr: `Error: No MCP server named '${ASHLR_HUB_MCP_SERVER}' found.` }),
      result({ code: 1, stderr: 'permission denied while writing config.toml' }),
    ], calls);

    const wired = await wireEditor('codex', { configPath, runCommand });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('codex mcp add failed');
    expect(wired.detail).toContain('permission denied');
    expect(calls.map(call => call.args)).toEqual([
      ['mcp', 'get', ASHLR_HUB_MCP_SERVER, '--json'],
      ['mcp', 'add', ASHLR_HUB_MCP_SERVER, '--', 'ashlr', 'mcp'],
    ]);
    expect(fs.readFileSync(`${configPath}.bak`, 'utf8')).toBe(original);
  });

  it('fails closed when post-add verification returns a mismatched registration', async () => {
    const root = tempRoot();
    const configPath = path.join(root, 'config.toml');
    const calls: CapturedCall[] = [];
    const runCommand = sequenceRunner([
      result({ stderr: `Error: No MCP server named '${ASHLR_HUB_MCP_SERVER}' found.` }),
      result({ ok: true, code: 0 }),
      codexEntry('unexpected-command', ['mcp']),
    ], calls);

    const wired = await wireEditor('codex', { configPath, runCommand });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('could not be verified');
    expect(calls.map(call => call.args)).toEqual([
      ['mcp', 'get', ASHLR_HUB_MCP_SERVER, '--json'],
      ['mcp', 'add', ASHLR_HUB_MCP_SERVER, '--', 'ashlr', 'mcp'],
      ['mcp', 'get', ASHLR_HUB_MCP_SERVER, '--json'],
    ]);
  });

  it('is a no-op when the exact ashlr-hub registration already exists', async () => {
    const root = tempRoot();
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(configPath, '[mcp_servers.ashlr-hub]\ncommand = "ashlr"\n', 'utf8');
    const calls: CapturedCall[] = [];
    const runCommand = sequenceRunner([codexEntry()], calls);

    const wired = await wireEditor('codex', { configPath, runCommand });

    expect(wired.ok).toBe(true);
    expect(wired.detail).toContain('already wired');
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('refuses to overwrite a conflicting ashlr-hub registration', async () => {
    const configPath = path.join(tempRoot(), 'config.toml');
    const calls: CapturedCall[] = [];
    const runCommand = sequenceRunner([codexEntry('different-command')], calls);

    const wired = await wireEditor('codex', { configPath, runCommand });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('already exists with a different');
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('refuses to call add when Codex reports malformed TOML', async () => {
    const configPath = path.join(tempRoot(), 'config.toml');
    fs.writeFileSync(configPath, 'not = [valid', 'utf8');
    const calls: CapturedCall[] = [];
    const runCommand = sequenceRunner([
      result({ stderr: 'Error loading config.toml: TOML parse error at line 1' }),
    ], calls);

    const wired = await wireEditor('codex', { configPath, runCommand });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('refusing to write');
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('fails closed on a generic Codex registry read failure', async () => {
    const configPath = path.join(tempRoot(), 'config.toml');
    fs.writeFileSync(configPath, 'model = "gpt-5"\n', 'utf8');
    const calls: CapturedCall[] = [];
    const runCommand = sequenceRunner([
      result({ stderr: 'permission denied while reading credential store' }),
    ], calls);

    const wired = await wireEditor('codex', { configPath, runCommand });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('refusing to write');
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('reports CLI launch failure without touching the config', async () => {
    const configPath = path.join(tempRoot(), 'config.toml');
    fs.writeFileSync(configPath, 'model = "gpt-5"\n', 'utf8');
    const runCommand = sequenceRunner([
      result({ code: null, launchError: 'ENOENT' }),
    ]);

    const wired = await wireEditor('codex', { configPath, runCommand });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('Codex CLI unavailable');
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'does not report timeout while a TERM-ignoring process tree can still mutate',
    async () => {
      const failed = await exerciseTermIgnoringCodex('timeout');

      expect(failed.detail).toContain('codex mcp add failed: command timed out after 15 seconds');
      expect(failed.elapsedMs).toBeLessThan(2_000);
      await new Promise(resolve => setTimeout(resolve, 550));
      expect(fs.existsSync(failed.mutationPath)).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32').each(['stdout', 'stderr'] as const)(
    'does not report $0 overflow while a TERM-ignoring process tree can still mutate',
    async (stream) => {
      const failed = await exerciseTermIgnoringCodex(stream);

      expect(failed.detail).toContain('codex mcp add failed: command output exceeded 256 KiB safety limit');
      expect(failed.elapsedMs).toBeLessThan(2_000);
      await new Promise(resolve => setTimeout(resolve, 550));
      expect(fs.existsSync(failed.mutationPath)).toBe(false);
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not report timeout while a Windows descendant tree can still mutate',
    async () => {
      const failed = await exerciseTermIgnoringCodex('timeout');

      expect(failed.detail).toContain('codex mcp add failed: command timed out after 15 seconds');
      expect(failed.elapsedMs).toBeLessThan(5_000);
      await new Promise(resolve => setTimeout(resolve, 550));
      expect(fs.existsSync(failed.mutationPath)).toBe(false);
    },
  );

  it.runIf(process.platform === 'win32').each(['stdout', 'stderr'] as const)(
    'does not report $0 overflow while a Windows descendant tree can still mutate',
    async (stream) => {
      const failed = await exerciseTermIgnoringCodex(stream);

      expect(failed.detail).toContain('codex mcp add failed: command output exceeded 256 KiB safety limit');
      expect(failed.elapsedMs).toBeLessThan(5_000);
      await new Promise(resolve => setTimeout(resolve, 550));
      expect(fs.existsSync(failed.mutationPath)).toBe(false);
    },
  );

  it('invokes taskkill with an argument-safe exact PID and reports non-zero completion', async () => {
    const killer = fakeChildProcess();
    const calls: Array<{ executable: string; args: readonly string[]; options: unknown }> = [];
    const completion = terminateWindowsProcessTreeForTests(4242, (executable, args, options) => {
      calls.push({ executable, args, options });
      queueMicrotask(() => killer.emit('close', 5, null));
      return killer;
    }, 100);

    await expect(completion).resolves.toEqual({
      ok: false,
      detail: 'taskkill.exe exited with code 5',
    });
    expect(calls).toEqual([{
      executable: 'taskkill.exe',
      args: ['/PID', '4242', '/T', '/F'],
      options: { shell: false, stdio: 'ignore', windowsHide: true },
    }]);
  });

  it('bounds a stuck taskkill attempt and kills the stuck taskkill process', async () => {
    const killer = fakeChildProcess();

    await expect(terminateWindowsProcessTreeForTests(
      4242,
      () => killer,
      10,
    )).resolves.toEqual({
      ok: false,
      detail: 'taskkill.exe timed out after 10 ms',
    });
    expect(killer.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('preserves the initiating failure and marks failed Windows tree teardown unconfirmed', async () => {
    const root = tempRoot();
    const configPath = path.join(root, 'config.toml');
    const scriptPath = path.join(root, 'stuck-codex.cjs');
    fs.writeFileSync(scriptPath, `
if (process.argv.includes('get')) {
  process.stderr.write("Error: No MCP server named '${ASHLR_HUB_MCP_SERVER}' found.\\n");
  process.exit(1);
}
setInterval(() => {}, 1000);
`, 'utf8');
    const killer = fakeChildProcess();
    setEditorConfigTestHooksForTests({
      commandPlatform: 'win32',
      commandExecutable: process.execPath,
      commandArgumentPrefix: [scriptPath],
      commandTimeoutMs: args => args[1] === 'add' ? 25 : 15_000,
      spawnWindowsTreeKiller: () => {
        queueMicrotask(() => killer.emit('close', 5, null));
        return killer;
      },
    });

    const wired = await wireEditor('codex', { configPath });

    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain(
      'codex mcp add failed: command timed out after 15 seconds; ' +
      'Windows process-tree teardown unconfirmed: taskkill.exe exited with code 5',
    );
  });

  it('requires configPath overrides to target config.toml', async () => {
    const runCommand = sequenceRunner([]);
    const wired = await wireEditor('codex', {
      configPath: path.join(tempRoot(), 'config.json'),
      runCommand,
    });
    expect(wired.ok).toBe(false);
    expect(wired.detail).toContain('must end in config.toml');
  });
});

describe('wire CLI target-specific config safety', () => {
  it('rejects --config unless exactly one target is explicit', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await cmdWire(['all', '--config', '/tmp/shared-config'])).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('--config requires exactly one explicit target'));
    } finally {
      stderr.mockRestore();
    }
  });
});
