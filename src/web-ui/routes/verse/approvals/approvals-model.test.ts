import { describe, expect, it } from 'vitest';
import type { Proposal } from '../../../data/api-types.js';
import {
  describeApproveConsequence,
  describeDiffStats,
  engineOf,
  filterProposals,
  formatDiffStats,
  kindLabel,
  longAgo,
  orderProposals,
  parseRunSummary,
  reachesRemote,
  readableTitle,
  repoName,
  riskRank,
} from './approvals-model.js';

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
    // The project's name, not its absolute path (the confirm prints the path once, on its own line).
    expect(text).toContain("hub's remote");
    expect(text).not.toContain('/Users/m/code/hub');
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

/**
 * The live Needs-you item that motivated this: a sandboxed Claude run whose
 * title the server sliced at 80 characters mid-word, whose summary packs the
 * run facts into a sentence, and whose source label is internal shorthand.
 */
describe('readable approval detail', () => {
  const TITLE = 'claude run: Advance goal "Add a circuit breaker to binshield\'s worker scan pipeline so a deg';
  const SUMMARY = 'TITRR claude:claude-fable-5 run produced 2 file(s) (+384/-0). Review before applying.';

  it('never ends a title mid-word, closes the quote the cut left open, and lifts the engine into an eyebrow', () => {
    const title = readableTitle(TITLE);
    expect(title.eyebrow).toBe('Claude run');
    expect(title.truncated).toBe(true);
    expect(title.text).toBe('Advance goal "Add a circuit breaker to binshield\'s worker scan pipeline so a\u2026"');
    expect(title.text).not.toMatch(/deg/);
  });

  it('drops a partial word before an upstream ellipsis, and leaves whole titles alone', () => {
    expect(readableTitle('Tidy the scan pipeline so a deg\u2026').text).toBe('Tidy the scan pipeline so a\u2026');
    expect(readableTitle('PR: fix the flaky snapshot test')).toEqual({ eyebrow: null, text: 'PR: fix the flaky snapshot test', truncated: false });
    expect(readableTitle('codex run: Rename the flag.')).toEqual({ eyebrow: 'Codex run', text: 'Rename the flag.', truncated: false });
    expect(readableTitle('Dry run: check the thing').eyebrow).toBeNull();
  });

  it('names the engine the same way for a partial run: "Partial Claude run", never "Partial claude run"', () => {
    expect(readableTitle('[partial] claude run: Add the breaker.').eyebrow).toBe('Partial Claude run');
    expect(readableTitle('[Partial] CODEX run: Rename the flag.')).toEqual({ eyebrow: 'Partial Codex run', text: 'Rename the flag.', truncated: false });
    expect(readableTitle('[partial] grok run: x').eyebrow).toBe('Partial Grok run');
    expect(readableTitle('[partial] ollama run: x').eyebrow).toBe('Partial Ollama run');
    expect(readableTitle('local run: x').eyebrow).toBe('Local run');
  });

  it('takes the run summary apart: stats, plain-language source with the acronym in a hint, and the rest', () => {
    const facts = parseRunSummary(SUMMARY)!;
    expect(facts).toMatchObject({ partial: false, source: 'TITRR', model: 'claude:claude-fable-5', files: 2, insertions: 384, deletions: 0, rest: 'Review before applying.' });
    expect(facts.sourceLabel).toBe('Test-and-repair loop');
    expect(facts.sourceHint).toMatch(/^TITRR — Test, Iterate, Test, Refine, Repeat/);
    expect(formatDiffStats(facts)).toBe('2 files \u00b7 +384 \u22120');
    expect(formatDiffStats({ files: 1, insertions: 12_480, deletions: 3 })).toBe('1 file \u00b7 +12,480 \u22123');
    // The spoken form: a screen reader says "minus zero" for "\u22120", which is not what it means.
    expect(describeDiffStats(facts)).toBe('2 files changed, 384 lines added, 0 removed');
    expect(describeDiffStats({ files: 1, insertions: 1, deletions: 12_480 })).toBe('1 file changed, 1 line added, 12,480 removed');
  });

  it('reads the other source labels and a partial run, and returns null for prose it does not know', () => {
    expect(parseRunSummary('Partial TITRR api-model required-diff grok:grok-4 run produced 1 file(s) (+3/-1).')).toMatchObject({
      partial: true, sourceLabel: 'Test-and-repair loop (API model, retried for a missing diff)', files: 1, rest: null,
    });
    expect(parseRunSummary('Best-of-N winner codex:gpt-5.5 run produced 4 file(s) (+10/-2). Review before applying.')!.sourceLabel).toBe('Best-of-N winner');
    expect(parseRunSummary('Two assertions raced the clock.')).toBeNull();
    expect(parseRunSummary(undefined)).toBeNull();
  });

  it('names the project, not the path, and the kind in words', () => {
    expect(repoName('/private/tmp/claude-501/x/scratchpad/binshield/')).toBe('binshield');
    expect(repoName(null)).toBeNull();
    expect(kindLabel('patch')).toBe('Patch');
    expect(kindLabel('pr')).toBe('Pull request');
    expect(kindLabel('mystery')).toBe('mystery');
  });

  it('writes ages out in full: "38 days ago", not "38d"', () => {
    const now = Date.parse('2026-09-24T12:00:00.000Z');
    expect(longAgo('2026-08-17T12:00:00.000Z', now)).toBe('38 days ago');
    expect(longAgo('2026-09-24T11:59:40.000Z', now)).toBe('just now');
    expect(longAgo('2026-09-24T11:55:00.000Z', now)).toBe('5 minutes ago');
    expect(longAgo('2026-09-23T12:00:00.000Z', now)).toBe('yesterday');
    // Noon on May 1 LOCAL time — the date a viewer reads is their own calendar
    // day, so a UTC-noon instant is May 2 from UTC+12 eastward.
    expect(longAgo(new Date(2026, 4, 1, 12).toISOString(), now)).toMatch(/^on May 1, 2026$/);
    expect(longAgo('nope', now)).toBe('at an unknown time');
  });
});
