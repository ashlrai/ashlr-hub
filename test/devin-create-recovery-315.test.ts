/** No network/credentials: paginated GET evidence and real temporary task-store accounting. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { devinTaskAcuUsed } from '../src/core/devin/budget.js';
import { sendDevinChatMessage, terminateDevinChat } from '../src/core/devin/chat.js';
import type { DevinSession, DevinSessionPage } from '../src/core/devin/client.js';
import { previewDevinCreateRecovery } from '../src/core/devin/create-recovery.js';
import { storeDevinKey } from '../src/core/devin/secret.js';
import { devinSessionTaskTag, messageDevinTask } from '../src/core/devin/service.js';
import { readDevinTask, writeDevinConnection, writeDevinTask } from '../src/core/devin/store.js';
import { devinTaskNeedsObservation, refreshDevinTasks, resetDevinTrackerCursorForTest } from '../src/core/devin/tracker.js';
import type { DevinTaskV1 } from '../src/core/devin/types.js';
import { fakeDevin } from './helpers/fake-devin.js';
import { fakeKeychain } from './helpers/fake-keychain.js';

const orgId = 'org-recovery';
const now = new Date('2026-10-02T03:00:00Z');
const task = (patch: Partial<DevinTaskV1> = {}): DevinTaskV1 => ({
  v: 1, id: 'dv_20261002T0300_000001', repo: 'o/r', baseBranch: 'main', branch: 'ashlr-devin/dv_20261002T0300_000001',
  title: 'Recover', prompt: 'Existing work', origin: 'operator', requestedBy: 'mason', sessionId: null,
  sessionUrl: null, launchOrgId: orgId, state: 'failed', stateReason: 'Create outcome unknown', failure: 'network',
  createdAt: now.toISOString(), launchedAt: now.toISOString(), updatedAt: now.toISOString(), session: null,
  maxAcu: 10, devinMode: 'normal', pr: null, headSha: null, report: null, backlogItemId: null, ...patch,
});
const session = (patch: Partial<DevinSession> = {}): DevinSession => ({
  sessionId: 'devin-found', orgId, url: 'https://app.devin.ai/sessions/devin-found', status: 'exit',
  statusDetail: null, acusConsumed: 3, pullRequests: [], tags: [devinSessionTaskTag(task().id)], title: null,
  structuredOutput: null, ...patch,
});
const page = (items: DevinSession[], patch: Partial<DevinSessionPage> = {}): DevinSessionPage => ({
  items, complete: true, hasNextPage: false, endCursor: null, ...patch,
});
function api(pages: DevinSessionPage[], exact: DevinSession = session()) {
  const listSessions = vi.fn(async () => pages.shift()!);
  const getSession = vi.fn(async () => exact);
  return { orgId, client: { listSessions, getSession } };
}

describe('read-only ID-less create recovery preview', () => {
  it('shares account-qualified observation eligibility across scheduler and tracker', () => {
    expect(devinTaskNeedsObservation(task())).toBe(true);
    expect(devinTaskNeedsObservation(task({ launchOrgId: undefined }))).toBe(false);
    expect(devinTaskNeedsObservation(task({ state: 'closed' }))).toBe(true);
    expect(devinTaskNeedsObservation(task({ state: 'closed', launchOrgId: undefined }))).toBe(false);
    expect(devinTaskNeedsObservation(task({ state: 'closed', sessionId: 'devin-found', session: null }))).toBe(true);
    expect(devinTaskNeedsObservation(task({ state: 'merged', sessionId: 'devin-found',
      session: { status: 'running', statusDetail: 'finished', acusConsumed: 2, prUrls: [], readAt: now.toISOString() } }))).toBe(true);
    expect(devinTaskNeedsObservation(task({ state: 'closed', sessionId: 'devin-found',
      session: { status: 'exit', statusDetail: null, acusConsumed: null, prUrls: [], readAt: now.toISOString() } }))).toBe(true);
    expect(devinTaskNeedsObservation(task({ state: 'closed', sessionId: 'devin-found',
      session: { status: 'exit', statusDetail: null, acusConsumed: 3, prUrls: [], readAt: now.toISOString() } }))).toBe(false);
  });
  it('follows the actual cursor, scans to completion and confirms one exact task tag with GET', async () => {
    const a = api([page([session({ sessionId: 'devin-other', tags: ['unrelated'] })], { hasNextPage: true, endCursor: 'page2' }), page([session()])]);
    expect(await previewDevinCreateRecovery(task(), a)).toMatchObject({ kind: 'match', launchAccountBound: true, pages: 2 });
    expect(a.client.listSessions.mock.calls).toEqual([[orgId, { first: 200 }], [orgId, { first: 200, after: 'page2' }]]);
    expect(a.client.getSession).toHaveBeenCalledWith(orgId, 'devin-found');
  });
  it('never equates no match with non-creation, or a current login with the legacy launch account', async () => {
    expect(await previewDevinCreateRecovery(task(), api([page([session({ tags: [`${devinSessionTaskTag(task().id)}-suffix`] })])]))).toMatchObject({ kind: 'held', reason: 'no-match' });
    expect(await previewDevinCreateRecovery(task({ launchOrgId: undefined }), api([page([session()])]))).toMatchObject({ kind: 'match', launchAccountBound: false });
  });
  it('retains the hold for multiple distinct matches even on later pages', async () => {
    const a = api([page([session()], { hasNextPage: true, endCursor: 'next' }), page([session({ sessionId: 'devin-second' })])]);
    expect(await previewDevinCreateRecovery(task(), a)).toMatchObject({ kind: 'held', reason: 'multiple-matches' });
    expect(a.client.getSession).not.toHaveBeenCalled();
  });
  it('refuses duplicate session IDs and repeated cursors rather than deduplicating away uncertainty', async () => {
    const a = api([page([session()], { hasNextPage: true, endCursor: 'next' }), page([session()])]);
    expect(await previewDevinCreateRecovery(task(), a)).toMatchObject({ reason: 'duplicate-session' });
    const loop = api([page([], { hasNextPage: true, endCursor: 'same' }), page([], { hasNextPage: true, endCursor: 'same' })]);
    expect(await previewDevinCreateRecovery(task(), loop)).toMatchObject({ reason: 'cursor-loop', pages: 2 });
  });
  it.each([
    page([session()], { complete: false }),
    page([session()], { hasNextPage: true, endCursor: null }),
    page([session()], { hasNextPage: true, endCursor: 'x'.repeat(513) }),
  ])('holds incomplete or unrepresentable pagination %#', async (p) => {
    expect(await previewDevinCreateRecovery(task(), api([p]))).toMatchObject({ kind: 'held', reason: 'incomplete' });
  });
  it('does not confirm a partial-page match when the read budget ends', async () => {
    const a = api([page([session()], { hasNextPage: true, endCursor: 'more' })]);
    expect(await previewDevinCreateRecovery(task(), a, { maxPages: 1 })).toMatchObject({ reason: 'incomplete' });
    expect(a.client.getSession).not.toHaveBeenCalled();
  });
  it.each([undefined, 'org-foreign'])('requires provider-reported org context, not just the caller config (%s)', async (reported) => {
    expect(await previewDevinCreateRecovery(task(), api([page([session({ orgId: reported })])]))).toMatchObject({ reason: 'account-context' });
  });
  it('refuses a changed launch account before requesting its sessions', async () => {
    const a = api([]);
    expect(await previewDevinCreateRecovery(task({ launchOrgId: 'org-previous' }), a)).toMatchObject({ reason: 'account-context', pages: 0 });
    expect(a.client.listSessions).not.toHaveBeenCalled();
  });
  it.each([
    session({ tags: [] }), session({ orgId: 'org-other' }), session({ sessionId: 'devin-other' }),
  ])('requires exact GET identity/account/tag confirmation %#', async (exact) => {
    expect(await previewDevinCreateRecovery(task(), api([page([session()])], exact))).toMatchObject({ reason: 'changed-match' });
  });
  it.each(['listSessions', 'getSession'] as const)('retains the hold and suppresses raw errors when %s fails', async (method) => {
    const a = api([page([session()])]);
    a.client[method].mockRejectedValueOnce(new Error('private provider body'));
    const result = await previewDevinCreateRecovery(task(), a);
    expect(result).toMatchObject({ kind: 'held', reason: 'read-failed' });
    expect(JSON.stringify(result)).not.toContain('private');
  });
});

describe('supported refresh settles only org-pinned terminal observed usage', () => {
  let root: string;
  const prior = process.env['ASHLR_HOME'];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ashlr-devin-recovery-'));
    process.env['ASHLR_HOME'] = root;
    resetDevinTrackerCursorForTest();
  });
  afterEach(() => {
    if (prior === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = prior;
    rmSync(root, { recursive: true, force: true });
  });
  it.each(['exit', 'error'] as const)('settles actual ACUs for literal %s with no POST/DELETE/GitHub calls', async (status) => {
    writeDevinTask(task());
    const a = api([page([session({ status })])], session({ status }));
    const gh = vi.fn();
    expect(await refreshDevinTasks({ client: a, gh, now: () => now })).toEqual({ checked: 1, updated: 1 });
    const after = readDevinTask(task().id)!;
    expect(after.sessionId).toBe('devin-found');
    expect(after.session?.readAt).toBe(now.toISOString());
    expect(after.state).toBe(status === 'exit' ? 'expired' : 'failed');
    expect(after.stateReason).toBe(status === 'exit'
      ? `Devin finished without a pull request on ${task().branch}. The session link still works.`
      : 'The Devin session ended in an error.');
    expect(after).not.toHaveProperty('reason');
    expect(devinTaskAcuUsed(after)).toBe(3);
    expect(gh).not.toHaveBeenCalled();
    expect(Object.keys(a.client).sort()).toEqual(['getSession', 'listSessions']);
  });
  it.each([
    session({ status: 'running', statusDetail: 'working' }),
    session({ status: 'running', statusDetail: 'finished' }),
    session({ status: 'suspended', statusDetail: 'out_of_quota' }),
    session({ acusConsumed: null }), session({ acusConsumed: Number.NaN }),
  ])('keeps the original full-cap hold for unverified termination/usage %#', async (exact) => {
    writeDevinTask(task());
    const before = readDevinTask(task().id)!;
    expect(await refreshDevinTasks({ client: api([page([session()])], exact), now: () => now })).toEqual({ checked: 1, updated: 0 });
    expect(readDevinTask(task().id)).toEqual(before);
    expect(devinTaskAcuUsed(before)).toBe(10);
  });
  it('does not automatically scan or bind legacy holds to a historical personal Max login', async () => {
    writeDevinTask(task({ launchOrgId: undefined }));
    const a = api([page([session()])]);
    expect(await refreshDevinTasks({ client: a, now: () => now })).toEqual({ checked: 0, updated: 0 });
    expect(a.client.listSessions).not.toHaveBeenCalled();
    expect(devinTaskAcuUsed(readDevinTask(task().id)!)).toBe(10);
  });
  it.each(['exit', 'error'] as const)('reconciles a dismissed org-pinned ID-less hold using literal %s without reopening it', async (status) => {
    const dismissed = task({ state: 'closed', stateReason: 'Dismissed by you.', failure: 'unparsed' });
    writeDevinTask(dismissed);
    const a = api([page([session()])], session({ status }));
    const gh = vi.fn(async () => { throw new Error('No delivery lookup for dismissed recovery'); });
    const clock = new Date(now.getTime() + 50 * 60 * 60 * 1000);
    expect(await refreshDevinTasks({ client: a, now: () => clock, gh })).toEqual({ checked: 1, updated: 1 });
    const after = readDevinTask(dismissed.id)!;
    expect(after).toMatchObject({ state: 'closed', stateReason: 'Dismissed by you.', failure: 'unparsed', maxAcu: 10,
      launchOrgId: orgId, sessionId: 'devin-found', session: { status, acusConsumed: 3 } });
    expect(devinTaskAcuUsed(after)).toBe(3);
    expect(devinTaskNeedsObservation(after)).toBe(false);
    expect(a.client.listSessions).toHaveBeenCalledTimes(1);
    expect(a.client.getSession).toHaveBeenCalledWith(orgId, 'devin-found');
    expect(gh).not.toHaveBeenCalled();
    expect(await refreshDevinTasks({ client: a, now: () => clock, gh })).toEqual({ checked: 0, updated: 0 });
  });
  it('keeps dismissed legacy ID-less records preview-only and never auto-binds the current account', async () => {
    writeDevinTask(task({ state: 'closed', launchOrgId: undefined, stateReason: 'Dismissed by you.' }));
    const before = readDevinTask(task().id)!;
    const a = api([page([session()])]);
    expect(await refreshDevinTasks({ client: a, now: () => now })).toEqual({ checked: 0, updated: 0 });
    expect(a.client.listSessions).not.toHaveBeenCalled();
    expect(readDevinTask(before.id)).toEqual(before);
    expect(await previewDevinCreateRecovery(before, a)).toMatchObject({ kind: 'match', launchAccountBound: false });
    expect(readDevinTask(before.id)).toEqual(before);
  });
  it('does not overwrite a local task changed while a provider GET was in flight', async () => {
    writeDevinTask(task());
    const a = api([page([session()])]);
    a.client.getSession.mockImplementationOnce(async () => {
      writeDevinTask({ ...readDevinTask(task().id)!, state: 'closed' });
      return session();
    });
    expect(await refreshDevinTasks({ client: a, now: () => now })).toEqual({ checked: 1, updated: 0 });
    expect(readDevinTask(task().id)?.state).toBe('closed');
  });
  it('does not read a known session through a different current organization', async () => {
    writeDevinTask(task({ state: 'running', failure: null, sessionId: 'devin-found', sessionUrl: session().url,
      session: { status: 'running', statusDetail: 'working', acusConsumed: 2, prUrls: [], readAt: now.toISOString() } }));
    const a = api([], session());
    a.orgId = 'org-newlogin';
    const gh = vi.fn(async () => ({ ok: true, stdout: '[]', stderr: '' }));
    await refreshDevinTasks({ client: a, gh, now: () => now });
    expect(a.client.getSession).not.toHaveBeenCalled();
    expect(readDevinTask(task().id)?.session).toMatchObject({ status: 'running', acusConsumed: 2 });
  });
  it('rejects foreign response context on the normal known-session refresh path', async () => {
    writeDevinTask(task({ state: 'running', failure: null, sessionId: 'devin-found', sessionUrl: session().url,
      session: { status: 'running', statusDetail: 'working', acusConsumed: 2, prUrls: [], readAt: now.toISOString() } }));
    const a = api([], session({ orgId: 'org-foreign' }));
    const gh = vi.fn(async () => ({ ok: true, stdout: '[]', stderr: '' }));
    await refreshDevinTasks({ client: a, gh, now: () => now });
    expect(a.client.getSession).toHaveBeenCalledWith(orgId, 'devin-found');
    expect(readDevinTask(task().id)?.session).toMatchObject({ status: 'running', acusConsumed: 2 });
  });
  it('preserves legacy request-context behavior when launch/response org metadata was omitted', async () => {
    writeDevinTask(task({ launchOrgId: undefined, state: 'running', failure: null, sessionId: 'devin-found', sessionUrl: session().url,
      session: { status: 'running', statusDetail: 'working', acusConsumed: 2, prUrls: [], readAt: now.toISOString() } }));
    const a = api([], session({ orgId: undefined }));
    const gh = vi.fn(async () => ({ ok: true, stdout: '[]', stderr: '' }));
    await refreshDevinTasks({ client: a, gh, now: () => now });
    expect(a.client.getSession).toHaveBeenCalledWith(orgId, 'devin-found');
    expect(readDevinTask(task().id)?.session).toMatchObject({ status: 'exit', acusConsumed: 3 });
  });
  it.each(['task-message', 'chat-message', 'terminate'] as const)('refuses switched-account %s before any provider POST/DELETE', async (action) => {
    const provider = fakeDevin({ orgId: 'org-newlogin' });
    const keychain = fakeKeychain();
    const keyStore = { run: keychain.run, platform: 'darwin' as const };
    await storeDevinKey(provider.key, keyStore);
    writeDevinConnection({ orgId: provider.orgId, principal: 'service_user', principalName: null,
      keyStore: 'keychain', connectedAt: now.toISOString() });
    writeDevinTask(task({ state: 'running', failure: null, sessionId: 'devin-found', sessionUrl: session().url,
      session: { status: 'running', statusDetail: 'working', acusConsumed: 2, prUrls: [], readAt: now.toISOString() } }));
    const before = readDevinTask(task().id);
    const deps = { keyStore, fetch: provider.fetch, sleep: async () => undefined };
    const result = action === 'task-message' ? await messageDevinTask(task().id, 'Continue', deps)
      : action === 'chat-message' ? await sendDevinChatMessage(task().id, 'Continue', deps)
      : await terminateDevinChat(task().id, deps);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('different organization') });
    expect(provider.requests).toEqual([]);
    expect(readDevinTask(task().id)).toEqual(before);
  });
  it.each(['closed', 'expired', 'merged', 'failed'] as const)('reconciles >49-hour-old %s remote usage without changing local visibility or delivery', async (state) => {
    const old = new Date(now.getTime() - 50 * 60 * 60 * 1000).toISOString();
    writeDevinTask(task({ state, failure: null, sessionId: 'devin-found', sessionUrl: session().url,
      createdAt: old, launchedAt: old, session: { status: 'running', statusDetail: 'working', acusConsumed: 2, prUrls: [], readAt: old } }));
    const a = api([], session());
    const gh = vi.fn(async () => ({ ok: true, stdout: '[]', stderr: '' }));
    expect(await refreshDevinTasks({ client: a, gh, now: () => now })).toEqual({ checked: 1, updated: 1 });
    expect(a.client.getSession).toHaveBeenCalledWith(orgId, 'devin-found');
    const after = readDevinTask(task().id)!;
    expect(after.state).toBe(state);
    expect(after.session).toMatchObject({ status: 'exit', acusConsumed: 3, readAt: now.toISOString() });
    expect(devinTaskAcuUsed(after)).toBe(3);
    expect(gh).not.toHaveBeenCalled();
  });
  it.each([null, { status: 'exit' as const, statusDetail: null, acusConsumed: null, prUrls: [], readAt: now.toISOString() }])('keeps watching closed known sessions with incomplete terminal usage %#', async (observation) => {
    writeDevinTask(task({ state: 'closed', failure: null, sessionId: 'devin-found', sessionUrl: session().url, session: observation }));
    const a = api([], session());
    expect(await refreshDevinTasks({ client: a, now: () => now })).toEqual({ checked: 1, updated: 1 });
    expect(readDevinTask(task().id)?.session).toMatchObject({ status: 'exit', acusConsumed: 3 });
    expect(readDevinTask(task().id)?.state).toBe('closed');
  });
  it('does not keep polling a closed known session after terminal usage is complete', async () => {
    writeDevinTask(task({ state: 'closed', failure: null, sessionId: 'devin-found', sessionUrl: session().url,
      session: { status: 'exit', statusDetail: null, acusConsumed: 3, prUrls: [], readAt: now.toISOString() } }));
    const a = api([]);
    expect(await refreshDevinTasks({ client: a, now: () => now })).toEqual({ checked: 0, updated: 0 });
    expect(a.client.getSession).not.toHaveBeenCalled();
  });
});
