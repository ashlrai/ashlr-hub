import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

vi.mock('../src/core/integrations/pulse-sync.js', () => ({
  emitFleetEvent: () => Promise.resolve(),
}));

import {
  createProposal,
  inboxDir,
  loadProposal,
  setStatus,
} from '../src/core/inbox/store.js';
import {
  evaluateProposalEffectPolicy,
  materializeProposalActionForPolicy,
  proposalHasOutwardEffect,
  verifyProposalEffectPolicy,
} from '../src/core/inbox/review-policy.js';
import { provenanceKeyPath } from '../src/core/foundry/provenance.js';
import { applyProposal } from '../src/core/inbox/apply.js';
import { autoMergeProposal } from '../src/core/inbox/merge.js';
import { isApprovedRemoteHandoffRetryCandidate } from '../src/core/inbox/remote-handoff.js';

const originalHome = process.env.HOME;
let home = '';
let repo = '';

function input(
  overrides: Partial<Omit<Proposal, 'id' | 'status' | 'createdAt'>> = {},
): Omit<Proposal, 'id' | 'status' | 'createdAt'> {
  return {
    repo,
    origin: 'manual',
    kind: 'patch',
    title: 'Bounded effect proposal',
    summary: 'The content is authenticated without granting effect authority.',
    diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    ...overrides,
  };
}

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-m505-home-')));
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-m505-repo-')));
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('M505 — signed human-only effect policy', () => {
  it('classifies only a note with no action payload as observational', () => {
    const note = {
      ...input({ repo: null, kind: 'note', diff: undefined }),
      id: 'note-1',
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    };
    expect(proposalHasOutwardEffect(note)).toBe(false);
    expect(evaluateProposalEffectPolicy(note)).toEqual({
      allowed: true,
      effectClass: 'none',
      code: 'policy-not-required',
    });
    expect(proposalHasOutwardEffect({ ...note, action: undefined })).toBe(false);
    expect(proposalHasOutwardEffect({ ...note, action: null as never })).toBe(true);
    expect(proposalHasOutwardEffect({ ...note, kind: 'patch' })).toBe(true);
  });

  it('never lets a generic caller impersonate a human decision on a note', () => {
    const note = createProposal(input({ repo: null, kind: 'note', diff: undefined }));
    expect(evaluateProposalEffectPolicy(note, 'status-transition')).toEqual({
      allowed: false,
      effectClass: 'none',
      code: 'policy-human-only',
    });
    expect(setStatus(note.id, 'approved')).toBe(false);
    expect(setStatus(note.id, 'rejected')).toBe(false);
    expect(loadProposal(note.id)?.status).toBe('pending');
    expect(loadProposal(note.id)?.decidedAt).toBeUndefined();
  });

  it('drops caller policy, stamps the finalized persisted row, and reloads valid authority', () => {
    const forged = {
      schemaVersion: 99,
      reviewPolicy: 'autonomous',
      effectClass: 'none',
    } as never;
    const created = createProposal(input({ effectPolicy: forged }));
    const loaded = loadProposal(created.id);
    expect(created.status).toBe('pending');
    expect(loaded).not.toBeNull();
    expect(loaded?.effectPolicy?.schemaVersion).toBe(1);
    expect(loaded?.effectPolicy?.reviewPolicy).toBe('human-only');
    expect(loaded?.effectPolicy?.effectClass).toBe('outward-effect');
    expect(verifyProposalEffectPolicy(loaded!)).toBe(true);
    expect(evaluateProposalEffectPolicy(loaded!)).toEqual({
      allowed: false,
      effectClass: 'outward-effect',
      code: 'policy-human-only',
    });
  });

  it('binds immutable content but remains stable across lifecycle-only changes', () => {
    const created = createProposal(input());
    expect(verifyProposalEffectPolicy({ ...created, status: 'approved' })).toBe(true);
    expect(verifyProposalEffectPolicy({ ...created, result: 'observation only' })).toBe(true);
    expect(verifyProposalEffectPolicy({ ...created, title: `${created.title} tampered` })).toBe(false);
    expect(verifyProposalEffectPolicy({ ...created, diff: `${created.diff}+tamper\n` })).toBe(false);
    expect(verifyProposalEffectPolicy({
      ...created,
      action: { type: 'open-editor', target: repo },
    })).toBe(false);
  });

  it('refuses exotic or non-JSON action values before anything is persisted', () => {
    const exotic = createProposal(input({
      kind: 'desktop-action',
      diff: undefined,
      action: {
        type: 'open-editor',
        target: repo,
        params: { when: new Date('2026-08-11T00:00:00.000Z') },
      },
    }));
    expect(exotic.status).toBe('failed');
    expect(exotic.creationFailureCode).toBe('invalid-action-payload');
    expect(exotic.decidedAt).toBeUndefined();
    expect(loadProposal(exotic.id)).toBeNull();

    const accessorParams: Record<string, unknown> = {};
    Object.defineProperty(accessorParams, 'value', {
      enumerable: true,
      get: () => 'must-not-be-read',
    });
    const accessor = createProposal(input({
      kind: 'desktop-action',
      diff: undefined,
      action: { type: 'open-editor', target: repo, params: accessorParams },
    }));
    expect(accessor.status).toBe('failed');
    expect(accessor.creationFailureCode).toBe('invalid-action-payload');
    expect(loadProposal(accessor.id)).toBeNull();

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const nonFinite = createProposal(input({
        kind: 'desktop-action',
        diff: undefined,
        action: {
          type: 'open-editor',
          target: repo,
          params: { value },
        },
      }));
      expect(nonFinite.status).toBe('failed');
      expect(nonFinite.creationFailureCode).toBe('invalid-action-payload');
      expect(loadProposal(nonFinite.id)).toBeNull();
    }
  });

  it('binds __proto__ data and persists the same inert action bytes that were signed', () => {
    const params = JSON.parse('{"__proto__":{"x":1},"safe":"yes"}') as Record<string, unknown>;
    const created = createProposal(input({
      kind: 'desktop-action',
      diff: undefined,
      action: { type: 'open-editor', target: repo, params },
    }));
    const loaded = loadProposal(created.id);
    expect(created.status).toBe('pending');
    expect(loaded).not.toBeNull();
    expect(verifyProposalEffectPolicy(loaded!)).toBe(true);
    const tampered = structuredClone(loaded!);
    (tampered.action!.params as Record<string, unknown>)['__proto__'] = { x: 2 };
    expect(verifyProposalEffectPolicy(tampered)).toBe(false);
  });

  it('enforces bounded canonical JSON action materialization', () => {
    const valid = {
      type: 'open-editor',
      target: repo,
      params: { nested: [true, null, 3, 'ok'] },
    };
    expect(materializeProposalActionForPolicy(valid)).toEqual({ ok: true, action: valid });

    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(materializeProposalActionForPolicy(cycle)).toEqual({ ok: false });

    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 18; depth++) deep = { child: deep };
    expect(materializeProposalActionForPolicy(deep)).toEqual({ ok: false });

    expect(materializeProposalActionForPolicy({ items: Array.from({ length: 2_049 }, () => 1) }))
      .toEqual({ ok: false });
    expect(materializeProposalActionForPolicy(
      Object.fromEntries(Array.from({ length: 2_049 }, (_, index) => [`k${index}`, 1])),
    )).toEqual({ ok: false });
    expect(materializeProposalActionForPolicy({ text: 'x'.repeat(64 * 1024 + 1) }))
      .toEqual({ ok: false });
    expect(materializeProposalActionForPolicy(
      Object.fromEntries(Array.from({ length: 2_048 }, (_, index) => [
        `${index}`.padEnd(140, 'k'),
        1,
      ])),
    )).toEqual({ ok: false });

    const sparse = new Array(2);
    sparse[1] = 'present';
    expect(materializeProposalActionForPolicy({ items: sparse })).toEqual({ ok: false });
  });

  it('materializes a stateful action once, then scrubs the inert bytes before signing', () => {
    const secret = 'api_key=abcdefghijklmnopqrstuvwxyz1234567890';
    let reads = 0;
    const action = new Proxy({}, {
      getPrototypeOf: () => Object.prototype,
      ownKeys: () => ['type', 'url', 'instructions'],
      getOwnPropertyDescriptor: (_target, key) => {
        reads++;
        const values: Record<PropertyKey, unknown> = {
          type: 'browser-task',
          url: `https://example.com/?${secret}`,
          instructions: `Use ${secret}`,
        };
        return { configurable: true, enumerable: true, writable: true, value: values[key] };
      },
    });
    const created = createProposal(input({
      kind: 'browser-action',
      diff: undefined,
      action: action as never,
    }));
    const loaded = loadProposal(created.id)!;
    expect(created.status).toBe('pending');
    expect(reads).toBeGreaterThan(0);
    expect(JSON.stringify(loaded.action)).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
    expect(JSON.stringify(loaded.action)).toContain('[REDACTED]');
    expect(verifyProposalEffectPolicy(loaded)).toBe(true);
  });

  it('fails closed for missing, unsupported, mismatched, and invalid policies', () => {
    const created = createProposal(input());
    expect(evaluateProposalEffectPolicy({ ...created, effectPolicy: undefined }).code)
      .toBe('policy-missing');
    expect(evaluateProposalEffectPolicy({
      ...created,
      effectPolicy: { ...created.effectPolicy!, schemaVersion: 2 as never },
    }).code).toBe('policy-unsupported');
    expect(evaluateProposalEffectPolicy({
      ...created,
      effectPolicy: { ...created.effectPolicy!, effectClass: 'none' },
    }).code).toBe('effect-class-mismatch');
    expect(evaluateProposalEffectPolicy({
      ...created,
      effectPolicy: { ...created.effectPolicy!, attestation: '0'.repeat(64) },
    }).code).toBe('policy-invalid');

    const withHiddenExtra = { ...created.effectPolicy! };
    Object.defineProperty(withHiddenExtra, 'hidden', { enumerable: false, value: true });
    expect(verifyProposalEffectPolicy({ ...created, effectPolicy: withHiddenExtra })).toBe(false);
    const withSymbol = { ...created.effectPolicy!, [Symbol('extra')]: true };
    expect(verifyProposalEffectPolicy({ ...created, effectPolicy: withSymbol })).toBe(false);

    let policyKeysRead = 0;
    const statefulPolicy = new Proxy(created.effectPolicy!, {
      ownKeys: (target) => policyKeysRead++ === 0 ? Reflect.ownKeys(target) : ['schemaVersion'],
      getOwnPropertyDescriptor: (target, key) => Reflect.getOwnPropertyDescriptor(target, key),
    });
    expect(verifyProposalEffectPolicy({ ...created, effectPolicy: statefulPolicy })).toBe(true);
    expect(policyKeysRead).toBe(1);
  });

  it('does not backfill historical rows and read-only verification creates no key', () => {
    const historical: Proposal = {
      ...input(),
      id: 'historical-row',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    mkdirSync(inboxDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(inboxDir(), `${historical.id}.json`), `${JSON.stringify(historical)}\n`, {
      mode: 0o600,
    });
    const loaded = loadProposal(historical.id);
    expect(loaded?.effectPolicy).toBeUndefined();
    expect(evaluateProposalEffectPolicy(loaded!).code).toBe('policy-missing');
    expect(verifyProposalEffectPolicy(loaded!)).toBe(false);
    expect(existsSync(provenanceKeyPath())).toBe(false);
  });

  it('centrally refuses machine decisions for outward rows and leaves them pending', () => {
    const created = createProposal(input());
    for (const status of ['approved', 'rejected', 'awaiting-host-merge', 'applied', 'failed'] as const) {
      expect(setStatus(created.id, status, 'untrusted caller')).toBe(false);
      const loaded = loadProposal(created.id);
      expect(loaded?.status).toBe('pending');
      expect(loaded?.decidedAt).toBeUndefined();
    }
    expect(setStatus(created.id, 'pending', 'Mason approved')).toBe(false);
    expect(setStatus(created.id, 'pending', undefined, 'human decision')).toBe(false);
    expect(loadProposal(created.id)?.result).toBeUndefined();
    expect(loadProposal(created.id)?.decisionReason).toBeUndefined();
  });

  it('strips caller handoff authority and closes generic runtime patch bypasses', async () => {
    const created = createProposal(input({
      remoteHandoff: {
        provider: 'github',
        state: 'awaiting-host-merge',
        branch: 'attacker',
        base: 'main',
        updatedAt: new Date().toISOString(),
      },
    }));
    expect(loadProposal(created.id)?.remoteHandoff).toBeUndefined();

    const { updateProposalField } = await import('../src/core/inbox/store.js');
    expect(updateProposalField(created.id, { status: 'approved' } as never)).toBe(false);
    expect(updateProposalField(created.id, {
      effectPolicy: { ...created.effectPolicy!, attestation: '0'.repeat(64) },
    } as never)).toBe(false);
    expect(setStatus(created.id, 'pending', undefined, undefined, undefined, {
      remoteHandoff: {
        provider: 'github',
        state: 'awaiting-host-merge',
        branch: 'attacker',
        base: 'main',
        updatedAt: new Date().toISOString(),
      },
    })).toBe(false);
    expect(setStatus(created.id, 'pending', undefined, undefined, undefined, {
      status: 'approved',
    } as never)).toBe(false);

    let patchKeysRead = 0;
    const statefulPatch = new Proxy({}, {
      ownKeys: () => patchKeysRead++ === 0 ? [] : ['status'],
      getOwnPropertyDescriptor: () => ({
        configurable: true,
        enumerable: true,
        writable: true,
        value: 'approved',
      }),
    });
    expect(setStatus(
      created.id,
      'pending',
      undefined,
      undefined,
      undefined,
      statefulPatch as never,
    )).toBe(true);

    let fieldKeysRead = 0;
    const statefulFieldPatch = new Proxy({}, {
      ownKeys: () => fieldKeysRead++ === 0 ? ['judgeNonShipCount'] : ['status'],
      getOwnPropertyDescriptor: (_target, key) => ({
        configurable: true,
        enumerable: true,
        writable: true,
        value: key === 'judgeNonShipCount' ? 1 : 'approved',
      }),
    });
    expect(updateProposalField(created.id, statefulFieldPatch as never)).toBe(true);
    expect(loadProposal(created.id)?.status).toBe('pending');
    expect(loadProposal(created.id)?.judgeNonShipCount).toBe(1);
    expect(loadProposal(created.id)?.remoteHandoff).toBeUndefined();
  });

  it('keeps destructive diffs pending with a bounded non-decisional annotation', () => {
    const destructive = createProposal(input({
      diff: '--- a/package.json\n+++ b/package.json\n@@ -1,8 +1,3 @@\n {\n-  "dependencies": {\n-    "a": "1",\n-    "b": "1",\n-    "c": "1"\n-  }\n+  "dependencies": {}\n }\n',
    }));
    expect(destructive.status).toBe('pending');
    expect(destructive.safetyAnnotation).toBe('destructive-diff-review-required');
    expect(destructive.decisionReason).toBeUndefined();
    expect(destructive.decidedAt).toBeUndefined();
    expect(verifyProposalEffectPolicy(destructive)).toBe(true);
    const raw = JSON.parse(readFileSync(join(inboxDir(), `${destructive.id}.json`), 'utf8')) as Proposal;
    expect(raw.status).toBe('pending');
    expect(raw.safetyAnnotation).toBe('destructive-diff-review-required');
  });

  it('refuses direct apply at the effect-policy sink before starting an adapter', async () => {
    const created = createProposal(input());
    const stored = loadProposal(created.id)!;
    writeFileSync(
      join(inboxDir(), `${created.id}.json`),
      `${JSON.stringify({ ...stored, status: 'approved' })}\n`,
      { mode: 0o600 },
    );

    const result = await applyProposal(created.id, { confirmed: true });

    expect(result).toEqual({
      ok: false,
      status: 'approved',
      detail: 'proposal effect policy refused apply: policy-human-only',
    });
    expect(loadProposal(created.id)?.status).toBe('approved');
    expect(existsSync(join(repo, '.git'))).toBe(false);
  });

  it('refuses direct auto-merge before verification, judging, or staging can start', async () => {
    const created = createProposal(input());
    const cfg = {
      foundry: { autoMerge: { enabled: true } },
    } as AshlrConfig;

    const result = await autoMergeProposal(created.id, cfg);

    expect(result).toEqual({
      ok: false,
      merged: false,
      reason: 'proposal effect policy refused auto-merge: policy-human-only',
    });
    expect(loadProposal(created.id)?.status).toBe('pending');
    expect(existsSync(join(repo, '.git'))).toBe(false);
  });

  it('never treats an approved human-only row as a remote retry candidate', () => {
    const created = createProposal(input());
    expect(isApprovedRemoteHandoffRetryCandidate({
      ...created,
      status: 'approved',
    })).toBe(false);
  });
});
