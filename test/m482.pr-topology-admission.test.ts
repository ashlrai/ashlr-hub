/**
 * M482 - read-only PR topology admission V1.
 *
 * Fixtures are hermetic. Tests never contact or mutate GitHub.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  evaluateTopology,
  fetchGithubSnapshot,
  parseSupersedes,
  renderMarkdown,
} from '../scripts/check-pr-topology.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const scriptPath = resolve(repoRoot, 'scripts/check-pr-topology.mjs');
const workflowPath = resolve(repoRoot, '.github/workflows/pr-topology.yml');
const repository = 'ashlrai/ashlr-hub';
const roots: string[] = [];

function oid(value: number): string {
  return value.toString(16).padStart(40, '0');
}

function pullRequest({
  number,
  headRef,
  baseRef,
  headSha = oid(number * 10 + 1),
  baseSha = oid(number * 10 + 2),
  headRepo = repository,
  baseRepo = repository,
  body = '',
}: {
  number: number;
  headRef: string;
  baseRef: string;
  headSha?: string;
  baseSha?: string;
  headRepo?: string;
  baseRepo?: string;
  body?: string;
}) {
  return {
    number,
    state: 'open',
    body,
    head: { ref: headRef, sha: headSha, repo: { full_name: headRepo } },
    base: { ref: baseRef, sha: baseSha, repo: { full_name: baseRepo } },
  };
}

function snapshot({
  candidate,
  pulls,
  comparisons = [],
  complete = true,
}: {
  candidate: number;
  pulls: ReturnType<typeof pullRequest>[];
  comparisons?: Array<Record<string, unknown>>;
  complete?: boolean;
}) {
  return {
    schemaVersion: 1,
    complete,
    repository: { full_name: repository, default_branch: 'master' },
    pullRequestNumber: candidate,
    pullRequests: pulls,
    comparisons,
  };
}

function comparison(baseSha: string, headSha: string, status = 'ahead') {
  return { baseSha, headSha, mergeBaseSha: baseSha, status, complete: true };
}

function response(body: unknown, { status = 200, link = null }: { status?: number; link?: string | null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'link' ? link : null) },
    json: vi.fn(async () => body),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('M482 topology graph admission', () => {
  it('maps a linear stack to exactly one open parent with exact SHAs', () => {
    const root = pullRequest({ number: 1, headRef: 'feature/root', baseRef: 'master' });
    const child = pullRequest({
      number: 2,
      headRef: 'feature/child',
      baseRef: root.head.ref,
      baseSha: root.head.sha,
    });

    const report = evaluateTopology(snapshot({ candidate: 2, pulls: [root, child] }));

    expect(report.admission).toBe('admitted');
    expect(report.relations).toContainEqual({
      pullRequest: 2,
      kind: 'stacked',
      parentPullRequest: 1,
      headRef: 'feature/child',
      headSha: child.head.sha,
      baseRef: 'feature/root',
      baseSha: root.head.sha,
      parentHeadSha: root.head.sha,
      baseHeadMatches: true,
    });
  });

  it('does not mistake a same-named fork branch for the target-repository parent', () => {
    const fork = pullRequest({
      number: 1,
      headRef: 'feature/root',
      headRepo: 'contributor/ashlr-hub',
      baseRef: 'master',
    });
    const parent = pullRequest({ number: 2, headRef: 'feature/root', baseRef: 'master' });
    const child = pullRequest({
      number: 3,
      headRef: 'feature/child',
      baseRef: 'feature/root',
      baseSha: parent.head.sha,
    });

    const report = evaluateTopology(snapshot({ candidate: 3, pulls: [fork, parent, child] }));

    expect(report.admission).toBe('admitted');
    expect(report.relations.find((entry: { pullRequest: number }) => entry.pullRequest === 3))
      .toMatchObject({ parentPullRequest: 2, parentHeadSha: parent.head.sha });
  });

  it('fails closed when a stacked base is ambiguous', () => {
    const first = pullRequest({ number: 1, headRef: 'shared', baseRef: 'master' });
    const second = pullRequest({ number: 2, headRef: 'shared', baseRef: 'master' });
    const child = pullRequest({ number: 3, headRef: 'child', baseRef: 'shared' });

    const report = evaluateTopology(snapshot({ candidate: 3, pulls: [first, second, child] }));

    expect(report.admission).toBe('blocked');
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'ambiguous-base' }));
  });

  it('fails closed when a non-default base has no open parent', () => {
    const child = pullRequest({ number: 3, headRef: 'child', baseRef: 'missing-parent' });
    const report = evaluateTopology(snapshot({ candidate: 3, pulls: [child] }));

    expect(report.admission).toBe('blocked');
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'orphan-base' }));
  });

  it('fails closed when the child base SHA is stale relative to its parent head', () => {
    const parent = pullRequest({ number: 1, headRef: 'parent', baseRef: 'master' });
    const child = pullRequest({
      number: 2,
      headRef: 'child',
      baseRef: 'parent',
      baseSha: oid(999),
    });

    const report = evaluateTopology(snapshot({ candidate: 2, pulls: [parent, child] }));

    expect(report.admission).toBe('blocked');
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'stale-parent-head',
      pullRequest: 2,
    }));
    expect(report.relations).toContainEqual(expect.objectContaining({
      pullRequest: 2,
      parentPullRequest: 1,
      baseHeadMatches: false,
    }));
  });

  it('proves contained default-branch roots and requires explicit declarations', () => {
    const root = pullRequest({ number: 10, headRef: 'convergence-root', baseRef: 'master' });
    const candidate = pullRequest({ number: 20, headRef: 'convergence-final', baseRef: 'master' });
    const ancestry = comparison(root.head.sha, candidate.head.sha);

    const missing = evaluateTopology(
      snapshot({ candidate: 20, pulls: [root, candidate], comparisons: [ancestry] }),
    );
    expect(missing.admission).toBe('blocked');
    expect(missing.containedRoots).toEqual([
      expect.objectContaining({
        pullRequest: 10,
        headSha: root.head.sha,
        convergenceHeadSha: candidate.head.sha,
        mergeBaseSha: root.head.sha,
      }),
    ]);
    expect(missing.supersedes.missing).toEqual([10]);

    candidate.body = 'Convergence release\n\nSupersedes: #10\n';
    const declared = evaluateTopology(
      snapshot({ candidate: 20, pulls: [root, candidate], comparisons: [ancestry] }),
    );
    expect(declared.admission).toBe('admitted');
    expect(declared.supersedes).toMatchObject({ declared: [10], required: [10], missing: [] });
    expect(parseSupersedes(
      '<!--\nSupersedes: #8\n-->\n```text\nSupersedes: #9\n```\nSupersedes: #10',
    )).toEqual([10]);
  });

  it('admits an ordinary default-branch PR when exact comparison proves no containment', () => {
    const independent = pullRequest({ number: 10, headRef: 'independent', baseRef: 'master' });
    const candidate = pullRequest({ number: 20, headRef: 'ordinary', baseRef: 'master' });
    const notContained = {
      ...comparison(independent.head.sha, candidate.head.sha, 'diverged'),
      mergeBaseSha: oid(999),
    };

    const report = evaluateTopology(
      snapshot({ candidate: 20, pulls: [independent, candidate], comparisons: [notContained] }),
    );

    expect(report.admission).toBe('admitted');
    expect(report.containedRoots).toEqual([]);
    expect(report.supersedes.required).toEqual([]);
  });

  it('fails closed for incomplete pagination or absent comparison evidence', () => {
    const root = pullRequest({ number: 1, headRef: 'root', baseRef: 'master' });
    const candidate = pullRequest({ number: 2, headRef: 'candidate', baseRef: 'master' });

    const incomplete = evaluateTopology(
      snapshot({ candidate: 2, pulls: [root, candidate], complete: false }),
    );
    expect(incomplete.admission).toBe('blocked');
    expect(incomplete.complete).toBe(false);
    expect(incomplete.diagnostics.map((entry: { code: string }) => entry.code)).toEqual(
      expect.arrayContaining(['incomplete-input', 'comparison-incomplete']),
    );
  });

  it('rejects unbounded fixture comparison input before graph materialization', () => {
    const candidate = pullRequest({ number: 1, headRef: 'candidate', baseRef: 'master' });
    const comparisons = Array.from({ length: 1_001 }, () => ({}));

    const report = evaluateTopology(snapshot({ candidate: 1, pulls: [candidate], comparisons }));

    expect(report.admission).toBe('blocked');
    expect(report.complete).toBe(false);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({ code: 'invalid-input', message: expect.stringContaining('comparison bound') }),
    ]);
  });

  it('paginates read-only GitHub GETs and includes every open PR', async () => {
    const root = pullRequest({ number: 1, headRef: 'root', baseRef: 'master' });
    const candidate = pullRequest({
      number: 2,
      headRef: 'child',
      baseRef: 'root',
      baseSha: root.head.sha,
    });
    const pageTwo = 'https://api.github.com/repos/ashlrai/ashlr-hub/pulls?state=open&per_page=100&page=2';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ full_name: repository, default_branch: 'master' }))
      .mockResolvedValueOnce(response([root], { link: `<${pageTwo}>; rel="next"` }))
      .mockResolvedValueOnce(response([candidate]));

    const raw = await fetchGithubSnapshot({
      repository,
      pullRequestNumber: 2,
      token: 'test-token',
      fetchImpl,
    });

    expect(raw.complete).toBe(true);
    expect(raw.pullRequests).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    }
    expect(evaluateTopology(raw).admission).toBe('admitted');
  });

  it('rejects API failure without attempting any mutation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}, { status: 503 }));
    await expect(
      fetchGithubSnapshot({ repository, pullRequestNumber: 1, token: 'test-token', fetchImpl }),
    ).rejects.toThrow('GitHub API GET failed with status 503');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('emits bounded injection-safe Markdown without echoing PR body content', () => {
    const candidate = pullRequest({
      number: 1,
      headRef: 'feature/injection-check',
      baseRef: 'stack/<script>|value',
      body: '::error:: forged\n<script>alert(1)</script>\nSupersedes: #999',
    });
    const report = evaluateTopology(snapshot({ candidate: 1, pulls: [candidate] }));
    const markdown = renderMarkdown(report);

    expect(parseSupersedes(candidate.body)).toEqual([999]);
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('::error::');
    expect(markdown).toContain('&lt;script&gt;&#124;value');
    expect(Buffer.byteLength(markdown, 'utf8')).toBeLessThan(100_000);
  });

  it('writes deterministic JSON and Markdown files from fixture input', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-pr-topology-'));
    roots.push(root);
    const input = join(root, 'input.json');
    const jsonOut = join(root, 'report.json');
    const markdownOut = join(root, 'report.md');
    const candidate = pullRequest({ number: 1, headRef: 'feature', baseRef: 'master' });
    writeFileSync(input, JSON.stringify(snapshot({ candidate: 1, pulls: [candidate] })), 'utf8');

    execFileSync(
      process.execPath,
      [scriptPath, '--input', input, '--json-out', jsonOut, '--markdown-out', markdownOut],
      { encoding: 'utf8' },
    );

    expect(JSON.parse(readFileSync(jsonOut, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      mode: 'shadow',
      admission: 'admitted',
      candidate: { pullRequest: 1, headSha: candidate.head.sha, baseSha: candidate.base.sha },
    });
    expect(readFileSync(markdownOut, 'utf8')).toContain('# PR Topology Admission V1');
  });
});

describe('M482 shadow workflow policy', () => {
  const workflowText = readFileSync(workflowPath, 'utf8');
  const workflow = parse(workflowText) as Record<string, any>;
  const job = workflow.jobs.topology as Record<string, any>;
  const steps = job.steps as Array<Record<string, any>>;

  it('is an explicitly non-mutating shadow check with least privilege', () => {
    expect(workflow.name).toBe('PR topology admission (shadow)');
    expect(workflow.on).toHaveProperty('pull_request_target');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on).not.toHaveProperty('pull_request');
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(job.name).toBe('PR topology admission (shadow)');
    expect(job).not.toHaveProperty('permissions');
    expect(workflowText).not.toMatch(/\b(comment|label|close|merge|retarget|delete)\b.*\b(pr|pull request)\b/i);
  });

  it('pins all actions to reviewed immutable SHAs and drops checkout credentials', () => {
    const actionSteps = steps.filter((step) => typeof step.uses === 'string');
    expect(actionSteps.map((step) => step.uses)).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    ]);
    expect(actionSteps[0]?.with).toEqual({
      'persist-credentials': false,
      ref: '${{ github.event.repository.default_branch }}',
      path: 'trusted-auditor',
    });
    for (const step of actionSteps) {
      expect(step.uses).toMatch(/^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}$/i);
    }
  });

  it('keeps audit failure fail-closed while still publishing the bounded summary', () => {
    const inspect = steps.find((step) => step.name === 'Inspect open PR topology without mutation');
    const summary = steps.find((step) => step.name === 'Publish bounded shadow summary');
    expect(inspect).not.toHaveProperty('continue-on-error');
    expect(inspect.run).toContain('node trusted-auditor/scripts/check-pr-topology.mjs');
    expect(inspect.run).toContain('--json-out pr-topology.json');
    expect(inspect.run).toContain('--markdown-out pr-topology.md');
    expect(summary.if).toBe('always()');
    expect(summary.run).toContain('cat pr-topology.md >> "$GITHUB_STEP_SUMMARY"');
  });

  it('contains no GitHub mutation surface in the auditor', () => {
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain("method: 'GET'");
    expect(script).not.toMatch(/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
    expect(script).not.toMatch(/\bgh\s+(?:pr|api|issue|release)\b/);
    expect(script).not.toMatch(/api\.github\.com\/(?:graphql|user|orgs)\b/);
  });

  it('never checks out or executes pull-request-authored code in the token-bearing job', () => {
    const checkout = steps.find((step) => step.name === 'Checkout topology auditor');
    const inspect = steps.find((step) => step.name === 'Inspect open PR topology without mutation');
    expect(checkout.with.ref).toBe('${{ github.event.repository.default_branch }}');
    expect(checkout.with.path).toBe('trusted-auditor');
    expect(inspect.run).toMatch(/^node trusted-auditor\/scripts\/check-pr-topology\.mjs/);
    expect(workflowText).not.toContain('github.event.pull_request.head.sha');
    expect(workflowText).not.toContain('github.head_ref');
  });
});
