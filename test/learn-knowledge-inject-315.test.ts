/**
 * 3.15 suggested knowledge — trigger matching, the 16 KiB cap, and the read
 * back of the Leader's veto playbook deltas (learn/retro/inject.ts).
 * HOME is isolated by test/setup/home.ts.
 */
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  KNOWLEDGE_HEADING,
  classifyTaskKind,
  knowledgeBlockFor,
  leaderLessons,
  renderKnowledgeBlock,
  repoMatches,
  scopeMatches,
  selectKnowledge,
  vetoLessons,
  withApprovedKnowledge,
} from '../src/core/learn/retro/inject.js';
import { KNOWLEDGE_INJECT_CAP_BYTES, type KnowledgeNoteV1, type KnowledgeScope } from '../src/core/learn/retro/types.js';
import { addDelta, getEntries } from '../src/core/vision/playbook.js';

function note(id: string, text: string, scope: Partial<KnowledgeScope> = {}, over: Partial<KnowledgeNoteV1> = {}): KnowledgeNoteV1 {
  return {
    v: 1,
    id,
    text,
    scope: { repo: null, pathGlobs: [], taskKinds: [], ...scope },
    status: 'approved',
    retroId: null,
    source: 'fleet',
    createdAt: '2026-09-01T00:00:00.000Z',
    decidedAt: '2026-09-02T00:00:00.000Z',
    edited: false,
    hits: 0,
    lastHitAt: null,
    seen: 1,
    agentsMdTaskId: null,
    ...over,
  };
}

beforeEach(() => {
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

describe('trigger matching', () => {
  it('repo: owner/name, a fleet mirror path, or a plain clone path', () => {
    expect(repoMatches(null, null)).toBe(true);
    expect(repoMatches('ashlrai/Widget', 'ashlrai/widget')).toBe(true);
    expect(repoMatches('ashlrai/widget', '/Users/x/.ashlr/fleet/mirrors/ashlrai__widget')).toBe(true);
    expect(repoMatches('ashlrai/widget', '/Users/x/code/widget/')).toBe(true);
    expect(repoMatches('ashlrai/widget', 'ashlrai/gadget')).toBe(false);
    expect(repoMatches('ashlrai/widget', 'widget')).toBe(false);
    expect(repoMatches('ashlrai/widget', null)).toBe(false);
  });

  it('paths: any known path under any glob; with no paths, the glob prefix must be named in the task', () => {
    const scope: KnowledgeScope = { repo: null, pathGlobs: ['src/parser/**'], taskKinds: [] };
    expect(scopeMatches(scope, { repo: null, paths: ['src/parser/lex.ts'], kind: null })).toBe(true);
    expect(scopeMatches(scope, { repo: null, paths: ['src/ui/app.tsx'], kind: null })).toBe(false);
    expect(scopeMatches(scope, { repo: null, paths: [], kind: null, text: 'Fix CRLF handling in src/parser' })).toBe(true);
    expect(scopeMatches(scope, { repo: null, paths: [], kind: null, text: 'Fix the uploader' })).toBe(false);
  });

  it('task kinds: given or inferred from the text', () => {
    const scope: KnowledgeScope = { repo: null, pathGlobs: [], taskKinds: ['tests'] };
    expect(scopeMatches(scope, { repo: null, paths: [], kind: 'tests' })).toBe(true);
    expect(scopeMatches(scope, { repo: null, paths: [], kind: null, text: 'Add coverage for the lexer' })).toBe(true);
    expect(scopeMatches(scope, { repo: null, paths: [], kind: 'docs' })).toBe(false);
    expect(classifyTaskKind('Revert #12')).toBe('revert');
    expect(classifyTaskKind('Bump vitest to 4.1')).toBe('deps');
    expect(classifyTaskKind('')).toBe('other');
  });

  it('only approved notes, most specific first', () => {
    const notes = [
      note('kn_0000000000000001', 'anywhere'),
      note('kn_0000000000000002', 'repo only', { repo: 'ashlrai/widget' }),
      note('kn_0000000000000003', 'repo + path', { repo: 'ashlrai/widget', pathGlobs: ['src/**'] }),
      note('kn_0000000000000004', 'pending', { repo: 'ashlrai/widget' }, { status: 'pending' }),
      note('kn_0000000000000005', 'rejected', {}, { status: 'rejected' }),
      note('kn_0000000000000006', 'other repo', { repo: 'ashlrai/gadget' }),
    ];
    const picked = selectKnowledge(notes, { repo: 'ashlrai/widget', paths: ['src/a.ts'], kind: null });
    expect(picked.map((n) => n.text)).toEqual(['repo + path', 'repo only', 'anywhere']);
  });
});

describe('the cap', () => {
  it('never exceeds 16 KiB of UTF-8 and never cuts a note in half', () => {
    const big = 'é'.repeat(290); // 580 bytes each
    const notes = Array.from({ length: 60 }, (_, i) => note(`kn_${String(i).padStart(16, '0')}`, `${i}: ${big}`));
    const r = renderKnowledgeBlock(notes, []);
    expect(r.bytes).toBeLessThanOrEqual(KNOWLEDGE_INJECT_CAP_BYTES);
    expect(Buffer.byteLength(r.text, 'utf8')).toBe(r.bytes);
    expect(r.noteIds.length).toBeGreaterThan(20);
    expect(r.noteIds.length).toBeLessThan(60);
    for (const line of r.text.split('\n').filter((l) => l.startsWith('- '))) expect(line.endsWith(big)).toBe(true);
  });

  it('a note too long for the remaining room is skipped, a shorter one after it still fits', () => {
    const r = renderKnowledgeBlock([note('kn_000000000000000a', 'x'.repeat(400)), note('kn_000000000000000b', 'short lesson')], [], 400);
    expect(r.noteIds).toEqual(['kn_000000000000000b']);
  });

  it('nothing matching ⇒ the prompt is byte-identical', () => {
    const prompt = 'Fix the parser.\n\nRepo: /x';
    expect(withApprovedKnowledge(prompt, { repo: '/x', paths: [], kind: null }, { notes: [], recordHits: false })).toBe(prompt);
    expect(withApprovedKnowledge(prompt, { repo: '/x', paths: [], kind: null }, { recordHits: false })).toBe(prompt);
  });

  it('matching notes are appended under the heading', () => {
    const out = withApprovedKnowledge('Fix the parser.', { repo: 'ashlrai/widget', paths: [], kind: null }, {
      notes: [note('kn_00000000000000aa', 'Run npm run typecheck; tests alone miss TS errors here.', { repo: 'ashlrai/widget' })],
      recordHits: false,
    });
    expect(out.startsWith('Fix the parser.\n\n' + KNOWLEDGE_HEADING)).toBe(true);
    expect(out).toContain('[ashlrai/widget] Run npm run typecheck');
  });
});

describe('veto playbook read-back', () => {
  it('veto deltas written by the veto path are read back for Leader-originated tasks only', () => {
    addDelta('strategy', 'Mason vetoed the Leader\'s "Pause goal Router cleanup" (goal.pause): it unblocks cost. Weigh this before proposing similar moves.');
    addDelta('strategy', 'Hard problem: flaky CI'); // strategist lesson, not a veto
    expect(getEntries()).toHaveLength(2);
    expect(vetoLessons(getEntries()).map((e) => e.text)).toEqual([expect.stringContaining('Mason vetoed')]);

    const target = { repo: 'ashlrai/widget', paths: [], kind: null };
    expect(knowledgeBlockFor(target, { recordHits: false }).text).toBe('');
    const fromLeader = knowledgeBlockFor(target, { fromLeader: true, recordHits: false });
    expect(fromLeader.vetoes).toBe(1);
    expect(fromLeader.text).toContain('Leader vetoes to respect');
    expect(fromLeader.text).not.toContain('Hard problem');
  });

  it('leaderLessons carries vetoes (with repeats) and every approved note; null when there is nothing', () => {
    expect(leaderLessons()).toBeNull();
    addDelta('strategy', 'Mason vetoed the Leader\'s "Open 4 Grok lanes" (lane.set). Weigh this before proposing similar moves.');
    addDelta('strategy', 'Mason vetoed the Leader\'s "Open 4 Grok lanes" (lane.set). Weigh this before proposing similar moves.');
    const lessons = leaderLessons({ notes: [note('kn_00000000000000bb', 'Keep ashlr-hub PRs under 300 lines.', { repo: 'ashlrai/ashlr-hub' })] });
    expect(lessons!.vetoes).toEqual([{ text: expect.stringContaining('Open 4 Grok lanes'), repeats: 2 }]);
    expect(lessons!.knowledge).toEqual([{ text: 'Keep ashlr-hub PRs under 300 lines.', scope: 'ashlrai/ashlr-hub' }]);
  });
});

describe('cloud briefs', () => {
  it('the lessons block sits between the task text and the delivery contract; none ⇒ unchanged prompt', async () => {
    const { buildCloudPrompt } = await import('../src/core/cloud/delivery-contract.js');
    const task = {
      v: 1, id: 'ct_20260926T1000_aaaaaa', repo: 'ashlrai/widget', baseBranch: 'main', branch: 'ashlr-cloud/ct_20260926T1000_aaaaaa',
      title: 'Fix parser', prompt: 'Fix the CRLF bug in the parser.', origin: 'operator', requestedBy: 'mason', seat: 'claude-a',
      sessionId: null, sessionUrl: null, state: 'launching', stateReason: null, failure: null, createdAt: 'x', launchedAt: null,
      updatedAt: 'x', pr: null, report: null, estimatedCostUsd: 0, backlogItemId: null, needsYouId: null,
    } as unknown as Parameters<typeof buildCloudPrompt>[0];
    expect(buildCloudPrompt(task, '')).toBe(buildCloudPrompt(task));
    const block = knowledgeBlockFor({ repo: 'ashlrai/widget', paths: [], kind: null, text: task.prompt }, {
      notes: [note('kn_00000000000000cc', 'Parser changes need a CRLF fixture test.', { repo: 'ashlrai/widget' })],
      recordHits: false,
    }).text;
    const prompt = buildCloudPrompt(task, block);
    const lessonsAt = prompt.indexOf(KNOWLEDGE_HEADING);
    expect(lessonsAt).toBeGreaterThan(prompt.indexOf('Fix the CRLF bug'));
    expect(lessonsAt).toBeLessThan(prompt.indexOf('DELIVERY CONTRACT'));
  });
});
