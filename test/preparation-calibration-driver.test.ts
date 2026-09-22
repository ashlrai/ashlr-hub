import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Test-only dependency substitution of the whole trusted driver, not an
// alternative implementation of its guards. Every import is intercepted;
// no real Git, capture, filesystem mutation, HOME or KILL access is available.
const source = ts.createSourceFile('run-calibration.mjs', readFileSync(new URL(
  '../workplans/2026-09-12-installed-scoring/run-calibration.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const settlementFunction = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'assertSettledCapture');
if (!settlementFunction) throw new Error('Calibration settlement guard unavailable');
// Execute the actual driver guard with only assert injected. No process probing,
// private-key recovery, capture execution or filesystem access is available.
const checkSettlement = compileFunction(`${settlementFunction.getText(source)}\nreturn assertSettledCapture(captured, retained);`,
  ['assert', 'captured', 'retained']);
function settledFixture() {
  const captured = { state: 'recorded', disposition: 'created', intent: { captureId: 'baseline-v2-1', evaluator: { digest: 'a'.repeat(64) } },
    receipt: { outcome: 'captured', identityVerified: true, processGroupSettlement: 'group-exit-confirmed',
      custodyDiagnostics: { boundary: 'completed' }, report: { sha256: 'b'.repeat(64) } } };
  return { captured, retained: { ...structuredClone(captured), disposition: null } };
}
describe('calibration consumes exact retained settlement evidence', () => {
  it('accepts authenticated completion through its receipt without retaining the private key', () => {
    const { captured, retained } = settledFixture();
    expect(() => checkSettlement(assert, captured, retained)).not.toThrow();
  });
  it('preserves legacy captured receipts without inventing diagnostics', () => {
    const { captured, retained } = settledFixture();
    Reflect.deleteProperty(captured.receipt, 'custodyDiagnostics'); Reflect.deleteProperty(retained.receipt, 'custodyDiagnostics');
    expect(() => checkSettlement(assert, captured, retained)).not.toThrow();
  });
  it.each([
    { state: 'held' }, { disposition: 'replayed' }, { receipt: null },
    { receipt: { outcome: 'held', identityVerified: true, processGroupSettlement: 'unconfirmed' } },
    { receipt: { outcome: 'captured', identityVerified: false, processGroupSettlement: 'group-exit-confirmed' } },
    { receipt: { outcome: 'captured', identityVerified: true, processGroupSettlement: 'unconfirmed' } },
    { receipt: { outcome: 'captured', identityVerified: true, processGroupSettlement: 'group-exit-confirmed', custodyDiagnostics: { boundary: 'nested-activity' } } },
  ])('refuses unsuccessful fresh evidence even if readback agrees: %#', patch => {
    const { captured } = settledFixture(); const changed = { ...captured, ...patch };
    expect(() => checkSettlement(assert, changed, structuredClone(changed))).toThrow();
  });
  it.each(['state', 'intent', 'receipt', 'missing'] as const)('refuses mismatched retained %s', field => {
    const { captured, retained } = settledFixture();
    if (field === 'state') retained.state = 'held';
    if (field === 'intent') retained.intent.captureId = 'another-capture';
    if (field === 'receipt') retained.receipt.report.sha256 = 'c'.repeat(64);
    expect(() => checkSettlement(assert, captured, field === 'missing' ? null : retained)).toThrow();
  });
});
const transformed = ts.transform(source, [context => root => {
  const f = context.factory;
  const visit: ts.Visitor = node => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause!;
      const bindings: ts.VariableDeclaration[] = [];
      const lookup = () => f.createCallExpression(f.createIdentifier('__static'), undefined, [node.moduleSpecifier]);
      if (clause.name) bindings.push(f.createVariableDeclaration(clause.name, undefined, undefined,
        f.createPropertyAccessExpression(lookup(), 'default')));
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        bindings.push(f.createVariableDeclaration(f.createObjectBindingPattern(clause.namedBindings.elements.map(item =>
          f.createBindingElement(undefined, item.propertyName, item.name))), undefined, undefined, lookup()));
      }
      return f.createVariableStatement(undefined, f.createVariableDeclarationList(bindings, ts.NodeFlags.Const));
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) return f.createIdentifier('__meta');
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return f.updateCallExpression(node, f.createIdentifier('__load'), undefined,
        node.arguments.map(arg => ts.visitNode(arg, visit) as ts.Expression));
    }
    return ts.visitEachChild(node, visit, context);
  };
  return ts.visitNode(root, visit) as ts.SourceFile;
}]);
const program = ts.createPrinter().printFile(transformed.transformed[0]!).replace(/^#![^\n]*\n/, '');
transformed.dispose();
const invoke = compileFunction(`return (async () => { ${program}\n })();`,
  ['__static', '__load', '__meta', 'globalThis', 'Date']);
const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const ROOT = '/private/driver-evidence';
const REPOSITORY = '/fixed/repository';
const entry = `${REPOSITORY}/workplans/2026-09-12-installed-scoring/run-calibration.mjs`;

interface Options {
  argv?: string[]; platform?: string; node?: string; mode?: number; uid?: number;
  symlink?: boolean; canonical?: string; entries?: string[];
  kill?: { sourceState: string; state: string }; env?: Record<string, string>;
  onGit?: (state: { stop(): void; expire(): void; kill(): void }) => void;
  refuseDirectoryFsync?: boolean;
  sourceFixture?: { refuse?: 'staged' | 'unstaged' | 'head' | 'tree' | 'identity' | 'canonical' | 'symlink' | 'mode' | 'deadline' | 'growth' | 'oversized' | 'unmerged' | 'replacement' | 'promisor' | 'partial-clone' | 'worktree-promisor' | 'worktree-partial-clone'; late?: boolean;
    algorithm?: 'sha1' | 'sha256'; materializedWrong?: boolean };
}
async function run(options: Options = {}) {
  let now = NOW, kill = options.kill ?? { sourceState: 'healthy', state: 'inactive' };
  const listeners = new Map<string, () => void>();
  const env = { HOME: '/untouched/home', ASHLR_HOME: '/untouched/ashlr', ...options.env };
  const originalEnv = { ...env };
  const process = { platform: options.platform ?? 'darwin', versions: { node: options.node ?? '24.18.0' },
    argv: options.argv ?? ['/fixed/node', entry, '--evidence-root', ROOT, '--deadline', new Date(NOW + 60_000).toISOString()],
    env, execPath: '/fixed/node', version: 'v24.18.0', exitCode: undefined as number | undefined,
    getuid: () => 501, once: vi.fn((event: string, callback: () => void) => listeners.set(event, callback)),
    removeListener: vi.fn((event: string) => listeners.delete(event)) };
  let sourceWasRead = false, repositoryVisits = 0, headReads = 0, treeReads = 0;
  const refuseSource = (kind: NonNullable<Options['sourceFixture']>['refuse']) => options.sourceFixture?.refuse === kind &&
    (!options.sourceFixture?.late || sourceWasRead);
  const sourceBytes = Buffer.from('export const unchanged = true;\n');
  const sourceOid = createHash(options.sourceFixture?.algorithm ?? 'sha1').update(`blob ${sourceBytes.length}\0`).update(sourceBytes).digest('hex');
  const targetPath = `${REPOSITORY}/src/core/resources/engineering-preparation.ts`;
  const stat = { dev: 1, ino: 2, mode: options.mode ?? 0o40700, uid: options.uid ?? 501,
    isDirectory: () => true, isSymbolicLink: () => options.symlink ?? false };
  const files = new Map<string, string>(), descriptors = new Map<number, string>();
  const events: string[] = []; let nextFd = 10;
  const fileStat = () => ({ dev: 1n, ino: 3n, mode: refuseSource('mode') ? 0o100755n : 0o100644n, uid: 501n, gid: 20n,
    nlink: 1n, size: refuseSource('oversized') ? 64n * 1024n * 1024n + 1n : BigInt(sourceBytes.length), mtimeNs: 1n, ctimeNs: 1n,
    isFile: () => true, isSymbolicLink: () => refuseSource('symlink') });
  const fs = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 256, O_NONBLOCK: 4 },
    realpathSync: vi.fn((name: string) => name === ROOT ? options.canonical ?? name :
      name === REPOSITORY && repositoryVisits > 1 && refuseSource('canonical') ? '/replaced/repository' : name),
    lstatSync: vi.fn((name: string) => name === targetPath ? fileStat() : name === REPOSITORY && ++repositoryVisits > 1 && refuseSource('identity') ?
      { ...stat, ino: 99 } : stat), readdirSync: vi.fn((_name: string) => options.entries ?? []),
    openSync: vi.fn((name: string, flags: string | number, mode?: number) => {
      if (name === targetPath) assert.equal(flags, 260);
      else if (name !== ROOT) { assert.equal(flags, 'wx'); assert.equal(mode, 0o600); assert.equal(path.dirname(name), ROOT); assert.ok(!files.has(name)); }
      else assert.equal(flags, 256);
      const fd = nextFd++; descriptors.set(fd, name); events.push(`open:${name}`); return fd;
    }),
    writeFileSync: vi.fn((fd: number, bytes: string) => { assert.ok(descriptors.has(fd)); files.set(descriptors.get(fd)!, bytes); }),
    fsyncSync: vi.fn((fd: number) => { events.push(`fsync:${descriptors.get(fd)}`);
      if (options.refuseDirectoryFsync && descriptors.get(fd) === ROOT) throw new Error('fixture fsync refusal'); }),
    fstatSync: vi.fn((fd: number) => descriptors.get(fd) === targetPath ? fileStat() : stat), closeSync: vi.fn((fd: number) => { descriptors.delete(fd); }),
    mkdirSync: vi.fn(() => { throw new Error('Unexpected fixture creation'); }),
    readFileSync: vi.fn((name: string) => {
      if (options.sourceFixture && name === `${REPOSITORY}/src/core/resources/engineering-preparation.ts`) {
        sourceWasRead = true; return sourceBytes;
      }
      throw new Error('Unexpected file read');
    }),
    readlinkSync: vi.fn(() => { throw new Error('Unexpected link read'); }),
    readSync: vi.fn((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      assert.equal(descriptors.get(fd), targetPath);
      const bytes = refuseSource('unstaged') ? Buffer.alloc(sourceBytes.length, 'x') :
        refuseSource('growth') ? Buffer.concat([sourceBytes, Buffer.from('x')]) : sourceBytes;
      const count = bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length));
      if (refuseSource('deadline')) now += 60_000;
      return count;
    }),
  };
  const logs: string[] = [], errors: string[] = [];
  const timer = vi.fn(() => 1), clear = vi.fn();
  const git = vi.fn((_executable: string, args: string[]) => {
    if (options.sourceFixture) {
      const command = args.slice(args.indexOf('-C') + 2);
      if (command[0] === 'ls-tree') return `100644 blob ${sourceOid}\tsrc/core/resources/engineering-preparation.ts\0`;
      if (command[0] === 'ls-files') return `100644 ${refuseSource('staged') ? 'd'.repeat(40) : sourceOid} ${refuseSource('unmerged') ? 2 : 0}\tsrc/core/resources/engineering-preparation.ts\0`;
      if (command[0] === 'for-each-ref') return refuseSource('replacement') ? 'refs/replace/fixed\n' : '';
      if (command[0] === 'config') {
        // Model the real distinction: --local does not reveal config.worktree.
        const worktree = !command.includes('--local');
        if (worktree && refuseSource('worktree-promisor')) return 'extensions.worktreeConfig\ntrue\0remote.origin.promisor\ntrue\0';
        if (worktree && refuseSource('worktree-partial-clone')) return 'extensions.worktreeConfig\ntrue\0extensions.partialClone\norigin\0';
        return refuseSource('promisor') ? 'remote.origin.promisor\ntrue\0' :
          refuseSource('partial-clone') ? 'extensions.partialClone\norigin\0' : 'filter.fixture.clean\nnever-execute-this\0filter.fixture.process\nnever-execute-this-either\0';
      }
      if (command.join(' ') === 'rev-parse HEAD') return ++headReads > 1 && refuseSource('head') ? 'd'.repeat(40) : 'a'.repeat(40);
      if (command[0] === 'rev-parse' && command[1]?.endsWith('^{tree}')) return ++treeReads > 1 && refuseSource('tree') ? 'd'.repeat(40) : 'b'.repeat(40);
      if (command[0] === 'rev-parse' && command[1]?.includes(':')) return sourceOid;
      if (command.join(' ') === `cat-file blob ${sourceOid}`) return sourceBytes.toString();
      throw new Error('Unexpected source fixture Git command');
    }
    options.onGit?.({ stop: () => listeners.get('SIGTERM')?.(), expire: () => { now += 60_000; },
      kill: () => { kill = { sourceState: 'healthy', state: 'active' }; } });
    // End the normal preflight before source reads/setup; stop variants return
    // so the driver's post-command guard must detect the injected condition.
    if (!options.onGit) throw new Error('Intentional preflight boundary');
    return 'a'.repeat(40);
  });
  const resolve = vi.fn(() => ({ git: { path: '/fixed/git', digest: 'a'.repeat(64) } }));
  const capture = vi.fn(() => { throw new Error('Capture must never run in preflight tests'); });
  const coreEnvironments: Record<string, string>[] = [];
  const init = vi.fn(() => {
    coreEnvironments.push({ ...env });
    if (options.sourceFixture?.materializedWrong) return;
    throw new Error('Initialization must never run in preflight tests');
  });
  const artifactRead = vi.fn(() => ({ digest: 'fixture-artifact', entries: [{ path: 'src/core/resources/engineering-preparation.ts',
    executable: false, data: Buffer.from('wrong materialized bytes') }] }));
  const modules: Record<string, unknown> = {
    'node:assert/strict': { default: assert }, 'node:buffer': { Buffer },
    'node:console': { default: { log: (text: string) => logs.push(text), error: (text: string) => errors.push(text) } },
    'node:process': { default: process }, 'node:child_process': { execFileSync: git }, 'node:crypto': { createHash },
    'node:fs': fs, 'node:path': path, 'node:perf_hooks': { performance: { now: () => now - NOW } },
    'node:timers': { setTimeout: timer, clearTimeout: clear }, 'node:url': url,
  };
  const load = vi.fn(async (href: string) => {
    assert.ok(href.startsWith(`file://${REPOSITORY}/`));
    if (href.endsWith('/core/sandbox/policy.js')) return { readKillSwitch: () => kill };
    if (href.endsWith('/core/universe/builtin-evaluator-registry.js')) return { resolveBuiltinEvaluator: resolve };
    if (href.endsWith('/core/universe/store.js')) return { initUniverse: init, universePath: () => `${ROOT}/universe/fixture`, readRecords: () => [],
      manifestRecord: () => ({ manifest: { seed: { repo: REPOSITORY, revision: 'a'.repeat(40) } },
        seedArtifact: { path: `${ROOT}/frozen-seed`, revision: 'a'.repeat(40), digest: 'fixture-artifact' } }) };
    if (href.endsWith('/core/universe/artifacts.js')) return { readArtifactSnapshot: artifactRead, MAX_ARTIFACT_BYTES: 64 * 1024 * 1024, MAX_ARTIFACT_ENTRIES: 8192 };
    if (href.endsWith('/core/universe/preparation-measurement-capture.js')) return { captureUniversePreparationMeasurement: capture };
    return {};
  });
  class Clock extends Date { static override now() { return now; } }
  await invoke((name: string) => { assert.ok(Object.hasOwn(modules, name)); return modules[name]; }, load,
    { url: url.pathToFileURL(entry).href }, { AbortController }, Clock);
  expect(env).toEqual(originalEnv); expect(capture).not.toHaveBeenCalled();
  if (!options.sourceFixture || options.sourceFixture.refuse) expect(init).not.toHaveBeenCalled();
  expect(descriptors.size).toBe(0); expect(listeners.size).toBe(0);
  if (timer.mock.calls.length) expect(clear).toHaveBeenCalledExactlyOnceWith(1);
  return { process, fs, git, load, resolve, logs, errors, files, events, timer, clear, init, coreEnvironments, artifactRead };
}

describe('retained calibration driver isolated safety preflight', () => {
  it.each([
    [], ['/fixed/node', entry, '--help'],
    ['/fixed/node', entry, '--evidence-root', ROOT, '--deadline', '2026-09-12'],
    ['/fixed/node', entry, '--evidence-root', ROOT, '--deadline', new Date(NOW).toISOString()],
    ['/fixed/node', entry, '--evidence-root', ROOT, '--deadline', new Date(NOW + 6_000_001).toISOString()],
    ['/fixed/node', entry, '--evidence-root', 'relative', '--deadline', new Date(NOW + 1000).toISOString()],
    ['/fixed/node', entry, '--evidence-root', '/', '--deadline', new Date(NOW + 1000).toISOString()],
    ['/fixed/node', entry, '--evidence-root', ROOT, '--deadline', new Date(NOW + 1000).toISOString(), '--seed', '/arbitrary/repository'],
    ['/fixed/node', entry, '--evidence-root', ROOT, '--deadline', new Date(NOW + 1000).toISOString(), '--repo', REPOSITORY],
    ['/fixed/node', entry, '--evidence-root', ROOT, '--deadline', new Date(NOW + 1000).toISOString(), '--seed', 'private-one-file'],
    ['/fixed/node', entry, '--evidence-root', `${REPOSITORY}/evidence`, '--deadline', new Date(NOW + 1000).toISOString()],
    ['/fixed/node', entry, '--evidence-root', '/fixed', '--deadline', new Date(NOW + 1000).toISOString()],
  ].map(argv => ({ argv })))('refuses invalid arguments before runtime import or mutation: %j', async ({ argv }) => {
    const r = await run({ argv }); expect(r.process.exitCode).toBe(1); expect(r.load).not.toHaveBeenCalled();
    expect(r.git).not.toHaveBeenCalled(); expect(r.fs.openSync).not.toHaveBeenCalled();
  });
  it.each([{ platform: 'linux' }, { node: '22.15.0' }, { mode: 0o40755 }, { uid: 502 },
    { symlink: true }, { canonical: '/different' }, { entries: ['existing.json'] }])('refuses unsafe host/root before claiming evidence: %j', async options => {
    const r = await run(options); expect(r.process.exitCode).toBe(1); expect(r.load).not.toHaveBeenCalled();
    expect(r.files.size).toBe(0); expect(r.git).not.toHaveBeenCalled();
  });
  it.each([{ sourceState: 'healthy', state: 'active' }, { sourceState: 'degraded', state: 'unknown' }])('refuses KILL state without resolving runtime or Git: %j', async kill => {
    const r = await run({ kill }); expect(r.process.exitCode).toBe(1); expect(r.load).toHaveBeenCalledTimes(1);
    expect(r.resolve).not.toHaveBeenCalled(); expect(r.git).not.toHaveBeenCalled();
    expect(JSON.parse(r.files.get(`${ROOT}/driver-failure.json`)!)).toMatchObject({
      code: kill.sourceState === 'healthy' ? 'KILL_SWITCH_ACTIVE' : 'KILL_SWITCH_UNAVAILABLE', retained: true, automaticRetry: false });
    expect(r.events).toEqual([`open:${ROOT}/driver-failure.json`, `fsync:${ROOT}/driver-failure.json`, `open:${ROOT}`, `fsync:${ROOT}`]);
  });
  it('removes ambient Git authority while preserving real HOME/KILL environment values', async () => {
    const r = await run({ env: { GIT_DIR: '/real/repo/.git', GIT_WORK_TREE: '/real/repo', GIT_INDEX_FILE: '/real/index',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/real/hooks', GIT_CONFIG_PARAMETERS: 'bad', PATH: '/untrusted' } });
    expect(r.git).toHaveBeenCalledTimes(1);
    const [executable, args, options] = r.git.mock.calls[0] as unknown as [string, string[], { env: Record<string, string>; timeout: number }];
    expect(executable).toBe('/fixed/git'); expect(args.slice(-4)).toEqual(['-C', REPOSITORY, 'rev-parse', 'HEAD']);
    expect(Object.fromEntries(Object.entries(options.env).filter(([key]) => key.startsWith('GIT_')))).toEqual({
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0' });
    expect(options.env).toMatchObject({ HOME: '/untouched/home', ASHLR_HOME: '/untouched/ashlr', PATH: '/fixed:/fixed:/usr/bin:/bin' });
    expect(options.timeout).toBe(10_000); expect(r.process.exitCode).toBe(1);
  });
  it.each(['stop', 'expire', 'kill'] as const)('rechecks %s after Git before further work', async action => {
    const r = await run({ onGit: state => state[action]() }); expect(r.git).toHaveBeenCalledTimes(1);
    expect(r.fs.readFileSync).not.toHaveBeenCalled(); expect(r.process.exitCode).toBe(1);
    expect(JSON.parse(r.errors[0]!)).toMatchObject({ code: action === 'kill' ? 'KILL_SWITCH_ACTIVE' : 'CALIBRATION_STOPPED' });
  });
  it('does not replace retained failure bytes when directory fsync refuses', async () => {
    const r = await run({ kill: { sourceState: 'healthy', state: 'active' }, refuseDirectoryFsync: true });
    expect(r.files.size).toBe(1); expect(r.fs.writeFileSync).toHaveBeenCalledTimes(1); expect(r.process.exitCode).toBe(1);
    expect(r.logs.some(text => JSON.parse(text).phase === 'calibrated-and-retained')).toBe(false);
  });
});

describe('calibration driver closed source-repository mode (synthetic pre-initialization fixture)', () => {
  const argv = ['/fixed/node', entry, '--evidence-root', ROOT, '--deadline', new Date(NOW + 60_000).toISOString(), '--seed', 'source-repository'];
  it.each(['sha1', 'sha256'] as const)('passes the actual source repository and %s blob proof to init without filters, cloning or checkout traversal', async algorithm => {
    const r = await run({ argv, sourceFixture: { algorithm }, env: { PATH: '/ambient/untrusted' } });
    expect(r.init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ seed: { repo: REPOSITORY, revision: 'a'.repeat(40) },
      evaluation: { builtin: 'preparation-measurement-v1', timeoutMs: 1_800_000 },
      budget: expect.objectContaining({ trialTimeoutMs: 900_000 }) }), { root: `${ROOT}/universe` });
    expect(JSON.parse(r.files.get(`${ROOT}/source-origin.json`)!)).toMatchObject({ seedScope: 'source-repository', sourceTree: 'b'.repeat(40) });
    expect(JSON.parse(r.files.get(`${ROOT}/invocation.json`)!)).toMatchObject({ seedScope: 'source-repository', sourceTree: 'b'.repeat(40) });
    expect(r.fs.mkdirSync).not.toHaveBeenCalled();
    expect(r.fs.readdirSync.mock.calls.every(([name]) => name === ROOT)).toBe(true);
    expect(r.fs.readFileSync.mock.calls.every(([name]) => name === `${REPOSITORY}/src/core/resources/engineering-preparation.ts`)).toBe(true);
    expect(r.git.mock.calls.some(([, args]) => args.includes('init') || args.includes('add') || args.includes('commit'))).toBe(false);
    expect(r.git.mock.calls.every(([, args]) => ['rev-parse', 'ls-tree', 'ls-files', 'cat-file', 'for-each-ref', 'config'].includes(args[args.indexOf('-C') + 2]!))).toBe(true);
    expect(r.git.mock.calls.filter(([, args]) => args[args.indexOf('-C') + 2] === 'config')
      .every(([, args]) => args.slice(args.indexOf('-C') + 2).join(' ') === 'config --includes --null --list')).toBe(true);
    expect(r.fs.readSync).toHaveBeenCalled();
    expect(r.coreEnvironments).toEqual([expect.objectContaining({ PATH: '/fixed:/fixed:/usr/bin:/bin', HOME: '/untouched/home', ASHLR_HOME: '/untouched/ashlr' })]);
    expect(r.process.env).toMatchObject({ PATH: '/ambient/untrusted' });
    // init is an intentional throwing boundary; this is not a genuine capture.
    expect(r.process.exitCode).toBe(1);
  });
  it.each(['staged', 'unstaged', 'head', 'tree', 'identity', 'canonical', 'symlink', 'mode', 'deadline', 'growth', 'oversized', 'unmerged', 'replacement', 'promisor', 'partial-clone', 'worktree-promisor', 'worktree-partial-clone'] as const)('refuses initial %s mismatch before initialization', async refuse => {
    const r = await run({ argv, sourceFixture: { refuse } });
    expect(r.process.exitCode).toBe(1); expect(r.init).not.toHaveBeenCalled();
    expect(r.files.has(`${ROOT}/manifest.json`)).toBe(false);
    if (refuse === 'oversized') expect(r.fs.readSync).not.toHaveBeenCalled();
    if (refuse === 'growth') expect(r.fs.readSync).toHaveBeenCalledTimes(1);
  });
  it.each(['staged', 'unstaged', 'head', 'tree', 'identity', 'canonical', 'symlink', 'mode', 'deadline'] as const)('fresh guard refuses later %s drift before initialization', async refuse => {
    const r = await run({ argv, sourceFixture: { refuse, late: true } });
    expect(r.fs.readFileSync).toHaveBeenCalled(); expect(r.process.exitCode).toBe(1);
    expect(r.init).not.toHaveBeenCalled(); expect(r.files.has(`${ROOT}/manifest.json`)).toBe(false);
  });
  it('refuses an independently mismatched materialized seed before any capture', async () => {
    const r = await run({ argv, sourceFixture: { materializedWrong: true } });
    expect(r.init).toHaveBeenCalledTimes(1); expect(r.artifactRead).toHaveBeenCalledExactlyOnceWith(`${ROOT}/frozen-seed`);
    expect(r.process.exitCode).toBe(1); expect(r.files.has(`${ROOT}/baseline-v2-1-capture.json`)).toBe(false);
    expect(r.process.env).not.toHaveProperty('PATH');
  });
});

// Exercise only the real final-publication statements and their real guard/save
// definitions. This seam does NOT fabricate three successful capture receipts
// or claim to validate a calibration; the descriptor is an opaque write payload.
function declaration(name: string, statements = source.statements): ts.Statement {
  const found = statements.find(statement => ts.isFunctionDeclaration(statement) ? statement.name?.text === name :
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item =>
      ts.isIdentifier(item.name) && item.name.text === name));
  assert.ok(found, `Driver declaration missing: ${name}`); return found;
}
const main = declaration('main') as ts.FunctionDeclaration;
const finalStatements = main.body!.statements;
const publication = finalStatements.findIndex(statement => ts.isExpressionStatement(statement) &&
  ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression) &&
  statement.expression.expression.text === 'saveJson' &&
  ts.isStringLiteral(statement.expression.arguments[0]!) && statement.expression.arguments[0]!.text === 'calibration.json');
assert.ok(publication > 0);
const finalPhase = compileFunction(`
  const { assert, Buffer, evidenceRoot, rootIdentity, lstatSync, realpathSync, openSync, closeSync,
    fstatSync, fsyncSync, writeFileSync, constants, process, join, controller, performance,
    deadlineAt, deadlineMonotonicMs, readKillSwitch, resolveBuiltinEvaluator, installed,
    git, repository, sourceHead, readFileSync, target, source, descriptor, announce } = fixture;
  const seedScope = 'private-one-file';
  let code = 'CALIBRATION_NOT_CONFIRMED'; const abort = () => controller.abort();
  ${['assertRoot', 'save', 'saveJson', 'timeGuard'].map(name => declaration(name).getText(source)).join('\n')}
  ${declaration('guard', finalStatements).getText(source)}
  ${declaration('fresh', finalStatements).getText(source)}
  ${finalStatements.slice(publication - 1).map(statement => statement.getText(source)).join('\n')}
`, ['fixture', 'Date']);

describe('calibration driver final publication guard (phase-only fixture)', () => {
  it.each(['healthy', 'deadline', 'kill'] as const)('retains publication and reports success only if final %s guard permits', condition => {
    let now = NOW, kill = { sourceState: 'healthy', state: 'inactive' };
    const controller = new AbortController(), events: string[] = [];
    const descriptors = new Map<number, string>(), saved = new Map<string, string>(); let next = 1;
    const stat = { dev: 1, ino: 2, mode: 0o40700, uid: 501, isDirectory: () => true, isSymbolicLink: () => false };
    const announced = vi.fn(), readKill = vi.fn(() => kill);
    const sourceBytes = Buffer.from('fixed source'), installed = { digest: 'a'.repeat(64) };
    const fixture = {
      assert, Buffer, evidenceRoot: ROOT, rootIdentity: stat, lstatSync: () => stat, realpathSync: (name: string) => name,
      constants: { O_RDONLY: 0, O_NOFOLLOW: 256 }, process: { getuid: () => 501 }, join: path.join,
      openSync: (name: string, flags: string | number) => {
        expect(flags).toBe(name === ROOT ? 256 : 'wx'); const fd = next++; descriptors.set(fd, name); return fd;
      },
      writeFileSync: (fd: number, bytes: string) => { saved.set(descriptors.get(fd)!, bytes); },
      closeSync: (fd: number) => descriptors.delete(fd), fstatSync: () => stat,
      fsyncSync: (fd: number) => {
        const name = descriptors.get(fd)!; events.push(`fsync:${name}`);
        if (name === ROOT && condition === 'deadline') now = NOW + 1000;
        if (name === ROOT && condition === 'kill') kill = { sourceState: 'healthy', state: 'active' };
      },
      controller, performance: { now: () => now - NOW }, deadlineAt: NOW + 1000, deadlineMonotonicMs: 1000,
      readKillSwitch: readKill, resolveBuiltinEvaluator: () => installed, installed,
      git: () => 'fixed-head', repository: REPOSITORY, sourceHead: 'fixed-head',
      readFileSync: () => sourceBytes, target: 'fixed-target', source: sourceBytes,
      descriptor: { opaquePhaseOnlyPayload: true }, announce: announced,
    };
    class Clock extends Date { static override now() { return now; } }
    if (condition === 'healthy') {
      finalPhase(fixture, Clock); expect(announced).toHaveBeenCalledExactlyOnceWith('calibrated-and-retained');
    } else {
      expect(() => finalPhase(fixture, Clock)).toThrow(); expect(announced).not.toHaveBeenCalled();
      expect(controller.signal.aborted).toBe(condition === 'deadline');
    }
    expect(events).toEqual([`fsync:${ROOT}/calibration.json`, `fsync:${ROOT}`]);
    expect(JSON.parse(saved.get(`${ROOT}/calibration.json`)!)).toEqual(fixture.descriptor);
    expect(descriptors.size).toBe(0);
    if (condition === 'kill') expect(readKill.mock.results.at(-1)!.value).toEqual({ sourceState: 'healthy', state: 'active' });
  });
});
