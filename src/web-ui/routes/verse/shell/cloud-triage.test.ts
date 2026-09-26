/**
 * cloud-triage.ts (3.13) — the drawer's reading of cloud PR previews, and the
 * budget form's review-backpressure field (cloud-model.ts).
 */
import { describe, expect, it } from 'vitest';
import type { CloudPrPreview } from '../../../../core/cloud/pr-preview.js';
import { DEFAULT_CLOUD_BUDGET, type CloudBudgetV1 } from '../../../../core/cloud/types.js';
import type { NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { budgetFormFrom, budgetPatch } from '../cloud/cloud-model.js';
import { cleanLandable, narrowPreviews, previewMatchesItem, triageChip } from './cloud-triage.js';

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
