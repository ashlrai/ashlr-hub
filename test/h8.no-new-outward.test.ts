/**
 * h8.no-new-outward.test.ts — Ashlr v2.1 MILESTONE H8 — the NO-NEW-OUTWARD proof.
 *
 * INVARIANTS proven here (see docs/contracts/CONTRACT-H8.md · §H8 INVARIANTS):
 *  - DEMO-NEVER-APPLIES (static): the demo's two new files (src/cli/demo.ts +
 *    src/cli/demo-sandbox.ts) import NO outward-capability module and contain NO
 *    outward CALL token — the demo's only proposal path is a PENDING proposal.
 *  - NO-GUARD-WEAKENED: H8 adds no new outward capability; the real-swarm branch
 *    is proposal-only (it goes through the existing `tick`, which imports no
 *    apply/push/PR/deploy primitive — the H1/H4 grep-guard already proves this).
 *
 * This is the SAME [STATIC] source-scan technique H4/H6/H7 used to prove the
 * daemon (and the H7 onboarding surface) import no outward primitive — it reuses
 * readSource / importLines / stripComments / containsToken from
 * test/helpers/h4-static.ts.
 *
 * SAFETY: a pure source-text scan (no execution, no HOME relocation needed for
 * the static cases). Where a behavioral assertion is added, it runs on an
 * ISOLATED tmp HOME (makeFixture) with a DISPOSABLE repo and probeEndpoint mocked
 * DOWN. Every it() has a real expect(); beforeEach calls expect.hasAssertions().
 *
 * Every it() is a real expect()-bearing test (no placeholders remain).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readSource, importLines, stripComments, containsToken } from './helpers/h4-static.js';

// The two new H8 production files, relative to src/.
const DEMO_FILES = ['cli/demo.ts', 'cli/demo-sandbox.ts'] as const;

// Outward tokens that must NOT appear in the demo source (sans comments).
const OUTWARD_TOKENS = [
  'applyProposal(',
  'approveProposal(',
  "setStatus('approved'",
  'setStatus("approved"',
  'createPr(',
  'git push',
  'gitPush(',
  'deploy(',
] as const;

beforeEach(() => {
  expect.hasAssertions();
});

describe('h8 no-new-outward — the demo adds NO outward capability', () => {
  // sanity: the helpers + file list are wired (a real assertion so the suite is
  // never vacuously green even before BUILD fills the todos).
  it('scans the two new demo files with the H4 static helpers', () => {
    expect(DEMO_FILES).toHaveLength(2);
    for (const f of DEMO_FILES) {
      const src = readSource(f);
      expect(typeof src).toBe('string');
      expect(src.length).toBeGreaterThan(0);
      expect(importLines(src)).toBeInstanceOf(Array);
      expect(typeof stripComments(src)).toBe('string');
    }
    // containsToken is the primitive the outward-token assertions use.
    expect(containsToken('const x = applyProposal(', 'applyProposal(')).toBe(true);
  });

  // DEMO-NEVER-APPLIES (static) — neither demo file may IMPORT an outward module.
  it('demo.ts + demo-sandbox.ts import NO apply/push/PR/deploy module (inbox/apply, integrations/github, ship/*, deploy)', () => {
    // Module specifiers that would grant an outward capability if imported.
    const FORBIDDEN_IMPORTS = [
      'inbox/apply',
      'integrations/github',
      '/ship',
      'ship.js',
      'deploy',
      'createPr',
      'pushBranch',
    ];
    for (const f of DEMO_FILES) {
      const imports = importLines(readSource(f));
      for (const spec of FORBIDDEN_IMPORTS) {
        const hit = imports.find((l) => l.includes(spec));
        expect(hit, `${f} must not import ${spec}: ${hit ?? ''}`).toBeUndefined();
      }
    }
    // POSITIVE control: the demo DOES import the proposal-only seam (tick) +
    // the read-only inbox store, proving the scan sees real imports.
    const demoImports = importLines(readSource('cli/demo.ts'));
    expect(demoImports.some((l) => l.includes('daemon/loop'))).toBe(true);
    expect(demoImports.some((l) => l.includes('inbox/store'))).toBe(true);
  });

  // DEMO-NEVER-APPLIES (static) — no outward CALL token in the demo source.
  it(`demo source (comments stripped) contains NONE of the outward CALL tokens: ${OUTWARD_TOKENS.join(', ')}`, () => {
    for (const f of DEMO_FILES) {
      const stripped = stripComments(readSource(f));
      for (const token of OUTWARD_TOKENS) {
        expect(containsToken(stripped, token), `${f} contains outward token ${token}`).toBe(false);
      }
    }
  });

  // NO-GUARD-WEAKENED (static→behavioral) — the demo's only proposal paths are
  // the daemon `tick` (proposal-only) and `createProposal` (writes a PENDING
  // record); it NEVER calls an apply/approve/PR/deploy primitive, so the
  // real-swarm branch cannot apply anything.
  it('the demo real-swarm branch is propose-only — tick is never invoked in a way that approves/applies', () => {
    const stripped = stripComments(readSource('cli/demo.ts'));
    // The real-swarm branch goes through the existing proposal-only tick.
    expect(containsToken(stripped, 'tick(')).toBe(true);
    // …and produces only a PENDING proposal record — never an apply/approve.
    expect(containsToken(stripped, 'applyProposal(')).toBe(false);
    expect(containsToken(stripped, 'approveProposal(')).toBe(false);
    expect(containsToken(stripped, "setStatus('approved'")).toBe(false);
    expect(containsToken(stripped, 'setStatus("approved"')).toBe(false);
    // The proposal it DOES create is created via createProposal (a PENDING write),
    // confirming the proposal path is the read/propose seam, not an apply seam.
    expect(containsToken(stripped, 'createProposal(')).toBe(true);
  });
});
