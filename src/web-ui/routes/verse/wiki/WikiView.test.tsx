/**
 * Repo wiki (3.15) — the Wiki section against a stubbed server: repo picker,
 * freshness badge, page tree with stale marks, rendered pages whose
 * citations open the editor (token-gated) or GitHub, background builds,
 * Ask with cited answers / not-found, and the ⌘K hand-off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WikiAskResult, WikiGraphView, WikiPageView, WikiRepoView, WikiReposView, WikiStatus } from '../../../../core/knowledge/wiki/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, TEST_TOKEN, type RecordedCall } from '../context/context-fixtures.test-support.js';
import { resetVerseUi, getVerseUiState } from '../verse-ui-store.js';
import { WikiGraphCanvas } from './WikiGraph.js';
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

const GRAPH: WikiGraphView = {
  repoKey: KEY, repoName: 'notes', commit: SHA, generatedAt: '2026-09-29T12:00:00Z',
  nodes: [
    { id: 'src/api', sourceFiles: 2, testFiles: 1, bytes: 100, files: [{ file: 'src/api/server.ts', line: 1, lines: 10 }], exports: [{ name: 'handle', kind: 'function', cite: { file: 'src/api/server.ts', line: 3 } }] },
    { id: 'src/store', sourceFiles: 1, testFiles: 0, bytes: 80, files: [{ file: 'src/store/notes.ts', line: 1, lines: 6 }], exports: [] },
  ],
  edges: [{ from: 'src/api', to: 'src/store', imports: 2, confidence: 'inferred' }],
  coverage: { listedFiles: 7, readFiles: 5, unreadFiles: 2, omittedModuleFiles: 1, listingTruncated: false },
};

function server(over: { repo?: () => WikiRepoView; ask?: WikiAskResult; onPost?: (c: RecordedCall) => void } = {}) {
  return installFetch((call) => {
    if (call.method === 'POST') over.onPost?.(call);
    if (call.path === '/api/verse/wiki') return json(reposView);
    if (call.path === `/api/verse/wiki/repo/${KEY}`) return json(over.repo ? over.repo() : repoView());
    if (call.path === `/api/verse/wiki/repo/${OTHER}`) return json(repoView({ status: status({ key: OTHER, exists: false, pages: [], stalePages: 0, generatedCommit: null }), githubUrl: null }));
    if (call.path === `/api/verse/wiki/repo/${KEY}/graph` || call.path === `/api/verse/wiki/repo/${OTHER}/graph`) return json(GRAPH);
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
  it('opens a local module map before a wiki is built and sends verified citations through the token gate', async () => {
    const { calls } = server();
    render(<WikiView />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Repo' }), { target: { value: OTHER } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Wiki view' })).getByRole('button', { name: 'Module map' }));
    const map = await screen.findByRole('region', { name: 'Codebase module map' });
    expect(within(map).getByText('Partial coverage: 5 of 7 listed files read')).toBeInTheDocument();
    expect(calls.some((c) => c.path === `/api/verse/wiki/repo/${OTHER}/graph`)).toBe(true);
    fireEvent.click(within(map).getByRole('button', { name: 'handle' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/verse/wiki/open')).toBe(true));
    const open = calls.find((c) => c.path === '/api/verse/wiki/open')!;
    expect(open.body).toEqual({ repoKey: OTHER, file: 'src/api/server.ts', line: 3 });
    expect(open.headers['x-ashlr-token']).toBe(TEST_TOKEN);
  });

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


describe('WikiGraphCanvas', () => {
  it('opens checked import lines in both dependency directions and discloses evidence sampling', () => {
    const cite = vi.fn();
    const graph: WikiGraphView = { ...GRAPH, edges: [{ ...GRAPH.edges[0]!, citations: [{ file: 'src/api/server.ts', line: 2 }], omittedCitations: 3, droppedCitations: 1 }], coverage: { ...GRAPH.coverage, importEvidence: { unresolvedLocalImports: 2, unsupportedSourceFiles: 1, checkedCitations: 1, omittedCitations: 3, droppedCitations: 1, omittedModuleImports: 2 } } };
    render(<WikiGraphCanvas graph={graph} onCite={cite} />);
    const detail = screen.getByRole('complementary', { name: 'Selected module' });
    fireEvent.click(within(detail).getByRole('button', { name: 'Open import src/api/server.ts:2' }));
    expect(cite).toHaveBeenCalledWith({ file: 'src/api/server.ts', line: 2 }, SHA);
    expect(within(detail).getByText(/additional import references are outside/)).toBeInTheDocument();
    expect(within(detail).getByText(/failed the file or line check/)).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'src/store' }));
    fireEvent.click(within(detail).getByRole('button', { name: 'Open import src/api/server.ts:2' }));
    expect(cite).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('2 detected local import references could not be resolved');
    expect(screen.getByText(/1 read source files use languages without supported/)).toBeInTheDocument();
    expect(screen.getByText(/Pattern matches can include comments or strings/)).toBeInTheDocument();
  });

  it('treats old import evidence as unavailable rather than zero unresolved dependencies', () => {
    render(<WikiGraphCanvas graph={GRAPH} onCite={vi.fn()} />);
    expect(screen.getByText(/Missing evidence does not mean zero unresolved imports/)).toBeInTheDocument();
    expect(screen.getByText('Import line evidence unavailable; refresh the map.')).toBeInTheDocument();
    expect(screen.queryByText(/Detected local imports in read sources: 0 unresolved/)).not.toBeInTheDocument();
  });

  it('searches modules by exported symbols, follows dependency buttons, and preserves exact citations', () => {
    const cite = vi.fn();
    render(<WikiGraphCanvas graph={GRAPH} onCite={cite} />);
    const detail = screen.getByRole('complementary', { name: 'Selected module' });
    expect(within(detail).getByRole('heading', { name: 'src/api' })).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'src/store' }));
    expect(within(detail).getByRole('heading', { name: 'src/store' })).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'src/store/notes.ts:1' }));
    expect(cite).toHaveBeenCalledWith({ file: 'src/store/notes.ts', line: 1 }, SHA);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a module' }), { target: { value: 'handle' } });
    expect(screen.getByText('1 of 2 modules')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'handle' }));
    expect(cite).toHaveBeenLastCalledWith({ file: 'src/api/server.ts', line: 3 }, SHA);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a module' }), { target: { value: 'nothing matches' } });
    expect(screen.getByRole('status')).toHaveTextContent('No matching modules');
  });

  it('explains an empty scan and offers an explicit refresh', () => {
    const refresh = vi.fn();
    render(<WikiGraphCanvas graph={{ ...GRAPH, nodes: [], edges: [] }} onCite={vi.fn()} onRefresh={refresh} />);
    expect(screen.getByRole('status')).toHaveTextContent('No readable modules');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh map' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('distinguishes a failed listing from an empty readable repo', () => {
    render(<WikiGraphCanvas graph={{ ...GRAPH, nodes: [], edges: [], coverage: { ...GRAPH.coverage, listedFiles: 0, readFiles: 0, listingIncomplete: true } }} onCite={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('listing could not be completed');
    expect(screen.getByText('Partial coverage: 0 of 0 listed files read')).toBeInTheDocument();
  });
});
