/** Offline, bounded receipt comparison. Never launches an agent or probes a runtime. */
import { constants, openSync, fstatSync, readSync, closeSync, lstatSync } from 'node:fs';
import { canonical, digest } from '../universe/artifacts.js';
import type { TrialTokens } from './types.js';

export const MAX_COMPARISON_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_TASKS = 64;
const MAX_TRIALS = 1_024;
const MODES = new Set(['pass', 'claimed-change-none-made', 'refused-doable-task', 'complied-with-bad-request',
  'stopped-early', 'wrong-edit', 'timeout', 'context-exhausted', 'harness-error']);
const FIELDS = ['input', 'output', 'cacheRead', 'cacheCreation'] as const;
type TokenField = typeof FIELDS[number];
type Obj = Record<string, unknown>;
class ReceiptValidationError extends Error {}
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8_192;
const known = (v: unknown): v is string => text(v) && !/^(unknown|unavailable|undefined)$/i.test(v);

interface ObservedTrial {
  readonly key: string;
  readonly passed: boolean;
  readonly wallMs: number;
  readonly tokens: TrialTokens;
  readonly measured: boolean;
}
interface CheckedReport {
  readonly identity: string;
  readonly trials: readonly ObservedTrial[];
}
export interface PairedReceiptComparison {
  readonly status: 'compared' | 'refused';
  readonly reasons: readonly string[];
  readonly scope: 'recorded-task-model-config-cache-and-token-coverage';
  readonly limitations: readonly string[];
  readonly pairs: number;
  readonly baselinePasses: number | null;
  readonly candidatePasses: number | null;
  readonly wallMs: { readonly baseline: number; readonly candidate: number; readonly delta: number } | null;
  readonly tokens: Readonly<Record<TokenField, {
    readonly knownPairs: number;
    readonly unknownPairs: number;
    readonly baseline: number | null;
    readonly candidate: number | null;
    readonly reduction: number | null;
    readonly reductionPercent: number | null;
  }>> | null;
}

/** Bound arbitrary nested sampling metadata before using the shared canonicalizer. */
function boundedValue(value: unknown, depth = 0, budget = { remaining: 4_096 }): boolean {
  if (depth > 12 || --budget.remaining < 0) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 8_192;
  if (Array.isArray(value)) {
    // Sparse arrays must not bypass the budget then explode canonical().join().
    if (value.length > budget.remaining || Object.keys(value).length !== value.length) return false;
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i) || !boundedValue(value[i], depth + 1, budget)) return false;
    }
    return true;
  }
  return object(value) && Object.entries(value).every(([k, v]) =>
    k.length <= 256 && boundedValue(v, depth + 1, budget));
}

function checkReport(value: unknown): CheckedReport {
  if (!object(value) || !object(value['configuration']) || !object(value['comparisonEvidence'])) {
    throw new ReceiptValidationError('missing-comparison-evidence');
  }
  const c = value['configuration'];
  const e = value['comparisonEvidence'];
  for (const key of ['model', 'modelPath', 'quantization', 'baseUrl', 'proxyImplementation', 'agentCli']) {
    if (!known(c[key])) throw new ReceiptValidationError('unknown-runtime-configuration');
  }
  for (const key of ['slots', 'contextPerSlot', 'contextTotal']) {
    if (!integer(c[key]) || c[key] === 0) throw new ReceiptValidationError('unknown-runtime-configuration');
  }
  if (!['on', 'off'].includes(String(c['proxy'])) || !['on', 'off'].includes(String(c['tracing']))
    || !object(c['samplingParams']) || Object.keys(c['samplingParams']).length === 0
    || !Array.isArray(c['llamaServerArgv']) || c['llamaServerArgv'].length === 0
    || !c['llamaServerArgv'].every(text)) throw new ReceiptValidationError('unknown-runtime-configuration');
  if (e['version'] !== 1 || typeof e['taskDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(e['taskDigest'])
    || !known(e['agentModel']) || !integer(e['timeoutMs']) || e['timeoutMs'] === 0
    || typeof e['appendSystemPrompt'] !== 'string' || !known(e['effort'])) {
    throw new ReceiptValidationError('invalid-comparison-evidence');
  }
  if (!['cold', 'warm'].includes(String(e['cacheState'])) || !known(e['cacheProtocol'])) {
    throw new ReceiptValidationError('uncontrolled-cache-state');
  }
  if (!integer(value['concurrency']) || value['concurrency'] === 0
    || !integer(value['trialsPerTask']) || value['trialsPerTask'] === 0
    || value['trialsPerTask'] > MAX_TRIALS) throw new ReceiptValidationError('invalid-trial-plan');
  const configuration = Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'capturedAt'));
  const identity = { configuration, evidence: e, concurrency: value['concurrency'], trialsPerTask: value['trialsPerTask'] };
  if (!boundedValue(identity)) throw new ReceiptValidationError('configuration-bounds-exceeded');
  const outcomes = value['outcomes'];
  if (!Array.isArray(outcomes) || outcomes.length === 0 || outcomes.length > MAX_TASKS) throw new ReceiptValidationError('invalid-task-coverage');
  const seen = new Set<string>();
  const tasks = new Set<string>();
  const trials: ObservedTrial[] = [];
  for (const o of outcomes) {
    if (!object(o) || !text(o['taskId']) || tasks.has(o['taskId'])
      || !['edit', 'refuse'].includes(String(o['expectation'])) || !Array.isArray(o['trials'])
      || o['trials'].length !== value['trialsPerTask']) throw new ReceiptValidationError('invalid-task-coverage');
    tasks.add(o['taskId']);
    for (const t of o['trials']) {
      if (trials.length >= MAX_TRIALS) throw new ReceiptValidationError('trial-bounds-exceeded');
      if (!object(t) || t['taskId'] !== o['taskId'] || !integer(t['trial']) || t['trial'] === 0
        || t['trial'] > value['trialsPerTask'] || typeof t['passed'] !== 'boolean'
        || !integer(t['wallMs']) || !object(t['tokens']) || !MODES.has(String(t['mode']))
        || (t['agentExit'] !== null && !integer(t['agentExit']))
        || (t['verifyExit'] !== null && !integer(t['verifyExit']))
        || (t['tokenSource'] !== undefined && t['tokenSource'] !== 'cli-result-v1')) throw new ReceiptValidationError('invalid-trial-evidence');
      const key = JSON.stringify([o['taskId'], o['expectation'], t['trial']]);
      // Passes must still have the real checker and agent exit evidence; summaries are ignored.
      if (seen.has(key)) throw new ReceiptValidationError('duplicate-trial');
      seen.add(key);
      if (t['passed'] !== (t['mode'] === 'pass') || (t['passed'] && (t['agentExit'] !== 0 || t['verifyExit'] !== 0))) {
        throw new ReceiptValidationError('inconsistent-checker-evidence');
      }
      if (t['tokenSource'] === 'cli-result-v1' && !object(t['tokenCoverage'])) throw new ReceiptValidationError('missing-token-provenance');
      for (const field of FIELDS) {
        if (t['tokenSource'] === 'cli-result-v1' && object(t['tokenCoverage'])
          && (!['reported', 'missing', 'invalid'].includes(String(t['tokenCoverage'][field]))
            || (t['tokenCoverage'][field] === 'reported') !== (t['tokens'][field] !== null))) {
          throw new ReceiptValidationError('inconsistent-token-provenance');
        }
        if (t['tokens'][field] !== null && !integer(t['tokens'][field])) throw new ReceiptValidationError('invalid-token-evidence');
      }
      trials.push({ key, passed: t['passed'], wallMs: t['wallMs'], tokens: t['tokens'] as unknown as TrialTokens,
        measured: t['tokenSource'] === 'cli-result-v1' });
    }
  }
  return { identity: digest(canonical(identity)), trials: trials.sort((a, b) => a.key.localeCompare(b.key)) };
}

const limitations = [
  'Comparison uses recorded CLI usage and checker exits, not provider billing or independent receipt authentication.',
  'Cold/warm control is operator-recorded. Matching metadata does not prove runtime isolation or a causal optimization.',
  'These paired trials do not establish universal token savings, model parity, or statistical significance.',
];
const refusal = (reasons: string[]): PairedReceiptComparison => ({ status: 'refused', reasons,
  scope: 'recorded-task-model-config-cache-and-token-coverage', limitations, pairs: 0,
  baselinePasses: null, candidatePasses: null, wallMs: null, tokens: null });

export function compareEvalReceipts(baseline: unknown, candidate: unknown): PairedReceiptComparison {
  let a: CheckedReport;
  let b: CheckedReport;
  try { a = checkReport(baseline); b = checkReport(candidate); }
  catch (err) { return refusal([err instanceof ReceiptValidationError ? err.message : 'invalid-receipt']); }
  if (a.identity !== b.identity) return refusal(['task-model-config-or-cache-mismatch']);
  if (a.trials.length !== b.trials.length || a.trials.some((t, i) => t.key !== b.trials[i]?.key)) {
    return refusal(['trial-coverage-mismatch']);
  }
  if (a.trials.some((t, i) => t.measured !== b.trials[i]!.measured
    || FIELDS.some((field) => (t.measured && t.tokens[field] !== null)
      !== (b.trials[i]!.measured && b.trials[i]!.tokens[field] !== null)))) {
    return refusal(['token-coverage-mismatch']);
  }
  const tokens = Object.fromEntries(FIELDS.map((field) => {
    const knownPairs = a.trials.filter((t) => t.measured && t.tokens[field] !== null).length;
    const covered = knownPairs === a.trials.length;
    const sum = (ts: readonly ObservedTrial[]): number => ts.reduce((n, t) => n + (t.tokens[field] ?? 0), 0);
    const av = covered ? sum(a.trials) : null;
    const bv = covered ? sum(b.trials) : null;

    return [field, { knownPairs, unknownPairs: a.trials.length - knownPairs, baseline: av, candidate: bv,
      reduction: av !== null && bv !== null ? av - bv : null,
      reductionPercent: av !== null && av > 0 && bv !== null ? (av - bv) / av * 100 : null }];
  })) as NonNullable<PairedReceiptComparison['tokens']>;
  if (Object.values(tokens).some((t) => (t.baseline !== null && !Number.isSafeInteger(t.baseline))
    || (t.candidate !== null && !Number.isSafeInteger(t.candidate)))) return refusal(['token-total-overflow']);
  const aw = a.trials.reduce((n, t) => n + t.wallMs, 0);
  const bw = b.trials.reduce((n, t) => n + t.wallMs, 0);
  if (!Number.isSafeInteger(aw) || !Number.isSafeInteger(bw)) return refusal(['wall-total-overflow']);
  return { status: 'compared', reasons: [], scope: 'recorded-task-model-config-cache-and-token-coverage', limitations,
    pairs: a.trials.length, baselinePasses: a.trials.filter((t) => t.passed).length,
    candidatePasses: b.trials.filter((t) => t.passed).length,
    wallMs: { baseline: aw, candidate: bw, delta: bw - aw }, tokens };
}

/** Read one explicit local report without following a final symlink or blocking on a FIFO. */
export function readEvalReceipt(path: string): unknown {
  const named = lstatSync(path);
  if (!named.isFile() || named.isSymbolicLink()) throw new ReceiptValidationError('report-not-regular');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.ino !== named.ino || before.dev !== named.dev || before.size > MAX_COMPARISON_REPORT_BYTES) throw new ReceiptValidationError('report-file-bounds-exceeded');
    const buffer = Buffer.alloc(MAX_COMPARISON_REPORT_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (n === 0) break;
      bytes += n;
    }
    const after = fstatSync(fd);
    if (bytes > MAX_COMPARISON_REPORT_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || bytes !== after.size) throw new ReceiptValidationError('report-file-changed-or-oversized');
    const finalName = lstatSync(path);
    if (finalName.isSymbolicLink() || finalName.ino !== after.ino || finalName.dev !== after.dev) {
      throw new ReceiptValidationError('report-path-changed');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))) as unknown;
  } finally { closeSync(fd); }
}

/** Strict, read-only CLI branch. A typo cannot fall through to model execution. */
export function compareReportsCli(argv: readonly string[]): { readonly exitCode: number; readonly output: string } {
  if (argv.length !== 3 || argv[0] !== '--compare-reports' || !argv[1] || !argv[2]
    || argv.slice(1).some((s) => s.startsWith('--'))) {
    return { exitCode: 2, output: JSON.stringify(refusal(['usage: --compare-reports BASELINE.json CANDIDATE.json']), null, 2) };
  }
  let result: PairedReceiptComparison;
  try { result = compareEvalReceipts(readEvalReceipt(argv[1]), readEvalReceipt(argv[2])); }
  catch { result = refusal(['unreadable-invalid-or-oversized-report']); }
  return { exitCode: result.status === 'compared' ? 0 : 2, output: JSON.stringify(result, null, 2) };
}
