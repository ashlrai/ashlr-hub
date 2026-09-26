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
  tagsNeedingDetail,
  localSeatPreferenceRank,
  preferredLocalTags,
  resolveAccountsRoot,
  resolveOllamaBaseUrl,
  nativeSeatModels,
  readSeatProfile,
  VERSE_CATALOG_PENDING_NOTE,
  VERSE_NATIVE_MODELS,
  VERSE_REPIN_COMMAND,
} from '../src/core/verse/seats.js';
import { DEFAULT_LOCAL_MODEL_TAG } from '../src/core/run/model-catalog.js';
import { resetModelWindowCaches } from '../src/core/verse/model-windows.js';
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

/**
 * A fake Ollama whose tag list AND per-tag `capabilities` are given by the
 * caller — the modern runtime shape, where `/api/show` reports whether a model
 * supports `tools`. `startFakeOllama` above deliberately omits `capabilities`
 * to exercise the legacy-name-heuristic fallback; this one exercises the real
 * path, and lets a test control the order `/api/tags` reports.
 */
function startFakeOllamaWith(models: ReadonlyArray<{ name: string; capabilities: string[] }>): Promise<FakeOllama> {
  const showCalls: string[] = [];
  const byName = new Map(models.map((m) => [m.name, m.capabilities]));
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: models.map((m) => ({ name: m.name })) }));
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
        res.end(JSON.stringify({ capabilities: byName.get(name) ?? [], model_info: {} }));
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
let prevOllamaCtx: string | undefined;
let ollama: FakeOllama | null = null;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-seats-home-'));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-seats-root-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // The unpinned-window default reads this; a developer's shell must not leak in.
  prevOllamaCtx = process.env.OLLAMA_CONTEXT_LENGTH;
  delete process.env.OLLAMA_CONTEXT_LENGTH;
  resetModelWindowCaches();
});

afterEach(async () => {
  if (ollama) { await ollama.close(); ollama = null; }
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevOllamaCtx === undefined) delete process.env.OLLAMA_CONTEXT_LENGTH;
  else process.env.OLLAMA_CONTEXT_LENGTH = prevOllamaCtx;
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
    // V3.9: Fable 5.1 runs at 1M on the CLI, not the 200k unknown-model
    // fallback every Claude model used to inherit.
    expect(claude.contextWindow).toBe(1_000_000);
    // This fixture's launcher has no native profile, so the pinned CLI version
    // is UNKNOWN — reported as a note, never guessed into an unavailable model.
    expect(claude.cliVersion).toBeUndefined();
    expect(claude.models.every((m) => !m.unavailableReason)).toBe(true);
    expect(claude.notes).toEqual([
      'Could not tell which Claude Code version this seat is pinned to; Opus 5.5 may silently run as an older model on an older binary.',
    ]);

    const codex = discovery.seats.find((s) => s.id === 'codex-personal')!;
    expect(codex.engine).toBe('codex');
    // The FIRST entry is what a new session defaults to, so it must be the
    // newest model the catalog offers, not whichever one was newest when this
    // test was written. Pinning a specific id here is how the Codex list went
    // stale at gpt-5.5 while the catalog had moved on to the GPT-6 family.
    expect(codex.models[0]?.id).toBe('gpt-6-astra');
    expect(codex.models.map((m) => m.id)).not.toContain('gpt-5.5-mini');
    // Hidden catalog slugs are never offered, even from the built-in list.
    expect(codex.models.map((m) => m.id)).not.toContain('gpt-reserve');
    // The EFFECTIVE window codex measures against: 272k × 95%.
    expect(codex.contextWindow).toBe(258_400);
    // No profile ⇒ no catalog of its own yet ⇒ the documented list, labelled.
    expect(codex.models.every((m) => m.windowSource === 'documented')).toBe(true);
    expect(codex.notes).toEqual([VERSE_CATALOG_PENDING_NOTE]);

    // The wire shape must never carry the launcher.
    const wire = JSON.stringify(discovery.seats);
    expect(wire).not.toContain('command');
    expect(wire).not.toContain('launcher');
    for (const part of [...CLAUDE_COMMAND, ...CODEX_COMMAND]) expect(wire).not.toContain(part);
    // V2.1 adds `capacity`, the subscription meter the seat list renders
    // without a second request. V3.9 adds `notes` (and `cliVersion` when it is
    // known — not here). Nothing else may appear.
    for (const seat of discovery.seats) expect(Object.keys(seat).sort()).toEqual(
      ['accountId', 'capacity', 'contextWindow', 'engine', 'health', 'id', 'label', 'models', 'notes'],
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
    expect(qwen.label).toBe('Qwen3-Coder-Next (64k, local)');
    // :ctx64k suffix (show returned no context_length) — a naming convention,
    // so it is labelled a fallback and the seat says the figure is an estimate.
    expect(qwen.models).toEqual([{
      id: 'qwen3-coder-next:ctx64k',
      label: 'Qwen3-Coder-Next (64k)',
      contextWindow: 65_536,
      autoCompactAt: 32_536,
      windowSource: 'fallback',
    }]);
    expect(qwen.contextWindow).toBe(65_536);
    expect(qwen.notes).toEqual(['Ollama did not describe this model; the 65,536-token context window is an estimate.']);
    expect(qwen.health.state).toBe('ready');
    // A local tag has NO subscription window. Reporting an empty meter would
    // imply a quota it does not have, so the key is simply absent.
    expect(qwen.capacity).toBeUndefined();
    expect('capacity' in qwen).toBe(false);

    const llama = discovery.seats.find((s) => s.id === 'local:llama3.2:3b')!;
    expect(llama.contextWindow).toBe(8192); // /api/show parameters.num_ctx wins over model_info context_length
    expect(llama.models[0]?.contextWindow).toBe(8192);
    expect(llama.models[0]?.windowSource).toBe('provider-catalog');
    // A pinned window is what Ollama allocates: nothing to apologise for.
    expect(llama.notes).toBeUndefined();

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

  it('surfaces the preferred local model first, whatever order /api/tags reports', async () => {
    // Ollama lists by mtime, so the model the operator actually uses sinks
    // below whatever was pulled most recently. Here the preferred tag is
    // reported LAST, and a non-tool model is reported first.
    ollama = await startFakeOllamaWith([
      { name: 'bge-m3:latest', capabilities: ['completion', 'embedding'] },
      { name: 'qwen3.8:27b-q8_0', capabilities: ['completion', 'vision', 'tools', 'thinking'] },
      { name: 'qwen3.8:27b-ctx64k', capabilities: ['completion', 'vision', 'tools', 'thinking'] },
    ]);
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot,
      ollamaBaseUrl: ollama.baseUrl,
      claudeUsage: zeroUsage,
    });

    // ctx64k (exact match on the default) first, then its q8_0 sibling (same
    // family, different variant). bge-m3 is absent: no `tools`, so it cannot
    // drive an agentic session — the capability filter still owns membership.
    expect(discovery.seats.map((s) => s.id)).toEqual([
      'local:qwen3.8:27b-ctx64k',
      'local:qwen3.8:27b-q8_0',
    ]);
    // localRuntime reports what the runtime said, unreordered and unfiltered.
    expect(discovery.localRuntime.ollama.models).toEqual([
      'bge-m3:latest',
      'qwen3.8:27b-q8_0',
      'qwen3.8:27b-ctx64k',
    ]);
  });

  it('cfg.foundry.models[local-coder] outranks the built-in default for seat order', async () => {
    ollama = await startFakeOllamaWith([
      { name: 'qwen3.8:27b-ctx64k', capabilities: ['completion', 'tools', 'thinking'] },
      { name: 'devstral:24b', capabilities: ['completion', 'tools'] },
    ]);
    const cfg = makeConfig({ foundry: { models: { 'local-coder': 'devstral:24b' } } } as Partial<AshlrConfig>);
    const discovery = await discoverSeats(cfg, {
      accountsRoot: tmpRoot,
      ollamaBaseUrl: ollama.baseUrl,
      claudeUsage: zeroUsage,
    });
    expect(discovery.seats.map((s) => s.id)).toEqual(['local:devstral:24b', 'local:qwen3.8:27b-ctx64k']);
  });

  it('helpers: preferred tags + preference rank', () => {
    // No override: the built-in default is the sole preference.
    expect(preferredLocalTags(makeConfig())).toEqual(['qwen3.8:27b-ctx64k']);
    // An override leads; the default still backs it up rather than vanishing.
    expect(preferredLocalTags(makeConfig({ foundry: { models: { 'local-coder': 'devstral:24b' } } } as Partial<AshlrConfig>)))
      .toEqual(['devstral:24b', 'qwen3.8:27b-ctx64k']);
    // An override that IS the default is not duplicated.
    expect(preferredLocalTags(makeConfig({ foundry: { models: { 'local-coder': 'qwen3.8:27b-ctx64k' } } } as Partial<AshlrConfig>)))
      .toEqual(['qwen3.8:27b-ctx64k']);

    const preferred = ['qwen3.8:27b-ctx64k', 'devstral:24b'];
    expect(localSeatPreferenceRank('qwen3.8:27b-ctx64k', preferred)).toBe(0);
    expect(localSeatPreferenceRank('QWEN3.8:27B-CTX64K', preferred)).toBe(0); // case-insensitive
    expect(localSeatPreferenceRank('devstral:24b', preferred)).toBe(1);
    expect(localSeatPreferenceRank('qwen3.8:27b-q8_0', preferred)).toBe(2); // same family
    expect(localSeatPreferenceRank('devstral:latest', preferred)).toBe(3);  // same family
    expect(localSeatPreferenceRank('llama3.2:3b', preferred)).toBe(4);      // unrelated
    expect(localSeatPreferenceRank('llama3.2:3b', [])).toBe(0);             // no preference: all equal
  });

  it('helpers: tag suffix + label', () => {
    expect(contextWindowFromTagSuffix('qwen3-coder-next:ctx64k')).toBe(65_536);
    expect(contextWindowFromTagSuffix('qwen3-coder-next:ctx128K')).toBe(131_072);
    // The house default: the suffix follows a HYPHEN. The old `/:ctx(\d+)k$/`
    // missed it entirely.
    expect(contextWindowFromTagSuffix('qwen3.8:27b-ctx64k')).toBe(65_536);
    expect(contextWindowFromTagSuffix('qwen3-coder:30b-ctx64k')).toBe(65_536);
    expect(contextWindowFromTagSuffix('custom_ctx32k')).toBe(32_768);
    expect(contextWindowFromTagSuffix('llama3.2:3b')).toBeNull();
    expect(contextWindowFromTagSuffix('qwen3.8:27b-q8_0')).toBeNull();
    expect(contextWindowFromTagSuffix('bigctx64k')).toBeNull(); // not a separated suffix
    expect(contextWindowFromTagSuffix('x:ctx0k')).toBeNull();
    expect(localSeatLabel('deepseek-coder-v2:16b')).toBe('DeepSeek-Coder-V2 16B (local)');
    expect(localSeatLabel('llama3.2:latest')).toBe('Llama3.2 (local)');
  });

  it('local seat labels fold the window into one parenthetical with "local"', () => {
    expect(localSeatLabel('qwen3.8:27b-ctx64k')).toBe('Qwen3.8 27B (64k, local)');
    expect(localSeatLabel('gpt-oss:20b')).toBe('gpt-oss 20B (local)');
  });

  it('keeps two quantizations of one model apart, and leaves a unique one clean', () => {
    const tags = ['qwen3.8:27b-q8_0', 'qwen3.8:27b-q4_K_M', 'gpt-oss:20b'];
    const need = tagsNeedingDetail(tags);
    expect([...need].sort()).toEqual(['qwen3.8:27b-q4_K_M', 'qwen3.8:27b-q8_0']);
    expect(localSeatLabel('qwen3.8:27b-q8_0', need.has('qwen3.8:27b-q8_0'))).toBe('Qwen3.8 27B · q8_0 (local)');
    expect(localSeatLabel('gpt-oss:20b', need.has('gpt-oss:20b'))).toBe('gpt-oss 20B (local)');
  });
});

// ---------------------------------------------------------------------------
// V3.9 — models from each seat's OWN catalog and pinned binary
// ---------------------------------------------------------------------------

/**
 * A native profile laid out exactly as `ashlr resources profile prepare` writes
 * it: `<dir>/launcher.mjs` (what connections.json's command names) beside
 * `<dir>/profile.json` (provider, executable, nativeStatePath).
 */
function makeProfile(
  base: string,
  id: string,
  provider: 'claude' | 'codex' | 'grok',
  opts: { executable?: string; manifestProvider?: string } = {},
): { command: string[]; dir: string; nativeState: string } {
  const dir = path.join(base, '.ashlr', 'native-profiles', id);
  const nativeState = path.join(dir, 'native-state');
  fs.mkdirSync(nativeState, { recursive: true });
  const launcher = path.join(dir, 'launcher.mjs');
  fs.writeFileSync(launcher, '// launcher\n');
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({
    schemaVersion: 1,
    provider: opts.manifestProvider ?? provider,
    directory: dir,
    ...(opts.executable ? { executable: opts.executable } : {}),
    nativeStatePath: nativeState,
    launcherPath: launcher,
    command: ['/usr/bin/node', launcher],
  }));
  return { command: ['/usr/bin/node', launcher], dir, nativeState };
}

function writeClaudeVersions(root: string, versions: string[]): void {
  fs.mkdirSync(root, { recursive: true });
  for (const v of versions) fs.writeFileSync(path.join(root, v), 'binary');
}

function writeConnections(root: string, accounts: Array<{ id: string; label: string; provider: string; command: string[] }>): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'connections.json'), JSON.stringify({ accounts }));
}

const CODEX_ROW = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  display_name: slug,
  visibility: 'list',
  context_window: 272_000,
  max_context_window: 872_000,
  effective_context_window_percent: 95,
  auto_compact_token_limit: null,
  ...extra,
});

const GROK_SECRET = 'xai-seat-secret-must-not-surface-42';

describe('verse seats — per-seat catalogs and pinned binaries (V3.9)', () => {
  it('lists Opus 5.5 as unavailable on a 2.1.257 pin and names the installed fix', async () => {
    const versions = path.join(tmpHome, '.local', 'share', 'claude', 'versions');
    writeClaudeVersions(versions, ['2.1.243', '2.1.257', '2.1.280']);
    const profile = makeProfile(tmpHome, 'claude-a', 'claude', { executable: path.join(versions, '2.1.257') });
    writeConnections(tmpRoot, [{ id: 'claude-a', label: 'Claude A', provider: 'claude', command: profile.command }]);

    const discovery = await discoverSeats(makeConfig(), { accountsRoot: tmpRoot, claudeUsage: zeroUsage, collector: null });
    const seat = discovery.seats.find((s) => s.id === 'claude-a')!;
    expect(seat.cliVersion).toBe('2.1.257');

    // The default is RUNNABLE: the gated model sinks to the end, listed with
    // its reason rather than hidden, so the operator learns why.
    expect(seat.models[0]!.id).toBe('claude-fable-5-1');
    const last = seat.models[seat.models.length - 1]!;
    expect(last.id).toBe('claude-opus-5-5');
    expect(last.unavailableReason).toBe('needs Claude Code 2.1.280; this seat runs 2.1.257');
    expect(seat.models.slice(0, -1).every((m) => !m.unavailableReason)).toBe(true);
    expect(seat.contextWindow).toBe(1_000_000);

    expect(seat.notes).toEqual([
      'Pinned to Claude Code 2.1.257; 2.1.280 is installed — Opus 5.5 needs it. '
      + 'Re-pin with: ashlr resources profile repin --directory ~/.ashlr/native-profiles/claude-a '
      + '--executable ~/.local/share/claude/versions/2.1.280',
    ]);
    // Remediation text is home-relative; the private state path never appears.
    const wire = JSON.stringify(discovery.seats);
    expect(wire).not.toContain(tmpHome);
    expect(wire).not.toContain('native-state');
    expect(wire).not.toContain('launcher.mjs');
  });

  it('names a repin command the CLI actually routes', () => {
    // The note is copy-paste remediation. `ashlr` routes `resources` → `profile`
    // (src/cli/resources.ts) and the profile CLI owns `repin`; its own usage
    // text spells the full command, so a drifted spelling fails here.
    expect(VERSE_REPIN_COMMAND).toBe('ashlr resources profile repin');
    const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli', 'resource-profile.ts'), 'utf8');
    expect(cli).toContain(`${VERSE_REPIN_COMMAND} --directory`);
    expect(cli).toContain('--dry-run');
  });

  it('says a newer binary is needed when none is installed', async () => {
    const versions = path.join(tmpRoot, 'versions');
    writeClaudeVersions(versions, ['2.1.257']);
    const profile = makeProfile(tmpRoot, 'claude-a', 'claude', { executable: path.join(versions, '2.1.257') });
    const built = nativeSeatModels('claude', readSeatProfile(profile.command, 'claude'), { claudeVersionsRoot: versions });
    expect(built.cliVersion).toBe('2.1.257');
    expect(built.notes).toEqual([
      'Pinned to Claude Code 2.1.257; Opus 5.5 needs 2.1.280 or newer, which is not installed on this machine.',
    ]);
  });

  it('offers every model, runnable, in table order on a 2.1.280 pin — with no notes', async () => {
    const versions = path.join(tmpRoot, 'versions');
    writeClaudeVersions(versions, ['2.1.280']);
    const profile = makeProfile(tmpRoot, 'claude-b', 'claude', { executable: path.join(versions, '2.1.280') });
    writeConnections(tmpRoot, [{ id: 'claude-b', label: 'Claude B', provider: 'claude', command: profile.command }]);
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot, claudeUsage: zeroUsage, collector: null, claudeVersionsRoot: versions,
    });
    const seat = discovery.seats[0]!;
    expect(seat.models.map((m) => m.id)).toEqual(VERSE_NATIVE_MODELS.claude.map((m) => m.id));
    expect(seat.models[1]).toMatchObject({ id: 'claude-opus-5-5', unavailableReason: null, contextWindow: 1_000_000, autoCompactAt: 367_000 });
    expect(seat.models[1]!.expansive).toEqual({ contextWindow: 1_000_000, autoCompactAt: 967_000 });
    expect(seat.notes).toBeUndefined();
    expect('notes' in seat).toBe(false);
    expect(seat.cliVersion).toBe('2.1.280');
  });

  it('builds codex and grok seats from their OWN catalogs, never the global homes', async () => {
    // A global ~/.codex catalog with a slug the seat's does not have: it must
    // not leak into the seat (catalogs differ per account).
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.codex', 'models_cache.json'), JSON.stringify({
      models: [CODEX_ROW('gpt-daybreak-blue-latest')],
    }));

    const codex = makeProfile(tmpRoot, 'codex-b', 'codex', { executable: '/Applications/ChatGPT.app/Contents/Resources/codex' });
    fs.writeFileSync(path.join(codex.nativeState, 'models_cache.json'), JSON.stringify({
      client_version: '0.155.0',
      models: [
        CODEX_ROW('gpt-6-astra', { display_name: 'GPT-6-Astra', priority: 1 }),
        CODEX_ROW('gpt-reserve', { visibility: 'hide', priority: 3 }),
        CODEX_ROW('gpt-5.5', { display_name: 'GPT-5.5', max_context_window: 272_000, priority: 12 }),
      ],
    }));
    const grok = makeProfile(tmpRoot, 'grok-a', 'grok', { executable: '/Users/x/.grok/downloads/grok-0.2.118-macos-aarch64' });
    fs.writeFileSync(path.join(grok.nativeState, 'models_cache.json'), JSON.stringify({
      grok_version: '0.2.118',
      models: {
        'grok-4.7-build-fast': {
          info: { id: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast', context_window: 500_000, auto_compact_threshold_percent: 80, hidden: false, supported_in_api: true },
          api_key: GROK_SECRET,
          env_key: null,
          api_base_url: null,
        },
      },
    }));
    writeConnections(tmpRoot, [
      { id: 'codex-b', label: 'Codex B', provider: 'codex', command: codex.command },
      { id: 'grok-a', label: 'Grok', provider: 'grok', command: grok.command },
    ]);

    const discovery = await discoverSeats(makeConfig(), { accountsRoot: tmpRoot, claudeUsage: zeroUsage, collector: null });
    const codexSeat = discovery.seats.find((s) => s.id === 'codex-b')!;
    expect(codexSeat.models.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.5']);
    expect(codexSeat.models[0]).toMatchObject({
      label: 'GPT-6-Astra', contextWindow: 258_400, autoCompactAt: 244_800, windowSource: 'provider-catalog',
    });
    expect(codexSeat.models[0]!.expansive).toEqual({ contextWindow: 828_400, autoCompactAt: 784_800, providerWindow: 872_000 });
    expect(codexSeat.contextWindow).toBe(258_400);
    expect(codexSeat.notes).toBeUndefined();
    // The ChatGPT.app binary does not carry its version in its path: unknown.
    expect(codexSeat.cliVersion).toBeUndefined();

    const grokSeat = discovery.seats.find((s) => s.id === 'grok-a')!;
    expect(grokSeat.models).toEqual([{
      id: 'grok-4.7-build-fast',
      label: 'Grok 4.7 Fast',
      contextWindow: 500_000,
      autoCompactAt: 400_000,
      windowSource: 'provider-catalog',
      minCliVersion: null,
      unavailableReason: null,
    }]);
    expect(grokSeat.contextWindow).toBe(500_000);
    expect(grokSeat.cliVersion).toBe('0.2.118');

    const wire = JSON.stringify(discovery.seats);
    expect(wire).not.toContain(GROK_SECRET);
    expect(wire).not.toContain('daybreak');
    expect(wire).not.toContain('gpt-reserve');
    expect(wire).not.toContain(tmpRoot);
  });

  it('falls back to the documented list, with a note, before a seat fetches its catalog', async () => {
    const codex = makeProfile(tmpRoot, 'codex-a', 'codex');
    writeConnections(tmpRoot, [{ id: 'codex-a', label: 'Codex A', provider: 'codex', command: codex.command }]);
    const discovery = await discoverSeats(makeConfig(), { accountsRoot: tmpRoot, claudeUsage: zeroUsage, collector: null });
    const seat = discovery.seats[0]!;
    expect(seat.models.map((m) => m.id)).toEqual(VERSE_NATIVE_MODELS.codex.map((m) => m.id));
    expect(seat.models.every((m) => m.windowSource === 'documented')).toBe(true);
    expect(seat.notes).toEqual([VERSE_CATALOG_PENDING_NOTE]);
  });

  it('ignores a profile whose provider disagrees with the account', async () => {
    const wrong = makeProfile(tmpRoot, 'mixed', 'codex', { manifestProvider: 'grok' });
    fs.writeFileSync(path.join(wrong.nativeState, 'models_cache.json'), JSON.stringify({ models: [CODEX_ROW('gpt-only-here')] }));
    expect(readSeatProfile(wrong.command, 'codex')).toBeNull();
    const built = nativeSeatModels('codex', readSeatProfile(wrong.command, 'codex'));
    expect(built.models.map((m) => m.id)).not.toContain('gpt-only-here');
    expect(built.notes).toEqual([VERSE_CATALOG_PENDING_NOTE]);
  });

  it('reads nothing when the launcher is not a native profile', () => {
    expect(readSeatProfile(['/opt/private/launchers/claude-max-profile'], 'claude')).toBeNull();
    expect(readSeatProfile(['node', 'relative/launcher.mjs'], 'claude')).toBeNull();
    const dir = path.join(tmpRoot, 'bad-profile');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'launcher.mjs'), '');
    fs.writeFileSync(path.join(dir, 'profile.json'), '{ nope');
    expect(readSeatProfile(['/usr/bin/node', path.join(dir, 'launcher.mjs')], 'claude')).toBeNull();
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ provider: 'claude', executable: 'relative/claude', nativeStatePath: 42 }));
    expect(readSeatProfile(['/usr/bin/node', path.join(dir, 'launcher.mjs')], 'claude')).toEqual({
      directory: dir, executable: null, nativeStatePath: null,
    });
  });
});

// ---------------------------------------------------------------------------
// V3.9 — the local window precedence, end to end through discovery
// ---------------------------------------------------------------------------

interface ShowFixture { parameters?: string; native?: number | null }

/** An injected fetch playing Ollama: `/api/tags`, `/api/show` per tag, `/api/ps`. */
function ollamaFetch(
  models: Record<string, ShowFixture>,
  resident: Array<{ name: string; context_length: number }> = [],
  calls: string[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.endsWith('/api/tags')) {
      calls.push('tags');
      return reply({ models: Object.keys(models).map((name) => ({ name })) });
    }
    if (url.endsWith('/api/ps')) {
      calls.push('ps');
      return reply({ models: resident });
    }
    if (url.endsWith('/api/show')) {
      const name = String((JSON.parse(String(init?.body ?? '{}')) as { name?: string }).name ?? '');
      calls.push(`show:${name}`);
      const fx = models[name] ?? {};
      return reply({
        capabilities: ['completion', 'tools'],
        ...(fx.parameters ? { parameters: fx.parameters } : {}),
        model_info: fx.native ? { 'general.architecture': 'qwen35', 'qwen35.context_length': fx.native } : {},
      });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

describe('verse seats — local context windows (V3.9 precedence)', () => {
  it('pinned num_ctx is capped at the trained length; unpinned tags get Ollama\'s real default', async () => {
    const calls: string[] = [];
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot,
      claudeUsage: zeroUsage,
      ollamaBaseUrl: 'http://ollama.test',
      ollamaServerDefault: { contextLength: 131_072, source: 'server-log-vram' },
      fetchImpl: ollamaFetch({
        'qwen3.8:27b-ctx64k': { parameters: 'num_ctx                        65536', native: 262_144 },
        'bigpin:latest': { parameters: 'num_ctx 300000', native: 262_144 },
        'qwen3.8:27b-q8_0': { native: 262_144 },
        'qwen-loaded:7b': { native: 262_144 },
        'tiny-coder:1b': { native: 8_192 },
      }, [{ name: 'qwen-loaded:7b', context_length: 16_384 }], calls),
    });
    const win = (tag: string) => {
      const seat = discovery.seats.find((s) => s.id === `local:${tag}`)!;
      return { window: seat.contextWindow, source: seat.models[0]!.windowSource, notes: seat.notes };
    };
    expect(win('qwen3.8:27b-ctx64k')).toEqual({ window: 65_536, source: 'provider-catalog', notes: undefined });
    // Ollama caps a pin above n_ctx_train itself.
    expect(win('bigpin:latest')).toEqual({ window: 262_144, source: 'provider-catalog', notes: undefined });
    // NOT the 262,144 architecture maximum: what Ollama actually allocates.
    expect(win('qwen3.8:27b-q8_0')).toEqual({ window: 131_072, source: 'provider-catalog', notes: undefined });
    // A runner resident at 16k (another client's num_ctx) does NOT define the
    // window: Verse's turns send no num_ctx, so Ollama gives them its default.
    expect(win('qwen-loaded:7b')).toEqual({ window: 131_072, source: 'provider-catalog', notes: undefined });
    // …and a default above the trained length is capped by it.
    expect(win('tiny-coder:1b')).toEqual({ window: 8_192, source: 'provider-catalog', notes: undefined });
    // With the server default known (and every native length known), /api/ps
    // is not even asked.
    expect(calls).not.toContain('ps');

    // 64k: compacts at 65536 − 20k reserve − 13k buffer. 8k: the reserve and
    // buffer swallow the window, so there is no honest compaction point.
    const pinned = discovery.seats.find((s) => s.id === 'local:qwen3.8:27b-ctx64k')!;
    expect(pinned.models[0]!.autoCompactAt).toBe(32_536);
    const tiny = discovery.seats.find((s) => s.id === 'local:tiny-coder:1b')!;
    expect(tiny.models[0]!.autoCompactAt).toBeNull();
  });

  it('uses /api/ps residency only when no server default is known', async () => {
    const calls: string[] = [];
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot,
      claudeUsage: zeroUsage,
      ollamaBaseUrl: 'http://ollama.test',
      ollamaServerDefault: { contextLength: null, source: null },
      fetchImpl: ollamaFetch({
        'qwen-loaded:7b': { native: 262_144 },
        'qwen3.8:27b-q8_0': { native: 262_144 },
      }, [{ name: 'qwen-loaded:7b', context_length: 98_304 }], calls),
    });
    const loaded = discovery.seats.find((s) => s.id === 'local:qwen-loaded:7b')!;
    expect(loaded.contextWindow).toBe(98_304);
    expect(loaded.models[0]!.windowSource).toBe('runtime');
    const idle = discovery.seats.find((s) => s.id === 'local:qwen3.8:27b-q8_0')!;
    expect(idle.contextWindow).toBe(262_144);
    expect(idle.models[0]!.windowSource).toBe('fallback');
    expect(calls.filter((c) => c === 'ps')).toHaveLength(1);
  });

  it('lists a seat whose window is too small for Claude Code with a reason, after the usable ones', async () => {
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot,
      claudeUsage: zeroUsage,
      ollamaBaseUrl: 'http://ollama.test',
      ollamaServerDefault: { contextLength: 32_768, source: 'server-log-vram' },
      fetchImpl: ollamaFetch({
        // Unpinned: gets the 32k server default — CLAUDE_CODE_MAX_CONTEXT_TOKENS
        // would make the CLI compact at 0, below its own base prompt.
        'qwen3.8:27b-q8_0': { native: 262_144 },
        'qwen3.8:27b-ctx64k': { parameters: 'num_ctx 65536', native: 262_144 },
        'qwen3.8:27b-ctx56k': { parameters: 'num_ctx 56000', native: 262_144 },
        'qwen3.8:27b-ctx48k': { parameters: 'num_ctx 49152', native: 262_144 },
      }),
    });
    // Discovery order put q8_0 first; the usable seats now lead.
    expect(discovery.seats.map((s) => s.id)).toEqual([
      'local:qwen3.8:27b-ctx64k',
      'local:qwen3.8:27b-ctx56k',
      'local:qwen3.8:27b-q8_0',
      'local:qwen3.8:27b-ctx48k',
    ]);
    const option = (id: string) => discovery.seats.find((s) => s.id === id)!.models[0]!;
    // A usable seat's wire shape is unchanged: no key at all.
    expect(option('local:qwen3.8:27b-ctx64k')).not.toHaveProperty('unavailableReason');
    // LOCAL_MIN_USABLE_WINDOW (56,000) itself is usable.
    expect(option('local:qwen3.8:27b-ctx56k')).not.toHaveProperty('unavailableReason');
    expect(option('local:qwen3.8:27b-q8_0').unavailableReason).toBe(
      'Context window 32,768 is too small for Claude Code: it would compact at ≈0k tokens, with no real room above '
      + 'its ~15k base prompt. Use a tag with a window of at least 56,000 tokens.',
    );
    expect(option('local:qwen3.8:27b-ctx48k').unavailableReason).toMatch(/49,152 is too small .* compact at ≈16k tokens/);
    // Still listed with its true window (the operator sees what it is).
    expect(discovery.seats.find((s) => s.id === 'local:qwen3.8:27b-q8_0')!.contextWindow).toBe(32_768);
  });

  it('a too-small preferred tag never becomes the default ahead of a usable one', async () => {
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot,
      claudeUsage: zeroUsage,
      ollamaBaseUrl: 'http://ollama.test',
      ollamaServerDefault: { contextLength: 32_768, source: 'server-log-vram' },
      fetchImpl: ollamaFetch({
        'other-coder:7b': { parameters: 'num_ctx 65536', native: 131_072 },
        [DEFAULT_LOCAL_MODEL_TAG]: { parameters: 'num_ctx 32768', native: 262_144 },
      }),
    });
    expect(discovery.seats[0]!.id).toBe('local:other-coder:7b');
    expect(discovery.seats[1]!.id).toBe(`local:${DEFAULT_LOCAL_MODEL_TAG}`);
    expect(discovery.seats[1]!.models[0]!.unavailableReason).toMatch(/too small for Claude Code/);
  });

  it('skips /api/ps entirely when every tag pins num_ctx', async () => {
    const calls: string[] = [];
    await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot,
      claudeUsage: zeroUsage,
      ollamaBaseUrl: 'http://ollama.test',
      ollamaServerDefault: null,
      fetchImpl: ollamaFetch({ 'qwen3.8:27b-ctx64k': { parameters: 'num_ctx 65536', native: 262_144 } }, [], calls),
    });
    expect(calls).not.toContain('ps');
  });

  it('marks the trained maximum as an estimate when Ollama\'s default cannot be read', async () => {
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot,
      claudeUsage: zeroUsage,
      ollamaBaseUrl: 'http://ollama.test',
      ollamaServerDefault: null,
      fetchImpl: ollamaFetch({ 'qwen3.8:27b-q8_0': { native: 262_144 } }),
    });
    const seat = discovery.seats[0]!;
    expect(seat.contextWindow).toBe(262_144);
    expect(seat.models[0]!.windowSource).toBe('fallback');
    expect(seat.notes).toEqual([
      "Ollama's default context for models without a pinned num_ctx could not be read; 262,144 is this model's trained maximum, and Ollama may allocate less.",
    ]);
  });

  it('reads the server default from ~/.ollama/logs/server.log when none is injected', async () => {
    const logs = path.join(tmpHome, '.ollama', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'server.log'), [
      'time=2026-09-21T01:08:55.194-04:00 level=INFO source=routes.go:1955 msg="server config" env="map[OLLAMA_CONTEXT_LENGTH:0 OLLAMA_DEBUG:INFO]"',
      'time=2026-09-21T01:08:55.358-04:00 level=INFO source=routes.go:2062 msg="vram-based default context" total_vram="23.0 GiB" default_num_ctx=4096',
    ].join('\n'));
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: tmpRoot,
      claudeUsage: zeroUsage,
      ollamaBaseUrl: 'http://ollama.test',
      fetchImpl: ollamaFetch({ 'qwen3.8:27b-q8_0': { native: 262_144 } }),
    });
    expect(discovery.seats[0]!.contextWindow).toBe(4_096);
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
