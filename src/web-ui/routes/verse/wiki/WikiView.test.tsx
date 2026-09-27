/**
 * Repo wiki (3.15) — the Wiki section against a stubbed server: repo picker,
 * freshness badge, page tree with stale marks, rendered pages whose
 * citations open the editor (token-gated) or GitHub, background builds,
 * Ask with cited answers / not-found, and the ⌘K hand-off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WikiAskResult, WikiPageView, WikiRepoView, WikiReposView, WikiStatus } from '../../../../core/knowledge/wiki/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, TEST_TOKEN, type RecordedCall } from '../context/context-fixtures.test-support.js';
import { resetVerseUi, getVerseUiState } from '../verse-ui-store.js';
import { WikiView } from './WikiView.js';
import { requestWikiFocus, resetWikiFocus } from './wiki-focus.js';
import { freshness, githubCitationUrl, jobLine, modelLabel, pageTree, repoForProject } from './wiki-model.js';

const KEY = 'notes-0123456789ab';
const OTHER = 'billing-ba9876543210';
const SHA = 'a'.repeat(40);

const reposView: WikiReposView = {
  repos: [
    { key: KEY, repo: '~/code/notes', name: 'notes', exists: true, generatedAt: '2026-09-27T00:00:00Z', commit: SHA, pages: 3, pending: 0, building: false },
    { key: OTHER, repo: '~/code/billing', name: 'billing', exists: false, generatedAt: null, commit: null, pages: 0, pending: 0, building: false },
  ],
};

function status(patch: Partial<WikiStatus> = {}): WikiStatus {
  return {
    repo: '~/code/notes',
    repoName: 'notes',
    key: KEY,
    exists: true,
    generatedAt: '2026-09-27T00:00:00Z',
    generatedCommit: SHA,
    currentCommit: SHA,
    pages: [
      { id: 'overview', title: 'Overview', kind: 'overview', stale: false, model: 'local:qwen', generatedAt: '' },
      { id: 'modules', title: 'Module map', kind: 'modules', stale: true, model: 'local:qwen', generatedAt: '' },
      { id: 'change-src-store', title: 'How to change src/store', kind: 'change', parent: 'modules', stale: false, model: 'facts-only', generatedAt: '' },
    ],
    stalePages: 1,
    pendingPages: 0,
    ...patch,
  };
}

function repoView(patch: Partial<WikiRepoView> = {}): WikiRepoView {
  return { status: status(), job: null, githubUrl: 'https://github.com/acme/notes', ...patch };
}

function pageView(id: string, markdown: string): WikiPageView {
  return {
    meta: { id, title: id, kind: 'overview', purpose: 'p', commit: SHA, generatedAt: '', model: 'local:qwen', citations: 2, droppedCitations: 1 },
    markdown,
  };
}

const OVERVIEW_MD = '# Overview\n\n> p\n\nNotes are saved by [src/store/notes.ts:5-6](#cite:src/store/notes.ts:5-6). See [Module map](#page:modules).\n';

function server(over: { repo?: () => WikiRepoView; ask?: WikiAskResult; onPost?: (c: RecordedCall) => void } = {}) {
  return installFetch((call) => {
    if (call.method === 'POST') over.onPost?.(call);
    if (call.path === '/api/verse/wiki') return json(reposView);
    if (call.path === `/api/verse/wiki/repo/${KEY}`) return json(over.repo ? over.repo() : repoView());
    if (call.path === `/api/verse/wiki/repo/${OTHER}`) return json(repoView({ status: status({ key: OTHER, exists: false, pages: [], stalePages: 0, generatedCommit: null }), githubUrl: null }));
    if (call.path === `/api/verse/wiki/repo/${KEY}/page/overview`) return json(pageView('overview', OVERVIEW_MD));
    if (call.path === `/api/verse/wiki/repo/${KEY}/page/modules`) return json(pageView('modules', '# Module map\n\n| Module |\n|---|\n| `src/store` |\n'));
    if (call.path === `/api/verse/wiki/repo/${KEY}/build`) return json({ job: { state: 'running', startedAt: '', finishedAt: null, progress: { index: 0, total: 0, page: null }, summary: null, error: null, trigger: 'operator' } }, 202);
    if (call.path === '/api/verse/wiki/open') return json({ ok: true });
    if (call.path === '/api/verse/wiki/ask' && over.ask) return json(over.ask);
    return json({ error: 'not found' }, 404);
  });
}

beforeEach(() => {
  evictAll();
  resetVerseUi();
  resetWikiFocus();
  try { localStorage.clear(); } catch { /* jsdom */ }
  setMutationToken(TEST_TOKEN);
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

describe('wiki-model', () => {
  it('orders the page tree depth-first with children under their parent', () => {
    expect(pageTree(status().pages).map((t) => `${t.depth}:${t.page.id}`)).toEqual(['0:overview', '0:modules', '1:change-src-store']);
  });

  it('words freshness, models, jobs and GitHub links', () => {
    expect(freshness(undefined)).toEqual({ text: 'Not built yet', tone: 'neutral' });
    expect(freshness(status())).toEqual({ text: 'Generated at aaaaaaa · 1 page stale', tone: 'warning' });
    expect(freshness(status({ stalePages: 0 })).tone).toBe('success');
    expect(modelLabel('facts-only')).toMatch(/no model/);
    expect(modelLabel('local:qwen3:27b')).toBe('qwen3:27b (local)');
    expect(githubCitationUrl('https://github.com/acme/notes', SHA, { file: 'src/a b.ts', line: 3, endLine: 5 })).toBe(`https://github.com/acme/notes/blob/${SHA}/src/a%20b.ts#L3-L5`);
    expect(githubCitationUrl('https://evil.example/x', SHA, { file: 'a', line: 1 })).toBeNull();
    expect(jobLine({ state: 'running', startedAt: '', finishedAt: null, progress: { index: 2, total: 9, page: 'modules' }, summary: null, error: null, trigger: 'operator' })).toBe('Building… 2 of 9 (modules)');
    expect(repoForProject(reposView.repos, '~/code/notes/')?.key).toBe(KEY);
    expect(repoForProject(reposView.repos, '/elsewhere/billing')?.key).toBe(OTHER);
  });
});

describe('WikiView', () => {
  it('shows the freshness badge, the tree with stale marks, and the rendered page', async () => {
    server();
    render(<WikiView />);
    expect(await screen.findByText('Generated at aaaaaaa · 1 page stale')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Wiki pages' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Overview', 'Module map', 'How to change src/store']);
    expect(within(nav).getByLabelText('stale')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'src/store/notes.ts:5-6' })).toBeInTheDocument();
    expect(screen.getByText(/1 unverifiable removed/)).toBeInTheDocument();
  });

  it('opens a citation in the editor through the token-gated route, and follows page links', async () => {
    const { calls } = server();
    render(<WikiView />);
    fireEvent.click(await screen.findByRole('link', { name: 'src/store/notes.ts:5-6' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/verse/wiki/open')).toBe(true));
    const open = calls.find((c) => c.path === '/api/verse/wiki/open')!;
    expect(open.body).toEqual({ repoKey: KEY, file: 'src/store/notes.ts', line: 5 });
    expect(open.headers['x-ashlr-token']).toBe(TEST_TOKEN);
    expect(await screen.findByText('Opened src/store/notes.ts:5-6 in your editor.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Module map' }));
    expect(await screen.findByRole('columnheader', { name: 'Module' })).toBeInTheDocument();
  });

  it('opens GitHub at the page commit when GitHub is chosen', async () => {
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    const { calls } = server();
    render(<WikiView />);
    fireEvent.click(await screen.findByRole('radio', { name: 'GitHub' }));
    fireEvent.click(await screen.findByRole('link', { name: 'src/store/notes.ts:5-6' }));
    expect(opened).toHaveBeenCalledWith(`https://github.com/acme/notes/blob/${SHA}/src/store/notes.ts#L5-L6`, '_blank', 'noopener,noreferrer');
    expect(calls.some((c) => c.path === '/api/verse/wiki/open')).toBe(false);
  });

  it('offers to build a repo that has no wiki, and starts a background job', async () => {
    const posts: RecordedCall[] = [];
    server({ onPost: (c) => posts.push(c) });
    render(<WikiView />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Repo' }), { target: { value: OTHER } });
    expect(await screen.findByText('No wiki for billing yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /cite/ })).toBeNull();
    // Build is on the known repo's route; switch back and refresh stale pages.
    fireEvent.change(screen.getByRole('combobox', { name: 'Repo' }), { target: { value: KEY } });
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh stale pages' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain(`/api/verse/wiki/repo/${KEY}/build`));
  });

  it('shows a running build and polls until it settles', async () => {
    let n = 0;
    server({
      repo: () => {
        n += 1;
        return repoView({
          job: n < 2
            ? { state: 'running', startedAt: '', finishedAt: null, progress: { index: 2, total: 5, page: 'modules' }, summary: null, error: null, trigger: 'operator' }
            : { state: 'done', startedAt: '', finishedAt: '', progress: { index: 5, total: 5, page: null }, summary: { startedAt: '', finishedAt: '', generated: 1, skippedFresh: 4, deferred: 0, failed: 0, estimatedTokens: 1, engine: 'local:qwen', budgetStop: null }, error: null, trigger: 'operator' },
        });
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<WikiView />);
      expect(await screen.findByText('Building… 2 of 5 (modules)')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(await screen.findByText(/Build finished: 1 written · 4 already fresh/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks the codebase and renders a cited answer with its sources', async () => {
    const ask: WikiAskResult = {
      question: 'how are notes saved', repo: '~/code/notes', repoKey: KEY, repoName: 'notes', alsoIn: [],
      status: 'answered', answer: 'Via SQLite [src/store/notes.ts:5](#cite:src/store/notes.ts:5).',
      sources: [{ repo: '~/code/notes', repoName: 'notes', file: 'src/store/notes.ts', line: 1, endLine: 8, via: 'index' }],
      engine: 'local:qwen', local: true, droppedCitations: 0,
    };
    const posts: RecordedCall[] = [];
    server({ ask, onPost: (c) => posts.push(c) });
    render(<WikiView />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'how are notes saved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    const card = await screen.findByLabelText('Answer');
    expect(within(card).getByText('Answer')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'src/store/notes.ts:5' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'src/store/notes.ts:1-8' })).toBeInTheDocument();
    expect(within(card).getByText('qwen (local)')).toBeInTheDocument();
    expect(posts.find((p) => p.path === '/api/verse/wiki/ask')!.body).toEqual({ question: 'how are notes saved', repoKey: KEY });
  });

  it('says not found plainly', async () => {
    server({
      ask: { question: 'q', repo: null, repoKey: null, repoName: null, alsoIn: [], status: 'not-found', answer: 'Not found: nothing covers this.', sources: [], engine: 'none', local: true, droppedCitations: 0 },
    });
    render(<WikiView />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Question' }), { target: { value: 'kubernetes?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    const card = await screen.findByLabelText('Answer');
    expect(within(card).getByText('Not found')).toBeInTheDocument();
    expect(within(card).getByText('Not found: nothing covers this.')).toBeInTheDocument();
  });

  it('takes the ⌘K hand-off: goes to the section, selects the repo, focuses Ask', async () => {
    server();
    requestWikiFocus({ kind: 'ask', projectPath: '~/code/billing' });
    expect(getVerseUiState().section).toBe('wiki');
    render(<WikiView />);
    expect(await screen.findByText('No wiki for billing yet')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Question' })).toHaveFocus());
  });

  it('explains an empty enrollment', async () => {
    installFetch((call) => (call.path === '/api/verse/wiki' ? json({ repos: [] }) : json({ error: 'nf' }, 404)));
    render(<WikiView />);
    expect(await screen.findByText('No enrolled repos')).toBeInTheDocument();
  });
});
