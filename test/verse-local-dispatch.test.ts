/**
 * test/verse-local-dispatch.test.ts — the local seat DISPATCH lane.
 *
 * A Verse local seat has always been "the plain `claude` binary with
 * ANTHROPIC_BASE_URL pointed at Ollama". Ollama serialises this model
 * architecture, so that lane is a queue rather than a fleet; llama-server is
 * not, but Claude Code cannot talk to it directly — only through the Anthropic
 * normalising proxy in front of it.
 *
 * These tests pin the two things that make moving lanes safe:
 *
 *  1. DISCOVERY NEVER MOVES. `/api/tags` and `/api/show` are Ollama's, and
 *     llama-server implements neither. Opting into the llama-server lane must
 *     change where turns GO and nothing about how seats are FOUND.
 *  2. THE DEFAULT IS UNTOUCHED. With nobody opted in, the discovery payload
 *     and the persisted launch record must be byte-identical to what they were
 *     before lanes existed — a llama-server that is not running cannot be
 *     allowed to cost anyone the Ollama lane that works today.
 *
 *  3. (V3.9) THE WINDOW FOLLOWS THE LANE. llama-server allocates context per
 *     slot (`-c 262144 --parallel 4` is 65536 each), whatever the tag's
 *     Modelfile says, so on that lane a seat's window is the slot's — read back
 *     from `/props` — and on the Ollama lane it is Ollama's.
 *
 * Hermetic: a real loopback HTTP server plays Ollama and another plays
 * llama-server's `/props`; the proxy address comes from
 * LLAMA_SERVER_ANTHROPIC_BASE_URL, which short-circuits the resolver before it
 * touches config or the process table, and every llama-lane discovery names
 * its llama-server origin explicitly so a real server on :8080 can never
 * answer. HOME is relocated (the window resolver reads ~/.ollama/logs and the
 * llama ownership record). Nothing here dispatches a turn, and no llama-server
 * is started or stopped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import { discoverSeats, resolveVerseLocalDispatch } from '../src/core/verse/seats.js';
import { claudeAdapter, anthropicEnvBaseUrl } from '../src/core/verse/adapters/claude.js';
import type { VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import type { VerseSeat, VerseSession } from '../src/core/verse/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROXY_BASE = 'http://127.0.0.1:8081/v1';

function makeConfig(verse?: Record<string, unknown>): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    ...(verse ? { verse } : {}),
  } as AshlrConfig;
}

interface FakeOllama {
  baseUrl: string;
  /** Every tag `/api/show` was asked about — proof discovery stayed here. */
  showCalls: string[];
  close(): Promise<void>;
}

/**
 * The smallest runtime that answers the two DISCOVERY endpoints. It returns no
 * `capabilities` key, so seat visibility falls back to the legacy name
 * heuristic — which both tags below satisfy.
 */
function startFakeOllama(): Promise<FakeOllama> {
  const showCalls: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen3-coder-next:ctx64k' }, { name: 'llama3.2:3b' }] }));
      return;
    }
    if (req.method === 'POST' && url === '/api/show') {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
      req.on('end', () => {
        try { showCalls.push(String((JSON.parse(raw) as { name?: string }).name ?? '')); } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model_info: {} }));
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
        close: () => new Promise<void>((done) => server.close(() => { done(); })),
      });
    });
  });
}

const LOCAL_SEAT: VerseSeat = {
  id: 'local:qwen3-coder-next:ctx64k',
  engine: 'local',
  label: 'Qwen3-Coder-Next ctx64k (local)',
  accountId: 'local',
  models: [{ id: 'qwen3-coder-next:ctx64k', label: 'Qwen3-Coder-Next', contextWindow: 65_536 }],
  contextWindow: 65_536,
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};

function localSession(): VerseSession {
  return {
    id: 'session-1',
    title: 'x',
    projectPath: '/tmp/project',
    engine: 'local',
    accountId: 'local',
    seatId: LOCAL_SEAT.id,
    model: 'qwen3-coder-next:ctx64k',
    nativeSessionId: '11111111-2222-3333-4444-555555555555',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle',
    turnCount: 0,
    usage: {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, contextTokens: 0, contextWindow: 65_536,
    },
    lastError: null,
  };
}

function launch(overrides: Partial<VerseSeatLaunch> = {}): VerseSeatLaunch {
  return { seat: LOCAL_SEAT, launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434', ...overrides };
}

// ---------------------------------------------------------------------------

/**
 * The two llama-server endpoints the per-slot window is read from, shaped as
 * the real b10964 server answers them (`-c 262144 --parallel 4`).
 */
function startFakeLlamaServer(opts: { perSlot: number; slots: number }): Promise<{ origin: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    hits.push(url);
    res.writeHead(url === '/props' || url === '/slots' ? 200 : 404, { 'Content-Type': 'application/json' });
    if (url === '/props') {
      res.end(JSON.stringify({ total_slots: opts.slots, default_generation_settings: { n_ctx: opts.perSlot } }));
    } else if (url === '/slots') {
      res.end(JSON.stringify(Array.from({ length: opts.slots }, (_, id) => ({ id, n_ctx: opts.perSlot }))));
    } else {
      res.end('{}');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise<void>((done) => server.close(() => { done(); })),
      });
    });
  });
}

/** A port nothing listens on: the llama-server probe is refused at once. */
const NO_LLAMA = 'http://127.0.0.1:1';

let ollama: FakeOllama | null = null;
let llama: { origin: string; hits: string[]; close(): Promise<void> } | null = null;
const ENV_KEYS = [
  'ASHLR_VERSE_LOCAL_DISPATCH',
  'LLAMA_SERVER_ANTHROPIC_BASE_URL',
  'LLAMA_SERVER_BASE_URL',
  'OLLAMA_CONTEXT_LENGTH',
  'HOME',
] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmpHome: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-local-dispatch-home-'));
  process.env.HOME = tmpHome;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (ollama) { await ollama.close(); ollama = null; }
  if (llama) { await llama.close(); llama = null; }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('resolveVerseLocalDispatch', () => {
  it('defaults to the Ollama lane when nobody has opted in', () => {
    expect(resolveVerseLocalDispatch(makeConfig())).toBe('ollama');
  });

  it('reads config, then env, then an explicit argument — each beating the last', () => {
    expect(resolveVerseLocalDispatch(makeConfig({ localDispatch: 'llama-server' }))).toBe('llama-server');

    // Env outranks config: an operator can try the lane for one run without
    // editing a file that a launchd job would then inherit forever.
    process.env['ASHLR_VERSE_LOCAL_DISPATCH'] = 'ollama';
    expect(resolveVerseLocalDispatch(makeConfig({ localDispatch: 'llama-server' }))).toBe('ollama');

    // An explicit argument outranks both (the seam tests use).
    expect(resolveVerseLocalDispatch(makeConfig({ localDispatch: 'ollama' }), 'llama-server')).toBe('llama-server');
  });

  it('accepts the obvious spellings and treats anything else as no choice at all', () => {
    for (const spelling of ['llama-server', 'llama', 'LlamaServer', '  LLAMA-SERVER  ']) {
      process.env['ASHLR_VERSE_LOCAL_DISPATCH'] = spelling;
      expect(resolveVerseLocalDispatch(makeConfig())).toBe('llama-server');
    }
    // Junk is not a lane. It must land on the one that works, never on the one
    // that needs a process nobody has started.
    for (const junk of ['vllm', '', '   ', 'true']) {
      process.env['ASHLR_VERSE_LOCAL_DISPATCH'] = junk;
      expect(resolveVerseLocalDispatch(makeConfig())).toBe('ollama');
    }
    delete process.env['ASHLR_VERSE_LOCAL_DISPATCH'];
    expect(resolveVerseLocalDispatch(makeConfig({ localDispatch: 42 }))).toBe('ollama');
  });
});

describe('discoverSeats — the default lane is untouched', () => {
  it('carries no dispatch override at all, so the payload and launch record are unchanged', async () => {
    ollama = await startFakeOllama();
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: '/nonexistent/accounts',
      ollamaBaseUrl: ollama.baseUrl,
      claudeUsage: () => ({ ok: false, reason: 'no-usage' }) as never,
    });

    // Exactly the historical shape: one `ollama` key, no `dispatch`.
    expect(discovery.localRuntime).toEqual({
      ollama: { reachable: true, baseUrl: ollama.baseUrl, models: ['qwen3-coder-next:ctx64k', 'llama3.2:3b'] },
    });
    expect('dispatch' in discovery.localRuntime).toBe(false);

    const local = discovery.launches.get('local:qwen3-coder-next:ctx64k')!;
    expect(local.ollamaBaseUrl).toBe(ollama.baseUrl);
    expect(local.anthropicBaseUrl).toBeUndefined();
    // Absent, not undefined-valued: a record written today has to deserialize
    // identically to one written before the lane existed.
    expect('anthropicBaseUrl' in local).toBe(false);
  });
});

describe('discoverSeats — the llama-server lane', () => {
  it('moves DISPATCH to the proxy while DISCOVERY stays entirely on Ollama', async () => {
    ollama = await startFakeOllama();
    process.env['LLAMA_SERVER_ANTHROPIC_BASE_URL'] = PROXY_BASE;

    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: '/nonexistent/accounts',
      ollamaBaseUrl: ollama.baseUrl,
      localDispatch: 'llama-server',
      llamaServerOrigin: NO_LLAMA,
      claudeUsage: () => ({ ok: false, reason: 'no-usage' }) as never,
    });

    // DISCOVERY: every tag still came from Ollama, and `/api/show` was still
    // asked about each one. llama-server implements neither endpoint, so a
    // change that moved these would have produced an empty seat picker.
    expect(discovery.localRuntime.ollama.reachable).toBe(true);
    expect(discovery.localRuntime.ollama.baseUrl).toBe(ollama.baseUrl);
    expect(discovery.localRuntime.ollama.models).toEqual(['qwen3-coder-next:ctx64k', 'llama3.2:3b']);
    expect(ollama.showCalls.sort()).toEqual(['llama3.2:3b', 'qwen3-coder-next:ctx64k']);
    expect(discovery.seats.map((s) => s.id))
      .toEqual(['local:qwen3-coder-next:ctx64k', 'local:llama3.2:3b']);

    // DISPATCH: the proxy, reported on the wire so the lane is visible.
    expect(discovery.localRuntime.dispatch).toEqual({ lane: 'llama-server', baseUrl: PROXY_BASE });

    for (const id of ['local:qwen3-coder-next:ctx64k', 'local:llama3.2:3b']) {
      const l = discovery.launches.get(id)!;
      expect(l.anthropicBaseUrl).toBe(PROXY_BASE);
      // The Ollama address is still recorded — it is where the seat came from.
      expect(l.ollamaBaseUrl).toBe(ollama.baseUrl);
    }
  });

  it('never leaks a dispatch address onto a native seat', async () => {
    ollama = await startFakeOllama();
    process.env['LLAMA_SERVER_ANTHROPIC_BASE_URL'] = PROXY_BASE;
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: '/nonexistent/accounts',
      ollamaBaseUrl: ollama.baseUrl,
      localDispatch: 'llama-server',
      llamaServerOrigin: NO_LLAMA,
      claudeUsage: () => ({ ok: false, reason: 'no-usage' }) as never,
    });
    for (const [id, l] of discovery.launches) {
      if (l.seat.engine === 'local') continue;
      expect(`${id}: ${String(l.anthropicBaseUrl)}`).toBe(`${id}: undefined`);
    }
  });

  it('discovers a full seat list even when nothing is listening on the proxy', async () => {
    // THE FAILURE THIS GUARDS: resolving the dispatch address must be an
    // address lookup, not a probe. A proxy that is not running (the normal
    // state of this machine — it only exists while some process hosts it)
    // would otherwise stall or empty the seat picker, which is exactly the
    // "a local runtime that is not running breaks the lane that works"
    // outcome the opt-in exists to prevent.
    ollama = await startFakeOllama();
    process.env['LLAMA_SERVER_ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:1/v1';
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: '/nonexistent/accounts',
      ollamaBaseUrl: ollama.baseUrl,
      localDispatch: 'llama-server',
      llamaServerOrigin: NO_LLAMA,
      claudeUsage: () => ({ ok: false, reason: 'no-usage' }) as never,
    });
    expect(discovery.seats.map((s) => s.id))
      .toEqual(['local:qwen3-coder-next:ctx64k', 'local:llama3.2:3b']);
    expect(discovery.launches.get('local:qwen3-coder-next:ctx64k')!.anthropicBaseUrl)
      .toBe('http://127.0.0.1:1/v1');
    expect(discovery.localRuntime.ollama.reachable).toBe(true);
  });
});

describe('claude adapter — engine=local', () => {
  it('points ANTHROPIC_BASE_URL at the launch record’s dispatch address', () => {
    const l = claudeAdapter.buildLaunch(localSession(), 'hi', launch({ anthropicBaseUrl: PROXY_BASE }));
    // The origin, not the `/v1` URL: Claude Code appends `/v1/messages` itself.
    expect(l.env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:8081');
    expect(l.env['ANTHROPIC_AUTH_TOKEN']).toBe('ollama');
    expect(l.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1');
    // The Ollama address is recorded on the launch but must not be dispatched to.
    expect(Object.values(l.env)).not.toContain('http://127.0.0.1:11434');
  });

  it('falls back to the Ollama address for a record written before lanes existed', () => {
    const l = claudeAdapter.buildLaunch(localSession(), 'hi', launch());
    expect(l.env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:11434');
  });

  it('strips /v1 and trailing slashes from either lane’s spelling', () => {
    expect(anthropicEnvBaseUrl('http://127.0.0.1:8081/v1')).toBe('http://127.0.0.1:8081');
    expect(anthropicEnvBaseUrl('http://127.0.0.1:8081/v1/')).toBe('http://127.0.0.1:8081');
    expect(anthropicEnvBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(anthropicEnvBaseUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
  });
});

describe('discoverSeats — the window follows the lane (V3.9)', () => {
  it('on the llama-server lane, every seat gets one slot\'s context, read back from /props', async () => {
    ollama = await startFakeOllama();
    llama = await startFakeLlamaServer({ perSlot: 65_536, slots: 4 });
    process.env['LLAMA_SERVER_ANTHROPIC_BASE_URL'] = PROXY_BASE;
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: '/nonexistent/accounts',
      ollamaBaseUrl: ollama.baseUrl,
      localDispatch: 'llama-server',
      llamaServerOrigin: llama.origin,
      claudeUsage: () => ({ ok: false, reason: 'no-usage' }) as never,
    });
    for (const seat of discovery.seats) {
      expect(seat.contextWindow, seat.id).toBe(65_536);
      expect(seat.models[0]!.windowSource, seat.id).toBe('runtime');
      expect(seat.models[0]!.autoCompactAt, seat.id).toBe(32_536);
      expect(seat.notes, seat.id).toBeUndefined();
    }
    expect(llama.hits).toContain('/props');
    // Discovery itself never moved: Ollama still answered /api/show for each tag.
    expect(ollama.showCalls.sort()).toEqual(['llama3.2:3b', 'qwen3-coder-next:ctx64k']);
  });

  it('when llama-server does not answer, falls back to Ollama\'s figure and says so', async () => {
    ollama = await startFakeOllama();
    process.env['LLAMA_SERVER_ANTHROPIC_BASE_URL'] = PROXY_BASE;
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: '/nonexistent/accounts',
      ollamaBaseUrl: ollama.baseUrl,
      localDispatch: 'llama-server',
      llamaServerOrigin: NO_LLAMA,
      ollamaServerDefault: null,
      claudeUsage: () => ({ ok: false, reason: 'no-usage' }) as never,
    });
    const seat = discovery.seats.find((s) => s.id === 'local:qwen3-coder-next:ctx64k')!;
    // This fake Ollama describes nothing, so the tag suffix is the figure.
    expect(seat.contextWindow).toBe(65_536);
    expect(seat.models[0]!.windowSource).toBe('fallback');
    expect(seat.notes?.[0]).toContain('llama-server did not report its per-slot context');
  });

  it('never probes llama-server on the default Ollama lane', async () => {
    ollama = await startFakeOllama();
    llama = await startFakeLlamaServer({ perSlot: 65_536, slots: 4 });
    const discovery = await discoverSeats(makeConfig(), {
      accountsRoot: '/nonexistent/accounts',
      ollamaBaseUrl: ollama.baseUrl,
      llamaServerOrigin: llama.origin,
      ollamaServerDefault: null,
      claudeUsage: () => ({ ok: false, reason: 'no-usage' }) as never,
    });
    expect(llama.hits).toEqual([]);
    expect(discovery.seats.every((s) => s.models[0]!.windowSource !== 'runtime')).toBe(true);
  });
});
