import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LessonsPanel } from './LessonsPanel.js';
import { causeChart, parseScopeForm } from './lessons-model.js';
import { narrowLessons } from './lessons-data.js';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import type { KnowledgeNoteV1, LessonsStateV1 } from '../../../../core/learn/retro/types.js';

const NOW = '2026-09-27T12:00:00.000Z';

function note(id: string, text: string, status: KnowledgeNoteV1['status'], over: Partial<KnowledgeNoteV1> = {}): KnowledgeNoteV1 {
  return {
    v: 1, id, text, scope: { repo: 'ashlrai/widget', pathGlobs: ['src/parser/**'], taskKinds: ['fix'] }, status, retroId: 'rt_1', source: 'fleet',
    createdAt: NOW, decidedAt: status === 'pending' ? null : NOW, edited: false, hits: 0, lastHitAt: null, seen: 1, agentsMdTaskId: null, ...over,
  };
}

function lessons(over: Partial<LessonsStateV1> = {}): LessonsStateV1 {
  return {
    v: 1,
    retros: [{
      id: 'rt_1', source: 'fleet', taskId: 'p-1', repo: 'ashlrai/widget', endKind: 'verify-failed', endedAt: NOW, taskKind: 'fix',
      asked: 'Fix flaky parser test', happened: 'Verification failed: 2 tests failed',
      rootCause: { code: 'verify:test', label: 'Tests failed', detail: '2 tests failed', evidence: 'verify output' },
      doDifferently: ['Run npm test before proposing.'], betterPrompt: 'Fix flaky parser test\n\nConstraints learned from the last attempt:\n- Run npm test.',
      candidates: 1, modelAssisted: false,
    }],
    endKinds: { 'verify-failed': 1 },
    causes: [{ code: 'verify:test', label: 'Tests failed', count: 3, bySource: { fleet: 2, cloud: 1, leader: 0 } }],
    windowDays: 30,
    knowledge: {
      pending: [note('kn_0000000000000001', 'Run npm test in widget before proposing parser fixes.', 'pending', { seen: 3 })],
      approved: [note('kn_0000000000000002', 'Widget parser PRs stay under 400 lines.', 'approved', { hits: 7 })],
      rejected: 0,
      approvedBytes: 40,
      capBytes: 16384,
    },
    playbook: [{ text: 'Mason vetoed the Leader\'s "Open 4 Grok lanes" (lane.set).', hits: 1, addedAt: NOW }],
    sweptAt: NOW,
    ...over,
  };
}

beforeEach(() => {
  evictAll();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
});

describe('LessonsPanel', () => {
  it('shows recurring causes, recent retros, suggestions and approved knowledge with hits', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/learning/lessons': lessons() } });
    render(<LessonsPanel />);
    await screen.findByRole('figure', { name: 'Recurring failure causes · 30d' });
    expect(await screen.findByText('Run npm test in widget before proposing parser fixes.')).toBeInTheDocument();
    expect(screen.getByText(/suggested 3×/)).toBeInTheDocument();
    expect(screen.getByText('Widget parser PRs stay under 400 lines.')).toBeInTheDocument();
    expect(screen.getByText(/used 7×/)).toBeInTheDocument();
    expect(screen.getByText(/Leader veto lesson/)).toBeInTheDocument();
    // A retro expands to its cause, next steps and better prompt.
    fireEvent.click(screen.getByRole('button', { name: /Fix flaky parser test/ }));
    expect(screen.getByText('Tests failed', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('Run npm test before proposing.')).toBeInTheDocument();
    expect(screen.getByText(/Constraints learned from the last attempt/)).toBeInTheDocument();
  });

  it('approve posts the decision with the held token', async () => {
    setMutationToken('a'.repeat(64));
    const stub = stubSurfaceFetch({ routes: { '/api/verse/learning/lessons': lessons() } });
    render(<LessonsPanel />);
    const text = await screen.findByText('Run npm test in widget before proposing parser fixes.');
    const row = text.closest('li')!;
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(stub.posted).toEqual([{ url: '/api/verse/learning/lessons/knowledge', body: { id: 'kn_0000000000000001', decision: 'approve' } }]));
  });

  it('edit then approve sends the edited text and scope', async () => {
    setMutationToken('b'.repeat(64));
    const stub = stubSurfaceFetch({ routes: { '/api/verse/learning/lessons': lessons() } });
    render(<LessonsPanel />);
    const row = (await screen.findByText('Run npm test in widget before proposing parser fixes.')).closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(row).getByLabelText('Lesson'), { target: { value: 'Always run npm test in widget.' } });
    fireEvent.change(within(row).getByLabelText('Task kinds'), { target: { value: '' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Approve edited' }));
    await waitFor(() => expect(stub.posted[0]?.body).toEqual({
      id: 'kn_0000000000000001', decision: 'approve', text: 'Always run npm test in widget.',
      scope: { repo: 'ashlrai/widget', pathGlobs: ['src/parser/**'], taskKinds: [] },
    }));
  });

  it('an older server without the route says so instead of breaking Growth', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/learning/lessons': null } });
    render(<LessonsPanel />);
    expect((await screen.findAllByText(/Lessons is not in this build yet/)).length).toBeGreaterThan(0);
  });
});

describe('lessons model', () => {
  it('causeChart stacks by source; parseScopeForm validates', () => {
    expect(causeChart(lessons().causes)).toEqual({ categories: ['Tests failed'], values: [[2, 1, 0]] });
    expect(parseScopeForm('', 'src/**, docs/*.md', 'fix, tests')).toEqual({ repo: null, pathGlobs: ['src/**', 'docs/*.md'], taskKinds: ['fix', 'tests'] });
    expect(parseScopeForm('not a repo', '', '')).toBeNull();
    expect(parseScopeForm('a/b', '../x', '')).toBeNull();
    expect(parseScopeForm('a/b', '', 'nonsense')).toBeNull();
    expect(narrowLessons({ v: 1 })).toBeNull();
    expect(narrowLessons(lessons())).not.toBeNull();
  });
});
