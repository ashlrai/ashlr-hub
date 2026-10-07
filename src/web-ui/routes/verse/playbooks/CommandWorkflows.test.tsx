/**
 * Command workflows (3.15, `kind: command` playbooks) in Verse: the fill form
 * (one field per `{{param}}`, prefilled defaults, a live preview, values as
 * one quoted shell word, control characters refused), the terminal's
 * self-contained picker (onPaste then onClose; Escape steps back), the
 * Playbooks section (Command badge, Use… → paste into the chat's Terminal
 * pane via the dock store — never run; disabled with no chat open), the ⌘K
 * fallback, and command workflows kept out of the `!macro` surfaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { parsePlaybook } from '../../../../core/playbooks/parse.js';
import type { PlaybookDetailResponse, PlaybookSummary, PlaybookV1 } from '../../../../core/playbooks/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json, TEST_TOKEN } from '../context/context-fixtures.test-support.js';
import { getDockSnapshot, resetDockStore } from '../dock/dock-store.js';
import { findCommand } from '../shell/command-catalog.js';
import { resetCommandBus, runCommand } from '../shell/command-bus.js';
import { registerShellCommandHandlers } from '../shell/run-command.js';
import { getVerseUiState, resetVerseUi, setVerseActiveSession } from '../verse-ui-store.js';
import { commandPasteUnavailableReason } from './command-workflow-paste.js';
import { CommandWorkflowForm } from './CommandWorkflowForm.js';
import { CommandWorkflowPicker, commandWorkflowRows } from './CommandWorkflowPicker.js';
import { matchPlaybookMacros } from './macro-suggest.js';
import { resetPlaybookFocus } from './playbook-focus.js';
import { PlaybooksView } from './PlaybooksView.js';
import { UsePlaybookAction } from './UsePlaybookAction.js';

const TEMPLATE = 'git switch -c {{branch}} && git push -u {{remote:origin}} {{branch}}';
const PARAMS = [{ name: 'branch', default: null }, { name: 'remote', default: 'origin' }];
const SOURCE = `---\nid: new-branch\nname: New branch\ndescription: Branch off and push.\nkind: command\n---\n\n## Command\n\n\`\`\`sh\n${TEMPLATE}\n\`\`\`\n`;

const ROWS: PlaybookSummary[] = [
  {
    id: 'new-branch', name: 'New branch', macro: '!new-branch', description: 'Branch off and push.', taskKinds: [], auto: false, latest: 1, builtin: false,
    updatedAt: '2026-09-27T00:00:00.000Z', kind: 'command', command: { template: TEMPLATE, params: PARAMS },
  },
  {
    id: 'tail-logs', name: 'Tail service logs', macro: '!tail-logs', description: '', taskKinds: [], auto: false, latest: 2, builtin: false,
    updatedAt: '2026-09-27T00:00:00.000Z', kind: 'command', command: { template: 'kubectl logs -f {{pod}} -n {{ns:default}}', params: [{ name: 'pod', default: null }, { name: 'ns', default: 'default' }] },
  },
  // An older server's row: no kind ⇒ an agent playbook.
  { id: 'fix-issue', name: 'Fix a reported bug', macro: '!fix-bug', description: 'Reproduce, fix, prove it.', taskKinds: ['fix'], auto: false, latest: 1, builtin: true, updatedAt: '2026-09-27T00:00:00.000Z' },
];

function detail(): PlaybookDetailResponse {
  const parsed = parsePlaybook(SOURCE);
  if (!parsed.ok) throw new Error('fixture must parse');
  const playbook: PlaybookV1 = { v: 1, meta: parsed.meta, sections: parsed.sections, version: 1, sha: 'abcdefabcdef', source: SOURCE, createdAt: '2026-09-27T00:00:00.000Z', builtin: false };
  return {
    v: 1,
    playbook,
    rendered: `## Command workflow: New branch\n\n\`\`\`sh\n${TEMPLATE}\n\`\`\``,
    versions: [{ version: 1, sha: 'abcdefabcdef', createdAt: '2026-09-27T00:00:00.000Z', note: null, author: 'mason', outcomes: { merged: 0, refused: 0, reverted: 0, failed: 0, total: 0 } }],
  };
}

function server(rows: PlaybookSummary[] = ROWS) {
  return installFetch((call) => {
    if (call.path === '/api/verse/playbooks') return json({ v: 1, playbooks: rows });
    if (call.path === '/api/verse/playbooks/new-branch') return json(detail());
    return json({ error: 'not found' }, 404);
  });
}

beforeEach(() => {
  evictAll();
  resetVerseUi();
  resetDockStore();
  resetPlaybookFocus();
  resetCommandBus();
  try { localStorage.clear(); } catch { /* jsdom */ }
  setMutationToken(TEST_TOKEN);
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

const preview = () => screen.getByText((_, el) => el?.tagName === 'CODE' && el.parentElement?.tagName === 'PRE');

describe('CommandWorkflowForm', () => {
  it('shows one labelled field per param, prefilled with defaults, and previews live', () => {
    const onPaste = vi.fn();
    render(<CommandWorkflowForm name="New branch" template={TEMPLATE} params={PARAMS} onPaste={onPaste} />);
    expect(screen.getByLabelText('branch')).toHaveValue('');
    expect(screen.getByLabelText('remote')).toHaveValue('origin');
    expect(preview()).toHaveTextContent('git switch -c <branch> && git push -u origin <branch>');
    // A required field left empty blocks the paste, and says why.
    expect(screen.getByRole('button', { name: 'Paste in terminal' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Fill in branch.');

    fireEvent.change(screen.getByLabelText('branch'), { target: { value: 'feat/x' } });
    expect(preview()).toHaveTextContent('git switch -c feat/x && git push -u origin feat/x');
    fireEvent.click(screen.getByRole('button', { name: 'Paste in terminal' }));
    expect(onPaste).toHaveBeenCalledWith('git switch -c feat/x && git push -u origin feat/x');
  });

  it('quotes injection attempts as one literal word — preview and paste agree', () => {
    const onPaste = vi.fn();
    render(<CommandWorkflowForm name="New branch" template={TEMPLATE} params={PARAMS} onPaste={onPaste} />);
    fireEvent.change(screen.getByLabelText('branch'), { target: { value: 'x; rm -rf ~ $(whoami) `id`' } });
    const expected = "git switch -c 'x; rm -rf ~ $(whoami) `id`' && git push -u origin 'x; rm -rf ~ $(whoami) `id`'";
    expect(preview()).toHaveTextContent(expected, { normalizeWhitespace: false });
    fireEvent.click(screen.getByRole('button', { name: 'Paste in terminal' }));
    expect(onPaste).toHaveBeenCalledWith(expected);
  });

  it('refuses a control character instead of pasting it', () => {
    const onPaste = vi.fn();
    render(<CommandWorkflowForm name="New branch" template={TEMPLATE} params={PARAMS} onPaste={onPaste} />);
    fireEvent.change(screen.getByLabelText('branch'), { target: { value: 'main\tx' } });
    expect(screen.getByRole('button', { name: 'Paste in terminal' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/line break, tab or control character/);
    fireEvent.submit(screen.getByRole('form', { name: 'Fill New branch' }));
    expect(onPaste).not.toHaveBeenCalled();
  });

  it('a disabled reason from the caller wins', () => {
    render(<CommandWorkflowForm name="x" template="ls {{dir:.}}" params={[{ name: 'dir', default: '.' }]} onPaste={vi.fn()} pasteDisabledReason="Open a chat first." />);
    expect(screen.getByRole('button', { name: 'Paste in terminal' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Open a chat first.');
  });
});

describe('CommandWorkflowPicker', () => {
  it('lists only command workflows, fills one, pastes, then closes', async () => {
    server();
    const onPaste = vi.fn();
    const onClose = vi.fn();
    render(<CommandWorkflowPicker onPaste={onPaste} onClose={onClose} />);
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('button').map((b) => b.querySelector('span')?.textContent)).toEqual(['New branch', 'Tail service logs']);

    fireEvent.change(screen.getByLabelText('Filter command workflows'), { target: { value: 'kubectl' } });
    fireEvent.click(within(screen.getByRole('list')).getByRole('button'));
    fireEvent.change(screen.getByLabelText('pod'), { target: { value: 'api-7f9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Paste in terminal' }));
    expect(onPaste).toHaveBeenCalledWith('kubectl logs -f api-7f9 -n default');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape steps back from the form, then closes', async () => {
    server();
    const onClose = vi.fn();
    render(<CommandWorkflowPicker onPaste={vi.fn()} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /New branch/ }));
    expect(screen.getByLabelText('branch')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('branch'), { key: 'Escape' });
    expect(await screen.findByLabelText('Filter command workflows')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('Filter command workflows'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says how to make one when there are none', async () => {
    server([ROWS[2]!]);
    const onClose = vi.fn();
    render(<CommandWorkflowPicker onPaste={vi.fn()} onClose={onClose} />);
    expect(await screen.findByText(/No command workflows yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Playbooks' }));
    expect(getVerseUiState().section).toBe('playbooks');
    expect(onClose).toHaveBeenCalled();
  });

  it('commandWorkflowRows keeps only well-formed command rows', () => {
    expect(commandWorkflowRows(ROWS).map((r) => r.id)).toEqual(['new-branch', 'tail-logs']);
    expect(commandWorkflowRows([{ ...ROWS[0]!, command: undefined }])).toEqual([]);
    expect(commandWorkflowRows(null)).toEqual([]);
  });
});

describe('PlaybooksView with command workflows', () => {
  it('badges them, and Use… pastes the filled command into the chat terminal — never run', async () => {
    server();
    localStorage.setItem('verse.playbooks.selected', 'new-branch');
    setVerseActiveSession('chat-1');
    render(<PlaybooksView />);
    const nav = await screen.findByRole('navigation', { name: 'Playbooks' });
    expect(within(nav).getAllByRole('button')[0]).toHaveTextContent('New branchCommand · v1');
    expect(within(nav).getAllByRole('button')[2]).toHaveTextContent('Fix a reported bug!fix-bug · v1 · built-in');
    expect(await screen.findByLabelText('Rendered playbook')).toHaveTextContent(/Command workflow: New branch/);
    expect(screen.queryByRole('table', { name: 'Outcomes by version' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Use…' }));
    fireEvent.change(await screen.findByLabelText('branch'), { target: { value: 'fix/login' } });
    fireEvent.click(screen.getByRole('button', { name: 'Paste in terminal' }));

    const request = getDockSnapshot().requests.terminal;
    expect(request?.paste).toBe('git switch -c fix/login && git push -u origin fix/login');
    expect(request?.paste).not.toMatch(/\n$/);
    expect(getDockSnapshot().state).toMatchObject({ open: true, active: 'terminal' });
    expect(getVerseUiState().section).toBe('chat');
  });

  it('with no chat open, Paste is disabled and says why', async () => {
    server();
    localStorage.setItem('verse.playbooks.selected', 'new-branch');
    render(<PlaybooksView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use…' }));
    fireEvent.change(await screen.findByLabelText('branch'), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Paste in terminal' })).toBeDisabled();
    expect(screen.getByText(/Open a chat first/)).toBeInTheDocument();
    expect(getDockSnapshot().requests.terminal).toBeNull();
  });

  it('New command workflow starts from the command template', async () => {
    server();
    render(<PlaybooksView />);
    fireEvent.click(await screen.findByRole('button', { name: 'New command workflow' }));
    const editor = await screen.findByLabelText('Playbook markdown') as HTMLTextAreaElement;
    expect(editor.value).toContain('kind: command');
    expect(editor.value).toContain('## Command');
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
  });

  it('⌘K “Run command workflow…” falls back to Playbooks narrowed to command workflows', async () => {
    server();
    expect(findCommand('terminal.workflows')).toMatchObject({ title: 'Run command workflow…', group: 'actions', scope: 'global' });
    const off = registerShellCommandHandlers();
    render(<PlaybooksView />);
    await screen.findByRole('navigation', { name: 'Playbooks' });
    act(() => { expect(runCommand('terminal.workflows')).toBe(true); });
    expect(await screen.findByText(/Pick a command workflow and choose/)).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Playbooks' });
    await waitFor(() => expect(within(nav).getAllByRole('button').map((b) => b.querySelector('span')?.textContent)).toEqual(['New branch', 'Tail service logs']));
    expect(getVerseUiState().section).toBe('playbooks');
    off();
  });
});

describe('command workflows stay out of the !macro surfaces', () => {
  it('the composer’s ! menu never offers one', () => {
    expect(matchPlaybookMacros(ROWS, '').map((r) => r.id)).toEqual(['fix-issue']);
    expect(matchPlaybookMacros(ROWS, 'new').map((r) => r.id)).toEqual([]);
  });

  it('“Use playbook…” in the ⋯ sheet lists agent playbooks only', async () => {
    server();
    render(<UsePlaybookAction />);
    const select = await screen.findByLabelText('Use playbook');
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Use playbook…', 'Fix a reported bug (!fix-bug)']);
  });

  it('commandPasteUnavailableReason explains what is missing', () => {
    expect(commandPasteUnavailableReason({ activeSessionId: null, terminalLanded: true })).toMatch(/Open a chat first/);
    expect(commandPasteUnavailableReason({ activeSessionId: 's', terminalLanded: false })).toMatch(/no Phantom terminal/);
    expect(commandPasteUnavailableReason({ activeSessionId: 's', terminalLanded: true })).toBeNull();
  });
});
