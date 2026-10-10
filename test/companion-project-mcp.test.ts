import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverCompanionProjectMcp, companionProjectRuntime } from '../src/core/integrations/companion-project-mcp.js';
import { lexiconServerSpec } from '../src/core/integrations/lexicon-mcp.js';
import { cmdMcp } from '../src/cli/mcp.js';
import { probeServer } from '../src/core/mcp-gateway.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({ config: vi.fn(() => { throw new Error('HOME config must not be read'); }),
  inventory: vi.fn(() => { throw new Error('HOME inventory must not be read'); }) }));
vi.mock('../src/core/config.js', async original => ({ ...await original<typeof import('../src/core/config.js')>(), loadConfig: mocks.config }));
vi.mock('../src/core/tools-registry.js', () => ({ getToolsRegistry: mocks.inventory }));
const roots: string[] = [];
function fixture(binary = 'lexicon-mcp') {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-project-mcp-')));
  roots.push(project);
  const bin = join(project, 'bin'); mkdirSync(bin);
  mkdirSync(join(project, '.git'));
  const receipt = join(project, 'child-receipt.json');
  const command = join(bin, binary);
  const mockServer = readFileSync(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url), 'utf8');
  writeFileSync(command, '#!' + process.execPath + '\n' +
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(receipt)}, JSON.stringify({cwd:process.cwd(),env:process.env}));\n` +
    mockServer.replace(/^#![^\n]*\n/, ''), { mode: 0o755 });
  const config = join(project, '.mcp.json');
  const client = 'test-client';
  const entry = lexiconServerSpec({ projectRoot: project, client, command, launch: binary === 'lexicon' ? 'cli' : 'stdio' });
  writeFileSync(config, JSON.stringify({ mcpServers: { lexicon: entry, unrelated: { command: '/never/start/this' } } }));
  vi.stubEnv('PATH', bin);
  return { project, client, config, command, entry, receipt,
    scope: { project, client, config }, args: ['--project', project, '--client', client, '--config', config] };
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); mocks.config.mockClear(); mocks.inventory.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('explicit project/client companion consumption', () => {
  it.each(['lexicon-mcp', 'lexicon'])('discovers only matching installed %s without executing or touching trust', binary => {
    const f = fixture(binary); const registry = discoverCompanionProjectMcp(f.scope);
    expect(registry.servers).toHaveLength(1);
    expect(registry.servers[0]).toMatchObject({ name: 'lexicon', command: f.command, args: f.entry.args, env: f.entry.env });
    expect(companionProjectRuntime({ ...registry.servers[0]! })?.cwd).toBe(f.project);
    expect(JSON.stringify(registry)).not.toContain('USERPROFILE');
    expect(existsSync(f.receipt)).toBe(false); expect(existsSync(join(f.project, '.phantom'))).toBe(false);
  });
  it.each(['command', 'args', 'client', 'project', 'trust', 'node', 'home', 'xdg'])('rejects mismatched %s binding or runtime override', variant => {
    const f = fixture(); const entry = structuredClone(f.entry);
    if (variant === 'command') entry.command = process.execPath;
    if (variant === 'args') entry.args = ['--unsafe'];
    if (variant === 'client') entry.env.LEXICON_PATH = join(f.project, '.phantom', 'lexicon', 'other', 'lexicon.yaml');
    if (variant === 'project') entry.env.LEXICON_CWD = '/different';
    if (variant === 'trust') entry.env.LEXICON_TRUST_ALL = '1';
    if (variant === 'node') entry.env.NODE_OPTIONS = '--require /other';
    if (variant === 'home') entry.env.HOME = '/private';
    if (variant === 'xdg') entry.env.XDG_CONFIG_HOME = '/private';
    writeFileSync(f.config, JSON.stringify({ mcpServers: { lexicon: entry } }));
    expect(() => discoverCompanionProjectMcp(f.scope)).toThrow('does not match');
    expect(existsSync(f.receipt)).toBe(false);
  });
  it('rejects absent, malformed, multiply linked and oversized configs', () => {
    const f = fixture();
    expect(() => discoverCompanionProjectMcp({ ...f.scope, config: join(f.project, 'absent') })).toThrow();
    writeFileSync(f.config, '{bad'); expect(() => discoverCompanionProjectMcp(f.scope)).toThrow();
    writeFileSync(f.config, JSON.stringify({ mcpServers: { lexicon: f.entry } }));
    linkSync(f.config, join(f.project, 'second.json')); expect(() => discoverCompanionProjectMcp(f.scope)).toThrow('linked');
    const large = join(f.project, 'large.json'); writeFileSync(large, ' '.repeat(1024 * 1024 + 1));
    expect(() => discoverCompanionProjectMcp({ ...f.scope, config: large })).toThrow('bounded');
  });
  it('rejects outside or dangling paths and vocabulary links without reading vocabulary', () => {
    const f = fixture(); const outside = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-project-outside-'))); roots.push(outside);
    const other = join(outside, 'other.json'); writeFileSync(other, '{}');
    expect(() => discoverCompanionProjectMcp({ ...f.scope, config: other })).toThrow('inside');
    const linked = join(f.project, 'linked.json'); symlinkSync(other, linked);
    expect(() => discoverCompanionProjectMcp({ ...f.scope, config: linked })).toThrow('escapes');
    const dangling = join(f.project, 'dangling'); symlinkSync(join(f.project, 'absent'), dangling);
    expect(() => discoverCompanionProjectMcp({ ...f.scope, config: dangling })).toThrow('dangling');
    symlinkSync(outside, join(f.project, '.phantom'));
    expect(() => discoverCompanionProjectMcp(f.scope)).toThrow('escapes');
  });
  it('lists one explicit registration without home discovery, inventory, probing or vocabulary trust', async () => {
    const f = fixture(); const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdMcp(['list', ...f.args, '--json'])).toBe(0);
    const result = JSON.parse(String(output.mock.calls[0]![0]));
    expect(result.servers.map((s: { name: string }) => s.name)).toEqual(['lexicon']);
    expect(result.servers[0].env).toEqual({ LEXICON_CWD: '<set>', LEXICON_PATH: '<set>' });
    expect(result.tools.tools).toEqual([]); expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.inventory).not.toHaveBeenCalled();
    expect(existsSync(f.receipt)).toBe(false);
  });
  it('runs real stdio handshake/tools-list with isolated HOME, cwd and no provider env', async () => {
    const f = fixture(); vi.stubEnv('OPENAI_API_KEY', 'synthetic-no-provider-access');
    vi.stubEnv('LEXICON_TRUST_ALL', '1'); vi.stubEnv('NODE_OPTIONS', '--title=synthetic-ambient');
    vi.stubEnv('XDG_CONFIG_HOME', '/synthetic-private');
    const registry = discoverCompanionProjectMcp(f.scope);
    const health = await probeServer(registry.servers[0]!, 4000);
    expect(health).toMatchObject({ ok: true, toolCount: 2, tools: ['ping', 'echo'] });
    const child = JSON.parse(readFileSync(f.receipt, 'utf8'));
    expect(child.cwd).toBe(f.project); expect(child.env.HOME).toBe(join(f.project, '.phantom', 'lexicon', f.client));
    expect(child.env.XDG_CONFIG_HOME).toBe(child.env.HOME);
    expect(child.env.LEXICON_TRUST_ALL).toBeUndefined(); expect(child.env.OPENAI_API_KEY).toBeUndefined(); expect(child.env.NODE_OPTIONS).toBeUndefined();
    expect(mocks.config).not.toHaveBeenCalled(); expect(existsSync(join(f.project, '.phantom'))).toBe(false);
  });
  it('doctor actually handshakes the scoped server and reports failure instead of false success', async () => {
    const f = fixture(); const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdMcp(['doctor', ...f.args, '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))[0]).toMatchObject({ name: 'lexicon', ok: true, toolCount: 2 });
    writeFileSync(f.command, '#!' + process.execPath + '\nprocess.exit(8)\n', { mode: 0o755 });
    output.mockClear(); expect(await cmdMcp(['doctor', ...f.args, '--json'])).toBe(1);
    expect(JSON.parse(String(output.mock.calls[0]![0]))[0]).toMatchObject({ name: 'lexicon', ok: false });
    expect(mocks.config).not.toHaveBeenCalled();
  });
  it('connects a real disposable gateway and lists namespaced tools without any tool calls', async () => {
    const f = fixture();
    const runner = join(f.project, 'gateway.mjs');
    const module = fileURLToPath(new URL('../src/cli/mcp.ts', import.meta.url));
    // Deliberately cold boot for longer than the response deadline: startup must
    // complete before the SDK starts timing an initialize request.
    writeFileSync(runner, `import { cmdMcp } from ${JSON.stringify(module)};\nawait new Promise(resolve => setTimeout(resolve, 4500));\nprocess.exitCode = await cmdMcp(${JSON.stringify(f.args)});\n`);
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), runner],
      cwd: f.project, env: { HOME: f.project, PATH: join(f.project, 'bin'), ASHLR_NO_HEAL: '1',
        OPENAI_API_KEY: 'synthetic-outer-not-a-credential', LEXICON_TRUST_ALL: '1', NODE_OPTIONS: '' }, stderr: 'pipe' });
    const start = transport.start.bind(transport);
    let gatewayPid: number | null = null;
    transport.start = async () => {
      // Drain diagnostics before spawn, without printing them. Keep a separate
      // bounded bootstrap phase; protocol response deadlines below stay 4s.
      const stream = transport.stderr!;
      let tail = '';
      let timer: ReturnType<typeof setTimeout>;
      let onData: (chunk: Buffer) => void;
      let onEnd: () => void;
      const ready = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Gateway bootstrap readiness timed out')), 20_000);
        onData = chunk => {
          tail = (tail + chunk.toString('utf8')).slice(-512);
          if (tail.includes('[ashlr mcp] gateway ready')) resolve();
        };
        onEnd = () => reject(new Error('Gateway exited before bootstrap readiness'));
        stream.on('data', onData);
        stream.once('end', onEnd);
      });
      // A spawn failure may precede the awaited readiness promise.
      void ready.catch(() => undefined);
      try { await start(); gatewayPid = transport.pid; await ready; }
      finally {
        clearTimeout(timer!);
        stream.off('data', onData!);
        stream.off('end', onEnd!);
        stream.on('data', () => undefined);
      }
    };
    const client = new Client({ name: 'disposable-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: 4000 });
      const listed = await client.listTools({}, { timeout: 4000 });
      expect(listed.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['lexicon__ping', 'lexicon__echo', 'ashlr_ask']));
      const child = JSON.parse(readFileSync(f.receipt, 'utf8'));
      expect(child.env.OPENAI_API_KEY).toBeUndefined(); expect(child.env.LEXICON_TRUST_ALL).toBeUndefined();
      expect(child.cwd).toBe(f.project); expect(child.env.HOME).toBe(join(f.project, '.phantom', 'lexicon', f.client));
      expect(existsSync(join(f.project, '.phantom'))).toBe(false);
    } finally {
      try { await client.close(); }
      finally { await transport.close(); }
    }
    expect(transport.pid).toBeNull();
    expect(gatewayPid).not.toBeNull();
    // The SDK clears its PID before teardown finishes. Check the actual process
    // with signal zero rather than mistaking cleared bookkeeping for exit.
    const deadline = Date.now() + 2000;
    let exited = false;
    while (Date.now() < deadline) {
      try { process.kill(gatewayPid!, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { exited = true; break; }
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(exited).toBe(true);
  }, 35000);
  it('requires an existing Git boundary without creating one or reading parent vocabulary', () => {
    const f = fixture(); rmSync(join(f.project, '.git'), { recursive: true });
    expect(() => discoverCompanionProjectMcp(f.scope)).toThrow('.git marker');
    expect(existsSync(join(f.project, '.git'))).toBe(false);
  });
  it.each(['.lexicon.yaml', 'trust.json', 'hits.json', 'lexicon.yaml'])('rejects redirected or hardlinked %s state before any process starts', filename => {
    const f = fixture(); const home = join(f.project, '.phantom', 'lexicon', f.client); mkdirSync(home, { recursive: true });
    const target = join(f.project, 'other-state'); writeFileSync(target, 'not read');
    const state = filename === '.lexicon.yaml' ? join(f.project, filename) : join(home, filename);
    symlinkSync(target, state); expect(() => discoverCompanionProjectMcp(f.scope)).toThrow('redirect');
    rmSync(state); linkSync(target, state); expect(() => discoverCompanionProjectMcp(f.scope)).toThrow('linked');
    expect(existsSync(f.receipt)).toBe(false);
  });
  it('does not resolve relative PATH entries from the current directory', () => {
    const f = fixture(); vi.stubEnv('PATH', 'bin:.');
    expect(() => discoverCompanionProjectMcp(f.scope)).toThrow('No installed');
  });
  it('deduplicates executable aliases and shares physical binding with onboarding', async () => {
    const f = fixture(); const aliases = join(f.project, 'aliases'); mkdirSync(aliases);
    const alias = join(aliases, 'lexicon-mcp'); symlinkSync(f.command, alias);
    vi.stubEnv('PATH', [aliases, join(f.project, 'bin')].join(process.platform === 'win32' ? ';' : ':'));
    expect(discoverCompanionProjectMcp(f.scope).servers[0]!.command).toBe(realpathSync(f.command));
    rmSync(f.config); vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdMcp(['ecosystem', '--only', 'lexicon', ...f.args, '--write'])).toBe(0);
    expect(JSON.parse(readFileSync(f.config, 'utf8')).mcpServers.lexicon.command).toBe(realpathSync(f.command));
    expect(discoverCompanionProjectMcp(f.scope).servers).toHaveLength(1);
    expect(existsSync(f.receipt)).toBe(false);
  });
  it('refuses distinct installed Lexicon candidates instead of selecting PATH order', async () => {
    const f = fixture(); const other = join(f.project, 'other-bin'); mkdirSync(other);
    writeFileSync(join(other, 'lexicon-mcp'), readFileSync(f.command), { mode: 0o755 });
    vi.stubEnv('PATH', [join(f.project, 'bin'), other].join(process.platform === 'win32' ? ';' : ':'));
    expect(() => discoverCompanionProjectMcp(f.scope)).toThrow('Ambiguous');
    rmSync(f.config); vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdMcp(['ecosystem', '--only', 'lexicon', ...f.args, '--write'])).toBe(0);
    expect(existsSync(f.config)).toBe(false); expect(existsSync(f.receipt)).toBe(false);
  });
  it.each(['#!/usr/bin/env node\n// npx forbidden-downloader\n', '#!/bin/sh\nexit 0\n'])('refuses bootstrap and unknown script Lexicon launchers before execution', async source => {
    const f = fixture(); writeFileSync(f.command, source, { mode: 0o755 });
    expect(() => discoverCompanionProjectMcp(f.scope)).toThrow('Unsupported');
    rmSync(f.config); vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdMcp(['ecosystem', '--only', 'lexicon', ...f.args, '--write'])).toBe(0);
    expect(existsSync(f.config)).toBe(false); expect(existsSync(f.receipt)).toBe(false);
  });
  it('rejects client-directory aliasing and permits a regular worktree Git marker', () => {
    const f = fixture(); rmSync(join(f.project, '.git'), { recursive: true }); writeFileSync(join(f.project, '.git'), 'gitdir: deliberately-not-read');
    expect(discoverCompanionProjectMcp(f.scope).servers).toHaveLength(1);
    const clients = join(f.project, '.phantom', 'lexicon'); mkdirSync(join(clients, 'other-client'), { recursive: true });
    symlinkSync(join(clients, 'other-client'), join(clients, f.client));
    expect(() => discoverCompanionProjectMcp(f.scope)).toThrow('redirect'); expect(existsSync(f.receipt)).toBe(false);
  });
  it('refuses inherited Locus sessions before spawning or loading HOME configuration', async () => {
    const f = fixture(); const spec = discoverCompanionProjectMcp(f.scope).servers[0]!;
    vi.stubEnv('LOCUS_SESSION_ID', 'synthetic-inherited-session');
    expect(await probeServer(spec, 1000)).toMatchObject({ ok: false, error: 'Shared MCP gateway unavailable inside a delegated Locus job' });
    expect(existsSync(f.receipt)).toBe(false); expect(mocks.config).not.toHaveBeenCalled();
  });
  it('onboarding also ignores relative PATH entries', async () => {
    const f = fixture(); vi.stubEnv('PATH', '.:bin'); vi.spyOn(console, 'log').mockImplementation(() => {});
    rmSync(f.config);
    expect(await cmdMcp(['ecosystem', '--only', 'lexicon', ...f.args, '--write'])).toBe(0);
    expect(existsSync(f.config)).toBe(false); expect(existsSync(f.receipt)).toBe(false);
  });
  it.each([['--project'], ['--config', '/absent'], ['--project', '/a', '--client', 'x'], ['--other'], ['--client', 'x', '--client', 'x'], ['--json', '--json']])('refuses partial/unknown/duplicate options %j without ambient fallback', async args => {
    fixture(); vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdMcp(['list', ...args])).toBe(2); expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.inventory).not.toHaveBeenCalled();
  });
  it('refuses explicit scopes inside the isolated fleet gateway', async () => {
    const f = fixture(); vi.stubEnv('ASHLR_MCP_HOST', 'ashlr-fleet-engine'); vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdMcp(['list', ...f.args])).toBe(2); expect(existsSync(f.receipt)).toBe(false);
  });
});
