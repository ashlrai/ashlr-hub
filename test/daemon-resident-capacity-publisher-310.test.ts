/**
 * 3.10 c8 follow-up — runDaemon owns the daemon-side capacity publisher's
 * lifetime: it starts it for a resident standing run (not only lazily from
 * the first standing merge pass) and stops it when the run ends, so no
 * publisher interval or mid-sample collector outlives the daemon in-process.
 *
 * Pure: the publisher module is injected, nothing spawns, no HOME is read.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';
import {
  residentCapacityPublisherWanted,
  startResidentCapacityPublisher,
  stopResidentCapacityPublisher,
  type ResidentCapacityPublisherModule,
} from '../src/core/daemon/loop.js';
import { daemonCapacityPublisherRefusal } from '../src/core/daemon/capacity-publisher.js';

const cfg = { version: 1 } as unknown as AshlrConfig;

function fakeModule(): ResidentCapacityPublisherModule & { ensure: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> } {
  const ensure = vi.fn(() => ({ state: 'idle' }));
  const reset = vi.fn();
  return { ensure, reset, ensureDaemonCapacityPublisher: ensure, resetDaemonCapacityPublisherForTest: reset };
}

describe('resident capacity publisher lifetime', () => {
  it('is wanted only for a resident, non-dry run under a standing session', () => {
    expect(residentCapacityPublisherWanted({ dryRun: false, once: false, standing: true })).toBe(true);
    expect(residentCapacityPublisherWanted({ dryRun: true, once: false, standing: true })).toBe(false);
    expect(residentCapacityPublisherWanted({ dryRun: false, once: true, standing: true })).toBe(false);
    expect(residentCapacityPublisherWanted({ dryRun: false, once: false, standing: false })).toBe(false);
  });

  it('starts the publisher with the run config when wanted, and not otherwise', async () => {
    const mod = fakeModule();
    await expect(startResidentCapacityPublisher(cfg, { dryRun: false, once: false, standing: true }, async () => mod)).resolves.toBe(true);
    expect(mod.ensure).toHaveBeenCalledTimes(1);
    expect(mod.ensure).toHaveBeenCalledWith(cfg);

    const other = fakeModule();
    await expect(startResidentCapacityPublisher(cfg, { dryRun: true, once: false, standing: true }, async () => other)).resolves.toBe(false);
    await expect(startResidentCapacityPublisher(cfg, { dryRun: false, once: false, standing: false }, async () => other)).resolves.toBe(false);
    expect(other.ensure).not.toHaveBeenCalled();
  });

  it('never throws out of daemon start or stop', async () => {
    const broken = async (): Promise<ResidentCapacityPublisherModule> => { throw new Error('module failed to load'); };
    await expect(startResidentCapacityPublisher(cfg, { dryRun: false, once: false, standing: true }, broken)).resolves.toBe(false);
    await expect(stopResidentCapacityPublisher(broken)).resolves.toBeUndefined();
    const throwing = fakeModule();
    throwing.ensure.mockImplementation(() => { throw new Error('boom'); });
    await expect(startResidentCapacityPublisher(cfg, { dryRun: false, once: false, standing: true }, async () => throwing)).resolves.toBe(false);
  });

  it('stop stops and forgets the process publisher', async () => {
    const mod = fakeModule();
    await stopResidentCapacityPublisher(async () => mod);
    expect(mod.reset).toHaveBeenCalledTimes(1);
  });

  it('the real publisher still refuses to start in a test process (no probes from vitest)', () => {
    expect(daemonCapacityPublisherRefusal({ ASHLR_IN_DAEMON: '1', VITEST: 'true' })).toBe('test process');
  });

  it('runDaemon starts it before the first tick and stops it before the post-tick children drain', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/core/daemon/loop.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function runDaemonInEnrollmentScope('));
    const start = body.indexOf('await startResidentCapacityPublisher(activationCfg, residentPublisherRun)');
    const firstTick = body.indexOf('await tick(');
    const stop = body.indexOf('await stopResidentCapacityPublisher()');
    const drain = body.indexOf('await cancelDaemonPostTickChildren(');
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(firstTick);
    expect(stop).toBeGreaterThan(firstTick);
    expect(stop).toBeLessThan(drain);
    // The stop is not limited to runs the start covered: a one-shot run's
    // pass-started publisher is stopped too.
    expect(body.slice(stop - 80, stop)).toContain('if (!opts.dryRun && standing !== null)');
  });
});
