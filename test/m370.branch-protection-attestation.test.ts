/** Hermetic live branch-protection attestation tests. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  spawnSync: spawnMock,
  execFileSync: () => { throw new Error('execFileSync not expected'); },
}));

import { readBranchProtectionAttestation } from '../src/core/integrations/github.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';

function result(
  body: unknown,
  status: number | null = 0,
  stderr = '',
  error?: Error,
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: typeof body === 'string' ? body : JSON.stringify(body),
    stderr,
    status,
    signal: null,
    error,
  };
}

function successSequence(overrides: {
  classic?: SpawnSyncReturns<string>;
  rules?: SpawnSyncReturns<string>;
  branch?: string;
} = {}): SpawnSyncReturns<string>[] {
  const branch = overrides.branch ?? 'main';
  return [
    result({
      id: 'R_kgDOExample',
      nameWithOwner: 'acme/widgets',
      defaultBranchRef: { name: 'main' },
    }),
    result({ name: branch, commit: { sha: HEAD }, protected: true }),
    overrides.classic ?? result({
      required_status_checks: {
        contexts: ['build'],
        checks: [{ context: 'test', app_id: 1 }, { context: 'build', app_id: null }],
      },
      required_pull_request_reviews: { required_approving_review_count: 1 },
      required_signatures: { enabled: true },
    }),
    overrides.rules ?? result([
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'lint', integration_id: 2 }] },
      },
      { type: 'non_fast_forward' },
    ]),
  ];
}

function queue(responses: SpawnSyncReturns<string>[]): void {
  let index = 0;
  spawnMock.mockImplementation(() => {
    const response = responses[index];
    index++;
    if (!response) throw new Error(`unexpected gh call ${index}`);
    return response;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'));
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readBranchProtectionAttestation parsing', () => {
  it('binds identity and head while normalizing classic and effective rules', async () => {
    queue(successSequence({ branch: 'release/v1' }));

    const evidence = await readBranchProtectionAttestation(
      '/repo/parsing',
      'release/v1',
      { forceFresh: true },
    );

    expect(evidence).toEqual({
      ok: true,
      available: true,
      protected: true,
      branchProtection: true,
      nameWithOwner: 'acme/widgets',
      repositoryId: 'R_kgDOExample',
      defaultBranch: 'main',
      branch: 'release/v1',
      baseHead: HEAD,
      observedAt: '2026-07-11T12:00:00.000Z',
      requirements: [
        'non_fast_forward',
        'pull_request',
        'required_signatures',
        'required_status_checks',
      ],
      requiredChecks: ['build', 'lint', 'test'],
      requiredCheckBindings: [
        { context: 'build', appId: null },
        { context: 'lint', appId: '2' },
        { context: 'test', appId: '1' },
      ],
      sources: ['classic', 'ruleset'],
      detail: 'Live branch protection confirmed with 4 requirement(s)',
    });
    const calls = spawnMock.mock.calls.map((call) => call[1] as string[]);
    expect(calls[1]).toContain('repos/acme/widgets/branches/release/v1');
    expect(calls[2]).toContain('repos/acme/widgets/branches/release/v1/protection');
    expect(calls[3]).toContain('repos/acme/widgets/rules/branches/release/v1');
  });

  it('accepts an effective ruleset when classic protection is statically absent', async () => {
    queue(successSequence({
      classic: result('', 1, 'gh: Branch not protected (HTTP 404)'),
      rules: result([{ type: 'pull_request', parameters: { required_approving_review_count: 2 } }]),
    }));

    const evidence = await readBranchProtectionAttestation('/repo/rules-only', undefined, { forceFresh: true });

    expect(evidence.ok).toBe(true);
    expect(evidence.sources).toEqual(['ruleset']);
    expect(evidence.requirements).toEqual(['pull_request']);
    expect(evidence.requiredChecks).toEqual([]);
    expect(evidence.requiredCheckBindings).toEqual([]);
  });

  it('returns available but unprotected evidence for static absence', async () => {
    queue(successSequence({
      classic: result('', 1, 'HTTP 404: Branch not protected'),
      rules: result([]),
    }));

    const evidence = await readBranchProtectionAttestation('/repo/unprotected', undefined, { forceFresh: true });

    expect(evidence).toMatchObject({
      ok: false,
      available: true,
      protected: false,
      branchProtection: false,
      nameWithOwner: 'acme/widgets',
      branch: 'main',
      baseHead: HEAD,
      requirements: [],
      sources: [],
    });
  });
});

describe('readBranchProtectionAttestation failures', () => {
  it.each([
    ['missing gh', result('', null, '', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))],
    ['HTTP 401', result('', 1, 'HTTP 401: Bad credentials')],
    ['HTTP 403', result('', 1, 'HTTP 403: Resource not accessible')],
    ['HTTP 404', result('', 1, 'HTTP 404: Not Found')],
    ['timeout', result('', null, '', Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }))],
  ])('returns unavailable evidence when repository identity hits %s', async (_label, failure) => {
    queue([failure]);
    const evidence = await readBranchProtectionAttestation(`/repo/error-${_label}`, undefined, { forceFresh: true });
    expect(evidence).toMatchObject({ ok: false, available: false, protected: false });
  });

  it('fails closed on malformed identity, branch, classic, and rules payloads', async () => {
    const cases: Array<[string, SpawnSyncReturns<string>[]]> = [
      ['identity', [result('{bad json')]],
      ['branch', [successSequence()[0]!, result({ name: 'main', commit: { sha: 'short' } })]],
      ['classic', [successSequence()[0]!, successSequence()[1]!, result({ required_status_checks: [] })]],
      ['rules', [successSequence()[0]!, successSequence()[1]!, successSequence()[2]!, result({ rules: [] })]],
    ];
    for (const [name, responses] of cases) {
      queue(responses);
      const evidence = await readBranchProtectionAttestation(`/repo/malformed-${name}`, undefined, { forceFresh: true });
      expect(evidence).toMatchObject({ ok: false, available: false, protected: false });
    }
  });
});

describe('readBranchProtectionAttestation cache', () => {
  it('uses a 30s positive TTL and coalesces concurrent reads', async () => {
    queue([...successSequence(), ...successSequence()]);

    const reads = [
      readBranchProtectionAttestation('/repo/positive-cache'),
      readBranchProtectionAttestation('/repo/positive-cache'),
      readBranchProtectionAttestation('/repo/positive-cache'),
    ];
    const first = await Promise.all(reads);
    expect(first.every((item) => item.ok)).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(29_999);
    await readBranchProtectionAttestation('/repo/positive-cache');
    expect(spawnMock).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(1);
    await readBranchProtectionAttestation('/repo/positive-cache');
    expect(spawnMock).toHaveBeenCalledTimes(8);
  });

  it('uses a 5s negative TTL', async () => {
    const absent = successSequence({
      classic: result('', 1, 'HTTP 404: Branch not protected'),
      rules: result([]),
    });
    queue([...absent, ...absent]);

    await readBranchProtectionAttestation('/repo/negative-cache');
    vi.advanceTimersByTime(4_999);
    await readBranchProtectionAttestation('/repo/negative-cache');
    expect(spawnMock).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(1);
    await readBranchProtectionAttestation('/repo/negative-cache');
    expect(spawnMock).toHaveBeenCalledTimes(8);
  });

  it('forceFresh bypasses cache and never serves stale evidence after refresh failure', async () => {
    queue([...successSequence(), result('', 1, 'HTTP 403')]);
    expect((await readBranchProtectionAttestation('/repo/refresh')).ok).toBe(true);

    const refreshed = await readBranchProtectionAttestation('/repo/refresh', undefined, { forceFresh: true });
    expect(refreshed).toMatchObject({ ok: false, available: false });
    expect(spawnMock).toHaveBeenCalledTimes(5);

    const cachedFailure = await readBranchProtectionAttestation('/repo/refresh');
    expect(cachedFailure).toMatchObject({ ok: false, available: false });
    expect(spawnMock).toHaveBeenCalledTimes(5);
  });

  it('evicts the least-recently-used entry beyond 128 keys', async () => {
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'repo') return successSequence()[0];
      if (args[1]?.endsWith('/protection')) return successSequence()[2];
      if (args[1]?.includes('/rules/branches/')) return successSequence()[3];
      return successSequence()[1];
    });

    for (let index = 0; index < 129; index++) {
      await readBranchProtectionAttestation(`/repo/lru-${index}`, undefined, { forceFresh: true });
    }
    expect(spawnMock).toHaveBeenCalledTimes(129 * 4);

    await readBranchProtectionAttestation('/repo/lru-1');
    expect(spawnMock).toHaveBeenCalledTimes(129 * 4);
    await readBranchProtectionAttestation('/repo/lru-0');
    expect(spawnMock).toHaveBeenCalledTimes(130 * 4);
  });
});
