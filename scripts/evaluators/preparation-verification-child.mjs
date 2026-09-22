/** Persistent candidate process for the NON-EVALUATION verification prototype.
 * The controller owns assertions and read-only fixtures. This child owns only
 * its outbox/scratch. VM linking is compatibility plumbing, not a security jail.
 * Actual process/network/file authority is supplied by the parent's OS profile.
 */
import cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module';
import { createContext, runInContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { TextDecoder, types } from 'node:util';
import { exact, readMessage, publishMessage, MAX_MESSAGE_BYTES, MAX_CALLS, MAX_SESSION_DURATION_MS } from './preparation-verification-protocol.mjs';

const TARGET = 'src/core/resources/engineering-preparation.ts';
const HASH = /^[a-f0-9]{64}$/;
const LEAF_METHODS = Object.freeze({
  check: 'checkResourceEngineeringPreparation', metadata: 'readPreparedResourceEngineeringMetadata',
  bundle: 'readPreparedResourceEngineeringBundle',
  'successor-check': 'checkResourceEngineeringSuccessorPreparation',
  'successor-metadata': 'readResourceEngineeringSuccessorMetadata',
  'successor-bundle': 'readResourceEngineeringSuccessorBundle',
});
const MANAGER_METHODS = Object.freeze({ 'manager-open': 'open', 'manager-check': 'check', 'manager-replay': 'replay', 'manager-close': 'close' });
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const clock = performance.now.bind(performance);
const wallClock = Date.now.bind(Date);
const readSync = fs.readSync.bind(fs);
const jsonParse = JSON.parse.bind(JSON);
const byteLength = Buffer.byteLength.bind(Buffer);
const bufferFrom = Buffer.from.bind(Buffer);
const isProxy = types.isProxy.bind(types);
const ownKeys = Reflect.ownKeys.bind(Reflect);
const getPrototype = Object.getPrototypeOf.bind(Object);
const descriptors = Object.getOwnPropertyDescriptors.bind(Object);
const hasOwn = Object.hasOwn.bind(Object);
const exit = process.exit.bind(process);
const wait = Atomics.wait.bind(Atomics);
let startup;
let expires = 0;
let execId = 0;

function fail() { throw new Error('CANDIDATE_PROTOCOL_UNAVAILABLE'); }
function remaining() {
  const value = Math.min(expires - clock(), Date.parse(startup.deadlineAt) - wallClock());
  if (value <= 0) fail();
  return value;
}
function waitMessage(file, localDeadline = expires) {
  for (;;) {
    remaining(); if (clock() >= localDeadline) fail();
    const value = readMessage(file);
    if (value !== null) { remaining(); if (clock() >= localDeadline) fail(); return value; }
    wait(sleeper, 0, 0, Math.min(5, remaining(), Math.max(1, localDeadline - clock())));
  }
}
function startupInput() {
  const bytes = Buffer.alloc(MAX_MESSAGE_BYTES + 1); let size = 0;
  for (;;) {
    const count = readSync(0, bytes, size, bytes.length - size, null);
    if (count === 0) break;
    size += count; if (size >= bytes.length) fail();
  }
  const value = jsonParse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  if (!exact(value, ['schemaVersion', 'sessionId', 'inbox', 'outbox', 'candidateRoot', 'bridgePath', 'deadlineAt']) ||
      value.schemaVersion !== 1 || !HASH.test(value.sessionId) || typeof value.deadlineAt !== 'string' ||
      !Number.isFinite(Date.parse(value.deadlineAt)) || new Date(value.deadlineAt).toISOString() !== value.deadlineAt) fail();
  for (const key of ['inbox', 'outbox', 'candidateRoot', 'bridgePath']) {
    if (typeof value[key] !== 'string' || byteLength(value[key]) > 4096 || !path.isAbsolute(value[key]) ||
        path.resolve(value[key]) !== value[key] || fs.realpathSync(value[key]) !== value[key]) fail();
  }
  const duration = Date.parse(value.deadlineAt) - wallClock();
  if (duration <= 0 || duration > MAX_SESSION_DURATION_MS) fail();
  startup = Object.freeze(value); expires = clock() + duration;
}

/** Never JSON-normalize candidate accessors/prototypes into valid plain data. */
function plainData(value, acceptedObjectPrototype = Object.prototype, acceptedArrayPrototype = Array.prototype, allowBuffer = false, depth = 0, ancestors = new Set()) {
  if (allowBuffer && Buffer.isBuffer(value)) { if (value.length > MAX_MESSAGE_BYTES) fail(); return bufferFrom(value); }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return value; }
  if (typeof value !== 'object' || isProxy(value) || depth > 48 || ancestors.has(value)) fail();
  const keys = ownKeys(value); if (keys.length > 8192) fail();
  const props = descriptors(value); const array = Array.isArray(value);
  if (array) {
    if (![Array.prototype, acceptedArrayPrototype].includes(getPrototype(value))) fail();
    if (value.length > 8192 || keys.length !== value.length + 1 || !keys.includes('length')) fail();
    for (let index = 0; index < value.length; index++) if (!hasOwn(props, index) || !hasOwn(props[index], 'value') || !props[index].enumerable) fail();
  } else if (![Object.prototype, null, acceptedObjectPrototype].includes(getPrototype(value))) fail();
  ancestors.add(value);
  try {
    if (array) return Array.from({ length: value.length }, (_, index) => plainData(props[index].value, acceptedObjectPrototype, acceptedArrayPrototype, allowBuffer, depth + 1, ancestors));
    const output = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || key === 'toJSON' || !hasOwn(props[key], 'value') || !props[key].enumerable) fail();
      output[key] = plainData(props[key].value, acceptedObjectPrototype, acceptedArrayPrototype, allowBuffer, depth + 1, ancestors);
    }
    return output;
  } finally { ancestors.delete(value); }
}
function normalizeOptions(value) {
  const allowed = ['cwd', 'encoding', 'timeout', 'maxBuffer', 'input', 'env', 'stdio', 'shell', 'windowsHide'];
  // Node callers commonly include input: undefined. Omit only own data-valued
  // optional fields here; candidate return values remain strictly JSON-shaped.
  let supplied = value;
  if (supplied !== undefined) {
    if (!supplied || typeof supplied !== 'object' || isProxy(supplied) ||
        ![Object.prototype, null].includes(getPrototype(supplied))) fail();
    const props = descriptors(supplied); const filtered = Object.create(null);
    for (const key of ownKeys(supplied)) {
      if (typeof key !== 'string' || !allowed.includes(key) || !hasOwn(props[key], 'value') || !props[key].enumerable) fail();
      if (props[key].value !== undefined) filtered[key] = props[key].value;
    }
    supplied = filtered;
  }
  const options = supplied === undefined ? {} : plainData(supplied, Object.prototype, Array.prototype, true);
  if (ownKeys(options).some(key => !allowed.includes(key)) || options.shell !== undefined && options.shell !== false ||
      options.windowsHide !== undefined && typeof options.windowsHide !== 'boolean') fail();
  if (options.cwd !== undefined && (typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd))) fail();
  if (options.env !== undefined && (!options.env || typeof options.env !== 'object' || Array.isArray(options.env) ||
      Object.values(options.env).some(item => typeof item !== 'string'))) fail();
  if (options.stdio !== undefined && (!Array.isArray(options.stdio) || options.stdio.length !== 3 ||
      !['ignore', 'pipe'].includes(options.stdio[0]) || options.stdio[1] !== 'pipe' || options.stdio[2] !== 'pipe')) fail();
  const encoding = options.encoding == null || options.encoding === 'buffer' ? 'buffer' :
    ['utf8', 'utf-8'].includes(options.encoding) ? 'utf8' : null;
  const timeoutMs = options.timeout === undefined ? Math.min(30000, Math.floor(remaining())) : options.timeout;
  const maxBuffer = options.maxBuffer === undefined ? 1024 * 1024 : options.maxBuffer;
  if (!encoding || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 68 * 1024 * 1024 ||
      options.input !== undefined && typeof options.input !== 'string' && !Buffer.isBuffer(options.input)) fail();
  return { cwd: options.cwd ?? null, encoding, timeoutMs, maxBuffer,
    inputBase64: options.input === undefined ? null : bufferFrom(options.input).toString('base64') };
}
function decodeBytes(value) {
  if (typeof value !== 'string' || value.length > MAX_MESSAGE_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const bytes = bufferFrom(value, 'base64'); if (bytes.toString('base64') !== value) fail(); return bytes;
}
function execute(api, file, args, rawOptions) {
  remaining(); if (++execId > 4096 || typeof file !== 'string' || !Array.isArray(args) || args.length > 128 || args.some(arg => typeof arg !== 'string')) fail();
  const options = normalizeOptions(rawOptions); const nonce = randomBytes(32).toString('hex'); const id = execId;
  const localDeadline = Math.min(expires, clock() + options.timeoutMs);
  publishMessage(path.join(startup.outbox, `exec-${id}.json`), { schemaVersion: 1, id, nonce, api, file, args, options });
  const reply = waitMessage(path.join(startup.inbox, `exec-reply-${id}.json`), localDeadline);
  if (!reply || reply.schemaVersion !== 1 || reply.id !== id || reply.nonce !== nonce || reply.ok !== true ||
      !exact(reply, ['schemaVersion', 'id', 'nonce', 'ok', 'result'])) fail();
  const result = reply.result;
  if (!exact(result, ['status', 'signal', 'stdoutBase64', 'stderrBase64', 'error']) ||
      result.status !== null && !Number.isSafeInteger(result.status) || result.signal !== null && typeof result.signal !== 'string' ||
      result.error !== null && (!exact(result.error, ['code']) || typeof result.error.code !== 'string')) fail();
  const stdoutBytes = decodeBytes(result.stdoutBase64); const stderrBytes = decodeBytes(result.stderrBase64);
  const stdout = options.encoding === 'buffer' ? stdoutBytes : stdoutBytes.toString('utf8');
  const stderr = options.encoding === 'buffer' ? stderrBytes : stderrBytes.toString('utf8');
  if (api === 'spawnSync') return { pid: 0, status: result.status, signal: result.signal, stdout, stderr, output: [null, stdout, stderr],
    ...(result.error ? { error: Object.assign(new Error('BROKER_PROCESS_FAILED'), { code: result.error.code }) } : {}) };
  if (result.status !== 0 || result.signal !== null || result.error !== null) throw Object.assign(new Error('BROKER_PROCESS_FAILED'),
    { status: result.status, signal: result.signal, stdout, stderr, ...(result.error ? { code: result.error.code } : {}) });
  return stdout;
}

async function loadCandidate() {
  // Ordinary child-process entry points are brokered or refused. The OS profile
  // also denies process-fork; VM linking itself grants no security boundary.
  cp.execFileSync = (file, args, options) => execute('execFileSync', file, args, options);
  cp.spawnSync = (file, args, options) => execute('spawnSync', file, args, options);
  for (const key of ['exec', 'execFile', 'execSync', 'spawn', 'fork']) cp[key] = fail;
  syncBuiltinESMExports();
  const bridge = await import(pathToFileURL(startup.bridgePath).href);
  const target = path.join(startup.candidateRoot, TARGET); const before = fs.lstatSync(target, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 256n * 1024n || fs.realpathSync(target) !== target) fail();
  const source = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(target)); const after = fs.lstatSync(target, { bigint: true });
  for (const key of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) if (after[key] !== before[key]) fail();
  const context = createContext({ process: Object.freeze({ env: Object.freeze({ PATH: process.env.PATH }) }),
    Buffer: Object.freeze(Object.fromEntries(['byteLength', 'from', 'alloc', 'concat', 'isBuffer'].map(key => [key, Buffer[key].bind(Buffer)]))) },
  { codeGeneration: { strings: false, wasm: false } });
  const objectPrototype = runInContext('Object.prototype', context);
  const arrayPrototype = runInContext('Array.prototype', context);
  function hostData(value, depth = 0) {
    if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
    if (isProxy(value) || depth > 48) fail();
    const proto = getPrototype(value);
    if (!Array.isArray(value) && ![Object.prototype, null, objectPrototype].includes(proto)) return value;
    const props = descriptors(value);
    if (ownKeys(value).some(key => typeof key !== 'string' || !hasOwn(props[key], 'value'))) return value;
    if (Array.isArray(value)) return Array.from(value, item => hostData(item, depth + 1));
    return Object.fromEntries(Object.entries(props).map(([key, property]) => [key, hostData(property.value, depth + 1)]));
  }
  const subject = new SourceTextModule(stripTypeScriptTypes(source, { mode: 'transform' }), { context,
    identifier: 'candidate-engineering-preparation', importModuleDynamically: fail });
  const builtins = { 'node:child_process': Object.freeze({ execFileSync: cp.execFileSync, spawnSync: cp.spawnSync,
    exec: fail, execFile: fail, execSync: fail, spawn: fail, fork: fail }), 'node:fs': fs, 'node:path': path };
  await subject.link(specifier => {
    const namespace = hasOwn(builtins, specifier) ? builtins[specifier] : bridge.dependencies[specifier];
    if (!namespace) fail();
    const keys = Object.keys(namespace);
    return new SyntheticModule(keys, function () {
      for (const key of keys) {
        const value = namespace[key];
        this.setExport(key, typeof value === 'function' && !/^class\s/.test(Function.prototype.toString.call(value))
          ? (...args) => value(...args.map(arg => hostData(arg))) : value);
      }
    }, { context });
  });
  await subject.evaluate({ timeout: Math.max(1, Math.min(1000, Math.floor(remaining()))) }); remaining();
  let workflow;
  async function loadWorkflow() {
    if (workflow) return workflow;
    if (typeof bridge.workflowSource !== 'string' || byteLength(bridge.workflowSource) > 32 * 1024 * 1024 ||
        !bridge.workflowDependencies || typeof bridge.workflowDependencies !== 'object') fail();
    // Fixed shipped code runs in the child's host realm, never the controller.
    // Its only preparation import is the selected candidate, not bridge.baseline.
    const trusted = new SourceTextModule(bridge.workflowSource, {
      identifier: 'trusted-preparation-workflow', importModuleDynamically: fail,
      initializeImportMeta(meta) { meta.url = pathToFileURL(startup.bridgePath).href; },
    });
    const cache = new Map();
    await trusted.link(specifier => {
      if (cache.has(specifier)) return cache.get(specifier);
      let namespace;
      if (specifier === 'ashlr:preparation-candidate') {
        namespace = Object.fromEntries(Object.keys(subject.namespace).filter(key =>
          typeof subject.namespace[key] === 'function').map(key => {
          const value = subject.namespace[key];
          return [key, (...args) => plainData(value(...args), objectPrototype, arrayPrototype)];
        }));
      } else if (specifier === 'ashlr:preparation-native') {
        namespace = { require(name) {
          if (typeof name !== 'string' || !hasOwn(bridge.workflowDependencies, name)) fail();
          const dependency = bridge.workflowDependencies[name];
          return hasOwn(dependency, 'default') ? dependency.default : dependency;
        } };
      } else if (hasOwn(bridge.workflowDependencies, specifier)) namespace = bridge.workflowDependencies[specifier];
      else fail();
      const keys = Object.keys(namespace);
      const module = new SyntheticModule(keys, function () {
        for (const key of keys) this.setExport(key, namespace[key]);
      });
      cache.set(specifier, module); return module;
    });
    await trusted.evaluate({ timeout: Math.max(1, Math.min(1000, Math.floor(remaining()))) }); remaining();
    if (typeof trusted.namespace.createPreparationWorkflow !== 'function') fail();
    const instance = trusted.namespace.createPreparationWorkflow();
    if (!instance || Object.values(MANAGER_METHODS).some(method => typeof instance[method] !== 'function')) fail();
    workflow = instance; return workflow;
  }
  return { subject: subject.namespace, objectPrototype, arrayPrototype, loadWorkflow,
    async closeWorkflow() { if (workflow) { await workflow.close(); remaining(); } } };
}
async function main() {
  startupInput(); const { subject, objectPrototype, arrayPrototype, loadWorkflow, closeWorkflow } = await loadCandidate();
  if (typeof subject.checkResourceEngineeringPreparation !== 'function' || typeof subject.readPreparedResourceEngineeringMetadata !== 'function') fail();
  publishMessage(path.join(startup.outbox, 'ready.json'), { schemaVersion: 1, sessionId: startup.sessionId, ready: true });
  for (let id = 1; id <= MAX_CALLS + 1; id++) {
    const request = waitMessage(path.join(startup.inbox, `request-${id}.json`));
    if (!exact(request, ['schemaVersion', 'id', 'nonce', 'method', 'input']) || request.schemaVersion !== 1 || request.id !== id ||
        typeof request.nonce !== 'string' || !HASH.test(request.nonce) ||
        !(hasOwn(LEAF_METHODS, request.method) || hasOwn(MANAGER_METHODS, request.method) || request.method === 'close') ||
        id > MAX_CALLS && request.method !== 'close') fail();
    const base = { schemaVersion: 1, id, nonce: request.nonce };
    if (request.method === 'close') {
      if (request.input !== null) fail(); await closeWorkflow();
      publishMessage(path.join(startup.outbox, `reply-${id}.json`), { ...base, ok: true, value: null }); exit(0);
    }
    let reply;
    try {
      let output;
      if (hasOwn(LEAF_METHODS, request.method)) {
        const method = subject[LEAF_METHODS[request.method]];
        if (typeof method !== 'function') fail();
        output = method(request.input);
      } else {
        if (request.method === 'manager-close' && request.input !== null) fail();
        const manager = await loadWorkflow();
        output = await manager[MANAGER_METHODS[request.method]](request.input);
      }
      remaining();
      try { reply = { ...base, ok: true, value: plainData(output, objectPrototype, arrayPrototype) }; }
      catch { reply = { ...base, ok: false, error: 'invalid-result' }; }
    } catch { reply = { ...base, ok: false, error: 'candidate-threw' }; }
    remaining(); publishMessage(path.join(startup.outbox, `reply-${id}.json`), reply);
  }
  fail();
}
main().catch(() => { exit(1); });
