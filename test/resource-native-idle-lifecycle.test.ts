/** Owned inert child processes and private fixtures only; no native accounts or providers. */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function exitedOwner(mode: 'initial-idle' | 'settled' | 'preparing' | 'registered-exited' | 'ready'): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-owned-idle-'))); roots.push(root);
  const leaseModule = new URL('../dist/core/resources/quota-refresh-lease.js', import.meta.url).href;
  const runnerModule = new URL('../dist/core/run/verify-commands.js', import.meta.url).href;
  const script = `
    const {acquireResourceQuotaRefreshLease}=await import(${JSON.stringify(leaseModule)});
    const {runVerifySubprocessAsync}=await import(${JSON.stringify(runnerModule)});
    const lease=await acquireResourceQuotaRefreshLease(${JSON.stringify(root)},{trackNativeActivity:true});
    lease.markPending();
    if (${JSON.stringify(mode)} !== 'initial-idle') {
      const activity=lease.beginNativeActivity();
      const processGroupLifecycle=${JSON.stringify(mode)} === 'registered-exited' ? {
        prepare() {
          const command=activity.processGroupLifecycle.prepare();
          // Crash-window fixture: preserve the durable registered phase after OS exit.
          return {spawned: (pgid)=>command.spawned(pgid), settled: ()=>{}};
        }
      } : activity.processGroupLifecycle;
      const result=await runVerifySubprocessAsync([process.execPath,'-e','process.stdout.write("owned-fixture")'],
        {cwd:${JSON.stringify(root)},timeoutMs:5000,requireProcessGroupExit:true,processGroupLifecycle});
      if(result.processGroupSettlement!=='group-exit-confirmed'||result.exitCode!==0) process.exit(7);
      if (${JSON.stringify(mode)} === 'settled') activity.settle();
      if (${JSON.stringify(mode)} === 'preparing') activity.processGroupLifecycle.prepare();
    }
    // Deliberately skip lease.close(): reproduce an exited owner with durable records.
    process.exit(0);
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, stdio: 'ignore', timeout: 15_000, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
    });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Owned fixture exited ${code}`)));
  });
  return root;
}

describe.skipIf(process.platform !== 'darwin')('native owned-process idle recovery', () => {
  it.each(['initial-idle', 'settled', 'ready', 'registered-exited'] as const)('recovers %s records after actual owner exit', async (mode) => {
    const root = await exitedOwner(mode);
    const marker = JSON.parse(readFileSync(join(root, '.resource-quota-refresh-pending.json'), 'utf8'));
    expect(marker.schemaVersion).toBe(4);
    const lease = await acquireResourceQuotaRefreshLease(root, { trackNativeActivity: true });
    try {
      const receipt = JSON.parse(readFileSync(join(root, '.resource-quota-refresh-recovery.json'), 'utf8'));
      expect(receipt.reason).toBe(mode === 'registered-exited'
        ? 'same-boot-verified-groups-absent-dead-owner' : 'same-boot-verified-idle-dead-owner');
      lease.markPending(); const activity = lease.beginNativeActivity(); activity.settle();
    } finally { lease.close(); }
  });

  it('retains a preparing reservation even when the actual owner and prior inert subprocess exited', async () => {
    const root = await exitedOwner('preparing');
    const path = join(root, '.resource-quota-refresh-pending.json'); const bytes = readFileSync(path);
    await expect(acquireResourceQuotaRefreshLease(root, { trackNativeActivity: true }))
      .rejects.toMatchObject({ code: 'reconciliation-required', safeReadOnlyFallback: true });
    expect(readFileSync(path)).toEqual(bytes);
  });
});
