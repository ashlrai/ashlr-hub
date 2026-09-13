/** Executes the actual driver on private fixtures. No accounts, providers or production ledger access. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import * as perf from 'node:perf_hooks';
import * as util from 'node:util';
import { setImmediate } from 'node:timers/promises';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { compileFunction } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as locks from '../src/core/fleet/local-store-lock.js';
import { killSwitchPath, readKillSwitch } from '../src/core/sandbox/policy.js';

const entry = new URL('../workplans/2026-09-12-standing-mission/reconcile-legacy-collector.mjs', import.meta.url);
const source = ts.createSourceFile('driver.mjs', fs.readFileSync(entry, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
const transformed = ts.transform(source, [context => root => {
  const f = context.factory;
  const visit: ts.Visitor = node => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause!.namedBindings as ts.NamedImports;
      return f.createVariableStatement(undefined, f.createVariableDeclarationList([f.createVariableDeclaration(
        f.createObjectBindingPattern(bindings.elements.map(item => f.createBindingElement(undefined, item.propertyName, item.name))),
        undefined, undefined, f.createCallExpression(f.createIdentifier('__static'), undefined, [node.moduleSpecifier]))], ts.NodeFlags.Const));
    }
    if (ts.isMetaProperty(node)) return f.createIdentifier('__meta');
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return f.updateCallExpression(node,
      f.createIdentifier('__load'), undefined, node.arguments.map(arg => ts.visitNode(arg, visit) as ts.Expression));
    return ts.visitEachChild(node, visit, context);
  };
  return ts.visitNode(root, visit) as ts.SourceFile;
}]);
const invoke = compileFunction(`return (async()=>{${ts.createPrinter().printFile(transformed.transformed[0]!).replace(/^#![^\n]*\n/, '')}})();`,
  ['__static', '__load', '__meta', 'globalThis']); transformed.dispose();
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'legacy-quarantine-'))); roots.push(base);
  const root = path.join(base, 'ledger'), evidence = path.join(base, 'evidence'), home = path.join(base, 'home');
  for (const directory of [root, evidence, home, path.join(home, '.ashlr'), path.join(root, 'history')]) fs.mkdirSync(directory, { mode: 0o700 });
  const marker = path.join(root, '.resource-quota-refresh-pending.json'), kill = path.join(home, '.ashlr/KILL');
  const bytes = Buffer.from('{"schemaVersion":1,"scope":"codex-native-metadata","state":"pending","startedAt":"2026-09-12T12:00:00.000Z"}\n');
  fs.writeFileSync(marker, bytes, { mode: 0o600 }); fs.writeFileSync(kill, '', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'pool-state.json'), '{"usedTokens":97,"ceiling":75,"paused":true}', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'history/shared-evidence.json'), 'PRIVATE_QUOTA_EVIDENCE', { mode: 0o600 });
  vi.stubEnv('HOME', home); expect(killSwitchPath()).toBe(kill); expect(readKillSwitch()).toMatchObject({ state: 'active', sourceState: 'healthy' });
  return { base, root, evidence, home, marker, kill, bytes,
    argv: ['node', url.fileURLToPath(entry), '--root', root, '--evidence', evidence, '--expected-marker-sha256', hash(bytes), '--authorize-legacy-quarantine'] };
}
type Fixture = ReturnType<typeof fixture>;
async function run(f: Fixture, options: { argv?: string[]; fs?: Partial<typeof fs>; locks?: Partial<typeof locks>; platform?: string; node?: string; clock?: () => number;
  atYield?: (stop: () => void) => void } = {}) {
  const listeners = new Map<string, () => void>();
  const log = vi.fn(), processDouble = { argv: options.argv ?? f.argv, platform: options.platform ?? 'darwin', versions: { node: options.node ?? '24.18.0' },
    getuid: () => process.getuid!(), exitCode: undefined as number | undefined,
    once: vi.fn((event: string, callback: () => void) => listeners.set(event, callback)), removeListener: vi.fn() };
  const native: Record<string, unknown> = { 'node:crypto': crypto, 'node:fs': { ...fs, ...options.fs }, 'node:path': path, 'node:url': url,
    'node:perf_hooks': options.clock ? { performance: { now: options.clock } } : perf, 'node:util': util, 'node:buffer': { Buffer },
    'node:timers/promises': { setImmediate: async () => { await setImmediate(); options.atYield?.(() => listeners.get('SIGTERM')?.()); } } };
  const load = vi.fn(async (specifier: string) => {
    if (specifier.endsWith('/dist/core/fleet/local-store-lock.js')) return { ...locks, ...options.locks };
    if (specifier.endsWith('/dist/core/sandbox/policy.js')) return { readKillSwitch };
    throw Error('Unexpected driver dependency');
  });
  await invoke((specifier: string) => { if (!Object.hasOwn(native, specifier)) throw Error('Unexpected import'); return native[specifier]; },
    load, { url: entry.href }, { process: processDouble, console: { log } });
  expect(log).toHaveBeenCalledOnce(); const report = JSON.parse(log.mock.calls[0]![0] as string);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|ownerToken|usedTokens/);
  expect(processDouble.removeListener).toHaveBeenCalledTimes(2);
  return { report, exitCode: processDouble.exitCode, load };
}
function untouched(f: Fixture) {
  expect(fs.readFileSync(path.join(f.root, 'pool-state.json'), 'utf8')).toBe('{"usedTokens":97,"ceiling":75,"paused":true}');
  expect(fs.readFileSync(path.join(f.root, 'history/shared-evidence.json'), 'utf8')).toBe('PRIVATE_QUOTA_EVIDENCE');
  expect(readKillSwitch()).toMatchObject({ state: 'active', sourceState: 'healthy' });
}
describe('explicit legacy collector quarantine driver', () => {
  it('preserves raw marker/inode, usage and evidence under real exclusive ownership', async () => {
    const f = fixture(), before = fs.lstatSync(f.marker), result = await run(f);
    expect(result.exitCode).toBe(0); expect(result.report).toMatchObject({ state: 'quarantined', markerMoved: true, historicalOwner: 'unknown-not-proven-dead', executionAuthorized: false });
    expect(fs.existsSync(f.marker)).toBe(false); expect(fs.existsSync(path.join(f.root, '.resource-quota-refresh.lock'))).toBe(false);
    const quarantined = path.join(f.evidence, 'quarantined-marker.json'); expect(fs.lstatSync(quarantined).ino).toBe(before.ino);
    for (const name of fs.readdirSync(f.evidence)) expect(fs.lstatSync(path.join(f.evidence, name)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(quarantined)).toEqual(f.bytes); expect(fs.readFileSync(path.join(f.evidence, 'marker.raw.json'))).toEqual(f.bytes);
    const receipt = fs.readFileSync(path.join(f.evidence, 'receipt.json')); expect(hash(receipt)).toBe(result.report.receiptSha256);
    expect(JSON.parse(receipt.toString())).toMatchObject({ state: 'quarantined-before-lock-release', poolEvidenceUnchanged: true, quotaRefreshed: false }); untouched(f);
  });
  it.each(['authorization', 'digest', 'relative', 'overlap', 'extra'])('refuses invalid %s before module loading', async kind => {
    const f = fixture(), argv = [...f.argv];
    if (kind === 'authorization') argv.pop(); if (kind === 'digest') argv[7] = 'no'; if (kind === 'relative') argv[3] = 'relative';
    if (kind === 'overlap') argv[5] = f.root; if (kind === 'extra') argv.push('--force');
    const result = await run(f, { argv }); expect(result.exitCode).toBe(1); expect(result.load).not.toHaveBeenCalled(); expect(fs.readFileSync(f.marker)).toEqual(f.bytes);
  });
  it('refuses a stale expected digest without changing the marker', async () => {
    const f = fixture(), argv = [...f.argv]; argv[7] = '0'.repeat(64); expect((await run(f, { argv })).exitCode).toBe(1);
    expect(fs.readFileSync(f.marker)).toEqual(f.bytes); expect(fs.readdirSync(f.evidence)).toEqual([]); untouched(f);
  });
  it.each(['absent', 'unsafe'])('requires healthy active global KILL (%s)', async kind => {
    const f = fixture(); if (kind === 'absent') fs.unlinkSync(f.kill); else fs.chmodSync(f.kill, 0o666);
    expect((await run(f)).exitCode).toBe(1); expect(fs.readFileSync(f.marker)).toEqual(f.bytes); expect(fs.readdirSync(f.evidence)).toEqual([]);
  });
  it.each(['.pool.lock', '.resource-console.lock', '.resource-quota-refresh.lock'])('refuses an existing %s without touching it', async name => {
    const f = fixture(), file = path.join(f.root, name); fs.writeFileSync(file, 'EXISTING_OWNER', { mode: 0o600 });
    expect((await run(f)).exitCode).toBe(1); expect(fs.readFileSync(file, 'utf8')).toBe('EXISTING_OWNER'); expect(fs.readFileSync(f.marker)).toEqual(f.bytes);
  });
  it.each(['symlink', 'hardlink', 'public', 'v2', 'extra', 'oversized'])('refuses unsafe or unsupported marker %s', async kind => {
    const f = fixture();
    if (kind === 'symlink') { fs.renameSync(f.marker, path.join(f.base, 'other')); fs.symlinkSync(path.join(f.base, 'other'), f.marker); }
    if (kind === 'hardlink') fs.linkSync(f.marker, path.join(f.base, 'other')); if (kind === 'public') fs.chmodSync(f.marker, 0o644);
    if (['v2', 'extra', 'oversized'].includes(kind)) { const value = JSON.parse(f.bytes.toString()); if (kind === 'v2') value.schemaVersion = 2;
      if (kind === 'extra') value.secret = true; fs.writeFileSync(f.marker, kind === 'oversized' ? ' '.repeat(513) : JSON.stringify(value)); f.argv[7] = hash(fs.readFileSync(f.marker)); }
    expect((await run(f)).exitCode).toBe(1); expect(fs.readdirSync(f.evidence)).toEqual([]);
  });
  it('refuses partial evidence directories rather than replaying an authorization', async () => {
    const f = fixture(); fs.writeFileSync(path.join(f.evidence, 'intent.json'), 'RETAINED', { mode: 0o600 });
    expect((await run(f)).exitCode).toBe(1); expect(fs.readFileSync(f.marker)).toEqual(f.bytes); expect(fs.readFileSync(path.join(f.evidence, 'intent.json'), 'utf8')).toBe('RETAINED');
  });
  it.each(['symlink', 'large'])('refuses unsafe bounded ledger inventory: %s', async kind => {
    const f = fixture(), file = path.join(f.root, 'unsafe'); if (kind === 'symlink') fs.symlinkSync(f.home, file);
    else { fs.writeFileSync(file, '', { mode: 0o600 }); fs.truncateSync(file, 4 * 1024 * 1024 + 1); }
    expect((await run(f)).exitCode).toBe(1); expect(fs.readFileSync(f.marker)).toEqual(f.bytes);
  });
  it('rejects marker drift after archiving without quarantining changed bytes', async () => {
    const f = fixture(); let altered = false;
    const result = await run(f, { fs: { fsyncSync: fd => { fs.fsyncSync(fd); if (!altered && fs.existsSync(path.join(f.evidence, 'inventory.json'))) {
      altered = true; fs.writeFileSync(f.marker, Buffer.concat([f.bytes, Buffer.from(' ')])); } } } });
    expect(result.exitCode).toBe(1); expect(result.report.markerMoved).toBe(false); expect(fs.existsSync(path.join(f.evidence, 'quarantined-marker.json'))).toBe(false);
  });
  it('retains quarantine and intent on post-rename fsync failure without automatic rollback', async () => {
    const f = fixture(); let moved = false;
    const result = await run(f, { fs: { renameSync: (a, b) => { fs.renameSync(a, b); moved = true; }, fsyncSync: fd => { if (moved) throw Error('PRIVATE_FAILURE'); fs.fsyncSync(fd); } } });
    expect(result.exitCode).toBe(1); expect(result.report.markerMoved).toBe(true); expect(fs.existsSync(f.marker)).toBe(false);
    expect(fs.readFileSync(path.join(f.evidence, 'quarantined-marker.json'))).toEqual(f.bytes); expect(fs.existsSync(path.join(f.evidence, 'receipt.json'))).toBe(false); untouched(f);
  });
  it('reports release uncertainty even after receipt publication', async () => {
    const f = fixture(); const result = await run(f, { locks: { releaseLocalStoreLock: value => { locks.releaseLocalStoreLock(value); return false; } } });
    expect(result.exitCode).toBe(1); expect(result.report).toMatchObject({ state: 'incomplete', stage: 'lock-release', markerMoved: true });
    expect(fs.existsSync(path.join(f.evidence, 'receipt.json'))).toBe(true); untouched(f);
  });
  it('does not acquire ownership once its fixed duration expires', async () => {
    const f = fixture(); let calls = 0; const acquire = vi.fn(locks.acquireLocalStoreLockWithOutcome);
    expect((await run(f, { clock: () => calls++ === 0 ? 0 : 60_001, locks: { acquireLocalStoreLockWithOutcome: acquire } })).exitCode).toBe(1);
    expect(acquire).not.toHaveBeenCalled(); expect(fs.readFileSync(f.marker)).toEqual(f.bytes);
  });
  it('honors a delivered stop during archive before moving the marker', async () => {
    const f = fixture(); const result = await run(f, { atYield: stop => { if (fs.existsSync(path.join(f.evidence, 'inventory.json'))) stop(); } });
    expect(result.exitCode).toBe(1); expect(result.report.markerMoved).toBe(false); expect(fs.readFileSync(f.marker)).toEqual(f.bytes);
  });
  it('rereads exact marker bytes after the final inventory event-loop yield', async () => {
    const f = fixture(); let changed = false, poolReads = 0;
    const result = await run(f, { fs: { openSync: (file, flags, mode) => {
      if (file === path.join(f.root, 'pool-state.json')) poolReads++;
      return fs.openSync(file, flags, mode);
    } }, atYield: () => { if (!changed && poolReads === 2) {
      changed = true; fs.writeFileSync(f.marker, Buffer.concat([f.bytes, Buffer.from(' ')])); } } });
    expect(changed).toBe(true); expect(result.exitCode).toBe(1); expect(result.report.markerMoved).toBe(false);
  });
});
