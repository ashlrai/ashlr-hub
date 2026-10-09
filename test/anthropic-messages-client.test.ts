import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, ChatMessage, RunTask } from '../src/core/types.js';
import type { FreshClaudeApiGrantProof } from '../src/core/resources/claude-api-grant-types.js';
import { createClaudeApiGrantAdmission, CLAUDE_API_GRANT_LEDGER_FILE } from '../src/core/resources/claude-api-grant.js';
import { buildAnthropicMessagesClient, type ClaudeApiExecutionBinding } from '../src/core/run/provider-client.js';
import { runTask } from '../src/core/run/agent-loop.js';
import { BUILTIN_ENGINE_REGISTRY } from '../src/core/run/engine-registry.js';

const key = 'disposable-loopback-api-key';
const secret = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/core/integrations/secrets.js', () => ({ resolveProviderKey: secret.read }));
const model = 'claude-sonnet-4-6';
const endpoint = 'https://api.anthropic.com/v1/messages';
const messages: ChatMessage[] = [{ role: 'system', content: 'test system' }, { role: 'user', content: 'test goal' }];
const limits = { maxOutputTokens: 128 };
const cfg = (): AshlrConfig => ({ version: 1, roots: [], models: {}, foundry: { allowedBackends: ['claude-api'] } } as AshlrConfig);
let root: string; let proof: FreshClaudeApiGrantProof; let binding: ClaudeApiExecutionBinding;
const servers: Server[] = [];
function ledger(): Array<Record<string, unknown>> { return JSON.parse(readFileSync(join(root, CLAUDE_API_GRANT_LEDGER_FILE), 'utf8')).rows; }
function reply(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'message', id: 'msg_Test1', role: 'assistant', model, stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: 'complete answer' }], usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard', inference_geo: 'global' }, ...over };
}
async function loopback(handler: (body: Record<string, unknown>, number: number) => Record<string, unknown> | 'disconnect' | 'stall' | 'invalid-utf8' | 'redirect') {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    expect(request.headers['x-api-key']).toBe(key);
    // This assertion observes the actual durable pre-contact state at the peer.
    expect(ledger().at(-1)?.state).toBe('sent');
    const result = handler(body, bodies.length);
    if (result === 'disconnect') { request.socket.destroy(); return; }
    if (result === 'redirect') { response.writeHead(302, { location: 'http://127.0.0.1:1/never-follow' }); response.end(); return; }
    if (result === 'invalid-utf8') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(Buffer.from([0xff, 0xfe])); return; }
    if (result === 'stall') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test listener missing');
  const actualFetch = globalThis.fetch.bind(globalThis);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    expect(url).toBe(endpoint); expect(init?.redirect).toBe('error');
    return actualFetch(`http://127.0.0.1:${address.port}/v1/messages`, init);
  });
  return { bodies, fetch };
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-messages-ledger-'))); chmodSync(root, 0o700);
  const now = Date.now(); const stamp = new Date(now).toISOString();
  proof = { observation: { v: 1, kind: 'claude-api-promotion', observationId: 'observation-one', cycleId: 'cycle-one',
    binding: { organizationDigest: 'a'.repeat(64), workspaceDigest: 'b'.repeat(64), credentialDigest: createHash('sha256').update(key).digest('hex'), generation: 'generation-one' },
    remainingUsdMicros: '10000000', totalUsdMicros: '10000000', capturedAt: stamp,
    expiry: { precision: 'date', date: new Date(now + 86_400_000).toISOString().slice(0, 10), timezone: 'UTC', instant: null }, evidenceDigest: 'c'.repeat(64) },
    observedAt: stamp, validUntil: new Date(now + 60_000).toISOString(),
    funding: { source: 'verified-provider-billing', prepaid: true, invoiced: false, autoReload: 'off', purchasedUsdMicros: '0', otherPaidFunding: false },
    authority: { active: true, stop: false, localOnly: false, engineEnabled: true, repoAuthorized: true, roleAuthorized: true, meteredCeilingUsdMicros: '10000000', dailyRemainingUsdMicros: '10000000', identityDigest: 'd'.repeat(64) } };
  const readFreshProof = () => structuredClone(proof);
  const admission = createClaudeApiGrantAdmission({ expectedBinding: proof.observation.binding, readFreshProof });
  if (!admission.ok) throw new Error(admission.reason);
  binding = { ledgerRoot: root, admission: admission.value, expectedBinding: proof.observation.binding, readFreshProof };
  secret.read.mockReset(); secret.read.mockReturnValue(key);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  rmSync(root, { recursive: true, force: true });
});

describe('guarded first-party Claude Messages', () => {
  it('keeps Claude subscription and the opt-in API resource distinct', () => {
    expect(BUILTIN_ENGINE_REGISTRY.claude.kind).toBe('cli-agent');
    expect(BUILTIN_ENGINE_REGISTRY['claude-api']).toMatchObject({ kind: 'api-model', tier: 'mid', api: { protocol: 'anthropic-messages' } });
    expect(() => buildAnthropicMessagesClient({ ...cfg(), foundry: {} }, model, binding)).toThrow('engine-disabled');
    expect(secret.read).not.toHaveBeenCalled();
  });
  it('uses the fixed protocol, reserves full context, then settles exact complete usage', async () => {
    const peer = await loopback(() => reply()); const client = buildAnthropicMessagesClient(cfg(), model, binding);
    expect(client.chatStream).toBeUndefined(); expect(secret.read).not.toHaveBeenCalled();
    const result = await client.chat(messages, [], undefined, limits);
    expect(peer.bodies[0]).toMatchObject({ model, max_tokens: 128, system: 'test system', service_tier: 'standard_only', inference_geo: 'global', stream: false });
    expect(peer.bodies[0].messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'test goal' }] }]);
    expect(result).toMatchObject({ content: 'complete answer', usageKnown: true, billing: { actualUsdMicros: '105', requestId: 'msg_Test1' } });
    expect(ledger()[0]).toMatchObject({ state: 'settled', maxUsdMicros: '3001920', actualUsdMicros: '105', heldUsdMicros: '0' });
    expect(client.getApiBillingSummary?.()).toMatchObject({ settledUsdMicros: '105', unknownExposureUsdMicros: '0', settledRequests: 1 });
    expect(peer.fetch).toHaveBeenCalledTimes(1);
  });
  it('drives the unchanged agent tool loop through tool_use/result and complete final text', async () => {
    const peer = await loopback((_body, number) => number === 1 ? reply({ id: 'msg_Tool1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_Test1', name: 'read_fixture', input: {} }] }) : reply({ id: 'msg_Final1' }));
    const file = join(root, 'owned-work.txt'); writeFileSync(file, 'owned fixture');
    const tool = { type: 'function', function: { name: 'read_fixture', description: 'test-only local read', parameters: { type: 'object', properties: {} } }, name: 'read_fixture', safety: 'read', fn: async () => readFileSync(file, 'utf8') };
    const task: RunTask = { id: 'test-task', goal: 'read a fixture', deps: [], status: 'pending' };
    await runTask(task, buildAnthropicMessagesClient(cfg(), model, binding), { tools: [tool], budget: { maxTokens: 50000, maxSteps: 4, allowCloud: true }, usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 }, onStep() {}, reserveModelStep: () => ({ maxOutputTokens: 128, finalize() {} }) });
    expect(task.status).toBe('done'); expect(readFileSync(file, 'utf8')).toBe('owned fixture');
    const second = peer.bodies[1].messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(second.at(-1)?.content).toContainEqual({ type: 'tool_result', tool_use_id: 'toolu_Test1', content: 'owned fixture' });
    expect(ledger().map(row => row.state)).toEqual(['settled', 'settled']); expect(peer.fetch).toHaveBeenCalledTimes(2);
  });
  it('retains exposure and refuses a response tool ID already completed in replay history', async () => {
    const tool = { type: 'function', function: { name: 'read_fixture', parameters: { type: 'object', properties: {} } } };
    const history: ChatMessage[] = [...messages,
      { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_Completed1', name: 'read_fixture', arguments: {} }] },
      { role: 'tool', toolCallId: 'toolu_Completed1', content: 'completed fixture result' }];
    const peer = await loopback(() => reply({ stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'toolu_Completed1', name: 'read_fixture', input: {} },
    ] }));
    await expect(buildAnthropicMessagesClient(cfg(), model, binding).chat(history, [tool], undefined, limits)).rejects.toThrow('contact-unconfirmed');
    expect(peer.fetch).toHaveBeenCalledTimes(1); expect(ledger()[0]).toMatchObject({ state: 'unknown', heldUsdMicros: '3001920' });
  });
  it.each(['constructor', 'claude-sonnet-5', 'claude-code'])('holds unpriced model %s without key or contact', name => {
    expect(() => buildAnthropicMessagesClient(cfg(), name, binding)).toThrow('pricing-unknown'); expect(secret.read).not.toHaveBeenCalled();
  });
  it.each(['stop', 'stale', 'funding', 'zero-metered', 'changed-generation', 'copied-capability'])('holds %s before key or contact', async kind => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    if (kind === 'stop') proof.authority.stop = true;
    if (kind === 'stale') proof.validUntil = new Date(Date.now() - 1).toISOString();
    if (kind === 'funding') proof.funding.autoReload = 'unknown';
    if (kind === 'zero-metered') proof.authority.meteredCeilingUsdMicros = '0';
    if (kind === 'changed-generation') proof.observation.binding.generation = 'changed';
    if (kind === 'copied-capability') binding = { ...binding, admission: { ...binding.admission } };
    await expect(buildAnthropicMessagesClient(cfg(), model, binding).chat(messages, [], undefined, limits)).rejects.toThrow('Claude API held');
    expect(secret.read).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses a credential digest borrowed from another binding before credential access', async () => {
    binding = { ...binding, expectedBinding: { ...binding.expectedBinding, credentialDigest: 'f'.repeat(64) } };
    await expect(buildAnthropicMessagesClient(cfg(), model, binding).chat(messages, [], undefined, limits)).rejects.toThrow('binding-changed');
    expect(secret.read).not.toHaveBeenCalled();
  });
  it('releases only reserved exposure on a key mismatch', async () => {
    secret.read.mockReturnValue('different-disposable-key'); const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(buildAnthropicMessagesClient(cfg(), model, binding).chat(messages, [], undefined, limits)).rejects.toThrow('credential-binding-changed');
    expect(fetch).not.toHaveBeenCalled(); expect(ledger()[0]).toMatchObject({ state: 'released', heldUsdMicros: '0' });
  });
  it('rechecks Stop after credential setup and releases before any contact', async () => {
    secret.read.mockImplementation(() => { proof.authority.stop = true; return key; }); const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(buildAnthropicMessagesClient(cfg(), model, binding).chat(messages, [], undefined, limits)).rejects.toThrow('authority-held');
    expect(fetch).not.toHaveBeenCalled(); expect(ledger()[0]).toMatchObject({ state: 'released' });
  });
  it('releases before contact when credential setup observes cancellation', async () => {
    const controller = new AbortController(); const fetch = vi.spyOn(globalThis, 'fetch');
    secret.read.mockImplementation(() => { controller.abort(); return key; });
    await expect(buildAnthropicMessagesClient(cfg(), model, binding).chat(messages, [], controller.signal, limits)).rejects.toThrow('cancelled-before-contact');
    expect(fetch).not.toHaveBeenCalled(); expect(ledger()[0].state).toBe('released');
  });
  it('handles a notification failure after contact without retry or unhandled transport rejection', async () => {
    const peer = await loopback(() => 'disconnect');
    const client = buildAnthropicMessagesClient(cfg(), model, binding, { onRequestStart() { throw new Error('private notification detail'); } });
    await expect(client.chat(messages, [], undefined, limits)).rejects.toThrow(/^Claude API held: contact-unconfirmed$/);
    expect(peer.fetch).toHaveBeenCalledTimes(1); expect(ledger()[0].state).toBe('unknown');
  });
  it.each(['missing-cap', 'oversize', 'unmatched-tool'])('refuses %s request before reservation/key', async kind => {
    const input: ChatMessage[] = kind === 'oversize' ? [{ role: 'user', content: 'x'.repeat(65536) }] : kind === 'unmatched-tool' ? [{ role: 'tool', toolCallId: 'unknown', content: 'result' }] : messages;
    await expect(buildAnthropicMessagesClient(cfg(), model, binding).chat(input, [], undefined, kind === 'missing-cap' ? undefined : limits)).rejects.toThrow('Claude API held'); expect(secret.read).not.toHaveBeenCalled();
  });
  it.each(['cache', 'tier', 'server-tool', 'partial', 'unknown-block', 'missing-usage', 'excess-output', 'mismatched-model'])('retains exposure and serves no output for %s', async kind => {
    const data = reply(); const usage = data.usage as Record<string, unknown>;
    if (kind === 'cache') usage.cache_read_input_tokens = 1;
    if (kind === 'tier') usage.service_tier = 'priority';
    if (kind === 'server-tool') usage.server_tool_use = { web_search_requests: 1 };
    if (kind === 'partial') data.stop_reason = 'max_tokens';
    if (kind === 'unknown-block') data.content = [{ type: 'thinking', thinking: 'private content' }];
    if (kind === 'missing-usage') delete data.usage;
    if (kind === 'excess-output') usage.output_tokens = 129;
    if (kind === 'mismatched-model') data.model = 'other-model';
    const peer = await loopback(() => data); const client = buildAnthropicMessagesClient(cfg(), model, binding);
    await expect(client.chat(messages, [], undefined, limits)).rejects.toThrow('contact-unconfirmed');
    expect(ledger()[0]).toMatchObject({ state: 'unknown', heldUsdMicros: '3001920' });
    expect(client.getApiBillingSummary?.()).toMatchObject({ unknownExposureUsdMicros: '3001920', settledRequests: 0 }); expect(peer.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry a disconnected request and never exposes transport errors', async () => {
    const peer = await loopback(() => 'disconnect');
    await expect(buildAnthropicMessagesClient(cfg(), model, binding).chat(messages, [], undefined, limits)).rejects.toThrow(/^Claude API held: contact-unconfirmed$/);
    expect(ledger()[0].state).toBe('unknown'); expect(peer.fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses caller cancellation before key or reservation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(buildAnthropicMessagesClient(cfg(), model, binding).chat(messages, [], controller.signal, limits)).rejects.toThrow('cancelled-before-contact'); expect(secret.read).not.toHaveBeenCalled();
  });
  it.each(['redirect', 'invalid-utf8'] as const)('refuses %s without following or retrying', async failure => {
    const peer = await loopback(() => failure);
    await expect(buildAnthropicMessagesClient(cfg(), model, binding).chat(messages, [], undefined, limits)).rejects.toThrow('contact-unconfirmed');
    expect(peer.fetch).toHaveBeenCalledTimes(1); expect(ledger()[0].state).toBe('unknown');
  });
  it('bounds response bytes and retains the reservation', async () => {
    const peer = await loopback(() => reply({ content: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] }));
    await expect(buildAnthropicMessagesClient(cfg(), model, binding).chat(messages, [], undefined, limits)).rejects.toThrow('contact-unconfirmed');
    expect(peer.fetch).toHaveBeenCalledTimes(1); expect(ledger()[0].state).toBe('unknown');
  });
  it('settles no partial stalled body and cleans caller cancellation without retry', async () => {
    let started!: () => void; const received = new Promise<void>(resolve => { started = resolve; });
    const peer = await loopback(() => { started(); return 'stall'; }); const controller = new AbortController();
    const pending = buildAnthropicMessagesClient(cfg(), model, binding).chat(messages, [], controller.signal, limits);
    const observed = pending.then(() => ({ error: null }), error => ({ error }));
    await received; controller.abort();
    expect((await observed).error).toHaveProperty('message', 'Claude API held: contact-unconfirmed');
    expect(peer.fetch).toHaveBeenCalledTimes(1); expect(ledger()[0].state).toBe('unknown');
  });
  it('refuses local-only without reading a credential', () => {
    expect(() => buildAnthropicMessagesClient({ ...cfg(), foundry: { allowedBackends: ['claude-api'], localOnly: true } }, model, binding)).toThrow(); expect(secret.read).not.toHaveBeenCalled();
  });
  it('holds an absent runtime binding before sandbox or any credential/contact', async () => {
    const { runApiModelSandboxed } = await import('../src/core/run/sandboxed-engine.js');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await runApiModelSandboxed('claude-api', 'inert goal', cfg(), { sourceRepo: root, budget: { allowCloud: true }, deferTerminalAction: true });
    expect(result.proposalOutcome?.reason).toContain('source-owned grant binding'); expect(result.state.status).toBe('failed');
    expect(result.state.tasks).toEqual([]); expect(secret.read).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
