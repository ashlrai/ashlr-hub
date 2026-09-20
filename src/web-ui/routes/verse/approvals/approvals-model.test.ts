import { describe, expect, it } from 'vitest';
import type { Proposal } from '../../../data/api-types.js';
import { describeApproveConsequence, engineOf, filterProposals, orderProposals, reachesRemote, riskRank } from './approvals-model.js';

function proposal(over: Partial<Proposal> & Pick<Proposal, 'id' | 'status' | 'createdAt'>): Proposal {
  return {
    repo: '/Users/m/code/hub',
    origin: 'backlog',
    kind: 'patch',
    title: 'title',
    summary: 'summary',
    ...over,
  } as Proposal;
}

describe('approvals ordering', () => {
  it('puts pending first even when it is older than a decided row', () => {
    const rows = [
      proposal({ id: 'new-rejected', status: 'rejected', createdAt: '2026-03-02T00:00:00.000Z' }),
      proposal({ id: 'old-pending', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' }),
      proposal({ id: 'new-pending', status: 'pending', createdAt: '2026-03-01T00:00:00.000Z' }),
    ];
    expect(orderProposals(rows).map((p) => p.id)).toEqual(['new-pending', 'old-pending', 'new-rejected']);
  });

  it('is total and stable when timestamps collide or fail to parse', () => {
    const rows = [
      proposal({ id: 'b', status: 'pending', createdAt: 'not-a-date' }),
      proposal({ id: 'a', status: 'pending', createdAt: 'not-a-date' }),
    ];
    expect(orderProposals(rows).map((p) => p.id)).toEqual(['a', 'b']);
    // Does not mutate its input.
    expect(rows.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('ranks risk high-first and sinks an unstated risk to the bottom', () => {
    expect([undefined, 'low', 'high', 'medium'].map((r) => riskRank(r as Proposal['riskClass']))).toEqual([3, 2, 0, 1]);
  });
});

describe('approvals filtering', () => {
  const rows = [
    proposal({ id: '1', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', title: 'Fix auth guard', repo: '/code/hub' }),
    proposal({ id: '2', status: 'pending', createdAt: '2026-01-02T00:00:00.000Z', title: 'Tidy docs', summary: 'auth notes', repo: '/code/site' }),
  ];

  it('matches title or summary, case-insensitively', () => {
    expect(filterProposals(rows, 'AUTH', '').map((p) => p.id)).toEqual(['1', '2']);
    expect(filterProposals(rows, 'guard', '').map((p) => p.id)).toEqual(['1']);
  });

  it('narrows by repo independently of the text search', () => {
    expect(filterProposals(rows, '', 'site').map((p) => p.id)).toEqual(['2']);
    expect(filterProposals(rows, 'auth', 'site').map((p) => p.id)).toEqual(['2']);
  });
});

describe('approve consequence', () => {
  it('names the repo and says plainly that a pr leaves the machine', () => {
    const text = describeApproveConsequence('pr', '/Users/m/code/hub');
    expect(text).toContain('/Users/m/code/hub');
    expect(text).toContain('pull request');
    expect(text).toContain('cannot undo');
    expect(reachesRemote('pr')).toBe(true);
  });

  it('describes a patch as a local write, not a push', () => {
    const text = describeApproveConsequence('patch', '/code/hub');
    expect(text).toContain('on disk');
    expect(text).not.toContain('pull request');
    expect(reachesRemote('patch')).toBe(false);
  });

  it('still says something useful for an unknown kind and a null repo', () => {
    expect(describeApproveConsequence('something-else', null)).toContain('the target repository');
  });
});

describe('engine display', () => {
  it('prefers the concrete model over the tier, and admits when neither is present', () => {
    expect(engineOf({ engineModel: 'codex:gpt-5.5', engineTier: 'frontier' })).toBe('codex:gpt-5.5');
    expect(engineOf({ engineModel: undefined, engineTier: 'frontier' })).toBe('frontier');
    expect(engineOf({ engineModel: undefined, engineTier: undefined })).toBeNull();
  });
});
