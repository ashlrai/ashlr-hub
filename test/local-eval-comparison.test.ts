import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareEvalReceipts, compareReportsCli, MAX_COMPARISON_REPORT_BYTES, readEvalReceipt } from '../src/core/local-eval/compare.js';
import { parseAgentResult } from '../src/core/local-eval/runner.js';
import { buildReport, renderReport, summariseTask } from '../src/core/local-eval/report.js';
import { parseArgs } from '../src/core/local-eval/main.js';
import { taskSetDigest } from '../src/core/local-eval/tasks-heldout.js';
import type { EvalReport, TaskSpec, TrialResult, HarnessConfiguration } from '../src/core/local-eval/types.js';

const task: TaskSpec = { id: 'edit', expectation: 'edit', why: 'real checker', prompt: 'Change the fixture.',
  files: { 'source.txt': 'before' }, check: 'if (text !== "after") process.exit(1)', verify: ['node', 'check.mjs'] };
const config: HarnessConfiguration = { model: 'local-model', modelPath: '/models/sha256-abc', quantization: 'Q8',
  slots: 2, contextPerSlot: 4096, contextTotal: 8192, samplingParams: { temperature: 0 },
  baseUrl: 'http://127.0.0.1:9000', proxy: 'on', tracing: 'on', proxyImplementation: 'ashlr',
  agentCli: 'claude', llamaServerArgv: ['llama-server', '--model', '/models/sha256-abc'], capturedAt: '2026-09-30' };
function trial(over: Partial<TrialResult> = {}): TrialResult {
  return { taskId: task.id, trial: 1, mode: 'pass', passed: true, wallMs: 1000,
    tokens: { input: 100, output: 20, cacheRead: 0, cacheCreation: null }, tokenSource: 'cli-result-v1',
    tokenCoverage: { input: 'reported', output: 'reported', cacheRead: 'reported', cacheCreation: 'missing' },
    tokenTotalStatus: 'not-reported',
    agentExit: 0, verifyExit: 0, changedFiles: 1, claim: 'claims-change', integrity: 'consistent', turns: 1,
    note: 'private transcript marker', timeoutDiagnosis: null, trace: null, ...over };
}
function report(trials = [trial()]): EvalReport {
  return buildReport({ configuration: config, outcomes: [summariseTask(task, trials)], trialsPerTask: trials.length,
    concurrency: 1, startedAt: 0, finishedAt: 2000, comparisonEvidence: { version: 1, taskDigest: taskSetDigest([task]),
      cacheState: 'cold', cacheProtocol: 'operator restarted runtime before each arm; same fixed fixture',
      agentModel: 'local-model', timeoutMs: 5000, appendSystemPrompt: '', effort: 'default' } });
}
const dirs: string[] = [];
function scratch(): string { const path = mkdtempSync(join(tmpdir(), 'eval-compare-')); dirs.push(path); return path; }
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('CLI usage coverage', () => {
  it.each(['bad json', 'null', '[]', '42', '"text"'])('keeps absent usage unknown and malformed root an error: %s', (stdout) => {
    expect(parseAgentResult(stdout)).toMatchObject({ isError: true, tokens: { input: null, output: null, cacheRead: null, cacheCreation: null } });
  });
  it('retains measured zero and independently validates each field', () => {
    expect(parseAgentResult(JSON.stringify({ usage: { input_tokens: 0, output_tokens: '10', cache_read_input_tokens: -1,
      cache_creation_input_tokens: 2.5 } })).tokens).toEqual({ input: 0, output: null, cacheRead: null, cacheCreation: null });
    expect(parseAgentResult('{"usage":{"input_tokens":1e999,"output_tokens":9007199254740992}}').tokens)
      .toMatchObject({ input: null, output: null });
  });
  it.each([null, [], 'bad', 0, {}])('does not infer omitted usage fields from malformed usage %j', (usage) => {
    expect(parseAgentResult(JSON.stringify({ result: 'done', usage })).tokens)
      .toEqual({ input: null, output: null, cacheRead: null, cacheCreation: null });
  });
  it('records per-field provenance and never synthesizes a total from cache counters', () => {
    const parsed = parseAgentResult('{"usage":{"input_tokens":0,"output_tokens":1,"cache_read_input_tokens":"bad"}}');
    expect(parsed.tokenCoverage).toEqual({ input: 'reported', output: 'reported', cacheRead: 'invalid', cacheCreation: 'missing' });
    expect(parsed.tokenTotalStatus).toBe('not-reported');
    const compatible = parseAgentResult('{"usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":20,"total_tokens":32}}');
    expect(compatible.tokenTotalStatus).toBe('unverified');
    expect(compatible.tokens).toMatchObject({ input: 10, output: 2, cacheRead: 20 });
  });
  it.each([0, 11, '12', -1])('ignores unqualified aggregate semantics without discarding valid counters: %j', (total_tokens) => {
    const parsed = parseAgentResult(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, total_tokens } }));
    expect(parsed.tokens).toEqual({ input: 10, output: 2, cacheRead: 20, cacheCreation: 5 });
    expect(parsed.tokenTotalStatus).toBe('unverified');
    expect(parsed.tokenCoverage.input).toBe('reported');
  });
  it('renders new valid zero, unknown partial coverage, and legacy fallback zeros distinctly', () => {
    const current = renderReport(report());
    expect(current).toContain('unknown');
    expect(current).toMatch(/100\s+20\s+0\s+unknown/);
    const legacy = trial({ tokenSource: undefined, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } });
    expect(renderReport(report([legacy]))).toMatch(/unknown\s+unknown\s+unknown\s+unknown/);
  });
});

describe('matched offline comparisons', () => {
  it('reports checker passes and complete measured fields without inventing partial totals', () => {
    const a = report();
    const b = report([trial({ passed: false, mode: 'wrong-edit', verifyExit: 1, wallMs: 500,
      tokens: { input: 50, output: 10, cacheRead: 0, cacheCreation: null } })]);
    const result = compareEvalReceipts(a, b);
    expect(result).toMatchObject({ status: 'compared', pairs: 1, baselinePasses: 1, candidatePasses: 0,
      wallMs: { baseline: 1000, candidate: 500, delta: -500 }, tokens: {
        input: { knownPairs: 1, baseline: 100, candidate: 50, reduction: 50, reductionPercent: 50 },
        cacheRead: { baseline: 0, candidate: 0, reduction: 0, reductionPercent: null },
        cacheCreation: { knownPairs: 0, unknownPairs: 1, baseline: null, candidate: null, reduction: null },
      } });
    expect(JSON.stringify(result)).not.toContain('private transcript marker');
    expect(JSON.stringify(result)).not.toContain('/models/');
    expect(result.limitations.join(' ')).toContain('not establish universal');
  });
  it('recomputes scores rather than trusting the recorded aggregate', () => {
    const b = { ...report(), totalPasses: 900, overallPassRate: 900 };
    expect(compareEvalReceipts(report(), b).candidatePasses).toBe(1);
  });
  it('ignores capture time and JSON key ordering, not configuration changes', () => {
    const b = report();
    expect(compareEvalReceipts(report(), { ...b, configuration: { ...config, capturedAt: 'tomorrow', samplingParams: { temperature: 0 } } }).status).toBe('compared');
  });
  it.each(['model', 'quantization', 'agentCli', 'baseUrl'])('refuses a changed runtime %s', (field) => {
    expect(compareEvalReceipts(report(), { ...report(), configuration: { ...config, [field]: 'different' } }))
      .toMatchObject({ status: 'refused', tokens: null });
  });
  it.each(['cacheState', 'cacheProtocol', 'agentModel', 'timeoutMs', 'effort', 'appendSystemPrompt', 'taskDigest'])('refuses changed evidence %s', (field) => {
    const b = report();
    const changed = field === 'timeoutMs' ? 10000 : field === 'cacheState' ? 'warm' : field === 'taskDigest' ? 'a'.repeat(64) : 'different';
    expect(compareEvalReceipts(report(), { ...b, comparisonEvidence: { ...b.comparisonEvidence, [field]: changed } }).status).toBe('refused');
  });
  it('binds task prompts, fixture, checker and verify argv rather than names alone', () => {
    for (const changed of [{ prompt: 'other' }, { files: { 'source.txt': 'other' } }, { check: 'process.exit(0)' }, { verify: ['false'] }, { expectation: 'refuse' as const }]) {
      expect(taskSetDigest([{ ...task, ...changed }])).not.toBe(taskSetDigest([task]));
    }
  });
  it('refuses uncontrolled caches, absent legacy comparison metadata, and unknown runtime fields', () => {
    const b = report();
    expect(compareEvalReceipts(b, { ...b, comparisonEvidence: undefined }).status).toBe('refused');
    expect(compareEvalReceipts(b, { ...b, comparisonEvidence: { ...b.comparisonEvidence, cacheState: 'uncontrolled' } }).reasons).toContain('uncontrolled-cache-state');
    expect(compareEvalReceipts(b, { ...b, configuration: { ...config, model: 'unknown' } }).reasons).toContain('unknown-runtime-configuration');
    expect(parseArgs([]).cacheState).toBe('uncontrolled');
    expect(() => parseArgs(['--cache-state', 'guess'])).toThrow();
  });
  it('refuses differing nullable/source coverage including a legacy false zero', () => {
    expect(compareEvalReceipts(report(), report([trial({ tokens: { input: null, output: 20, cacheRead: 0, cacheCreation: null },
      tokenCoverage: { input: 'missing', output: 'reported', cacheRead: 'reported', cacheCreation: 'missing' } })])).reasons).toContain('token-coverage-mismatch');
    expect(compareEvalReceipts(report(), report([trial({ tokenSource: undefined })])).reasons).toContain('token-coverage-mismatch');
    const legacy = report([trial({ tokenSource: undefined })]);
    expect(compareEvalReceipts(legacy, legacy).tokens?.input).toMatchObject({ baseline: null, candidate: null, knownPairs: 0 });
  });
  it('refuses claimed provenance that contradicts the nullable values', () => {
    const fake = report([trial({ tokenCoverage: { input: 'invalid', output: 'reported', cacheRead: 'reported', cacheCreation: 'missing' } })]);
    expect(compareEvalReceipts(report(), fake).reasons).toContain('inconsistent-token-provenance');
  });
  it('refuses duplicate/missing trials and contradictory checker evidence', () => {
    expect(compareEvalReceipts(report([trial(), trial()]), report([trial(), trial()])).reasons).toContain('duplicate-trial');
    expect(compareEvalReceipts(report(), report([trial({ verifyExit: 1 })])).reasons).toContain('inconsistent-checker-evidence');
    expect(compareEvalReceipts(report(), report([trial({ agentExit: null })])).status).toBe('refused');
    expect(compareEvalReceipts(report(), report([trial({ trial: 2 })])).status).toBe('refused');
  });
  it('refuses invalid token counts and aggregate integer overflow', () => {
    expect(compareEvalReceipts(report(), report([trial({ tokens: { input: -2, output: 20, cacheRead: 0, cacheCreation: null } })])).status).toBe('refused');
    const big = report([trial({ tokens: { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheCreation: null } }),
      trial({ trial: 2, tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: null } })]);
    expect(compareEvalReceipts(big, big).reasons).toContain('token-total-overflow');
  });
  it('does not reflect arbitrary getter/proxy errors into selected evidence', () => {
    const secret = { get configuration(): never { throw new Error('secret-private-marker'); } };
    const result = compareEvalReceipts(secret, report());
    expect(result.reasons).toEqual(['invalid-receipt']);
    expect(JSON.stringify(result)).not.toContain('secret-private-marker');
  });
  it('bounds tasks, trials and deeply nested sampling metadata', () => {
    const many = { ...report(), outcomes: Array.from({ length: 65 }, () => report().outcomes[0]) };
    expect(compareEvalReceipts(many, many).reasons).toContain('invalid-task-coverage');
    const manyTrials = report(Array.from({ length: 1025 }, (_, i) => trial({ trial: i + 1 })));
    expect(compareEvalReceipts(manyTrials, manyTrials).status).toBe('refused');
    let nested: unknown = 0;
    for (let i = 0; i < 20; i++) nested = { nested };
    const sparse = { ...report(), configuration: { ...config, samplingParams: { holes: new Array(5000) } } };
    expect(compareEvalReceipts(sparse, sparse).reasons).toContain('configuration-bounds-exceeded');
    const deep = { ...report(), configuration: { ...config, samplingParams: { nested } } };
    expect(compareEvalReceipts(deep, deep).reasons).toContain('configuration-bounds-exceeded');
  });
});

describe('bounded local file and read-only CLI contract', () => {
  it('compares two receipts and refuses extra runtime flags without reaching evaluation', () => {
    const dir = scratch(); const a = join(dir, 'a.json'); const b = join(dir, 'b.json');
    writeFileSync(a, JSON.stringify(report())); writeFileSync(b, JSON.stringify(report()));
    expect(compareReportsCli(['--compare-reports', a, b]).exitCode).toBe(0);
    expect(compareReportsCli(['--compare-reports', a, b, '--experiments']).exitCode).toBe(2);
    expect(compareReportsCli(['--compare-report', a, b]).exitCode).toBe(2);
    expect(compareReportsCli(['--compare-reports', a]).exitCode).toBe(2);
  });
  it('rejects symlinks, directories, malformed JSON, invalid UTF-8, and byte-oversized reports', () => {
    const dir = scratch(); const regular = join(dir, 'a.json'); const link = join(dir, 'link.json');
    writeFileSync(regular, JSON.stringify(report())); symlinkSync(regular, link);
    expect(() => readEvalReceipt(link)).toThrow(); expect(() => readEvalReceipt(dir)).toThrow();
    writeFileSync(regular, '{'); expect(() => readEvalReceipt(regular)).toThrow();
    writeFileSync(regular, Buffer.from([0x22, 0xff, 0x22])); expect(() => readEvalReceipt(regular)).toThrow();
    writeFileSync(regular, ' '.repeat(MAX_COMPARISON_REPORT_BYTES + 1)); expect(() => readEvalReceipt(regular)).toThrow();
    const refusal = compareReportsCli(['--compare-reports', regular, regular]);
    expect(refusal.exitCode).toBe(2); expect(refusal.output).not.toContain(regular);
  });
});
