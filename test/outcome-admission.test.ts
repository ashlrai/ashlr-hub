/** No provider/CLI contact: pure callbacks and fake fetch only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTask } from '../src/core/run/agent-loop.js';
import { newUsage } from '../src/core/run/budget.js';
import { buildOpenAICompatibleClient } from '../src/core/run/provider-client.js';
import { assertSelectedOutcomeAdmission, withSelectedOutcomeAdmission } from '../src/core/run/outcome-admission.js';
import type { RunTask } from '../src/core/types.js';

afterEach(() => vi.unstubAllGlobals());
const task = (): RunTask => ({ id: 'task', goal: 'Improve the fixture', deps: [], status: 'pending' });
const budget = { maxTokens: 1000000, maxSteps: 40, allowCloud: false };

describe('Caller-owned outcome admission', () => {
  it.each([() => false, () => { throw new Error('private callback detail'); }])('holds before reserving or contacting the first model', async selectedOutcomeAdmission => {
    const chat = vi.fn(); const reserveModelStep = vi.fn(); const work = task();
    await runTask(work, { id: 'fake', supportsTools: false, chat }, { budget, usage: newUsage(),
      onStep: () => {}, reserveModelStep, selectedOutcomeAdmission });
    expect(chat).not.toHaveBeenCalled(); expect(reserveModelStep).not.toHaveBeenCalled();
    expect(work).toMatchObject({ status: 'failed', error: 'Task cancelled.' });
  });
  it('retirement during an awaited model call preserves observed usage and prevents returned tool mutations', async () => {
    let current = true; const mutate = vi.fn(); const usage = newUsage(); const work = task();
    const chat = vi.fn(async () => { await Promise.resolve(); current = false; return {
      content: '', toolCalls: [{ id: 'write', name: 'write_file', arguments: {} }],
      usage: { tokensIn: 13, tokensOut: 6 }, usageKnown: true,
    }; });
    await runTask(work, { id: 'fake', supportsTools: true, chat }, { budget, usage,
      selectedOutcomeAdmission: () => current, tools: [{ name: 'write_file', fn: mutate }],
      onStep: step => { if (step.usage) { usage.tokensIn += step.usage.tokensIn; usage.tokensOut += step.usage.tokensOut; } } });
    expect(chat).toHaveBeenCalledOnce(); expect(mutate).not.toHaveBeenCalled();
    expect(work).toMatchObject({ status: 'failed', error: 'Task cancelled.' });
    expect(usage).toMatchObject({ tokensIn: 13, tokensOut: 6 });
  });
  it('checks again before a later model turn without erasing earlier observed consumption', async () => {
    let current = true; const usage = newUsage(); const work = task();
    const chat = vi.fn(async () => ({ content: '', toolCalls: [{ id: 'read', name: 'read_file', arguments: {} }],
      usage: { tokensIn: 9, tokensOut: 3 }, usageKnown: true }));
    await runTask(work, { id: 'fake', supportsTools: true, chat }, { budget, usage,
      selectedOutcomeAdmission: () => current, tools: [{ name: 'read_file', fn: async () => { current = false; return 'old result'; } }],
      onStep: step => { if (step.usage) { usage.tokensIn += step.usage.tokensIn; usage.tokensOut += step.usage.tokensOut; } } });
    expect(chat).toHaveBeenCalledOnce(); expect(usage).toMatchObject({ tokensIn: 9, tokensOut: 3 });
    expect(work.error).toBe('Task cancelled.');
  });
  it('reconciles a proven pre-contact refusal to zero rather than unknown reserved consumption', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); let current = true;
    const contacted = vi.fn(); const finalize = vi.fn(); const work = task();
    const client = buildOpenAICompatibleClient('http://127.0.0.1:11434/v1', '', 'fixture', false, undefined, undefined, {
      onRequestStart: () => { assertSelectedOutcomeAdmission(() => current); contacted(); },
    });
    await runTask(work, client, { budget, usage: newUsage(), onStep: () => {}, selectedOutcomeAdmission: () => current,
      reserveModelStep: () => { current = false; return { maxOutputTokens: 1024, finalize }; } });
    expect(fetchMock).not.toHaveBeenCalled(); expect(contacted).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith(expect.any(String), { tokensIn: 0, tokensOut: 0 }, 'no-contact');
    expect(work.usage?.tokenEvidence).toEqual({
      schemaVersion: 1, scope: 'recorded-model-requests',
      input: { reported: 0, estimated: 0, reserved: 0, unknown: 0 },
      output: { reported: 0, estimated: 0, reserved: 0, unknown: 0 },
      requests: { reported: 0, estimated: 0, reserved: 0, unknown: 0, noContact: 1 },
      unclassified: false,
    });
    expect(work.status).toBe('failed'); expect(work.usage).toMatchObject({ tokensIn: 0, tokensOut: 0 });
  });
});


describe('Direct and nested client admission', () => {
  it('returns the identical client when no outcome is selected', () => {
    const client = { id: 'fake', supportsTools: false, chat: vi.fn() };
    expect(withSelectedOutcomeAdmission(client)).toBe(client);
  });
  it('rechecks a streaming fallback after the first contacted attempt retires the outcome', async () => {
    let current = true; const fallback = vi.fn();
    const client = { id: 'fake', supportsTools: false, chat: fallback,
      async chatStream() { current = false; await Promise.resolve(); return this.chat(); } };
    const guarded = withSelectedOutcomeAdmission(client, () => current);
    await expect(guarded.chatStream!([], undefined, () => {})).rejects.toMatchObject({ name: 'SelectedOutcomeAdmissionRefusal', usageKnown: false });
    expect(fallback).not.toHaveBeenCalled();
  });
});


it('a retired streaming fallback retains unknown accounting for the contacted stream', async () => {
  let current = true; const finalize = vi.fn(); const fallback = vi.fn(); const work = task();
  const client = { id: 'fake-stream', supportsTools: false, chat: fallback, authority: { requestLimits: 'enforced' as const, usageAccounting: 'exact-provider-counters' as const },
    async chatStream() { await Promise.resolve(); current = false; return this.chat(); } };
  await runTask(work, client, { budget, usage: newUsage(), onStep: () => {}, selectedOutcomeAdmission: () => current,
    reserveModelStep: () => ({ maxOutputTokens: 1024, finalize }) });
  expect(fallback).not.toHaveBeenCalled(); expect(work.error).toBe('Task cancelled.');
  // Undefined usage retains the real reservation; this hint is not counter evidence.
  expect(finalize).toHaveBeenCalledWith(expect.any(String), undefined, 'reported');
  expect(work.usage?.tokenEvidence).toEqual({
    schemaVersion: 1, scope: 'recorded-model-requests',
    input: { reported: 0, estimated: 0, reserved: 0, unknown: 0 },
    output: { reported: 0, estimated: 0, reserved: 0, unknown: 0 },
    requests: { reported: 0, estimated: 0, reserved: 0, unknown: 1, noContact: 0 },
    unclassified: false,
  });
});


it('preserves opaque adapter receivers, public metadata, and private fields while guarding exposed calls', async () => {
  class Adapter {
    readonly id = 'opaque-fixture'; readonly supportsTools = false; #value = 7; calls = 0;
    get model() { return `fixture-${this.#value}`; }
    async getContextWindowTokens() { return this.#value * 1000; }
    async chat() { this.calls++; return { content: String(this.#value), usage: { tokensIn: 1, tokensOut: 2 }, usageKnown: true }; }
    async chatStream() { return this.chat(); }
  }
  const client = new Adapter(); let current = true;
  const guarded = withSelectedOutcomeAdmission(client, () => current);
  expect(guarded.model).toBe('fixture-7'); expect(await guarded.getContextWindowTokens!()).toBe(7000);
  expect(await guarded.chat([], undefined)).toMatchObject({ content: '7' });
  expect(await guarded.chatStream!([], undefined, () => {})).toMatchObject({ content: '7' });
  current = false;
  await expect(guarded.chat([], undefined)).rejects.toMatchObject({ name: 'SelectedOutcomeAdmissionRefusal' });
  expect(client.calls).toBe(2);
});
