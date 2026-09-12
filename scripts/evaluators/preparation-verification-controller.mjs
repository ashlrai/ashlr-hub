/** Trusted assertions remain in the caller. This broker owns all counted launches. */
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { userInfo } from 'node:os';
import { exact, MAX_CALLS, MAX_MESSAGE_BYTES, publishMessage, readMessage } from './preparation-verification-protocol.mjs';

const HASH = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
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
export function readonlyCommand(request, fixtureRoot, scratch) {
  if (!exact(request, ['schemaVersion', 'id', 'nonce', 'api', 'file', 'args', 'options']) || request.schemaVersion !== 1 ||
      !Number.isSafeInteger(request.id) || request.id < 1 || !HASH.test(request.nonce) ||
      !['execFileSync', 'spawnSync'].includes(request.api) || typeof request.file !== 'string' ||
      !Array.isArray(request.args) || request.args.length > 2048 || request.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 8192)) throw failure();
  const options = request.options;
  if (!exact(options, ['cwd', 'encoding', 'timeoutMs', 'maxBuffer', 'inputBase64']) ||
      !(options.cwd === null || typeof options.cwd === 'string' && isAbsolute(options.cwd) && within(fixtureRoot, options.cwd)) ||
      !['utf8', 'buffer'].includes(options.encoding) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000 ||
      !Number.isSafeInteger(options.maxBuffer) || options.maxBuffer < 1 || options.maxBuffer > 8 * 1024 * 1024) throw failure();
  const input = options.inputBase64 === null ? undefined : base64(options.inputBase64);
  let file, args; let blob = false;
  if (request.file === 'git' || request.file === '/usr/bin/git') {
    const rest = [...request.args]; let repository;
    while (rest[0] === '-c') {
      rest.shift(); if (!['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'commit.gpgsign=false'].includes(rest.shift())) throw failure();
    }
    if (rest.shift() !== '-C') throw failure(); repository = rest.shift();
    if (typeof repository !== 'string' || !within(fixtureRoot, canonicalDirectory(repository))) throw failure();
    const verb = rest.shift();
    if (verb === 'rev-parse') {
      if (!(rest.length === 1 && ['--show-toplevel', '--show-object-format', '--git-dir', '--is-inside-work-tree'].includes(rest[0]) ||
          JSON.stringify(rest) === JSON.stringify(['--is-inside-work-tree', '--absolute-git-dir', '--git-common-dir', '--show-toplevel']) ||
          rest.length === 2 && rest[0] === '--verify' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})\^\{commit\}$/.test(rest[1]))) throw failure();
    } else if (verb === 'ls-files') {
      if (rest.length !== 1 || rest[0] !== '-z') throw failure();
    } else if (verb === 'for-each-ref') {
      if (rest.length !== 1 || rest[0] !== '--format=%(refname)') throw failure();
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
    file = '/usr/bin/git'; args = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repository, verb, ...rest];
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

export async function createPreparationCandidateSession({ bridge, bridgePath, candidateRoot, fixtureRoot, workRoot, timeoutMs = 60000, signal, activity }) {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
      typeof bridge?.runVerifySubprocessAsync !== 'function' || typeof bridge?.confinedUniverseArgv !== 'function') throw failure();
  for (const path of [candidateRoot, fixtureRoot, workRoot]) canonicalDirectory(path);
  if (within(candidateRoot, workRoot) || within(fixtureRoot, workRoot) || within(workRoot, candidateRoot)) throw failure();
  const child = fileURLToPath(new URL('./preparation-verification-child.mjs', import.meta.url));
  const tool = fileURLToPath(new URL('./preparation-verification-tool.mjs', import.meta.url));
  for (const file of [bridgePath, child, tool]) if (!isAbsolute(file) || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw failure();
  const sessionRoot = fs.mkdtempSync(join(workRoot, 'candidate-session-'));
  const inbox = join(sessionRoot, 'inbox'), scratch = join(sessionRoot, 'child'), outbox = join(scratch, 'outbox');
  for (const path of [inbox, scratch, outbox]) fs.mkdirSync(path, { mode: 0o700 });
  const sessionId = randomBytes(32).toString('hex'); const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
  const deadline = performance.now() + timeoutMs; const abort = new globalThis.AbortController();
  const onAbort = () => abort.abort();
  if (signal?.aborted) throw failure();
  const environment = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch,
    ASHLR_HOME: scratch, ASHLR_UNIVERSE_CANDIDATE: candidateRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LANG: 'C', LC_ALL: 'C' };
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
  signal?.addEventListener('abort', onAbort, { once: true });
  let terminal, terminalError, closePromise, busy = false, closed = false, faulted = false, callId = 0, execId = 0;
  const completion = bridge.runVerifySubprocessAsync(command, { cwd: scratch, env: environment, timeoutMs,
    input: JSON.stringify({ schemaVersion: 1, sessionId, inbox, outbox, candidateRoot, bridgePath, deadlineAt }),
    maxOutputChars: 4096, signal: abort.signal, terminationGraceMs: 1000, requireProcessGroupExit: true,
    ...(activity ? { processGroupLifecycle: activity.lifecycle('candidate') } : {}) }).then(result => { terminal = result; return result; }, error => { terminalError = error; });
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  function guard(allowTerminal = false) { if (faulted || terminal && !allowTerminal || terminalError || abort.signal.aborted || performance.now() >= deadline) throw failure(); }
  async function settle() {
    await completion;
    if (!terminal || terminalError || terminal.exitCode !== 0 || terminal.signal !== null || terminal.error || terminal.timedOut || terminal.cancelled ||
        terminal.outputTruncated || terminal.stdout !== '' || terminal.stderr !== '' || terminal.processGroupSettlement !== 'group-exit-confirmed') throw failure();
  }
  async function discard() { faulted = true; abort.abort(); await completion; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  async function broker(request, measurement) {
    const selected = readonlyCommand(request, fixtureRoot, scratch);
    if (request.id !== execId + 1 || request.id > 4096) throw failure();
    guard(); execId = request.id;
    const argv = confined([process.execPath, '--no-addons', tool]);
    const remaining = Math.max(1, Math.floor(deadline - performance.now()));
    // Count observed broker launches, never child-provided counters or failed
    // pre-spawn attempts. This is not a census of trusted tool descendants.
    const result = await bridge.runVerifySubprocessAsync(argv, { cwd: scratch, env: environment,
      input: JSON.stringify({ request, fixtureRoot, scratch }), timeoutMs: Math.min(remaining, selected.options.timeoutMs),
      maxOutputChars: MAX_MESSAGE_BYTES, signal: abort.signal, terminationGraceMs: 1000, requireProcessGroupExit: true,
      ...(activity ? { processGroupLifecycle: activity.lifecycle('tool') } : {}) });
    if (result.exitCode !== 0 || result.signal !== null || result.error || result.timedOut || result.cancelled ||
        result.outputTruncated || result.stderr !== '' || result.processGroupSettlement !== 'group-exit-confirmed') throw failure();
    const output = JSON.parse(result.stdout);
    if (!exact(output, ['started', 'status', 'signal', 'stdoutBase64', 'stderrBase64', 'error']) || output.started !== true ||
        output.status !== null && !Number.isSafeInteger(output.status) || output.signal !== null && typeof output.signal !== 'string' ||
        output.error !== null && (!exact(output.error, ['code']) || typeof output.error.code !== 'string')) throw failure();
    base64(output.stdoutBase64); base64(output.stderrBase64);
    measurement.processes++; if (selected.blob) measurement.blobProcesses++;
    delete output.started;
    guard(); publishMessage(join(inbox, `exec-reply-${execId}.json`), { schemaVersion: 1, id: execId, nonce: request.nonce, ok: true, result: output });
  }
  async function exchange(method, input) {
    const id = ++callId, nonce = randomBytes(32).toString('hex'), measurement = { processes: 0, blobProcesses: 0 };
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
        return reply.ok ? { value: reply.value, measurement } : { error: reply.error, measurement };
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
    async call(method, input) {
      if (closed || busy || faulted || callId >= MAX_CALLS || !['check', 'metadata'].includes(method)) throw failure();
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
          await exchange('close', null); await settle();
        } catch { await discard(); throw failure(); }
        finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
      })();
      return closePromise;
    },
  };
}
