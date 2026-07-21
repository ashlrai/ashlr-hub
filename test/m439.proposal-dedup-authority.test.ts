import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashDiff } from '../src/core/foundry/provenance.js';
import {
  createProposal,
  inboxDir,
  isDiffDedupResult,
  listProposals,
  loadProposal,
} from '../src/core/inbox/store.js';
import { selectInboxStore } from '../src/core/seams/inbox.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

const DIFF_A = 'diff --git a/src/a.ts b/src/a.ts\n+export const value = 1;\n';
const DIFF_B = 'diff --git a/src/b.ts b/src/b.ts\n+export const value = 2;\n';
const GENERATION_A = 'a'.repeat(64);
const GENERATION_B = 'b'.repeat(64);

let priorHome: string | undefined;
let priorAllowAnyRepo: string | undefined;
let priorPulseUrl: string | undefined;
let home: string;
let repoA: string;
let repoB: string;

beforeEach(() => {
  priorHome = process.env.HOME;
  priorAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  priorPulseUrl = process.env.PULSE_URL;
  home = mkdtempSync(join(tmpdir(), 'ashlr-proposal-dedup-authority-'));
  repoA = join(home, 'repo-a');
  repoB = join(home, 'repo-b');
  mkdirSync(repoA);
  mkdirSync(repoB);
  process.env.HOME = home;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  delete process.env.PULSE_URL;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = priorAllowAnyRepo;
  if (priorPulseUrl === undefined) delete process.env.PULSE_URL;
  else process.env.PULSE_URL = priorPulseUrl;
  rmSync(home, { recursive: true, force: true });
});

function proposalInput(
  repo: string,
  overrides: Partial<Omit<Proposal, 'id' | 'status' | 'createdAt'>> = {},
): Omit<Proposal, 'id' | 'status' | 'createdAt'> {
  return {
    repo,
    origin: 'agent',
    kind: 'patch',
    title: 'same work retry',
    summary: 'same canonical change',
    diff: DIFF_A,
    diffHash: hashDiff(DIFF_A),
    workItemId: 'issue:authority-fix',
    workItemGenerationId: GENERATION_A,
    ...overrides,
  };
}

function rewriteProposal(id: string, mutate: (proposal: Proposal) => void): void {
  const path = join(inboxDir(), `${id}.json`);
  const proposal = JSON.parse(readFileSync(path, 'utf8')) as Proposal;
  mutate(proposal);
  writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function durableProposalFiles(): string[] {
  return readdirSync(inboxDir()).filter((file) => file.endsWith('.json')).sort();
}

describe('proposal dedup authority', () => {
  it('files identical canonical diffs independently across repositories', () => {
    const first = createProposal(proposalInput(repoA));
    const second = createProposal(proposalInput(repoB));

    expect(first.status).toBe('pending');
    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
    expect(listProposals({ status: 'pending' })).toHaveLength(2);
  });

  it.each([
    ['a different work item', { workItemId: 'issue:other-work' }],
    ['a different generation', { workItemGenerationId: GENERATION_B }],
    ['a missing generation', { workItemGenerationId: undefined }],
  ])('files identical diffs for %s instead of inheriting prior work authority', (_case, authority) => {
    const first = createProposal(proposalInput(repoA));
    const second = createProposal(proposalInput(repoA, authority));

    expect(first.status).toBe('pending');
    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
    expect(listProposals({ status: 'pending' })).toHaveLength(2);
  });

  it('threads production-velocity freshness through the inbox seam without rejecting stale work', () => {
    const first = createProposal(proposalInput(repoA));
    rewriteProposal(first.id, (proposal) => {
      proposal.createdAt = new Date(Date.now() - (48 * 60 * 60 * 1000)).toISOString();
    });
    const cfg = {
      version: 1,
      foundry: {
        productionVelocity: {
          enabled: true,
          profile: 'resource-control',
          stalePendingTtlHours: 24,
        },
      },
    } as AshlrConfig;

    const second = selectInboxStore(cfg).create(proposalInput(repoA));

    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
    expect(listProposals({ status: 'pending' })).toHaveLength(2);
    expect(listProposals().find((proposal) => proposal.id === first.id)?.status).toBe('pending');
  });

  it('does not let a forged stored hash suppress different canonical diff bytes', () => {
    const first = createProposal(proposalInput(repoA));
    rewriteProposal(first.id, (proposal) => {
      proposal.diffHash = hashDiff(DIFF_B);
    });

    const second = createProposal(proposalInput(repoA, {
      diff: DIFF_B,
      diffHash: hashDiff(DIFF_B),
    }));

    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
    expect(listProposals({ status: 'pending' })).toHaveLength(2);
  });

  it('never returns a synthetic dedup rejection for a manual proposal', () => {
    const first = createProposal(proposalInput(repoA));
    writeFileSync(join(inboxDir(), 'invalid.json'), '{not-json\n', { encoding: 'utf8', mode: 0o600 });
    const manual = createProposal(proposalInput(repoA, { origin: 'manual' }));

    expect(first.status).toBe('pending');
    expect(manual.status).toBe('pending');
    expect(manual.id).not.toBe(first.id);
    expect(isDiffDedupResult(manual)).toBe(false);
    expect(loadProposal(manual.id)?.status).toBe('pending');
  });

  it.runIf(process.platform !== 'win32')(
    'atomically admits one durable proposal for concurrent same-work duplicates',
    async () => {
      const storeUrl = pathToFileURL(resolve('src/core/inbox/store.ts')).href;
      const input = proposalInput(join(repoA, 'missing', '..'));
      const script = [
        `import { createProposal } from ${JSON.stringify(storeUrl)};`,
        `const result = createProposal(${JSON.stringify(input)});`,
        "process.stdout.write(JSON.stringify({ id: result.id, status: result.status, reason: result.decisionReason }));",
      ].join('\n');
      const tsx = resolve('node_modules/.bin/tsx');
      const runChild = (): Promise<{ id: string; status: string; reason?: string }> =>
        new Promise((resolveChild, rejectChild) => {
          const child = spawn(tsx, ['-e', script], {
            env: {
              ...process.env,
              HOME: home,
              ASHLR_TEST_ALLOW_ANY_REPO: '1',
              PULSE_URL: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
          child.once('error', rejectChild);
          child.once('close', (code) => {
            if (code !== 0) {
              rejectChild(new Error(`proposal child exited ${code}: ${stderr}`));
              return;
            }
            resolveChild(JSON.parse(stdout) as { id: string; status: string; reason?: string });
          });
        });

      const results = await Promise.all([runChild(), runChild()]);

      expect(results.map((result) => result.status).sort()).toEqual(['pending', 'rejected']);
      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results.find((result) => result.status === 'rejected')?.reason).toContain('diffHash dedup');
      expect(durableProposalFiles()).toHaveLength(1);
      expect(listProposals({ status: 'pending' })).toHaveLength(1);
    },
    15_000,
  );
});
