import { afterEach, describe, expect, it, vi } from 'vitest';

const inspectMock = vi.fn();

vi.mock('../src/core/portfolio/candidate-admission.js', () => ({
  inspectCandidateRepoAdmission: (...args: unknown[]) => inspectMock(...args),
}));

import { cmdEnroll } from '../src/cli/sandbox.js';

function report(admissionReady: boolean): Record<string, unknown> {
  return {
    schemaVersion: 6,
    generatedAt: '2026-08-09T12:00:00.000Z',
    readOnly: true,
    authorityGranted: false,
    mutationPerformed: false,
    repo: '/candidate',
    name: 'candidate',
    verdict: admissionReady ? 'proposal-only' : 'blocked',
    admissionReady,
    judgeFreeEligible: false,
    primaryAction: 'Review blockers.',
    admissionBlockers: admissionReady ? [] : [{ id: 'source-dirty', detail: 'dirty', fix: 'clean it' }],
    autonomyBlockers: [{ id: 'sensitive-project-restricted', detail: 'sensitive', fix: 'proposal only' }],
    warnings: [],
    enrollment: { registryState: 'ready', registryReason: 'missing-empty', enrolled: false },
    source: { detail: admissionReady ? 'clean and current' : 'dirty' },
    verifier: { detail: 'merge-grade' },
    remotePr: { detail: 'protected PR incomplete' },
    admissionContract: { detail: 'immutable declaration missing' },
    trustedPolicy: { detail: 'operator signer policy unavailable' },
    risk: { detail: 'proposal-only restriction' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  inspectMock.mockReset();
});

describe('M489 candidate repo admission CLI', () => {
  it('emits the non-authoritative JSON report and exits on admission readiness', async () => {
    inspectMock.mockResolvedValue(report(true));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(cmdEnroll(['preflight', '/candidate', '--json'])).resolves.toBe(0);

    expect(inspectMock).toHaveBeenCalledWith('/candidate');
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      admissionReady: true,
      judgeFreeEligible: false,
      readOnly: true,
      authorityGranted: false,
      mutationPerformed: false,
    });
  });

  it('returns nonzero for a blocked report without converting autonomy status into authority', async () => {
    inspectMock.mockResolvedValue(report(false));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(cmdEnroll(['preflight', '/candidate'])).resolves.toBe(1);
    expect(inspectMock).toHaveBeenCalledTimes(1);
  });

  it('rejects missing repos and unknown flags before inspection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(cmdEnroll(['preflight', '--json'])).resolves.toBe(2);
    await expect(cmdEnroll(['preflight', '/candidate', '--write'])).resolves.toBe(2);
    expect(inspectMock).not.toHaveBeenCalled();
  });
});
