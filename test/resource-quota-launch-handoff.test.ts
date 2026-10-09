/** Real inert private children only. No native provider, credential or live ledger. */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireResourceQuotaRefreshLease, type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { verifiedProcessStartIdentity } from '../src/core/fleet/local-store-lock.js';
import { readNativeBootIdentity } from '../src/core/resources/native-boot-identity.js';
import { inspectNativeMetadataLaunch, nativeMetadataLaunchSupported, type NativeMetadataLaunchBinding } from '../src/core/run/native-metadata-launch.js';
import { runVerifySubprocessAsync } from '../src/core/run/verify-commands.js';
import type { NativeMetadataLaunchDescriptor } from '../src/core/run/native-metadata-launch.js';
import { withNativeMetadataAdmission } from '../src/core/resources/metadata-coordinator.js';

let root: string, harnessDirectory: string, harnessPath: string;
const leases: ResourceQuotaRefreshLease[] = [];
const parents = new Set<ChildProcess>(); const ownedGroups = new Map<number, string | undefined>();
const rememberGroup = (pid: number) => ownedGroups.set(pid, verifiedProcessStartIdentity(pid, { requiredSource: 'ps-lstart' })?.ref);
const env = () => ({ PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'C', LC_ALL: 'C', VITEST: 'true', ASHLR_DEVIN_AUTO: '0' });
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const activity = () => json(join(root, '.resource-quota-refresh-activity.json'));
async function until<T>(read: () => T | null): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) { const value = read(); if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error('Inert fixture precondition not reached'); await delay(10); }
}
function groupAbsent(pid: number): boolean {
  try { process.kill(-pid, 0); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; return false;
  }
}
async function acquire() {
  const lease = await acquireResourceQuotaRefreshLease(root, { trackNativeActivity: true, trackNativeLaunchHandoff: true });
  leases.push(lease); return lease;
}
function ticket() {
  const entry = activity().reservations[0];
  return { id: entry.id as string, path: join(root, `.resource-quota-launch-${entry.id}.json`) };
}
function binding(): NativeMetadataLaunchBinding {
  const marker = json(join(root, '.resource-quota-refresh-pending.json'));
  const record = activity(), stored = json(ticket().path);
  return { owner: record.ownerIdentity, pending: stored.pending, bootIdentity: marker.bootIdentity };
}
async function owner(stage: 'prepared' | 'spawned' | 'registered' | 'running'): Promise<{ child: ChildProcess; pid: number | null }> {
  const child = spawn(process.execPath, [harnessPath, root, stage], { env: env(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  parents.add(child);
  let diagnostic = ''; child.stderr?.on('data', bytes => { diagnostic = (diagnostic + String(bytes)).slice(-1000); });
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Inert owner did not reach ${stage}: ${diagnostic}`)), 10_000);
    const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
    child.once('error', fail); child.once('exit', () => fail(new Error(`Inert owner exited before ${stage}: ${diagnostic}`)));
    child.on('message', message => {
      if (message && typeof message === 'object' && 'pid' in message && Number.isSafeInteger(message.pid) && Number(message.pid) > 0) rememberGroup(Number(message.pid));
      if (message && typeof message === 'object' && 'stage' in message && message.stage === stage) {
      clearTimeout(timeout); const pid = 'pid' in message ? Number(message.pid) : null;
      if (pid) rememberGroup(pid); resolve({ child, pid });
    } });
  });
}
async function killOwner(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.kill('SIGKILL'); await exited; parents.delete(child);
}

beforeAll(async () => {
  harnessDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'quota-launch-harness-'))); chmodSync(harnessDirectory, 0o700);
  harnessPath = join(harnessDirectory, 'owner.mjs');
  symlinkSync(join(process.cwd(), 'node_modules'), join(harnessDirectory, 'node_modules'), 'dir');
  const entry = `import {spawn} from 'node:child_process';import * as fs from 'node:fs';import {join} from 'node:path';
import {acquireResourceQuotaRefreshLease} from ${JSON.stringify(join(process.cwd(), 'src/core/resources/quota-refresh-lease.ts'))};
import {runVerifySubprocessAsync} from ${JSON.stringify(join(process.cwd(), 'src/core/run/verify-commands.ts'))};
const root=process.argv[2],stage=process.argv[3];process.on('message',()=>{});
const lease=await acquireResourceQuotaRefreshLease(root,{trackNativeActivity:true,trackNativeLaunchHandoff:true});lease.markPending();
const activity=lease.beginNativeActivity();
if(stage==='prepared'){activity.processGroupLifecycle.prepare();process.send({stage});await new Promise(()=>{});}
const target=join(root,'target.mjs');fs.writeFileSync(target,stage==='running'
 ? "import * as fs from 'node:fs';fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);"
 : "import * as fs from 'node:fs';fs.writeFileSync(process.argv[2],'unexpected contact');",{mode:384});
const result=await runVerifySubprocessAsync([process.execPath,target,join(root,'contact')],{cwd:root,env:process.env,timeoutMs:30000,requireProcessGroupExit:true,processGroupLifecycle:activity.processGroupLifecycle,
 _spawn:(file,args,options)=>{if(stage==='spawned')args=['--import',join(root,'gate.mjs'),...args];const child=spawn(file,args,options);process.send({stage:'owned-child',pid:child.pid});
 if(stage==='spawned')process.send({stage,pid:child.pid});
 if(stage==='registered')child.stdio[3].prependListener('data',()=>{process.send({stage,pid:child.pid});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});
 if(stage==='running'){const watcher=fs.watch(root,()=>{if(fs.existsSync(join(root,'contact'))){watcher.close();process.send({stage,pid:child.pid});}});}
 return child;}});process.send({stage:'settled',result});`;
  await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'inert-owner.ts' }, bundle: true,
    platform: 'node', target: 'node22', format: 'esm', packages: 'external', outfile: harnessPath, logLevel: 'silent' });
});
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'quota-launch-'))); chmodSync(root, 0o700); });
afterEach(async () => {
  for (const child of parents) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  parents.clear();
  // These PGIDs came only from this test's own spawn callback. Never discover
  // or signal a group by account name, command string or live product files.
  for (const [pid, ref] of ownedGroups) { if (!groupAbsent(pid)) {
    const current = verifiedProcessStartIdentity(pid, { requiredSource: 'ps-lstart' });
    if (ref && current?.ref === ref) process.kill(-pid, 'SIGKILL');
    await until(() => groupAbsent(pid) ? true : null);
  } }
  ownedGroups.clear();
  for (const lease of leases.splice(0)) { try { lease.close(); } catch { /* Expected held private fixtures. */ } }
  rmSync(root, { recursive: true, force: true });
});
afterAll(() => { rmSync(harnessDirectory, { recursive: true, force: true }); });

describe.skipIf(!nativeMetadataLaunchSupported())('durable exec-in-place collector handoff', () => {
  it('refuses a Bun interpreter claim even when the host exposes execve', () => {
    const before = Object.getOwnPropertyDescriptor(process.versions, 'bun');
    Object.defineProperty(process.versions, 'bun', { value: 'inert-runtime-fixture', configurable: true });
    try { expect(nativeMetadataLaunchSupported()).toBe(false); }
    finally { if (before) Object.defineProperty(process.versions, 'bun', before); else Reflect.deleteProperty(process.versions, 'bun'); }
  });
  it('preserves ordinary argv, stdin and PID with one child, then retires its private ticket', async () => {
    const lease = await acquire(); lease.markPending(); const handle = lease.beginNativeActivity();
    expect(json(join(root, '.resource-quota-refresh-pending.json')).schemaVersion).toBe(5);
    let launchedPid: number | undefined; let launches = 0;
    const result = await runVerifySubprocessAsync([realpathSync(process.execPath), '-e',
      "let v='';process.stdin.on('data',b=>v+=b);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({pid:process.pid,value:v,arg:process.argv[1]})));", 'fixture-argument'],
    { cwd: root, env: env(), input: 'inert input', timeoutMs: 10_000, requireProcessGroupExit: true, processGroupLifecycle: handle.processGroupLifecycle, _spawn: (file, args, options) => {
      const child = spawn(file, args, options); launchedPid = child.pid; launches++; if (child.pid) rememberGroup(child.pid); return child;
    } });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed' });
    expect(result.error).toBeUndefined(); expect(JSON.parse(result.stdout)).toMatchObject({ pid: launchedPid, value: 'inert input', arg: 'fixture-argument' }); expect(launches).toBe(1);
    expect(activity().reservations[0]).toMatchObject({ phase: 'ready', pgid: null, launchId: null }); handle.settle(); lease.close();
  });

  it('refuses account drift after child publication before go without invoking the target', async () => {
    const lease = await acquire(); lease.markPending(); const handle = lease.beginNativeActivity(); let current = true; let pid = 0;
    const processGroupLifecycle = withNativeMetadataAdmission(handle.processGroupLifecycle, () => { if (!current) throw new Error('Changed account'); });
    const result = await runVerifySubprocessAsync([realpathSync(process.execPath), '-e', "require('node:fs').writeFileSync(process.argv[1],'contact')", join(root, 'contact')],
      { cwd: root, env: env(), timeoutMs: 10_000, requireProcessGroupExit: true, processGroupLifecycle, _spawn: (file, args, options) => {
        const child = spawn(file, args, options); pid = child.pid!; rememberGroup(pid);
        (child.stdio[3] as import('node:stream').Duplex).prependListener('data', () => { current = false; }); return child;
      } });
    expect(result.error).toBe('process-group lifecycle publication failed'); expect(result.processGroupSettlement).toBe('unconfirmed');
    expect(existsSync(join(root, 'contact'))).toBe(false); await until(() => groupAbsent(pid) ? true : null);
    expect(activity().reservations[0]).toMatchObject({ phase: 'preparing', pgid: null });
    // The group is now absent, but failed owner publication still poisons this
    // invocation. Recovery never turns changed admission into provider contact.
    expect(existsSync(join(root, '.resource-quota-refresh-pending.json'))).toBe(true);
  });

  it('settles owned cancellation after exec without discarding the group fence', async () => {
    const lease = await acquire(); lease.markPending(); const handle = lease.beginNativeActivity(); const controller = new AbortController(); let pid = 0;
    const work = runVerifySubprocessAsync([realpathSync(process.execPath), '-e', "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", join(root, 'contact')],
      { cwd: root, env: env(), timeoutMs: 10_000, terminationGraceMs: 250, signal: controller.signal, requireProcessGroupExit: true, processGroupLifecycle: handle.processGroupLifecycle,
        _spawn: (file, args, options) => { const child = spawn(file, args, options); pid = child.pid!; rememberGroup(pid); return child; } });
    await until(() => existsSync(join(root, 'contact')) ? true : null); expect(Number(readFileSync(join(root, 'contact'), 'utf8'))).toBe(pid);
    controller.abort(); const result = await work;
    expect(result, JSON.stringify(result)).toMatchObject({ cancelled: true, timedOut: false, processGroupSettlement: 'group-exit-confirmed' });
    expect(groupAbsent(pid)).toBe(true); expect(activity().reservations[0]).toMatchObject({ phase: 'ready', pgid: null, launchId: null });
    handle.settle(); lease.close();
  });

  it('does not prepare or launch for an already cancelled invocation', async () => {
    const lease = await acquire(); lease.markPending(); const handle = lease.beginNativeActivity(); const controller = new AbortController(); controller.abort();
    let spawned = false;
    const result = await runVerifySubprocessAsync([realpathSync(process.execPath), '-e', "throw Error('must not run')"],
      { cwd: root, env: env(), timeoutMs: 10_000, signal: controller.signal, requireProcessGroupExit: true, processGroupLifecycle: handle.processGroupLifecycle,
        _spawn: () => { spawned = true; throw new Error('Unexpected spawn'); } });
    expect(result).toMatchObject({ cancelled: true, processGroupSettlement: 'not-started' }); expect(spawned).toBe(false);
    expect(activity().reservations[0]).toMatchObject({ phase: 'ready', pgid: null, launchId: null }); handle.settle(); lease.close();
  });

  it('renews one-use tickets for sequential metadata commands without changing their stdin or argv', async () => {
    const lease = await acquire(); lease.markPending(); const handle = lease.beginNativeActivity(); const digests: string[] = [];
    const processGroupLifecycle = { prepare() { const prepared = handle.processGroupLifecycle.prepare(); digests.push(prepared.launcher!.ticketDigest); return prepared; } };
    for (const value of ['first', 'second', 'third']) {
      const result = await runVerifySubprocessAsync([realpathSync(process.execPath), '-e', "let v='';process.stdin.on('data',b=>v+=b);process.stdin.on('end',()=>process.stdout.write(process.argv[1]+':'+v));", value],
        { cwd: root, env: env(), input: value, timeoutMs: 10_000, requireProcessGroupExit: true, processGroupLifecycle });
      expect(result).toMatchObject({ exitCode: 0, stdout: value + ':' + value, processGroupSettlement: 'group-exit-confirmed' });
      expect(result.error).toBeUndefined();
    }
    expect(new Set(digests).size).toBe(3); expect(activity().reservations[0]).toMatchObject({ phase: 'ready', launchId: null }); handle.settle(); lease.close();
  });

  it('refuses a replayed retired ticket without a second target contact', async () => {
    const lease = await acquire(); lease.markPending(); const handle = lease.beginNativeActivity(); let saved!: NativeMetadataLaunchDescriptor;
    const first = await runVerifySubprocessAsync([realpathSync(process.execPath), '-e', "process.stdout.write('first')"],
      { cwd: root, env: env(), timeoutMs: 10_000, requireProcessGroupExit: true, processGroupLifecycle: { prepare() {
        const prepared = handle.processGroupLifecycle.prepare(); saved = prepared.launcher!; return prepared;
      } } });
    expect(first).toMatchObject({ stdout: 'first', exitCode: 0, processGroupSettlement: 'group-exit-confirmed' });
    let registrationAttempted = false;
    const second = await runVerifySubprocessAsync([realpathSync(process.execPath), '-e', "require('node:fs').writeFileSync(process.argv[1],'second')", join(root, 'contact')],
      { cwd: root, env: env(), timeoutMs: 10_000, requireProcessGroupExit: true, processGroupLifecycle: { prepare: () => ({ launcher: saved,
        spawned() { registrationAttempted = true; }, settled() { throw new Error('Missing replay evidence'); } }) } });
    expect(second).toMatchObject({ exitCode: 1, processGroupSettlement: 'unconfirmed' });
    expect(registrationAttempted).toBe(false); expect(existsSync(join(root, 'contact'))).toBe(false); handle.settle(); lease.close();
  });

  it('keeps exactly two distinct launch reservations and refuses a third before any target', async () => {
    const lease = await acquire(); lease.markPending(); const first = lease.beginNativeActivity(), second = lease.beginNativeActivity();
    const a = first.processGroupLifecycle.prepare(), b = second.processGroupLifecycle.prepare();
    expect(a.launcher!.ticketPath).not.toBe(b.launcher!.ticketPath); expect(a.launcher!.ticketDigest).not.toBe(b.launcher!.ticketDigest);
    expect(() => lease.beginNativeActivity()).toThrow(); expect(activity().reservations).toHaveLength(2);
    expect(activity().reservations.every((row: { phase: string }) => row.phase === 'preparing')).toBe(true);
    expect(existsSync(join(root, 'contact'))).toBe(false);
  });

  it('refuses changed activity after the parent registration callback and before exec', async () => {
    const lease = await acquire(); lease.markPending(); const handle = lease.beginNativeActivity();
    const result = await runVerifySubprocessAsync([realpathSync(process.execPath), '-e', "require('node:fs').writeFileSync(process.argv[1],'contact')", join(root, 'contact')],
      { cwd: root, env: env(), timeoutMs: 10_000, requireProcessGroupExit: true, processGroupLifecycle: { prepare() {
        const prepared = handle.processGroupLifecycle.prepare(); return { ...prepared, spawned(pgid: number) {
          prepared.spawned(pgid); const value = activity(); value.reservations[0].phase = 'ready'; value.reservations[0].pgid = null;
          writeFileSync(join(root, '.resource-quota-refresh-activity.json'), JSON.stringify(value) + '\n');
        } };
      } } });
    expect(result.exitCode).toBe(126); expect(result.processGroupSettlement).toBe('unconfirmed');
    expect(existsSync(join(root, 'contact'))).toBe(false); expect(existsSync(join(root, '.resource-quota-refresh-pending.json'))).toBe(true);
  });

  it('does not invent a child after owner death at preparation and preserves the unknown fence', async () => {
    const { child } = await owner('prepared'), before = readFileSync(join(root, '.resource-quota-refresh-pending.json'), 'utf8');
    await killOwner(child);
    await expect(acquire()).rejects.toMatchObject({ code: 'reconciliation-required', recovery: { reasonCode: 'command-registration-incomplete', markerVersion: 5 } });
    expect(readFileSync(join(root, '.resource-quota-refresh-pending.json'), 'utf8')).toBe(before); expect(existsSync(join(root, 'contact'))).toBe(false);
  });

  it('publishes child identity independently when the owner dies after spawn but before registration', async () => {
    writeFileSync(join(root, 'gate.mjs'), "import * as fs from 'node:fs';import {dirname} from 'node:path';const root=dirname(process.argv[2]);await new Promise(resolve=>{const watcher=fs.watch(root,()=>{if(fs.existsSync(root+'/open-gate')){watcher.close();resolve();}});if(fs.existsSync(root+'/open-gate')){watcher.close();resolve();}});", { mode: 0o600 });
    const { child, pid } = await owner('spawned'); expect(pid).toBeGreaterThan(0);
    expect(existsSync(`${ticket().path}.registered`)).toBe(false); await killOwner(child);
    writeFileSync(join(root, 'open-gate'), 'open', { mode: 0o600 });
    await until(() => existsSync(`${ticket().path}.not-started`) ? true : null); await until(() => groupAbsent(pid!) ? true : null);
    const identity = inspectNativeMetadataLaunch(root, ticket().id, binding()); expect(identity).toMatchObject({ pid, pgid: pid, startRefSource: 'ps-lstart' });
    expect(existsSync(join(root, 'contact'))).toBe(false);
    const next = await acquire(); expect(existsSync(join(root, '.resource-quota-refresh-pending.json'))).toBe(false);
    const receipt = json(join(root, '.resource-quota-refresh-recovery.json'));
    expect(receipt).toMatchObject({ reason: 'same-boot-verified-groups-absent-dead-owner', launches: [{ id: ticket().id, ticketDigest: identity.ticketDigest, registrationDigest: identity.registrationDigest }] });
    expect(lstatSync(join(root, '.resource-quota-refresh-recovery.json')).size).toBeLessThanOrEqual(2048); next.close();
  });

  it('recovers child registration even when the parent never runs its registration callback', async () => {
    const { child, pid } = await owner('registered');
    expect(activity().reservations[0]).toMatchObject({ phase: 'preparing', pgid: null });
    await killOwner(child); await until(() => existsSync(`${ticket().path}.not-started`) ? true : null); await until(() => groupAbsent(pid!) ? true : null);
    expect(existsSync(join(root, 'contact'))).toBe(false); const next = await acquire(); next.close();
  });
  it('retains the hold when the launcher dies before publishing its own identity', async () => {
    writeFileSync(join(root, 'gate.mjs'), "await new Promise(()=>{});", { mode: 0o600 });
    const { child, pid } = await owner('spawned');
    expect(verifiedProcessStartIdentity(pid!, { requiredSource: 'ps-lstart' })?.ref).toBe(ownedGroups.get(pid!));
    process.kill(-pid!, 'SIGKILL'); await until(() => groupAbsent(pid!) ? true : null); ownedGroups.delete(pid!);
    await killOwner(child);
    expect(existsSync(`${ticket().path}.registered`)).toBe(false);
    await expect(acquire()).rejects.toMatchObject({ recovery: { reasonCode: 'command-registration-incomplete', markerVersion: 5 } });
    expect(existsSync(join(root, 'contact'))).toBe(false); expect(existsSync(join(root, '.resource-quota-refresh-pending.json'))).toBe(true);
  });

  it('keeps a held fence after parent death while the exec-in-place inert group remains present', async () => {
    const { child, pid } = await owner('running'); expect(Number(readFileSync(join(root, 'contact'), 'utf8'))).toBe(pid);
    await killOwner(child);
    await expect(acquire()).rejects.toMatchObject({ recovery: { reasonCode: 'process-group-not-confirmed-absent', markerVersion: 5 } });
    process.kill(-pid!, 'SIGKILL'); ownedGroups.delete(pid!); await until(() => groupAbsent(pid!) ? true : null);
    const next = await acquire(); next.close();
  });

  it.each(['ticket', 'registration', 'launcher', 'receipt', 'permissions'] as const)('refuses %s evidence drift before same-boot recovery', async kind => {
    const { child, pid } = await owner('registered'); await killOwner(child);
    await until(() => existsSync(`${ticket().path}.not-started`) ? true : null); await until(() => groupAbsent(pid!) ? true : null);
    const p = ticket().path;
    if (kind === 'ticket') { const value = json(p); value.owner.token = '00000000-1111-2222-3333-444444444444'; writeFileSync(p, JSON.stringify(value)); }
    if (kind === 'registration') { const value = json(`${p}.registered`); value.ticketDigest = 'b'.repeat(64); writeFileSync(`${p}.registered`, JSON.stringify(value)); }
    if (kind === 'launcher') writeFileSync(`${p}.mjs`, 'tampered');
    if (kind === 'receipt') writeFileSync(`${p}.not-started`, '{}');
    if (kind === 'permissions') chmodSync(`${p}.registered`, 0o644);
    await expect(acquire()).rejects.toMatchObject({ recovery: { reasonCode: 'command-registration-incomplete' } });
    expect(existsSync(join(root, '.resource-quota-refresh-pending.json'))).toBe(true); expect(existsSync(join(root, 'contact'))).toBe(false);
  });

  it('uses actual immutable boot evidence rather than a elapsed-time recovery assumption', () => {
    const boot = readNativeBootIdentity(); expect(boot?.bootId).toMatch(/^[a-f0-9-]{36}$/); expect(boot?.machineDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
