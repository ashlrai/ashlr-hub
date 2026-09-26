/**
 * Host merge through the `ashlr-fleet` GitHub App — V3.10 Track B (owner: unit U3).
 *
 * The ONLY way a fleet change reaches a default branch under a standing grant
 * (invariant I4: remote, pinned to a SHA, checked server-side, attributed,
 * reversible):
 *
 *   1. PUBLISH  the verified tree as a commit on `ashlr/fleet/<key>` through
 *      the Git Data API (blobs → tree → commit → ref) with a 1-hour, one-repo
 *      installation token from the custody helper. The tree GitHub computes
 *      must equal the tree verification ran on, and its parent must be the
 *      verified base — otherwise nothing is published.
 *   2. OPEN     the PR as `ashlr-fleet[bot]` (owner lane ⇒ `ashlr:owner-lane`).
 *   3. MERGE    `PUT /pulls/{n}/merge {sha, merge_method: squash}` pinned to
 *      the head SHA, with `Ashlr-Grant` / `Ashlr-Gates` / `Ashlr-Ledger-Head`
 *      trailers, through host-merge-revocation-protocol.ts: prepare → arm →
 *      final re-check → consume → PUT. A Stop that lands before consume
 *      revokes the armed authority and the PUT never happens.
 *
 * WHY the Git Data API instead of `git push`: the installation token never
 * enters a child process (no argv, no env, no credential helper, no hooks in
 * an agent-touched mirror), the commit is attributed to the App by GitHub
 * itself, and "the pushed tree is the verified tree" is checked by content
 * address instead of assumed.
 *
 * Local git runs in a private SCRATCH repository whose object store borrows
 * the mirror's objects read-only (alternates): the mirror's config, hooks,
 * attributes drivers and fsmonitor never run, and nothing is written into the
 * agent-touched mirror (U2's safe-git covers the remaining daemon git calls).
 *
 * Secrets: the token is minted per repo, cached in memory only until 5 minutes
 * before expiry, and never logged, persisted, returned or put in an error.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  prepareHostMergeRevocation,
  readHostMergeRevocationState,
  transitionHostMergeRevocation,
  type HostMergeRevocationIdentityV1,
  type HostMergeRevocationWriteResult,
} from '../autonomy/host-merge-revocation-protocol.js';
import { appendLedger, currentLedgerHead } from '../authority/ledger.js';
import { currentStandingPolicy } from '../authority/effective-config.js';
import { githubToken } from '../authority/custody-client.js';
import type { EffectivePolicy, LedgerAppendInput, LedgerAppendResult, LedgerEventKind, LedgerHead } from '../authority/types.js';
import { canonicalizeDaemonActivationValue } from '../daemon/activation-permit.js';
import { verifyProposal } from '../inbox/merge.js';
import { loadConfigReadOnly } from '../config.js';
import { audit } from '../sandbox/audit.js';
import { killSwitchOn, killSwitchPath, readKillSwitch } from '../sandbox/policy.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../sandbox/mutation-fence.js';
import { scrubSecrets } from '../util/scrub.js';
import type { Proposal } from '../types.js';
import {
  buildGateResult,
  evaluateG0,
  evaluateG3,
  evaluateG7Checks,
  g7MergeEvaluation,
  recordGateRow,
  type CheckRunObservation,
  type GateEvaluation,
  type RequiredCheck,
  type StatusObservation,
} from './merge-gates.js';
import {
  listFleetMergeStateKeys,
  lockFleetMergeState,
  newFleetMergeState,
  readFleetMergeState,
  revertStateKey,
  unlockFleetMergeState,
  writeFleetMergeState,
  type FleetMergeStateV1,
  type FleetPrMemo,
} from './fleet-merge-state.js';
import { mirrorLeaseKey, mirrorPathFor, parseNameWithOwner } from './mirrors.js';
import { ASHLR_VERIFY_CHECK_NAME, ensureFleetVerifyCheck, normalizeVerifyCommands } from './verify-check-run.js';
import { VerificationCapacityError, withRepoLease, withVerificationSlot } from '../sandbox/execution-leases.js';
// One definition of the revert seam: U4 owns the request / outcome shapes
// (type-only import — post-merge-watch loads this module lazily, never the reverse).
import type { FleetRevertFailureCode, FleetRevertOutcome, FleetRevertRequest } from './post-merge-watch.js';
import type {
  FleetActor,
  FleetPrChange,
  FleetPrRecord,
  FleetPrRequest,
  FleetPrResult,
  GateId,
  GateResult,
  LandingRecord,
  RepoEnforcement,
} from './fleet-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The App's bot login. PRs the fleet may close/reopen/merge are authored by exactly this login. */
export const FLEET_APP_BOT_LOGIN = 'ashlr-fleet[bot]';
/** `<app-user-id>+ashlr-fleet[bot]@users.noreply.github.com` — how GitHub attributes the App's commits. */
export const FLEET_APP_BOT_EMAIL_RE = /^\d+\+ashlr-fleet\[bot\]@users\.noreply\.github\.com$/i;
/** Every fleet branch lives here; nothing else is ever pushed, closed or merged by the fleet. */
export const FLEET_BRANCH_PREFIX = 'ashlr/fleet/';
/** A PR with this label is never auto-merged (G1 / G7 owner lane). */
export const OWNER_LANE_LABEL = 'ashlr:owner-lane';

const GITHUB_API = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** A host-merge authority lives this long (the protocol allows ≤ 15 min). */
const MERGE_AUTHORITY_TTL_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 60_000;
const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const MAX_PUBLISHED_PATHS = 64;
const SHA_RE = /^[0-9a-f]{40}$/;
const NAME_WITH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const NODE_ID_RE = /^[A-Za-z0-9_+/=-]{1,240}$/;
/** How long landFleetRevert waits on the revert PR's checks in one call (U4 retries on `retryable`). */
export const REVERT_CHECKS_MAX_WAIT_MS = 15 * 60 * 1000;
/**
 * How long a publish waits for the mirror's repo lease (U6). Short on
 * purpose: the lease is held for seconds by agents and for a fetch by a
 * mirror sync; a pass that cannot get it retries on the next tick instead of
 * blocking the daemon's tick.
 */
export const PUBLISH_LEASE_WAIT_MS = 30_000;
const REVERT_CHECKS_POLL_MS = 20_000;

// ---------------------------------------------------------------------------
// Transport and token (injectable; production defaults below)
// ---------------------------------------------------------------------------

export interface GithubCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Absolute API path, e.g. `/repos/o/r/pulls/12`. */
  path: string;
  body?: unknown;
  /** SECRET — the transport puts it in the Authorization header and nowhere else. */
  token: string;
}

export interface GithubReply {
  /** HTTP status; 0 = the request did not complete (network / timeout). */
  status: number;
  body: unknown;
}

export type GithubTransport = (call: GithubCall) => Promise<GithubReply>;
export type GithubTokenSource = (repo: string) => Promise<{ token: string; expiresAt: string | null }>;

export interface HostMergeDeps {
  transport: GithubTransport;
  token: GithubTokenSource;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  killActive: () => boolean;
  /** Digest of the Stop sentinel's current identity (see killEpochDigest). */
  killEpoch: () => string;
  policy: () => EffectivePolicy | null;
  appendLedger: <K extends LedgerEventKind>(input: LedgerAppendInput<K>) => LedgerAppendResult<K>;
  /** Throws when the chain is broken. */
  ledgerHead: () => LedgerHead | null;
  /** Test seam between arm and consume (a Stop landing in the race window). */
  beforeConsume?: () => void | Promise<void>;
}

/** GitHub REST over fetch. The token goes in one header; bodies are size-capped and never echoed. */
export function fetchGithubTransport(fetchImpl: typeof fetch = globalThis.fetch): GithubTransport {
  return async (call) => {
    try {
      const res = await fetchImpl(`${GITHUB_API}${call.path}`, {
        method: call.method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${call.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ashlr-fleet-host-merge',
          ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return { status: res.status, body: null };
      let body: unknown = null;
      try {
        body = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } catch {
      return { status: 0, body: null };
    }
  };
}

const tokenCache = new Map<string, { token: string; refreshAtMs: number }>();

/** Custody-minted installation tokens, cached in memory until 5 minutes before expiry. */
export function custodyGithubTokenSource(nowMs: () => number = Date.now): GithubTokenSource {
  return async (repo) => {
    const cached = tokenCache.get(repo);
    if (cached && cached.refreshAtMs > nowMs()) return { token: cached.token, expiresAt: null };
    const minted = await githubToken(repo);
    const expiresMs = minted.expiresAt ? Date.parse(minted.expiresAt) : Number.NaN;
    // Unknown expiry ⇒ reuse for 10 minutes at most (installation tokens live an hour).
    const refreshAtMs = Number.isFinite(expiresMs) ? expiresMs - TOKEN_REFRESH_MARGIN_MS : nowMs() + 10 * 60 * 1000;
    if (refreshAtMs > nowMs()) tokenCache.set(repo, { token: minted.token, refreshAtMs });
    return minted;
  };
}

/**
 * Identity of the Stop sentinel. It changes whenever `~/.ashlr/KILL` appears,
 * disappears or is re-created, so a host-merge authority prepared under one
 * Stop state can never be consumed under another.
 */
export function killEpochDigest(): string {
  let identity = 'absent';
  try {
    const stat = lstatSync(killSwitchPath(), { bigint: true });
    identity = `present:${stat.dev}:${stat.ino}:${stat.mtimeNs}`;
  } catch {
    identity = 'absent';
  }
  let state = 'unknown';
  try {
    state = readKillSwitch().state;
  } catch {
    state = 'unreadable';
  }
  return createHash('sha256').update(`ashlr:kill-epoch:v1\0${state}\0${identity}`, 'utf8').digest('hex');
}

export function defaultHostMergeDeps(): HostMergeDeps {
  return {
    transport: fetchGithubTransport(),
    token: custodyGithubTokenSource(),
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    killActive: () => killSwitchOn(),
    killEpoch: () => killEpochDigest(),
    policy: () => currentStandingPolicy(),
    appendLedger: (input) => appendLedger(input),
    ledgerHead: () => currentLedgerHead(),
  };
}

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function sha(value: unknown): string | null {
  return typeof value === 'string' && SHA_RE.test(value) ? value : null;
}

function errText(error: unknown): string {
  return scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function githubMessage(reply: GithubReply): string {
  const message = str(obj(reply.body)?.['message']);
  return reply.status === 0
    ? 'GitHub did not answer (network error or timeout)'
    : `GitHub answered HTTP ${reply.status}${message ? `: ${scrubSecrets(message).slice(0, 200)}` : ''}`;
}

/**
 * Agent-authored text (proposal titles / summaries) going into a PR or a
 * squash commit: secrets scrubbed, `@mentions` defused (a prompt-injected
 * summary must not page people), and — for single-line fields — no line
 * breaks, so it can never smuggle a fake `Ashlr-*` trailer line.
 */
export function untrustedText(text: string, maxChars: number, singleLine: boolean): string {
  // eslint-disable-next-line no-control-regex
  let out = scrubSecrets(String(text)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  if (singleLine) out = out.replace(/[\r\n\t]+/g, ' ').trim();
  out = out.replace(/@(?=[A-Za-z0-9-])/g, '@\u200b');
  return out.length <= maxChars ? out : `${out.slice(0, Math.max(0, maxChars - 1))}…`;
}

function encodePathSegments(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function repoPath(repo: string, suffix: string): string {
  if (!NAME_WITH_OWNER_RE.test(repo)) throw new Error('repo is not owner/name');
  return `/repos/${repo}${suffix}`;
}

async function gh(
  deps: HostMergeDeps,
  repo: string,
  method: GithubCall['method'],
  suffix: string,
  body?: unknown,
): Promise<GithubReply> {
  let token: string;
  try {
    token = (await deps.token(repo)).token;
  } catch (error) {
    return { status: 0, body: { message: `no installation token for ${repo}: ${errText(error)}` } };
  }
  try {
    return await deps.transport({ method, path: repoPath(repo, suffix), token, ...(body !== undefined ? { body } : {}) });
  } catch {
    return { status: 0, body: null };
  }
}

// ---------------------------------------------------------------------------
// Isolated local git (scratch repo borrowing the mirror's objects read-only)
// ---------------------------------------------------------------------------

export interface FleetGitScratch {
  readonly dir: string;
  readonly mirror: string;
  readonly env: NodeJS.ProcessEnv;
}

type GitRun = { ok: true; stdout: Buffer } | { ok: false; status: number | null; stderr: string };

/** Open a scratch repository over `mirror`'s objects. Returns a reason string on failure. */
export function openGitScratch(mirror: string): FleetGitScratch | string {
  try {
    const objects = join(mirror, '.git', 'objects');
    const stat = lstatSync(objects);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return `${mirror} has no plain .git/objects directory`;
    const parent = join(homedir(), '.ashlr', 'tmp');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(parent, 'fleet-git-'));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: dir,
      LC_ALL: 'C',
      GIT_DIR: dir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
      GIT_INDEX_FILE: join(dir, 'fleet-index'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    };
    execFileSync('git', ['init', '--quiet', '--bare', '--template=', dir], {
      env: { PATH: env['PATH'], HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
    });
    return { dir, mirror, env };
  } catch (error) {
    return `could not open a scratch git repository: ${errText(error)}`;
  }
}

export function closeGitScratch(scratch: FleetGitScratch | null): void {
  if (!scratch) return;
  try {
    rmSync(scratch.dir, { recursive: true, force: true });
  } catch { /* a leftover scratch dir under ~/.ashlr/tmp is harmless */ }
}

function git(scratch: FleetGitScratch, args: readonly string[], input?: string | Buffer): GitRun {
  try {
    const stdout = execFileSync('git', [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false',
      '-c', 'diff.external=',
      ...args,
    ], {
      env: scratch.env,
      stdio: 'pipe',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      ...(input !== undefined ? { input } : {}),
    });
    return { ok: true, stdout };
  } catch (error) {
    const e = error as { status?: number | null; stderr?: Buffer | string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? String(error);
    return { ok: false, status: e.status ?? null, stderr: scrubSecrets(stderr).slice(0, 500) };
  }
}

function gitText(scratch: FleetGitScratch, args: readonly string[]): string | null {
  const run = git(scratch, args);
  return run.ok ? run.stdout.toString('utf8').trim() : null;
}

/** True when the mirror's object store has `oid`. */
export function scratchHasCommit(scratch: FleetGitScratch, oid: string): boolean {
  return SHA_RE.test(oid) && git(scratch, ['cat-file', '-e', `${oid}^{commit}`]).ok;
}

export type TreeResult = { ok: true; treeSha: string } | { ok: false; reason: string; conflict: boolean };

/**
 * The tree `diff` produces on `baseSha` — exactly what `git apply --index`
 * gives in verifyProposal's worktree, computed in a private index with no
 * working tree, no hooks and no filters. A patch that does not apply is a
 * conflict (the change must be redone on the new base).
 */
export function treeForDiff(scratch: FleetGitScratch, baseSha: string, diff: string): TreeResult {
  if (!SHA_RE.test(baseSha)) return { ok: false, reason: 'base is not a commit id', conflict: false };
  if (!scratchHasCommit(scratch, baseSha)) return { ok: false, reason: `base ${baseSha.slice(0, 12)} is not in the mirror yet`, conflict: false };
  const read = git(scratch, ['read-tree', baseSha]);
  if (!read.ok) return { ok: false, reason: `read-tree failed: ${read.stderr}`, conflict: false };
  const patch = join(scratch.dir, `fleet-${randomBytes(6).toString('hex')}.diff`);
  try {
    writeFileSync(patch, diff.endsWith('\n') ? diff : `${diff}\n`, { mode: 0o600 });
  } catch (error) {
    return { ok: false, reason: `could not stage the patch: ${errText(error)}`, conflict: false };
  }
  const apply = git(scratch, ['apply', '--cached', '--whitespace=nowarn', patch]);
  if (!apply.ok) return { ok: false, reason: `the diff does not apply: ${apply.stderr}`, conflict: true };
  const tree = gitText(scratch, ['write-tree']);
  return tree && SHA_RE.test(tree) ? { ok: true, treeSha: tree } : { ok: false, reason: 'write-tree failed', conflict: false };
}

/** Parent and tree of a commit in the mirror's object store. */
export function scratchCommit(scratch: FleetGitScratch, oid: string): { tree: string; parents: string[] } | null {
  const raw = gitText(scratch, ['cat-file', 'commit', oid]);
  if (!raw) return null;
  const header = raw.split('\n\n')[0] ?? '';
  const tree = /^tree ([0-9a-f]{40})$/m.exec(header)?.[1];
  const parents = [...header.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!);
  return tree ? { tree, parents } : null;
}

/**
 * The tree of `baseSha` with the squash commit `mergeSha` undone — a 3-way
 * merge of base and the merge's parent over the merge itself. A conflict
 * means later commits touched the same lines; the watch escalates it.
 */
export function revertTreeFor(scratch: FleetGitScratch, baseSha: string, mergeSha: string): TreeResult & { parentSha?: string } {
  const merge = scratchCommit(scratch, mergeSha);
  if (!merge) return { ok: false, reason: `merge commit ${mergeSha.slice(0, 12)} is not in the mirror yet`, conflict: false };
  if (merge.parents.length !== 1) return { ok: false, reason: 'the landing is not a single-parent squash commit', conflict: true };
  if (!scratchHasCommit(scratch, baseSha)) return { ok: false, reason: `base ${baseSha.slice(0, 12)} is not in the mirror yet`, conflict: false };
  const parentSha = merge.parents[0]!;
  const run = git(scratch, ['merge-tree', '--write-tree', '--merge-base', mergeSha, baseSha, parentSha]);
  if (!run.ok) {
    return run.status === 1
      ? { ok: false, reason: 'reverting conflicts with later commits', conflict: true }
      : { ok: false, reason: `merge-tree failed: ${run.stderr}`, conflict: false };
  }
  const tree = run.stdout.toString('utf8').split('\n')[0]?.trim() ?? '';
  return SHA_RE.test(tree) ? { ok: true, treeSha: tree, parentSha } : { ok: false, reason: 'merge-tree returned no tree', conflict: false };
}

/** Unified diff between two trees (for verifying a computed revert with verifyProposal). */
export function scratchDiff(scratch: FleetGitScratch, fromTree: string, toTree: string): string | null {
  const run = git(scratch, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', fromTree, toTree]);
  return run.ok ? run.stdout.toString('utf8') : null;
}

interface TreeChange {
  path: string;
  /** null ⇒ deleted in the new tree. */
  entry: { mode: string; type: string; sha: string } | null;
  oldMode: string | null;
}

function treeChanges(scratch: FleetGitScratch, fromTree: string, toTree: string): TreeChange[] | string {
  const run = git(scratch, ['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', fromTree, toTree]);
  if (!run.ok) return `diff-tree failed: ${run.stderr}`;
  const fields = run.stdout.toString('utf8').split('\0').filter((f) => f.length > 0);
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    // ":<oldmode> <newmode> <oldsha> <newsha> <status>" then the path.
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\d*$/.exec(fields[i]!);
    const path = fields[i + 1]!;
    if (!meta) return `unexpected diff-tree output: ${fields[i]!.slice(0, 80)}`;
    const [, oldMode, newMode, , newSha, status] = meta;
    if (status === 'D') {
      changes.push({ path, entry: null, oldMode: oldMode! });
      continue;
    }
    if (newMode === '160000' || oldMode === '160000') return `${path} is a submodule; the fleet never publishes gitlinks`;
    changes.push({ path, entry: { mode: newMode!, type: 'blob', sha: newSha! }, oldMode: oldMode === '000000' ? null : oldMode! });
  }
  return changes;
}

/**
 * What `treeSha` changes relative to `baseSha`, as git itself sees it: every
 * path and its new mode (null = deleted). G3 checks this against the paths
 * the diff parser reported, so a parser/`git apply` disagreement can never
 * smuggle a protected path, a symlink or a submodule past G1.
 */
export function scratchTreeChanges(
  scratch: FleetGitScratch,
  baseSha: string,
  treeSha: string,
): { path: string; mode: string | null; oldMode: string | null }[] | string {
  const base = scratchCommit(scratch, baseSha);
  if (!base) return `base ${baseSha.slice(0, 12)} is not in the mirror`;
  const run = git(scratch, ['diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', base.tree, treeSha]);
  if (!run.ok) return `diff-tree failed: ${run.stderr}`;
  const fields = run.stdout.toString('utf8').split('\0').filter((f) => f.length > 0);
  const out: { path: string; mode: string | null; oldMode: string | null }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([A-Z])\d*$/.exec(fields[i]!);
    if (!meta) return `unexpected diff-tree output: ${fields[i]!.slice(0, 80)}`;
    out.push({
      path: fields[i + 1]!,
      mode: meta[3] === 'D' ? null : meta[2]!,
      oldMode: meta[1] === '000000' ? null : meta[1]!,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitHub reads
// ---------------------------------------------------------------------------

export interface RepoInfo {
  nodeId: string;
  defaultBranch: string;
}

export async function readRepoInfo(repo: string, deps: HostMergeDeps): Promise<RepoInfo | string> {
  const reply = await gh(deps, repo, 'GET', '');
  if (reply.status !== 200) return githubMessage(reply);
  const body = obj(reply.body);
  const nodeId = str(body?.['node_id']);
  const defaultBranch = str(body?.['default_branch']);
  if (!nodeId || !NODE_ID_RE.test(nodeId) || !defaultBranch) return 'GitHub returned no repository identity';
  return { nodeId, defaultBranch };
}

/** Head commit of `branch` on GitHub; null = no such branch; string = error. */
export async function readBranchHead(repo: string, branch: string, deps: HostMergeDeps): Promise<{ sha: string | null } | string> {
  if (!BRANCH_RE.test(branch)) return 'invalid branch name';
  const reply = await gh(deps, repo, 'GET', `/git/ref/heads/${encodePathSegments(branch)}`);
  if (reply.status === 404) return { sha: null };
  if (reply.status !== 200) return githubMessage(reply);
  const object = obj(obj(reply.body)?.['object']);
  const head = sha(object?.['sha']);
  return head && object?.['type'] === 'commit' ? { sha: head } : 'GitHub returned a ref that is not a commit';
}

export interface RemoteCommit {
  sha: string;
  tree: string;
  parents: string[];
  authorEmail: string | null;
  message: string;
}

export async function readRemoteCommit(repo: string, oid: string, deps: HostMergeDeps): Promise<RemoteCommit | string> {
  if (!SHA_RE.test(oid)) return 'invalid commit id';
  const reply = await gh(deps, repo, 'GET', `/git/commits/${oid}`);
  if (reply.status !== 200) return githubMessage(reply);
  return parseRemoteCommit(reply.body) ?? 'GitHub returned a malformed commit';
}

function parseRemoteCommit(body: unknown): RemoteCommit | null {
  const b = obj(body);
  const commitSha = sha(b?.['sha']);
  const tree = sha(obj(b?.['tree'])?.['sha']);
  const parentsRaw = Array.isArray(b?.['parents']) ? b!['parents'] as unknown[] : null;
  if (!commitSha || !tree || !parentsRaw) return null;
  const parents = parentsRaw.map((p) => sha(obj(p)?.['sha'])).filter((p): p is string => p !== null);
  if (parents.length !== parentsRaw.length) return null;
  return {
    sha: commitSha,
    tree,
    parents,
    authorEmail: str(obj(b?.['author'])?.['email']),
    message: str(b?.['message']) ?? '',
  };
}

export interface PrSnapshot {
  number: number;
  nodeId: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  headSha: string;
  headRef: string;
  headRepo: string | null;
  baseRef: string;
  authorLogin: string | null;
  labels: string[];
}

function parsePr(body: unknown): PrSnapshot | null {
  const b = obj(body);
  const number = b?.['number'];
  const nodeId = str(b?.['node_id']);
  const state = b?.['state'];
  const head = obj(b?.['head']);
  const base = obj(b?.['base']);
  const headSha = sha(head?.['sha']);
  const headRef = str(head?.['ref']);
  const baseRef = str(base?.['ref']);
  if (!Number.isSafeInteger(number) || !nodeId || (state !== 'open' && state !== 'closed') || !headSha || !headRef || !baseRef) {
    return null;
  }
  const labels = Array.isArray(b?.['labels'])
    ? (b!['labels'] as unknown[]).map((l) => str(obj(l)?.['name'])).filter((l): l is string => l !== null)
    : [];
  return {
    number: number as number,
    nodeId,
    state,
    merged: b?.['merged'] === true || typeof b?.['merged_at'] === 'string',
    mergeCommitSha: sha(b?.['merge_commit_sha']),
    mergedAt: str(b?.['merged_at']),
    headSha,
    headRef,
    headRepo: str(obj(head?.['repo'])?.['full_name']),
    baseRef,
    authorLogin: str(obj(b?.['user'])?.['login']),
    labels,
  };
}

export async function readPr(repo: string, number: number, deps: HostMergeDeps): Promise<PrSnapshot | string> {
  if (!Number.isSafeInteger(number) || number < 1) return 'invalid PR number';
  const reply = await gh(deps, repo, 'GET', `/pulls/${number}`);
  if (reply.status !== 200) return githubMessage(reply);
  return parsePr(reply.body) ?? 'GitHub returned a malformed pull request';
}

/**
 * The checks GitHub requires on `baseBranch`: rulesets (`required_status_checks`
 * rules, readable with metadata permission) ∪ classic branch protection. The
 * digest binds the merge authority to the protection it was checked against.
 */
export async function readRequiredChecks(
  repo: string,
  baseBranch: string,
  deps: HostMergeDeps,
): Promise<{ required: RequiredCheck[]; protectionDigest: string; strict: boolean | null } | string> {
  if (!BRANCH_RE.test(baseBranch)) return 'invalid base branch';
  const rules = await gh(deps, repo, 'GET', `/rules/branches/${encodePathSegments(baseBranch)}?per_page=100`);
  if (rules.status !== 200 && rules.status !== 404) return `rulesets: ${githubMessage(rules)}`;
  const branch = await gh(deps, repo, 'GET', `/branches/${encodePathSegments(baseBranch)}`);
  if (branch.status !== 200) return `branch protection: ${githubMessage(branch)}`;
  const byContext = new Map<string, Set<string | null>>();
  const add = (context: unknown, appId: unknown): void => {
    if (typeof context !== 'string' || context.length === 0 || context.length > 256) return;
    const id = typeof appId === 'number' && Number.isSafeInteger(appId) && appId > 0 ? String(appId)
      : typeof appId === 'string' && /^[1-9]\d{0,19}$/.test(appId) ? appId : null;
    const set = byContext.get(context) ?? new Set<string | null>();
    set.add(id);
    byContext.set(context, set);
  };
  const ruleTypes: string[] = [];
  // "Require branches to be up to date": with it GitHub refuses to squash a PR
  // whose base moved after our final re-check (closing the last race window).
  // null = no source states it (the classic summary on GET /branches omits the
  // flag), so the ledger says "unknown" rather than guessing either way.
  let strict: boolean | null = null;
  const noteStrict = (flag: unknown): void => {
    if (flag === true) strict = true;
    else if (flag === false && strict === null) strict = false;
  };
  if (rules.status === 200 && Array.isArray(rules.body)) {
    for (const rule of rules.body as unknown[]) {
      const r = obj(rule);
      const type = str(r?.['type']);
      if (type) ruleTypes.push(type);
      if (type !== 'required_status_checks') continue;
      noteStrict(obj(r?.['parameters'])?.['strict_required_status_checks_policy']);
      const checks = obj(r?.['parameters'])?.['required_status_checks'];
      if (!Array.isArray(checks)) continue;
      for (const check of checks as unknown[]) add(obj(check)?.['context'], obj(check)?.['integration_id']);
    }
  }
  const protection = obj(obj(branch.body)?.['protection']);
  // Classic protection lists contexts even when `enforcement_level` is "off"
  // (verified against the live API): those are not enforced by GitHub, so
  // they are not server-side required checks.
  const classicRaw = obj(protection?.['required_status_checks']);
  const classic = classicRaw && classicRaw['enforcement_level'] !== 'off' ? classicRaw : null;
  if (classic) {
    noteStrict(classic['strict']);
    if (Array.isArray(classic['checks'])) {
      for (const check of classic['checks'] as unknown[]) add(obj(check)?.['context'], obj(check)?.['app_id']);
    }
    if (Array.isArray(classic['contexts'])) {
      for (const context of classic['contexts'] as unknown[]) if (!byContext.has(String(context))) add(context, null);
    }
  }
  const required: RequiredCheck[] = [];
  for (const [context, ids] of [...byContext.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Two sources naming different Apps for one context: the stricter (named) one wins.
    const named = [...ids].filter((id): id is string => id !== null).sort();
    required.push({ context, appId: named[0] ?? null });
  }
  const protectionDigest = createHash('sha256').update(`ashlr:fleet-protection:v1\0${canonicalizeDaemonActivationValue({
    required: required.map((r) => `${r.context}@${r.appId ?? '*'}`),
    ruleTypes: [...new Set(ruleTypes)].sort(),
    protectedClassic: protection?.['enabled'] === true || classic !== null,
    strict,
  })}`, 'utf8').digest('hex');
  return { required, protectionDigest, strict };
}

/** Check runs (≤ 300) and commit statuses on `oid`. */
export async function readHeadChecks(
  repo: string,
  oid: string,
  deps: HostMergeDeps,
): Promise<{ runs: CheckRunObservation[]; statuses: StatusObservation[] } | string> {
  if (!SHA_RE.test(oid)) return 'invalid commit id';
  const runs: CheckRunObservation[] = [];
  for (let page = 1; page <= 3; page++) {
    const reply = await gh(deps, repo, 'GET', `/commits/${oid}/check-runs?per_page=100&page=${page}`);
    if (reply.status !== 200) return `check runs: ${githubMessage(reply)}`;
    const body = obj(reply.body);
    const list = Array.isArray(body?.['check_runs']) ? body!['check_runs'] as unknown[] : [];
    for (const item of list) {
      const run = obj(item);
      const id = run?.['id'];
      const name = str(run?.['name']);
      if (!Number.isSafeInteger(id) || !name) continue;
      const appId = obj(run?.['app'])?.['id'];
      runs.push({
        id: id as number,
        name,
        appId: typeof appId === 'number' && Number.isSafeInteger(appId) ? String(appId) : null,
        status: str(run?.['status']) ?? 'unknown',
        conclusion: str(run?.['conclusion']),
      });
    }
    const total = typeof body?.['total_count'] === 'number' ? body['total_count'] as number : list.length;
    if (list.length < 100 || runs.length >= total) break;
  }
  const status = await gh(deps, repo, 'GET', `/commits/${oid}/status?per_page=100`);
  if (status.status !== 200) return `commit statuses: ${githubMessage(status)}`;
  const statusList = obj(status.body)?.['statuses'];
  const statuses: StatusObservation[] = (Array.isArray(statusList) ? statusList as unknown[] : [])
    .map((s) => ({ context: str(obj(s)?.['context']) ?? '', state: str(obj(s)?.['state']) ?? 'pending' }))
    .filter((s) => s.context.length > 0);
  return { runs, statuses };
}

// ---------------------------------------------------------------------------
// Publishing a verified tree
// ---------------------------------------------------------------------------

export interface PublishInput {
  repo: string;
  branch: string;
  baseSha: string;
  treeSha: string;
  scratch: FleetGitScratch;
  commitMessage: string;
}

export type PublishFailureCode = 'base-missing' | 'tree-mismatch' | 'branch-foreign' | 'github' | 'local-git' | 'busy';

export type PublishResult =
  | { ok: true; headSha: string }
  | { ok: false; code: PublishFailureCode; reason: string; retryable: boolean };

function publishFail(code: PublishFailureCode, reason: string, retryable: boolean): PublishResult {
  return { ok: false, code, reason: scrubSecrets(reason).slice(0, 400), retryable };
}

/**
 * Create (or adopt / fast-replace) `branch` so it points at a commit whose
 * tree is exactly `treeSha` and whose only parent is `baseSha`. The branch is
 * in the fleet's namespace; an existing head is replaced only when it is an
 * App-authored commit (a human's push to a fleet branch is never clobbered).
 *
 * V3.10 (U6): the publish is the fleet's "push", so it runs under the mirror's
 * repo lease (`mirrorLeaseKey(mirror)`) — the lease clone, sync, sandbox
 * creation and proposal filing take — so a mirror reset or removal never
 * interleaves with the scratch reads of the mirror's objects, and two pushes
 * for one repo never race. A busy lease is `busy` (retryable): nothing was
 * published.
 */
export async function publishVerifiedTree(input: PublishInput, deps: HostMergeDeps): Promise<PublishResult> {
  if (!input.branch.startsWith(FLEET_BRANCH_PREFIX) || !BRANCH_RE.test(input.branch)) {
    return publishFail('branch-foreign', `refusing to publish outside ${FLEET_BRANCH_PREFIX}`, false);
  }
  let leaseKey: string;
  try {
    leaseKey = mirrorLeaseKey(input.scratch.mirror);
  } catch (error) {
    return publishFail('local-git', `the mirror's lease key could not be computed: ${errText(error)}`, false);
  }
  const leased = await withRepoLease(leaseKey, () => publishVerifiedTreeLeased(input, deps), { waitMs: PUBLISH_LEASE_WAIT_MS });
  if (!leased.ok) return publishFail('busy', `the mirror's repo lease is unavailable: ${leased.reason}`, true);
  return leased.value;
}

async function publishVerifiedTreeLeased(input: PublishInput, deps: HostMergeDeps): Promise<PublishResult> {
  if (!input.branch.startsWith(FLEET_BRANCH_PREFIX) || !BRANCH_RE.test(input.branch)) {
    return publishFail('branch-foreign', `refusing to publish outside ${FLEET_BRANCH_PREFIX}`, false);
  }
  const base = scratchCommit(input.scratch, input.baseSha);
  if (!base) return publishFail('base-missing', `base ${input.baseSha.slice(0, 12)} is not in the mirror`, true);
  const changes = treeChanges(input.scratch, base.tree, input.treeSha);
  if (typeof changes === 'string') return publishFail('local-git', changes, false);
  if (changes.length === 0) return publishFail('tree-mismatch', 'the verified tree equals the base tree; there is nothing to publish', false);
  if (changes.length > MAX_PUBLISHED_PATHS) return publishFail('tree-mismatch', `${changes.length} paths exceed the publish bound`, false);

  const entries: { path: string; mode: string; type: 'blob'; sha: string | null }[] = [];
  for (const change of changes) {
    if (!change.entry) {
      entries.push({ path: change.path, mode: change.oldMode ?? '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = git(input.scratch, ['cat-file', 'blob', change.entry.sha]);
    if (!blob.ok) return publishFail('local-git', `could not read ${change.path}: ${blob.stderr}`, false);
    if (blob.stdout.length > MAX_BLOB_BYTES) return publishFail('tree-mismatch', `${change.path} exceeds the blob size bound`, false);
    const created = await gh(deps, input.repo, 'POST', '/git/blobs', {
      content: blob.stdout.toString('base64'),
      encoding: 'base64',
    });
    if (created.status !== 201 && created.status !== 200) return publishFail('github', `blob ${change.path}: ${githubMessage(created)}`, true);
    // Content-addressed: GitHub's blob id must be ours, byte for byte.
    if (sha(obj(created.body)?.['sha']) !== change.entry.sha) {
      return publishFail('tree-mismatch', `GitHub stored ${change.path} under a different blob id`, false);
    }
    entries.push({ path: change.path, mode: change.entry.mode, type: 'blob', sha: change.entry.sha });
  }

  const tree = await gh(deps, input.repo, 'POST', '/git/trees', { base_tree: base.tree, tree: entries });
  if (tree.status !== 201 && tree.status !== 200) return publishFail('github', `tree: ${githubMessage(tree)}`, true);
  const remoteTree = sha(obj(tree.body)?.['sha']);
  if (remoteTree !== input.treeSha) {
    return publishFail('tree-mismatch', `GitHub built tree ${remoteTree?.slice(0, 12) ?? 'none'}, verification ran on ${input.treeSha.slice(0, 12)}`, false);
  }

  const commit = await gh(deps, input.repo, 'POST', '/git/commits', {
    message: input.commitMessage,
    tree: input.treeSha,
    parents: [input.baseSha],
  });
  if (commit.status !== 201 && commit.status !== 200) return publishFail('github', `commit: ${githubMessage(commit)}`, true);
  const created = parseRemoteCommit(commit.body);
  if (!created || created.tree !== input.treeSha || created.parents.length !== 1 || created.parents[0] !== input.baseSha) {
    return publishFail('tree-mismatch', 'GitHub returned a commit that is not the verified tree on the verified base', false);
  }

  const existing = await readBranchHead(input.repo, input.branch, deps);
  if (typeof existing === 'string') return publishFail('github', `branch read: ${existing}`, true);
  if (existing.sha === created.sha) return { ok: true, headSha: created.sha };
  if (existing.sha === null) {
    const ref = await gh(deps, input.repo, 'POST', '/git/refs', { ref: `refs/heads/${input.branch}`, sha: created.sha });
    if (ref.status === 201 || ref.status === 200) return { ok: true, headSha: created.sha };
    if (ref.status !== 422) return publishFail('github', `ref create: ${githubMessage(ref)}`, true);
    // Lost a race with another pass creating the same branch: re-read and fall through.
    const raced = await readBranchHead(input.repo, input.branch, deps);
    if (typeof raced === 'string' || raced.sha === null) return publishFail('github', 'ref create raced and the branch could not be re-read', true);
    if (raced.sha === created.sha) return { ok: true, headSha: created.sha };
    existing.sha = raced.sha;
  }
  const prior = await readRemoteCommit(input.repo, existing.sha!, deps);
  if (typeof prior === 'string') return publishFail('github', `branch head read: ${prior}`, true);
  if (!prior.authorEmail || !FLEET_APP_BOT_EMAIL_RE.test(prior.authorEmail)) {
    return publishFail('branch-foreign', `${input.branch} holds a commit the App did not author; it is left untouched`, false);
  }
  const update = await gh(deps, input.repo, 'PATCH', `/git/refs/heads/${encodePathSegments(input.branch)}`, {
    sha: created.sha,
    force: true,
  });
  if (update.status !== 200) return publishFail('github', `ref update: ${githubMessage(update)}`, true);
  return { ok: true, headSha: created.sha };
}

// ---------------------------------------------------------------------------
// Opening a fleet PR
// ---------------------------------------------------------------------------

export interface OpenFleetPrInput {
  repo: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  treeSha: string;
  title: string;
  body: string;
  ownerLane: boolean;
  ownerLaneReason: string | null;
}

export type OpenFleetPrResult =
  | { ok: true; pr: FleetPrMemo }
  | { ok: false; reason: string; retryable: boolean };

/** Open (or adopt the open) PR for `branch`, authored by the App; label it when it is owner-lane. */
export async function openFleetPr(input: OpenFleetPrInput, deps: HostMergeDeps): Promise<OpenFleetPrResult> {
  const info = await readRepoInfo(input.repo, deps);
  if (typeof info === 'string') return { ok: false, reason: info, retryable: true };
  // The grant authorizes landing on a repo's default branch only. WHY check
  // here, against GitHub: the base came from the mirror, whose refs sit in a
  // tree agents can reach; GitHub's own answer is the one that counts.
  if (input.baseBranch !== info.defaultBranch) {
    return {
      ok: false,
      reason: `the PR base ${untrustedText(input.baseBranch, 100, true)} is not the default branch ${untrustedText(info.defaultBranch, 100, true)}`,
      retryable: false,
    };
  }
  const owner = input.repo.split('/')[0]!;
  const list = await gh(deps, input.repo, 'GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}&per_page=10`);
  let pr: PrSnapshot | null = null;
  if (list.status === 200 && Array.isArray(list.body)) {
    pr = (list.body as unknown[]).map(parsePr).find((p): p is PrSnapshot => p !== null && p.headRef === input.branch) ?? null;
  }
  if (!pr) {
    const created = await gh(deps, input.repo, 'POST', '/pulls', {
      title: untrustedText(input.title, 120, true),
      head: input.branch,
      base: input.baseBranch,
      body: untrustedText(input.body, 8_000, false),
      maintainer_can_modify: false,
      draft: false,
    });
    if (created.status !== 201 && created.status !== 200) {
      return { ok: false, reason: `PR create: ${githubMessage(created)}`, retryable: created.status === 0 || created.status >= 500 };
    }
    pr = parsePr(created.body);
    if (!pr) return { ok: false, reason: 'GitHub returned a malformed pull request', retryable: false };
  }
  let ownerLane = input.ownerLane;
  let ownerLaneReason = input.ownerLaneReason;
  // The authorship rule every later step relies on: the App opened it, from
  // its own namespace, in this repo, at the verified head.
  if (pr.authorLogin !== FLEET_APP_BOT_LOGIN || pr.headRef !== input.branch ||
    (pr.headRepo !== null && pr.headRepo.toLowerCase() !== input.repo.toLowerCase())) {
    ownerLane = true;
    ownerLaneReason = `PR #${pr.number} is not authored by ${FLEET_APP_BOT_LOGIN} on ${input.branch}; it is never auto-merged`;
  } else if (pr.headSha !== input.headSha) {
    ownerLane = true;
    ownerLaneReason = `PR #${pr.number}'s head ${pr.headSha.slice(0, 12)} is not the verified commit ${input.headSha.slice(0, 12)}`;
  }
  if (ownerLane && !pr.labels.includes(OWNER_LANE_LABEL)) {
    const label = await gh(deps, input.repo, 'POST', `/issues/${pr.number}/labels`, { labels: [OWNER_LANE_LABEL] });
    if (label.status !== 200 && label.status !== 201) {
      // The label is Mason's cue, not the safety mechanism (ownerLane in our
      // state and CODEOWNERS are) — record the miss and keep going.
      audit({
        action: 'fleet:owner-lane-label',
        repo: null,
        sandboxId: null,
        summary: `${input.repo}#${pr.number}: could not add ${OWNER_LANE_LABEL}: ${githubMessage(label)}`,
        result: 'error',
      });
    }
  }
  return {
    ok: true,
    pr: {
      number: pr.number,
      nodeId: pr.nodeId,
      repositoryId: info.nodeId,
      branch: input.branch,
      baseBranch: input.baseBranch,
      baseSha: input.baseSha,
      headSha: input.headSha,
      treeSha: input.treeSha,
      ownerLane,
      ownerLaneReason,
      openedAt: new Date(deps.nowMs()).toISOString(),
      ledgered: false,
      state: 'open',
      closedBy: null,
      nextCheckAt: null,
      checkBackoffMs: 0,
      checks: null,
      wouldMergeHeadSha: null,
    },
  };
}

/** Label an already-open PR as owner lane (a head changed under us, no checks, …). */
export async function labelOwnerLane(repo: string, number: number, deps: HostMergeDeps): Promise<boolean> {
  const reply = await gh(deps, repo, 'POST', `/issues/${number}/labels`, { labels: [OWNER_LANE_LABEL] });
  return reply.status === 200 || reply.status === 201;
}

/** Post a comment on a PR (best effort — the ledger, not the comment, is the record). */
export async function commentOnPr(repo: string, number: number, body: string, deps: HostMergeDeps): Promise<boolean> {
  const reply = await gh(deps, repo, 'POST', `/issues/${number}/comments`, { body: scrubSecrets(body).slice(0, 4_000) });
  return reply.status === 201 || reply.status === 200;
}

// ---------------------------------------------------------------------------
// Trailers
// ---------------------------------------------------------------------------

export interface FleetTrailers {
  grantId: string;
  gatesDigest: string;
  ledgerHead: string;
  proposalId: string | null;
  stageId: string;
  revertsLandingId?: string | null;
}

/** The squash commit message: title, body, then git trailers in the final paragraph. */
export function fleetMergeCommitMessage(body: string, trailers: FleetTrailers): string {
  const lines = [
    `Ashlr-Grant: ${trailers.grantId}`,
    `Ashlr-Gates: ${trailers.gatesDigest}`,
    `Ashlr-Ledger-Head: ${trailers.ledgerHead}`,
    `Ashlr-Stage: ${trailers.stageId}`,
    ...(trailers.proposalId ? [`Ashlr-Proposal: ${trailers.proposalId}`] : []),
    ...(trailers.revertsLandingId ? [`Ashlr-Reverts: ${trailers.revertsLandingId}`] : []),
  ];
  // No line of the body may look like one of our trailers: the post-merge
  // watch counts EVERY `Ashlr-Grant:` line when it proves a commit is ours.
  const cleanBody = untrustedText(body, 4_000, false).replace(/^\s*Ashlr-[A-Za-z-]+\s*:.*$/gim, '').trim();
  return `${cleanBody.length > 0 ? `${cleanBody}\n\n` : ''}${lines.join('\n')}\n`;
}

/** Parse `Ashlr-*` trailers back out of a commit message (for tests and the watch). */
export function parseFleetTrailers(message: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const match of message.matchAll(/^(Ashlr-[A-Za-z-]+):[ \t]*(\S+)[ \t]*$/gm)) {
    (out[match[1]!] ??= []).push(match[2]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The SHA-pinned merge, through the host-merge revocation protocol
// ---------------------------------------------------------------------------

export interface PinnedMergeInput {
  state: FleetMergeStateV1;
  /** Recorded in the attempt memo before the PUT (crash reconciliation). */
  trailers: { grantId: string; gatesDigest: string; ledgerHead: string; stageId: string };
  /** Called under the outward mutation fence right before consume; a string refuses the merge. */
  recheck: () => Promise<string | null>;
  commitTitle: string;
  commitMessage: string;
  identity: {
    evidencePackDigest: string;
    verifierManifestDigest: string;
    protectionPolicyDigest: string;
    policyEpoch: string;
  };
  /** Recomputes the policy epoch now; a change since `identity.policyEpoch` refuses the merge. */
  currentPolicyEpoch: () => string | null;
}

export type PinnedMergeOutcome =
  | { ok: true; mergeSha: string; landedAt: string }
  | {
      ok: false;
      code: 'protocol' | 'fence' | 'recheck' | 'revoked' | 'killed' | 'head-changed' | 'not-mergeable' | 'github';
      reason: string;
      retryable: boolean;
      /** The PUT was sent: GitHub's answer decides (a network loss here must be reconciled, not retried blind). */
      mergeCalled: boolean;
    };

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

type AppliedWrite = Extract<HostMergeRevocationWriteResult, { status: 'applied' | 'replayed' }>;

function applied(result: HostMergeRevocationWriteResult): result is AppliedWrite {
  return result.status === 'applied' || result.status === 'replayed';
}

function writeReason(result: HostMergeRevocationWriteResult): string {
  return result.status === 'refused' || result.status === 'degraded' ? result.reason : result.status;
}

/** The digest the protocol binds the Leader / grant state to: grant, stage, switch and this repo's caps. */
export function policyEpochDigest(policy: EffectivePolicy | null, repo: string): string | null {
  if (!policy) return null;
  const repoPolicy = policy.repos.find((r) => r.nameWithOwner.toLowerCase() === repo.toLowerCase()) ?? null;
  return sha256Hex(`ashlr:fleet-policy-epoch:v1\0${canonicalizeDaemonActivationValue({
    grantId: policy.grantId,
    grantSeq: policy.grantSeq,
    stageId: policy.rollout.stageId,
    stageIndex: policy.rollout.stageIndex,
    switch: policy.switch,
    repo: repoPolicy,
  })}`);
}

function persist(state: FleetMergeStateV1): boolean {
  return writeFleetMergeState(state);
}

/**
 * prepare → arm → [fence: recheck, Stop / policy epoch unchanged] → consume →
 * PUT. Consume is a compare-and-swap in a file-locked protocol record, so a
 * Stop in ANOTHER process that revokes the armed authority first wins and the
 * PUT is never sent; if consume wins, the Stop's own KILL check below still
 * stops a PUT that has not been sent yet.
 */
export async function mergeFleetPrPinned(input: PinnedMergeInput, deps: HostMergeDeps): Promise<PinnedMergeOutcome> {
  const state = input.state;
  const pr = state.pr;
  const fail = (
    code: Exclude<PinnedMergeOutcome, { ok: true }>['code'],
    reason: string,
    retryable: boolean,
    mergeCalled = false,
  ): PinnedMergeOutcome => ({ ok: false, code, reason: scrubSecrets(reason).slice(0, 400), retryable, mergeCalled });
  if (!pr || pr.state !== 'open') return fail('protocol', 'there is no open fleet PR to merge', false);
  if (pr.ownerLane) return fail('protocol', 'an owner-lane PR is never auto-merged', false);

  const nowMs = deps.nowMs();
  const identity: HostMergeRevocationIdentityV1 = {
    nameWithOwner: state.repo,
    repositoryId: pr.repositoryId,
    baseRef: pr.baseBranch,
    baseOid: pr.baseSha,
    headRef: pr.branch,
    headOid: pr.headSha,
    pullRequestId: pr.nodeId,
    pullRequestNumber: pr.number,
    evidencePackDigest: input.identity.evidencePackDigest,
    verifierManifestDigest: input.identity.verifierManifestDigest,
    protectionPolicyDigest: input.identity.protectionPolicyDigest,
    killEpoch: deps.killEpoch(),
    policyEpoch: input.identity.policyEpoch,
    expiresAt: new Date(nowMs + MERGE_AUTHORITY_TTL_MS).toISOString(),
  };
  const operationPrefix = `merge-${randomBytes(8).toString('hex')}`;
  // Durable BEFORE the authority exists, so a Stop in another process can find
  // (and revoke) it even if this process dies right after arming.
  state.merge = {
    identity,
    operationPrefix,
    startedAt: new Date(nowMs).toISOString(),
    phase: 'prepared',
    mergeSha: null,
    error: null,
    trailers: { ...input.trailers },
  };
  if (!persist(state)) return fail('protocol', 'the merge attempt could not be recorded before preparing authority', true);

  const prepared = prepareHostMergeRevocation({ identity, operationId: `${operationPrefix}.prepare`, now: new Date(deps.nowMs()) });
  if (!applied(prepared)) {
    state.merge.phase = 'failed';
    state.merge.error = `prepare refused: ${writeReason(prepared)}`;
    persist(state);
    return fail('protocol', `host-merge authority could not be prepared (${writeReason(prepared)})`, true);
  }
  const armed = transitionHostMergeRevocation({
    identity,
    action: 'arm',
    operationId: `${operationPrefix}.arm`,
    expectedSequence: prepared.record.sequence,
    expectedReceiptDigest: prepared.receipt.receiptDigest,
    now: new Date(deps.nowMs()),
  });
  if (!applied(armed)) {
    state.merge.phase = 'failed';
    state.merge.error = `arm refused: ${writeReason(armed)}`;
    persist(state);
    return fail('protocol', `host-merge authority could not be armed (${writeReason(armed)})`, true);
  }
  state.merge.phase = 'armed';
  persist(state);

  const revokeOwn = (why: string): void => {
    const revoked = transitionHostMergeRevocation({
      identity,
      action: 'revoke',
      operationId: `${operationPrefix}.revoke`,
      expectedSequence: armed.record.sequence,
      expectedReceiptDigest: armed.receipt.receiptDigest,
      now: new Date(deps.nowMs()),
    });
    state.merge!.phase = applied(revoked) ? 'revoked' : 'failed';
    state.merge!.error = why;
    persist(state);
  };

  const fence = acquireOutwardMutationFence();
  if (!fence || !ownsOutwardMutationFence(fence)) {
    releaseOutwardMutationFence(fence);
    revokeOwn('outward mutation fence unavailable');
    return fail('fence', 'the outward mutation fence is held elsewhere (a Stop or another merge is in progress)', true);
  }
  try {
    const refusal = await input.recheck();
    if (refusal) {
      revokeOwn(refusal);
      return fail('recheck', refusal, true);
    }
    if (deps.beforeConsume) await deps.beforeConsume();
    if (deps.killActive() || deps.killEpoch() !== identity.killEpoch) {
      revokeOwn('Stop was set before the merge authority was consumed');
      return fail('killed', 'Stop is on; the merge was cancelled before it was sent', true);
    }
    if (input.currentPolicyEpoch() !== identity.policyEpoch) {
      revokeOwn('the standing policy changed before the merge authority was consumed');
      return fail('recheck', 'the standing policy changed (grant, stage, switch or caps); re-evaluating next pass', true);
    }
    const consumed = transitionHostMergeRevocation({
      identity,
      action: 'consume',
      operationId: `${operationPrefix}.consume`,
      expectedSequence: armed.record.sequence,
      expectedReceiptDigest: armed.receipt.receiptDigest,
      now: new Date(deps.nowMs()),
    });
    if (!applied(consumed)) {
      // Revoked (a Stop won the compare-and-swap) or the record degraded: no PUT.
      const why = writeReason(consumed);
      state.merge.phase = why === 'authority-terminal' || why === 'compare-and-swap-mismatch' ? 'revoked' : 'failed';
      state.merge.error = `consume refused: ${why}`;
      persist(state);
      return fail('revoked', `the merge authority was revoked before it could be consumed (${why})`, true);
    }
    state.merge.phase = 'consumed';
    persist(state);
    if (!ownsOutwardMutationFence(fence) || deps.killActive()) {
      state.merge.phase = 'failed';
      state.merge.error = 'Stop landed after consume and before the merge call';
      persist(state);
      return fail('killed', 'Stop is on; the merge was not sent', true);
    }
    const reply = await gh(deps, state.repo, 'PUT', `/pulls/${pr.number}/merge`, {
      sha: pr.headSha,
      merge_method: 'squash',
      commit_title: untrustedText(input.commitTitle, 250, true),
      commit_message: input.commitMessage,
    });
    const body = obj(reply.body);
    if (reply.status === 200 && body?.['merged'] === true && sha(body['sha'])) {
      const mergeSha = sha(body['sha'])!;
      state.merge.phase = 'merged';
      state.merge.mergeSha = mergeSha;
      persist(state);
      return { ok: true, mergeSha, landedAt: new Date(deps.nowMs()).toISOString() };
    }
    state.merge.phase = 'failed';
    state.merge.error = githubMessage(reply);
    persist(state);
    if (reply.status === 409) return fail('head-changed', `the PR head moved off ${pr.headSha.slice(0, 12)} (${githubMessage(reply)})`, false, true);
    if (reply.status === 405 || reply.status === 422) return fail('not-mergeable', githubMessage(reply), true, true);
    return fail('github', githubMessage(reply), true, true);
  } finally {
    releaseOutwardMutationFence(fence);
  }
}

/**
 * Stop's companion: revoke every ARMED host-merge authority recorded in the
 * fleet merge state, so a merge another process is about to consume is
 * cancelled at the protocol level. Lowering authority — needs no auth, never
 * waits on the per-proposal locks, and never touches GitHub. Call it right
 * after writing ~/.ashlr/KILL (U1's `stop` / `revoke` actions, U5's beforeTick
 * when it observes KILL).
 */
export function revokeArmedHostMerges(reason: string): { revoked: number; failed: string[] } {
  const out = { revoked: 0, failed: [] as string[] };
  const keys = listFleetMergeStateKeys();
  if (keys === null) {
    out.failed.push('fleet merge state directory unreadable');
    return out;
  }
  for (const key of keys) {
    const read = readFleetMergeState(key);
    if (read.state !== 'ok') continue;
    const attempt = read.record.merge;
    if (!attempt || (attempt.phase !== 'armed' && attempt.phase !== 'prepared')) continue;
    const current = readHostMergeRevocationState(attempt.identity);
    if (current.state !== 'healthy' || current.record.phase !== 'armed') continue;
    const latest = current.record.receipts.at(-1)!;
    const result = transitionHostMergeRevocation({
      identity: attempt.identity,
      action: 'revoke',
      operationId: `${attempt.operationPrefix}.stop-${randomBytes(4).toString('hex')}`,
      expectedSequence: current.record.sequence,
      expectedReceiptDigest: latest.receiptDigest,
    });
    if (applied(result)) out.revoked++;
    else out.failed.push(`${key}: ${writeReason(result)}`);
  }
  audit({
    action: 'fleet:host-merge-revoke',
    repo: null,
    sandboxId: null,
    summary: scrubSecrets(`revoked ${out.revoked} armed fleet merge authority(ies): ${reason}${out.failed.length ? `; failures: ${out.failed.join('; ')}` : ''}`).slice(0, 900),
    result: out.failed.length === 0 ? 'ok' : 'error',
  });
  return out;
}

// ---------------------------------------------------------------------------
// Frozen contract: close / reopen (Leader class-A action and its veto)
// ---------------------------------------------------------------------------

async function changeFleetPrState(
  req: FleetPrRequest,
  to: 'closed' | 'open',
  deps: HostMergeDeps,
): Promise<FleetPrResult> {
  const result = (ok: boolean, reason: string, state: FleetPrResult['state']): FleetPrResult => ({
    ok,
    reason: scrubSecrets(reason).slice(0, 400),
    repo: req.repo,
    number: req.number,
    state,
  });
  if (!NAME_WITH_OWNER_RE.test(req.repo) || !Number.isSafeInteger(req.number) || req.number < 1) {
    return result(false, 'invalid repo or PR number', 'unknown');
  }
  const pr = await readPr(req.repo, req.number, deps);
  if (typeof pr === 'string') return result(false, pr, 'unknown');
  const current: FleetPrResult['state'] = pr.merged ? 'merged' : pr.state;
  // The Leader may only act on its own fleet's work.
  if (pr.authorLogin !== FLEET_APP_BOT_LOGIN || !pr.headRef.startsWith(FLEET_BRANCH_PREFIX) ||
    (pr.headRepo !== null && pr.headRepo.toLowerCase() !== req.repo.toLowerCase())) {
    return result(false, `PR #${req.number} was not authored by ${FLEET_APP_BOT_LOGIN} on an ${FLEET_BRANCH_PREFIX} branch`, current);
  }
  if (pr.merged) return result(false, `PR #${req.number} is already merged`, 'merged');
  if (pr.state === to) return result(true, `PR #${req.number} is already ${to}`, current);
  const policy = deps.policy();
  const change: FleetPrChange = {
    repo: req.repo,
    number: req.number,
    reason: scrubSecrets(req.reason).slice(0, 400),
    actor: req.actor,
    at: new Date(deps.nowMs()).toISOString(),
  };
  // Closing lowers authority (a PR that cannot merge); reopening restores it.
  // Reopen is ledgered FIRST (fail closed); close acts first, ledgers after.
  if (to === 'open') {
    const row = deps.appendLedger({ kind: 'pr:reopened', data: change, actor: req.actor, grantId: policy?.grantId ?? null, repo: req.repo });
    if (!row.ok) return result(false, `ledger refused the reopen: ${row.reason}`, current);
  }
  const reply = await gh(deps, req.repo, 'PATCH', `/pulls/${req.number}`, { state: to });
  if (reply.status !== 200) return result(false, `GitHub refused: ${githubMessage(reply)}`, current);
  const after = parsePr(reply.body);
  if (to === 'closed') {
    const row = deps.appendLedger({ kind: 'pr:closed', data: change, actor: req.actor, grantId: policy?.grantId ?? null, repo: req.repo });
    if (!row.ok) {
      audit({ action: 'fleet:pr-closed', repo: null, sandboxId: null, summary: `${req.repo}#${req.number} closed but not ledgered: ${row.reason}`, result: 'error' });
    }
  }
  await commentOnPr(req.repo, req.number, `${to === 'closed' ? 'Closed' : 'Reopened'} by the ashlr fleet (${req.actor}): ${req.reason}`, deps);
  recordPrStateLocally(req.repo, req.number, to, req.actor);
  return result(true, `PR #${req.number} ${to === 'closed' ? 'closed' : 'reopened'}`, after?.state ?? to);
}

/** Mirror a close / reopen into the fleet merge state so the pass stops (or resumes) progressing it. */
function recordPrStateLocally(repo: string, number: number, to: 'closed' | 'open', actor: FleetActor): void {
  const keys = listFleetMergeStateKeys();
  if (!keys) return;
  for (const key of keys) {
    const read = readFleetMergeState(key);
    if (read.state !== 'ok' || !read.record.pr) continue;
    if (read.record.repo.toLowerCase() !== repo.toLowerCase() || read.record.pr.number !== number) continue;
    const record = read.record;
    record.pr!.state = to;
    record.pr!.closedBy = to === 'closed' ? actor : null;
    record.pr!.nextCheckAt = null;
    writeFleetMergeState(record);
  }
}

/**
 * Close a PR the fleet authored. Refuses (ok: false) any PR not authored by
 * `ashlr-fleet[bot]` on an `ashlr/fleet/` branch — the Leader may only close
 * its own fleet's work.
 */
export async function closeFleetPr(req: FleetPrRequest, deps: HostMergeDeps = defaultHostMergeDeps()): Promise<FleetPrResult> {
  return changeFleetPrState(req, 'closed', deps);
}

/** Reopen a fleet PR closed by closeFleetPr — the inverse a Leader veto runs. Same authorship rule. */
export async function reopenFleetPr(req: FleetPrRequest, deps: HostMergeDeps = defaultHostMergeDeps()): Promise<FleetPrResult> {
  return changeFleetPrState(req, 'open', deps);
}

// ---------------------------------------------------------------------------
// Landing records
// ---------------------------------------------------------------------------

export function landingId(repo: string, prNumber: number, mergeSha: string): string {
  return `${repo}#${prNumber}@${mergeSha.slice(0, 12)}`;
}

/** Ledger a PR's opening (FleetPrRecord). A PR whose opening is not ledgered is never merged. */
export function ledgerPrOpened(
  state: FleetMergeStateV1,
  kind: 'change' | 'revert',
  grantId: string | null,
  deps: HostMergeDeps,
): boolean {
  const pr = state.pr;
  if (!pr) return false;
  if (pr.ledgered) return true;
  const record: FleetPrRecord = {
    v: 1,
    repo: state.repo,
    number: pr.number,
    proposalId: kind === 'change' ? state.proposalId : null,
    branch: pr.branch,
    headSha: pr.headSha,
    kind,
    ownerLane: pr.ownerLane,
    at: pr.openedAt,
  };
  const row = deps.appendLedger({ kind: 'pr:opened', data: record, actor: kind === 'revert' ? 'post-merge-watch' : 'daemon', grantId, repo: state.repo });
  if (!row.ok) return false;
  pr.ledgered = true;
  return true;
}

// ---------------------------------------------------------------------------
// Revert lander (U4's post-merge watch; SPEC-310B §2)
// ---------------------------------------------------------------------------

/**
 * U4's seam types, re-exported from fleet/post-merge-watch.ts (one definition).
 * `pending` = the revert is in flight (checks still running, the mirror or a
 * lease not ready, verification capacity busy): NOT a failed attempt — the
 * watch retries it next tick and bounds it with its own overall deadline.
 */
export type { FleetRevertFailureCode, FleetRevertOutcome, FleetRevertRequest };

export interface LandFleetRevertOptions {
  /**
   * How long to wait IN THIS CALL for the revert PR's checks (default 15 min).
   * The post-merge watch passes a short value so a slow CI never blocks the
   * daemon's tick; an unfinished wait answers `pending` and resumes next call.
   */
  maxWaitMs?: number;
  deps?: HostMergeDeps;
  /** Verification seam (tests); production runs verifyProposal in the mirror. */
  verify?: (proposal: Proposal) => Promise<{
    ok: boolean;
    detail: string;
    failureCategory?: string;
    baseBranch?: string;
    baseHead?: string;
    commandKinds: string[];
    /** 3.13: the commands that ran (reported by `ashlr/verify`); kinds alone when absent. */
    commands?: { kind: string; cmd: string[] }[];
  }>;
}

/**
 * `~/.ashlr/fleet/mirrors/<owner>__<repo>` — U6's canonical path (it owns the
 * mirrors and their layout; one rule, no drift). Throws on a name GitHub
 * itself would refuse; callers validate with `parseNameWithOwner` first.
 */
export function fleetMirrorPath(repo: string): string {
  return mirrorPathFor(repo);
}

/** Gate rows for a revert: G0, G3, G7 (SPEC-310B §2 "take the revert through G0, G3 and G7"). */
export function revertGatesDigest(rows: readonly Pick<GateResult, 'gate' | 'digest'>[]): string {
  const order: GateId[] = ['G0', 'G3', 'G7'];
  return sha256Hex(`ashlr:revert-gates:v1\0${order.map((gate) => `${gate}:${rows.find((r) => r.gate === gate)?.digest ?? 'none'}`).join('\n')}`);
}

async function defaultRevertVerify(proposal: Proposal): ReturnType<NonNullable<LandFleetRevertOptions['verify']>> {
  const cfg = loadConfigReadOnly();
  // A revert's G3 is a verification like any other: it takes a verification
  // slot (U6), and runs confined under the standing grant (verifyProposal).
  let result: Awaited<ReturnType<typeof verifyProposal>>;
  try {
    result = await withVerificationSlot(mirrorLeaseKey(proposal.repo ?? ''), () => verifyProposal(proposal, cfg));
  } catch (error) {
    if (!(error instanceof VerificationCapacityError)) throw error;
    return { ok: false, detail: `verification did not run: ${error.message}`, failureCategory: 'infra', commandKinds: [] };
  }
  return {
    ok: result.ok,
    detail: result.detail,
    ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
    ...(result.baseBranch ? { baseBranch: result.baseBranch } : {}),
    ...(result.baseHead ? { baseHead: result.baseHead } : {}),
    commandKinds: result.ran.map((command) => command.kind),
    commands: result.ran.map((command) => ({ kind: command.kind, cmd: [...command.cmd] })),
  };
}

/**
 * Revert one fleet landing: G0 (Stop and a live grant still stop it; holds do
 * not — U4 quarantines first), G3 (the reverted tree is verified in the
 * mirror), G7 (App PR, required checks green, SHA-pinned squash merge through
 * the revocation protocol). Idempotent on `idempotencyKey`: the same key maps
 * to the same branch / PR, and an already-landed revert is returned as is.
 * U4 writes the `revert:landed` ledger row; this writes the gate and PR rows.
 */
export async function landFleetRevert(req: FleetRevertRequest, opts: LandFleetRevertOptions = {}): Promise<FleetRevertOutcome> {
  const deps = opts.deps ?? defaultHostMergeDeps();
  const verify = opts.verify ?? defaultRevertVerify;
  const maxWaitMs = Math.max(0, Math.min(opts.maxWaitMs ?? REVERT_CHECKS_MAX_WAIT_MS, 60 * 60 * 1000));
  const fail = (code: FleetRevertFailureCode, reason: string, retryable: boolean): FleetRevertOutcome => ({
    ok: false,
    code,
    retryable,
    reason: scrubSecrets(reason).slice(0, 400),
  });
  const landing = req.landing;
  if (!landing || landing.kind !== 'merge') return fail('not-fleet', 'only a fleet merge landing is ever reverted', false);
  if (
    !NAME_WITH_OWNER_RE.test(landing.repo) ||
    parseNameWithOwner(landing.repo)?.nameWithOwner !== landing.repo ||
    !SHA_RE.test(landing.mergeSha) ||
    !BRANCH_RE.test(landing.baseBranch)
  ) {
    return fail('invalid-response', 'the landing record is malformed', false);
  }
  if (typeof req.idempotencyKey !== 'string' || req.idempotencyKey.length === 0) {
    return fail('invalid-response', 'a revert needs an idempotency key', false);
  }
  const key = revertStateKey(req.idempotencyKey);
  const lock = lockFleetMergeState(key, 0);
  if (!lock) return fail('pending', 'a revert for this landing is already being worked on', true);
  let scratch: FleetGitScratch | null = null;
  try {
    const read = readFleetMergeState(key);
    if (read.state === 'corrupt') return fail('unavailable', `the revert's state is unreadable: ${read.reason}`, false);
    const state = read.state === 'ok' ? read.record : newFleetMergeState({
      key,
      kind: 'revert',
      proposalId: null,
      revertsLandingId: landing.id,
      repo: landing.repo,
      repoPath: fleetMirrorPath(landing.repo),
      enforcement: landing.enforcement,
      nowIso: new Date(deps.nowMs()).toISOString(),
    });
    if (state.landing) return { ok: true, landing: state.landing };
    const gateProposalId = `revert:${landing.id}`.slice(0, 240);

    const record = (gate: GateId, e: GateEvaluation, headSha: string | null, grantId: string | null): { ok: boolean; row: GateResult } => {
      const row = buildGateResult({ gate, proposalId: gateProposalId, repo: landing.repo, headSha, evaluation: e, nowMs: deps.nowMs() });
      const written = recordGateRow(state, row, grantId, (r, g) => {
        const res = deps.appendLedger({ kind: 'gate:result', data: r, actor: 'post-merge-watch', grantId: g, repo: landing.repo });
        return res.ok ? { ok: true } : { ok: false, reason: res.reason };
      });
      return { ok: written.ok, row };
    };

    // ── G0 ──────────────────────────────────────────────────────────────
    const policy = deps.policy();
    const g0 = evaluateG0({
      purpose: 'revert',
      policy,
      repo: landing.repo,
      killOn: deps.killActive(),
      holds: [],
      mergeTimes24h: [],
      judgeLanes: null,
      nowMs: deps.nowMs(),
    });
    if (g0.verdict !== 'pass' || !policy) {
      persist(state);
      return g0.code === 'kill-on' ? fail('killed', g0.reason, true) : fail('gate-refused', g0.reason, false);
    }
    const g0Row = record('G0', g0, null, policy.grantId);
    if (!g0Row.ok) {
      persist(state);
      return fail('github', 'the authority ledger refused the revert\'s G0 row', true);
    }

    // Defense in depth on U4's authorship check: GitHub must say the landing is the App's, with our trailer.
    const landed = await readRemoteCommit(landing.repo, landing.mergeSha, deps);
    if (typeof landed === 'string') return fail('github', `the landing commit could not be read: ${landed}`, true);
    const grants = parseFleetTrailers(landed.message)['Ashlr-Grant'] ?? [];
    if (!landed.authorEmail || !FLEET_APP_BOT_EMAIL_RE.test(landed.authorEmail) || grants.length !== 1 || grants[0] !== landing.grantId) {
      return fail('not-fleet', `${landing.mergeSha.slice(0, 12)} is not an App-authored fleet landing of grant ${landing.grantId}`, false);
    }

    scratch = (() => {
      const opened = openGitScratch(state.repoPath);
      return typeof opened === 'string' ? null : opened;
    })();
    if (!scratch) return fail('unavailable', `the fleet mirror ${state.repoPath} could not be opened`, true);

    const deadline = deps.nowMs() + maxWaitMs;
    for (let rebuilds = 0; rebuilds < 3; rebuilds++) {
      // ── Build (or rebuild on a moved base) the revert PR ──────────────
      const remoteBase = await readBranchHead(landing.repo, landing.baseBranch, deps);
      if (typeof remoteBase === 'string' || remoteBase.sha === null) {
        persist(state);
        return fail('github', `the base branch could not be read: ${typeof remoteBase === 'string' ? remoteBase : 'missing'}`, true);
      }
      if (!state.pr || state.pr.baseSha !== remoteBase.sha || state.pr.state !== 'open') {
        const built = await buildRevert(state, landing, remoteBase.sha, scratch, verify, deps, record, policy.grantId, req.reason);
        if (!built.ok) {
          persist(state);
          return built.outcome;
        }
      }
      persist(state);

      // ── G7: wait for required checks on the revert head ────────────────
      const waited = await waitForChecks(state, deps, deadline);
      if (waited.kind === 'killed') return fail('killed', 'Stop is on; the revert waits', true);
      if (waited.kind === 'error') return fail('github', waited.reason, true);
      if (waited.kind === 'pending') {
        persist(state);
        return fail('pending', `required checks on revert PR #${state.pr!.number} are still running`, true);
      }
      if (waited.kind === 'owner-lane') {
        await labelOwnerLane(landing.repo, state.pr!.number, deps);
        state.pr!.ownerLane = true;
        state.pr!.ownerLaneReason = waited.evaluation.reason;
        record('G7', waited.evaluation, state.pr!.headSha, policy.grantId);
        persist(state);
        return fail('checks-red', `the revert PR cannot be proven green: ${waited.evaluation.reason}`, false);
      }
      if (waited.kind === 'red') {
        record('G7', waited.evaluation, state.pr!.headSha, policy.grantId);
        persist(state);
        return fail('checks-red', waited.evaluation.reason, false);
      }

      // ── G7: pinned merge ───────────────────────────────────────────────
      const pr = state.pr!;
      const g7 = g7MergeEvaluation({
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        treeSha: pr.treeSha,
        checks: waited.evaluation,
        protectionDigest: waited.protectionDigest,
        strictUpToDate: waited.strict,
      });
      const g7Row = record('G7', g7, pr.headSha, policy.grantId);
      if (!g7Row.ok) {
        persist(state);
        return fail('github', 'the authority ledger refused the revert\'s G7 row', true);
      }
      const rows = [state.gates['G0'], state.gates['G3'], state.gates['G7']]
        .map((memo, i) => ({ gate: (['G0', 'G3', 'G7'] as GateId[])[i]!, digest: memo?.digest ?? 'none' }));
      const gatesDigest = revertGatesDigest(rows);
      let ledgerHeadHash: string;
      try {
        const head = deps.ledgerHead();
        if (!head) return fail('github', 'the authority ledger is empty', true);
        ledgerHeadHash = head.hash;
      } catch (error) {
        return fail('gate-refused', `the authority ledger is broken: ${errText(error)}`, false);
      }
      const liveEpoch = policyEpochDigest(policy, landing.repo)!;
      const merged = await mergeFleetPrPinned({
        state,
        trailers: { grantId: policy.grantId, gatesDigest, ledgerHead: ledgerHeadHash, stageId: policy.rollout.stageId },
        commitTitle: `Revert "${landing.proposalId ? `fleet proposal ${landing.proposalId}` : landing.id}" (#${pr.number})`,
        commitMessage: fleetMergeCommitMessage(
          `Reverts ${landing.mergeSha} (PR #${landing.prNumber}) after the post-merge watch found it red: ${req.reason}`,
          {
            grantId: policy.grantId,
            gatesDigest,
            ledgerHead: ledgerHeadHash,
            proposalId: null,
            stageId: policy.rollout.stageId,
            revertsLandingId: landing.id,
          },
        ),
        identity: {
          evidencePackDigest: gatesDigest,
          verifierManifestDigest: state.verifyDigest ?? sha256Hex('none'),
          protectionPolicyDigest: waited.protectionDigest,
          policyEpoch: liveEpoch,
        },
        currentPolicyEpoch: () => policyEpochDigest(deps.policy(), landing.repo),
        recheck: async () => {
          if (deps.killActive()) return 'Stop is on';
          if (!deps.policy()) return 'the standing grant is no longer in force';
          const live = await readPr(landing.repo, pr.number, deps);
          if (typeof live === 'string') return `the revert PR could not be re-read: ${live}`;
          if (live.state !== 'open' || live.merged) return `revert PR #${pr.number} is no longer open`;
          if (live.headSha !== pr.headSha) return `revert PR #${pr.number}'s head moved off the verified commit`;
          const base = await readBranchHead(landing.repo, landing.baseBranch, deps);
          if (typeof base === 'string' || base.sha !== pr.baseSha) return 'the base branch moved; the revert is rebuilt on the new base';
          return null;
        },
      }, deps);
      if (!merged.ok) {
        persist(state);
        if (merged.code === 'killed' || merged.code === 'revoked') return fail('killed', merged.reason, true);
        if (merged.code === 'recheck' && /base branch moved/.test(merged.reason) && deps.nowMs() < deadline) continue;
        if (merged.code === 'head-changed') return fail('checks-red', merged.reason, false);
        return fail('github', merged.reason, merged.retryable);
      }
      const revertLanding: LandingRecord = {
        v: 1,
        id: landingId(landing.repo, pr.number, merged.mergeSha),
        kind: 'revert',
        repo: landing.repo,
        baseBranch: landing.baseBranch,
        prNumber: pr.number,
        headSha: pr.headSha,
        mergeSha: merged.mergeSha,
        proposalId: null,
        revertsLandingId: landing.id,
        grantId: policy.grantId,
        rolloutStageId: policy.rollout.stageId,
        gatesDigest,
        ledgerHead: ledgerHeadHash,
        enforcement: state.enforcement ?? landing.enforcement,
        // A revert carries the landing's risk class; its size is measured from the revert diff.
        risk: landing.risk,
        files: state.files ?? landing.files,
        linesAdded: state.linesAdded ?? landing.linesDeleted,
        linesDeleted: state.linesDeleted ?? landing.linesAdded,
        producer: null,
        judgeId: null,
        proposedAt: state.createdAt,
        landedAt: merged.landedAt,
        watchUntil: new Date(Date.parse(merged.landedAt) + 2 * 60 * 60 * 1000).toISOString(),
      };
      state.landing = revertLanding;
      // U4 ledgers `revert:landed` itself (FleetRevertRequest contract).
      state.landingLedgered = true;
      state.outcome = 'merged';
      state.outcomeReason = `reverted ${landing.id}`;
      state.pr!.state = 'merged';
      persist(state);
      return { ok: true, landing: revertLanding };
    }
    persist(state);
    return fail('github', 'the base branch kept moving while the revert was being landed', true);
  } catch (error) {
    return fail('github', `revert failed: ${errText(error)}`, true);
  } finally {
    closeGitScratch(scratch);
    unlockFleetMergeState(lock);
  }
}

type RevertRecorder = (gate: GateId, e: GateEvaluation, headSha: string | null, grantId: string | null) => { ok: boolean; row: GateResult };

async function buildRevert(
  state: FleetMergeStateV1,
  landing: LandingRecord,
  baseSha: string,
  scratch: FleetGitScratch,
  verify: NonNullable<LandFleetRevertOptions['verify']>,
  deps: HostMergeDeps,
  record: RevertRecorder,
  grantId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; outcome: FleetRevertOutcome }> {
  const fail = (code: FleetRevertFailureCode, why: string, retryable: boolean) => ({
    ok: false as const,
    outcome: { ok: false as const, code, retryable, reason: scrubSecrets(why).slice(0, 400) },
  });
  // The mirror syncs to origin once per tick: a base it has not fetched yet is
  // a wait (`pending`), not a failed revert attempt.
  if (!scratchHasCommit(scratch, baseSha)) return fail('pending', 'the base commit is not in the mirror yet', true);
  if (!scratchHasCommit(scratch, landing.mergeSha)) return fail('pending', 'the landing commit is not in the mirror yet', true);
  const reverted = revertTreeFor(scratch, baseSha, landing.mergeSha);
  if (!reverted.ok) return fail(reverted.conflict ? 'conflict' : 'github', reverted.reason, !reverted.conflict);
  const base = scratchCommit(scratch, baseSha);
  if (!base) return fail('pending', 'the base commit is not in the mirror yet', true);
  if (reverted.treeSha === base.tree) return fail('gate-refused', 'the base already lacks this change; there is nothing to revert', false);
  const diff = scratchDiff(scratch, base.tree, reverted.treeSha);
  if (!diff) return fail('github', 'the revert diff could not be computed', true);

  // ── G3: verify the reverted tree in the mirror ─────────────────────────
  const synthetic = {
    id: `fleet-revert-${state.key}`.slice(0, 120),
    repo: state.repoPath,
    origin: 'swarm',
    kind: 'patch',
    title: `Revert ${landing.id}`,
    summary: reason,
    diff,
    status: 'pending',
    createdAt: state.createdAt,
  } as Proposal;
  let verified: Awaited<ReturnType<typeof verify>> | null;
  try {
    verified = await verify(synthetic);
  } catch {
    verified = null;
  }
  const verifyForGate = verified && verified.baseHead && verified.baseHead !== baseSha
    ? { ...verified, ok: false, failureCategory: 'infra', detail: `the mirror is at ${verified.baseHead.slice(0, 12)}, not the remote base ${baseSha.slice(0, 12)}` }
    : verified;
  const g3 = evaluateG3({
    verify: verifyForGate,
    parity: null,
    tree: { ok: true, treeSha: reverted.treeSha },
    diffHash: sha256Hex(diff),
  });
  const g3Row = record('G3', g3, null, grantId);
  if (!g3Row.ok) return fail('github', 'the authority ledger refused the revert\'s G3 row', true);
  // G3 `wait` = verification could not run (capacity, lease, infra): in flight, not an attempt.
  if (g3.verdict === 'wait') return fail('pending', g3.reason, true);
  if (g3.verdict !== 'pass') return fail('gate-refused', g3.reason, false);
  state.baseBranch = landing.baseBranch;
  state.baseSha = baseSha;
  state.treeSha = reverted.treeSha;
  state.diffHash = sha256Hex(diff);
  const size = diffSize(diff);
  state.files = size.files;
  state.linesAdded = size.added;
  state.linesDeleted = size.deleted;
  state.verifyDigest = sha256Hex(`${g3Row.row.digest}`);
  state.verifyCommands = normalizeVerifyCommands(verified?.commands ?? verified?.commandKinds.map((kind) => ({ kind, cmd: [] })) ?? []);

  // ── G7: publish + open ────────────────────────────────────────────────
  const branch = `${FLEET_BRANCH_PREFIX}${state.key}`;
  const published = await publishVerifiedTree({
    repo: landing.repo,
    branch,
    baseSha,
    treeSha: reverted.treeSha,
    scratch,
    commitMessage: `Revert fleet landing ${landing.id}\n\n${scrubSecrets(reason).slice(0, 1_000)}\n`,
  }, deps);
  if (!published.ok) {
    const code: FleetRevertFailureCode = published.code === 'branch-foreign' ? 'not-fleet' : published.code === 'busy' ? 'pending' : 'github';
    return fail(code, published.reason, published.retryable);
  }
  if (state.pr && state.pr.state === 'open') {
    state.pr.headSha = published.headSha;
    state.pr.baseSha = baseSha;
    state.pr.treeSha = reverted.treeSha;
    state.pr.checks = null;
    state.pr.openedAt = new Date(deps.nowMs()).toISOString();
    return { ok: true };
  }
  const opened = await openFleetPr({
    repo: landing.repo,
    branch,
    baseBranch: landing.baseBranch,
    headSha: published.headSha,
    baseSha,
    treeSha: reverted.treeSha,
    title: `Revert fleet merge #${landing.prNumber} (post-merge watch)`,
    body: [
      `The post-merge watch found fleet landing \`${landing.id}\` red and is reverting it.`,
      '',
      `Reason: ${reason}`,
      '',
      'Verified in the fleet mirror (G3); merged by the ashlr-fleet App once every required check is green (G7).',
    ].join('\n'),
    ownerLane: false,
    ownerLaneReason: null,
  }, deps);
  if (!opened.ok) return fail('github', opened.reason, opened.retryable);
  state.pr = opened.pr;
  if (!ledgerPrOpened(state, 'revert', grantId, deps)) {
    return fail('github', 'the authority ledger refused the revert PR\'s pr:opened row', true);
  }
  if (opened.pr.ownerLane) return fail('not-fleet', opened.pr.ownerLaneReason ?? 'the revert PR is not the App\'s', false);
  return { ok: true };
}

type WaitResult =
  | { kind: 'green'; evaluation: GateEvaluation; protectionDigest: string; strict: boolean | null }
  | { kind: 'red'; evaluation: GateEvaluation }
  | { kind: 'owner-lane'; evaluation: GateEvaluation }
  | { kind: 'pending' }
  | { kind: 'killed' }
  | { kind: 'error'; reason: string };

async function waitForChecks(state: FleetMergeStateV1, deps: HostMergeDeps, deadlineMs: number): Promise<WaitResult> {
  const pr = state.pr!;
  // 3.13: the App's ashlr/verify on the revert head (idempotent per head). A
  // local-enforcement repo cannot pass G7 without it, so a transient failure
  // is retried later rather than sending the revert to the owner lane.
  const posted = await ensureFleetVerifyCheck(state, deps);
  if (!posted.ok && posted.retryable && state.enforcement === 'local') {
    return { kind: 'error', reason: `${ASHLR_VERIFY_CHECK_NAME} could not be posted: ${posted.reason}` };
  }
  for (;;) {
    if (deps.killActive()) return { kind: 'killed' };
    const required = await readRequiredChecks(state.repo, pr.baseBranch, deps);
    if (typeof required === 'string') return { kind: 'error', reason: required };
    const checks = await readHeadChecks(state.repo, pr.headSha, deps);
    if (typeof checks === 'string') return { kind: 'error', reason: checks };
    const evaluation = evaluateG7Checks({
      enforcement: (state.enforcement ?? 'server') as RepoEnforcement,
      required: required.required,
      runs: checks.runs,
      statuses: checks.statuses,
      pendingSinceMs: Date.parse(pr.openedAt) || deps.nowMs(),
      nowMs: deps.nowMs(),
      fleetAppId: pr.verifyCheck?.appId ?? null,
    });
    pr.checks = { state: evaluation.state === 'none' ? 'none' : evaluation.state, detail: evaluation.reason, at: new Date(deps.nowMs()).toISOString() };
    if (evaluation.verdict === 'pass') return { kind: 'green', evaluation, protectionDigest: required.protectionDigest, strict: required.strict };
    if (evaluation.verdict === 'owner-lane') return { kind: 'owner-lane', evaluation };
    if (evaluation.verdict === 'refuse') return { kind: 'red', evaluation };
    if (deps.nowMs() + REVERT_CHECKS_POLL_MS > deadlineMs) return { kind: 'pending' };
    await deps.sleep(REVERT_CHECKS_POLL_MS);
  }
}

/** Files and +/- line counts of a unified diff (content lines only). */
export function diffSize(diff: string): { files: number; added: number; deleted: number } {
  let files = 0;
  let added = 0;
  let deleted = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files++;
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) deleted++;
  }
  return { files, added, deleted };
}
