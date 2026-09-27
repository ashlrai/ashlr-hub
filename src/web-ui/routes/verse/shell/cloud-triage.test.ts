/**
 * cloud-triage.ts (3.13) — the drawer's reading of cloud PR previews, and the
 * budget form's review-backpressure field (cloud-model.ts). 3.15: Devin
 * previews merged in (each lane speaks only for its own rows), the item →
 * task mapping behind Evidence, and the Close reason helpers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudPrPreview } from '../../../../core/cloud/pr-preview.js';
import { DEFAULT_CLOUD_BUDGET, type CloudBudgetV1 } from '../../../../core/cloud/types.js';
import type { NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { budgetFormFrom, budgetPatch } from '../cloud/cloud-model.js';
import { ApiError } from '../../../data/client.js';
import { cleanCloseReason, isCloseTriageAction, withCloseReason } from './close-reason.js';
import { cleanLandable, cloudPreviewsQuery, deliveryTaskOfItem, isDeliveryPrItem, narrowPreviews, previewMatchesItem, triageChip } from './cloud-triage.js';

const SHA = 'a'.repeat(40);

function item(headSha: string, withLand = true): NeedsYouItem {
  return {
    id: 'fleet:owner-lane-pr:cloud-ct_20260926T1100_abc123',
    source: 'fleet', kind: 'owner-lane-pr', severity: 'info', title: 'Cloud task ready for review: x', detail: null,
    since: '2026-09-26T11:00:00.000Z', expiresAt: null,
    subject: { repo: 'ashlrai/ashlr-hub', pr: 42, seatId: null, sessionId: null, engine: 'claude' },
    target: { kind: 'url', url: 'https://github.com/ashlrai/ashlr-hub/pull/42' },
    actions: [
      ...(withLand ? [{ kind: 'approve' as const, label: 'Land', request: { method: 'POST' as const, path: '/api/verse/cloud/tasks/ct_20260926T1100_abc123/land', body: { headSha } }, confirm: null, destructive: false }] : []),
      { kind: 'reject', label: 'Close', request: { method: 'POST', path: '/api/verse/cloud/tasks/ct_20260926T1100_abc123/close', body: { headSha } }, confirm: null, destructive: true },
    ],
  };
}

function preview(over: Partial<CloudPrPreview> = {}): CloudPrPreview {
  return {
    taskId: 'ct_20260926T1100_abc123', itemId: 'fleet:owner-lane-pr:cloud-ct_20260926T1100_abc123', prNumber: 42, headSha: SHA,
    baseBranch: 'master', open: true, wouldAutoLand: true, reason: 'Clean: low risk, 1 file, 1 line, checks green.',
    landable: { ok: true, reason: null }, behind: false,
    checks: [{ id: 'ci', ok: true, text: 'Checks green' }], computedAt: '2026-09-26T11:00:00.000Z', ...over,
  };
}

describe('previews', () => {
  it('narrows the wire shape and drops malformed entries', () => {
    const map = narrowPreviews({ previews: [preview(), { itemId: 'x' }, null] });
    expect([...map.keys()]).toEqual([preview().itemId]);
    expect(narrowPreviews(null).size).toBe(0);
    expect(narrowPreviews({ previews: 'nope' }).size).toBe(0);
  });

  it('a chip speaks only for the head the actions are pinned to', () => {
    expect(triageChip(item(SHA), preview())).toEqual({ tone: 'clean', label: 'Clean', why: null, title: preview().reason });
    expect(triageChip(item('b'.repeat(40)), preview())).toBeNull();
    expect(previewMatchesItem(item(SHA), preview())).toBe(true);
    const held = preview({ wouldAutoLand: false, checks: [{ id: 'ci', ok: true, text: 'Checks green' }, { id: 'behind', ok: false, text: '1 commit behind' }] });
    expect(triageChip(item(SHA), held)).toMatchObject({ tone: 'held', label: 'Held', why: '1 commit behind' });
  });

  it('"Land all clean" takes only clean, head-matched items that carry Land', () => {
    const map = new Map([[preview().itemId, preview()]]);
    expect(cleanLandable([item(SHA)], map)).toHaveLength(1);
    expect(cleanLandable([item(SHA, false)], map)).toHaveLength(0);
    expect(cleanLandable([item('b'.repeat(40))], map)).toHaveLength(0);
    expect(cleanLandable([item(SHA)], new Map([[preview().itemId, preview({ wouldAutoLand: false })]]))).toHaveLength(0);
  });
});

describe('3.15: Devin previews next to the cloud lane’s', () => {
  const DV = 'dv_20260927T0400_abc123';
  const devinPreview = preview({ taskId: DV, itemId: `fleet:owner-lane-pr:devin-${DV}` });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  afterEach(() => vi.unstubAllGlobals());

  it('with a lane, narrowPreviews keeps only that lane’s rows', () => {
    const raw = { previews: [preview(), devinPreview] };
    expect([...narrowPreviews(raw, 'cloud').keys()]).toEqual([preview().itemId]);
    expect([...narrowPreviews(raw, 'devin').keys()]).toEqual([devinPreview.itemId]);
    // A Devin preview keyed the pre-3.15 way (`cloud-dv_…`) from the Devin route is dropped, not mis-filed.
    expect(narrowPreviews({ previews: [{ ...devinPreview, itemId: `fleet:owner-lane-pr:cloud-${DV}` }] }, 'devin').size).toBe(0);
  });

  it('the query merges both lanes; one lane’s 404 or failure costs the other nothing; 401 propagates', async () => {
    const serve = (devin: 'ok' | 404 | 500) => vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/verse/cloud/previews') return json({ previews: [preview()] });
      if (path === '/api/verse/devin/previews') return devin === 'ok' ? json({ previews: [devinPreview] }) : json({ error: 'x' }, devin);
      return json({ error: 'unexpected' }, 404);
    });
    vi.stubGlobal('fetch', serve('ok'));
    expect([...(await cloudPreviewsQuery.fetch()).keys()].sort()).toEqual([preview().itemId, devinPreview.itemId].sort());
    vi.stubGlobal('fetch', serve(404));
    expect([...(await cloudPreviewsQuery.fetch()).keys()]).toEqual([preview().itemId]);
    vi.stubGlobal('fetch', serve(500));
    expect([...(await cloudPreviewsQuery.fetch()).keys()]).toEqual([preview().itemId]);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input).includes('/devin/') ? json({}, 401) : json({ previews: [preview()] }))));
    await expect(cloudPreviewsQuery.fetch()).rejects.toBeInstanceOf(ApiError);
  });

  it('deliveryTaskOfItem: the lane and task behind a PR / failed-launch / waiting item, only in that lane’s own id format', () => {
    expect(deliveryTaskOfItem(`fleet:owner-lane-pr:devin-${DV}`)).toEqual({ lane: 'devin', taskId: DV });
    expect(deliveryTaskOfItem(`chats:chat-failed:devin-${DV}`)).toEqual({ lane: 'devin', taskId: DV });
    expect(deliveryTaskOfItem('fleet:owner-lane-pr:cloud-ct_20260926T1100_abc123')).toEqual({ lane: 'cloud', taskId: 'ct_20260926T1100_abc123' });
    for (const id of [`fleet:owner-lane-pr:cloud-${DV}`, 'fleet:owner-lane-pr:devin-ct_20260926T1100_abc123', `fleet:owner-lane-pr:devin-${DV}/../x`, 'fleet:owner-lane-pr:p-1', 'approvals:x']) {
      expect(deliveryTaskOfItem(id), id).toBeNull();
    }
    expect(isDeliveryPrItem(`fleet:owner-lane-pr:devin-${DV}`)).toBe(true);
    expect(isDeliveryPrItem(`chats:chat-failed:devin-${DV}`)).toBe(false);
  });
});

describe('3.15: the Close reason', () => {
  const close = (path: string, kind: 'reject' | 'approve' = 'reject') => ({ kind, request: { method: 'POST' as const, path, body: { headSha: SHA } } });

  it('only a cloud or Devin PR Close takes one', () => {
    expect(isCloseTriageAction(close('/api/verse/cloud/tasks/ct_20260926T1100_abc123/close'))).toBe(true);
    expect(isCloseTriageAction(close('/api/verse/devin/tasks/dv_20260927T0400_abc123/close'))).toBe(true);
    expect(isCloseTriageAction(close('/api/verse/cloud/tasks/ct_20260926T1100_abc123/land', 'approve'))).toBe(false);
    expect(isCloseTriageAction(close('/api/verse/cloud/tasks/ct_20260926T1100_abc123/dismiss'))).toBe(false);
    expect(isCloseTriageAction(close('/api/inbox/p-1/reject'))).toBe(false);
    expect(isCloseTriageAction({ kind: 'reject', request: { method: 'POST', path: '/api/verse/cloud/tasks/ct_20260926T1100_abc123/close', body: {} } })).toBe(false);
    expect(isCloseTriageAction({ kind: 'reject', request: null })).toBe(false);
  });

  it('one trimmed line of at most 200 characters; blank adds no key', () => {
    expect(cleanCloseReason('  a\n b\u2028c  ')).toBe('a b c');
    expect(cleanCloseReason('   ')).toBeNull();
    expect(cleanCloseReason('z'.repeat(250))).toBe('z'.repeat(200));
    expect(withCloseReason({ headSha: SHA }, '')).toEqual({ headSha: SHA });
    expect(withCloseReason({ headSha: SHA }, ' wrong repo ')).toEqual({ headSha: SHA, reason: 'wrong repo' });
  });
});

describe('budget form: open self-improvement PRs', () => {
  const budget = (self: Partial<CloudBudgetV1['selfImprove']> = {}): CloudBudgetV1 => ({
    ...DEFAULT_CLOUD_BUDGET, selfImprove: { ...DEFAULT_CLOUD_BUDGET.selfImprove, ...self }, updatedAt: '2026-09-26T11:00:00.000Z',
  });

  it('edits maxOpenPrs, validated 1..50', () => {
    const b = budget();
    const form = budgetFormFrom(b);
    expect(form.selfImproveMaxOpen).toBe('3');
    expect(budgetPatch({ ...form, selfImproveMaxOpen: '5' }, b)).toEqual({ ok: true, changed: true, update: { selfImprove: { maxOpenPrs: 5 } } });
    const bad = budgetPatch({ ...form, selfImproveMaxOpen: '0' }, b);
    expect(bad.ok).toBe(false);
  });

  it('a pre-3.13 server (no maxOpenPrs) shows the default and never sends it unchanged', () => {
    const legacy = budget();
    delete (legacy.selfImprove as Partial<CloudBudgetV1['selfImprove']>).maxOpenPrs;
    const form = budgetFormFrom(legacy);
    expect(form.selfImproveMaxOpen).toBe('3');
    expect(budgetPatch(form, legacy)).toEqual({ ok: true, changed: false, update: {} });
  });
});
