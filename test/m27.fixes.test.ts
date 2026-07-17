/**
 * M27 fixes tests — deriveSafeFixes + emitFixProposals.
 *
 * SAFETY GUARDRAILS:
 *  - HOME is overridden to a tmp dir so the real ~/.ashlr/inbox/ is never touched.
 *  - emitFixProposals is PROPOSAL-ONLY: it only calls createProposal() (pure
 *    persistence). It NEVER mutates a repo, NEVER pushes/PRs/deploys, NEVER
 *    auto-advances proposal status.
 *  - Each test is hermetic: fresh tmp HOME per test.
 *
 * Invariants asserted:
 *  - deriveSafeFixes derives advisory fixes from a seeded UNHEALTHY HealthScore
 *    (failed convention probes + worst offenders).
 *  - derived fixes default to proposalKind 'note', are deduped by key, bounded.
 *  - deriveSafeFixes is PURE (same input -> identical output; mutates nothing).
 *  - emitFixProposals creates PENDING 'note' proposals (origin 'manual', repo set).
 *  - emitted proposals carry NO diff and are never auto-advanced.
 *  - GUARD: fixes.ts source contains no saveConfig/CONFIG_PATH/applyProposal/
 *    setStatus/push write usage (read-only, proposal-only by construction).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation — before any module resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m27-fixes-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

import { deriveSafeFixes, emitFixProposals } from '../src/core/quality/fixes.js';
import { listProposals, inboxDir } from '../src/core/inbox/store.js';
import type {
  ConventionFinding,
  HealthScore,
  SafeFix,
  WorkItem,
} from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const REPO = path.join(fs.realpathSync.native(os.tmpdir()), 'unhealthy-repo');

function conv(key: string, label: string, ok: boolean, weight = 3): ConventionFinding {
  return { key, label, ok, weight, detail: `${label} probe (${ok ? 'ok' : 'missing'})` };
}

function work(source: WorkItem['source'], title: string, score = 5): WorkItem {
  return {
    id: `${REPO}:${source}:${title}`,
    repo: REPO,
    source,
    title,
    detail: `${source} finding: ${title}`,
    value: 4,
    effort: 2,
    score,
    tags: [source],
    ts: new Date().toISOString(),
  };
}

/** A seeded UNHEALTHY score: several failed conventions + actionable offenders. */
function unhealthyScore(): HealthScore {
  return {
    repo: REPO,
    score: 41,
    grade: 'F',
    dimensions: [],
    conventions: [
      conv('license', 'LICENSE file', false, 4),
      conv('readme', 'README', false, 3),
      conv('gitignore', '.gitignore', false, 2),
      conv('lockfile', 'lockfile', false, 3),
      conv('ci', 'CI workflow', false, 3),
      conv('testdir', 'test suite', false, 4),
      conv('something-unmapped', 'Unmapped probe', false, 1), // must be ignored
    ],
    worstOffenders: [
      work('dep', 'lodash@4.17.0 (vulnerable)', 9),
      work('test', 'src/auth.ts has no test', 8),
      work('todo', '12 TODO markers in src/', 7),
      work('security', 'hardcoded token suspected', 9), // not auto-noted
      work('issue', 'open issue #42', 6), // not auto-noted
    ],
    ts: new Date().toISOString(),
  };
}

// ===========================================================================
// deriveSafeFixes
// ===========================================================================

describe('M27 deriveSafeFixes — derivation from an unhealthy score', () => {
  it('derives advisory fixes from failed convention probes', () => {
    const fixes = deriveSafeFixes(unhealthyScore());
    const keys = fixes.map((f) => f.key);
    expect(keys).toContain('docs.add-license');
    expect(keys).toContain('docs.add-readme');
    expect(keys).toContain('conventions.add-gitignore');
    expect(keys).toContain('conventions.add-lockfile');
    expect(keys).toContain('conventions.add-ci');
    expect(keys).toContain('tests.add-test'); // testdir convention
  });

  it('ignores convention probes that are ok=true', () => {
    const score = unhealthyScore();
    score.conventions = [conv('license', 'LICENSE file', true, 4)];
    const fixes = deriveSafeFixes(score);
    expect(fixes.find((f) => f.key === 'docs.add-license')).toBeUndefined();
  });

  it('ignores unmapped convention keys', () => {
    const fixes = deriveSafeFixes(unhealthyScore());
    expect(fixes.find((f) => f.key.includes('something-unmapped'))).toBeUndefined();
  });

  it('derives fixes from actionable worst offenders (dep/test/todo)', () => {
    const fixes = deriveSafeFixes(unhealthyScore());
    expect(fixes.some((f) => f.key.startsWith('deps.upgrade:'))).toBe(true);
    expect(fixes.some((f) => f.key.startsWith('tests.add-test:'))).toBe(true);
    expect(fixes.some((f) => f.key.startsWith('codeDebt.resolve:'))).toBe(true);
  });

  it('does NOT derive fixes from security/issue offenders', () => {
    const fixes = deriveSafeFixes(unhealthyScore());
    expect(fixes.some((f) => f.dimension === 'security')).toBe(false);
    expect(fixes.some((f) => f.dimension === 'issuesCi')).toBe(false);
  });

  it('every derived fix defaults to proposalKind "note"', () => {
    const fixes = deriveSafeFixes(unhealthyScore());
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes.every((f) => f.proposalKind === 'note')).toBe(true);
  });

  it('every derived fix targets the score repo and has a non-empty rationale', () => {
    const fixes = deriveSafeFixes(unhealthyScore());
    expect(fixes.every((f) => f.repo === REPO)).toBe(true);
    expect(fixes.every((f) => f.rationale.length > 0)).toBe(true);
    expect(fixes.every((f) => f.title.length > 0)).toBe(true);
  });

  it('dedupes by key', () => {
    const score = unhealthyScore();
    // Two probes for the same convention key + duplicate dep offenders.
    score.conventions.push(conv('license', 'LICENSE file', false, 4));
    score.worstOffenders.push(work('dep', 'lodash@4.17.0 (vulnerable)', 9));
    const fixes = deriveSafeFixes(score);
    const keys = fixes.map((f) => f.key);
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });

  it('is bounded to MAX_FIXES_PER_REPO (10)', () => {
    const score = unhealthyScore();
    // Flood with distinct dep offenders.
    for (let i = 0; i < 50; i++) {
      score.worstOffenders.push(work('dep', `pkg-${i}@1.0.0`, 5));
    }
    const fixes = deriveSafeFixes(score);
    expect(fixes.length).toBeLessThanOrEqual(10);
  });

  it('returns [] for a clean score (no failed probes, no actionable offenders)', () => {
    const score = unhealthyScore();
    score.conventions = score.conventions.map((c) => ({ ...c, ok: true }));
    score.worstOffenders = [work('security', 'x', 9), work('issue', 'y', 6)];
    expect(deriveSafeFixes(score)).toEqual([]);
  });

  it('is PURE — deterministic, identical output across calls, mutates nothing', () => {
    const score = unhealthyScore();
    const snapshot = JSON.parse(JSON.stringify(score)) as HealthScore;
    const a = deriveSafeFixes(score);
    const b = deriveSafeFixes(score);
    expect(a).toEqual(b);
    // input untouched
    expect(score).toEqual(snapshot);
  });
});

// ===========================================================================
// emitFixProposals
// ===========================================================================

describe('M27 emitFixProposals — PENDING note proposals (proposal-only)', () => {
  it('emits one proposal per fix', () => {
    const fixes = deriveSafeFixes(unhealthyScore());
    const proposals = emitFixProposals(fixes);
    expect(proposals.length).toBe(fixes.length);
  });

  it('every emitted proposal is PENDING, kind="note", origin="manual"', () => {
    const proposals = emitFixProposals(deriveSafeFixes(unhealthyScore()));
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every((p) => p.status === 'pending')).toBe(true);
    expect(proposals.every((p) => p.kind === 'note')).toBe(true);
    expect(proposals.every((p) => p.origin === 'manual')).toBe(true);
  });

  it('emitted proposals carry NO diff (advisory note, no patch)', () => {
    const proposals = emitFixProposals(deriveSafeFixes(unhealthyScore()));
    expect(proposals.every((p) => p.diff === undefined)).toBe(true);
    expect(proposals.every((p) => p.sandboxId === undefined)).toBe(true);
  });

  it('emitted proposals set repo and a clear title + summary', () => {
    const proposals = emitFixProposals(deriveSafeFixes(unhealthyScore()));
    expect(proposals.every((p) => p.repo === REPO)).toBe(true);
    expect(proposals.every((p) => p.title.startsWith('[health] '))).toBe(true);
    expect(proposals.every((p) => p.summary.length > 0)).toBe(true);
  });

  it('downgrades a "patch" SafeFix to a "note" proposal (notes-only build)', () => {
    const patchFix: SafeFix = {
      repo: REPO,
      dimension: 'deps',
      key: 'deps.upgrade:foo',
      title: 'Upgrade foo',
      rationale: 'stretch patch fix',
      proposalKind: 'patch',
    };
    const proposals = emitFixProposals([patchFix]);
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.kind).toBe('note');
    expect(proposals[0]!.diff).toBeUndefined();
  });

  it('persists the proposals as PENDING into the inbox store', () => {
    const fixes = deriveSafeFixes(unhealthyScore());
    emitFixProposals(fixes);
    const pending = listProposals({ status: 'pending' });
    expect(pending.length).toBe(fixes.length);
    expect(pending.every((p) => p.kind === 'note')).toBe(true);
    // confirm they actually hit the tmp HOME inbox dir
    expect(inboxDir().startsWith(tmpHome)).toBe(true);
  });

  it('NEVER auto-advances status — no approved/applied proposal is created', () => {
    emitFixProposals(deriveSafeFixes(unhealthyScore()));
    expect(listProposals({ status: 'approved' })).toEqual([]);
    expect(listProposals({ status: 'applied' })).toEqual([]);
    expect(listProposals({ status: 'rejected' })).toEqual([]);
  });

  it('returns [] for [] and never throws', () => {
    expect(() => emitFixProposals([])).not.toThrow();
    expect(emitFixProposals([])).toEqual([]);
  });

  it('does NOT mutate the target repo working tree', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m27-fixes-repo-'));
    try {
      fs.writeFileSync(path.join(repoDir, 'file.txt'), 'original\n', 'utf8');
      const fix: SafeFix = {
        repo: repoDir,
        dimension: 'docs',
        key: 'docs.add-license',
        title: 'Add a LICENSE file',
        rationale: 'no license',
        proposalKind: 'note',
      };
      emitFixProposals([fix]);
      expect(fs.readFileSync(path.join(repoDir, 'file.txt'), 'utf8')).toBe('original\n');
      // no new files written into the repo by the fixes module
      expect(fs.readdirSync(repoDir)).toEqual(['file.txt']);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Source guard — proposal-only / read-only by construction
// ===========================================================================

describe('M27 fixes.ts source guard — no mutation/apply/push primitives', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'quality', 'fixes.ts'),
    'utf8',
  );

  it.each([
    'saveConfig',
    'CONFIG_PATH',
    'applyProposal',
    'setStatus',
  ])('does not reference %s', (token) => {
    expect(src.includes(token)).toBe(false);
  });

  it('does not invoke git/push/pr/deploy mutation primitives', () => {
    // No spawning / git pushing / PR / deploy helpers in a proposal-only module.
    expect(/\bgit\s+push\b/.test(src)).toBe(false);
    expect(/createPr\b/.test(src)).toBe(false);
    expect(/\bdeploy\(/.test(src)).toBe(false);
    expect(/child_process|execSync|spawnSync|\bspawn\(/.test(src)).toBe(false);
  });

  it('does not write to the filesystem directly (no fs write APIs)', () => {
    expect(/\bwriteFileSync\b|\bwriteFile\b|\brenameSync\b|\bmkdirSync\b/.test(src)).toBe(
      false,
    );
  });

  it('the ONLY inbox mutation it imports is createProposal', () => {
    expect(src.includes('createProposal')).toBe(true);
    // It must not import the status-changing / applying APIs.
    expect(/import[^;]*\bsetStatus\b/.test(src)).toBe(false);
  });
});
