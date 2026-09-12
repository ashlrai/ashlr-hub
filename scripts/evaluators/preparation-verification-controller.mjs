/** Trusted assertions remain in the caller. This broker owns all counted launches. */
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { userInfo } from 'node:os';
import { exact, MAX_CALLS, MAX_MESSAGE_BYTES, MAX_SESSION_DURATION_MS, publishMessage, readMessage } from './preparation-verification-protocol.mjs';
import { assertPreparationGit, resolvePreparationGit } from './preparation-verification-native.mjs';

const HASH = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GIT_CONFIG = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.attributesFile=/dev/null',
  'commit.gpgsign=false', 'tag.gpgsign=false', 'gc.auto=0', 'maintenance.auto=false',
  'core.logAllRefUpdates=false', 'protocol.allow=never'];
const METHODS = ['check', 'metadata', 'bundle', 'successor-check', 'successor-metadata', 'successor-bundle',
  'manager-open', 'manager-check', 'manager-replay', 'manager-close'];
function branchRef(value) {
  return typeof value === 'string' && value.startsWith('refs/heads/') && !value.includes('..') &&
    value.slice(11).split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) && !part.endsWith('.') && !part.endsWith('.lock'));
}
const failure = () => new Error('CANDIDATE_SESSION_FAILED');
const wait = () => new Promise(done => setTimeout(done, 2));
function within(root, file) { const part = relative(root, file); return part === '' || part !== '..' && !part.startsWith('../') && !isAbsolute(part); }
function canonicalDirectory(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || fs.realpathSync(value) !== value ||
      !fs.lstatSync(value).isDirectory()) throw failure();
  return value;
}
function base64(value) {
  if (typeof value !== 'string' || value.length > MAX_MESSAGE_BYTES || Buffer.from(value, 'base64').toString('base64') !== value) throw failure();
  return Buffer.from(value, 'base64');
}
export function readonlyCommand(request, fixtureRoot, scratch, trustedGitPath = '/usr/bin/git') {
  if (!exact(request, ['schemaVersion', 'id', 'nonce', 'api', 'file', 'args', 'options']) || request.schemaVersion !== 1 ||
      !Number.isSafeInteger(request.id) || request.id < 1 || !HASH.test(request.nonce) ||
      !['execFileSync', 'spawnSync'].includes(request.api) || typeof request.file !== 'string' ||
      !Array.isArray(request.args) || request.args.length > 2048 || request.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 8192)) throw failure();
  const options = request.options;
  if (!exact(options, ['cwd', 'encoding', 'timeoutMs', 'maxBuffer', 'inputBase64']) ||
      !(options.cwd === null || typeof options.cwd === 'string' && isAbsolute(options.cwd) && within(fixtureRoot, options.cwd)) ||
      !['utf8', 'buffer'].includes(options.encoding) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000 ||
      // deliveryGit declares the artifact ceiling plus framing. The fixed tool
      // still independently caps actual captured output at 64 KiB per stream.
      !Number.isSafeInteger(options.maxBuffer) || options.maxBuffer < 1 || options.maxBuffer > 68 * 1024 * 1024) throw failure();
  const input = options.inputBase64 === null ? undefined : base64(options.inputBase64);
  let file, args; let blob = false;
  if (request.file === 'git' || request.file === '/usr/bin/git') {
    const rest = [...request.args]; let repository;
    if (rest[0] === '--no-replace-objects') rest.shift();
    while (rest[0] === '-c') {
      rest.shift(); if (!GIT_CONFIG.includes(rest.shift())) throw failure();
    }
    if (rest.shift() !== '-C') throw failure(); repository = rest.shift();
    if (typeof repository !== 'string' || !within(fixtureRoot, canonicalDirectory(repository))) throw failure();
    const verb = rest.shift();
    if (verb === 'rev-parse') {
      if (!(rest.length === 1 && ['--show-toplevel', '--show-object-format', '--git-dir', '--is-inside-work-tree'].includes(rest[0]) ||
          JSON.stringify(rest) === JSON.stringify(['--is-inside-work-tree', '--absolute-git-dir', '--git-common-dir', '--show-toplevel']) ||
          rest.length === 2 && rest[0] === '--verify' && (/^(?:[a-f0-9]{40}|[a-f0-9]{64})\^\{(?:commit|tree)\}$/.test(rest[1]) || branchRef(rest[1])))) throw failure();
    } else if (verb === 'symbolic-ref') {
      if (rest.length !== 2 || rest[0] !== '-q' || !branchRef(rest[1])) throw failure();
    } else if (verb === 'show-ref') {
      if (rest.length !== 3 || rest[0] !== '--verify' || rest[1] !== '--quiet' || !branchRef(rest[2])) throw failure();
    } else if (verb === 'rev-list') {
      if (rest.length !== 4 || rest[0] !== '--parents' || rest[1] !== '-n' || rest[2] !== '1' || !OID.test(rest[3])) throw failure();
    } else if (verb === 'ls-files') {
      if (rest.length !== 1 || rest[0] !== '-z') throw failure();
    } else if (verb === 'for-each-ref') {
      if (rest[0] !== '--format=%(refname)' || !(rest.length === 1 || rest.length === 2 && branchRef(rest[1]))) throw failure();
    } else if (verb === 'ls-tree') {
      if (rest.length !== 3 || !['-rz', '-rlz'].includes(rest[0]) || rest[1] !== '--full-tree' || !OID.test(rest[2])) throw failure();
    } else if (verb === 'cat-file') {
      blob = true;
      if (rest.length === 2 && rest[0] === 'blob' && OID.test(rest[1])) { if (input !== undefined) throw failure(); }
      else if (rest.length === 1 && rest[0] === '--batch' && input && input.length > 0) {
        const lines = input.toString('utf8'); if (!lines.endsWith('\n') || lines.slice(0, -1).split('\n').some(line => !OID.test(line))) throw failure();
      } else throw failure();
    } else throw failure();
    if (verb !== 'cat-file' && input !== undefined) throw failure();
    // Rebuild an invariant safe prefix rather than trusting candidate options.
    file = trustedGitPath; args = ['--no-replace-objects', ...GIT_CONFIG.flatMap(value => ['-c', value]), '-C', repository, verb, ...rest];
  } else if (request.file === '/bin/ls') {
    if (request.args.length < 2 || request.args[0] !== '-lde' || input !== undefined && input.length !== 0 || request.args.slice(1).some(path =>
      !isAbsolute(path) || resolve(path) !== path || !within(fixtureRoot, path) && !within(scratch, path))) throw failure();
    file = '/bin/ls'; args = request.args;
  } else if (request.file === '/bin/ps') {
    if (request.args.length !== 4 || request.args[0] !== '-o' || request.args[1] !== 'lstart=' || request.args[2] !== '-p' ||
      !/^[1-9][0-9]{0,9}$/.test(request.args[3]) || input !== undefined && input.length !== 0) throw failure();
    file = '/bin/ps'; args = request.args;
  } else throw failure();
  return { file, args, options, input, blob };
}

/** Trusted mutation boundary; never changes native results or broker accounting. */
export function createPreparationMutationInterceptor({ run, toolPath, fixtureRoot, matches, mutate }) {
  const message = 'PREPARATION_MUTATION_INTERCEPTOR_FAILED';
  const privateDirectory = value => {
    canonicalDirectory(value);
    const stat = fs.lstatSync(value);
    if ((stat.mode & 0o777) !== 0o700 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(message);
  };
  const json = text => {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error(message);
    return JSON.parse(text);
  };
  const success = result => {
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut !== false || result.cancelled !== false ||
        result.error !== undefined || result.outputTruncated !== undefined || result.stderr !== '' ||
        result.processGroupSettlement !== 'group-exit-confirmed') throw new Error(message);
    const output = json(result.stdout);
    if (!exact(output, ['started', 'status', 'signal', 'stdoutBase64', 'stderrBase64', 'error']) || output.started !== true ||
        output.status !== 0 || output.signal !== null || output.error !== null) throw new Error(message);
    for (const key of ['stdoutBase64', 'stderrBase64']) if (base64(output[key]).length > 64 * 1024) throw new Error(message);
  };
  privateDirectory(fixtureRoot);
  if (typeof run !== 'function' || typeof matches !== 'function' || typeof mutate !== 'function' || !isAbsolute(toolPath) ||
      resolve(toolPath) !== toolPath || fs.realpathSync(toolPath) !== toolPath || !fs.lstatSync(toolPath).isFile()) throw new Error(message);
  let armed = false, fired = false, count = 0, fault = false, pending = false, lastId = 0, scratchPin;
  const nonces = new Set();
  function fail() { fault = true; throw new Error(message); }
  const wrapped = async (argv, opts) => {
    // Cleanup/lifecycle calls still reach the original runner after injector failure.
    if (!argv.includes(toolPath)) return run(argv, opts);
    if (fault || pending) return fail();
    pending = true;
    try {
      if (argv.length !== 6 || argv[0] !== '/usr/bin/sandbox-exec' || argv[1] !== '-p' || typeof argv[2] !== 'string' ||
          argv[3] !== process.execPath || argv[4] !== '--no-addons' || argv[5] !== toolPath) fail();
      const input = json(opts.input);
      if (!exact(input, ['request', 'fixtureRoot', 'scratch', 'gitPin']) || input.fixtureRoot !== fixtureRoot || input.scratch !== opts.cwd) fail();
      assertPreparationGit(input.gitPin);
      privateDirectory(opts.cwd); if (scratchPin !== undefined && scratchPin !== opts.cwd) fail(); scratchPin = opts.cwd;
      readonlyCommand(input.request, fixtureRoot, opts.cwd, input.gitPin.path);
      const request = input.request;
      if (request.id !== lastId + 1 || request.id > 4096 || nonces.has(request.nonce)) fail();
      lastId = request.id; nonces.add(request.nonce);
      Object.freeze(request.args); Object.freeze(request.options); Object.freeze(request);
      const selected = armed && !fired ? matches(request) : false;
      if (typeof selected !== 'boolean') fail();
      const result = await run(argv, opts);
      if (selected) {
        success(result); fired = true;
        if (mutate() !== undefined) fail(); // No asynchronous mutation after resume.
        count++;
      }
      return result;
    } catch { return fail(); }
    finally { pending = false; }
  };
  return { run: wrapped, arm() { if (fault || armed || pending) fail(); armed = true; },
    assertInjected() { if (fault || !armed || pending || count !== 1) fail(); }, injections() { return count; } };
}

const qualificationError = (stale = false) => {
  const code = stale ? 'CANDIDATE_QUALIFICATION_STALE_RESULT' : 'CANDIDATE_QUALIFICATION_FAILED';
  return Object.assign(new Error(code), { code });
};
const qualificationCanonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function qualificationSnapshot(root) {
  let entries = 0, bytes = 0;
  const visit = file => {
    if (++entries > 32768) throw qualificationError();
    const stat = fs.lstatSync(file, { bigint: true });
    let content;
    if (stat.isSymbolicLink()) content = { symlink: fs.readlinkSync(file) };
    else if (stat.isDirectory()) content = Object.fromEntries(fs.readdirSync(file).sort().map(name => [name, visit(join(file, name))]));
    else {
      if (!stat.isFile() || stat.size > BigInt(256 * 1024 * 1024 - bytes)) throw qualificationError();
      const data = fs.readFileSync(file); bytes += data.length;
      if (bytes > 256 * 1024 * 1024) throw qualificationError();
      content = createHash('sha256').update(data).digest('hex');
    }
    return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), content };
  };
  return qualificationCanonical(visit(root));
}

/** Fixed qualification choices only. Mutators and expected data are trusted
 * controller code; neither comes from candidate output or installed CLI flags. */
export async function qualifyPreparationCandidate({ name, fixture, bridge, bridgePath, candidateRoot, fixtureRoot, workRoot,
  activity, signal, gitPin, deadlineAt, deadlineMonotonicMs }) {
  let session, stale = false, closed = false;
  try {
    if (!['runtime-drift', 'source-drift'].includes(name) || !Number.isSafeInteger(deadlineAt) ||
        !Number.isFinite(deadlineMonotonicMs) || !activity || Date.parse(activity.owner.deadlineAt) !== deadlineAt ||
        !(signal instanceof globalThis.AbortSignal)) throw qualificationError();
    const remaining = () => Math.floor(Math.min(deadlineAt - Date.now(), deadlineMonotonicMs - performance.now()));
    const guard = () => { if (signal.aborted || remaining() <= 0) throw qualificationError(); };
    guard(); assertPreparationGit(gitPin); canonicalDirectory(fixtureRoot);
    const source = name === 'source-drift';
    const method = source ? 'successor-metadata' : 'metadata';
    const input = source ? { ...fixture.options, expectedPlanDigest: fixture.plan.planDigest } : fixture.bundleInput;
    const intent = join(input.output, 'intent.json');
    if (!within(fixtureRoot, intent) || resolve(intent) !== intent) throw qualificationError();
    const runtimeFile = source ? undefined : fixture.options.config.resourceRuntime;
    if (!source) {
      if (!within(fixtureRoot, runtimeFile) || fs.realpathSync(runtimeFile) !== runtimeFile) throw qualificationError();
      const original = qualificationCanonical(fixture.runtime) + '\n';
      const changed = qualificationCanonical({ ...fixture.runtime, capacityWaitMs: 1000 }) + '\n';
      const current = fs.readFileSync(runtimeFile, 'utf8');
      if (current !== original && current !== changed) throw qualificationError();
      // Restore only the known between-call mutation after its session closed.
      guard(); if (current !== original) fs.writeFileSync(runtimeFile, original, { mode: 0o600 }); guard();
    }
    const git = (...args) => {
      guard(); assertPreparationGit(gitPin);
      const result = execFileSync(gitPin.path, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false',
        '-C', canonicalDirectory(fixture.repo), ...args], { encoding: 'utf8', timeout: Math.max(1, Math.min(10000, remaining())),
        maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
      assertPreparationGit(gitPin); guard(); return result;
    };
    if (source) {
      if (!within(fixtureRoot, fixture.repo)) throw qualificationError();
      const current = git('rev-parse', '--verify', 'refs/heads/codex/upstream');
      if (current !== fixture.receipt.commit && current !== fixture.revision) throw qualificationError();
      if (current !== fixture.receipt.commit) git('update-ref', 'refs/heads/codex/upstream', fixture.receipt.commit);
      if (git('rev-parse', '--verify', 'refs/heads/codex/upstream') !== fixture.receipt.commit) throw qualificationError();
    }
    const expected = source ? bridge.baseline.readResourceEngineeringSuccessorMetadata(input) : bridge.baseline.readPreparedResourceEngineeringMetadata(input);
    guard();
    const before = qualificationSnapshot(fixtureRoot);
    let changed;
    const interceptor = createPreparationMutationInterceptor({ run: bridge.runVerifySubprocessAsync,
      toolPath: fileURLToPath(new URL('./preparation-verification-tool.mjs', import.meta.url)), fixtureRoot,
      matches: request => request.file === '/bin/ls' && request.args[0] === '-lde' && request.args.slice(1).includes(intent),
      mutate() {
        guard();
        if (source) {
          if (git('rev-parse', '--verify', 'refs/heads/codex/upstream') !== fixture.receipt.commit) throw qualificationError();
          git('update-ref', 'refs/heads/codex/upstream', fixture.revision);
          if (git('rev-parse', '--verify', 'refs/heads/codex/upstream') !== fixture.revision) throw qualificationError();
        } else fs.writeFileSync(runtimeFile, qualificationCanonical({ ...fixture.runtime, capacityWaitMs: 1000 }) + '\n', { mode: 0o600 });
        changed = qualificationSnapshot(fixtureRoot);
        if (changed === before) throw qualificationError();
        guard();
      } });
    session = await createPreparationCandidateSession({ bridge: { ...bridge, runVerifySubprocessAsync: interceptor.run }, bridgePath,
      candidateRoot, fixtureRoot, workRoot, activity, signal, gitPin, timeoutMs: Math.min(MAX_SESSION_DURATION_MS, remaining()) });
    guard(); if (qualificationSnapshot(fixtureRoot) !== before) throw qualificationError();
    const healthy = await session.call(method, input);
    guard();
    if (healthy.error !== undefined || !Object.hasOwn(healthy, 'value') || qualificationCanonical(healthy.value) !== qualificationCanonical(expected) ||
        healthy.measurement.processes <= 0 || qualificationSnapshot(fixtureRoot) !== before) throw qualificationError();
    interceptor.arm();
    const mutated = await session.call(method, input);
    guard(); interceptor.assertInjected();
    if (!changed || qualificationSnapshot(fixtureRoot) !== changed || mutated.measurement.processes <= 0) throw qualificationError();
    stale = mutated.error === undefined && Object.hasOwn(mutated, 'value') && qualificationCanonical(mutated.value) === qualificationCanonical(expected);
    const refused = mutated.error === 'candidate-threw' && !Object.hasOwn(mutated, 'value');
    const ledger = session.measurementLedger();
    const requests = [healthy, mutated].map((result, index) => ({ id: index + 1, method, ...result.measurement }));
    if (qualificationCanonical(ledger.requests) !== qualificationCanonical(requests) ||
        ledger.processes !== requests.reduce((total, row) => total + row.processes, 0) ||
        ledger.blobProcesses !== requests.reduce((total, row) => total + row.blobProcesses, 0)) throw qualificationError();
    await session.close(); closed = true;
    guard(); interceptor.assertInjected(); assertPreparationGit(gitPin);
    if (qualificationSnapshot(fixtureRoot) !== changed) throw qualificationError();
    if (!refused) throw qualificationError(stale);
    return { name, ...ledger, injections: 1 };
  } catch (error) {
    if (session && !closed) { try { await session.close(); } catch { throw qualificationError(); } }
    // Stale-result classification requires a complete, independently verified
    // pair AND successful close. A failed transport/cleanup never impersonates it.
    if (closed && error?.code === 'CANDIDATE_QUALIFICATION_STALE_RESULT') throw qualificationError(true);
    throw qualificationError();
  }
}

export async function createPreparationCandidateSession({ bridge, bridgePath, candidateRoot, fixtureRoot, workRoot, timeoutMs = 60000, signal, activity, gitPin: suppliedGitPin }) {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SESSION_DURATION_MS ||
      typeof bridge?.runVerifySubprocessAsync !== 'function' || typeof bridge?.confinedUniverseArgv !== 'function') throw failure();
  const deadline = performance.now() + timeoutMs;
  const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
  const selectedGit = suppliedGitPin === undefined ? resolvePreparationGit() : suppliedGitPin;
  assertPreparationGit(selectedGit);
  const gitPin = Object.freeze({ path: selectedGit.path, digest: selectedGit.digest });
  for (const path of [candidateRoot, fixtureRoot, workRoot]) canonicalDirectory(path);
  if (within(candidateRoot, workRoot) || within(fixtureRoot, workRoot) || within(workRoot, candidateRoot)) throw failure();
  const child = fileURLToPath(new URL('./preparation-verification-child.mjs', import.meta.url));
  const tool = fileURLToPath(new URL('./preparation-verification-tool.mjs', import.meta.url));
  for (const file of [bridgePath, child, tool]) if (!isAbsolute(file) || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw failure();
  const sessionRoot = fs.mkdtempSync(join(workRoot, 'candidate-session-'));
  const inbox = join(sessionRoot, 'inbox'), scratch = join(sessionRoot, 'child'), outbox = join(scratch, 'outbox');
  for (const path of [inbox, scratch, outbox]) fs.mkdirSync(path, { mode: 0o700 });
  const sessionId = randomBytes(32).toString('hex');
  const abort = new globalThis.AbortController();
  const onAbort = () => abort.abort();
  if (signal?.aborted) throw failure();
  const environment = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch,
    ASHLR_HOME: scratch, ASHLR_UNIVERSE_CANDIDATE: candidateRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LANG: 'C', LC_ALL: 'C' };
  const readable = [fixtureRoot, inbox, dirname(child), dirname(bridgePath), candidateRoot];
  function confined(command) {
    const argv = bridge.confinedUniverseArgv(command, scratch, scratch, readable, workRoot);
    if (argv[0] !== '/usr/bin/sandbox-exec' || argv[1] !== '-p' || typeof argv[2] !== 'string') throw failure();
    // The harness deliberately replaces HOME. Deny the actual account home as
    // well, then restore only fixture/entry/runtime reads. This is the existing
    // system-compatible profile, not a claim of universal filesystem isolation.
    const escape = path => path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const scope = [scratch, ...readable, dirname(command[0])];
    const ancestors = new Set();
    for (const path of scope) for (let cursor = dirname(path); ; cursor = dirname(cursor)) {
      ancestors.add(cursor); if (dirname(cursor) === cursor) break;
    }
    argv[2] += `\n(deny file-read* (subpath "${escape(canonicalDirectory(userInfo().homedir))}"))\n` +
      `(allow file-read* ${scope.map(path => `(subpath "${escape(path)}")`).join(' ')})\n` +
      `(allow file-read-metadata ${[...ancestors].map(path => `(literal "${escape(path)}")`).join(' ')})\n`;
    return argv;
  }
  const command = confined([process.execPath, '--no-addons', '--experimental-vm-modules', '--no-warnings', child]);
  command[2] += '\n(deny process-fork)\n(deny signal)\n';
  assertPreparationGit(gitPin);
  const launchTimeoutMs = Math.floor(deadline - performance.now());
  if (signal?.aborted || launchTimeoutMs <= 0) throw failure();
  signal?.addEventListener('abort', onAbort, { once: true });
  let terminal, terminalError, closePromise, busy = false, closed = false, faulted = false, callId = 0, execId = 0;
  const cumulativeMeasurement = { processes: 0, blobProcesses: 0 }, requests = [];
  const completion = bridge.runVerifySubprocessAsync(command, { cwd: scratch, env: environment, timeoutMs: launchTimeoutMs,
    input: JSON.stringify({ schemaVersion: 1, sessionId, inbox, outbox, candidateRoot, bridgePath, deadlineAt }),
    maxOutputChars: 4096, signal: abort.signal, terminationGraceMs: 1000, requireProcessGroupExit: true,
    ...(activity ? { processGroupLifecycle: activity.lifecycle('candidate') } : {}) }).then(result => { terminal = result; return result; }, error => { terminalError = error; });
  const timer = setTimeout(() => abort.abort(), Math.max(0, deadline - performance.now()));
  function guard(allowTerminal = false) { if (faulted || terminal && !allowTerminal || terminalError || abort.signal.aborted || performance.now() >= deadline) throw failure(); }
  async function settle() {
    await completion;
    assertPreparationGit(gitPin);
    if (!terminal || terminalError || terminal.exitCode !== 0 || terminal.signal !== null || terminal.error || terminal.timedOut || terminal.cancelled ||
        terminal.outputTruncated || terminal.stdout !== '' || terminal.stderr !== '' || terminal.processGroupSettlement !== 'group-exit-confirmed') throw failure();
  }
  async function discard() { faulted = true; abort.abort(); await completion; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  async function broker(request, measurement) {
    const selected = readonlyCommand(request, fixtureRoot, scratch, gitPin.path);
    if (request.id !== execId + 1 || request.id > 4096) throw failure();
    guard(); execId = request.id;
    const argv = confined([process.execPath, '--no-addons', tool]);
    assertPreparationGit(gitPin);
    guard();
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw failure();
    // Count observed broker launches, never child-provided counters or failed
    // pre-spawn attempts. This is not a census of trusted tool descendants.
    const result = await bridge.runVerifySubprocessAsync(argv, { cwd: scratch, env: environment,
      input: JSON.stringify({ request, fixtureRoot, scratch, gitPin }), timeoutMs: Math.min(remaining, selected.options.timeoutMs),
      maxOutputChars: MAX_MESSAGE_BYTES, signal: abort.signal, terminationGraceMs: 1000, requireProcessGroupExit: true,
      ...(activity ? { processGroupLifecycle: activity.lifecycle('tool') } : {}) });
    assertPreparationGit(gitPin);
    if (result.exitCode !== 0 || result.signal !== null || result.error || result.timedOut || result.cancelled ||
        result.outputTruncated || result.stderr !== '' || result.processGroupSettlement !== 'group-exit-confirmed') throw failure();
    const output = JSON.parse(result.stdout);
    if (!exact(output, ['started', 'status', 'signal', 'stdoutBase64', 'stderrBase64', 'error']) || output.started !== true ||
        output.status !== null && !Number.isSafeInteger(output.status) || output.signal !== null && typeof output.signal !== 'string' ||
        output.error !== null && (!exact(output.error, ['code']) || typeof output.error.code !== 'string')) throw failure();
    base64(output.stdoutBase64); base64(output.stderrBase64);
    measurement.processes++; if (selected.blob) measurement.blobProcesses++;
    cumulativeMeasurement.processes++; if (selected.blob) cumulativeMeasurement.blobProcesses++;
    delete output.started;
    guard(); publishMessage(join(inbox, `exec-reply-${execId}.json`), { schemaVersion: 1, id: execId, nonce: request.nonce, ok: true, result: output });
  }
  async function exchange(method, input) {
    const id = ++callId, nonce = randomBytes(32).toString('hex'), measurement = { processes: 0, blobProcesses: 0 };
    requests.push({ id, method, measurement });
    publishMessage(join(inbox, `request-${id}.json`), { schemaVersion: 1, id, nonce, method, input });
    while (true) {
      guard(method === 'close');
      const request = readMessage(join(outbox, `exec-${execId + 1}.json`));
      if (request !== null) { if (method === 'close') throw failure(); await broker(request, measurement); continue; }
      const reply = readMessage(join(outbox, `reply-${id}.json`));
      if (reply !== null) {
        if (!(exact(reply, ['schemaVersion', 'id', 'nonce', 'ok', 'value']) && reply.ok === true ||
            exact(reply, ['schemaVersion', 'id', 'nonce', 'ok', 'error']) && reply.ok === false && ['candidate-threw', 'invalid-result'].includes(reply.error)) ||
            reply.schemaVersion !== 1 || reply.id !== id || reply.nonce !== nonce || method === 'close' && (!reply.ok || reply.value !== null)) throw failure();
        // Preserve the existing call response; aggregate evidence is available
        // through the separate detached ledger, not added to legacy replies.
        const counts = { measurement: { ...measurement } };
        return reply.ok ? { value: reply.value, ...counts } : { error: reply.error, ...counts };
      }
      if (terminal) throw failure();
      await wait();
    }
  }
  try {
    while (true) {
      guard(); const ready = readMessage(join(outbox, 'ready.json'));
      if (ready !== null) { if (!exact(ready, ['schemaVersion', 'sessionId', 'ready']) || ready.schemaVersion !== 1 || ready.sessionId !== sessionId || ready.ready !== true) throw failure(); break; }
      await wait();
    }
  } catch {
    clearTimeout(timer); await discard();
    // macOS can refuse a second sandbox_apply inside an existing evaluator
    // sandbox. Only this exact, fully settled launcher refusal is classified;
    // there is never an unconfined fallback or a child execution retry.
    if (!terminalError && terminal?.exitCode === 71 && terminal.signal === null &&
        terminal.stdout === '' && terminal.stderr === 'sandbox-exec: sandbox_apply: Operation not permitted\n' &&
        !terminal.error && !terminal.timedOut && !terminal.cancelled && !terminal.outputTruncated &&
        terminal.processGroupSettlement === 'group-exit-confirmed') {
      throw Object.assign(new Error('CANDIDATE_CONFINEMENT_UNAVAILABLE'), { code: 'CANDIDATE_CONFINEMENT_UNAVAILABLE' });
    }
    throw failure();
  }
  return {
    // Read-only copies remain useful after a failed call or close. They are
    // observed native launches, not a claim that the invocation was accepted.
    measurementLedger() { return { ...cumulativeMeasurement,
      requests: requests.map(({ id, method, measurement }) => ({ id, method, ...measurement })) }; },
    async call(method, input) {
      if (closed || busy || faulted || callId >= MAX_CALLS || !METHODS.includes(method)) throw failure();
      busy = true;
      try { return await exchange(method, input); }
      catch { await discard(); throw failure(); }
      finally { busy = false; }
    },
    close() {
      // Every caller observes the same process-group settlement, including
      // callers arriving while the first close is still draining the child.
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        try {
          if (busy || faulted) { await discard(); throw failure(); }
          await exchange('close', null); await settle(); guard(true);
        } catch { await discard(); throw failure(); }
        finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
      })();
      return closePromise;
    },
  };
}
