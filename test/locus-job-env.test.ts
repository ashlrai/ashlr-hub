import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInLocusJobEnv, getLocusJobEnv, hasInheritedLocusSession, hasLocusJobEnv, assertLocusJobDispatch, withLocusJobChildEnv } from '../src/core/integrations/locus-job-env.js';
import { withToolEnv } from '../src/core/env-bridge.js';
import { spawnEngine } from '../src/core/run/engines.js';
import { runApiModelSandboxed } from '../src/core/run/sandboxed-engine.js';
import type { AshlrConfig } from '../src/core/types.js';

const config = { models: { providerChain: [], ollama: '' }, roots: [], phantom: { enabled: false } } as unknown as AshlrConfig;
function env(id: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: `/synthetic/job-${id}`, LOCUS_HOME: `/synthetic/locus-${id}`,
    LOCUS_ENFORCE: 'off', LOCUS_SESSION_ID: id, LOCUS_BINDING: `binding-${id}`,
    LOCUS_EXECUTOR_CAPABILITY: id.repeat(64).slice(0, 64), LOCUS_CONTROL_CAPABILITY: 'control-do-not-delegate' };
}
function childIdentity(childEnv?: NodeJS.ProcessEnv): unknown {
  return JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify({home:process.env.HOME,session:process.env.LOCUS_SESSION_ID,executor:process.env.LOCUS_EXECUTOR_CAPABILITY,control:process.env.LOCUS_CONTROL_CAPABILITY,config:process.env.ASHLR_CONFIG,genome:process.env.ASHLR_GENOME_DIR}))'], { env: childEnv, encoding: 'utf8' }));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('private Locus job environments', () => {
  it('an actual child inheriting delegated markers refuses shared gateway startup without ALS', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'locus-inherited-gateway-')));
    const gatewayUrl = new URL('../src/core/mcp-gateway.ts', import.meta.url).href;
    const code = `const {startGateway}=await import(${JSON.stringify(gatewayUrl)});try{await startGateway({servers:[]});throw Error('gateway started');}catch(error){if(!error.message.includes('delegated Locus job'))throw error;console.log(JSON.stringify({refused:true}));}`;
    try {
      const stdout = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
        env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, ASHLR_HOME: join(home, 'ashlr'),
          XDG_CONFIG_HOME: join(home, 'config'), LOCUS_SESSION_ID: 'ses_synthetic',
          LOCUS_EXECUTOR_CAPABILITY: 'a'.repeat(64), ASHLR_NO_HEAL: '1' },
        encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024,
      });
      expect(JSON.parse(stdout)).toEqual({ refused: true });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.each([
    ['LOCUS_SESSION_ID', 'synthetic-unverified-session'],
    ['LOCUS_SESSION_ID', ''],
    ['LOCUS_EXECUTOR_CAPABILITY', 'synthetic-unverified-executor'],
    ['LOCUS_EXECUTOR_CAPABILITY', ''],
  ])('refuses uncaptured inherited %s even when malformed or incomplete', (key, value) => {
    vi.stubEnv(key, value);
    try {
      expect(hasLocusJobEnv()).toBe(false);
      expect(hasInheritedLocusSession()).toBe(true);
      expect(() => assertLocusJobDispatch()).toThrow('requires live verification');
      expect(() => withLocusJobChildEnv()).toThrow('requires live verification');
    } finally { vi.unstubAllEnvs(); }
  });

  it('captures an immutable copy and strips control authority', async () => {
    const original = env('a');
    await runInLocusJobEnv(original, async () => {
      original.HOME = 'changed';
      expect(Object.isFrozen(getLocusJobEnv())).toBe(true);
      expect(getLocusJobEnv().HOME).toBe('/synthetic/job-a');
      expect(getLocusJobEnv().LOCUS_CONTROL_CAPABILITY).toBeUndefined();
      expect(withLocusJobChildEnv().LOCUS_EXECUTOR_CAPABILITY).toBe('a'.repeat(64));
    });
  });

  it('interleaves A/B jobs and real children without changing unrelated spawn or process.env', async () => {
    const before = { ...process.env };
    const aStarted = deferred();
    const bStarted = deferred();
    const release = deferred();
    const a = runInLocusJobEnv(env('a'), async () => {
      aStarted.resolve();
      await release.promise;
      return childIdentity(withToolEnv(config));
    });
    await aStarted.promise;
    const b = runInLocusJobEnv(env('b'), async () => {
      bStarted.resolve();
      await release.promise;
      return childIdentity(withToolEnv(config));
    });
    await bStarted.promise;
    const unrelated = childIdentity();
    expect(process.env).toEqual(before);
    expect(unrelated).toEqual({ home: before.HOME, session: before.LOCUS_SESSION_ID,
      executor: before.LOCUS_EXECUTOR_CAPABILITY, control: before.LOCUS_CONTROL_CAPABILITY,
      config: before.ASHLR_CONFIG, genome: before.ASHLR_GENOME_DIR });
    release.resolve();
    expect(await a).toEqual({ home: '/synthetic/job-a', session: 'a', executor: 'a'.repeat(64) });
    expect(await b).toEqual({ home: '/synthetic/job-b', session: 'b', executor: 'b'.repeat(64) });
    expect(process.env).toEqual(before);
  });

  it('nested contexts return to their parent without waiting or deadlock', async () => {
    const ambient = getLocusJobEnv();
    await runInLocusJobEnv(env('a'), async () => {
      await runInLocusJobEnv(env('b'), async () => {
        expect(getLocusJobEnv().LOCUS_SESSION_ID).toBe('b');
        await Promise.resolve();
      });
      expect(getLocusJobEnv().LOCUS_SESSION_ID).toBe('a');
      expect(withLocusJobChildEnv().HOME).toBe('/synthetic/job-a');
    });
    expect(getLocusJobEnv()).toBe(ambient);
  });

  it('restores the parent after a nested callback fails', async () => {
    await runInLocusJobEnv(env('a'), async () => {
      await expect(runInLocusJobEnv(env('b'), () => { throw new Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
      expect(getLocusJobEnv().LOCUS_SESSION_ID).toBe('a');
    });
  });

  it.each(['HOME', 'LOCUS_HOME', 'LOCUS_SESSION_ID', 'LOCUS_BINDING', 'LOCUS_EXECUTOR_CAPABILITY', 'AWS_ACCOUNT_ID'])('fails closed for a child override of %s', async (key) => {
    await runInLocusJobEnv(env('a'), () => {
      expect(() => withLocusJobChildEnv({ [key]: 'another-identity' })).toThrow('identity override refused');
    });
  });

  it('scrubs uncaptured credentials while preserving explicit contained runtime settings', async () => {
    await runInLocusJobEnv(env('a'), () => {
      const child = withLocusJobChildEnv({ ANTHROPIC_API_KEY: 'ambient-do-not-copy',
        GITHUB_TOKEN: 'ambient-do-not-copy', ASHLR_HOOK_MODE: 'nudge', GIT_TERMINAL_PROMPT: '0',
        LOCUS_CONTROL_CAPABILITY: 'another-control' });
      expect(child.ANTHROPIC_API_KEY).toBeUndefined();
      expect(child.GITHUB_TOKEN).toBeUndefined();
      expect(child.ASHLR_HOOK_MODE).toBe('nudge');
      expect(child.GIT_TERMINAL_PROMPT).toBe('0');
      expect(child.LOCUS_CONTROL_CAPABILITY).toBeUndefined();
    });
  });

  it('revalidates at actual engine dispatch after a queued session expires', async () => {
    let valid = true;
    let validations = 0;
    await runInLocusJobEnv(env('a'), async () => {
      await Promise.resolve();
      valid = false;
      await expect(spawnEngine({ bin: process.execPath, args: ['-e', 'throw Error("must never spawn")'] }, config)).resolves.toMatchObject({ ok: false, error: 'synthetic expired session' });
    }, () => { validations++; if (!valid) throw new Error('synthetic expired session'); });
    expect(validations).toBe(2);
  });

  it('passes the private snapshot into the actual central engine child path', async () => {
    await runInLocusJobEnv(env('a'), async () => {
      const result = await spawnEngine({ bin: process.execPath, args: ['-e', 'console.log(JSON.stringify({home:process.env.HOME,session:process.env.LOCUS_SESSION_ID,executor:process.env.LOCUS_EXECUTOR_CAPABILITY,control:process.env.LOCUS_CONTROL_CAPABILITY,config:process.env.ASHLR_CONFIG,genome:process.env.ASHLR_GENOME_DIR}))'] }, config, { timeoutMs: 5_000 });
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.output)).toEqual({ home: '/synthetic/job-a', session: 'a', executor: 'a'.repeat(64) });
    });
  });

  it('refuses detached dispatch after the owning job ended', async () => {
    const release = deferred();
    let delayed!: Promise<void>;
    await runInLocusJobEnv(env('a'), () => {
      delayed = release.promise.then(() => { assertLocusJobDispatch(); });
    });
    release.resolve();
    await expect(delayed).rejects.toThrow('job has ended');
  });
  it('refuses in-process API execution before sandbox creation or provider contact', async () => {
    await runInLocusJobEnv(env('a'), async () => {
      const result = await runApiModelSandboxed('local-coder', 'must not dispatch', config,
        { sourceRepo: '/synthetic/nonexistent-repo', deferTerminalAction: true });
      expect(result.state.status).toBe('failed');
      expect(result.proposalOutcome?.kind).toBe('engine-unsupported');
      expect(result.proposalOutcome?.reason).toContain('no qualified job credential contract');
      expect(result.state.usage.steps).toBe(0);
    });
  });

  it('refuses inherited API execution without ALS before sandbox creation or provider contact', async () => {
    vi.stubEnv('LOCUS_EXECUTOR_CAPABILITY', 'synthetic-incomplete');
    try {
      const result = await runApiModelSandboxed('local-coder', 'must not dispatch', config,
        { sourceRepo: '/synthetic/nonexistent-repo', deferTerminalAction: true });
      expect(result.state.status).toBe('failed');
      expect(result.proposalOutcome?.kind).toBe('engine-unsupported');
      expect(result.proposalOutcome?.reason).toContain('no qualified job credential contract');
      expect(result.state.usage.steps).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it('omits unqualified daemon config paths even when supplied explicitly in the captured job', async () => {
    await runInLocusJobEnv({ ...env('a'), ASHLR_CONFIG: '/synthetic/daemon/config.json',
      ASHLR_GENOME_DIR: '/synthetic/daemon/genome' }, () => {
      const base = { ASHLR_CONFIG: '/synthetic/other/config.json',
        ASHLR_GENOME_DIR: '/synthetic/other/genome' };
      const explicitChild = withLocusJobChildEnv(base);
      expect(explicitChild.ASHLR_CONFIG).toBeUndefined();
      expect(explicitChild.ASHLR_GENOME_DIR).toBeUndefined();
      const child = withToolEnv(config, base);
      expect(child.ASHLR_CONFIG).toBeUndefined();
      expect(child.ASHLR_GENOME_DIR).toBeUndefined();
      expect(childIdentity(child)).toEqual({ home: '/synthetic/job-a', session: 'a', executor: 'a'.repeat(64) });
    });
  });

});
