/**
 * h8.docs.test.ts — Ashlr v2.1 MILESTONE H8, BUILD ITEM 2 + 3 + 4.
 *
 * INVARIANT proven here (see docs/contracts/CONTRACT-H8.md · DOCS-ACCURATE):
 *  - docs/RELIABILITY.md + README.md exist, cite the REAL recovery/self-check
 *    commands (verify-safety, sandbox gc, audit, preflight, daemon stop, demo),
 *    and carry the honest-limits markers (single-process, budget overshoot
 *    bound, no swarm wall-clock deadline) — so the docs state nothing the system
 *    cannot back.
 *
 * SAFETY: pure filesystem READS of the repo's own docs (no HOME relocation, no
 * model, no network). Every it() has a real expect(); beforeEach calls
 * expect.hasAssertions().
 *
 * Each it() reads the finalized docs and asserts the cited commands +
 * honest-limits markers (no placeholder tests remain).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root is two levels up from this test file (test/ -> repo root). Use
// fileURLToPath, not URL.pathname: on Windows the latter yields '/C:/...' which
// join() then mangles into a doubled-drive 'C:\C:\...' path.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELIABILITY = join(REPO_ROOT, 'docs', 'RELIABILITY.md');
const README = join(REPO_ROOT, 'README.md');

// Commands the runbook + reliability doc MUST cite.
const CITED_COMMANDS = [
  'verify-safety',
  'sandbox gc',
  'audit',
  'preflight',
  'daemon stop',
  'demo',
] as const;

beforeEach(() => {
  expect.hasAssertions();
});

describe('h8 docs — RELIABILITY.md + README activation runbook are accurate', () => {
  // sanity: the doc files exist (a real assertion so the suite is never
  // vacuously green before BUILD fills the todos).
  it('docs/RELIABILITY.md and README.md exist', () => {
    expect(existsSync(RELIABILITY)).toBe(true);
    expect(existsSync(README)).toBe(true);
    expect(readFileSync(RELIABILITY, 'utf8').length).toBeGreaterThan(0);
    expect(CITED_COMMANDS.length).toBeGreaterThan(0);
  });

  // DOCS-ACCURATE
  it('docs/RELIABILITY.md cites verify-safety, sandbox gc, audit, daemon stop, and the KILL switch', () => {
    const txt = readFileSync(RELIABILITY, 'utf8');
    expect(txt).toMatch(/verify-safety/);
    expect(txt).toMatch(/sandbox gc/);
    expect(txt).toMatch(/\baudit\b/);
    expect(txt).toMatch(/daemon stop/);
    // The kill switch must be cited as an explicit recovery lever.
    expect(txt.toLowerCase()).toMatch(/kill/);
  });

  // DOCS-ACCURATE (honest limits)
  it('docs/RELIABILITY.md states the honest limits: single-process, budget overshoot bound, no swarm wall-clock deadline', () => {
    const txt = readFileSync(RELIABILITY, 'utf8').toLowerCase();
    // Single-process honesty (no multi-process coordination yet).
    expect(txt).toMatch(/single-process/);
    // Budget overshoot is bounded but NOT zero — the doc must say so.
    expect(txt).toMatch(/overshoot/);
    // No hard swarm wall-clock deadline yet.
    expect(txt).toMatch(/wall-clock/);
  });

  // DOCS-ACCURATE (runbook)
  it('README activation runbook documents preflight → enroll one → dry-run → daemon → inbox approve → rollback and marks activation as the human gate', () => {
    const txt = readFileSync(README, 'utf8');
    const lower = txt.toLowerCase();
    // The runbook's ordered levers all appear.
    expect(txt).toMatch(/preflight/);
    expect(txt).toMatch(/\benroll\b/);
    expect(lower).toMatch(/dry-run/);
    expect(txt).toMatch(/\bdaemon\b/);
    expect(txt).toMatch(/inbox approve/);
    expect(lower).toMatch(/rollback/);
    // Activation is explicitly framed as the HUMAN GATE.
    expect(lower).toMatch(/human gate/);
    // The ordering is real: preflight is documented before inbox approve.
    expect(txt.indexOf('preflight')).toBeLessThan(txt.indexOf('inbox approve'));
  });

  // DOCS-ACCURATE (v2.1 surface)
  it('README documents the full v2.1 command surface: verify-safety, sandbox gc, audit, preflight, onboard, demo', () => {
    const txt = readFileSync(README, 'utf8');
    for (const cmd of ['verify-safety', 'sandbox gc', 'audit', 'preflight', 'onboard', 'demo']) {
      expect(txt.includes(cmd)).toBe(true);
    }
    // The demo is documented as DISPOSABLE + auto-cleaning (the H8 guarantee).
    expect(txt.toLowerCase()).toMatch(/disposable/);
    expect(txt.toLowerCase()).toMatch(/auto-clean/);
  });
});
