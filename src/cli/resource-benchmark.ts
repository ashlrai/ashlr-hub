import { closeSync } from 'node:fs';
import { isAbsolute, parse as parsePath, resolve } from 'node:path';
import { outputMetadata, reserveOutput, saveOutput } from './resource-pool.js';

const USAGE = `usage: ashlr resources pool benchmark --root ABS --pool ABS --bindings ABS --observations ABS
       --worker ID --run-id ID --workspace ABS --output ABS [--repeats 1..3]
       [--timeout-ms 1..180000] [--max-output-tokens 64..2048]
       [--expected-model-digest sha256:HEX] [--json]

Runs the fixed review-calibration-v1 suite (3 cases per repeat) through one
explicitly enrolled worker, sequentially. This contacts that worker and consumes
its resources. No auto-retry, account switching, service activation or downloads.
Local workers require an installed Ollama model's exact digest; inventory is
checked before each task. Native model identity is configured, not attested.
The workspace must be a canonical directory; tasks are read-only. The prompts
contain all test code. Generated output is parsed, never executed.
--output reserves a NEW private JSON report before worker contact. Existing
files are never overwritten. A failed preflight can leave an empty reserved file.
Report metadata includes fixed-suite checks and durable task receipts, not raw
model output. Reusing a recorded run ID/worker is refused, never rescored.
Use matching suite/workload digests for comparisons; results are a small review
calibration, not accepted engineering yield or a general model leaderboard.
No routing priority changes. Missing evaluations remain unknown.
Exit codes: 0 all cases passed, 1 stopped or a check failed, 2 invalid input.
`;
class UsageError extends Error {}
type Options = { help: true } | { help: false; root: string; pool: string; bindings: string; observations: string;
  workerId: string; runId: string; cwd: string; output: string; repeats: number; timeoutMs: number;
  maxOutputTokens: number; expectedModelDigest?: string; json: boolean };
function parse(args: string[]): Options {
  if (args.length > 27 || args.some((arg) => typeof arg !== 'string' || Buffer.byteLength(arg) > 4_096 ||
      [...arg].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)) ||
      Buffer.byteLength(args.join('\0')) > 32 * 1024) throw new UsageError('Invalid benchmark arguments');
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true };
  const paths = ['--root', '--pool', '--bindings', '--observations', '--workspace', '--output'];
  const flags = [...paths, '--worker', '--run-id', '--repeats', '--timeout-ms', '--max-output-tokens', '--expected-model-digest'];
  const values = new Map<string, string>(); let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--json') { if (json) throw new UsageError('Duplicate benchmark option'); json = true; continue; }
    if (!flags.includes(flag) || values.has(flag)) throw new UsageError('Unknown or duplicate benchmark option');
    const value = args[++index]; if (!value || value.startsWith('-')) throw new UsageError('Benchmark option requires a value');
    if (paths.includes(flag) && (!isAbsolute(value) || resolve(value) !== value || parsePath(value).root === value)) {
      throw new UsageError('Benchmark paths must be canonical absolute non-root paths');
    }
    values.set(flag, value);
  }
  if ([...paths, '--worker', '--run-id'].some((key) => !values.has(key)) ||
      !['--worker', '--run-id'].every((key) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(values.get(key)!))) {
    throw new UsageError('Benchmark requires explicit scope, worker, run ID and new output file');
  }
  function number(key: string, fallback: number, min: number, max: number): number {
    const text = values.get(key); if (text === undefined) return fallback;
    const value = Number(text); if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new UsageError(`Invalid ${key} bound`);
    }
    return value;
  }
  const expectedModelDigest = values.get('--expected-model-digest');
  if (expectedModelDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(expectedModelDigest)) throw new UsageError('Expected exact sha256 model digest');
  return { help: false, root: values.get('--root')!, pool: values.get('--pool')!, bindings: values.get('--bindings')!,
    observations: values.get('--observations')!, workerId: values.get('--worker')!, runId: values.get('--run-id')!,
    cwd: values.get('--workspace')!, output: values.get('--output')!, repeats: number('--repeats', 1, 1, 3),
    timeoutMs: number('--timeout-ms', 120_000, 1, 180_000), maxOutputTokens: number('--max-output-tokens', 512, 64, 2_048),
    ...(expectedModelDigest ? { expectedModelDigest } : {}), json };
}

export async function cmdResourceBenchmark(args: string[]): Promise<number> {
  let reserved: ReturnType<typeof reserveOutput> | undefined;
  const controller = new AbortController(); const interrupt = () => controller.abort();
  try {
    const options = parse(args); if (options.help) { console.log(USAGE); return 0; }
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    const [{ readResourceJson }, { runResourceReviewBenchmark }] = await Promise.all([
      import('../core/resources/pool-runtime.js'), import('../core/resources/review-benchmark.js'),
    ]);
    const pool = readResourceJson(options.pool) as import('../core/resources/pool-policy.js').ResourcePool;
    const bindings = readResourceJson(options.bindings) as import('../core/resources/worker.js').ResourceBinding[];
    const observations = readResourceJson(options.observations) as import('../core/resources/pool-policy.js').ResourceObservation[];
    if (controller.signal.aborted) throw new Error('Cancelled before reservation');
    reserved = reserveOutput(options.output);
    const report = await runResourceReviewBenchmark({ ...options, pool, bindings, observations, signal: controller.signal });
    saveOutput(reserved, JSON.stringify(report, null, 2) + '\n');
    console.log(options.json ? JSON.stringify({ report, outputFile: outputMetadata(reserved) }) : [
      `Review calibration ${report.status}: ${report.passedCases}/${report.expectedCases} cases passed; ${report.evaluatedCases} evaluated.`,
      ...(report.stopReason ? [`Stopped: ${report.stopReason}. Inspect the ledger before another run.`] : []),
      `Report: ${options.output}`, 'Fixed review calibration only; not verified accepted changes. Routing is unchanged.',
    ].join('\n'));
    return report.status === 'completed' && report.score === 1 ? 0 : 1;
  } catch (error) {
    const message = error instanceof UsageError ? error.message : 'Benchmark failed; inspect the ledger and reserved output before retrying';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message, outputFile: outputMetadata(reserved) }));
    else console.error(message, reserved ? `Reserved output: ${reserved.path} (${reserved.state}).` : '');
    return error instanceof UsageError ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    if (reserved) closeSync(reserved.fd);
  }
}
