/**
 * The host-verified required check `ashlr/verify` — 3.13.
 *
 * WHY: G7 needs GitHub to prove a fleet PR green. A repo without CI (GitHub
 * Actions off, e.g. ashlrai/ashlr-hub) reports zero check runs, so every PR
 * went to the owner lane (`no-required-checks` / `no-checks`); and on a
 * local-enforcement repo "every check green" accepted ANY green check — a
 * Vercel preview deploy alone passed G7. The fleet already runs the real
 * suite on the exact tree in its mirror (G3, verifyAndPersistProposal); this
 * module turns that result into a GitHub check run the ashlr-fleet App posts
 * on the PR head, so rulesets can REQUIRE it (pinned to the App's id) and G7
 * can demand it on local-enforcement repos.
 *
 * The one rule: `success` is posted ONLY when G3 passed AND the PR head
 * commit GitHub holds has exactly the verified tree on exactly the verified
 * base (its only parent). Anything else — G3 not passed, no command ran, a
 * head whose tree or parent differs — is `failure`. Nothing here ever posts
 * `neutral` or `skipped` (G7 counts those as green).
 *
 * Idempotent per head SHA: a commit id fixes its tree and parents forever, so
 * the decision is a pure function of (head SHA, verified binding). The memo
 * (`FleetPrMemo.verifyCheck`, in the agent-unreadable fleet merge state)
 * remembers the run posted for a head; an unchanged decision makes no GitHub
 * call, a changed one PATCHes that run, a new head gets a new run.
 *
 * The App id G7 trusts comes from GitHub's own answer to the App's
 * authenticated create call (`app.id` on the returned run) — an installation
 * token can only create runs as its own App, so no other App (a Vercel
 * integration, an agent's token) can ever be mistaken for the fleet's.
 *
 * Needs the App permission `checks: write`. A 403 is reported as `permission`
 * (not retryable); `ashlr authority setup` detects the missing permission and
 * prints where to grant it.
 */
import { createHash } from 'node:crypto';

import { scrubSecrets } from '../util/scrub.js';
import type { FleetMergeStateV1, FleetPrMemo } from './fleet-merge-state.js';
import type { GithubCall, GithubReply, HostMergeDeps } from './host-merge.js';

/** The check-run name rulesets require and G7 demands on local-enforcement repos. */
export const ASHLR_VERIFY_CHECK_NAME = 'ashlr/verify';

/** Where to grant the missing permission (the exact per-App URL is printed by `ashlr authority setup`). */
export const VERIFY_CHECK_PERMISSION_HINT =
  "the ashlr-fleet GitHub App needs the permission 'Checks: Read and write' to post ashlr/verify — " +
  'grant it in the App settings (Permissions & events), accept the new permission on each installation, ' +
  'then run `ashlr authority setup` (it prints the exact links)';

const SHA_RE = /^[0-9a-f]{40}$/;
const NAME_WITH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const MAX_COMMANDS = 20;
const MAX_CMD_CHARS = 200;

export interface VerifyCheckCommand {
  kind: string;
  /** argv as verification ran it; empty when only the kind is known (reverts). */
  cmd: readonly string[];
}

/** What the fleet posted on one PR head (stored on FleetPrMemo.verifyCheck). */
export interface VerifyCheckMemo {
  headSha: string;
  runId: number;
  /** The App GitHub attributed the run to — the id G7 requires `ashlr/verify` from. */
  appId: string;
  conclusion: 'success' | 'failure';
  /** Digest of (head, verified binding) the run was posted for; unchanged ⇒ no GitHub call. */
  inputsDigest: string;
  at: string;
}

/** The verified binding the check reports on. */
export interface VerifiedBinding {
  /** The G3 row's verdict / code; null = G3 never ran for this state. */
  g3: { verdict: string; code: string } | null;
  verifyDigest: string | null;
  baseSha: string | null;
  treeSha: string | null;
  commands: readonly VerifyCheckCommand[];
}

export interface VerifyCheckDecision {
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
  text: string;
}

export type VerifyCheckResult =
  | { ok: true; memo: VerifyCheckMemo; action: 'created' | 'updated' | 'unchanged' }
  | { ok: false; code: 'permission' | 'github' | 'invalid'; reason: string; retryable: boolean };

type Deps = Pick<HostMergeDeps, 'transport' | 'token' | 'nowMs'>;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function short(value: string | null): string {
  return value ? value.slice(0, 12) : 'none';
}

/** Bounded, secret-scrubbed commands (they come from the base tree's config, never from the diff). */
export function normalizeVerifyCommands(commands: readonly { kind?: unknown; cmd?: unknown }[] | null | undefined): VerifyCheckCommand[] {
  if (!Array.isArray(commands)) return [];
  const out: VerifyCheckCommand[] = [];
  for (const command of commands.slice(0, MAX_COMMANDS)) {
    const kind = typeof command?.kind === 'string' ? command.kind.replace(/[^a-z0-9_-]/gi, '').slice(0, 32) : '';
    if (!kind) continue;
    const cmd = Array.isArray(command.cmd)
      ? (command.cmd as unknown[]).filter((part): part is string => typeof part === 'string').slice(0, 32)
          .map((part) => scrubSecrets(part).replace(/[\r\n`]/g, ' ').slice(0, MAX_CMD_CHARS))
      : [];
    out.push({ kind, cmd });
  }
  return out;
}

/** Digest of everything the decision depends on besides the (immutable) head commit itself. */
export function verifyCheckInputsDigest(headSha: string, verified: VerifiedBinding): string {
  return sha256(`ashlr:verify-check:v1\0${JSON.stringify({
    headSha,
    g3: verified.g3 ? { verdict: verified.g3.verdict, code: verified.g3.code } : null,
    verifyDigest: verified.verifyDigest,
    baseSha: verified.baseSha,
    treeSha: verified.treeSha,
    commands: verified.commands.map((c) => ({ kind: c.kind, cmd: [...c.cmd] })),
  })}`);
}

/**
 * PURE: success only for G3 pass + at least one command + the head being the
 * verified tree on the verified base as its only parent. `head` is GitHub's
 * view of the PR head commit.
 */
export function decideVerifyCheck(input: {
  headSha: string;
  head: { tree: string; parents: readonly string[] };
  verified: VerifiedBinding;
}): VerifyCheckDecision {
  const { verified, head } = input;
  const facts = [
    `- Head: \`${input.headSha}\` (tree \`${head.tree}\`, parent ${head.parents.map((p) => `\`${p}\``).join(', ') || 'none'})`,
    `- Verified tree: \`${verified.treeSha ?? 'none'}\``,
    `- Verified base: \`${verified.baseSha ?? 'none'}\``,
    `- Verify digest: \`${verified.verifyDigest ?? 'none'}\``,
    `- G3: ${verified.g3 ? `${verified.g3.verdict} (${verified.g3.code})` : 'not run'}`,
  ];
  let failure: string | null = null;
  if (!verified.g3 || verified.g3.verdict !== 'pass') {
    failure = verified.g3
      ? `G3 did not pass (${verified.g3.verdict}: ${verified.g3.code})`
      : 'G3 never ran for this change (owner-lane PRs are not host-verified)';
  } else if (!verified.verifyDigest) failure = 'no verification digest is bound to this change';
  else if (!verified.treeSha || !SHA_RE.test(verified.treeSha) || !verified.baseSha || !SHA_RE.test(verified.baseSha)) {
    failure = 'the verified tree / base is not recorded';
  } else if (verified.commands.length === 0) failure = 'no verify command is recorded as having run';
  else if (head.tree !== verified.treeSha) failure = `the head's tree ${short(head.tree)} is not the verified tree ${short(verified.treeSha)}`;
  else if (head.parents.length !== 1 || head.parents[0] !== verified.baseSha) {
    failure = `the head's parent is not the verified base ${short(verified.baseSha)}`;
  }
  const commandLines = verified.commands.length === 0
    ? ['_No verify command recorded._']
    : verified.commands.map((c) => `- ${failure === null ? 'passed' : 'recorded'} · **${c.kind}**${c.cmd.length > 0 ? ` · \`${c.cmd.join(' ')}\`` : ''}`);
  const text = [
    '### Binding',
    ...facts,
    '',
    '### Commands (ran on the exact tree in the fleet mirror, confined)',
    ...commandLines,
  ].join('\n');
  if (failure !== null) {
    return {
      conclusion: 'failure',
      title: 'Not host-verified',
      summary: scrubSecrets(`ashlr did not verify this head: ${failure}.`).slice(0, 1_000),
      text,
    };
  }
  return {
    conclusion: 'success',
    title: `Host-verified: tree ${short(verified.treeSha)} on ${short(verified.baseSha)}`,
    summary: `The fleet ran ${verified.commands.length} verify command(s) on exactly this tree (G3 ${verified.g3!.code}); ` +
      `this head is that tree on that base, so GitHub can require this check.`,
    text,
  };
}

async function call(deps: Deps, repo: string, method: GithubCall['method'], suffix: string, body?: unknown): Promise<GithubReply> {
  let token: string;
  try {
    token = (await deps.token(repo)).token;
  } catch (error) {
    return { status: 0, body: { message: `no installation token for ${repo}: ${scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200)}` } };
  }
  try {
    return await deps.transport({ method, path: `/repos/${repo}${suffix}`, token, ...(body !== undefined ? { body } : {}) });
  } catch {
    return { status: 0, body: null };
  }
}

function replyMessage(reply: GithubReply): string {
  const message = obj(reply.body)?.['message'];
  return reply.status === 0
    ? 'GitHub did not answer (network error or timeout)'
    : `GitHub answered HTTP ${reply.status}${typeof message === 'string' ? `: ${scrubSecrets(message).slice(0, 200)}` : ''}`;
}

function failed(reply: GithubReply, what: string): VerifyCheckResult {
  if (reply.status === 403) {
    return { ok: false, code: 'permission', reason: `${what}: ${replyMessage(reply)}; ${VERIFY_CHECK_PERMISSION_HINT}`, retryable: false };
  }
  const retryable = reply.status === 0 || reply.status === 429 || reply.status >= 500;
  return { ok: false, code: 'github', reason: `${what}: ${replyMessage(reply)}`, retryable };
}

/**
 * Create or update the `ashlr/verify` check run on `headSha` from the
 * ashlr-fleet App (through the host-merge transport and its installation
 * token). Never throws.
 */
export async function postVerifyCheckRun(input: {
  repo: string;
  headSha: string;
  verified: VerifiedBinding;
  prior: VerifyCheckMemo | null | undefined;
}, deps: Deps): Promise<VerifyCheckResult> {
  if (!NAME_WITH_OWNER_RE.test(input.repo) || !SHA_RE.test(input.headSha)) {
    return { ok: false, code: 'invalid', reason: 'repo or head SHA is malformed', retryable: false };
  }
  const inputsDigest = verifyCheckInputsDigest(input.headSha, input.verified);
  const prior = input.prior ?? null;
  if (prior && prior.headSha === input.headSha && prior.inputsDigest === inputsDigest) {
    return { ok: true, memo: prior, action: 'unchanged' };
  }
  // GitHub's view of the head — the tree the check vouches for is the one GitHub holds.
  const headReply = await call(deps, input.repo, 'GET', `/git/commits/${input.headSha}`);
  if (headReply.status !== 200) return failed(headReply, 'head commit read');
  const headBody = obj(headReply.body);
  const tree = obj(headBody?.['tree'])?.['sha'];
  const parentsRaw = headBody?.['parents'];
  if (headBody?.['sha'] !== input.headSha || typeof tree !== 'string' || !SHA_RE.test(tree) || !Array.isArray(parentsRaw)) {
    return { ok: false, code: 'github', reason: 'GitHub returned a malformed head commit', retryable: true };
  }
  const parents = (parentsRaw as unknown[]).map((p) => obj(p)?.['sha']).filter((p): p is string => typeof p === 'string' && SHA_RE.test(p));
  if (parents.length !== parentsRaw.length) return { ok: false, code: 'github', reason: 'GitHub returned malformed head parents', retryable: true };
  const decision = decideVerifyCheck({ headSha: input.headSha, head: { tree, parents }, verified: input.verified });
  const common = {
    external_id: inputsDigest,
    status: 'completed',
    conclusion: decision.conclusion,
    completed_at: new Date(deps.nowMs()).toISOString(),
    output: { title: decision.title, summary: decision.summary, text: decision.text.slice(0, 60_000) },
  };
  let reply: GithubReply | null = null;
  let action: 'created' | 'updated' = 'created';
  if (prior && prior.headSha === input.headSha) {
    reply = await call(deps, input.repo, 'PATCH', `/check-runs/${prior.runId}`, common);
    action = 'updated';
    // The run is gone (or not ours any more): post a fresh one instead.
    if (reply.status === 404 || reply.status === 422) reply = null;
  }
  if (reply === null) {
    reply = await call(deps, input.repo, 'POST', '/check-runs', { name: ASHLR_VERIFY_CHECK_NAME, head_sha: input.headSha, ...common });
    action = 'created';
  }
  if (reply.status !== 200 && reply.status !== 201) return failed(reply, `check run ${action === 'created' ? 'create' : 'update'}`);
  const run = obj(reply.body);
  const runId = run?.['id'];
  const appIdRaw = obj(run?.['app'])?.['id'];
  const appId = typeof appIdRaw === 'number' && Number.isSafeInteger(appIdRaw) && appIdRaw > 0 ? String(appIdRaw) : null;
  if (!Number.isSafeInteger(runId) || (runId as number) < 1 || appId === null ||
    run?.['head_sha'] !== input.headSha || run?.['name'] !== ASHLR_VERIFY_CHECK_NAME || run?.['conclusion'] !== decision.conclusion) {
    return { ok: false, code: 'github', reason: 'GitHub returned a check run that is not the one posted', retryable: true };
  }
  // A PATCH answered by a different App than the one that created the run is not ours.
  if (action === 'updated' && prior && prior.appId !== appId) {
    return { ok: false, code: 'github', reason: `the check run is attributed to App ${appId}, not ${prior.appId}`, retryable: false };
  }
  return {
    ok: true,
    action,
    memo: {
      headSha: input.headSha,
      runId: runId as number,
      appId,
      conclusion: decision.conclusion,
      inputsDigest,
      at: new Date(deps.nowMs()).toISOString(),
    },
  };
}

/** The verified binding a fleet merge state carries (G3 row, verify digest, verified base / tree, commands). */
export function verifiedBindingOf(state: FleetMergeStateV1): VerifiedBinding {
  const g3 = state.gates['G3'];
  return {
    g3: g3 ? { verdict: g3.verdict, code: g3.code } : null,
    verifyDigest: state.verifyDigest,
    baseSha: state.baseSha,
    treeSha: state.treeSha,
    commands: normalizeVerifyCommands(state.verifyCommands ?? []),
  };
}

/**
 * Post (or confirm) `ashlr/verify` on the open fleet PR's current head and
 * remember it on `state.pr.verifyCheck`. The caller persists the state.
 */
export async function ensureFleetVerifyCheck(state: FleetMergeStateV1, deps: Deps): Promise<VerifyCheckResult> {
  const pr: FleetPrMemo | null = state.pr;
  if (!pr || pr.state !== 'open') return { ok: false, code: 'invalid', reason: 'no open fleet PR', retryable: false };
  const result = await postVerifyCheckRun({
    repo: state.repo,
    headSha: pr.headSha,
    verified: verifiedBindingOf(state),
    prior: pr.verifyCheck ?? null,
  }, deps);
  if (result.ok) pr.verifyCheck = result.memo;
  return result;
}
