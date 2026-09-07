import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, writeSync } from 'node:fs';
import { isAbsolute, parse as parsePath, resolve } from 'node:path';

const USAGE = `usage: ashlr resources pool status --root ABS --pool ABS --bindings ABS --observations ABS [--json]
       ashlr resources pool run --root ABS --pool ABS --bindings ABS --observations ABS --task ABS [--output ABS] [--json]
       ashlr resources pool observe --pool ABS --worker ID --provider codex|claude --input ABS --captured-at ISO [--previous ABS] [--bucket ID ...] [--json]

An explicit foreground task pool; no default configuration, credential discovery,
account login/switching, service activation, or automatic task retry.
status reads existing local evidence and never initializes the selected root.
observe normalizes an owner-supplied decoded native result/event, not a live
provider query. --captured-at is the operator-attested capture timestamp;
its fixed 60-second TTL is never refreshed from file timestamps or the clock.
Codex requires 1..4 explicit --bucket IDs; Claude does not accept --bucket.
--previous accepts an observation array and retains other workers/windows.
observe --json emits an observation array usable as --observations input.
run assigns one task to one enrolled worker. Worker completion is not verified
accepted engineering work. Unknown provider usage is never presented as zero.
--output reserves a NEW private file before worker contact and writes task output
only after completion. Existing files are never overwritten. Failed or refused
runs can leave an empty reserved file, identified in the result metadata.
Task output is never printed to stdout, including --json; only --output saves it.
The task ledger stores metadata, not raw prompt or provider output.
SIGINT/SIGTERM abort owned work and are awaited before this command returns.
Exit codes: 0 completed/status/help, 1 failed/cancelled/uncertain, 2 invalid input,
3 no eligible capacity. No quota reset time guarantees future availability.
`;

class UsageError extends Error {}
type Options = { help: true } | { help: false; command: 'status' | 'run'; root: string; pool: string;
  bindings: string; observations: string; task?: string; output?: string; json: boolean } |
  { help: false; command: 'observe'; pool: string; workerId: string; provider: 'codex' | 'claude'; input: string;
    capturedAt: string; previous?: string; buckets: string[]; json: boolean };
interface OutputReservation { fd: number; path: string; dev: bigint; ino: bigint; bytes: number; state: 'empty' | 'partial' | 'written' }
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function controls(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 ||
    character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159);
}
function absolute(value: string): string {
  if (!isAbsolute(value) || Buffer.byteLength(value) > 4_096 || resolve(value) === parsePath(value).root) {
    throw new UsageError('All file and store paths must be explicit absolute non-root paths');
  }
  return resolve(value);
}
function parse(args: string[]): Options {
  if (args.length > 32 || args.some((arg) => typeof arg !== 'string' || controls(arg) || arg.length > 4_096) ||
      Buffer.byteLength(args.join('\0')) > 32 * 1024) throw new UsageError('Arguments exceed the bounded text contract');
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { help: true };
  const command = args[0];
  if (command !== 'status' && command !== 'run' && command !== 'observe') throw new UsageError('Expected pool status, run or observe');
  if (args.length === 2 && ['--help', '-h'].includes(args[1]!)) return { help: true };
  if (command === 'observe') return parseObservation(args.slice(1));
  const values = new Map<string, string>(); let json = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--json') {
      if (json) throw new UsageError('Duplicate pool option'); json = true; continue;
    }
    if (!['--root', '--pool', '--bindings', '--observations', ...(command === 'run' ? ['--task', '--output'] : [])].includes(flag) ||
        values.has(flag)) throw new UsageError('Unknown or duplicate pool option');
    const value = args[++index];
    if (!value || value.startsWith('-')) throw new UsageError('Pool option requires an absolute path');
    values.set(flag, absolute(value));
  }
  if (['--root', '--pool', '--bindings', '--observations', ...(command === 'run' ? ['--task'] : [])].some((key) => !values.has(key))) {
    throw new UsageError('Explicit root, pool, bindings, observations and run task are required');
  }
  return { help: false, command, root: values.get('--root')!, pool: values.get('--pool')!, bindings: values.get('--bindings')!,
    observations: values.get('--observations')!, ...(values.has('--task') ? { task: values.get('--task')! } : {}),
    ...(values.has('--output') ? { output: values.get('--output')! } : {}), json };
}

function parseObservation(args: string[]): Extract<Options, { command: 'observe' }> {
  const values = new Map<string, string>(); const buckets: string[] = []; let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === '--json') { if (json) throw new UsageError('Duplicate pool option'); json = true; continue; }
    if (!['--pool', '--worker', '--provider', '--input', '--captured-at', '--previous', '--bucket'].includes(flag) ||
        flag !== '--bucket' && values.has(flag)) throw new UsageError('Unknown or duplicate observation option');
    const value = args[++index];
    if (!value || value.startsWith('-')) throw new UsageError('Observation option requires a value');
    if (flag === '--bucket') {
      if (!ID.test(value) || buckets.includes(value) || buckets.length >= 4) throw new UsageError('Expected 1..4 unique Codex bucket IDs');
      buckets.push(value);
    } else values.set(flag, ['--pool', '--input', '--previous'].includes(flag) ? absolute(value) : value);
  }
  const workerId = values.get('--worker'); const provider = values.get('--provider'); const capturedAt = values.get('--captured-at');
  if (!values.has('--pool') || !values.has('--input') || !workerId || !ID.test(workerId) ||
      provider !== 'codex' && provider !== 'claude' || !capturedAt ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt)) ||
      new Date(capturedAt).toISOString() !== capturedAt || Date.parse(capturedAt) > Date.now()) {
    throw new UsageError('Observe requires pool, worker, provider, input and a canonical non-future capture timestamp');
  }
  if (provider === 'codex' ? buckets.length === 0 : buckets.length !== 0) {
    throw new UsageError('Codex requires explicit bucket IDs; Claude does not accept buckets');
  }
  return { help: false, command: 'observe', pool: values.get('--pool')!, input: values.get('--input')!,
    workerId, provider, capturedAt, buckets, ...(values.has('--previous') ? { previous: values.get('--previous')! } : {}), json };
}

function reserveOutput(path: string): OutputReservation {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== 0n ||
        typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) ||
        process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o600n) throw new Error('Output reservation unavailable');
    return { fd, path, dev: stat.dev, ino: stat.ino, state: 'empty', bytes: 0 };
  } catch (error) { closeSync(fd); throw error; }
}
function saveOutput(reservation: OutputReservation, value: unknown): void {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_OUTPUT_BYTES) throw new Error('Task output unavailable');
  const descriptor = fstatSync(reservation.fd, { bigint: true }); const path = lstatSync(reservation.path, { bigint: true });
  if (!path.isFile() || path.isSymbolicLink() || path.dev !== reservation.dev || path.ino !== reservation.ino ||
      descriptor.dev !== reservation.dev || descriptor.ino !== reservation.ino || descriptor.nlink !== 1n || descriptor.size !== 0n ||
      process.platform !== 'win32' && (descriptor.mode & 0o777n) !== 0o600n) {
    throw new Error('Output reservation changed');
  }
  const bytes = Buffer.from(value, 'utf8'); let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(reservation.fd, bytes, offset, bytes.length - offset, null);
    if (written <= 0) throw new Error('Output write incomplete'); offset += written;
    reservation.bytes = offset; reservation.state = 'partial';
  }
  fsyncSync(reservation.fd); reservation.state = 'written';
}
function outputMetadata(reservation: OutputReservation | undefined) {
  return reservation ? { path: reservation.path, state: reservation.state, bytes: reservation.bytes } : null;
}

/** Parse scope before importing execution, and keep transient worker text out of CLI metadata. */
export async function cmdResourcePool(args: string[]): Promise<number> {
  let reserved: OutputReservation | undefined;
  try {
    const options = parse(args); if (options.help) { console.log(USAGE); return 0; }
    const controller = new AbortController();
    const interrupt = (): void => controller.abort(); const terminate = (): void => controller.abort();
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      const [runtime, policy] = await Promise.all([import('../core/resources/pool-runtime.js'), import('../core/resources/pool-policy.js')]);
      if (controller.signal.aborted) throw new Error('Resource command cancelled before reading inputs');
      const definition = runtime.readResourceJson(options.pool, MAX_INPUT_BYTES);
      if (options.command === 'observe') {
        const native = runtime.readResourceJson(options.input, MAX_INPUT_BYTES);
        const prior = options.previous === undefined ? [] : runtime.readResourceJson(options.previous, MAX_INPUT_BYTES);
        const normalizers = await import('../core/resources/provider-observations.js');
        if (controller.signal.aborted) throw new Error('Resource observation cancelled');
        let observations: ReturnType<typeof policy.validateResourceObservations>;
        try {
          const pool = policy.validateResourcePool(definition);
          const enrolled = pool.workers.find((item) => item.id === options.workerId);
          if (!enrolled || enrolled.provider !== options.provider) throw new Error('Observation worker mismatch');
          const previous = policy.validateResourceObservations(prior, pool);
          const before = previous.find((item) => item.workerId === options.workerId) ?? null;
          const capturedMs = Date.parse(options.capturedAt);
          if (before && Date.parse(before.updatedAt ?? before.observedAt) > capturedMs) throw new Error('Observation predates prior capture');
          const observation = options.provider === 'codex'
            ? normalizers.normalizeCodexResourceObservation(options.workerId, native, { nowMs: capturedMs, ttlMs: 60_000, bucketIds: options.buckets })
            : normalizers.mergeClaudeResourceObservation(options.workerId, native, before, { nowMs: capturedMs, ttlMs: 60_000 });
          if (!observation) throw new Error('Native provider metadata unavailable');
          const updated = new Map(runtime.mergeResourceObservations(previous, [observation]).map((item) => [item.workerId, item]));
          observations = policy.validateResourceObservations(pool.workers.flatMap((item) => updated.has(item.id) ? [updated.get(item.id)!] : []), pool);
        } catch { throw new UsageError('Invalid native observation, enrolled provider or capture chronology'); }
        console.log(options.json ? JSON.stringify(observations) : [
          `Normalized ${options.provider} observation for ${options.workerId}.`,
          `Operator-attested capture: ${options.capturedAt}; fixed 60-second freshness ceiling.`,
          'No provider contact or ledger mutation. This is owner-supplied evidence, not independently verified account headroom.',
          'Use --json for the reusable observation array; preserve private file permissions when saving.',
        ].join('\n'));
        return 0;
      }
      const worker = await import('../core/resources/worker.js');
      if (controller.signal.aborted) throw new Error('Resource command cancelled before reading bindings');
      const rawBindings = runtime.readResourceJson(options.bindings, MAX_INPUT_BYTES);
      const rawObservations = runtime.readResourceJson(options.observations, MAX_INPUT_BYTES);
      const rawTask = options.task === undefined ? undefined : runtime.readResourceJson(options.task, MAX_INPUT_BYTES);
      let pool: ReturnType<typeof policy.validateResourcePool>;
      let bindings: ReturnType<typeof worker.validateResourceBindings>;
      let observations: ReturnType<typeof policy.validateResourceObservations>;
      let task: ReturnType<typeof runtime.validateResourceTask> | undefined;
      try {
        pool = policy.validateResourcePool(definition); bindings = worker.validateResourceBindings(rawBindings, pool);
        observations = policy.validateResourceObservations(rawObservations, pool);
        if (rawTask !== undefined) {
          task = runtime.validateResourceTask(rawTask);
          const known = new Set(pool.workers.map((item) => item.id));
          if (task.allowedWorkerIds.some((id) => !known.has(id))) throw new UsageError('Task names an unenrolled worker');
        }
      } catch { throw new UsageError('Invalid resource pool, binding, observation or task manifest'); }
      if (controller.signal.aborted) throw new Error('Resource command cancelled before dispatch');
      if (options.command === 'status') {
        const status = runtime.resourcePoolStatus(options.root, pool, bindings, observations);
        console.log(options.json ? JSON.stringify(status) : [
          `Resource pool ${status.poolId}: ${status.sourceState}`,
          `Eligible workers: ${status.plan.candidates.length}; recorded attempts: ${status.attempts.length}`,
          'Read-only local evidence. Unknown quota is not available capacity; completion is not verified acceptance.',
        ].join('\n'));
        return 0;
      }
      if (!task) throw new UsageError('Run requires a valid task manifest');
      if (options.output) reserved = reserveOutput(options.output);
      if (controller.signal.aborted) throw new Error('Resource command cancelled before dispatch');
      const result = await runtime.runResourceTask({ root: options.root, pool, bindings, observations, task, signal: controller.signal });
      if (result.receipt?.status === 'completed' && reserved) saveOutput(reserved, result.output);
      const metadata = { receipt: result.receipt, plan: result.plan, replayed: result.replayed, outputFile: outputMetadata(reserved) };
      console.log(options.json ? JSON.stringify(metadata) : [
        `Resource task: ${result.receipt?.status ?? 'no-capacity'}${result.replayed ? ' (recorded result; no redispatch)' : ''}`,
        result.receipt ? `Worker: ${result.receipt.workerId}` : 'No eligible worker was dispatched.',
        'Worker completion is not verified accepted engineering work.',
        ...(reserved ? [`Output file: ${reserved.path} (${reserved.state}, ${reserved.bytes} bytes)`] : ['Task output not saved.']),
      ].join('\n'));
      return result.receipt?.status === 'completed' ? 0 : result.receipt === null ? 3 : 1;
    } finally {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    }
  } catch (error) {
    const message = error instanceof UsageError ? error.message : 'Resource pool command failed; inspect local evidence before retrying';
    const metadata = { error: message, outputFile: outputMetadata(reserved) };
    if (args.includes('--json')) console.log(JSON.stringify(metadata)); else {
      console.error(`resources pool: ${message}`);
      if (reserved) console.error(`Reserved output file remains at ${reserved.path} (${reserved.state}, ${reserved.bytes} bytes).`);
    }
    return error instanceof UsageError ? 2 : 1;
  } finally { if (reserved) closeSync(reserved.fd); }
}
