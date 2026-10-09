/** Real gateway handler with controlled SDK peers; no downstream processes or providers. */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runInLocusJobEnv } from '../src/core/integrations/locus-job-env.js';
import { startGateway, probeServer, callBrowserTool } from '../src/core/mcp-gateway.js';
import type { McpRegistry } from '../src/core/types.js';

type Listed = { tools: { name: string; description?: string; inputSchema?: object }[] };
type Request = { params: { name: string; arguments?: Record<string, unknown> } };
type Handler = (request?: Request) => Promise<unknown>;
type Peer = {
  listTools: Mock<(params: object, options: { timeout: number }) => Promise<Listed>>;
  callTool: Mock<(request: Request['params']) => Promise<{ content: [] }>>;
  close: Mock<() => Promise<void>>;
  onclose?: () => void;
};
const state = vi.hoisted(() => ({
  peers: new Map<string, Peer>(),
  handlers: new Map<unknown, Handler>(),
  server: null as null | { onclose?: () => void; close: Mock<() => Promise<void>> },
  attempts: [] as { command: string; args: string[]; env: Record<string, string> }[],
  connectPlans: new Map<string, Array<() => Promise<void>>>(),
}));
vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/config.js')>(),
  loadConfig: () => ({ models: {} }),
}));
vi.mock('../src/core/mcp-native.js', () => ({
  listNativeTools: () => [{ name: 'ashlr_native', inputSchema: { type: 'object' } }],
  isNativeTool: (name: string) => name === 'ashlr_native' || name === 'alpha__reserved',
  callNativeTool: async () => ({ content: [] }),
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(readonly options: { command: string; args: string[]; env: Record<string, string> }) {}
    async close() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    private name = '';
    onclose?: () => void;
    readonly listTools = vi.fn(async (_params: object, _options: { timeout: number }): Promise<Listed> => ({ tools: [{ name: 'initial' }] }));
    readonly callTool = vi.fn(async (_request: Request['params']): Promise<{ content: [] }> => ({ content: [] }));
    readonly close = vi.fn(async () => {});
    async connect(transport: { options: { command: string; args: string[]; env: Record<string, string> } }) {
      state.attempts.push({ ...transport.options, args: [...transport.options.args], env: { ...transport.options.env } });
      this.name = transport.options.command;
      state.peers.set(this.name, this);
      await state.connectPlans.get(this.name)?.shift()?.();
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    onclose?: () => void;
    readonly close = vi.fn(async () => {});
    constructor() { state.server = this; }
    setRequestHandler(schema: unknown, handler: Handler) { state.handlers.set(schema, handler); }
    async connect() {}
  },
}));

const originalNoHeal = process.env['ASHLR_NO_HEAL'];
let running: Promise<void> | undefined;
let beforeSignals: Map<'SIGINT' | 'SIGTERM', Set<(...args: unknown[]) => void>>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.peers.clear(); state.handlers.clear(); state.server = null;
  state.attempts.length = 0; state.connectPlans.clear();
  process.env['ASHLR_NO_HEAL'] = '1';
  beforeSignals = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal as 'SIGINT' | 'SIGTERM', new Set(process.listeners(signal))]));
  stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(async () => {
  state.server?.onclose?.();
  await running;
  running = undefined;
  for (const [signal, prior] of beforeSignals) for (const handler of process.listeners(signal)) {
    if (!prior.has(handler)) process.removeListener(signal, handler);
  }
  if (originalNoHeal === undefined) delete process.env['ASHLR_NO_HEAL'];
  else process.env['ASHLR_NO_HEAL'] = originalNoHeal;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function gateway(names = ['alpha', 'beta'], configured?: McpRegistry, timeoutMs = 800) {
  const registry: McpRegistry = configured ?? { servers: names.map((name) => ({ name, command: name, args: [], source: 'test' })) };
  running = startGateway(registry, timeoutMs);
  // Startup performs its real asynchronous connection/listing path first.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(state.server?.onclose).toBeTypeOf('function');
  expect([...state.peers.keys()], JSON.stringify(stderr.mock.calls)).toEqual(names);
  return {
    list: () => state.handlers.get(ListToolsRequestSchema)!() as Promise<Listed>,
    call: (name: string) => state.handlers.get(CallToolRequestSchema)!({ params: { name } }),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('gateway live tools discovery', () => {
  it('starts every lookup independently and merges reverse completion in registry order', async () => {
    const g = await gateway();
    const alpha = deferred<Listed>(), beta = deferred<Listed>();
    const started: string[] = [];
    state.peers.get('alpha')!.listTools.mockImplementationOnce(() => { started.push('alpha'); return alpha.promise; });
    state.peers.get('beta')!.listTools.mockImplementationOnce(() => { started.push('beta'); return beta.promise; });
    const result = g.list();
    try {
      // No lookup is allowed to settle until both have started. A serial walk fails here.
      expect(started).toEqual(['alpha', 'beta']);
      beta.resolve({ tools: [{ name: 'second', description: 'Beta' }] });
      await Promise.resolve();
      alpha.resolve({ tools: [{ name: 'first' }, { name: 'reserved' }] });
      expect((await result).tools.map((tool) => tool.name)).toEqual(['ashlr_native', 'alpha__first', 'beta__second']);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('alpha__reserved'));
      for (const peer of state.peers.values()) expect(peer.listTools).toHaveBeenLastCalledWith({}, { timeout: 800 });
      await g.call('alpha__first');
      expect(state.peers.get('alpha')!.callTool).toHaveBeenCalledWith({ name: 'first', arguments: {} }, undefined, { timeout: 800 });
    } finally {
      alpha.resolve({ tools: [] }); beta.resolve({ tools: [] }); await result;
    }
  });

  it('keeps peers discoverable when a lookup rejects asynchronously', async () => {
    const g = await gateway();
    state.peers.get('alpha')!.listTools.mockRejectedValueOnce(new Error('offline'));
    state.peers.get('beta')!.listTools.mockResolvedValueOnce({ tools: [{ name: 'available' }] });
    expect((await g.list()).tools.map((tool) => tool.name)).toEqual(['ashlr_native', 'beta__available']);
    expect(stderr).toHaveBeenCalledWith('[ashlr mcp] WARN tools/list("alpha") failed: offline\n');
  });

  it('isolates a synchronous client throw and still starts the next lookup', async () => {
    const g = await gateway();
    state.peers.get('alpha')!.listTools.mockImplementationOnce(() => { throw new Error('synchronous'); });
    state.peers.get('beta')!.listTools.mockResolvedValueOnce({ tools: [{ name: 'available' }] });
    expect((await g.list()).tools.map((tool) => tool.name)).toEqual(['ashlr_native', 'beta__available']);
    expect(state.peers.get('beta')!.listTools).toHaveBeenCalledTimes(2);
    expect(stderr).toHaveBeenCalledWith('[ashlr mcp] WARN tools/list("alpha") failed: synchronous\n');
  });

  it('isolates result processing failures per server', async () => {
    const g = await gateway();
    const malformed = { get tools(): Listed['tools'] { throw new Error('invalid tools'); } };
    state.peers.get('alpha')!.listTools.mockResolvedValueOnce(malformed);
    state.peers.get('beta')!.listTools.mockResolvedValueOnce({ tools: [{ name: 'valid' }] });
    expect((await g.list()).tools.map((tool) => tool.name)).toEqual(['ashlr_native', 'beta__valid']);
    expect(stderr).toHaveBeenCalledWith('[ashlr mcp] WARN tools/list("alpha") failed: invalid tools\n');
  });

  it('replaces routes on every successful list and refuses deleted tools', async () => {
    const g = await gateway();
    state.peers.get('alpha')!.listTools.mockResolvedValueOnce({ tools: [{ name: 'old' }] }).mockResolvedValueOnce({ tools: [{ name: 'new' }] });
    state.peers.get('beta')!.listTools.mockResolvedValue({ tools: [] });
    expect((await g.list()).tools.map((tool) => tool.name)).toEqual(['ashlr_native', 'alpha__old']);
    expect((await g.list()).tools.map((tool) => tool.name)).toEqual(['ashlr_native', 'alpha__new']);
    expect(state.peers.get('alpha')!.listTools).toHaveBeenCalledTimes(3);
    await g.call('alpha__new');
    await expect(g.call('alpha__old')).rejects.toThrow('Unknown tool');
    expect(state.peers.get('alpha')!.callTool.mock.calls.map(([request]) => request.name)).toEqual(['new']);
  });
});


describe('bounded configured downstream recovery', () => {
  it('recovers an absent-at-startup server only after backoff and single-flights simultaneous discovery', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    state.connectPlans.set('alpha', [async () => { throw new Error('ENOENT synthetic server absent'); }]);
    const g = await gateway();
    const failed = state.peers.get('alpha')!;
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect((await g.list()).tools.map(tool => tool.name)).toEqual(['ashlr_native', 'beta__initial']);
    expect(state.attempts.filter(attempt => attempt.command === 'alpha')).toHaveLength(1);
    now += 500;
    const connect = deferred<void>();
    state.connectPlans.set('alpha', [() => connect.promise]);
    const first = g.list(), second = g.list();
    expect(state.attempts.filter(attempt => attempt.command === 'alpha')).toHaveLength(2);
    connect.resolve();
    expect((await first).tools.map(tool => tool.name)).toEqual(['ashlr_native', 'alpha__initial', 'beta__initial']);
    expect((await second).tools.map(tool => tool.name)).toEqual(['ashlr_native', 'alpha__initial', 'beta__initial']);
    await g.call('alpha__initial');
    expect(state.peers.get('alpha')!.callTool).toHaveBeenCalledTimes(1);
  });

  it('revokes routes on transport death, ignores old-peer close, and reconnects using only captured spec/env', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const registry: McpRegistry = { servers: [{ name: 'alpha', command: 'alpha', args: ['--synthetic-server'], source: 'test',
      env: { LOCUS_BINDING: 'captured-binding', HOME: '/synthetic-captured-home', CUSTOM_ENDPOINT: 'http://synthetic.invalid', ASHLR_MCP_GATEWAY: '0' } }] };
    const g = await gateway(['alpha'], registry);
    const first = { ...state.attempts[0]!, args: [...state.attempts[0]!.args], env: { ...state.attempts[0]!.env } };
    const old = state.peers.get('alpha')!;
    registry.servers[0]!.command = 'unconfigured-fallback';
    registry.servers[0]!.args.push('--changed');
    registry.servers[0]!.env!.LOCUS_BINDING = 'wrong-binding';
    vi.stubEnv('HOME', '/synthetic-new-ambient-home');
    vi.stubEnv('PATH', '/synthetic-new-ambient-path');
    old.onclose!();
    await expect(g.call('alpha__initial')).rejects.toThrow('Unknown tool');
    expect(old.callTool).not.toHaveBeenCalled();
    now += 500;
    await g.list();
    expect(state.attempts[1]).toEqual(first);
    expect(state.attempts[1]!.env.ASHLR_MCP_GATEWAY).toBe('1');
    old.onclose!();
    await g.call('alpha__initial');
    expect(state.peers.get('alpha')!.callTool).toHaveBeenCalledTimes(1);
  });

  it('revokes all failed discovery routes while healthy peers remain callable', async () => {
    const g = await gateway();
    const alpha = state.peers.get('alpha')!;
    alpha.listTools.mockRejectedValueOnce(new Error('connection lost'));
    await g.list();
    await expect(g.call('alpha__initial')).rejects.toThrow('Unknown tool');
    expect(alpha.callTool).not.toHaveBeenCalled();
    expect(alpha.close).toHaveBeenCalledTimes(1);
    await g.call('beta__initial');
    expect(state.peers.get('beta')!.callTool).toHaveBeenCalledTimes(1);
  });

  it('backs off repeated absent-server failures without retrying every list request', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const failed = async () => { throw new Error('ENOENT synthetic'); };
    state.connectPlans.set('alpha', [failed, failed, failed]);
    const g = await gateway();
    now += 500; await g.list();
    expect(state.attempts.filter(attempt => attempt.command === 'alpha')).toHaveLength(2);
    now += 999; await g.list(); await g.list();
    expect(state.attempts.filter(attempt => attempt.command === 'alpha')).toHaveLength(2);
    now += 1; await g.list();
    expect(state.attempts.filter(attempt => attempt.command === 'alpha')).toHaveLength(3);
    await g.call('beta__initial');
  });

  it('never transparently replays an effectful failed call and removes its routes until rediscovery', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const g = await gateway();
    const old = state.peers.get('alpha')!;
    old.callTool.mockRejectedValueOnce(new Error('possibly completed before disconnect'));
    await expect(g.call('alpha__initial')).rejects.toThrow('possibly completed');
    expect(old.callTool).toHaveBeenCalledTimes(1);
    await expect(g.call('alpha__initial')).rejects.toThrow('Unknown tool');
    expect(state.attempts).toHaveLength(2);
    now += 500; await g.list();
    expect(state.peers.get('alpha')!.callTool).not.toHaveBeenCalled();
    await g.call('alpha__initial');
    expect(state.peers.get('alpha')!.callTool).toHaveBeenCalledTimes(1);
  });

  it('discards an in-flight discovery response from a dead peer instead of resurrecting its tools', async () => {
    const g = await gateway();
    const old = state.peers.get('alpha')!;
    const listed = deferred<Listed>();
    old.listTools.mockImplementationOnce(() => listed.promise);
    const pending = g.list();
    old.onclose!();
    listed.resolve({ tools: [{ name: 'resurrected' }] });
    expect((await pending).tools.map(tool => tool.name)).toEqual(['ashlr_native', 'beta__initial']);
    await expect(g.call('alpha__resurrected')).rejects.toThrow('Unknown tool');
  });

  it('cleans up late recovery connections, routes, deadline timers and process listeners on shutdown', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const timers = vi.spyOn(globalThis, 'clearTimeout');
    const g = await gateway();
    state.peers.get('alpha')!.onclose!();
    now += 500;
    const connect = deferred<void>();
    state.connectPlans.set('alpha', [() => connect.promise]);
    const pending = g.list();
    const rejection = expect(pending).rejects.toThrow('closed');
    const late = state.peers.get('alpha')!;
    state.server!.onclose!();
    connect.resolve();
    await rejection;
    await running;
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(late.listTools).not.toHaveBeenCalled();
    expect(timers).toHaveBeenCalled();
    for (const [signal, prior] of beforeSignals) expect(new Set(process.listeners(signal))).toEqual(prior);
    await expect(g.call('ashlr_native')).rejects.toThrow('closed');
  });
});

describe('gateway deadlines and termination', () => {
  it('bounds a stalled list and revokes that peer while retaining healthy peers', async () => {
    const g = await gateway(['alpha', 'beta'], undefined, 20);
    const old = state.peers.get('alpha')!;
    const never = deferred<Listed>();
    old.listTools.mockImplementationOnce(() => never.promise);
    expect((await g.list()).tools.map(tool => tool.name)).toEqual(['ashlr_native', 'beta__initial']);
    await expect(g.call('alpha__initial')).rejects.toThrow('Unknown tool');
    expect(old.close).toHaveBeenCalledTimes(1);
    never.resolve({ tools: [{ name: 'late' }] });
    await expect(g.call('alpha__late')).rejects.toThrow('Unknown tool');
  });

  it('reaps a connection that resolves after its startup deadline and never advertises its tools', async () => {
    const connect = deferred<void>();
    state.connectPlans.set('alpha', [() => connect.promise]);
    running = startGateway({ servers: [{ name: 'alpha', command: 'alpha', args: [], source: 'test' }] }, 20);
    await vi.waitFor(() => expect(state.server?.onclose).toBeTypeOf('function'));
    const timedOut = state.peers.get('alpha')!;
    expect(timedOut.close).toHaveBeenCalledTimes(1);
    connect.resolve();
    await vi.waitFor(() => expect(timedOut.close).toHaveBeenCalledTimes(2));
    expect(timedOut.listTools).not.toHaveBeenCalled();
    await expect(state.handlers.get(CallToolRequestSchema)!({ params: { name: 'alpha__initial' } })).rejects.toThrow('Unknown tool');
  });

  it('termination closes the upstream SDK server and every downstream exactly once, then removes listeners', async () => {
    await gateway();
    const peers = [...state.peers.values()];
    const onSignal = process.listeners('SIGTERM').find(handler => !beforeSignals.get('SIGTERM')!.has(handler));
    expect(onSignal).toBeTypeOf('function');
    onSignal!();
    await running;
    expect(state.server!.close).toHaveBeenCalledTimes(1);
    for (const peer of peers) expect(peer.close).toHaveBeenCalledTimes(1);
    state.server!.onclose!();
    await running;
    expect(state.server!.close).toHaveBeenCalledTimes(1);
    for (const [signal, prior] of beforeSignals) expect(new Set(process.listeners(signal))).toEqual(prior);
  });
});

describe('delegated job gateway isolation', () => {
  it('refuses persistent gateway startup before downstream or native effects in a delegated job', async () => {
    await runInLocusJobEnv({ HOME: '/synthetic-job-home', LOCUS_BINDING: 'synthetic-job' }, async () => {
      await expect(startGateway({ servers: [{ name: 'alpha', command: 'alpha', args: [], source: 'test' }] })).rejects.toThrow('delegated Locus job');
    });
    expect(state.attempts).toEqual([]);
    expect(state.server).toBeNull();
  });

  it('refuses shared discovery/native/downstream calls under job context without reconnect or calls', async () => {
    const g = await gateway();
    const before = state.attempts.length;
    await runInLocusJobEnv({ HOME: '/synthetic-job-home', LOCUS_BINDING: 'synthetic-job' }, async () => {
      await expect(g.list()).rejects.toThrow('delegated Locus job');
      await expect(g.call('ashlr_native')).rejects.toThrow('delegated Locus job');
      await expect(g.call('alpha__initial')).rejects.toThrow('delegated Locus job');
    });
    expect(state.attempts).toHaveLength(before);
    expect(state.peers.get('alpha')!.callTool).not.toHaveBeenCalled();
  });

  it('one-off probes validate the final configured env against captured job identity before constructing a transport', async () => {
    await runInLocusJobEnv({ HOME: '/synthetic-job-home', LOCUS_BINDING: 'synthetic-job', LOCUS_EXECUTOR_CAPABILITY: 'synthetic-executor', LOCUS_CONTROL_CAPABILITY: 'synthetic-control' }, async () => {
      const bad = await probeServer({ name: 'alpha', command: 'alpha', args: [], source: 'test', env: { LOCUS_BINDING: 'wrong-binding' } });
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain('identity override refused');
      expect(state.attempts).toHaveLength(0);
      expect((await probeServer({ name: 'alpha', command: 'alpha', args: [], source: 'test' })).ok).toBe(true);
      expect(state.attempts[0]!.env).toMatchObject({ HOME: '/synthetic-job-home', LOCUS_BINDING: 'synthetic-job', LOCUS_EXECUTOR_CAPABILITY: 'synthetic-executor', ASHLR_MCP_GATEWAY: '1' });
      expect(state.attempts[0]!.env.LOCUS_CONTROL_CAPABILITY).toBeUndefined();
    });
  });
});


it('scrubs one-off browser call errors and closes the peer without replaying its failed tool call', async () => {
  const raw = 'sk-' + 'S'.repeat(40);
  state.connectPlans.set('alpha', [async () => {
    state.peers.get('alpha')!.callTool.mockRejectedValueOnce(new Error(`failed with ${raw}`));
  }]);
  const result = await callBrowserTool({ name: 'alpha', command: 'alpha', args: [], source: 'test' }, 'effect', {});
  expect(result.ok).toBe(false);
  expect(result.detail).not.toContain(raw);
  expect(state.peers.get('alpha')!.callTool).toHaveBeenCalledTimes(1);
  expect(state.peers.get('alpha')!.close).toHaveBeenCalledTimes(1);
});
