/** Real gateway handler with controlled SDK peers; no downstream processes or providers. */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startGateway } from '../src/core/mcp-gateway.js';
import type { McpRegistry } from '../src/core/types.js';

type Listed = { tools: { name: string; description?: string; inputSchema?: object }[] };
type Request = { params: { name: string; arguments?: Record<string, unknown> } };
type Handler = (request?: Request) => Promise<unknown>;
type Peer = {
  listTools: Mock<(params: object, options: { timeout: number }) => Promise<Listed>>;
  callTool: Mock<(request: Request['params']) => Promise<{ content: [] }>>;
  close: Mock<() => Promise<void>>;
};
const state = vi.hoisted(() => ({
  peers: new Map<string, Peer>(),
  handlers: new Map<unknown, Handler>(),
  server: null as null | { onclose?: () => void },
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
    constructor(readonly options: { command: string }) {}
    async close() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    private name = '';
    readonly listTools = vi.fn(async (_params: object, _options: { timeout: number }): Promise<Listed> => ({ tools: [{ name: 'initial' }] }));
    readonly callTool = vi.fn(async (_request: Request['params']): Promise<{ content: [] }> => ({ content: [] }));
    readonly close = vi.fn(async () => {});
    async connect(transport: { options: { command: string } }) {
      this.name = transport.options.command;
      state.peers.set(this.name, this);
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    onclose?: () => void;
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
  stderr.mockRestore();
});
async function gateway(names = ['alpha', 'beta']) {
  const registry: McpRegistry = { servers: names.map((name) => ({ name, command: name, args: [], source: 'test' })) };
  running = startGateway(registry, 800);
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

  it('re-lists on every request and refreshes routes without deleting prior routes', async () => {
    const g = await gateway();
    state.peers.get('alpha')!.listTools.mockResolvedValueOnce({ tools: [{ name: 'old' }] }).mockResolvedValueOnce({ tools: [{ name: 'new' }] });
    state.peers.get('beta')!.listTools.mockResolvedValue({ tools: [] });
    expect((await g.list()).tools.map((tool) => tool.name)).toEqual(['ashlr_native', 'alpha__old']);
    expect((await g.list()).tools.map((tool) => tool.name)).toEqual(['ashlr_native', 'alpha__new']);
    expect(state.peers.get('alpha')!.listTools).toHaveBeenCalledTimes(3);
    await g.call('alpha__new'); await g.call('alpha__old');
    expect(state.peers.get('alpha')!.callTool.mock.calls.map(([request]) => request.name)).toEqual(['new', 'old']);
  });
});
