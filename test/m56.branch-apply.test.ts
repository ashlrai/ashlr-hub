/**
 * M56 — mid→branch auto-apply, END-TO-END on a real tmp git repo.
 *
 * Proves the actual `autoMergeProposal` execution path (not just the pure gate):
 * a verified MID-tier proposal with midToBranch ON applies to a BRANCH and leaves
 * `main` untouched; with the flag OFF it is refused; a local-tier proposal is
 * always refused. HOME is redirected to a tmp dir so the real ~/.ashlr is never
 * touched (mirrors test/m47.merge.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { autoMergeProposal } from '../src/core/inbox/merge.js';
import { createProposal, setStatus, loadProposal } from '../src/core/inbox/store.js';
import { enroll, unenroll, setKill } from '../src/core/sandbox/policy.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import type { AshlrConfig } from '../src/core/types.js';

const origHome = process.env.HOME;
const origAllowAny = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
let tmpHome: string;
let tmpRepo: string;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

function initRepo(dir: string, branch = 'main'): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', `--initial-branch=${branch}`, dir], { stdio: 'pipe' });
  git(dir, ['config', 'user.email', 'test@ashlr.test']);
  git(dir, ['config', 'user.name', 'Ashlr Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
}

function addFileDiff(filename: string, content: string): string {
  return [
    `diff --git a/${filename} b/${filename}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${filename}`,
    '@@ -0,0 +1 @@',
    `+${content}`,
    '',
  ].join('\n');
}

function midCfg(midToBranch: boolean | undefined): AshlrConfig {
  return {
    foundry: {
      autoMerge: { enabled: true, maxRisk: 'low', allowWithoutVerification: true, midToBranch },
    },
  } as unknown as AshlrConfig;
}

function makeProposal(opts: { tier: string; model: string; file: string }): string {
  const diff = addFileDiff(opts.file, 'mid-tier content');
  const dh = hashDiff(diff);
  const p = createProposal({
    repo: tmpRepo,
    origin: 'agent',
    kind: 'patch',
    title: 'mid update',
    summary: 'a mid-tier docs change',
    diff,
    diffHash: dh,
    provenanceSig: signProvenance(opts.model, opts.tier, dh),
    engineModel: opts.model,
    engineTier: opts.tier as 'local' | 'mid' | 'frontier',
  } as Parameters<typeof createProposal>[0]);
  setStatus(p.id, 'approved');
  return p.id;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m56-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m56-repo-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  setKill(false);
  initRepo(tmpRepo, 'main');
  git(tmpRepo, ['checkout', '-b', 'work']); // sit off the default branch
  enroll(tmpRepo);
});

afterEach(() => {
  try { unenroll(tmpRepo); } catch { /* ignore */ }
  try { setKill(false); } catch { /* ignore */ }
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origAllowAny === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = origAllowAny;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('M56 — mid→branch applies to a branch, NEVER main', () => {
  it('a verified mid proposal with midToBranch ON is branch-applied; main is untouched', async () => {
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);
    const id = makeProposal({ tier: 'mid', model: 'hermes:hermes-3-llama-3.1-70b', file: 'docs/mid.md' });

    const r = await autoMergeProposal(id, midCfg(true));

    expect(r.ok).toBe(true);
    expect(r.merged).toBe(false); // NEVER merged to main
    expect(r.branched).toBe(true);
    expect(r.reason).toMatch(/never merged to main/);
    // main did NOT advance.
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    // The proposal is marked applied (so the pass won't re-open it every tick).
    expect(loadProposal(id)!.status).toBe('applied');
  });

  it('REFUSES the same mid proposal when midToBranch is OFF (default)', async () => {
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);
    const id = makeProposal({ tier: 'mid', model: 'hermes:hermes-3-llama-3.1-70b', file: 'docs/mid2.md' });

    const r = await autoMergeProposal(id, midCfg(undefined));

    expect(r.ok).toBe(false);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/midToBranch|disabled/);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(loadProposal(id)!.status).not.toBe('applied');
  });

  it('REFUSES a local-tier proposal even with midToBranch ON (proposal-only)', async () => {
    const id = makeProposal({ tier: 'local', model: 'aw:llama-3.1-8b', file: 'docs/local.md' });
    const r = await autoMergeProposal(id, midCfg(true));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/proposal-only \(local\)/);
    expect(loadProposal(id)!.status).not.toBe('applied');
  });
});
