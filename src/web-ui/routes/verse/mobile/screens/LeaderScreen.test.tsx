/**
 * The Leader on a phone: the thread draws as bubbles with kinds and
 * channels, every state reads honestly, sends / answers / approvals /
 * directives reach their routes with the token (Approve now and Retire only
 * after the confirmation sheet), quick replies only fill the box, and
 * nothing can be sent when the device cannot act or the Mac is away.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaderStateV1 } from '../../../../../core/vision/leader-types.js';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { leaderState } from '../../command/fixtures.test-support.js';
import { directives, msg, QUESTION_TEXT, threadMessages } from '../../leader/thread-fixtures.test-support.js';
import type { LeaderThreadMessage, OperatorDirective } from '../../leader/thread-types.js';
import { resetGuard } from '../../shell/guard-store.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { json, permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { LeaderScreen } from './LeaderScreen.js';

function Harness() {
  return (
    <>
      <LeaderScreen />
      <MobileGuardSheet />
      <MobileToasts />
    </>
  );
}

const THREAD = '/api/verse/leader/thread';

function stubLeader(opts: { thread?: LeaderThreadMessage[] | Response; directives?: OperatorDirective[]; leader?: LeaderStateV1 | Response; routes?: Record<string, unknown> } = {}) {
  return stubFetch({
    [`GET ${THREAD}`]: () => (opts.thread instanceof Response ? opts.thread : json({ messages: opts.thread ?? threadMessages() })),
    'GET /api/verse/leader/directives': { directives: opts.directives ?? directives(), retired: [] },
    'GET /api/verse/leader': () => (opts.leader instanceof Response ? opts.leader : json(opts.leader ?? leaderState('live'))),
    ...opts.routes,
  });
}

function sent(message: Partial<LeaderThreadMessage> & { id: string; text: string }) {
  return json({ message: msg({ from: 'mason', ...message }), reply: null });
}

const composer = () => screen.getByRole('textbox', { name: /Message the Leader|Answer the Leader/ });

beforeEach(() => {
  setMutationToken(TOKEN);
});

afterEach(() => {
  clearMutationToken();
  evictAll();
  resetGuard();
  resetMobileToastsForTest();
  vi.unstubAllGlobals();
});

describe('LeaderScreen — states', () => {
  it('shows a skeleton while the thread loads', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    renderMobile(<LeaderScreen />);
    expect(screen.getByRole('status', { name: 'Loading the conversation' })).toBeInTheDocument();
  });

  it('draws the thread: sides, kind badges, channels, and plain text', async () => {
    stubLeader({ thread: [...threadMessages(), msg({ id: 't9', text: '<b>not html</b>\nline two' })] });
    renderMobile(<LeaderScreen />);
    expect(await screen.findByText(QUESTION_TEXT)).toBeInTheDocument();
    expect(screen.getByText('Question')).toBeInTheDocument();
    expect(screen.getByText('Memo')).toBeInTheDocument();
    expect(screen.getAllByText('via Telegram').length).toBeGreaterThan(0);
    expect(screen.getAllByText('via CLI').length).toBeGreaterThan(0);
    expect(screen.getByText('Telegram connected.')).toBeInTheDocument();
    // Untrusted text stays text.
    expect(screen.getByText(/<b>not html<\/b>/)).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByText('What is slowing merges this week?').closest('[data-from]')).toHaveAttribute('data-from', 'mason');
  });

  it('invites a first message when the thread is empty', async () => {
    stubLeader({ thread: [] });
    renderMobile(<LeaderScreen />);
    expect(await screen.findByText('No conversation yet — say hello')).toBeInTheDocument();
  });

  it('says why when the conversation is not available on this Mac', async () => {
    stubLeader({ thread: json({ error: 'not found' }, 404) });
    renderMobile(<LeaderScreen />);
    expect(await screen.findByText('The conversation isn’t available')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Leader conversation/);
    expect(composer()).toBeDisabled();
  });

  it('keeps the thread and turns sending off when the Mac is unreachable', async () => {
    stubLeader();
    renderMobile(<LeaderScreen />, { reachability: 'unreachable' });
    expect(await screen.findByText(QUESTION_TEXT)).toBeInTheDocument();
    expect(screen.getByText(/Can’t reach your Mac/)).toBeInTheDocument();
    expect(composer()).toBeDisabled();
    expect(screen.getByText(/Your Mac isn’t answering. Sending is off/)).toBeInTheDocument();
  });

  it('hides every write when the device cannot act, and says why', async () => {
    stubLeader();
    renderMobile(<LeaderScreen />, { permissions: permissionsFor('unavailable') });
    expect(await screen.findByText(QUESTION_TEXT)).toBeInTheDocument();
    expect(composer()).toBeDisabled();
    expect(screen.getByText('Your Mac started Verse without dispatch.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Answer/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve now/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Quick replies' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Directives/ }));
    expect(await screen.findByText('Ship binshield before new goals')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Retire/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add directive' })).not.toBeInTheDocument();
  });

  it('loads earlier messages from the oldest one on screen', async () => {
    const now = Date.now();
    const page = Array.from({ length: 50 }, (_, i) => msg({ id: `m${i + 10}`, at: new Date(now - (60 - i) * 60_000).toISOString(), text: `Message ${i}` }));
    const stub = stubLeader({ thread: page });
    renderMobile(<LeaderScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load earlier' }));
    await waitFor(() => expect(stub.calls.some((c) => c.url.includes('before=m10'))).toBe(true));
  });
});

describe('LeaderScreen — writes', () => {
  it('sends a message with the token, refetches the thread and clears the box', async () => {
    const stub = stubLeader({ routes: { [`POST ${THREAD}`]: () => sent({ id: 'lt-new', text: 'Ship it.' }) } });
    renderMobile(<Harness />);
    await screen.findByText(QUESTION_TEXT);
    const reads = stub.calls.filter((c) => c.method === 'GET' && c.url.startsWith(THREAD)).length;

    await userEvent.type(composer(), 'Ship it.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(stub.posts()).toHaveLength(1));
    const [post] = stub.posts();
    expect(post!.url).toBe(THREAD);
    expect(post!.body).toEqual({ text: 'Ship it.' });
    expect(post!.headers['x-ashlr-token']).toBe(TOKEN);
    await waitFor(() => expect(composer()).toHaveValue(''));
    await waitFor(() => expect(stub.calls.filter((c) => c.method === 'GET' && c.url.startsWith(THREAD)).length).toBeGreaterThan(reads));
    expect(await screen.findByText('Ship it.')).toBeInTheDocument();
  });

  it('keeps the words when the send fails', async () => {
    stubLeader({ routes: { [`POST ${THREAD}`]: json({ error: 'The Leader is offline.' }, 503) } });
    renderMobile(<Harness />);
    await screen.findByText(QUESTION_TEXT);
    await userEvent.type(composer(), 'Ship it.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/The Leader is offline|HTTP 503/)).toBeInTheDocument();
    expect(composer()).toHaveValue('Ship it.');
  });

  it('quick replies fill the box and never send', async () => {
    const stub = stubLeader();
    renderMobile(<LeaderScreen />);
    await screen.findByText(QUESTION_TEXT);
    await userEvent.click(screen.getByRole('button', { name: 'Hold off for now' }));
    expect(composer()).toHaveValue('Hold off for now');
    expect(stub.posts()).toHaveLength(0);
  });

  it('answers a question on its own route', async () => {
    const stub = stubLeader({
      routes: { 'POST /api/verse/leader/questions/memo-0924:0/answer': () => sent({ id: 'lt-a', kind: 'answer', questionId: 'memo-0924:0', text: 'Stay local.' }) },
    });
    renderMobile(<Harness />);
    await screen.findByText(QUESTION_TEXT);
    await userEvent.click(screen.getByRole('button', { name: /^Answer:/ }));
    expect(screen.getByText(/^Answering:/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Answer the Leader' }), 'Stay local.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(stub.posts()).toHaveLength(1));
    expect(stub.posts()[0]!.url).toBe('/api/verse/leader/questions/memo-0924:0/answer');
    expect(stub.posts()[0]!.body).toEqual({ text: 'Stay local.' });
    await waitFor(() => expect(screen.queryByText(/^Answering:/)).not.toBeInTheDocument());
  });

  it('Approve now confirms what it does, then posts the action', async () => {
    const stub = stubLeader({ routes: { 'POST /api/verse/leader/actions/a2/approve': { ok: true, code: 200, outcome: 'applied' } } });
    renderMobile(<Harness />);
    await screen.findByText(QUESTION_TEXT);
    // Only pending actions offer it: a2 (class B in its window) and a4 (class C ask), not the applied ones.
    expect(screen.getAllByRole('button', { name: /^Approve now/ })).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Approve now: Raise Grok to 3 lanes' }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Approve this action now?' });
    expect(sheet).toHaveTextContent('runs now instead of waiting out its veto window');
    expect(stub.posts()).toHaveLength(0);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Approve now' }));
    await waitFor(() => expect(stub.posts()).toHaveLength(1));
    expect(stub.posts()[0]!.url).toBe('/api/verse/leader/actions/a2/approve');
    expect(stub.posts()[0]!.headers['x-ashlr-token']).toBe(TOKEN);
  });

  it('retires a directive only after confirming', async () => {
    const stub = stubLeader({ routes: { 'DELETE /api/verse/leader/directives/d1': { directive: null } } });
    renderMobile(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /Directives/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Retire directive: Ship binshield before new goals' }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Retire this directive?' });
    expect(stub.posts()).toHaveLength(0);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(stub.posts()).toHaveLength(1));
    expect(stub.posts()[0]).toMatchObject({ method: 'DELETE', url: '/api/verse/leader/directives/d1' });
    expect(stub.posts()[0]!.headers['x-ashlr-token']).toBe(TOKEN);
  });

  it('adds a directive, capped at the server’s length', async () => {
    const stub = stubLeader({ routes: { 'POST /api/verse/leader/directives': { directive: { id: 'd9', text: 'Quiet after 10pm', createdAt: '2026-09-27T12:00:00Z', retiredAt: null }, duplicate: false } } });
    renderMobile(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /Directives/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add directive' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add directive' });
    const box = within(sheet).getByLabelText('Directive');
    expect(box).toHaveAttribute('maxLength', '300');
    await userEvent.type(box, 'Quiet after 10pm');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add directive' }));
    await waitFor(() => expect(stub.posts()).toHaveLength(1));
    expect(stub.posts()[0]).toMatchObject({ method: 'POST', url: '/api/verse/leader/directives', body: { text: 'Quiet after 10pm' } });
  });
});


describe('LeaderScreen — generated display text', () => {
  it('keeps phone memo/action prose readable and routes approval with the original ID', async () => {
    const memoId = 'lm-20261005153000-abcdef';
    const actionId = 'la-20261005153000-abcdef-1';
    const raw = `Memo ${memoId}\n• [B] Read \`file(${actionId}).ts\` — scheduled (${actionId})\nApprove or veto any of them by id.`;
    const state = leaderState('live');
    state.actions[1]!.id = actionId;
    const net = stubLeader({ leader: state, thread: [
      msg({ id: 'readable-memo', kind: 'memo', memoId, actionIds: [actionId], text: raw }),
      msg({ id: 'readable-action', kind: 'action', text: `Approved ${actionId}: recorded` }),
      msg({ id: 'literal-question', kind: 'question', questionId: `${memoId}:0`, text: `Does Memo ${memoId} name the file?` }),
      msg({ id: 'literal-human', from: 'mason', text: `Keep Memo ${memoId} exactly.` }),
      msg({ id: 'readable-system', kind: 'memo', channel: 'system', text: `Memo ${memoId}` }),
    ] });
    renderMobile(<Harness />);
    const note = await screen.findByText(/Review these actions before deciding\./);
    expect(note).toHaveTextContent(`file(${actionId}).ts`);
    expect(note).not.toHaveTextContent(`scheduled (${actionId})`);
    expect(screen.getByText('Approved action: recorded')).toBeInTheDocument();
    expect(screen.getByText(`Does Memo ${memoId} name the file?`)).toBeInTheDocument();
    expect(screen.getByText(`Keep Memo ${memoId} exactly.`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve now: Raise Grok to 3 lanes' }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Approve this action now?' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Approve now' }));
    await waitFor(() => expect(net.posts().some((call) => call.url === `/api/verse/leader/actions/${actionId}/approve`)).toBe(true));
    expect(raw).toContain(memoId);
  });
});


it('opens typed controls separately while the normal conversation composer remains available', async () => {
  const revision = Array(8).fill('a'.repeat(8)).join('-');
  const form = { schemaVersion: 1 as const, revision, mode: 'single' as const, options: ['Startup speed', 'Reliability'],
    expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const question = { questionId: 'memo-0924:0', text: 'Choose the next improvement?', askedAt: new Date().toISOString(), messageId: 'q-typed',
    answered: false, answer: null, questionForm: form };
  const net = stubLeader({ thread: [{ id: 'q-typed', at: question.askedAt, from: 'leader', channel: 'verse', kind: 'question',
    text: question.text, questionId: question.questionId, questionForm: form }], routes: {
      'GET /api/verse/leader/questions/memo-0924:0': { question, typedQuestionsSupported: true },
    } });
  renderMobile(<Harness />);
  await userEvent.click(await screen.findByRole('button', { name: /^Answer:/ }));
  await userEvent.click(await screen.findByRole('radio', { name: 'Reliability' })); expect(net.posts()).toHaveLength(0);
  // Closing the sheet exposes the independent conversation composer, preserving the selection.
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('textbox', { name: 'Message the Leader' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^Answer:/ }));
  expect(await screen.findByRole('radio', { name: 'Reliability' })).toBeChecked(); expect(net.posts()).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: 'Write an answer' }));
  const sheet = screen.getByRole('dialog', { name: 'Answer the Leader' });
  expect(within(sheet).getByRole('button', { name: 'Dictation unavailable in this browser' })).toBeInTheDocument();
  const text = within(sheet).getByRole('textbox', { name: 'Your answer' });
  await userEvent.type(text, 'Independent{Enter}answer');
  expect(text).toHaveValue('Independent\nanswer'); expect(net.posts()).toHaveLength(0);
  expect(within(sheet).getByRole('button', { name: 'Send answer' })).toBeEnabled();
});
