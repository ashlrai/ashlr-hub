/**
 * Playbooks (3.15) — the section against a stubbed server: the list, one
 * playbook with per-version outcomes and its rendered text, Run… writing the
 * `!macro` into the chat message, editing as a NEW version (with the base
 * version guard and field errors), the ⌘K "Run playbook…" hand-off, the ⋯
 * sheet's "Use playbook…", and the pure helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BUILTIN_PLAYBOOK_SOURCES } from '../../../../core/playbooks/builtins.js';
import { parsePlaybook } from '../../../../core/playbooks/parse.js';
import type { PlaybookDetailResponse, PlaybookSummary, PlaybookV1 } from '../../../../core/playbooks/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, TEST_TOKEN, type RecordedCall } from '../context/context-fixtures.test-support.js';
import { getVerseUiState, resetVerseUi } from '../verse-ui-store.js';
import { matchPlaybookMacros } from './macro-suggest.js';
import { withMacro } from './playbook-composer.js';
import { requestPlaybookFocus, resetPlaybookFocus } from './playbook-focus.js';
import { filterPlaybooks, PlaybooksView } from './PlaybooksView.js';
import { UsePlaybookAction } from './UsePlaybookAction.js';

const FIX_SOURCE = BUILTIN_PLAYBOOK_SOURCES[1]!;

function playbookFrom(source: string, version: number): PlaybookV1 {
  const parsed = parsePlaybook(source);
  if (!parsed.ok) throw new Error('fixture must parse');
  return { v: 1, meta: parsed.meta, sections: parsed.sections, version, sha: 'abcdefabcdef', source, createdAt: '2026-09-27T00:00:00.000Z', builtin: false };
}

const ROWS: PlaybookSummary[] = [
  { id: 'fix-issue', name: 'Fix a reported bug', macro: '!fix-bug', description: 'Reproduce, fix, prove it.', taskKinds: ['fix'], auto: false, latest: 2, builtin: false, updatedAt: '2026-09-27T00:00:00.000Z' },
  { id: 'docs-sync', name: 'Sync docs with the code', macro: '!docs-sync', description: 'Docs match the code.', taskKinds: ['docs'], auto: true, latest: 1, builtin: true, updatedAt: '2026-09-27T00:00:00.000Z' },
];

function detail(version: number): PlaybookDetailResponse {
  const source = version === 2 ? FIX_SOURCE.replace('Reproduce the bug', 'Reproduce the reported bug') : FIX_SOURCE;
  return {
    v: 1,
    playbook: playbookFrom(source, version),
    rendered: `## Playbook: Fix a reported bug (!fix-bug · fix-issue@v${version})\n\n### Outcome\n\nThe bug is gone (v${version}).`,
    versions: [
      { version: 1, sha: 'aaaaaaaaaaaa', createdAt: '2026-09-20T00:00:00.000Z', note: 'Shipped with ashlr', author: 'ashlr', outcomes: { merged: 3, refused: 1, reverted: 0, failed: 0, total: 4 } },
      { version: 2, sha: 'bbbbbbbbbbbb', createdAt: '2026-09-27T00:00:00.000Z', note: 'clearer repro step', author: 'mason', outcomes: { merged: 0, refused: 0, reverted: 1, failed: 2, total: 3 } },
    ],
  };
}

function server(over: { onPost?: (c: RecordedCall) => Response | undefined; list?: () => Response } = {}) {
  return installFetch((call) => {
    if (call.method === 'POST') return over.onPost?.(call) ?? json({ ok: true, playbook: playbookFrom(FIX_SOURCE, 3) });
    if (call.path === '/api/verse/playbooks') return over.list ? over.list() : json({ v: 1, playbooks: ROWS });
    if (call.path === '/api/verse/playbooks/fix-issue') return json(detail(2));
    if (call.path === '/api/verse/playbooks/fix-issue?version=1') return json(detail(1));
    if (call.path === '/api/verse/playbooks/docs-sync') return json({ ...detail(1), versions: [] });
    return json({ error: 'not found' }, 404);
  });
}

function composerBox(text = ''): HTMLTextAreaElement {
  const box = document.createElement('textarea');
  box.setAttribute('aria-label', 'Message');
  box.value = text;
  document.body.appendChild(box);
  return box;
}

beforeEach(() => {
  evictAll();
  resetVerseUi();
  resetPlaybookFocus();
  try { localStorage.clear(); } catch { /* jsdom */ }
  setMutationToken(TEST_TOKEN);
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
  document.querySelectorAll('textarea[aria-label="Message"]').forEach((n) => n.remove());
});

describe('helpers', () => {
  it('withMacro puts one macro at the front, replacing any other', () => {
    expect(withMacro('', '!fix-bug')).toBe('!fix-bug ');
    expect(withMacro('The parser crashes', '!fix-bug')).toBe('!fix-bug The parser crashes');
    expect(withMacro('!docs-sync update the README', '!fix-bug')).toBe('!fix-bug update the README');
    expect(withMacro('crash in a!b and x != y', '!fix-bug')).toBe('!fix-bug crash in a!b and x != y');
  });

  it('matches macros by prefix first, then by name', () => {
    expect(matchPlaybookMacros(ROWS, 'fix').map((r) => r.id)).toEqual(['fix-issue']);
    expect(matchPlaybookMacros(ROWS, 'docs').map((r) => r.id)).toEqual(['docs-sync']);
    expect(matchPlaybookMacros(ROWS, 'bug').map((r) => r.id)).toEqual(['fix-issue']);
    expect(matchPlaybookMacros(ROWS, '').map((r) => r.id)).toEqual(['fix-issue', 'docs-sync']);
  });

  it('filters the list by name, id, macro or description', () => {
    expect(filterPlaybooks(ROWS, '!docs').map((r) => r.id)).toEqual(['docs-sync']);
    expect(filterPlaybooks(ROWS, 'prove').map((r) => r.id)).toEqual(['fix-issue']);
    expect(filterPlaybooks(ROWS, '  ')).toHaveLength(2);
  });
});

describe('PlaybooksView', () => {
  it('lists playbooks and shows one with outcomes per version and its rendered text', async () => {
    server();
    render(<PlaybooksView />);
    const nav = await screen.findByRole('navigation', { name: 'Playbooks' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Fix a reported bug!fix-bug · v2',
      'Sync docs with the code!docs-sync · v1 · auto · built-in',
    ]);
    const table = await screen.findByRole('table', { name: 'Outcomes by version' });
    const rows = within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').slice(1, 5).map((c) => c.textContent));
    expect(rows).toEqual([['0', '0', '1', '2'], ['3', '1', '0', '0']]);
    expect(within(screen.getByLabelText('Rendered playbook')).getByText(/The bug is gone \(v2\)/)).toBeInTheDocument();
  });

  it('switching to an older version shows it and offers “Edit from v1”', async () => {
    server();
    render(<PlaybooksView />);
    fireEvent.change(await screen.findByLabelText('Version'), { target: { value: '1' } });
    expect(await screen.findByText(/The bug is gone \(v1\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit from v1' })).toBeInTheDocument();
  });

  it('Run… goes to Chat and writes the macro at the front of the message', async () => {
    server();
    const box = composerBox('The parser crashes on CRLF');
    render(<PlaybooksView />);
    await screen.findByRole('table', { name: 'Outcomes by version' });
    fireEvent.click(screen.getByRole('button', { name: 'Run…' }));
    await waitFor(() => expect(box.value).toBe('!fix-bug The parser crashes on CRLF'));
    expect(getVerseUiState().section).toBe('chat');
  });

  it('Edit saves a NEW version with the base version and a note', async () => {
    const posts: RecordedCall[] = [];
    server({ onPost: (c) => { posts.push(c); return undefined; } });
    render(<PlaybooksView />);
    await screen.findByRole('table', { name: 'Outcomes by version' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByLabelText('Playbook markdown');
    fireEvent.change(editor, { target: { value: (editor as HTMLTextAreaElement).value.replace('auto: false', 'auto: true') } });
    fireEvent.change(screen.getByLabelText('What changed (optional)'), { target: { value: 'auto-match fixes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save v3' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.path).toBe('/api/verse/playbooks');
    expect(posts[0]!.headers['x-ashlr-token']).toBe(TEST_TOKEN);
    expect(posts[0]!.body).toMatchObject({ baseVersion: 2, note: 'auto-match fixes' });
    expect(String((posts[0]!.body as { source: string }).source)).toContain('auto: true');
    expect(await screen.findByText('Saved fix-issue@v3.')).toBeInTheDocument();
  });

  it('validates as you type and shows the server’s field errors', async () => {
    server({ onPost: () => json({ ok: false, errors: [{ field: 'version', message: 'This playbook changed since you opened it (now v3).' }] }) });
    render(<PlaybooksView />);
    await screen.findByRole('table', { name: 'Outcomes by version' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByLabelText('Playbook markdown');
    const original = (editor as HTMLTextAreaElement).value;
    fireEvent.change(editor, { target: { value: original.replace('## Outcome', '## Vibes') } });
    expect(screen.getByRole('list', { name: 'Problems' })).toHaveTextContent(/Unknown section/);
    expect(screen.getByRole('button', { name: 'Save v3' })).toBeDisabled();
    fireEvent.change(editor, { target: { value: original.replace('auto: false', 'auto: true') } });
    fireEvent.click(screen.getByRole('button', { name: 'Save v3' }));
    expect(await screen.findByText(/changed since you opened it/)).toBeInTheDocument();
  });

  it('New playbook starts from the template and creates v1', async () => {
    const posts: RecordedCall[] = [];
    server({ onPost: (c) => { posts.push(c); return json({ ok: true, playbook: playbookFrom(String((c.body as { source: string }).source), 1) }); } });
    render(<PlaybooksView />);
    await screen.findByRole('navigation', { name: 'Playbooks' });
    fireEvent.click(screen.getByRole('button', { name: 'New playbook' }));
    expect((await screen.findByLabelText('Playbook markdown') as HTMLTextAreaElement).value).toContain('id: my-playbook');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).not.toHaveProperty('baseVersion');
    expect(await screen.findByText('Saved my-playbook@v1.')).toBeInTheDocument();
  });

  it('⌘K “Run playbook…” opens in pick-to-run mode with the filter focused', async () => {
    server();
    render(<PlaybooksView />);
    await screen.findByRole('navigation', { name: 'Playbooks' });
    act(() => requestPlaybookFocus({ kind: 'run' }));
    expect(await screen.findByText(/Pick a playbook and choose/)).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('Filter playbooks'));
    expect(getVerseUiState().section).toBe('playbooks');
  });

  it('says so when this server has no playbooks route', async () => {
    server({ list: () => json({ error: 'not found' }, 404) });
    render(<PlaybooksView />);
    expect(await screen.findByText('Playbooks are not in this build yet.')).toBeInTheDocument();
  });
});

describe('UsePlaybookAction (⋯ sheet)', () => {
  it('writes the chosen macro into the message', async () => {
    server();
    const box = composerBox('update the README');
    render(<UsePlaybookAction />);
    const select = await screen.findByLabelText('Use playbook');
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: '!docs-sync' } });
    expect(box.value).toBe('!docs-sync update the README');
    expect(screen.getByRole('status')).toHaveTextContent('!docs-sync is at the start of your message');
  });

  it('renders nothing on a server without playbooks', async () => {
    server({ list: () => json({ error: 'not found' }, 404) });
    const { container } = render(<UsePlaybookAction />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
