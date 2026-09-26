/**
 * `ashlr authority resident start|stop|status` and setup's resident step
 * (docs/RESIDENT-RUNTIME.md §d).
 *
 *   - setup: `already` only when admitted AND running AND the plist is what
 *     config says; `waiting-on-you` with the exact command otherwise;
 *     `blocked` only for a missing prerequisite (no active grant, dirty build…)
 *   - start: refuses --yes, a non-operator context and a non-admitted verdict
 *     before any effect; is a no-op when already current; asks, and only a yes
 *     reaches the real start
 *   - stop: lowering — never asks
 *
 * Every effect is injected; nothing here touches launchd, custody or GitHub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trust = vi.hoisted(() => ({ roots: [] as unknown[] }));
vi.mock('../src/core/authority/trust-roots.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/authority/trust-roots.js')>();
  return {
    ...actual,
    get STANDING_GRANT_TRUST_ROOTS() {
      return trust.roots;
    },
  };
});

vi.mock('../src/core/authority/surface.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/authority/surface.js')>()),
  currentHostBinding: () => 'a'.repeat(64),
}));

const standing = vi.hoisted(() => ({ grantActive: false }));
vi.mock('../src/core/authority/effective-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/authority/effective-config.js')>();
  return {
    ...actual,
    evaluateStandingAuthority: () => ({
      grantState: standing.grantActive ? 'active' : 'none',
      grant: standing.grantActive ? { grantSeq: 7 } : null,
      switch: 'autonomous',
    }),
    requestAutonomySwitch: () => ({ ok: true }),
  };
});

import {
  runAuthorityCli,
  type AuthorityCliDeps,
  type AuthoritySetupReportV1,
  type DaemonServiceState,
  type ResidentCliDeps,
  type ResidentServiceObservation,
} from '../src/cli/authority.js';
import { keyIdForPublicKeyPem } from '../src/core/authority/custody-client.js';
import type { ResidentAdmission } from '../src/core/authority/resident.js';
import { TEST_ROOT, withTempHome } from './helpers/authority-310b.js';

let restore: () => void;

beforeEach(() => {
  ({ restore } = withTempHome('resident-cli-'));
  trust.roots = [TEST_ROOT];
  standing.grantActive = true;
});

afterEach(() => restore());

const ADMITTED: ResidentAdmission = {
  ok: true,
  code: 'admitted',
  status: 'admitted',
  reason: 'grant #7 is active',
  command: null,
  grantId: '0123456789abcdef0123456789abcdef',
  grantSeq: 7,
  expiresAt: '2026-10-20T00:00:00.000Z',
  revision: 'f'.repeat(40),
  packageRoot: '/rel',
};

const CURRENT: ResidentServiceObservation = {
  state: 'running',
  plist: 'current',
  plistPath: '/Users/mason/Library/LaunchAgents/ai.ashlr.daemon.plist',
  installedBudgetUsd: 50,
  expectedBudgetUsd: 50,
  problem: null,
};

function harness(opts: {
  admission?: ResidentAdmission;
  observed?: Partial<ResidentServiceObservation>;
  service?: DaemonServiceState;
  operatorRefusal?: string | null;
  confirm?: boolean;
} = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const resident: ResidentCliDeps & { calls: string[] } = {
    calls: [],
    admission: vi.fn(async () => opts.admission ?? ADMITTED),
    observe: vi.fn(async () => ({ ...CURRENT, ...(opts.observed ?? {}) })),
    operatorRefusal: vi.fn(async () => opts.operatorRefusal ?? null),
    start: vi.fn(async () => {
      resident.calls.push('start');
      return { ok: true as const, detail: 'ai.ashlr.daemon is running under grant #7' };
    }),
    stop: vi.fn(async () => {
      resident.calls.push('stop');
      return { ok: true as const, detail: 'ai.ashlr.daemon is stopped and its plist removed' };
    }),
  };
  const custody = {
    custodyStatus: async () => ({
      installed: true, version: '1.0', keyInitialized: true, keyId: TEST_ROOT.keyId,
      githubApp: true, claudeToken: true, checkedAt: new Date().toISOString(), reasons: [],
    }),
    custodyHostBinding: async () => 'a'.repeat(64),
    custodyPublicKey: async () => ({ keyId: TEST_ROOT.keyId, publicKeyPem: TEST_ROOT.publicKeyPem }),
    custodyInit: vi.fn(async () => { throw new Error('custodyInit must not run'); }),
    signGrant: vi.fn(async () => { throw new Error('signGrant must not run'); }),
    keyIdForPublicKeyPem,
  } as unknown as AuthorityCliDeps['custody'];
  const deps: Partial<AuthorityCliDeps> = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    confirm: async (question) => {
      questions.push(question);
      return opts.confirm ?? false;
    },
    readSecret: async () => '',
    run: () => ({ status: 1, stdout: '', stderr: 'offline' }),
    openBrowser: () => { throw new Error('no browser in tests'); },
    fetch: (async () => { throw new Error('no network in tests'); }) as unknown as typeof fetch,
    custody,
    daemonService: vi.fn(async () => opts.service ?? 'running'),
    resident,
  };
  return { deps, out, err, questions, resident };
}

async function residentStep(h: ReturnType<typeof harness>) {
  expect(await runAuthorityCli(['setup', '--dry-run', '--json'], h.deps)).toBe(0);
  const report = JSON.parse(h.out[0]!) as AuthoritySetupReportV1;
  return { report, step: report.steps.find((s) => s.id === 'resident-runtime')!, daemon: report.steps.find((s) => s.id === 'daemon-service')! };
}

describe('setup: resident runtime step', () => {
  it('is already in place when admitted, running and the plist matches config', async () => {
    const h = harness();
    const { step, daemon } = await residentStep(h);
    expect(daemon).toMatchObject({ status: 'already' });
    expect(step).toMatchObject({ status: 'already', needs: ['terminal'] });
    expect(step.detail).toMatch(/running under grant #7/);
    expect(h.resident.calls).toEqual([]);
  });

  it('waits on you with the exact command when admitted but not running', async () => {
    const h = harness({ service: 'not-loaded', observed: { state: 'not-loaded', plist: 'absent', installedBudgetUsd: null } });
    const { step, daemon } = await residentStep(h);
    expect(daemon.status).toBe('waiting-on-you');
    expect(daemon.detail).toContain('`ashlr authority resident start`');
    expect(step).toMatchObject({ status: 'waiting-on-you' });
    expect(step.detail).toContain('run `ashlr authority resident start`');
    expect(h.resident.calls).toEqual([]);
  });

  it('waits on you when the running plist drifted from config (budget changed)', async () => {
    const h = harness({ observed: { plist: 'drifted', installedBudgetUsd: 50, expectedBudgetUsd: 20 } });
    const { step } = await residentStep(h);
    expect(step.status).toBe('waiting-on-you');
    expect(step.detail).toMatch(/installed budget \$50\/day, config says \$20\/day/);
    expect(step.detail).toContain('`ashlr authority resident start`');
  });

  it('Stop and the switch are waiting-on-you with their own command', async () => {
    const h = harness({ admission: { ...ADMITTED, ok: false, code: 'stopped', status: 'waiting-on-you', reason: 'Stop is engaged', command: 'ashlr authority clear-stop' } });
    const { step } = await residentStep(h);
    expect(step).toMatchObject({ status: 'waiting-on-you' });
    expect(step.detail).toContain('`ashlr authority clear-stop`');
  });

  it('is blocked for a missing prerequisite (dirty build), never for this build as such', async () => {
    const h = harness({ admission: { ...ADMITTED, ok: false, code: 'build-identity-untrusted', status: 'blocked', reason: 'this release was built from a dirty working tree', command: null } });
    const { step, report } = await residentStep(h);
    expect(step).toMatchObject({ status: 'blocked' });
    expect(step.detail).toMatch(/dirty working tree/);
    expect(report.complete).toBe(false);
  });

  it('is blocked without an active grant and never asks the resident deps', async () => {
    standing.grantActive = false;
    const h = harness({ service: 'absent' });
    const { step, daemon } = await residentStep(h);
    expect(step).toMatchObject({ status: 'blocked' });
    expect(step.detail).toMatch(/blocked until a grant is active/);
    expect(daemon.detail).toMatch(/after the standing grant, run `ashlr authority resident start`/);
    expect(h.resident.admission).not.toHaveBeenCalled();
  });

  it('reports the resident step exactly once when setup stops early', async () => {
    const h = harness();
    (h.deps.custody as { custodyStatus: () => Promise<unknown> }).custodyStatus = async () => ({ installed: false });
    expect(await runAuthorityCli(['setup'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text.match(/^× resident runtime:/gm)).toHaveLength(1);
    expect(text).toMatch(/1 blocked on a prerequisite/);
  });
});

describe('resident start', () => {
  it('takes no --yes', async () => {
    const h = harness({ confirm: true });
    expect(await runAuthorityCli(['resident', 'start', '--yes'], h.deps)).toBe(2);
    expect(h.resident.calls).toEqual([]);
  });

  it('refuses an agent / non-operator context before reading anything else', async () => {
    const h = harness({ confirm: true, operatorRefusal: 'CLAUDECODE is set — the resident service is started by you in your own terminal' });
    expect(await runAuthorityCli(['resident', 'start'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/CLAUDECODE is set/);
    expect(h.resident.admission).not.toHaveBeenCalled();
    expect(h.resident.calls).toEqual([]);
    expect(h.questions).toEqual([]);
  });

  it('refuses without an admitted verdict (e.g. an expired grant)', async () => {
    const h = harness({ confirm: true, admission: { ...ADMITTED, ok: false, code: 'grant-inactive', status: 'blocked', reason: 'no active standing grant: expired', command: 'ashlr authority grant' } });
    expect(await runAuthorityCli(['resident', 'start'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/no active standing grant: expired.*ashlr authority grant/);
    expect(h.resident.calls).toEqual([]);
    expect(h.questions).toEqual([]);
  });

  it('is a no-op when already running from the current plist', async () => {
    const h = harness({ confirm: true });
    expect(await runAuthorityCli(['resident', 'start'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/already running under grant #7/);
    expect(h.resident.calls).toEqual([]);
  });

  it('shows the plan and changes nothing when you decline', async () => {
    const h = harness({ confirm: false, service: 'running', observed: { plist: 'drifted', installedBudgetUsd: 50, expectedBudgetUsd: 20 } });
    expect(await runAuthorityCli(['resident', 'start'], h.deps)).toBe(1);
    const text = h.out.join('\n');
    expect(text).toMatch(/budget +\$20\/day from config daemon\.dailyBudgetUsd \(installed: \$50\)/);
    expect(h.questions).toEqual(['Regenerate the plist from config and restart ai.ashlr.daemon now?']);
    expect(text).toMatch(/Nothing was changed/);
    expect(h.resident.calls).toEqual([]);
  });

  it('starts only after you confirm', async () => {
    const h = harness({ confirm: true, observed: { state: 'absent', plist: 'absent', installedBudgetUsd: null } });
    expect(await runAuthorityCli(['resident', 'start'], h.deps)).toBe(0);
    expect(h.questions).toEqual(['Install and start ai.ashlr.daemon now?']);
    expect(h.resident.calls).toEqual(['start']);
    expect(h.out.join('\n')).toMatch(/✓ ai\.ashlr\.daemon is running under grant #7/);
  });

  it('reports a failed start (the real start re-verifies and can still refuse)', async () => {
    const h = harness({ confirm: true, observed: { state: 'absent', plist: 'absent' } });
    (h.resident as ResidentCliDeps).start = async () => ({ ok: false, reason: 'HOME is not your login home' });
    expect(await runAuthorityCli(['resident', 'start'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/resident start failed: HOME is not your login home/);
  });
});

describe('resident stop and status', () => {
  it('stop is lowering: it never asks and never needs the grant', async () => {
    standing.grantActive = false;
    const h = harness({ confirm: false });
    expect(await runAuthorityCli(['resident', 'stop'], h.deps)).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.resident.calls).toEqual(['stop']);
    expect(h.out.join('\n')).toMatch(/Stop \(~\/\.ashlr\/KILL\) and the grant are unchanged/);
  });

  it('status --json is one machine-readable document and changes nothing', async () => {
    const h = harness({ observed: { plist: 'drifted', installedBudgetUsd: 50, expectedBudgetUsd: 20 } });
    expect(await runAuthorityCli(['resident', 'status', '--json'], h.deps)).toBe(0);
    expect(h.out).toHaveLength(1);
    const doc = JSON.parse(h.out[0]!) as { schema: string; admission: ResidentAdmission; service: ResidentServiceObservation };
    expect(doc).toMatchObject({ schema: 'ashlr.resident-status.v1', admission: { code: 'admitted' }, service: { plist: 'drifted', expectedBudgetUsd: 20 } });
    expect(h.resident.calls).toEqual([]);
  });

  it('an unknown subcommand is a usage error', async () => {
    const h = harness();
    expect(await runAuthorityCli(['resident', 'restart'], h.deps)).toBe(2);
    expect(h.resident.calls).toEqual([]);
  });
});
