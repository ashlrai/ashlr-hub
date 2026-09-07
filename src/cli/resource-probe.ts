import { closeSync } from 'node:fs';
import { dirname, isAbsolute, parse as parsePath, resolve } from 'node:path';
import { outputMetadata, reserveOutput, saveOutput } from './resource-pool.js';

const USAGE = `usage: ashlr resources pool probe --pool ABS --bindings ABS --worker ID
       --bucket ID [--bucket ID ...] --output NEW_ABS [--expected-account-hint HEX]
       [--timeout-ms 1..30000] [--json]

Reads native Codex account/quota metadata through one explicitly enrolled launcher.
This contacts that native provider but creates no thread, turn or model request.
The native client may maintain its own authentication/cache. No login, account
switch, token extraction, quota reset, API-key fallback or resident activation.
The helper runs in private scratch, not a project directory. Native global
configuration remains native-managed. Operator wrappers must forward app-server.
1..4 explicit bucket IDs are required. Account metadata is checked before and
after quota capture; the opaque hint is not stable workspace identity or proof
of independent capacity. --expected-account-hint pins a previously checked hint.
The NEW private output is reserved before contact; failed preflight may leave an
empty file. Reports contain sanitized metadata, never native emails or tokens.
No pool ledger, routing priority or enrollment file is written by this command.
Exit codes: 0 observed metadata, 1 unavailable/cancelled/uncertain, 2 invalid CLI syntax.
Observed metadata can still contain unknown/exhausted quota; it is not readiness.
`;
class UsageError extends Error {}
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function parse(args: string[]) {
  if (args.length > 25 || args.some((arg) => typeof arg !== 'string' || Buffer.byteLength(arg) > 4096 ||
    [...arg].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)) ||
    Buffer.byteLength(args.join('\0')) > 32 * 1024) throw new UsageError('Invalid probe arguments');
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true as const };
  const values = new Map<string, string>(); const bucketIds: string[] = []; let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--json') { if (json) throw new UsageError('Duplicate probe option'); json = true; continue; }
    if (!['--pool', '--bindings', '--worker', '--bucket', '--output', '--expected-account-hint', '--timeout-ms'].includes(flag) ||
      flag !== '--bucket' && values.has(flag)) throw new UsageError('Unknown or duplicate probe option');
    const value = args[++index]; if (!value || value.startsWith('-')) throw new UsageError('Probe option requires a value');
    if (flag === '--bucket') {
      if (!ID.test(value) || bucketIds.includes(value) || bucketIds.length >= 4) throw new UsageError('Expected 1..4 unique bucket IDs');
      bucketIds.push(value); continue;
    }
    if (['--pool', '--bindings', '--output'].includes(flag) && (!isAbsolute(value) || resolve(value) !== value || parsePath(value).root === value)) {
      throw new UsageError('Probe paths must be canonical absolute non-root paths');
    }
    values.set(flag, value);
  }
  if (['--pool', '--bindings', '--worker', '--output'].some((flag) => !values.has(flag)) || !bucketIds.length ||
    !ID.test(values.get('--worker')!)) throw new UsageError('Probe requires explicit pool, bindings, worker, buckets and new output');
  const expectedAccountHint = values.get('--expected-account-hint');
  if (expectedAccountHint !== undefined && !/^[a-f0-9]{64}$/.test(expectedAccountHint)) throw new UsageError('Expected exact account hint');
  const timeoutText = values.get('--timeout-ms') ?? '10000';
  const timeoutMs = Number(timeoutText);
  if (!/^[1-9][0-9]*$/.test(timeoutText) || !Number.isSafeInteger(timeoutMs) || timeoutMs > 30_000) throw new UsageError('Invalid probe timeout');
  return { help: false as const, pool: values.get('--pool')!, bindings: values.get('--bindings')!, workerId: values.get('--worker')!,
    output: values.get('--output')!, bucketIds, expectedAccountHint, timeoutMs, json };
}

export async function cmdResourceProbe(args: string[]): Promise<number> {
  let reserved: ReturnType<typeof reserveOutput> | undefined;
  const controller = new AbortController(); const abort = () => controller.abort();
  try {
    const options = parse(args); if (options.help) { console.log(USAGE); return 0; }
    process.on('SIGINT', abort); process.on('SIGTERM', abort);
    const [{ readResourceJson }, { probeCodexResourceAccount }] = await Promise.all([
      import('../core/resources/pool-runtime.js'), import('../core/resources/codex-account-probe.js'),
    ]);
    const pool = readResourceJson(options.pool) as import('../core/resources/pool-policy.js').ResourcePool;
    const bindings = readResourceJson(options.bindings) as import('../core/resources/worker.js').ResourceBinding[];
    if (controller.signal.aborted) throw new Error('Probe cancelled before output reservation');
    reserved = reserveOutput(options.output);
    const report = await probeCodexResourceAccount({ pool, bindings, workerId: options.workerId,
      cwd: dirname(options.pool), bucketIds: options.bucketIds, expectedAccountHint: options.expectedAccountHint,
      timeoutMs: options.timeoutMs, signal: controller.signal });
    saveOutput(reserved, JSON.stringify(report, null, 2) + '\n');
    console.log(options.json ? JSON.stringify({ report, outputFile: outputMetadata(reserved) }) : [
      `Native metadata ${report.status}: ${report.reason}.`, `Report: ${options.output}`,
      'No model task or enrollment was created. A reported account hint is not independent capacity proof.',
    ].join('\n'));
    return report.status === 'observed' ? 0 : 1;
  } catch (error) {
    const message = error instanceof UsageError ? error.message : 'Native probe unavailable; inspect the reserved report before retrying';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message, outputFile: outputMetadata(reserved) }));
    else console.error(message);
    return error instanceof UsageError ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    if (reserved) closeSync(reserved.fd);
  }
}
