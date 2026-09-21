/**
 * Tests for src/core/verse/seats.ts + src/core/verse/projects.ts (owner B).
 *
 * Hermetic: a tmp accountsRoot holds connections.json / observations.json,
 * a real loopback HTTP server plays Ollama (/api/tags + /api/show), and
 * HOME is relocated so enrollment.json / claude usage never touch the real
 * ~/.ashlr or ~/.claude. Real server bind → real-io lane.
 *
 * The launcher `command` is the account's identity: every assertion here
 * that JSON-serializes seats also proves the command never appears.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import {
  contextWindowFromTagSuffix,
  discoverSeats,
  localSeatLabel,
  resolveAccountsRoot,
  resolveOllamaBaseUrl,
  VERSE_NATIVE_MODELS,
} from '../src/core/verse/seats.js';
import { discoverProjects } from '../src/core/verse/projects.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLAUDE_COMMAND = ['/opt/private/launchers/claude-max-profile', '--profile', 'mason-max'];
const CODEX_COMMAND = ['/opt/private/launchers/codex-personal'];

function makeConfig(overrides: Partial<AshlrConfig> & { verse?: { accountsRoot?: string } } = {}): AshlrConfig {
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
    ...overrides,
  } as AshlrConfig;
}

function writeAccounts(root: string, opts: { observations?: boolean } = {}): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify({
    accounts: [
      { id: 'claude', label: 'Claude Code', provider: 'claude', command: CLAUDE_COMMAND },
      { id: 'codex-personal', label: 'Personal Codex', provider: 'codex', command: CODEX_COMMAND },
      { id: 'broken', label: 'No command', provider: 'grok' },
      { id: 'weird', label: 'Unknown provider', provider: 'gemini', command: ['x'] },
    ],
  }));
  if (opts.observations !== false) {
    fs.writeFileSync(path.join(root, 'observations.json'), JSON.stringify([
      {
        workerId: 'claude',
        health: 'healthy',
        windows: [
          { id: '5h', usedPercent: 72, resetsAt: '2026-09-19T14:00:00.000Z' },
          { id: '7d', usedPercent: 31, resetsAt: null },
        ],
        observedAt: '2026-09-19T10:00:00.000Z',
      },
    ]));
  }
}

interface FakeOllama {
  baseUrl: string;
  close(): Promise<void>;
  showCalls: string[];
}

function startFakeOllama(): Promise<FakeOllama> {
  const showCalls: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        models: [
          { name: 'qwen3-coder-next:ctx64k' },
          { name: 'nomic-embed-text:latest' },
          { name: 'llama3.2:3b' },
        ],
      }));
      return;
    }
    if (req.method === 'POST' && url === '/api/show') {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
      req.on('end', () => {
        let name = '';
        try { name = String((JSON.parse(raw) as { name?: string }).name ?? ''); } catch { /* ignore */ }
        showCalls.push(name);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (name === 'llama3.2:3b') {
          // Real Ollama shape: `parameters` carries the Modelfile's effective
          // num_ctx while model_info reports the architecture maximum.
          res.end(JSON.stringify({
            parameters: 'num_ctx                        8192\nstop                           "<|im_end|>"\ntemperature                    0.7',
            model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 },
          }));
        } else {
          res.end(JSON.stringify({ model_info: {} }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        showCalls,
        close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

const zeroUsage = () => ({ tokens5h: 0, tokens7d: 0, messages5h: 0, messages7d: 0, readAt: Date.now(), filesScanned: 0 });

let tmpHome: string;
let tmpRoot: string;
let prevHome: string | undefined;
let ollama: FakeOllama | null = null;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-seats-home-'));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-seats-root-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(async () => {
  if (ollama) { await ollama.close(); ollama = null; }
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// seats
// ---------------------------------------------------------------------------

describe('verse seats — native accounts', () => {
  it('maps connections.json accounts to seats and keeps the launcher private', async () => {
    writeAccounts(tmpRoot);
    const discovery = await discoverSeats(makeConfig(), { accountsRoot: tmpRoot, claudeUsage: zeroUsage });

    const ids = discovery.seats.map((s) => s.id);
    expect(ids).toEqual(['claude', 'codex-personal']); // malformed entries dropped; ollama unreachable

    const claude = discovery.seats.find((s) => s.id === 'claude')!;
    expect(claude.engine).toBe('claude');
    expect(claude.label).toBe('Claude Code');
    expect(claude.accountId).toBe('claude');
    expect(claude.models.map((m) => m.id)).toEqual(VERSE_NATIVE_MODELS.claude.map((m) => m.id));
    expect(claude.contextWindow).toBe(200_000);

    const codex = discovery.seats.find((s) => s.id === 'codex-personal')!;
    expect(codex.engine).toBe('codex');
    expect(codex.models[0]?.id).toBe('gpt-5.5');
    expect(codex.contextWindow).toBe(272_000);

    // The wire shape must never carry the launcher.
    const wire = JSON.stringify(discovery.seats);
    expect(wire).not.toContain('command');
    expect(wire).not.toContain('launcher');
    for (const part of [...CLAUDE_COMMAND, ...CODEX_COMMAND]) expect(wire).not.toContain(part);
    // V2.1 adds exactly one key: `capacity`, the subscription meter the seat
    // list renders without a second request. Nothing else may appear here.
    for (const seat of discovery.seats) expect(Object.keys(seat).sort()).toEqual(
      ['accountId', 'capacity', 'contextWindow', 'engine', 'health', 'id', 'label', 'models'],
    );

    // …but the private launch map does, for the engine only.
    expect(discovery.launches.get('claude')?.launcher).toEqual(CLAUDE_COMMAND);
    expect(discovery.launches.get('codex-personal')?.launcher).toEqual(CODEX_COMMAND);
    expect(discovery.launches.get('claude')?.seat).toBe(claude);
  });

  it('maps observations.json into seat health, unknown when absent', async () => {
    writeAccounts(tmpRoot);
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot, claudeUsage: zeroUsage, collector: null,
    });
    const claude = discovery.seats.find((s) => s.id === 'claude')!;
    expect(claude.health.state).toBe('ready');
    // V2.1: Claude's `resetsAt` is STRUCTURALLY always null — the provider
    // publishes a sentence, never an instant. The seed file in this fixture
    // carries one anyway (it is operator-authored and predates the rule), and
    // the account derivation drops it rather than passing a fabricated
    // timestamp the UI would turn into a countdown.
    expect(claude.health.windows).toEqual([
      { id: '5h', usedPercent: 72, resetsAt: null },
      { id: '7d', usedPercent: 31, resetsAt: null },
    ]);
    expect(claude.health.summary).toContain('5h window 72% used');
    expect(claude.health.summary).toContain('7d window 31% used');
    expect(claude.health.observedAt).toBe('2026-09-19T10:00:00.000Z');
    // …and the capacity rides along, so the seat list needs no second request.
    expect(claude.capacity?.binding).toMatchObject({ id: '5h', usedPercent: 72, measured: true });
    expect(claude.capacity?.usability).toBe('ready');
    expect(claude.capacity?.evidenceSource).toBe('baseline');

    const codex = discovery.seats.find((s) => s.id === 'codex-personal')!;
    expect(codex.health).toEqual({ state: 'unknown', summary: null, windows: [], observedAt: null });
    // No reading at all is NOT zero: the meter has no value to draw.
    expect(codex.capacity?.binding).toBeNull();
    expect(codex.capacity?.usability).toBe('unknown');
  });

  it('adds claude rolling-window usage to the summary when available', async () => {
    writeAccounts(tmpRoot, { observations: false });
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot,
      claudeUsage: () => ({ tokens5h: 1_250_000, tokens7d: 30_400_000, messages5h: 12, messages7d: 400, readAt: 0, filesScanned: 3 }),
    });
    const claude = discovery.seats.find((s) => s.id === 'claude')!;
    expect(claude.health.state).toBe('unknown');
    expect(claude.health.summary).toBe('5h: 1.3M tokens · 7d: 30.4M tokens');
    // Token counts are not a quota reading: the capacity verdict stays unknown.
    expect(claude.capacity?.usability).toBe('unknown');
    const codex = discovery.seats.find((s) => s.id === 'codex-personal')!;
    expect(codex.health.summary).toBeNull();
  });

  it('never throws on missing or corrupt account files', async () => {
    const missing = await discoverSeats(makeConfig(), { accountsRoot: path.join(tmpRoot, 'nope'), claudeUsage: zeroUsage });
    expect(missing.seats).toEqual([]);
    expect(missing.localRuntime.ollama.reachable).toBe(false);

    fs.writeFileSync(path.join(tmpRoot, 'connections.json'), '{ not json');
    const corrupt = await discoverSeats(makeConfig(), { accountsRoot: tmpRoot, claudeUsage: zeroUsage });
    expect(corrupt.seats).toEqual([]);
  });

  it('resolves accountsRoot from cfg.verse.accountsRoot and the ollama base from cfg.models.ollama', () => {
    const cfg = makeConfig({ verse: { accountsRoot: '/tmp/x/accounts' } });
    expect(resolveAccountsRoot(cfg)).toBe('/tmp/x/accounts');
    expect(resolveAccountsRoot(cfg, '/explicit')).toBe('/explicit');
    expect(resolveAccountsRoot(makeConfig())).toBe(path.join(tmpHome, '.ashlr', 'account-connections'));
    expect(resolveOllamaBaseUrl(makeConfig({ models: { lmstudio: '', ollama: 'http://localhost:11434/v1/', providerChain: [] } })))
      .toBe('http://localhost:11434');
    expect(resolveOllamaBaseUrl(makeConfig({ models: { lmstudio: '', ollama: '', providerChain: [] } })))
      .toBe('http://127.0.0.1:11434');
  });
});

describe('verse seats — local Ollama', () => {
  it('discovers local seats from /api/tags with context windows from /api/show or the tag suffix', async () => {
    ollama = await startFakeOllama();
    writeAccounts(tmpRoot);
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot,
      ollamaBaseUrl: ollama.baseUrl,
      claudeUsage: zeroUsage,
    });

    expect(discovery.localRuntime).toEqual({
      ollama: {
        reachable: true,
        baseUrl: ollama.baseUrl,
        models: ['qwen3-coder-next:ctx64k', 'nomic-embed-text:latest', 'llama3.2:3b'],
      },
    });

    const ids = discovery.seats.map((s) => s.id);
    expect(ids).toEqual(['claude', 'codex-personal', 'local:qwen3-coder-next:ctx64k', 'local:llama3.2:3b']);
    expect(ids).not.toContain('local:nomic-embed-text:latest'); // hidden by the tag filter

    const qwen = discovery.seats.find((s) => s.id === 'local:qwen3-coder-next:ctx64k')!;
    expect(qwen.engine).toBe('local');
    expect(qwen.accountId).toBe('local');
    expect(qwen.label).toBe('Qwen3-Coder-Next ctx64k (local)');
    expect(qwen.models).toEqual([{ id: 'qwen3-coder-next:ctx64k', label: 'Qwen3-Coder-Next ctx64k', contextWindow: 65_536 }]);
    expect(qwen.contextWindow).toBe(65_536); // :ctx64k suffix (show returned no context_length)
    expect(qwen.health.state).toBe('ready');
    // A local tag has NO subscription window. Reporting an empty meter would
    // imply a quota it does not have, so the key is simply absent.
    expect(qwen.capacity).toBeUndefined();
    expect('capacity' in qwen).toBe(false);

    const llama = discovery.seats.find((s) => s.id === 'local:llama3.2:3b')!;
    expect(llama.contextWindow).toBe(8192); // /api/show parameters.num_ctx wins over model_info context_length
    expect(llama.models[0]?.contextWindow).toBe(8192);

    // V2.1: /api/show is now asked about EVERY installed tag, not just the ones
    // whose name matched a regex — that call is what reports the `tools`
    // capability, and a model without it cannot drive an agentic session. This
    // fake runtime returns no `capabilities` key (an older Ollama), so
    // visibility falls back to the legacy name heuristic, which is why the seat
    // ids above are unchanged.
    expect(ollama.showCalls.sort()).toEqual(['llama3.2:3b', 'nomic-embed-text:latest', 'qwen3-coder-next:ctx64k']);

    const local = discovery.launches.get('local:llama3.2:3b')!;
    expect(local.launcher).toBeNull();
    expect(local.ollamaBaseUrl).toBe(ollama.baseUrl);
    expect(JSON.stringify(discovery.seats)).not.toContain('command');
  });

  it('reports the runtime as unreachable without throwing', async () => {
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      claudeUsage: zeroUsage,
    });
    expect(discovery.localRuntime.ollama.reachable).toBe(false);
    expect(discovery.localRuntime.ollama.models).toEqual([]);
    expect(discovery.seats.filter((s) => s.engine === 'local')).toEqual([]);
  });

  it('helpers: tag suffix + label', () => {
    expect(contextWindowFromTagSuffix('qwen3-coder-next:ctx64k')).toBe(65_536);
    expect(contextWindowFromTagSuffix('qwen3-coder-next:ctx128K')).toBe(131_072);
    expect(contextWindowFromTagSuffix('llama3.2:3b')).toBeNull();
    expect(localSeatLabel('deepseek-coder-v2:16b')).toBe('Deepseek-Coder-V2 16b (local)');
    expect(localSeatLabel('llama3.2:latest')).toBe('Llama3.2 (local)');
  });
});

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

describe('verse projects', () => {
  it('lists existing enrolled directories, drops missing paths and codex artifacts, merges session paths', () => {
    const repoA = fs.mkdtempSync(path.join(tmpRoot, 'repo-a-'));
    const repoB = fs.mkdtempSync(path.join(tmpRoot, 'repo-b-'));
    const artifacts = path.join(tmpHome, '.codex', 'artifacts');
    const scratch = path.join(artifacts, 'scratch-1');
    fs.mkdirSync(scratch, { recursive: true });
    const notADir = path.join(tmpRoot, 'file.txt');
    fs.writeFileSync(notADir, 'x');

    fs.mkdirSync(path.join(tmpHome, '.ashlr'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.ashlr', 'enrollment.json'), JSON.stringify({
      repos: [repoA, path.join(tmpRoot, 'missing'), scratch, notADir, 42],
    }));

    const projects = discoverProjects({
      sessions: [{ projectPath: repoB }, { projectPath: repoA }, { projectPath: path.join(tmpRoot, 'gone') }],
    });
    expect(projects).toEqual([
      { path: repoA, name: path.basename(repoA), enrolled: true },
      { path: repoB, name: path.basename(repoB), enrolled: false },
    ]);
  });

  it('returns [] for a missing or corrupt registry', () => {
    expect(discoverProjects()).toEqual([]);
    fs.mkdirSync(path.join(tmpHome, '.ashlr'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.ashlr', 'enrollment.json'), '{{');
    expect(discoverProjects()).toEqual([]);
  });
});
