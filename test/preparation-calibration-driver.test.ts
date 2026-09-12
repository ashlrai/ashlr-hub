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
  const stat = { dev: 1, ino: 2, mode: options.mode ?? 0o40700, uid: options.uid ?? 501,
    isDirectory: () => true, isSymbolicLink: () => options.symlink ?? false };
  const files = new Map<string, string>(), descriptors = new Map<number, string>();
  const events: string[] = []; let nextFd = 10;
  const fs = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 256 },
    realpathSync: vi.fn((name: string) => name === ROOT ? options.canonical ?? name : name),
    lstatSync: vi.fn(() => stat), readdirSync: vi.fn(() => options.entries ?? []),
    openSync: vi.fn((name: string, flags: string | number, mode?: number) => {
      if (name !== ROOT) { assert.equal(flags, 'wx'); assert.equal(mode, 0o600); assert.equal(path.dirname(name), ROOT); assert.ok(!files.has(name)); }
      else assert.equal(flags, 256);
      const fd = nextFd++; descriptors.set(fd, name); events.push(`open:${name}`); return fd;
    }),
    writeFileSync: vi.fn((fd: number, bytes: string) => { assert.ok(descriptors.has(fd)); files.set(descriptors.get(fd)!, bytes); }),
    fsyncSync: vi.fn((fd: number) => { events.push(`fsync:${descriptors.get(fd)}`);
      if (options.refuseDirectoryFsync && descriptors.get(fd) === ROOT) throw new Error('fixture fsync refusal'); }),
    fstatSync: vi.fn(() => stat), closeSync: vi.fn((fd: number) => { descriptors.delete(fd); }),
    mkdirSync: vi.fn(() => { throw new Error('Unexpected fixture creation'); }),
    readFileSync: vi.fn(() => { throw new Error('Unexpected file read'); }),
    readlinkSync: vi.fn(() => { throw new Error('Unexpected link read'); }),
  };
  const logs: string[] = [], errors: string[] = [];
  const timer = vi.fn(() => 1), clear = vi.fn();
  const git = vi.fn(() => {
    options.onGit?.({ stop: () => listeners.get('SIGTERM')?.(), expire: () => { now += 60_000; },
      kill: () => { kill = { sourceState: 'healthy', state: 'active' }; } });
    // End the normal preflight before source reads/setup; stop variants return
    // so the driver's post-command guard must detect the injected condition.
    if (!options.onGit) throw new Error('Intentional preflight boundary');
    return 'a'.repeat(40);
  });
  const resolve = vi.fn(() => ({ git: { path: '/fixed/git', digest: 'a'.repeat(64) } }));
  const capture = vi.fn(() => { throw new Error('Capture must never run in preflight tests'); });
  const init = vi.fn(() => { throw new Error('Initialization must never run in preflight tests'); });
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
    if (href.endsWith('/core/universe/store.js')) return { initUniverse: init };
    if (href.endsWith('/core/universe/preparation-measurement-capture.js')) return { captureUniversePreparationMeasurement: capture };
    return {};
  });
  class Clock extends Date { static override now() { return now; } }
  await invoke((name: string) => { assert.ok(Object.hasOwn(modules, name)); return modules[name]; }, load,
    { url: url.pathToFileURL(entry).href }, { AbortController }, Clock);
  expect(env).toEqual(originalEnv); expect(init).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
  expect(descriptors.size).toBe(0); expect(listeners.size).toBe(0);
  if (timer.mock.calls.length) expect(clear).toHaveBeenCalledExactlyOnceWith(1);
  return { process, fs, git, load, resolve, logs, errors, files, events, timer, clear };
}

describe('retained calibration driver isolated safety preflight', () => {
  it.each([
    [], ['/fixed/node', entry, '--help'],
    ['/fixed/node', entry, '--evidence-root', ROOT, '--deadline', '2026-09-12'],
    ['/fixed/node', entry, '--evidence-root', ROOT, '--deadline', new Date(NOW).toISOString()],
    ['/fixed/node', entry, '--evidence-root', ROOT, '--deadline', new Date(NOW + 6_000_001).toISOString()],
    ['/fixed/node', entry, '--evidence-root', 'relative', '--deadline', new Date(NOW + 1000).toISOString()],
    ['/fixed/node', entry, '--evidence-root', '/', '--deadline', new Date(NOW + 1000).toISOString()],
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
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
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
