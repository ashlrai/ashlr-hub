/**
 * 3.15 suggested knowledge — the review queue: candidates in, Mason's
 * approve / edit / reject, AGENTS.md only through a fleet task, hit counts,
 * private storage. HOME is isolated by test/setup/home.ts.
 */
import { readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { retroFromFleet } from '../src/core/learn/retro/extract.js';
import { knowledgeBlockFor } from '../src/core/learn/retro/inject.js';
import { agentsMdTask, buildLessonsState, decideKnowledge, enqueueCandidates, proposeAgentsMd, recurringCauses } from '../src/core/learn/retro/knowledge.js';
import {
  knowledgePath,
  readApprovedKnowledgeSync,
  readKnowledge,
  readKnowledgeHits,
  recordKnowledgeHits,
  saveRetro,
} from '../src/core/learn/retro/store.js';
import type { RetroV1 } from '../src/core/learn/retro/types.js';

const NOW = '2026-09-27T12:00:00.000Z';

function refusedRetro(proposalId = 'p-1', reason = 'the diff touches 14 files (cap 8)'): RetroV1 {
  return retroFromFleet({
    proposalId,
    repo: 'ashlrai/widget',
    endKind: 'gate-refused',
    endedAt: '2026-09-26T10:00:00.000Z',
    title: 'Fix flaky parser test',
    summary: null,
    paths: ['src/parser/lex.ts'],
    gate: { gate: 'G2', code: 'files-over-cap', reason },
  }, NOW);
}

beforeEach(() => {
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

describe('queue', () => {
  it('candidates land pending; the same lesson again bumps `seen`, never duplicates', async () => {
    expect(await enqueueCandidates(refusedRetro('p-1'), NOW)).toBe(1);
    expect(await enqueueCandidates(refusedRetro('p-2'), NOW)).toBe(0);
    const notes = await readKnowledge();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ status: 'pending', seen: 2, source: 'fleet', hits: 0 });
    // Pending notes are never injected.
    expect(readApprovedKnowledgeSync()).toEqual([]);
    expect(knowledgeBlockFor({ repo: 'ashlrai/widget', paths: ['src/parser/lex.ts'], kind: 'fix' }, { recordHits: false }).text).toBe('');
  });

  it('the knowledge file is private (0600) and the directory 0700', async () => {
    await enqueueCandidates(refusedRetro(), NOW);
    expect(statSync(knowledgePath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(homedir(), '.ashlr', 'learn')).mode & 0o777).toBe(0o700);
    await saveRetro(refusedRetro());
    const retroFile = join(homedir(), '.ashlr', 'learn', 'retros', `${refusedRetro().id}.json`);
    expect(statSync(retroFile).mode & 0o777).toBe(0o600);
  });

  it('approve makes a note injectable; hits are counted', async () => {
    await enqueueCandidates(refusedRetro(), NOW);
    const [pending] = await readKnowledge();
    const decided = await decideKnowledge({ id: pending!.id, decision: 'approve' }, NOW);
    expect(decided).toMatchObject({ ok: true, note: { status: 'approved', edited: false } });

    const block = knowledgeBlockFor({ repo: 'ashlrai/widget', paths: ['src/parser/lex.ts'], kind: 'fix' });
    expect(block.noteIds).toEqual([pending!.id]);
    await vi.waitFor(async () => expect((await readKnowledgeHits()).get(pending!.id)?.hits).toBe(1));
    await recordKnowledgeHits([pending!.id, 'not-an-id']);
    expect((await readKnowledgeHits()).get(pending!.id)?.hits).toBe(2);
    expect((await buildLessonsState(Date.parse(NOW))).knowledge.approved[0]!.hits).toBe(2);
  });

  it('approve with an edit replaces text and scope (validated and scrubbed)', async () => {
    await enqueueCandidates(refusedRetro(), NOW);
    const [pending] = await readKnowledge();
    const bad = await decideKnowledge({ id: pending!.id, decision: 'approve', scope: { repo: 'not a repo', pathGlobs: [], taskKinds: [] } }, NOW);
    expect(bad).toMatchObject({ ok: false, status: 400 });
    const traversal = await decideKnowledge({ id: pending!.id, decision: 'approve', scope: { repo: null, pathGlobs: ['../x/**'], taskKinds: [] } }, NOW);
    expect(traversal).toMatchObject({ ok: false, status: 400 });
    const ok = await decideKnowledge({
      id: pending!.id,
      decision: 'approve',
      text: 'Split parser changes: one file per PR. token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      scope: { repo: 'ashlrai/widget', pathGlobs: ['src/parser/**'], taskKinds: [] },
    }, NOW);
    expect(ok).toMatchObject({ ok: true, note: { edited: true, status: 'approved', scope: { taskKinds: [] } } });
    expect(readFileSync(knowledgePath(), 'utf8')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    // Kind no longer scoped: a docs task in the parser now gets it too.
    expect(knowledgeBlockFor({ repo: 'ashlrai/widget', paths: ['src/parser/a.md'], kind: 'docs' }, { recordHits: false }).noteIds).toHaveLength(1);
  });

  it('reject is final: the same suggestion is not re-queued and is never injected', async () => {
    await enqueueCandidates(refusedRetro(), NOW);
    const [pending] = await readKnowledge();
    expect(await decideKnowledge({ id: pending!.id, decision: 'reject', text: 'x'.repeat(20) }, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await decideKnowledge({ id: pending!.id, decision: 'reject' }, NOW)).toMatchObject({ ok: true, note: { status: 'rejected' } });
    expect(await enqueueCandidates(refusedRetro('p-9'), NOW)).toBe(0);
    expect((await readKnowledge())[0]!.status).toBe('rejected');
    expect(readApprovedKnowledgeSync()).toEqual([]);
    expect(await decideKnowledge({ id: 'kn_ffffffffffffffff', decision: 'approve' }, NOW)).toMatchObject({ ok: false, status: 404 });
  });

  it('two concurrent decisions on different notes both persist', async () => {
    await enqueueCandidates(refusedRetro('p-1', 'a'), NOW);
    const second = refusedRetro('p-2');
    second.candidates = [{ text: 'Another distinct lesson about the uploader.', scope: { repo: 'ashlrai/widget', pathGlobs: [], taskKinds: [] } }];
    await enqueueCandidates(second, NOW);
    const [a, b] = await readKnowledge();
    await Promise.all([
      decideKnowledge({ id: a!.id, decision: 'approve' }, NOW),
      decideKnowledge({ id: b!.id, decision: 'reject' }, NOW),
    ]);
    const after = await readKnowledge();
    expect(after.find((n) => n.id === a!.id)!.status).toBe('approved');
    expect(after.find((n) => n.id === b!.id)!.status).toBe('rejected');
  });
});

describe('AGENTS.md via a proposal', () => {
  it('files a deduped fleet task for an approved repo-scoped note — never a direct write', async () => {
    await enqueueCandidates(refusedRetro(), NOW);
    const [pending] = await readKnowledge();
    const enqueue = vi.fn(async () => ({ ok: true as const, taskId: 'task-1' }));
    expect(await proposeAgentsMd(pending!.id, enqueue)).toMatchObject({ ok: false, status: 409 });
    expect(enqueue).not.toHaveBeenCalled();
    await decideKnowledge({ id: pending!.id, decision: 'approve' }, NOW);
    expect(await proposeAgentsMd(pending!.id, enqueue)).toMatchObject({ ok: true, taskId: 'task-1' });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'ashlrai/widget', source: 'manual', requestedBy: 'mason', dedupeKey: `knowledge-agents-md:${pending!.id}`,
    }));
    expect((await readKnowledge())[0]!.agentsMdTaskId).toBe('task-1');
  });

  it('a note with no repo has no AGENTS.md to go to', () => {
    const r = refusedRetro();
    expect(agentsMdTask({
      v: 1, id: 'kn_0000000000000001', text: 'x', scope: { repo: null, pathGlobs: [], taskKinds: [] }, status: 'approved', retroId: r.id,
      source: 'fleet', createdAt: NOW, decidedAt: NOW, edited: false, hits: 0, lastHitAt: null, seen: 1, agentsMdTaskId: null,
    })).toBeNull();
  });
});

describe('lessons state', () => {
  it('groups failure causes by code and source; merged retros are not causes', async () => {
    const merged = retroFromFleet({ proposalId: 'p-m', repo: 'ashlrai/widget', endKind: 'merged', endedAt: '2026-09-26T00:00:00.000Z', title: 't', summary: null, paths: [] }, NOW);
    await saveRetro(refusedRetro('p-1'));
    await saveRetro(refusedRetro('p-2'));
    await saveRetro(merged);
    const state = await buildLessonsState(Date.parse(NOW));
    expect(state.retros).toHaveLength(3);
    expect(state.endKinds).toEqual({ 'gate-refused': 2, merged: 1 });
    expect(state.causes).toEqual([{ code: 'gate:files-over-cap', label: 'Diff too large', count: 2, bySource: { fleet: 2, cloud: 0, leader: 0 } }]);
    expect(recurringCauses([merged])).toEqual([]);
    expect(state.knowledge.capBytes).toBe(16 * 1024);
  });
});
