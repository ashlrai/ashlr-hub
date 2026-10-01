/**
 * ⌘K "Autonomy: …", "Approve grant…" and "Budget mode: …" run THROUGH
 * Command's AutonomyBar — against the real surface, the real authority and
 * budget reads, and the real POSTs — so the palette is pinned to the bar's
 * own rules: lowering is instant, raising past the grant opens the Touch ID
 * sheet and sends nothing, the grant ceiling clamps the budget, a missing
 * token asks for it first, and a surface that cannot act says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll, invalidate } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { CommandSection } from '../sections/CommandSection.js';
import { resetCommandBus } from '../shell/command-bus.js';
import { executeCatalogCommand, setShellNotifier } from '../shell/run-command.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { getVerseUiState, resetVerseUi, setVerseSection } from '../verse-ui-store.js';
import { stubSurfaceFetch } from './fetch-stub.test-support.js';
import { GrantScopeEditor } from './GrantScopeEditor.js';
import { GrantSheet } from './GrantSheet.js';
import type { EditableGrantDraft } from './GrantScopeEditor.js';
import type { SurfaceActions } from './actions.js';
import { SURFACE_KEYS } from './surface-data.js';
import { authorityStatus, budgetView, grantDraft } from './fixtures.test-support.js';

const TOKEN = 'a'.repeat(64);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

let vp: ViewportMock | null = null;
const notify = vi.fn();

beforeEach(() => {
  evictAll();
  resetActivityForTest();
  resetCommandBus();
  resetVerseUi();
  clearMutationToken();
  notify.mockReset();
  setShellNotifier(notify);
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  vp = mockWideViewport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  setShellNotifier(null);
  vp?.restore();
  vp = null;
});

async function ready() {
  await waitFor(() => expect(screen.getByTestId('verdict')).toHaveTextContent(/building|dark|Propose|unknown/));
}

function run(id: string) {
  act(() => {
    executeCatalogCommand(id, { via: 'palette' });
  });
}

describe('⌘K autonomy switch', () => {
  it('lowers at once from another surface: Command comes forward, the parked command runs, one POST', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live', post: () => json(authorityStatus('live', Date.now(), { switch: 'off', effectiveSwitch: 'off' })) });
    setVerseSection('chat');
    // Asked before Command has ever mounted: it parks until the bar registers.
    run('autonomy.off');
    expect(getVerseUiState().section).toBe('command');
    render(<CommandSection />);
    await waitFor(() => expect(posted).toEqual([{ url: '/api/verse/authority', body: { action: 'switch', to: 'off' } }]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('raising past the grant opens the Touch ID sheet and sends nothing', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'sparse' });
    render(<CommandSection />);
    await ready();
    run('autonomy.autonomous');
    expect(await screen.findByRole('dialog', { name: 'Approve a standing grant' })).toHaveTextContent(
      'Autonomous is beyond what the installed grant allows, so it needs a new grant.',
    );
    expect(posted).toEqual([]);
  });

  it('says it is already there instead of posting a no-op', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    run('autonomy.autonomous');
    expect(notify).toHaveBeenCalledWith('Autonomy is already Autonomous.', 'neutral');
    expect(posted).toEqual([]);
  });

  it('asks for the mutation token first when none is held', async () => {
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    run('autonomy.propose');
    expect(await screen.findByRole('dialog', { name: 'Unlock actions' })).toBeInTheDocument();
    expect(posted).toEqual([]);
  });

  it('says why when the authority service is not there, and changes nothing', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live', routes: { '/api/verse/authority': null } });
    render(<CommandSection />);
    await waitFor(() => expect(screen.getByTestId('verdict')).toBeInTheDocument());
    run('autonomy.off');
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/authority service is not in this build/), 'neutral'));
    expect(posted).toEqual([]);
  });
});

describe('⌘K Approve grant…', () => {
  it('opens the sheet when there is no grant', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'dark' });
    render(<CommandSection />);
    await ready();
    run('autonomy.grant');
    expect(await screen.findByRole('dialog', { name: 'Approve a standing grant' })).toBeInTheDocument();
    expect(posted).toEqual([]);
  });

  it('re-approves a paused grant', async () => {
    const now = Date.now();
    const live = authorityStatus('live', now);
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/authority': { ...live, grant: { ...live.grant, state: 'paused', reason: 'Authority code changed — re-approve.' } } } });
    render(<CommandSection />);
    await ready();
    run('autonomy.grant');
    expect(await screen.findByRole('dialog', { name: 'Re-approve the standing grant' })).toHaveTextContent('Authority code changed — re-approve.');
  });

  it('with an active grant weeks from expiry, says so rather than drafting a replacement', async () => {
    stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    run('autonomy.grant');
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^Grant active until /), 'neutral');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('⌘K Budget mode', () => {
  it('sets a mode inside the grant ceiling through the budget route', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live', post: (url) => (url === '/api/verse/budget' ? json({ ...budgetView('live'), mode: 'reserve' }) : undefined) });
    render(<CommandSection />);
    await ready();
    run('budget.reserve');
    await waitFor(() => expect(posted).toEqual([{ url: '/api/verse/budget', body: { mode: 'reserve' } }]));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Budget set to Reserve.', 'success'));
  });

  it('refuses a mode above the grant’s ceiling, naming the ceiling', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    run('budget.all-in');
    expect(notify).toHaveBeenCalledWith(
      'Your grant allows up to Balanced, so All-in is unavailable. A new grant can raise the ceiling.',
      'neutral',
    );
    expect(posted).toEqual([]);
  });

  it('says the mode is already set', async () => {
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    await waitFor(() => expect(screen.getByRole('button', { name: /Budget/ })).toHaveTextContent('Balanced'));
    run('budget.balanced');
    expect(notify).toHaveBeenCalledWith('Budget is already Balanced.', 'neutral');
    expect(posted).toEqual([]);
  });
});


describe('explicit signed volume editor choices', () => {
  const draft = () => ({ ...grantDraft(), editable: { repos: grantDraft().payload.repos.map((r) => r.nameWithOwner), engines: [...grantDraft().payload.engines], leaderClasses: ['A', 'B'], maxDays: 30, volumeLimits: true } });
  it('does not add volume opt-in when previewing unrelated legacy scope', () => {
    const preview = vi.fn();
    render(<GrantScopeEditor draft={draft()} busy={false} edited={false} onPreview={preview} onReset={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    expect(preview).toHaveBeenCalledOnce();
    expect(preview.mock.calls[0]![0]).not.toHaveProperty('maxFiles');
    expect(preview.mock.calls[0]![0]).not.toHaveProperty('repoMaxMergesPerDay');
  });
  it('sends no-cap as an explicit safe-integer choice and refuses fractional sizes', () => {
    const preview = vi.fn();
    const d = draft();
    render(<GrantScopeEditor draft={d} busy={false} edited={false} onPreview={preview} onReset={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Files per change'), { target: { value: '1.5' } });
    expect(screen.getByRole('button', { name: 'Preview the changes' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'No volume cap: Files per change' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'No volume cap: Lines per change' }));
    for (const r of d.payload.repos) fireEvent.click(screen.getByRole('checkbox', { name: `No volume cap: ${r.nameWithOwner} merges/day` }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ maxFiles: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER, repoMaxMergesPerDay: Object.fromEntries(d.payload.repos.map((r) => [r.nameWithOwner, Number.MAX_SAFE_INTEGER])) }));
  });
  it('hides unsupported volume edits on older servers', () => {
    const d = draft();
    delete (d.editable as { volumeLimits?: boolean }).volumeLimits;
    render(<GrantScopeEditor draft={d} busy={false} edited={false} onPreview={() => undefined} onReset={() => undefined} />);
    expect(screen.queryByLabelText('Files per change')).not.toBeInTheDocument();
  });
});


describe('explicit signed account policies', () => {
  const draft = () => {
    const d = grantDraft();
    return { ...d, editable: { repos: d.payload.repos.map((repo) => repo.nameWithOwner), engines: [...d.payload.engines], leaderClasses: ['A', 'B'], maxDays: 30, volumeLimits: true, seatPolicies: Object.fromEntries(Object.keys(d.payload.spend.seats).map((id) => [id, { roles: ['producer', 'judge', 'leader'] as import('../../../../core/authority/types.js').SeatRole[] }])) } };
  };
  it('preserves seat policy on unrelated all-in previews and hides edits for older servers', () => {
    const preview = vi.fn();
    const d = draft();
    const { rerender } = render(<GrantScopeEditor draft={d} busy={false} edited={false} onPreview={preview} onReset={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Budget mode up to'), { target: { value: 'all-in' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    expect(preview.mock.calls[0]![0]).not.toHaveProperty('seatPolicies');
    delete (d.editable as { seatPolicies?: unknown }).seatPolicies;
    rerender(<GrantScopeEditor draft={d} busy={false} edited={false} onPreview={preview} onReset={() => undefined} />);
    expect(screen.queryByLabelText(`${Object.keys(d.payload.spend.seats)[0]!}: reserve for you (%)`)).not.toBeInTheDocument();
  });
  it('sends only explicitly edited fields, and never opts into volume changes', () => {
    const preview = vi.fn();
    const d = draft();
    const id = Object.keys(d.payload.spend.seats)[0]!;
    render(<GrantScopeEditor draft={d} busy={false} edited={false} onPreview={preview} onReset={() => undefined} />);
    fireEvent.change(screen.getByLabelText(`${id}: reserve for you (%)`), { target: { value: '0' } });
    const noCeiling = screen.getByRole('checkbox', { name: `${id}: No session ceiling` });
    if ((noCeiling as HTMLInputElement).checked) fireEvent.click(noCeiling);
    fireEvent.click(noCeiling);
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ seatPolicies: { [id]: { reserveFloorPercent: 0, maxSessionWindowPercent: null } } }));
    expect(preview.mock.calls[0]![0]).not.toHaveProperty('maxFiles');
    expect(preview.mock.calls[0]![0]).not.toHaveProperty('repoMaxMergesPerDay');
  });
  it('refuses empty/fractional percentages, then previews enabled and role changes', () => {
    const preview = vi.fn();
    const d = draft();
    const id = Object.keys(d.payload.spend.seats)[0]!;
    render(<GrantScopeEditor draft={d} busy={false} edited={false} onPreview={preview} onReset={() => undefined} />);
    const reserve = screen.getByLabelText(`${id}: reserve for you (%)`);
    for (const value of ['', '0.5', '101']) {
      fireEvent.change(reserve, { target: { value } });
      expect(screen.getByRole('button', { name: 'Preview the changes' })).toBeDisabled();
    }
    fireEvent.change(reserve, { target: { value: '25' } });
    fireEvent.click(screen.getByRole('checkbox', { name: `Permit autonomy on ${id}` }));
    const role = screen.getByRole('checkbox', { name: `${id}: producer` });
    const wasProducer = (role as HTMLInputElement).checked;
    fireEvent.click(role);
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ seatPolicies: { [id]: { reserveFloorPercent: 25, enabled: !d.payload.spend.seats[id]!.enabled, roles: wasProducer ? d.payload.spend.seats[id]!.roles.filter((r) => r !== 'producer') : [...d.payload.spend.seats[id]!.roles, 'producer'] } } }));
  });
  it('offers read-only navigation to current account settings and Resources', () => {
    const account = vi.fn(); const resources = vi.fn(); const preview = vi.fn();
    render(<GrantScopeEditor draft={draft()} busy={false} edited={false} onPreview={preview} onReset={() => undefined} onAccountSettings={account} onResources={resources} />);
    fireEvent.click(screen.getByRole('button', { name: 'Current account settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resources' }));
    expect(account).toHaveBeenCalledOnce(); expect(resources).toHaveBeenCalledOnce(); expect(preview).not.toHaveBeenCalled();
  });
});


describe('grant approval requires the current preview', () => {
  function setup() {
    setMutationToken(TOKEN);
    const initial: EditableGrantDraft = { ...grantDraft(), kind: 'new', eliteDirect: false, digest: 'a'.repeat(64), editable: { repos: grantDraft().payload.repos.map((r) => r.nameWithOwner), engines: [...grantDraft().payload.engines], leaderClasses: ['A', 'B'], maxDays: 30, seatPolicies: { 'claude-a': { roles: ['producer', 'judge', 'leader'] } } } };
    let source = initial;
    const pending: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') return await new Promise<Response>((resolve) => pending.push(resolve));
      return json(source);
    });
    vi.stubGlobal('fetch', fetchMock);
    const approve = vi.fn();
    const guardedAction: SurfaceActions['act'] = (fn, _reason, options) => { void fn().then((result) => options?.onDone?.(result)); };
    render(<GrantSheet open intent="grant" then={null} busy={false} why="Review the account policy" onApprove={approve} onClose={() => undefined} act={guardedAction} startEditing />);
    const edited = (reserve: number, digest: string): EditableGrantDraft => {
      const next = structuredClone(source);
      next.digest = digest.repeat(64);
      next.payload.spend.seats['claude-a']!.reserveFloorPercent = reserve;
      next.diff = [{ field: 'seat-reserve', label: 'claude-a: reserve', before: '40%', after: `${reserve}%`, direction: 'wider' }];
      return next;
    };
    return { approve, pending, fetchMock, initial, edited, refresh: (next: EditableGrantDraft) => { source = next; invalidate(SURFACE_KEYS.authorityDraft); } };
  }
  it('keeps an untouched draft approvable, but a late preview cannot acknowledge newer choices', async () => {
    const h = setup();
    const approve = await screen.findByRole('button', { name: 'Approve with Touch ID' });
    await waitFor(() => expect(approve).toBeEnabled());
    const reserve = screen.getByLabelText('claude-a: reserve for you (%)');
    fireEvent.change(reserve, { target: { value: '0' } });
    expect(approve).toBeDisabled();
    fireEvent.click(approve); expect(h.approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(1));
    expect(approve).toBeDisabled();
    fireEvent.change(reserve, { target: { value: '25' } });
    await act(async () => h.pending[0]!(json(h.edited(0, 'b'))));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview the changes' })).toBeEnabled());
    expect(reserve).toHaveValue(25); expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(2));
    await act(async () => h.pending[1]!(json(h.edited(25, 'c'))));
    await waitFor(() => expect(approve).toBeEnabled());
    expect(screen.getByRole('cell', { name: '25%' })).toBeInTheDocument();
    fireEvent.click(approve);
    expect(h.approve).toHaveBeenCalledWith(expect.objectContaining({ digest: 'c'.repeat(64) }));
  });
  it('failed previews preserve choices and require explicit reset or a successful preview', async () => {
    const h = setup();
    const approve = await screen.findByRole('button', { name: 'Approve with Touch ID' });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.change(screen.getByLabelText('claude-a: reserve for you (%)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(1));
    await act(async () => h.pending[0]!(json({ error: 'Preview refused' }, 400)));
    await screen.findByText(/Preview refused/);
    expect(approve).toBeDisabled(); expect(screen.getByLabelText('claude-a: reserve for you (%)')).toHaveValue(0);
    fireEvent.click(screen.getByRole('button', { name: 'Back to the default draft' }));
    expect(screen.getByLabelText('claude-a: reserve for you (%)')).toHaveValue(40);
    expect(approve).toBeEnabled(); expect(h.approve).not.toHaveBeenCalled();
  });
  it('reset invalidates in-flight previews and a source refresh retains choices until re-preview', async () => {
    const h = setup();
    const approve = await screen.findByRole('button', { name: 'Approve with Touch ID' });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.change(screen.getByLabelText('claude-a: reserve for you (%)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Back to the default draft' }));
    await act(async () => h.pending[0]!(json(h.edited(0, 'b'))));
    expect(approve).toBeEnabled(); expect(screen.getByLabelText('claude-a: reserve for you (%)')).toHaveValue(40);
    fireEvent.change(screen.getByLabelText('claude-a: reserve for you (%)'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(2));
    await act(async () => h.pending[1]!(json(h.edited(25, 'c'))));
    await waitFor(() => expect(approve).toBeEnabled());
    await act(async () => h.refresh({ ...h.initial, digest: 'd'.repeat(64) }));
    await waitFor(() => expect(approve).toBeDisabled());
    expect(screen.getByLabelText('claude-a: reserve for you (%)')).toHaveValue(25);
    expect(h.approve).not.toHaveBeenCalled();
  });
});
