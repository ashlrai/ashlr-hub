import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateResourceReview, RESOURCE_REVIEW_SUITE, runResourceReviewBenchmark } from '../src/core/resources/review-benchmark.js';
import { resourcePoolStatus } from '../src/core/resources/pool-runtime.js';
import { cmdResourcePool } from '../src/cli/resource-pool.js';
import type { ResourceObservation, ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';

const expected = [
  { zero: null, stringZero: 0, empty: null, fix: 'nullish-check' },
  { first: [10], second: [30], last: [50], fix: 'remove-minus-one' },
  { source: [1, 2, 3], result: [1, 2, 3], sameReference: true, fix: 'copy-before-push' },
];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { wrong?: boolean; missingUsage?: boolean; changeDigestAt?: number; httpFailure?: boolean;
  quota?: number; hold?: boolean; onInventory?: (count: number) => void } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'resource-review-'))); chmodSync(base, 0o700);
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'work'); mkdirSync(cwd, { mode: 0o700 });
  let generations = 0; let inventories = 0; const prompts: string[] = [];
  const sha = 'a'.repeat(64);
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags') {
      inventories++;
      options.onInventory?.(inventories);
      response.end(JSON.stringify({ models: [{ name: 'fixture-model', digest: inventories >= (options.changeDigestAt ?? Infinity) ? 'b'.repeat(64) : sha,
        size: 1, details: {} }] })); return;
    }
    generations++;
    if (options.httpFailure) { response.writeHead(503); response.end('{}'); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const text = JSON.parse(body).messages.at(-1).content as string; prompts.push(text);
    if (options.hold) return;
    const index = RESOURCE_REVIEW_SUITE.cases.findIndex((row) => row.prompt === text);
    response.end(JSON.stringify({ choices: [{ message: { content: options.wrong ? '```json\n{}\n```' : JSON.stringify(expected[index]) }, finish_reason: 'stop' }],
      ...(options.missingUsage ? {} : { usage: { prompt_tokens: 20, completion_tokens: 10 } }) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  const pool: ResourcePool = { schemaVersion: 1, id: 'bench-pool', workers: [{ id: 'local-a', provider: 'local', model: 'fixture-model',
    priority: 0, maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: options.quota ?? 20, taskWindowMs: 60_000, allowUnknownQuota: true }] };
  const bindings: ResourceBinding[] = [{ workerId: 'local-a', capacityKey: 'local-device', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }];
  const observations: ResourceObservation[] = [{ workerId: 'local-a', observedAt: new Date(Date.now() - 100).toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(), health: 'ready', windows: [], retryAfter: null }];
  const input = { root: join(base, 'ledger'), pool, bindings, observations, workerId: 'local-a', runId: 'run-a', cwd,
    expectedModelDigest: `sha256:${sha}`, timeoutMs: 2_000 };
  return { base, input, prompts, counts: () => ({ generations, inventories }) };
}

describe('fixed review calibration evaluator', () => {
  it('matches independently calculated JavaScript outcomes for all fixed fixtures', () => {
    function reading(value: unknown) { if (!value) return null; return Number(value); }
    function page(items: number[], index: number, size: number) { return items.slice(index * size, index * size + size - 1); }
    const source = [1, 2]; const result = source; result.push(3);
    expect(expected).toEqual([
      { zero: reading(0), stringZero: reading('0'), empty: reading(''), fix: 'nullish-check' },
      { first: page([10, 20, 30, 40, 50], 0, 2), second: page([10, 20, 30, 40, 50], 1, 2), last: page([10, 20, 30, 40, 50], 2, 2), fix: 'remove-minus-one' },
      { source, result, sameReference: source === result, fix: 'copy-before-push' },
    ]);
    RESOURCE_REVIEW_SUITE.cases.forEach((row, index) => expect(evaluateResourceReview(row.id, JSON.stringify(expected[index])))
      .toEqual({ passed: true, checksPassed: 4, checksTotal: 4, failedChecks: [], reason: 'matched' }));
    expect(Object.isFrozen(RESOURCE_REVIEW_SUITE.cases)).toBe(true);
    expect(RESOURCE_REVIEW_SUITE.digest).toBe('cface499c951f7231a6ae5db493a8125d21accf4d2a4221f9da62ad653d0e576');
  });
  it.each(['null', '[]', '{}', 'not JSON', '```json\n{}\n```', '{"extra":1}', 'x'.repeat(16_385)])('rejects non-contract output', (output) => {
    expect(evaluateResourceReview('zero-value', output)).toEqual({ passed: false, checksPassed: 0, checksTotal: 4,
      failedChecks: ['zero', 'stringZero', 'empty', 'fix'], reason: 'invalid-json-contract' });
  });
  it('scores exact values, not a model self-rating, and rejects unknown cases', () => {
    expect(evaluateResourceReview('zero-value', JSON.stringify({ ...expected[0], zero: 0 })))
      .toMatchObject({ passed: false, checksPassed: 3, failedChecks: ['zero'], reason: 'answer-mismatch' });
    expect(evaluateResourceReview('zero-value', JSON.stringify({ ...expected[0], score: 1 }))).toMatchObject({ reason: 'invalid-json-contract' });
    expect(() => evaluateResourceReview('other', '{}')).toThrow('Unknown');
  });
  it('reports mismatched fixed check names in suite order without persisting answer values', () => {
    const output = JSON.stringify({ fix: 'private generated value', last: [50], second: [30, 40], first: [10] });
    const result = evaluateResourceReview('page-boundary', output);
    expect(result).toEqual({ passed: false, checksPassed: 2, checksTotal: 4,
      failedChecks: ['second', 'fix'], reason: 'answer-mismatch' });
    expect(JSON.stringify(result)).not.toMatch(/private generated value|\[30,40\]/);
  });
  it('invalid contracts report only all expected check names, detached between evaluations', () => {
    const result = evaluateResourceReview('shared-array', '{"private-model-key":"private-model-value"}');
    expect(result.failedChecks).toEqual(['source', 'result', 'sameReference', 'fix']);
    expect(JSON.stringify(result)).not.toContain('private-model');
    result.failedChecks.push('caller mutation');
    expect(evaluateResourceReview('shared-array', '{}').failedChecks).toEqual(['source', 'result', 'sameReference', 'fix']);
  });
  it.each(['1e309', '-1e309'])('rejects overflowing JSON number %s instead of matching expected null', (number) => {
    const output = `{"zero":${number},"stringZero":0,"empty":${number},"fix":"nullish-check"}`;
    expect(evaluateResourceReview('zero-value', output)).toEqual({ passed: false, checksPassed: 0, checksTotal: 4,
      failedChecks: ['zero', 'stringZero', 'empty', 'fix'], reason: 'invalid-json-contract' });
  });
  it.each(['[1e309]', '{"nested":[{"value":-1e309}]}'])('rejects non-finite values throughout the JSON tree: %s', (value) => {
    const output = `{"first":${value},"second":[30],"last":[50],"fix":"remove-minus-one"}`;
    expect(evaluateResourceReview('page-boundary', output)).toEqual({ passed: false, checksPassed: 0, checksTotal: 4,
      failedChecks: ['first', 'second', 'last', 'fix'], reason: 'invalid-json-contract' });
  });
});

describe.skipIf(process.platform === 'win32')('resource review benchmark local acceptance', () => {
  it('runs repeated fixed cases through real ledger/loopback and refuses replay', async () => {
    const f = await fixture(); const report = await runResourceReviewBenchmark({ ...f.input, repeats: 2 });
    expect(report).toMatchObject({ status: 'completed', expectedCases: 6, evaluatedCases: 6, passedCases: 6, score: 1,
      verifiedAccepted: false, routingChanged: false, modelIdentity: { digest: f.input.expectedModelDigest } });
    expect(f.counts()).toEqual({ generations: 6, inventories: 6 });
    expect(f.prompts.slice(0, 3)).toEqual(f.prompts.slice(3));
    const status = resourcePoolStatus(f.input.root, f.input.pool, f.input.bindings, []);
    expect(status.attempts).toHaveLength(6); expect(status.attempts.every((row) => row.verifiedAccepted === false)).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('function reading'); expect(serialized).not.toContain('nullish-check');
    await expect(runResourceReviewBenchmark({ ...f.input, repeats: 2 })).rejects.toThrow('already recorded');
    expect(f.counts()).toEqual({ generations: 6, inventories: 6 });
  });
  it('records failed checks independently of successful execution and unknown usage', async () => {
    const f = await fixture({ wrong: true, missingUsage: true }); const report = await runResourceReviewBenchmark(f.input);
    expect(report).toMatchObject({ status: 'completed', evaluatedCases: 3, passedCases: 0, score: 0 });
    expect(report.trials[0]).toMatchObject({ receipt: { status: 'completed', inputTokens: null, outputTokens: null },
      evaluation: { passed: false, failedChecks: ['zero', 'stringZero', 'empty', 'fix'] } });
  });
  it('stops before changed model dispatch and leaves aggregate quality unknown', async () => {
    const f = await fixture({ changeDigestAt: 2 }); const report = await runResourceReviewBenchmark(f.input);
    expect(report).toMatchObject({ status: 'stopped', stopReason: 'model-identity-digest-mismatch', evaluatedCases: 1, score: null });
    expect(f.counts()).toEqual({ generations: 1, inventories: 2 });
  });
  it('stops on capacity exhaustion without bypassing task caps or retrying', async () => {
    const f = await fixture({ quota: 1 }); const report = await runResourceReviewBenchmark(f.input);
    expect(report).toMatchObject({ status: 'stopped', stopReason: 'no-capacity', evaluatedCases: 1, score: null });
    expect(f.counts().generations).toBe(1); expect(report.trials[1]?.receipt).toBeNull();
  });
  it('stops on execution failure without scoring it as a model answer', async () => {
    const f = await fixture({ httpFailure: true }); const report = await runResourceReviewBenchmark(f.input);
    expect(report).toMatchObject({ status: 'stopped', evaluatedCases: 0, score: null });
    expect(report.trials[0]?.evaluation).toBeNull(); expect(f.counts().generations).toBe(1);
  });
  it('rejects unpinned local identity and prior cancellation before contact', async () => {
    const f = await fixture(); await expect(runResourceReviewBenchmark({ ...f.input, expectedModelDigest: undefined })).rejects.toThrow('exact Ollama');
    await expect(runResourceReviewBenchmark({ ...f.input, repeats: 4 })).rejects.toThrow('Invalid');
    await expect(runResourceReviewBenchmark({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    expect(f.counts()).toEqual({ generations: 0, inventories: 0 }); expect(existsSync(f.input.root)).toBe(false);
  });
  it('pins store and model identity across inventory awaits despite caller option changes', async () => {
    const f = await fixture({ onInventory(count) { if (count === 1) {
      input.root = changedRoot; input.expectedModelDigest = `sha256:${'b'.repeat(64)}`;
      input.workerId = 'different'; input.runId = 'different'; input.cwd = changedRoot;
    } } });
    const changedRoot = join(f.base, 'must-stay-absent');
    const input: Parameters<typeof runResourceReviewBenchmark>[0] = { ...f.input };
    const report = await runResourceReviewBenchmark(input);
    expect(report).toMatchObject({ status: 'completed', runId: 'run-a', workerId: 'local-a',
      modelIdentity: { digest: f.input.expectedModelDigest } });
    expect(resourcePoolStatus(f.input.root, f.input.pool, f.input.bindings, []).attempts).toHaveLength(3);
    expect(existsSync(changedRoot)).toBe(false); expect(f.counts()).toEqual({ generations: 3, inventories: 3 });
  });
  it('retains its original cancellation signal and awaits an admitted held request', async () => {
    const controller = new AbortController(); const f = await fixture({ hold: true });
    const input: Parameters<typeof runResourceReviewBenchmark>[0] = { ...f.input, signal: controller.signal };
    const running = runResourceReviewBenchmark(input); input.signal = new AbortController().signal;
    await vi.waitFor(() => expect(f.counts().generations).toBe(1)); controller.abort();
    const report = await running;
    expect(report).toMatchObject({ status: 'stopped', evaluatedCases: 0, score: null });
    expect(report.trials[0]).toMatchObject({ receipt: { status: 'cancelled' }, evaluation: null });
    expect(resourcePoolStatus(f.input.root, f.input.pool, f.input.bindings, []).attempts[0]?.status).toBe('cancelled');
    expect(f.counts()).toEqual({ generations: 1, inventories: 1 });
  });
  it('records a held request timeout without inventing a quality evaluation', async () => {
    const f = await fixture({ hold: true }); const report = await runResourceReviewBenchmark({ ...f.input, timeoutMs: 250 });
    expect(report).toMatchObject({ status: 'stopped', evaluatedCases: 0, passedCases: 0, score: null });
    expect(report.trials[0]).toMatchObject({ receipt: { status: 'timed-out', inputTokens: null, outputTokens: null }, evaluation: null });
    expect(f.counts()).toEqual({ generations: 1, inventories: 1 });
  });
  it('uses the source CLI command contract with private exclusive report output', async () => {
    const f = await fixture(); const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const inputs = { pool: f.input.pool, bindings: f.input.bindings, observations: f.input.observations };
    for (const [name, value] of Object.entries(inputs)) writeFileSync(join(f.base, `${name}.json`), JSON.stringify(value), { mode: 0o600 });
    const output = join(f.base, 'report.json');
    const args = ['benchmark', '--root', f.input.root, '--pool', join(f.base, 'pool.json'), '--bindings', join(f.base, 'bindings.json'),
      '--observations', join(f.base, 'observations.json'), '--workspace', f.input.cwd, '--worker', 'local-a', '--run-id', 'run-cli',
      '--expected-model-digest', f.input.expectedModelDigest, '--output', output, '--json'];
    expect(await cmdResourcePool(args)).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ score: 1, evaluatedCases: 3 });
    expect(statSync(output).mode & 0o777).toBe(0o600); expect(log.mock.calls.at(-1)?.[0]).not.toContain('function reading');
    expect(await cmdResourcePool(args)).toBe(1); expect(f.counts().generations).toBe(3);
  });
  it.each([[], ['--help', '--json'], ['--root', '/'], ['--wat'], ['--json', '--json'], ['--worker', 'bad\n']])('rejects invalid CLI input', async (...args) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdResourcePool(['benchmark', ...args])).toBe(2);
  });
  it('shows help without execution', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdResourcePool(['benchmark', '--help'])).toBe(0); expect(log.mock.calls[0]?.[0]).toContain('not accepted engineering yield');
  });
});
