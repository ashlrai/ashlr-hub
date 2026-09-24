/**
 * V3.10 unit C6 — Apps & Accounts server side: detection (core/verse/apps.ts),
 * the route module (core/verse/apps-api.ts) and the llama-server probe
 * (core/verse/local-models.ts).
 *
 * Nothing real is touched: PATH, stat, `--version`, `ollama launch --help`,
 * loopback fetches and Terminal are all injected. The fixtures are the exact
 * outputs captured on Mason's machine on 2026-09-24 (zero-cost status
 * commands), so the parsers are tested against what the tools really print.
 * HOME is a temp directory for every test that writes (the A1 guard fails any
 * write under the real ~/.ashlr).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  buildTerminalScript,
  claudeDesktopOllamaState,
  commandText,
  createAppsService,
  lastLocalThroughput,
  parseAppsState,
  parseVersionOutput,
  readAppsStateFile,
  resolveAppLaunch,
  setAppsService,
  terminalOpener,
  versionFromPackageJson,
  versionFromRealPath,
  writeAppsStateFile,
  type AppsDeps,
  type BinaryFacts,
  type RunResult,
} from '../src/core/verse/apps.js';
import { handleAppsApi } from '../src/core/verse/apps-api.js';
import { probeLlamaServer } from '../src/core/verse/local-models.js';
import type { LoginPathResult } from '../src/core/verse/login-path.js';
import type { VerseEvent, VerseSession } from '../src/core/verse/types.js';
import type { VerseAppRow, VerseAppsResponse } from '../src/core/verse/workbench-types.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

// ---------------------------------------------------------------------------
// Fixtures captured on this machine (2026-09-24)
// ---------------------------------------------------------------------------

const OLLAMA_LAUNCH_HELP = `Launch the Ollama interactive menu, or directly launch a specific integration.

Supported integrations:
  claude          Claude Code
  chatgpt         ChatGPT (aliases: codex-app, codex-desktop, codex-gui)
  hermes          Hermes Agent
  openclaw        OpenClaw (aliases: clawdbot, moltbot)
  opencode        OpenCode
  codex           Codex
  hermes-desktop  Hermes Desktop
  copilot         Copilot CLI (aliases: copilot-cli)
  droid           Droid
  pi              Pi
  cline           Cline
  vscode          VS Code (aliases: code)

Examples:
  ollama launch
  ollama launch claude-desktop --restore
  ollama launch claude --model <model>

Usage:
  ollama launch [INTEGRATION] [-- [EXTRA_ARGS...]] [flags]

Flags:
      --model string   Model to use
      --restore        Restore an integration to its default profile
`;

const HOME = '/Users/op';
const PATH_ENTRIES = ['/opt/homebrew/bin', `${HOME}/.local/bin`, `${HOME}/.grok/bin`, '/usr/local/bin', '/usr/bin', '/bin'];

/** What `stat` finds: PATH hit → real path. */
const INSTALLED: Record<string, string> = {
  [`${HOME}/.local/bin/claude`]: `${HOME}/.local/share/claude/versions/2.1.280`,
  '/opt/homebrew/bin/codex': '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
  [`${HOME}/.grok/bin/grok`]: `${HOME}/.grok/downloads/grok-0.2.118-macos-aarch64`,
  [`${HOME}/.local/bin/hermes`]: `${HOME}/.local/bin/hermes`,
  [`${HOME}/.local/bin/aider`]: `${HOME}/.local/share/uv/tools/aider-chat/bin/aider`,
  '/opt/homebrew/bin/goose': '/opt/homebrew/Cellar/block-goose-cli/1.30.0/bin/goose',
  '/usr/local/bin/ollama': '/Applications/Ollama.app/Contents/Resources/ollama',
  '/opt/homebrew/bin/llama-server': '/opt/homebrew/Cellar/llama.cpp/0.4.1/bin/llama-server',
};

const VERSION_OUTPUT: Record<string, string> = {
  hermes: 'Hermes Agent v0.15.1 (2026.5.29)\nProject: ~/.hermes/hermes-agent\n',
  aider: 'aider 0.86.2\n',
  ollama: 'ollama version is 0.33.3\n',
};

const LOGIN: LoginPathResult = {
  path: PATH_ENTRIES.join(':'),
  entries: PATH_ENTRIES,
  source: 'login-shell',
  shell: '/bin/zsh',
  fallbackReason: null,
  resolvedAt: '2026-09-24T10:00:00.000Z',
};

interface FakeWorld {
  deps: AppsDeps;
  runs: Array<{ file: string; args: readonly string[]; env: Record<string, string> }>;
  scripts: Array<{ script: string; name: string }>;
  state: { text: string | null };
  files: Map<string, string>;
  fetches: string[];
  /** Release a held `--version` for this basename. */
  release: (bin: string) => void;
}

interface WorldOptions {
  installed?: Record<string, string>;
  hold?: string[];
  ollamaUp?: boolean;
  llama?: 'ok' | 'loading' | 'down';
  lmStudio?: boolean;
  platform?: NodeJS.Platform;
  loginSource?: 'login-shell' | 'fallback';
  claudeDesktopConfig?: string | null;
  roots?: string[];
  throughput?: { model: string; tokPerSec: number; at: string } | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function world(opts: WorldOptions = {}): FakeWorld {
  const installed = opts.installed ?? INSTALLED;
  const runs: FakeWorld['runs'] = [];
  const scripts: FakeWorld['scripts'] = [];
  const state = { text: null as string | null };
  const files = new Map<string, string>();
  files.set('/opt/homebrew/lib/node_modules/@openai/codex/package.json', JSON.stringify({ name: '@openai/codex', version: '0.136.0' }));
  const configPath = `${HOME}/Library/Application Support/Claude/claude_desktop_config.json`;
  const desktop = opts.claudeDesktopConfig === undefined ? JSON.stringify({ preferences: {} }) : opts.claudeDesktopConfig;
  if (desktop !== null) files.set(configPath, desktop);
  const holds = new Map<string, () => void>();
  const held = new Set(opts.hold ?? []);
  const fetches: string[] = [];
  const ollamaUp = opts.ollamaUp ?? true;

  const run = async (file: string, args: readonly string[], o: { env: Record<string, string> }): Promise<RunResult> => {
    runs.push({ file, args, env: o.env });
    const bin = path.basename(file);
    if (bin === 'ollama' && args[0] === 'launch') return { stdout: OLLAMA_LAUNCH_HELP, stderr: '', code: 0, timedOut: false };
    if (held.has(bin)) {
      await new Promise<void>((resolve) => holds.set(bin, resolve));
    }
    return { stdout: VERSION_OUTPUT[bin] ?? '', stderr: '', code: 0, timedOut: false };
  };

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetches.push(url);
    if (url.startsWith('http://127.0.0.1:11434')) {
      if (!ollamaUp) throw Object.assign(new Error('refused'), { name: 'TypeError' });
      if (url.endsWith('/api/version')) return jsonResponse({ version: '0.33.3' });
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'qwen3.8:27b' }, { name: 'qwen3-coder:30b' }] });
      if (url.endsWith('/api/ps')) return jsonResponse({ models: [{ name: 'qwen3.8:27b', size: 1, size_vram: 1 }] });
    }
    if (url.startsWith('http://127.0.0.1:8080')) {
      const llama = opts.llama ?? 'ok';
      if (llama === 'down') throw Object.assign(new Error('refused'), { name: 'TypeError' });
      if (url.endsWith('/health')) return llama === 'loading' ? jsonResponse({ error: { message: 'Loading model' } }, 503) : jsonResponse({ status: 'ok' });
      if (url.endsWith('/props')) return jsonResponse({ total_slots: 4, model_path: `${HOME}/.ollama/models/blobs/sha256-2bb2` });
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: `${HOME}/.ollama/models/blobs/sha256-2bb2` }] });
    }
    if (url.startsWith('http://127.0.0.1:1234')) {
      if (opts.lmStudio) return jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] });
      throw Object.assign(new Error('refused'), { name: 'TypeError' });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;

  const deps: AppsDeps = {
    loginPath: async () => ({ ...LOGIN, source: opts.loginSource ?? 'login-shell' }),
    childEnv: async () => ({ PATH: LOGIN.path, HOME }),
    statExecutable: (p: string): BinaryFacts | null => {
      const real = installed[p];
      return real === undefined ? null : { path: p, realPath: real, mtimeMs: 1, size: 100 };
    },
    readText: (p) => files.get(p) ?? null,
    run,
    fetchImpl,
    openTerminal: async (script, name) => { scripts.push({ script, name }); },
    writeState: (text) => { state.text = text; },
    readState: () => state.text,
    home: HOME,
    platform: opts.platform ?? 'darwin',
    now: () => Date.parse('2026-09-24T10:00:00.000Z'),
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    llamaServerBaseUrl: 'http://127.0.0.1:8080',
    lmStudioBaseUrl: 'http://127.0.0.1:1234',
    localThroughput: () => (opts.throughput === undefined ? null : opts.throughput),
    allowedRoots: () => opts.roots ?? ['/Users/op/code/ashlr-hub'],
    checkRoot: (raw) => (raw.startsWith('/') ? { ok: true, path: raw } : { ok: false, error: 'not an absolute folder' }),
  };
  return {
    deps,
    runs,
    scripts,
    state,
    files,
    fetches,
    release: (bin) => { holds.get(bin)?.(); holds.delete(bin); },
  };
}

function row(res: VerseAppsResponse, id: string): VerseAppRow {
  for (const group of res.groups) {
    const found = group.apps.find((a) => a.id === id);
    if (found) return found;
  }
  throw new Error(`no row ${id}`);
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe('versions — from the install path first, then the CLI’s own output', () => {
  it('reads the versions the real CLIs print', () => {
    expect(parseVersionOutput('codex-cli 0.136.0\n')).toBe('0.136.0');
    expect(parseVersionOutput('aider 0.86.2\n')).toBe('0.86.2');
    expect(parseVersionOutput(' 1.30.0\n')).toBe('1.30.0');
    expect(parseVersionOutput('ollama version is 0.33.3\n')).toBe('0.33.3');
    expect(parseVersionOutput('version: 0.4.1 (build 10964, commit b29c606e2)\nbuilt with AppleClang 21.0.0')).toBe('0.4.1');
    expect(parseVersionOutput(VERSION_OUTPUT['hermes']!)).toBe('0.15.1');
    expect(parseVersionOutput('no digits here')).toBeNull();
  });

  it('reads a version out of the install path without running anything', () => {
    expect(versionFromRealPath('/Users/op/.local/share/claude/versions/2.1.280')).toBe('2.1.280');
    expect(versionFromRealPath('/Users/op/.grok/downloads/grok-0.2.118-macos-aarch64')).toBe('0.2.118');
    expect(versionFromRealPath('/opt/homebrew/Cellar/block-goose-cli/1.30.0/bin/goose')).toBe('1.30.0');
    expect(versionFromRealPath('/opt/homebrew/Cellar/llama.cpp/0.4.1/bin/llama-server')).toBe('0.4.1');
    // A venv shim and an app bundle say nothing: the CLI is asked instead.
    expect(versionFromRealPath('/Users/op/.local/share/uv/tools/aider-chat/bin/aider')).toBeNull();
    expect(versionFromRealPath('/Applications/Ollama.app/Contents/Resources/ollama')).toBeNull();
  });

  it('reads an npm CLI’s version from its package.json, only inside node_modules', () => {
    const files = new Map([['/g/node_modules/@openai/codex/package.json', '{"name":"@openai/codex","version":"0.136.0"}']]);
    const read = (p: string) => files.get(p) ?? null;
    expect(versionFromPackageJson('/g/node_modules/@openai/codex/bin/codex.js', read)).toBe('0.136.0');
    expect(versionFromPackageJson('/usr/local/bin/tool', read)).toBeNull();
  });
});

describe('claudeDesktopOllamaState — the other app’s own record of the switch', () => {
  it('is off without a deployment mode, on with one, unknown when unreadable', () => {
    expect(claudeDesktopOllamaState(JSON.stringify({ preferences: {} }))).toBe('off');
    expect(claudeDesktopOllamaState(JSON.stringify({ deploymentMode: '3p' }))).toBe('on');
    expect(claudeDesktopOllamaState(null)).toBe('unknown');
    expect(claudeDesktopOllamaState('{not json')).toBe('unknown');
    expect(claudeDesktopOllamaState('[]')).toBe('unknown');
  });
});

describe('lastLocalThroughput — end-to-end tok/s of the newest local turn', () => {
  const session = (over: Partial<VerseSession>): VerseSession => ({
    id: 's1', title: 't', projectPath: '/p', engine: 'local', accountId: 'local', seatId: 'local:q', model: 'qwen3.8:27b',
    nativeSessionId: null, createdAt: '2026-09-24T09:00:00.000Z', updatedAt: '2026-09-24T09:30:00.000Z', status: 'idle',
    turnCount: 2, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, contextTokens: null, contextWindow: null },
    lastError: null,
    ...over,
  } as VerseSession);

  const events: VerseEvent[] = [
    { seq: 1, at: '2026-09-24T09:10:00.000Z', type: 'usage', turnId: 't1', usage: { outputTokens: 100 } as never },
    { seq: 2, at: '2026-09-24T09:10:10.000Z', type: 'turn-done', turnId: 't1', ok: true, nativeSessionId: null, durationMs: 10_000 },
    { seq: 3, at: '2026-09-24T09:20:00.000Z', type: 'usage', turnId: 't2', usage: { outputTokens: 850 } as never },
    { seq: 4, at: '2026-09-24T09:21:40.000Z', type: 'turn-done', turnId: 't2', ok: true, nativeSessionId: null, durationMs: 100_000 },
    { seq: 5, at: '2026-09-24T09:25:00.000Z', type: 'turn-done', turnId: 't3', ok: false, nativeSessionId: null, durationMs: 5_000 },
  ];

  it('uses the LAST successful turn with both a token count and a duration', () => {
    const got = lastLocalThroughput([session({})], () => events);
    expect(got).toEqual({ model: 'qwen3.8:27b', tokPerSec: 8.5, at: '2026-09-24T09:21:40.000Z' });
  });

  it('reads one session only — the newest local one — and ignores paid seats', () => {
    const seen: string[] = [];
    const got = lastLocalThroughput(
      [session({ id: 'old', updatedAt: '2026-09-20T00:00:00.000Z' }), session({ id: 'new' }), session({ id: 'claude', engine: 'claude', updatedAt: '2026-09-25T00:00:00.000Z' })],
      (id) => { seen.push(id); return events; },
    );
    expect(seen).toEqual(['new']);
    expect(got?.tokPerSec).toBe(8.5);
  });

  it('is null (unknown) — never zero — with nothing to measure', () => {
    expect(lastLocalThroughput([], () => events)).toBeNull();
    expect(lastLocalThroughput([session({ turnCount: 0 })], () => events)).toBeNull();
    expect(lastLocalThroughput([session({})], () => [])).toBeNull();
    expect(lastLocalThroughput([session({})], () => { throw new Error('gone'); })).toBeNull();
  });
});

describe('the Terminal script', () => {
  it('quotes every argument, pins PATH, cds, and execs the absolute binary', () => {
    const script = buildTerminalScript({
      argv: ['/opt/homebrew/bin/codex'],
      display: ['codex'],
      cwd: "/Users/op/my 'repo'",
      path: '/opt/homebrew/bin:/usr/bin',
      banner: 'launching Codex in my repo.\u001b[31m',
    });
    const lines = script.split('\n');
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines[1]).toBe('rm -f -- "$0"');
    expect(script).toContain(`export PATH='/opt/homebrew/bin:/usr/bin'`);
    expect(script).toContain(`cd -- '/Users/op/my '\\''repo'\\''' || exit 1`);
    expect(script).toContain(`exec '/opt/homebrew/bin/codex'`);
    // Control characters never reach the terminal.
    expect(script).not.toContain('\u001b');
    expect(commandText(['ollama', 'launch', 'claude', '--model', 'qwen3.8:27b'])).toBe('ollama launch claude --model qwen3.8:27b');
    expect(commandText(['echo', 'a b'])).toBe(`echo 'a b'`);
  });
});

describe('parseAppsState', () => {
  it('keeps only records for real desktop switches, and survives garbage', () => {
    expect(parseAppsState(null)).toEqual({ v: 1, desktop: {} });
    expect(parseAppsState('nope')).toEqual({ v: 1, desktop: {} });
    const parsed = parseAppsState(JSON.stringify({
      v: 1,
      desktop: { 'hermes-desktop': { enabled: true, at: 'x' }, codex: { enabled: true, at: 'x' }, 'claude-desktop': { enabled: 'yes', at: 'x' } },
    }));
    expect(parsed.desktop).toEqual({ 'hermes-desktop': { enabled: true, at: 'x' } });
  });
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

describe('createAppsService — detection', () => {
  it('finds every installed tool on the LOGIN PATH, with versions, and says "not installed" for the rest', async () => {
    const w = world();
    const res = await createAppsService(w.deps).get();

    expect(res.pathSource).toBe('login-shell');
    expect(res.groups.map((g) => g.id)).toEqual(['desktop', 'terminal-agents', 'local-models']);

    expect(row(res, 'claude-code')).toMatchObject({ installed: true, version: '2.1.280', health: { state: 'ok', label: 'installed' } });
    expect(row(res, 'codex')).toMatchObject({ installed: true, version: '0.136.0' });
    expect(row(res, 'grok')).toMatchObject({ installed: true, version: '0.2.118' });
    expect(row(res, 'goose')).toMatchObject({ installed: true, version: '1.30.0' });
    expect(row(res, 'aider')).toMatchObject({ installed: true, version: '0.86.2' });
    expect(row(res, 'hermes')).toMatchObject({ installed: true, version: '0.15.1' });
    expect(row(res, 'opencode')).toMatchObject({ installed: false, version: null, health: { state: 'off', label: 'not installed' } });

    // Versions that the path states never spawn a process.
    const spawned = w.runs.filter((r) => r.args[0] !== 'launch').map((r) => path.basename(r.file)).sort();
    expect(spawned).toEqual(['aider', 'hermes', 'ollama']);
    // And every spawn runs with the sanitised child env, never the sidecar's.
    for (const r of w.runs) expect(r.env).toEqual({ PATH: LOGIN.path, HOME });
  });

  it('shows the own launch command as the copy pill, and `ollama launch <id>` ONLY where the installed ollama lists it', async () => {
    const res = await createAppsService(world().deps).get();
    expect(row(res, 'claude-code').copy).toEqual({ label: 'claude', text: 'claude' });
    expect(row(res, 'claude-code').ollamaLaunch).toEqual(['ollama', 'launch', 'claude']);
    expect(row(res, 'codex').ollamaLaunch).toEqual(['ollama', 'launch', 'codex']);
    expect(row(res, 'hermes').ollamaLaunch).toEqual(['ollama', 'launch', 'hermes']);
    // No integration for these in 0.33.3.
    expect(row(res, 'grok').ollamaLaunch).toBeNull();
    expect(row(res, 'aider').ollamaLaunch).toBeNull();
    expect(row(res, 'goose').ollamaLaunch).toBeNull();
  });

  it('never offers Launch for an agent that is not installed — even when ollama could install it', async () => {
    const res = await createAppsService(world().deps).get();
    const launch = row(res, 'opencode').actions.find((a) => a.kind === 'launch')!;
    expect(launch.disabledReason).toBe('Not installed. Running ollama launch opencode yourself can install it.');
    expect(row(res, 'opencode').ollamaLaunch).toEqual(['ollama', 'launch', 'opencode']);
    expect(row(res, 'codex').actions.find((a) => a.kind === 'launch')!.disabledReason).toBeNull();
  });

  it('with no ollama at all, no row shows an ollama command', async () => {
    const installed = { ...INSTALLED };
    delete installed['/usr/local/bin/ollama'];
    const res = await createAppsService(world({ installed, ollamaUp: false }).deps).get();
    for (const group of res.groups) for (const app of group.apps) expect(app.ollamaLaunch).toBeNull();
    expect(row(res, 'claude-desktop')).toMatchObject({ toggle: null, health: { state: 'off', label: 'needs Ollama' } });
    expect(row(res, 'ollama')).toMatchObject({ installed: false, health: { state: 'off', label: 'not installed' } });
  });

  it('reports a fallback PATH honestly', async () => {
    const res = await createAppsService(world({ loginSource: 'fallback' }).deps).get();
    expect(res.pathSource).toBe('fallback');
  });

  it('a slow --version never holds the page; its answer lands on the next read, and is asked once per install', async () => {
    const w = world({ hold: ['hermes'] });
    const svc = createAppsService(w.deps);
    const first = await svc.get();
    expect(row(first, 'hermes')).toMatchObject({ installed: true, version: null });
    w.release('hermes');
    await new Promise((r) => setTimeout(r, 0));
    const second = await svc.get();
    expect(row(second, 'hermes').version).toBe('0.15.1');
    await svc.refresh();
    expect(w.runs.filter((r) => path.basename(r.file) === 'hermes')).toHaveLength(1);
  }, 10_000);
});

describe('createAppsService — local runtimes', () => {
  it('Ollama: running, with model counts and the measured end-to-end tok/s', async () => {
    const res = await createAppsService(world({ throughput: { model: 'qwen3.8:27b', tokPerSec: 8.5, at: 'x' } }).deps).get();
    expect(row(res, 'ollama')).toMatchObject({
      installed: true,
      version: '0.33.3',
      health: { state: 'ok', label: 'running' },
      detail: '2 models · 1 loaded · ≈8.5 tok/s end to end, last local turn',
    });
  });

  it('Ollama: installed but not running is a warning with the way to start it', async () => {
    const res = await createAppsService(world({ ollamaUp: false }).deps).get();
    expect(row(res, 'ollama').health).toEqual({ state: 'warn', label: 'not running' });
    expect(row(res, 'ollama').detail).toContain('ollama serve');
  });

  it('llama-server: slots from the server itself, and never the GGUF path', async () => {
    const res = await createAppsService(world().deps).get();
    const llama = row(res, 'llama-server');
    expect(llama).toMatchObject({ health: { state: 'ok', label: 'running' }, version: '0.4.1', detail: ':8080 · 4 slots · 1 model' });
    expect(JSON.stringify(res)).not.toContain('.ollama/models/blobs');
    expect(JSON.stringify(res)).not.toContain(HOME);
  });

  it('llama-server: loading and down read as such', async () => {
    expect(row(await createAppsService(world({ llama: 'loading' }).deps).get(), 'llama-server').health)
      .toEqual({ state: 'warn', label: 'loading a model' });
    expect(row(await createAppsService(world({ llama: 'down' }).deps).get(), 'llama-server').health)
      .toEqual({ state: 'off', label: 'not running' });
  });

  it('LM Studio: not installed, or a running server with its model count', async () => {
    expect(row(await createAppsService(world().deps).get(), 'lm-studio').health).toEqual({ state: 'off', label: 'not installed' });
    expect(row(await createAppsService(world({ lmStudio: true }).deps).get(), 'lm-studio'))
      .toMatchObject({ health: { state: 'ok', label: 'server running' }, detail: '2 models' });
  });
});

describe('createAppsService — desktop switches (SPEC-310C §0.5: shown off, with Restore)', () => {
  it('Claude Desktop reads its own config: off, with both commands and a Restore action', async () => {
    const res = await createAppsService(world().deps).get();
    const cd = row(res, 'claude-desktop');
    expect(cd.toggle).toEqual({
      enabled: false,
      command: ['ollama', 'launch', 'claude-desktop'],
      restoreCommand: ['ollama', 'launch', 'claude-desktop', '--restore'],
    });
    expect(cd.health).toEqual({ state: 'off', label: 'off' });
    expect(cd.actions).toEqual([{ kind: 'restore', label: 'Restore', command: ['ollama', 'launch', 'claude-desktop', '--restore'], disabledReason: null }]);
  });

  it('Claude Desktop switched on outside Verse reads on (a warning, with the way back)', async () => {
    const res = await createAppsService(world({ claudeDesktopConfig: JSON.stringify({ deploymentMode: '3p' }) }).deps).get();
    expect(row(res, 'claude-desktop').health).toEqual({ state: 'warn', label: 'on' });
    expect(row(res, 'claude-desktop').toggle?.enabled).toBe(true);
  });

  it('an unreadable config is "state not read" — not off', async () => {
    const res = await createAppsService(world({ claudeDesktopConfig: null }).deps).get();
    expect(row(res, 'claude-desktop').health).toEqual({ state: 'unknown', label: 'state not read' });
  });

  it('toggle opens the exact command in Terminal and records what Verse asked for', async () => {
    const w = world();
    const svc = createAppsService(w.deps);
    const result = await svc.toggle('hermes-desktop', true);
    expect(result).toEqual({ ok: true, status: 202, body: { ok: true, opened: 'terminal-app', command: ['ollama', 'launch', 'hermes-desktop'] } });
    expect(w.scripts).toHaveLength(1);
    expect(w.scripts[0]!.script).toContain(`exec '/usr/local/bin/ollama' 'launch' 'hermes-desktop'`);
    // Never answers the other tool's prompts for the operator.
    expect(w.scripts[0]!.script).not.toMatch(/'-y'|--yes/);
    expect(JSON.parse(w.state.text!)).toMatchObject({ v: 1, desktop: { 'hermes-desktop': { enabled: true } } });
    const res = await svc.get();
    expect(row(res, 'hermes-desktop').health).toEqual({ state: 'warn', label: 'on (as last set from Verse)' });

    const restore = await svc.toggle('hermes-desktop', false);
    expect(restore.ok && restore.body.command).toEqual(['ollama', 'launch', 'hermes-desktop', '--restore']);
  });

  it('toggle refuses anything that is not a desktop switch, and a switch this ollama lacks', async () => {
    const svc = createAppsService(world().deps);
    expect(await svc.toggle('nope', true)).toMatchObject({ ok: false, status: 404 });
    expect(await svc.toggle('codex', true)).toMatchObject({ ok: false, status: 409, code: 'VERSE_APP_NO_TOGGLE' });
    const installed = { ...INSTALLED };
    delete installed['/usr/local/bin/ollama'];
    const noOllama = createAppsService(world({ installed }).deps);
    expect(await noOllama.toggle('claude-desktop', true)).toMatchObject({ ok: false, status: 409, code: 'VERSE_APP_OLLAMA_UNAVAILABLE' });
  });

  it('is macOS-only: elsewhere it says so and opens nothing', async () => {
    const w = world({ platform: 'linux' });
    expect(await createAppsService(w.deps).toggle('claude-desktop', false)).toMatchObject({ ok: false, status: 501 });
    expect(w.scripts).toHaveLength(0);
    expect(w.state.text).toBeNull();
  });
});

describe('launch', () => {
  it('runs the agent itself, in the chosen project, from its detected binary', async () => {
    const w = world();
    const result = await createAppsService(w.deps).launch('codex', { root: '/Users/op/code/ashlr-hub' });
    expect(result).toEqual({ ok: true, status: 202, body: { ok: true, opened: 'terminal-app', command: ['codex'] } });
    const script = w.scripts[0]!.script;
    expect(script).toContain(`cd -- '/Users/op/code/ashlr-hub' || exit 1`);
    expect(script).toContain(`exec '/opt/homebrew/bin/codex'`);
  });

  it('through Ollama, optionally with an installed local model', async () => {
    const w = world();
    const svc = createAppsService(w.deps);
    const result = await svc.launch('claude-code', { root: '/Users/op/code/ashlr-hub', model: 'qwen3.8:27b' });
    expect(result.ok && result.body.command).toEqual(['ollama', 'launch', 'claude', '--model', 'qwen3.8:27b']);
    expect(w.scripts[0]!.script).toContain(`exec '/usr/local/bin/ollama' 'launch' 'claude' '--model' 'qwen3.8:27b'`);
  });

  it('refuses a folder that is not a chat folder or a discovered project', async () => {
    const w = world();
    const svc = createAppsService(w.deps);
    expect(await svc.launch('codex', { root: '/etc' })).toMatchObject({ ok: false, status: 400 });
    expect(await svc.launch('codex', { root: 'relative' })).toMatchObject({ ok: false, status: 400, error: 'not an absolute folder' });
    expect(w.scripts).toHaveLength(0);
  });

  it('refuses what cannot run: unknown, not an agent, not installed, no ollama integration, a bad or absent model', async () => {
    const svc = createAppsService(world().deps);
    const root = '/Users/op/code/ashlr-hub';
    expect(await svc.launch('nope', { root })).toMatchObject({ status: 404 });
    expect(await svc.launch('ollama', { root })).toMatchObject({ status: 409, code: 'VERSE_APP_NOT_LAUNCHABLE' });
    expect(await svc.launch('opencode', { root })).toMatchObject({ status: 409, code: 'VERSE_APP_NOT_INSTALLED' });
    expect(await svc.launch('opencode', { root, via: 'ollama' })).toMatchObject({ status: 409, code: 'VERSE_APP_NOT_INSTALLED' });
    expect(await svc.launch('grok', { root, via: 'ollama' })).toMatchObject({ status: 409, code: 'VERSE_APP_OLLAMA_UNAVAILABLE' });
    expect(await svc.launch('claude-code', { root, model: 'not-installed:7b' })).toMatchObject({ status: 400, code: 'VERSE_APP_MODEL_INVALID' });
    expect(await svc.launch('claude-code', { root, model: '$(rm -rf ~)' })).toMatchObject({ status: 400, code: 'VERSE_APP_MODEL_INVALID' });
    expect(await svc.launch('codex', { root, via: 'native', model: 'qwen3.8:27b' })).toMatchObject({ status: 400 });
  });

  it('resolveAppLaunch is what C4’s terminal can use for an `appId` (no Terminal involved)', async () => {
    const snap = await createAppsService(world().deps).snapshot();
    expect(resolveAppLaunch(snap, 'claude-code')).toEqual({ ok: true, plan: { argv: [`${HOME}/.local/bin/claude`], display: ['claude'] } });
    expect(resolveAppLaunch(snap, 'codex', { via: 'ollama' })).toEqual({
      ok: true,
      plan: { argv: ['/usr/local/bin/ollama', 'launch', 'codex'], display: ['ollama', 'launch', 'codex'] },
    });
  });
});

describe('private files', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'c6-apps-')); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('the state record is 0600 in a 0700 directory, written atomically', () => {
    writeAppsStateFile('{"v":1,"desktop":{}}\n', home);
    const file = path.join(home, '.ashlr', 'verse', 'apps.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readAppsStateFile(home)).toBe('{"v":1,"desktop":{}}\n');
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a launch script is 0700 and handed to the opener, never run here', async () => {
    const opened: string[] = [];
    await terminalOpener(home, async (p) => { opened.push(p); })('#!/bin/sh\nexit 0\n', 'codex/../x');
    expect(opened).toHaveLength(1);
    expect(path.dirname(opened[0]!)).toBe(path.join(home, '.ashlr', 'verse', 'apps'));
    expect(path.basename(opened[0]!)).toMatch(/^codex____x-[0-9a-f]{8}\.command$/);
    expect(fs.statSync(opened[0]!).mode & 0o777).toBe(0o700);
  });
});

// ---------------------------------------------------------------------------
// llama-server probe
// ---------------------------------------------------------------------------

describe('probeLlamaServer', () => {
  it('ok: slots and names, with path-shaped model ids counted but never returned', async () => {
    const fetchImpl = (async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
      if (url.endsWith('/props')) return jsonResponse({ total_slots: 4 });
      return jsonResponse({ data: [{ id: '/Users/op/.ollama/models/blobs/sha256-x' }, { id: 'qwen-local' }] });
    }) as typeof fetch;
    expect(await probeLlamaServer({ fetchImpl, baseUrl: 'http://127.0.0.1:8080/v1' })).toEqual({
      reachable: true, baseUrl: 'http://127.0.0.1:8080', status: 'ok', models: ['qwen-local'], modelCount: 2, slots: 4, reason: null,
    });
  });

  it('loading, http error, refused', async () => {
    const status = (code: number) => (async () => new Response('{}', { status: code })) as unknown as typeof fetch;
    expect((await probeLlamaServer({ fetchImpl: status(503) })).status).toBe('loading');
    expect((await probeLlamaServer({ fetchImpl: status(500) })).reason).toBe('llama-server-http-500');
    const refused = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await probeLlamaServer({ fetchImpl: refused })).toMatchObject({ reachable: false, status: 'down', reason: 'llama-server-refused' });
  });
});

// ---------------------------------------------------------------------------
// The route module
// ---------------------------------------------------------------------------

describe('handleAppsApi', () => {
  let server: http.Server;
  let base: string;
  let w: FakeWorld;
  const ctx: VerseApiContext = { cfg: {} as AshlrConfig, token: 't', allowDispatch: true };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      void handleAppsApi(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
        if (!handled) {
          res.writeHead(418, { 'Content-Type': 'application/json' });
          res.end('{"error":"not mine"}');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    setAppsService(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    w = world();
    setAppsService(createAppsService(w.deps));
  });

  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('declines paths that are not its own', async () => {
    expect((await fetch(`${base}/api/verse/appsx`)).status).toBe(418);
    expect((await fetch(`${base}/api/verse/health`)).status).toBe(418);
  });

  it('GET /api/verse/apps answers the three groups it owns', async () => {
    const res = await fetch(`${base}/api/verse/apps`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as VerseAppsResponse;
    expect(body.groups.map((g) => g.id)).toEqual(['desktop', 'terminal-agents', 'local-models']);
    expect(JSON.stringify(body)).not.toContain(HOME);
  });

  it('POST refresh takes an empty body and nothing else', async () => {
    expect((await post('/api/verse/apps/refresh', {})).status).toBe(200);
    expect((await post('/api/verse/apps/refresh', { force: true })).status).toBe(400);
  });

  it('toggle: confirm:true is required, enabled must be boolean, unknown keys are 400', async () => {
    expect((await post('/api/verse/apps/claude-desktop/toggle', { enabled: false })).status).toBe(400);
    expect((await post('/api/verse/apps/claude-desktop/toggle', { enabled: false, confirm: 'yes' })).status).toBe(400);
    expect((await post('/api/verse/apps/claude-desktop/toggle', { enabled: 'no', confirm: true })).status).toBe(400);
    expect((await post('/api/verse/apps/claude-desktop/toggle', { enabled: false, confirm: true, extra: 1 })).status).toBe(400);
    expect(w.scripts).toHaveLength(0);
    const ok = await post('/api/verse/apps/claude-desktop/toggle', { enabled: false, confirm: true });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ ok: true, opened: 'terminal-app', command: ['ollama', 'launch', 'claude-desktop', '--restore'] });
    expect(w.scripts).toHaveLength(1);
  });

  it('launch: validates root, via and model before anything opens', async () => {
    expect((await post('/api/verse/apps/codex/launch', {})).status).toBe(400);
    expect((await post('/api/verse/apps/codex/launch', { root: '/Users/op/code/ashlr-hub', via: 'shell' })).status).toBe(400);
    expect((await post('/api/verse/apps/codex/launch', { root: '/Users/op/code/ashlr-hub', model: 7 })).status).toBe(400);
    expect((await post('/api/verse/apps/codex/launch', { root: '/Users/op/code/ashlr-hub', cwd: '/' })).status).toBe(400);
    expect(w.scripts).toHaveLength(0);
    const ok = await post('/api/verse/apps/codex/launch', { root: '/Users/op/code/ashlr-hub' });
    expect(ok.status).toBe(202);
    expect(w.scripts).toHaveLength(1);
  });

  it('unknown ids and verbs are 404; wrong methods are 405', async () => {
    expect((await post('/api/verse/apps/Codex/launch', { root: '/x' })).status).toBe(404);
    expect((await post('/api/verse/apps/codex/delete', {})).status).toBe(404);
    expect((await post('/api/verse/apps/nope/toggle', { enabled: true, confirm: true })).status).toBe(404);
    expect((await fetch(`${base}/api/verse/apps/codex/launch`)).status).toBe(405);
    expect((await post('/api/verse/apps', {})).status).toBe(405);
    expect((await fetch(`${base}/api/verse/apps/refresh`)).status).toBe(405);
  });
});
