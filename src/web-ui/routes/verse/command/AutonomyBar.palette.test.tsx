/**
 * ⌘K "Autonomy: …", "Approve grant…" and "Budget mode: …" run THROUGH
 * Command's AutonomyBar — against the real surface, the real authority and
 * budget reads, and the real POSTs — so the palette is pinned to the bar's
 * own rules: lowering is instant, raising past the grant opens the Touch ID
 * sheet and sends nothing, the grant ceiling clamps the budget, a missing
 * token asks for it first, and a surface that cannot act says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { DraftScope, GrantSheet } from './GrantSheet.js';
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
  it('shows pending approval and an inline refusal, then permits a deliberate retry after settlement', async () => {
    setMutationToken(TOKEN);
    const now = Date.now();
    const { posted, fetchMock } = stubSurfaceFetch({ kind: 'dark', now, post: () => json(authorityStatus('live', now)) });
    const original = fetchMock.getMockImplementation() as typeof fetch;
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    fetchMock.mockImplementation(async (input, init) => {
      const result = original(input, init);
      return init?.method === 'POST' && posted.length === 1 ? pending : result;
    });
    render(<CommandSection />);
    await ready();
    run('autonomy.grant');
    const sheet = await screen.findByRole('dialog', { name: 'Approve a standing grant' });
    const approve = within(sheet).getByRole('button', { name: 'Approve with Touch ID' });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    expect(await within(sheet).findByRole('status')).toHaveTextContent('Waiting for the result. Complete any Mac authentication prompt; signing has a three-minute timeout. Closing this dialog does not cancel approval.');
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(posted).toEqual([{ url: '/api/verse/authority', body: { action: 'grant', draftDigest: grantDraft(now).digest } }]);
    expect(within(sheet).getByRole('button', { name: 'Close dialog' })).toBeEnabled();
    await act(async () => { finish(json({ code: 'not-signed', error: 'Mac approval timed out.' }, 409)); });
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Mac approval timed out.');
    expect(within(sheet).queryByText(/Waiting for the result/)).toBeNull();
    expect(approve).toBeEnabled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Dismiss' }));
    expect(within(sheet).queryByRole('alert')).toBeNull();
    fireEvent.click(approve);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Approve a standing grant' })).toBeNull());
    expect(posted.map(entry => entry.body)).toEqual([
      { action: 'grant', draftDigest: grantDraft(now).digest },
      { action: 'grant', draftDigest: grantDraft(now).digest },
    ]);
  });

  it('closes the pending view without cancelling or replaying the approval request', async () => {
    setMutationToken(TOKEN);
    const { posted, fetchMock } = stubSurfaceFetch({ kind: 'dark' });
    const original = fetchMock.getMockImplementation() as typeof fetch;
    let finish!: (response: Response) => void;
    let signingRequest: RequestInit | undefined;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    fetchMock.mockImplementation(async (input, init) => {
      const result = original(input, init);
      if (init?.method !== 'POST') return result;
      signingRequest = init;
      return pending;
    });
    render(<CommandSection />);
    await ready();
    run('autonomy.grant');
    const sheet = await screen.findByRole('dialog', { name: 'Approve a standing grant' });
    const approve = within(sheet).getByRole('button', { name: 'Approve with Touch ID' });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    await within(sheet).findByRole('status');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog', { name: 'Approve a standing grant' })).toBeNull();
    expect(signingRequest?.signal?.aborted).not.toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body.action).toBe('grant');
    expect(screen.queryByText(/approval cancelled/i)).toBeNull();
    await act(async () => { finish(json(authorityStatus('live', Date.now()))); });
    expect(posted).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Approve a standing grant' })).toBeNull();
  });

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


describe('explicit starting-stage Leader choices', () => {
  function draft(): EditableGrantDraft {
    const d = grantDraft();
    return { ...d, editable: { repos: d.payload.repos.map((r) => r.nameWithOwner), engines: [...d.payload.engines], leaderClasses: ['A', 'B'], maxDays: 30, startingStageLeaderClasses: { stageId: d.payload.rollout.stages[0]!.id, classes: ['A', 'B'] } } };
  }
  it('omits untouched starting permissions and hides the control for older servers', () => {
    const d = draft(); const preview = vi.fn();
    const { rerender } = render(<GrantScopeEditor draft={d} busy={false} edited={false} onPreview={preview} onReset={() => undefined} />);
    expect(screen.getByRole('checkbox', { name: 'Starting stage class A' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    expect(preview.mock.calls[0]![0]).not.toHaveProperty('startingStageLeaderClasses');
    delete d.editable!.startingStageLeaderClasses;
    rerender(<GrantScopeEditor draft={d} busy={false} edited={false} onPreview={preview} onReset={() => undefined} />);
    expect(screen.queryByRole('checkbox', { name: 'Starting stage class A' })).not.toBeInTheDocument();
  });
  it('sends only an explicit stage-bound selection and requires the global ceiling', () => {
    const d = draft(); const preview = vi.fn();
    render(<GrantScopeEditor draft={d} busy={false} edited={false} onPreview={preview} onReset={() => undefined} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Starting stage class A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ startingStageLeaderClasses: { stageId: d.payload.rollout.stages[0]!.id, classes: ['A'] } }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Class A — reversible housekeeping' }));
    expect(screen.getByRole('checkbox', { name: 'Starting stage class A' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Starting stage class A' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ startingStageLeaderClasses: { stageId: d.payload.rollout.stages[0]!.id, classes: [] } }));
  });
  it('holds an explicit choice when the starting-stage identity changes', () => {
    const d = draft(); const preview = vi.fn();
    const { rerender } = render(<GrantScopeEditor draft={d} busy={false} edited={false} onPreview={preview} onReset={() => undefined} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Starting stage class A' }));
    const next = structuredClone(d);
    next.payload.rollout.stages[0]!.id = 'elite-direct';
    next.editable!.startingStageLeaderClasses!.stageId = 'elite-direct';
    rerender(<GrantScopeEditor draft={next} busy={false} edited={false} onPreview={preview} onReset={() => undefined} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The starting stage changed');
    expect(screen.getByRole('button', { name: 'Preview the changes' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    expect(preview).not.toHaveBeenCalled();
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
    const initial: EditableGrantDraft = { ...grantDraft(), kind: 'new', eliteDirect: false, digest: 'a'.repeat(64), editable: { repos: grantDraft().payload.repos.map((r) => r.nameWithOwner), engines: [...grantDraft().payload.engines], leaderClasses: ['A', 'B'], maxDays: 30, volumeLimits: true, startingStageLeaderClasses: { stageId: grantDraft().payload.rollout.stages[0]!.id, classes: ['A', 'B'] }, seatPolicies: { 'claude-a': { roles: ['producer', 'judge', 'leader'] } } } };
    let source = initial;
    const pending: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') return await new Promise<Response>((resolve) => pending.push(resolve));
      if (String(input).includes('eliteDirect=1')) return json({ ...source, eliteDirect: true, digest: 'f'.repeat(64) });
      return json(source);
    });
    vi.stubGlobal('fetch', fetchMock);
    const approve = vi.fn();
    const guardedAction: SurfaceActions['act'] = (fn, _reason, options) => { void fn().then((result) => options?.onDone?.(result)); };
    const view = render(<GrantSheet open intent="grant" then={null} busy={false} why="Review the account policy" onApprove={approve} onClose={() => undefined} act={guardedAction} startEditing />);
    const edited = (reserve: number, digest: string): EditableGrantDraft => {
      const next = structuredClone(source);
      next.digest = digest.repeat(64);
      next.payload.spend.seats['claude-a']!.reserveFloorPercent = reserve;
      next.diff = [{ field: 'seat-reserve', label: 'claude-a: reserve', before: '40%', after: `${reserve}%`, direction: 'wider' }];
      return next;
    };
    return { approve, pending, fetchMock, initial, edited, setBusy: (busy: boolean) => view.rerender(<GrantSheet open intent="grant" then={null} busy={busy} why="Review the account policy" onApprove={approve} onClose={() => undefined} act={guardedAction} startEditing />), refresh: (next: EditableGrantDraft) => { source = next; invalidate(SURFACE_KEYS.authorityDraft); } };
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
    h.setBusy(true);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing the grant preview…');
    expect(screen.queryByText(/Mac authentication prompt|three-minute timeout/)).toBeNull();
    expect(h.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url)).toEqual(['/api/verse/authority/draft']);
    expect(h.approve).not.toHaveBeenCalled();
    h.setBusy(false);
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
  it('keeps unpreviewed choices and explicit field flags across Hide/Open', async () => {
    const h = setup();
    const approve = await screen.findByRole('button', { name: 'Approve with Touch ID' });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.change(screen.getByLabelText('claude-a: reserve for you (%)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'No volume cap: Files per change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide the scope editor' }));
    expect(screen.queryByRole('button', { name: 'Preview the changes' })).not.toBeInTheDocument();
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit scope' }));
    expect(screen.getByLabelText('claude-a: reserve for you (%)')).toHaveValue(0);
    expect(screen.getByRole('checkbox', { name: 'No volume cap: Files per change' })).toBeChecked();
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(1));
    const posted = h.fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1];
    expect(JSON.parse(posted!.body as string).scope).toMatchObject({ maxFiles: Number.MAX_SAFE_INTEGER, seatPolicies: { 'claude-a': { reserveFloorPercent: 0 } } });
    await act(async () => h.pending[0]!(json(h.edited(0, 'b'))));
  });
  it('keeps stage choices across Hide/Open, requires a fresh preview and clears the opt-in on Reset', async () => {
    const h = setup();
    const approve = await screen.findByRole('button', { name: 'Approve with Touch ID' });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Starting stage class A' }));
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Hide the scope editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit scope' }));
    expect(screen.getByRole('checkbox', { name: 'Starting stage class A' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(1));
    const posted = h.fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1];
    expect(JSON.parse(posted!.body as string).scope.startingStageLeaderClasses).toEqual({ stageId: h.initial.payload.rollout.stages[0]!.id, classes: ['A'] });
    const reviewed = h.edited(40, 'b');
    reviewed.payload.rollout.stages[0]!.leaderClasses = ['A'];
    reviewed.diff = [{ field: 'stage-leader', label: 'Starting Leader permissions', before: 'none', after: 'A', direction: 'wider' }];
    await act(async () => h.pending[0]!(json(reviewed)));
    await waitFor(() => expect(approve).toBeEnabled());
    await act(async () => h.refresh({ ...h.initial, digest: 'd'.repeat(64) }));
    await waitFor(() => expect(approve).toBeDisabled());
    expect(screen.getByRole('checkbox', { name: 'Starting stage class A' })).toBeChecked();
    fireEvent.click(approve); expect(h.approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the default draft' }));
    expect(screen.getByRole('checkbox', { name: 'Starting stage class A' })).not.toBeChecked();
    expect(approve).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(2));
    const posts = h.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(JSON.parse(posts[1]![1]!.body as string).scope).not.toHaveProperty('startingStageLeaderClasses');
    await act(async () => h.pending[1]!(json({ ...h.initial, digest: 'e'.repeat(64) })));
  });
  it('keeps reviewed local engines, uncapped volumes and disabled accounts when reopened and edited', async () => {
    const h = setup();
    const approve = await screen.findByRole('button', { name: 'Approve with Touch ID' });
    await waitFor(() => expect(approve).toBeEnabled());
    for (const engine of ['Grok (grok-cli)', 'Claude Code (claude-cli)', 'Codex']) fireEvent.click(screen.getByRole('checkbox', { name: engine }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'No volume cap: Files per change' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'No volume cap: Lines per change' }));
    for (const repo of h.initial.payload.repos) fireEvent.click(screen.getByRole('checkbox', { name: `No volume cap: ${repo.nameWithOwner} merges/day` }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Permit autonomy on claude-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(1));
    const accepted = h.edited(40, 'b');
    accepted.payload.engines = ['local'];
    accepted.payload.merge.maxFiles = Number.MAX_SAFE_INTEGER;
    accepted.payload.merge.maxLines = Number.MAX_SAFE_INTEGER;
    accepted.payload.spend.seats['claude-a']!.enabled = false;
    await act(async () => h.pending[0]!(json(accepted)));
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Hide the scope editor' }));
    expect(approve).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit scope' }));
    expect(screen.getByRole('checkbox', { name: 'Codex' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Permit autonomy on claude-a' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'No volume cap: Lines per change' })).toBeChecked();
    fireEvent.change(screen.getByLabelText('Valid for (days, at most 30)'), { target: { value: '7' } });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(2));
    const posted = h.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')[1]![1];
    expect(JSON.parse(posted!.body as string).scope).toMatchObject({ engines: ['local'], days: 7, maxFiles: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER, repoMaxMergesPerDay: Object.fromEntries(h.initial.payload.repos.map((repo) => [repo.nameWithOwner, Number.MAX_SAFE_INTEGER])), seatPolicies: { 'claude-a': { enabled: false } } });
    await act(async () => h.pending[1]!(json({ ...accepted, digest: 'c'.repeat(64) })));
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    expect(h.approve).toHaveBeenCalledWith(expect.objectContaining({ digest: 'c'.repeat(64) }));
  });
  it('retains choices when the source changes while hidden, but requires a fresh preview', async () => {
    const h = setup();
    const approve = await screen.findByRole('button', { name: 'Approve with Touch ID' });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.change(screen.getByLabelText('claude-a: reserve for you (%)'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(1));
    await act(async () => h.pending[0]!(json(h.edited(25, 'b'))));
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Hide the scope editor' }));
    await act(async () => h.refresh({ ...h.initial, digest: 'd'.repeat(64) }));
    await screen.findByText(/The grant source changed/);
    expect(approve).toBeDisabled();
    expect(screen.queryByText('Showing your edited draft.')).not.toBeInTheDocument();
    fireEvent.click(approve);
    expect(h.approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit scope' }));
    expect(screen.getByLabelText('claude-a: reserve for you (%)')).toHaveValue(25);
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(2));
    await act(async () => h.pending[1]!(json(h.edited(25, 'e'))));
    await waitFor(() => expect(approve).toBeEnabled());
    expect(screen.queryByText(/The grant source changed/)).not.toBeInTheDocument();
  });
  it('explicit Reset clears retained choices and edited-field flags after Hide/Open', async () => {
    const h = setup();
    const approve = await screen.findByRole('button', { name: 'Approve with Touch ID' });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(screen.getByRole('checkbox', { name: 'No volume cap: Files per change' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Permit autonomy on claude-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide the scope editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit scope' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to the default draft' }));
    expect(screen.getByRole('checkbox', { name: 'No volume cap: Files per change' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Permit autonomy on claude-a' })).toBeChecked();
    expect(approve).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(1));
    const posted = h.fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1];
    const scope = JSON.parse(posted!.body as string).scope;
    expect(scope).not.toHaveProperty('maxFiles');
    expect(scope).not.toHaveProperty('seatPolicies');
    await act(async () => h.pending[0]!(json(h.edited(40, 'b'))));
  });
  it('changing the ladder resets choices retained by the collapsed editor', async () => {
    const h = setup();
    const approve = await screen.findByRole('button', { name: 'Approve with Touch ID' });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.change(screen.getByLabelText('claude-a: reserve for you (%)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the changes' }));
    await waitFor(() => expect(h.pending).toHaveLength(1));
    expect(screen.getByRole('checkbox', { name: 'Elite direct' })).toBeDisabled();
    await act(async () => h.pending[0]!(json(h.edited(0, 'b'))));
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Hide the scope editor' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Elite direct' }));
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Edit scope' }));
    expect(screen.getByLabelText('claude-a: reserve for you (%)')).toHaveValue(40);
    fireEvent.click(approve);
    expect(h.approve).toHaveBeenCalledWith(expect.objectContaining({ digest: 'f'.repeat(64), eliteDirect: true }));
  });
});

describe('grant review shows starting-stage Leader permission', () => {
  it('shows advisory work when top-level A/B is unavailable in the elite stage', () => {
    const d = grantDraft();
    d.payload.leader.classes = ['A', 'B'];
    d.payload.rollout.stages = [{ ...d.payload.rollout.stages[0]!, id: 'elite-direct', leaderClasses: [] }];
    render(<DraftScope draft={d} />);
    expect(screen.getByRole('region', { name: 'Repositories' })).toHaveTextContent(`Phantom itself: ${d.payload.merge.selfRepo === 'propose-only' ? 'propose only' : 'merge outside authority code'}`);
    const leader = within(screen.getByRole('region', { name: 'Engines and Leader' }));
    expect(leader.getByText(/Signed Leader ceiling: A \+ B/)).toBeInTheDocument();
    expect(leader.getByText('Leader remains advisory in the starting stage.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Rollout ladder' })).toHaveTextContent('Leader advisory only');
  });
  it('shows only the intersection, with autonomy required before actions', () => {
    const d = grantDraft();
    d.payload.leader.classes = ['A'];
    d.payload.rollout.stages[0]!.leaderClasses = ['A', 'B'];
    render(<DraftScope draft={d} />);
    expect(screen.getByText('Starting stage permits Leader classes A when autonomy is active.')).toBeInTheDocument();
    expect(screen.queryByText(/Starting stage permits Leader classes A \+ B/)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Rollout ladder' })).not.toHaveTextContent('Leader classes A + B');
  });
});
