import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentsReadClient } from '../src/core/openai-agents/client.js';
import { AgentsReadError, sessionMetadata } from '../src/core/openai-agents/contracts.js';
import { runOpenaiAgentsCli } from '../src/cli/openai-agents.js';
import { AGENT_COMMANDS } from '../src/cli/help.js';

const KEY = 'sk-test-never-real-credential';
const session = { object: 'agent.session', id: 'sess_123', created_at: 1720000000, status: 'idle',
  agent: { id: 'agent_123', model: 'gpt-6.1-sol', instructions: 'private instructions' },
  required_actions: [{ type: 'function_call', arguments: 'private input' }], environment: { secret: KEY } };
const turn = { object: 'agent.session.turn', id: 'turn_123', session_id: 'sess_123', agent_id: 'agent_123',
  subagent_id: null, created_at: 1720000000, status: 'completed', error: { message: KEY } };
const page = (data: unknown[], hasMore = false) => ({ object: 'list', data, has_more: hasMore,
  first_id: data.length ? (data[0] as { id: string }).id : null,
  last_id: data.length ? (data.at(-1) as { id: string }).id : null });
function mockClient(body: unknown) {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
  const readApiKey = vi.fn(() => KEY);
  return { client: new AgentsReadClient({ fetch: transport, readApiKey }), transport, readApiKey };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('managed Agents read-only transport and projections', () => {
  it('defers credentials and transport; GETs the fixed beta TLS host and projects a partial page', async () => {
    const { client, transport, readApiKey } = mockClient(page([session], true));
    expect(readApiKey).not.toHaveBeenCalled();
    const result = await client.listSessions({ limit: 1, after: 'sess_before' });
    expect(result).toEqual({ data: [{ id: 'sess_123', createdAt: 1720000000, status: 'idle',
      agent: { id: 'agent_123', model: 'gpt-6.1-sol' }, requiredActionCount: 1 }], hasMore: true, nextCursor: 'sess_123' });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/agents/sessions?limit=1&order=desc&after=sess_before');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${KEY}`, 'OpenAI-Beta': 'agents=v1' } });
    expect(JSON.stringify(result)).not.toMatch(/private|environment|instructions|arguments/);
  });
  it('keeps empty inventory distinct from malformed pagination', async () => {
    expect(await mockClient(page([])).client.listSessions()).toEqual({ data: [], hasMore: false, nextCursor: null });
    for (const bad of [{ ...page([]), has_more: true }, { ...page([session]), last_id: 'other' }, page([session, session])]) {
      await expect(mockClient(bad).client.listSessions()).rejects.toMatchObject({ code: 'invalid-response' });
    }
  });
  it('retrieves only the requested identity and lists root/subagent metadata without treating completion as tool acceptance', async () => {
    expect((await mockClient(session).client.inspectSession('sess_123')).status).toBe('idle');
    await expect(mockClient(session).client.inspectSession('sess_other')).rejects.toMatchObject({ code: 'invalid-response' });
    const { client, transport } = mockClient(page([turn, { ...turn, id: 'turn_sub', subagent_id: 'subagent_1' }]));
    expect((await client.listTurns('sess_123')).data.map(t => t.subagentId)).toEqual([null, 'subagent_1']);
    expect(transport.mock.calls[0][0]).toContain('/v1/agents/sessions/sess_123/turns?');
    await expect(mockClient(page([{ ...turn, session_id: 'sess_other' }])).client.listTurns('sess_123')).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it.each([0, 101, 1.1, NaN])('rejects invalid page limit %s before authentication', async limit => {
    const { client, readApiKey, transport } = mockClient(page([]));
    await expect(client.listSessions({ limit })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(readApiKey).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it.each(['../escape', 'https://evil.invalid', 'session?x=1', 'x'.repeat(201)])('refuses unsafe path/cursor %s', async value => {
    const { client, transport } = mockClient(page([]));
    await expect(client.inspectSession(value)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(client.listSessions({ after: value })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid timestamp %s', created_at => {
    expect(() => sessionMetadata({ ...session, created_at })).toThrow('invalid-response');
  });
  it('keeps provider/transport errors and key echoes out of output', async () => {
    for (const [status, code] of [[401, 'authentication'], [403, 'permission'], [404, 'not-found'], [429, 'rate-limit'], [500, 'provider-error']] as const) {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(KEY, { status }));
      await expect(new AgentsReadClient({ readApiKey: () => KEY, fetch: transport }).listSessions()).rejects.toMatchObject({ message: code });
    }
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error(KEY));
    await expect(new AgentsReadClient({ readApiKey: () => KEY, fetch: transport }).listSessions()).rejects.toMatchObject({ message: 'transport' });
    await expect(mockClient({ ...session, agent: { ...session.agent, model: KEY } }).client.inspectSession('sess_123')).rejects.toMatchObject({ message: 'invalid-response' });
  });
  it('refuses missing/invalid authentication without transport', async () => {
    const transport = vi.fn<typeof fetch>();
    for (const key of [undefined, '', '\nkey']) {
      await expect(new AgentsReadClient({ readApiKey: () => key, fetch: transport }).listSessions()).rejects.toBeInstanceOf(AgentsReadError);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it('cancels oversized declared bodies and bounds undeclared streamed bodies', async () => {
    const cancelled = vi.fn();
    const stream = () => new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, cancel: cancelled });
    for (const headers of [{ 'content-length': String(3 * 1024 * 1024), 'content-type': 'application/json' }, { 'content-type': 'application/json' }]) {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream(), { headers }));
      await expect(new AgentsReadClient({ readApiKey: () => KEY, fetch: transport }).listSessions()).rejects.toMatchObject({ code: 'response-too-large' });
    }
    expect(cancelled).toHaveBeenCalledTimes(2);
  });
  it('bounds both a stalled transport and a stalled response body', async () => {
    vi.useFakeTimers();
    for (const transport of [vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }))]) {
      const pending = new AgentsReadClient({ readApiKey: () => KEY, fetch: transport }).listSessions();
      const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(15_000); await rejected;
    }
  });
});

describe('managed Agents CLI', () => {
  function deps() {
    return { client: { listSessions: vi.fn().mockResolvedValue({ data: [], hasMore: false, nextCursor: null }),
      inspectSession: vi.fn().mockResolvedValue({ id: 'sess_123' }), listTurns: vi.fn().mockResolvedValue({ data: [] }) }, out: vi.fn(), err: vi.fn() };
  }
  it('is discoverable and help does not invoke a read', async () => {
    const d = deps(); expect(await runOpenaiAgentsCli(['--help'], d)).toBe(0);
    expect(d.out.mock.calls[0][0]).toContain('separate from Codex'); expect(d.client.listSessions).not.toHaveBeenCalled();
    expect(AGENT_COMMANDS.some(c => c.usage.includes('openai-agents'))).toBe(true);
  });
  it.each([['create'], ['sessions', '--key', KEY], ['sessions', '--limit', '101'], ['sessions', '--limit', '1', '--limit', '2'], ['inspect'], ['inspect', '--delete'], ['turns', '-h'], ['inspect', 'sess_123', '--after', 'turn_1'], ['turns', '../escape']])('rejects unsupported input %j without reads', async args => {
    const d = deps(); expect(await runOpenaiAgentsCli(args, d)).toBe(2);
    expect(d.client.listSessions).not.toHaveBeenCalled(); expect(d.client.inspectSession).not.toHaveBeenCalled(); expect(d.client.listTurns).not.toHaveBeenCalled();
    expect(d.err.mock.calls[0][0]).not.toContain(KEY);
  });
  it('dispatches exact bounded commands and labels metadata unqualified', async () => {
    const d = deps(); expect(await runOpenaiAgentsCli(['sessions', '--limit', '4', '--after', 'sess_previous', '--json'], d)).toBe(0);
    expect(d.client.listSessions).toHaveBeenCalledWith({ limit: 4, after: 'sess_previous' });
    expect(JSON.parse(d.out.mock.calls[0][0])).toMatchObject({ readOnly: true, executionQualified: false });
    expect(await runOpenaiAgentsCli(['inspect', 'sess_123'], d)).toBe(0); expect(d.client.inspectSession).toHaveBeenCalledWith('sess_123');
    expect(await runOpenaiAgentsCli(['turns', 'sess_123', '--json'], d)).toBe(0); expect(d.client.listTurns).toHaveBeenCalledWith('sess_123', {});
  });
  it('gives actionable missing-auth guidance and suppresses arbitrary dependency errors', async () => {
    const d = deps(); d.client.listSessions.mockRejectedValueOnce(new AgentsReadError('missing-auth')).mockRejectedValueOnce(new Error(KEY));
    expect(await runOpenaiAgentsCli(['sessions', '--json'], d)).toBe(1);
    expect(JSON.parse(d.err.mock.calls[0][0])).toMatchObject({ error: 'missing-auth' });
    expect(await runOpenaiAgentsCli(['sessions'], d)).toBe(1); expect(d.err.mock.calls[1][0]).not.toContain(KEY);
  });
});
