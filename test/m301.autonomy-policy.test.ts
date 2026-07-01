/**
 * M301 — Autonomy evidence pack + policy verdict.
 *
 * These tests keep the new autonomy layer pure and metadata-only. The existing
 * merge gate still recomputes safety from source inputs; this layer records and
 * classifies how far the passed evidence allows Ashlr to act autonomously.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildAutonomyEvidencePack,
  evidencePath,
  persistAutonomyEvidencePack,
} from '../src/core/autonomy/evidence-pack.js';
import { evaluateAutonomyPolicy } from '../src/core/autonomy/policy.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

const origHome = process.env.HOME;
let tmpHome: string;

function diff(): string {
  return [
    'diff --git a/docs/autonomy.md b/docs/autonomy.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/docs/autonomy.md',
    '@@ -0,0 +1 @@',
    '+evidence',
    '',
  ].join('\n');
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-m301',
    repo: '/tmp/repo',
    origin: 'agent',
    kind: 'patch',
    title: 'autonomy test',
    summary: 'autonomy evidence pack test',
    diff: diff(),
    diffHash: 'sha256:test',
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
    status: 'pending',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function cfg(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    version: 1,
    foundry: {
      autoMerge: {
        enabled: true,
        maxRisk: 'low',
        ...over,
      },
    },
  } as unknown as AshlrConfig;
}

function goodPack(over: Partial<Parameters<typeof buildAutonomyEvidencePack>[0]> = {}) {
  return buildAutonomyEvidencePack({
    proposal: proposal(),
    target: 'main',
    trustBasis: 'tier',
    remotePreferred: true,
    riskClass: 'low',
    authority: { ok: true, detail: 'frontier authority' },
    provenance: { ok: true, detail: 'valid HMAC provenance' },
    verification: {
      passed: true,
      detail: 'all verify commands passed',
      commandKinds: ['test', 'typecheck'],
    },
    risk: { ok: true, detail: "risk 'low' within maxRisk 'low'" },
    scope: { ok: true, detail: '1 file, 1 line within caps' },
    ...over,
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m301-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

describe('M301 evaluateAutonomyPolicy', () => {
  it('authorizes main merge when full evidence is present', () => {
    const verdict = evaluateAutonomyPolicy(goodPack(), cfg());
    expect(verdict).toMatchObject({
      tier: 'T4',
      action: 'merge-main',
      allowed: true,
    });
  });

  it('refuses when a required gate is missing or failed', () => {
    const verdict = evaluateAutonomyPolicy(
      goodPack({ provenance: { ok: false, detail: 'signature mismatch' } }),
      cfg(),
    );
    expect(verdict).toMatchObject({
      tier: 'T0',
      action: 'escalate-human',
      allowed: false,
    });
    expect(verdict.reason).toMatch(/provenance|signature/i);
  });

  it('refuses self-target merges unless explicitly allowed by evidence', () => {
    const verdict = evaluateAutonomyPolicy(
      goodPack({
        selfTarget: {
          ok: false,
          detail: 'self-target autonomous merge requires allowSelfMerge=true',
        },
      }),
      cfg(),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/self-target/i);
  });

  it('maps branch evidence to ready PR action when a remote is preferred', () => {
    const verdict = evaluateAutonomyPolicy(
      goodPack({ target: 'branch', remotePreferred: true }),
      cfg(),
    );
    expect(verdict).toMatchObject({
      tier: 'T3',
      action: 'open-ready-pr',
      allowed: true,
    });
  });
});

describe('M301 autonomy evidence pack persistence', () => {
  it('persists metadata without storing the raw diff', () => {
    const pack = goodPack();
    pack.policy = evaluateAutonomyPolicy(pack, cfg());

    expect(persistAutonomyEvidencePack(pack)).toBe(true);

    const raw = fs.readFileSync(evidencePath(pack.proposal.id), 'utf8');
    expect(raw).toContain('"policy"');
    expect(raw).toContain('"merge-main"');
    expect(raw).not.toContain('diff --git');
    expect(raw).not.toContain('+evidence');
  });
});
