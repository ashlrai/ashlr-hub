/**
 * Test fakes for V3.10 Track B unit U3 (gates + GitHub App host merge).
 *
 * FakeGithub is a GitHub REST fake backed by a REAL bare git repository, so
 * blob / tree / commit ids are genuinely content-addressed: when host-merge.ts
 * checks "GitHub built exactly the verified tree", the fake computes that tree
 * the way GitHub would. It implements only the endpoints the host merge uses,
 * enforces the merge rules that matter (SHA pin ⇒ 409, required checks ⇒ 405)
 * and records every call so tests can prove a merge was — or was never — sent.
 *
 * The fleet mirror is a real clone at ~/.ashlr/fleet/mirrors/<owner>__<name>
 * inside the test's isolated HOME, with a GitHub-shaped origin URL.
 *
 * REAL-IO: everything here spawns git. Tests using it belong in the real-io
 * lane (test/config/realio-lane-membership.mjs — see the U3 report).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { GithubCall, GithubReply, GithubTransport } from '../../src/core/fleet/host-merge.js';
import type { LedgerAppendInput, LedgerAppendResult, LedgerEventKind, LedgerHead } from '../../src/core/authority/types.js';
import type { EffectivePolicy, EffectiveRepoPolicy } from '../../src/core/authority/types.js';
import { hashDiff, signJudgeAttestation, signProvenance } from '../../src/core/foundry/provenance.js';
import type { DecisionEntry, Proposal } from '../../src/core/types.js';

export const BOT_LOGIN = 'ashlr-fleet[bot]';
export const BOT_EMAIL = '41898282+ashlr-fleet[bot]@users.noreply.github.com';
export const CI_APP_ID = 15368;

const GIT_ENV_BASE = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function run(args: readonly string[], opts: { cwd?: string; env?: Record<string, string>; input?: string | Buffer } = {}): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: { ...GIT_ENV_BASE, HOME: homedir(), ...opts.env },
    stdio: 'pipe',
    encoding: 'utf8',
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  }).trim();
}

const HUMAN = {
  GIT_AUTHOR_NAME: 'Mason',
  GIT_AUTHOR_EMAIL: 'mason@example.invalid',
  GIT_COMMITTER_NAME: 'Mason',
  GIT_COMMITTER_EMAIL: 'mason@example.invalid',
};

const BOT = {
  GIT_AUTHOR_NAME: BOT_LOGIN,
  GIT_AUTHOR_EMAIL: BOT_EMAIL,
  GIT_COMMITTER_NAME: 'GitHub',
  GIT_COMMITTER_EMAIL: 'noreply@github.com',
};

export interface FakeCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  appId: number | null;
}

export interface FakePull {
  number: number;
  nodeId: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  userLogin: string;
  labels: Set<string>;
  title: string;
  body: string;
}

export interface FakeGithubOptions {
  repo?: string;
  defaultBranch?: string;
  /** Required status checks on the default branch ([] = none → owner lane). */
  required?: { context: string; appId: number | null }[];
  /** Files of the initial commit. */
  files?: Record<string, string>;
  /** Classic branch-protection status checks, as GET /branches/{b} reports them. */
  classic?: { enforcement_level: string; contexts: string[] };
}

/** A GitHub REST fake over a real bare repository. */
export class FakeGithub {
  readonly repo: string;
  readonly defaultBranch: string;
  readonly root: string;
  readonly bare: string;
  readonly mirror: string;
  required: { context: string; appId: number | null }[];
  readonly pulls = new Map<number, FakePull>();
  readonly checkRuns = new Map<string, FakeCheckRun[]>();
  readonly statuses = new Map<string, { context: string; state: string }[]>();
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  readonly comments: { number: number; body: string }[] = [];
  /** Test hook: runs right before a PUT /merge is evaluated (e.g. push to the head). */
  beforeMerge: (() => void) | null = null;
  /** Test hook: corrupt the tree id GitHub answers for POST /git/trees. */
  corruptTrees = false;
  readonly classic: { enforcement_level: string; contexts: string[] } | null;
  private nextPr = 1;
  private nextCheck = 1000;

  constructor(opts: FakeGithubOptions = {}) {
    this.repo = opts.repo ?? 'ashlrai/fleet-canary';
    this.defaultBranch = opts.defaultBranch ?? 'main';
    this.required = opts.required ?? [{ context: 'ci/test', appId: CI_APP_ID }];
    this.classic = opts.classic ?? null;
    this.root = mkdtempSync(join(tmpdir(), 'ashlr-fake-github-'));
    this.bare = join(this.root, 'origin.git');
    run(['init', '--quiet', '--bare', `--initial-branch=${this.defaultBranch}`, this.bare]);
    // Seed through a throwaway work tree.
    const seed = join(this.root, 'seed');
    run(['init', '--quiet', `--initial-branch=${this.defaultBranch}`, seed]);
    const files = opts.files ?? {
      'README.md': '# canary\n',
      'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      'test/math.test.ts': "import { it, expect } from 'vitest';\nimport { add } from '../src/math.js';\nit('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
      'package.json': '{ "name": "canary", "version": "1.0.0" }\n',
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(seed, path)), { recursive: true });
      writeFileSync(join(seed, path), content);
    }
    run(['add', '-A'], { cwd: seed });
    run(['commit', '--quiet', '-m', 'initial'], { cwd: seed, env: HUMAN });
    run(['push', '--quiet', this.bare, `HEAD:refs/heads/${this.defaultBranch}`], { cwd: seed });
    rmSync(seed, { recursive: true, force: true });
    // The fleet mirror, at the layout SPEC-310B §2 fixes, with a GitHub-shaped origin.
    const [owner, name] = this.repo.split('/');
    this.mirror = join(homedir(), '.ashlr', 'fleet', 'mirrors', `${owner}__${name}`);
    mkdirSync(dirname(this.mirror), { recursive: true });
    run(['clone', '--quiet', this.bare, this.mirror]);
    run(['remote', 'set-url', 'origin', `https://github.com/${this.repo}.git`], { cwd: this.mirror });
    run(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${this.defaultBranch}`], { cwd: this.mirror });
  }

  dispose(): void {
    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch { /* tmp */ }
  }

  // ── git helpers ──────────────────────────────────────────────────────────

  git(args: readonly string[], opts: { env?: Record<string, string>; input?: string | Buffer } = {}): string {
    return run(['--git-dir', this.bare, ...args], opts);
  }

  head(branch = this.defaultBranch): string | null {
    try {
      return this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]) || null;
    } catch {
      return null;
    }
  }

  treeOf(sha: string): string {
    return this.git(['rev-parse', `${sha}^{tree}`]);
  }

  /** Bring the mirror to the origin's current state (what U6's per-tick reset does). */
  syncMirror(): void {
    run(['fetch', '--quiet', this.bare, '+refs/heads/*:refs/remotes/origin/*'], { cwd: this.mirror });
    const head = this.head();
    if (head) run(['update-ref', `refs/heads/${this.defaultBranch}`, head], { cwd: this.mirror });
  }

  /** A human commit straight onto a branch of the origin (moves the base / races a head). */
  pushCommit(branch: string, files: Record<string, string | null>, message = 'human change', env: Record<string, string> = HUMAN): string {
    const parent = this.head(branch);
    const index = join(this.root, `idx-${Math.random().toString(16).slice(2)}`);
    const withIndex = { GIT_INDEX_FILE: index, ...env };
    if (parent) this.git(['read-tree', parent], { env: withIndex });
    const lines: string[] = [];
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        lines.push(`0 0000000000000000000000000000000000000000\t${path}`);
      } else {
        const blob = this.git(['hash-object', '-w', '--stdin'], { input: content });
        lines.push(`100644 ${blob}\t${path}`);
      }
    }
    this.git(['update-index', '--index-info'], { env: withIndex, input: `${lines.join('\n')}\n` });
    const tree = this.git(['write-tree'], { env: withIndex });
    const commit = this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], { env: withIndex, input: message });
    this.git(['update-ref', `refs/heads/${branch}`, commit]);
    try { unlinkSync(index); } catch { /* none */ }
    return commit;
  }

  /** Unified diff of `files` against the default branch head (well-formed, as a producer captures it). */
  diffFor(files: Record<string, string | null>): string {
    return this.diffAndTree(files).diff;
  }

  /**
   * The diff AND the tree a worktree holds after `git add -A` — i.e. exactly
   * what verifyProposal's `git apply --index` worktree tests.
   */
  diffAndTree(files: Record<string, string | null>): { diff: string; tree: string } {
    const work = mkdtempSync(join(this.root, 'wt-'));
    run(['--git-dir', this.bare, 'worktree', 'add', '--quiet', '--detach', work, this.defaultBranch]);
    try {
      for (const [path, content] of Object.entries(files)) {
        const full = join(work, path);
        if (content === null) rmSync(full, { force: true });
        else {
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, content);
        }
      }
      run(['add', '-A'], { cwd: work });
      const diff = `${run(['diff', '--cached', '--no-color', '--no-ext-diff'], { cwd: work })}\n`;
      return { diff, tree: run(['write-tree'], { cwd: work }) };
    } finally {
      run(['--git-dir', this.bare, 'worktree', 'remove', '--force', work]);
    }
  }

  // ── checks ───────────────────────────────────────────────────────────────

  setCheck(sha: string, name: string, conclusion: string | null, appId: number | null = CI_APP_ID, status: FakeCheckRun['status'] = 'completed'): void {
    const runs = this.checkRuns.get(sha) ?? [];
    runs.push({ id: this.nextCheck++, name, status, conclusion, appId });
    this.checkRuns.set(sha, runs);
  }

  greenRequired(sha: string): void {
    for (const required of this.required) this.setCheck(sha, required.context, 'success', required.appId);
  }

  headOfPull(number: number): string | null {
    const pull = this.pulls.get(number);
    return pull ? this.head(pull.headRef) : null;
  }

  mergeCalls(): { method: string; path: string; body: unknown }[] {
    return this.calls.filter((call) => call.method === 'PUT' && /\/merge$/.test(call.path));
  }

  // ── REST ─────────────────────────────────────────────────────────────────

  readonly transport: GithubTransport = async (call: GithubCall): Promise<GithubReply> => {
    this.calls.push({ method: call.method, path: call.path, body: call.body });
    if (!call.token) return { status: 401, body: { message: 'Bad credentials' } };
    const prefix = `/repos/${this.repo}`;
    if (!call.path.startsWith(prefix)) return { status: 404, body: { message: 'Not Found' } };
    const [pathPart, query = ''] = call.path.slice(prefix.length).split('?');
    const path = decodeURIComponent(pathPart ?? '');
    const params = new URLSearchParams(query);
    try {
      return this.route(call.method, path, params, call.body as Record<string, unknown> | undefined);
    } catch (error) {
      return { status: 500, body: { message: error instanceof Error ? error.message : String(error) } };
    }
  };

  private pullJson(pull: FakePull): Record<string, unknown> {
    return {
      number: pull.number,
      node_id: pull.nodeId,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      title: pull.title,
      user: { login: pull.userLogin },
      head: { ref: pull.headRef, sha: this.head(pull.headRef) ?? '0'.repeat(40), repo: { full_name: this.repo } },
      base: { ref: pull.baseRef, sha: this.head(pull.baseRef), repo: { full_name: this.repo } },
      labels: [...pull.labels].map((name) => ({ name })),
    };
  }

  private commitJson(sha: string): Record<string, unknown> | null {
    let raw: string;
    try {
      raw = this.git(['cat-file', 'commit', sha]);
    } catch {
      return null;
    }
    const [header, ...rest] = raw.split('\n\n');
    const tree = /^tree ([0-9a-f]{40})$/m.exec(header ?? '')?.[1];
    const parents = [...(header ?? '').matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => ({ sha: m[1] }));
    const author = /^author (.*) <([^>]*)> /m.exec(header ?? '');
    return { sha, tree: { sha: tree }, parents, author: { name: author?.[1] ?? null, email: author?.[2] ?? null }, message: rest.join('\n\n') };
  }

  private requiredGreen(sha: string): boolean {
    const runs = this.checkRuns.get(sha) ?? [];
    return this.required.every((required) => runs.some((run) => run.name === required.context &&
      (required.appId === null || run.appId === required.appId) && run.status === 'completed' && run.conclusion === 'success'));
  }

  private route(method: string, path: string, params: URLSearchParams, body: Record<string, unknown> | undefined): GithubReply {
    if (method === 'GET' && path === '') return { status: 200, body: { node_id: 'R_kgDOfleetcanary', default_branch: this.defaultBranch, full_name: this.repo } };
    let m: RegExpExecArray | null;
    if (method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(path))) {
      const sha = this.head(m[1]!);
      return sha ? { status: 200, body: { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'GET' && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(path))) {
      const json = this.commitJson(m[1]!);
      return json ? { status: 200, body: json } : { status: 404, body: { message: 'Not Found' } };
    }
    if (method === 'POST' && path === '/git/blobs') {
      const content = Buffer.from(String(body?.['content'] ?? ''), 'base64');
      return { status: 201, body: { sha: this.git(['hash-object', '-w', '--stdin'], { input: content }) } };
    }
    if (method === 'POST' && path === '/git/trees') {
      const index = join(this.root, `tree-${Math.random().toString(16).slice(2)}`);
      const env = { GIT_INDEX_FILE: index };
      if (typeof body?.['base_tree'] === 'string') this.git(['read-tree', body['base_tree']], { env });
      const lines = (body?.['tree'] as { path: string; mode: string; sha: string | null }[]).map((entry) =>
        entry.sha === null ? `0 0000000000000000000000000000000000000000\t${entry.path}` : `${entry.mode} ${entry.sha}\t${entry.path}`);
      this.git(['update-index', '--index-info'], { env, input: `${lines.join('\n')}\n` });
      const tree = this.git(['write-tree'], { env });
      try { unlinkSync(index); } catch { /* none */ }
      return { status: 201, body: { sha: this.corruptTrees ? 'f'.repeat(40) : tree } };
    }
    if (method === 'POST' && path === '/git/commits') {
      const parents = (body?.['parents'] as string[]).flatMap((p) => ['-p', p]);
      const sha = this.git(['commit-tree', String(body?.['tree']), ...parents, '-F', '-'], { env: BOT, input: String(body?.['message'] ?? '') });
      return { status: 201, body: this.commitJson(sha) };
    }
    if (method === 'POST' && path === '/git/refs') {
      const ref = String(body?.['ref']);
      const branch = ref.replace(/^refs\/heads\//, '');
      if (this.head(branch)) return { status: 422, body: { message: 'Reference already exists' } };
      this.git(['update-ref', ref, String(body?.['sha'])]);
      return { status: 201, body: { ref, object: { sha: body?.['sha'], type: 'commit' } } };
    }
    if (method === 'PATCH' && (m = /^\/git\/refs\/heads\/(.+)$/.exec(path))) {
      this.git(['update-ref', `refs/heads/${m[1]}`, String(body?.['sha'])]);
      return { status: 200, body: { ref: `refs/heads/${m[1]}`, object: { sha: body?.['sha'], type: 'commit' } } };
    }
    if (method === 'GET' && path === '/pulls') {
      const head = params.get('head') ?? '';
      const branch = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
      const state = params.get('state') ?? 'open';
      const list = [...this.pulls.values()].filter((p) => p.headRef === branch && (state === 'all' || p.state === state));
      return { status: 200, body: list.map((p) => this.pullJson(p)) };
    }
    if (method === 'POST' && path === '/pulls') {
      const head = String(body?.['head']);
      if ([...this.pulls.values()].some((p) => p.headRef === head && p.state === 'open')) {
        return { status: 422, body: { message: 'A pull request already exists' } };
      }
      if (!this.head(head)) return { status: 422, body: { message: 'head does not exist' } };
      const pull: FakePull = {
        number: this.nextPr++,
        nodeId: `PR_kwDOfake${this.nextPr}`,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: String(body?.['base']),
        userLogin: BOT_LOGIN,
        labels: new Set(),
        title: String(body?.['title'] ?? ''),
        body: String(body?.['body'] ?? ''),
      };
      this.pulls.set(pull.number, pull);
      return { status: 201, body: this.pullJson(pull) };
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(path))) {
      const pull = this.pulls.get(Number(m[1]));
      if (!pull) return { status: 404, body: { message: 'Not Found' } };
      if (method === 'GET') return { status: 200, body: this.pullJson(pull) };
      if (method === 'PATCH') {
        if (body?.['state'] === 'closed' || body?.['state'] === 'open') pull.state = body['state'] as 'open' | 'closed';
        return { status: 200, body: this.pullJson(pull) };
      }
    }
    if (method === 'PUT' && (m = /^\/pulls\/(\d+)\/merge$/.exec(path))) {
      this.beforeMerge?.();
      const pull = this.pulls.get(Number(m[1]));
      if (!pull) return { status: 404, body: { message: 'Not Found' } };
      if (pull.state !== 'open' || pull.merged) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      const head = this.head(pull.headRef)!;
      if (body?.['sha'] !== head) return { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } };
      if (!this.requiredGreen(head)) return { status: 405, body: { message: 'Required status check "ci/test" is expected.' } };
      const base = this.head(pull.baseRef)!;
      const message = `${String(body?.['commit_title'] ?? pull.title)}\n\n${String(body?.['commit_message'] ?? '')}`;
      const squash = this.git(['commit-tree', this.treeOf(head), '-p', base, '-F', '-'], { env: BOT, input: message });
      this.git(['update-ref', `refs/heads/${pull.baseRef}`, squash, base]);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = squash;
      return { status: 200, body: { sha: squash, merged: true, message: 'Pull Request successfully merged' } };
    }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/labels$/.exec(path))) {
      const pull = this.pulls.get(Number(m[1]));
      if (!pull) return { status: 404, body: { message: 'Not Found' } };
      for (const label of (body?.['labels'] as string[]) ?? []) pull.labels.add(label);
      return { status: 200, body: [...pull.labels].map((name) => ({ name })) };
    }
    if (method === 'POST' && (m = /^\/issues\/(\d+)\/comments$/.exec(path))) {
      this.comments.push({ number: Number(m[1]), body: String(body?.['body'] ?? '') });
      return { status: 201, body: { id: this.comments.length } };
    }
    if (method === 'GET' && (m = /^\/rules\/branches\/(.+)$/.exec(path))) {
      const rules: unknown[] = [{ type: 'non_fast_forward' }, { type: 'deletion' }];
      if (this.required.length > 0) {
        rules.push({
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: this.required.map((r) => ({ context: r.context, ...(r.appId !== null ? { integration_id: r.appId } : {}) })),
          },
        });
      }
      return { status: 200, body: rules };
    }
    if (method === 'GET' && (m = /^\/branches\/(.+)$/.exec(path))) {
      const checks = this.classic ? { ...this.classic, checks: [] } : null;
      return { status: 200, body: { name: m[1], commit: { sha: this.head(m[1]!) }, protected: true, protection: { enabled: true, required_status_checks: checks } } };
    }
    if (method === 'GET' && (m = /^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(path))) {
      const runs = (this.checkRuns.get(m[1]!) ?? []).map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, app: r.appId === null ? null : { id: r.appId } }));
      return { status: 200, body: { total_count: runs.length, check_runs: runs } };
    }
    if (method === 'GET' && (m = /^\/commits\/([0-9a-f]{40})\/status$/.exec(path))) {
      return { status: 200, body: { state: 'success', statuses: this.statuses.get(m[1]!) ?? [] } };
    }
    return { status: 404, body: { message: `fake github: no route ${method} ${path}` } };
  }
}

// ---------------------------------------------------------------------------
// In-memory authority ledger (hash-free; the real chain is B-U1's, tested there)
// ---------------------------------------------------------------------------

export class MemoryLedger {
  readonly entries: { kind: LedgerEventKind; data: unknown; actor: string; grantId: string | null; repo: string | null; seq: number; at: string; hash: string }[] = [];
  refuse = false;

  append = <K extends LedgerEventKind>(input: LedgerAppendInput<K>): LedgerAppendResult<K> => {
    if (this.refuse) return { ok: false, reason: 'ledger refused (test)' };
    const seq = this.entries.length;
    const entry = { kind: input.kind, data: input.data, actor: input.actor, grantId: input.grantId, repo: input.repo, seq, at: new Date().toISOString(), hash: seq.toString(16).padStart(64, '0') };
    this.entries.push(entry);
    // The memory ledger does not model per-kind payload typing; the shape is the real one.
    return { ok: true, entry } as unknown as LedgerAppendResult<K>;
  };

  head = (): LedgerHead | null => {
    const last = this.entries.at(-1);
    return last ? { seq: last.seq, hash: last.hash, at: last.at } : null;
  };

  kinds(): string[] {
    return this.entries.map((e) => (e.kind === 'gate:result' ? `${e.kind}:${(e.data as { gate: string }).gate}:${(e.data as { verdict: string }).verdict}` : e.kind));
  }

  gateRows(): { gate: string; verdict: string; code: string; headSha: string | null }[] {
    return this.entries.filter((e) => e.kind === 'gate:result').map((e) => e.data as { gate: string; verdict: string; code: string; headSha: string | null });
  }

  of<K extends LedgerEventKind>(kind: K): unknown[] {
    return this.entries.filter((e) => e.kind === kind).map((e) => e.data);
  }
}

// ---------------------------------------------------------------------------
// Policies, proposals, judge verdicts
// ---------------------------------------------------------------------------

export function repoPolicy(repo: string, overrides: Partial<EffectiveRepoPolicy> = {}): EffectiveRepoPolicy {
  return {
    nameWithOwner: repo,
    stage: 'merge',
    enforcement: 'server',
    maxRisk: 'medium',
    maxFiles: 10,
    maxLines: 300,
    maxMergesPerDay: 6,
    selfRepo: null,
    ...overrides,
  };
}

export function standingPolicy(repos: EffectiveRepoPolicy[], overrides: Partial<EffectivePolicy> = {}): EffectivePolicy {
  return {
    v: 1,
    grantId: '0123456789abcdef0123456789abcdef',
    grantSeq: 1,
    keyId: 'mason-se-2026-09',
    issuedAt: '2026-09-24T00:00:00.000Z',
    expiresAt: '2026-10-24T00:00:00.000Z',
    switch: 'autonomous',
    rollout: { stageId: '2b', stageIndex: 2, stageCount: 5, enteredAt: '2026-09-24T00:00:00.000Z' },
    repos,
    merge: { maxFiles: 10, maxLines: 300, selfRepo: 'propose-only', localAuthored: { maxRisk: 'low', maxFiles: 4, maxLines: 150 } },
    spend: {
      maxMode: 'balanced',
      meteredUsdPerDay: 0,
      seats: {
        'grok-a': { seatId: 'grok-a', enabled: true, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer', 'judge'] },
        'claude-a': { seatId: 'claude-a', enabled: true, reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['judge'] },
      },
    },
    engines: ['local', 'grok-cli', 'claude-cli'],
    leader: { classes: ['A'], vetoMinutes: 30 },
    conductorGoals: false,
    computedAt: new Date().toISOString(),
    ...overrides,
  };
}

let proposalCounter = 0;

/** A signed pending proposal in the fake's mirror (provenance valid under the test HOME's key). */
export function fleetProposal(fake: FakeGithub, input: {
  files: Record<string, string | null>;
  engineModel?: string;
  engineTier?: 'frontier' | 'mid' | 'local';
  title?: string;
  summary?: string;
  id?: string;
}): Proposal {
  const diff = fake.diffFor(input.files);
  const engineModel = input.engineModel ?? 'local-coder:qwen3.8-coder';
  const engineTier = input.engineTier ?? 'local';
  const diffHash = hashDiff(diff);
  proposalCounter++;
  return {
    id: input.id ?? `p-310b-${proposalCounter}-${Math.random().toString(16).slice(2, 8)}`,
    repo: fake.mirror,
    origin: 'swarm',
    kind: 'patch',
    title: input.title ?? 'Tighten the add helper',
    summary: input.summary ?? 'Updated src/math.ts to validate inputs.',
    diff,
    engineModel,
    engineTier,
    diffHash,
    provenanceSig: signProvenance(engineModel, engineTier, diffHash),
    status: 'pending',
    createdAt: new Date().toISOString(),
  } as Proposal;
}

/** A judged decision entry with a REAL HMAC attestation (test HOME's provenance key). */
export function judgedDecision(proposal: Proposal, judgeEngine: string, verdict: 'ship' | 'review' = 'ship', at = new Date()): DecisionEntry {
  const ts = at.toISOString();
  const attestation = verdict === 'ship'
    ? signJudgeAttestation({ proposalId: proposal.id, judgeEngine, verdict: 'ship', diffHash: hashDiff(proposal.diff ?? ''), issuedAt: ts, mergeIntent: 'would-merge' })
    : undefined;
  return {
    ts,
    proposalId: proposal.id,
    action: 'judged',
    engine: judgeEngine,
    model: judgeEngine,
    verdict,
    detail: verdict === 'ship' ? 'would-merge' : '',
    ...(attestation ? { judgeAttestation: attestation, judgeAttestationIssuedAt: ts, judgeAttestationIntent: 'would-merge' as const } : {}),
  } as DecisionEntry;
}
