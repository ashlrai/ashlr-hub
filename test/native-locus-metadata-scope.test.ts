/** Inert boundary canaries: no native profile, credential, provider or child is used. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { assertHostNativeAccountContext, runInLocusJobEnv } from '../src/core/integrations/locus-job-env.js';
import { nativeRoleCompletion, type NativeRoleEngine } from '../src/core/run/role-completion.js';
import { runClaudeNativeAdapter } from '../src/core/sandbox/claude-native-adapter.js';
import * as nativeProfiles from '../src/core/resources/native-profile.js';
import * as roleAccounts from '../src/core/run/role-account.js';
import * as claudeAdmission from '../src/core/sandbox/claude-native-admission.js';
import * as devinAdmission from '../src/core/devin/cli-admission.js';
import * as engines from '../src/core/run/engines.js';
import * as policies from '../src/core/authority/effective-config.js';

const enginesToCheck: NativeRoleEngine[] = ['claude', 'codex', 'grok', 'devin'];
const sealed = { HOME: '/synthetic/sealed-job', LOCUS_SESSION_ID: 'ses_synthetic',
  LOCUS_EXECUTOR_CAPABILITY: 'a'.repeat(64) };
const scopeHold = 'Locus sealed jobs have no qualified host native-account metadata bridge';
const canaries: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  canaries.push(
    vi.spyOn(nativeProfiles, 'resolveNativeSeatLaunch'),
    vi.spyOn(roleAccounts, 'roleAccountEpoch'),
    vi.spyOn(roleAccounts, 'observeRoleAccount'),
    vi.spyOn(claudeAdmission, 'readClaudeNativeBinding'),
    vi.spyOn(claudeAdmission, 'observeClaudeNativeBinding'),
    vi.spyOn(devinAdmission, 'refreshDevinCliExecutionBinding'),
    vi.spyOn(engines, 'spawnEngine'),
    vi.spyOn(policies, 'currentStandingPolicy'),
  );
  for (const canary of canaries) canary.mockImplementation(() => { throw new Error('unexpected native boundary contact'); });
});
afterEach(() => { canaries.length = 0; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function noNativeContact(): void {
  for (const canary of canaries) expect(canary).not.toHaveBeenCalled();
}
function role(engine: NativeRoleEngine, signal?: AbortSignal) {
  return nativeRoleCompletion({ cfg: defaultConfig(), role: 'leader', seatId: 'synthetic-seat',
    engine, model: 'synthetic-model', accountHint: 'b'.repeat(64), timeoutMs: 1000,
    signal, admitted: () => true });
}
function adapter(signal = new AbortController().signal) {
  return runClaudeNativeAdapter({ cfg: defaultConfig(), runId: 'synthetic-run', seatId: 'synthetic-seat',
    model: 'synthetic-model', prompt: 'must not contact native accounts', worktree: '/synthetic/worktree',
    signal, admission: () => true, timeoutMs: 1000, recordEvidence: () => {}, retainCleanupFailure: () => {} });
}

describe('host native-account scope before metadata dispatch', () => {
  it.each(enginesToCheck)('holds sealed %s role before any profile, policy, metadata or model call', async engine => {
    const original = { ...process.env };
    const validate = vi.fn();
    await runInLocusJobEnv(sealed, async () => {
      await expect(role(engine)('SYSTEM', 'USER')).rejects.toThrow(scopeHold);
    }, validate);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(process.env).toEqual(original);
    noNativeContact();
  });

  it('returns a structured Claude scope hold before any profile, metadata or model call', async () => {
    const validate = vi.fn();
    await runInLocusJobEnv(sealed, async () => {
      await expect(adapter()).resolves.toMatchObject({ ok: false, output: '', error: scopeHold,
        providerContacted: false, captureDenied: true, terminationReason: 'error-exit' });
    }, validate);
    expect(validate).toHaveBeenCalledTimes(2);
    noNativeContact();
  });

  it.each([
    ['LOCUS_SESSION_ID', ''], ['LOCUS_SESSION_ID', 'invalid-session'],
    ['LOCUS_EXECUTOR_CAPABILITY', ''], ['LOCUS_EXECUTOR_CAPABILITY', 'invalid-executor'],
  ])('holds uncaptured inherited %s=%j before any native role or adapter metadata', async (key, value) => {
    vi.stubEnv(key, value);
    for (const engine of enginesToCheck) {
      await expect(role(engine)('SYSTEM', 'USER')).rejects.toThrow('requires live verification');
    }
    await expect(adapter()).resolves.toMatchObject({ ok: false, providerContacted: false, captureDenied: true,
      error: 'Inherited Locus session requires live verification before dispatch' });
    noNativeContact();
  });

  it('revalidates captured authority after an await and retains its precise failure', async () => {
    let valid = true;
    await runInLocusJobEnv(sealed, async () => {
      await Promise.resolve(); valid = false;
      await expect(role('codex')('SYSTEM', 'USER')).rejects.toThrow('synthetic session expired');
      await expect(adapter()).resolves.toMatchObject({ ok: false, providerContacted: false,
        error: 'synthetic session expired', captureDenied: true });
    }, () => { if (!valid) throw new Error('synthetic session expired'); });
    noNativeContact();
  });

  it('refuses delayed native metadata after the owning job ends', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let delayed!: Promise<Awaited<ReturnType<typeof adapter>>>;
    await runInLocusJobEnv(sealed, () => { delayed = pending.then(() => adapter()); });
    release();
    await expect(delayed).resolves.toMatchObject({ ok: false, providerContacted: false,
      error: 'Locus job has ended; refusing delayed dispatch', captureDenied: true });
    noNativeContact();
  });

  it('leaves unsealed host context and ordinary cancelled Claude behavior unchanged', async () => {
    expect(() => assertHostNativeAccountContext()).not.toThrow();
    const signal = AbortSignal.abort();
    await expect(adapter(signal)).resolves.toMatchObject({ ok: false, providerContacted: false,
      error: 'run cancelled', terminationReason: 'cancelled' });
    noNativeContact();
  });
});
