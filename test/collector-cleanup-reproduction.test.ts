/** Local inert descendants only. This proves a cleanup mechanism, not the live account failure's cause. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runVerifySubprocessAsync, type VerifyProcessGroupLifecycle } from '../src/core/run/verify-commands.js';
import { probeCodexResourceAccount } from '../src/core/resources/codex-account-probe.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';

let root: string;
const groups: number[] = [];
const absent = (pgid: number): boolean => {
  try { process.kill(-pgid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
};
async function awaitAbsence() {
  const deadline = performance.now() + 10_000;
  while (groups.some(pgid => !absent(pgid)) && performance.now() < deadline) await delay(25);
  return groups.every(absent);
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'collector-cleanup-repro-')));
  mkdirSync(join(root, 'home'), { mode: 0o700 }); vi.stubEnv('HOME', join(root, 'home')); groups.length = 0;
});
afterEach(async () => {
  // Never signal a recycled leader/group. Every inert descendant expires itself.
  // Keep evidence if even this independent, non-mutating absence check fails.
  const safe = await awaitAbsence(); vi.unstubAllEnvs();
  if (!safe) { console.warn(`Collector cleanup fixture retained: ${root}`); return; }
  rmSync(root, { recursive: true, force: true });
});
function lifecycle() {
  const settled = vi.fn<(receipt: 'not-started' | 'group-exit-confirmed') => void>();
  const hooks: VerifyProcessGroupLifecycle = { prepare: () => ({ spawned(pgid) { groups.push(pgid); }, settled }) };
  return { hooks, settled };
}
const linger = (duration: number) => `const child = require('node:child_process').spawn(process.execPath,
 ['-e','setTimeout(()=>{},${duration})'], {stdio:'ignore',detached:false}); child.unref();`;
const lingering = linger(1500);

describe.skipIf(process.platform === 'win32')('normal-close collector group reproduction', () => {
  it('normal leader close precedes its inherited inert descendant and gets no false settlement receipt', async () => {
    const activity = lifecycle();
    const result = await runVerifySubprocessAsync([process.execPath, '-e', `${lingering}process.stdout.write('normal-close');`], {
      cwd: root, env: { HOME: join(root, 'home'), PATH: '/usr/bin:/bin' }, timeoutMs: 5000, maxOutputChars: 1024,
      requireProcessGroupExit: true, processGroupLifecycle: activity.hooks,
    });
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe('normal-close');
    expect(result.timedOut).toBe(false); expect(result.cancelled).toBe(false);
    expect(result.processGroupSettlement).toBe('unconfirmed'); expect(result.error).toBe('required process-group exit receipt unconfirmed');
    expect(activity.settled).not.toHaveBeenCalled(); expect(groups).toHaveLength(1);
    expect(absent(groups[0]!)).toBe(false);
    expect(await awaitAbsence()).toBe(true);
    // Later kernel absence does not rewrite the earlier returned receipt.
    expect(result.processGroupSettlement).toBe('unconfirmed'); expect(activity.settled).not.toHaveBeenCalled();
  });

  it.each([0, 350, 1500])('actual metadata helper with descendant lifetime=%sms', async duration => {
    const native = join(root, 'inert-protocol.cjs');
    const ready = join(root, 'descendant-ready'); const release = join(root, 'descendant-release');
    // For the short positive case, exclude OS/Node startup from the claimed
    // remaining lifetime: initialize waits for readiness; EOF starts the timer.
    // The fixed self-expiry also prevents a broken handshake leaving a child.
    const waitingChild = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');
const deadline=Date.now()+5000;const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){
clearInterval(poll);setTimeout(()=>{},350);}else if(Date.now()>=deadline)clearInterval(poll);},5);`;
    writeFileSync(native, `
const readline = require('node:readline');
const fs = require('node:fs');
${duration === 350 ? `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(waitingChild)}],{stdio:'ignore',detached:false}).unref();` : ''}
const lines = readline.createInterface({ input:process.stdin });
const account = {requiresOpenaiAuth:true,account:{type:'chatgpt',email:'fixture@example.invalid',planType:'pro'}};
lines.on('line', async line => {
 const request=JSON.parse(line); if(request.method==='initialized')return;
 ${duration === 350 ? `const until=Date.now()+3000;while(!fs.existsSync(${JSON.stringify(ready)})){if(Date.now()>=until)throw Error('fixture readiness timeout');await new Promise(resolve=>setTimeout(resolve,5));}` : ''}
 const result=request.id===1 ? {codexHome:'/unused-fixture',userAgent:'inert/fixture',platformFamily:'unix',platformOs:'macos'} :
 request.id===3 ? {rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:2000000000},secondary:null,rateLimitReachedType:null}}} : account;
 process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
lines.on('close',()=>{${duration === 350 ? `fs.writeFileSync(${JSON.stringify(release)},'release');` : duration ? linger(duration) : ''}});
`, { mode: 0o600 });
    const pool: ResourcePool = { schemaVersion: 1, id: 'fixture', workers: [{ id: 'codex-fixture', provider: 'codex', model: 'fixture-model',
      maxConcurrent: 1, reservePercent: 10, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1 }] };
    const activity = lifecycle();
    const result = await probeCodexResourceAccount({ pool, bindings: [{ workerId: 'codex-fixture', capacityKey: 'fixture-account',
      kind: 'native-cli', command: [process.execPath, native] }], workerId: 'codex-fixture', cwd: root,
      bucketIds: ['codex'], timeoutMs: 5000, processGroupLifecycle: activity.hooks });
    expect(groups).toHaveLength(1);
    if (duration > 1000) {
      expect(result).toMatchObject({ status: 'uncertain', reason: 'probe-termination-uncertain', observation: null });
      expect(activity.settled).not.toHaveBeenCalled(); expect(absent(groups[0]!)).toBe(false);
    } else {
      expect(result, JSON.stringify(result.cleanupDiagnostics ?? {})).toMatchObject({ status: 'observed', reason: 'probe-observed' });
      expect(activity.settled).toHaveBeenCalledExactlyOnceWith('group-exit-confirmed');
    }
    expect(await awaitAbsence()).toBe(true);
    expect(activity.settled).toHaveBeenCalledTimes(duration > 1000 ? 0 : 1);
  });
});
