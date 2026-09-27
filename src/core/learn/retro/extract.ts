/**
 * Deterministic retro extraction (3.15) — PURE: no I/O, no clock, no model.
 *
 * Each task end arrives as a small, already-joined input (the sweep does the
 * joining from the authority ledger, the inbox, the cloud task files and the
 * Leader's action log). This module reads ONLY what the system itself
 * recorded — gate memos (code + reason), verify output (failed commands,
 * failure category, detail), post-merge detail and revert reason, close
 * reasons, launch failure codes, Leader veto notes — and turns it into:
 *
 *   root cause   a stable code the Lessons chart groups on, a label, one sentence
 *   do next      one to three concrete changes of approach
 *   better prompt the original ask plus the constraints the failure taught
 *   candidates   knowledge notes scoped to the repo / paths / task kind
 *
 * WHY infra causes produce no candidates: a missing required check or an
 * unauthenticated producer is not something the next coding task can do
 * better. Teaching engines about it would be noise; the retro still records it
 * (the chart shows it) so Mason can fix the setup.
 */
import { cleanText, retroIdFor } from './store.js';
import type {
  KnowledgeCandidate,
  KnowledgeScope,
  RetroEndKind,
  RetroRootCause,
  RetroSource,
  RetroV1,
  TaskKind,
} from './types.js';
import { classifyTaskKind } from './inject.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface VerifyEvidence {
  passed: boolean;
  /** Command kinds or names that failed ("test", "typecheck", "npm test"…). */
  failed?: readonly string[];
  detail?: string | null;
  failureCategory?: 'code' | 'tool' | 'timeout' | 'infra' | 'cancelled' | 'invalid-command' | null;
  ran?: readonly { kind: string; cmd: readonly string[] }[];
}

export interface FleetEndInput {
  /** Proposal id (or landing id when no proposal is known). */
  proposalId: string;
  /** GitHub owner/name. */
  repo: string | null;
  endKind: Extract<RetroEndKind, 'merged' | 'reverted' | 'closed' | 'gate-refused' | 'owner-laned' | 'verify-failed' | 'failed'>;
  endedAt: string;
  title: string | null;
  summary: string | null;
  /** Repo-relative paths from the proposal diff. */
  paths: readonly string[];
  /** The deciding gate row, when a gate decided. */
  gate?: { gate: string; code: string; reason: string } | null;
  verify?: VerifyEvidence | null;
  /** Post-merge verdict that caused a revert. */
  postMerge?: { ci: string; suite: string; detail: string } | null;
  /** A PR close: the recorded reason and who closed it. */
  close?: { reason: string; actor: string } | null;
  /** Producer engine (`grok-cli`, `local`…), when known. */
  engine?: string | null;
}

export interface CloudEndInput {
  taskId: string;
  repo: string;
  state: 'merged' | 'closed' | 'failed' | 'expired';
  endedAt: string;
  title: string;
  prompt: string;
  stateReason: string | null;
  failure: string | null;
  report: { status: string; summary: string; testsRun: readonly string[]; risks: readonly string[] } | null;
  origin: string;
}

export interface LeaderEndInput {
  actionId: string;
  kind: string;
  status: 'vetoed' | 'failed' | 'refused';
  summary: string;
  why: string;
  endedAt: string;
  note: string | null;
  statusReason: string | null;
  /** The action's repo param, when it names one. */
  repo: string | null;
}

// ---------------------------------------------------------------------------
// Cause catalog
// ---------------------------------------------------------------------------

interface CauseSpec {
  label: string;
  /** Not the task's fault (setup, custody, flaky infra): recorded, never taught. */
  infra: boolean;
  /** What to do differently next time (one or two lines). */
  advice: string[];
  /** Constraint appended to the better prompt; null = none. */
  constraint: string | null;
}

/** Gate codes the merge gates emit (fleet/merge-gates.ts), by what they mean for the NEXT attempt. */
const GATE_CAUSES: Readonly<Record<string, CauseSpec>> = {
  'test-tamper': {
    label: 'Tests weakened',
    infra: false,
    advice: ['Never delete, skip or loosen an existing test to make a change pass; fix the code or report the conflict.'],
    constraint: 'Do not delete, skip, or weaken any existing test or assertion.',
  },
  'partial-capture': {
    label: 'Partial diff filed',
    infra: false,
    advice: ['Size the task to finish inside the budget, or stop without a diff; a partial capture is never mergeable.'],
    constraint: 'Finish the change completely or make no change at all — never leave a partial diff.',
  },
  'risk-high': {
    label: 'Change too risky',
    infra: false,
    advice: ['Split the work so each proposal stays low-risk; high-risk changes are never auto-merged.'],
    constraint: 'Keep the change low-risk: no schema, auth, security or build-system changes in this task.',
  },
  'risk-over-cap': {
    label: 'Change too risky',
    infra: false,
    advice: ['Split the work so each proposal stays within the repo’s risk cap.'],
    constraint: 'Keep the change within the repo’s allowed risk level; split anything riskier into a separate task.',
  },
  'files-over-cap': {
    label: 'Diff too large',
    infra: false,
    advice: ['Touch fewer files per proposal; split broad changes into a sequence of small ones.'],
    constraint: 'Touch as few files as possible; split the work if it needs many files.',
  },
  'lines-over-cap': {
    label: 'Diff too large',
    infra: false,
    advice: ['Change fewer lines per proposal; land the core change first and follow-ups separately.'],
    constraint: 'Keep the diff small; land the core change only and leave follow-ups for separate tasks.',
  },
  'local-author-cap': {
    label: 'Diff too large',
    infra: false,
    advice: ['Work a local model authored merges only when tiny and low-risk; keep such tasks minimal.'],
    constraint: 'Keep the diff minimal and low-risk.',
  },
  'local-enforcement-cap': {
    label: 'Diff too large',
    infra: false,
    advice: ['This repo is locally enforced and capped low; keep its proposals minimal.'],
    constraint: 'Keep the diff minimal and low-risk.',
  },
  'verify-failed': {
    label: 'Verification failed',
    infra: false,
    advice: ['Run the repo’s own verify commands locally before proposing, and fix what fails.'],
    constraint: 'Run the repository’s tests, typecheck and lint for what you changed and make them pass before finishing.',
  },
  'no-verification-commands': {
    label: 'Nothing verified',
    infra: true,
    advice: ['Give the repo verify commands (tests / typecheck) so its changes can be proven.'],
    constraint: null,
  },
  'diff-does-not-apply': {
    label: 'Stale base',
    infra: false,
    advice: ['Work from the current default branch head; rebase before proposing when the base moved.'],
    constraint: 'Start from the latest default branch; the base moves quickly here.',
  },
  'tree-paths-unexpected': {
    label: 'Undeclared changes',
    infra: false,
    advice: ['Make sure generated files and build outputs are not left in the tree; the diff must be everything that changes.'],
    constraint: 'Do not leave generated files or build output in the working tree.',
  },
  'link-or-submodule': {
    label: 'Symlink or submodule added',
    infra: false,
    advice: ['Do not add symlinks or submodules; copy or import instead.'],
    constraint: 'Do not add symlinks or git submodules.',
  },
  'tree-protected-path': {
    label: 'Protected path touched',
    infra: false,
    advice: ['Keep autonomous changes out of protected paths; those go to Mason’s owner lane.'],
    constraint: 'Do not modify protected paths (authority, gates, CI config, test setup).',
  },
  'claim-mismatch': {
    label: 'Report did not match diff',
    infra: false,
    advice: ['Report exactly what the diff does; the claim is checked against the change.'],
    constraint: 'Describe only what the diff actually changes, and list the tests you actually ran.',
  },
  'judge-rejected': {
    label: 'Reviewer rejected',
    infra: false,
    advice: ['Read the reviewer’s objection and address it in the change itself before re-proposing.'],
    constraint: 'Keep the change tightly scoped to the request and match existing conventions exactly.',
  },
  'judge-no-merge-intent': {
    label: 'Reviewer would not merge',
    infra: false,
    advice: ['Make the change clearly worth merging on its own, or do not propose it.'],
    constraint: 'Only propose a change that is complete and clearly worth merging on its own.',
  },
  'required-check-failed': {
    label: 'CI failed on the PR',
    infra: false,
    advice: ['Run the same checks CI runs (not only targeted tests) before proposing.'],
    constraint: 'Run the full check suite CI runs, not just targeted tests, before finishing.',
  },
  'checks-timeout': { label: 'CI never finished', infra: true, advice: ['Check the repo’s CI; it did not finish within 24 h.'], constraint: null },
  'self-eval-parity': { label: 'Self-eval parity failed', infra: false, advice: ['Keep ashlr-hub self-eval parity: run the self-eval suite.'], constraint: 'Keep ashlr-hub self-eval parity: run the self-eval suite before finishing.' },
  'provenance-invalid': { label: 'Producer not authenticated', infra: true, advice: ['Producer signing failed; check the fleet’s provenance keys.'], constraint: null },
  'diff-unmeasurable': { label: 'Diff unreadable', infra: true, advice: ['The diff could not be measured; check the capture.'], constraint: null },
  'diff-unparseable': { label: 'Diff unreadable', infra: true, advice: ['The diff could not be parsed; check the capture.'], constraint: null },
  'tamper-unreadable': { label: 'Diff unreadable', infra: true, advice: ['Test tampering could not be ruled out; check the capture.'], constraint: null },
  'verify-unbound': { label: 'Verification unbound', infra: true, advice: ['Verification did not record its base; re-run it.'], constraint: null },
  'claim-check-failed': { label: 'Claim check failed', infra: true, advice: ['The claim-vs-diff check itself failed; re-run it.'], constraint: null },
  'no-required-checks': { label: 'Repo has no required checks', infra: true, advice: ['Add required checks on the default branch so fleet PRs can be proven green.'], constraint: null },
  'no-checks': { label: 'Repo has no CI', infra: true, advice: ['Add CI (or the ashlr/verify check) so fleet PRs can be proven green.'], constraint: null },
  'no-verify-check': { label: 'Repo has no CI', infra: true, advice: ['Install the ashlr-fleet App’s ashlr/verify check on this repo.'], constraint: null },
  'server-enforcement-unavailable': { label: 'Repo enforcement mismatch', infra: true, advice: ['Re-approve the grant to switch this repo to local enforcement.'], constraint: null },
};

const PROTECTED_CAUSE: CauseSpec = {
  label: 'Protected path touched',
  infra: false,
  advice: ['Keep autonomous changes out of protected paths; those always go to Mason’s owner lane.'],
  constraint: 'Do not modify protected paths (authority, gates, CI config, test setup); if the fix needs one, say so instead of editing it.',
};

function gateCause(code: string): CauseSpec {
  if (code.startsWith('protected-')) return PROTECTED_CAUSE;
  return GATE_CAUSES[code] ?? {
    label: 'Refused by a gate',
    infra: false,
    advice: ['Read the gate’s reason and address it in the change before re-proposing.'],
    constraint: null,
  };
}

/** Verification failure, classified by the verifier's own category and the failed command kinds. */
function verifyCause(verify: VerifyEvidence): { code: string; spec: CauseSpec; failedKinds: string[] } {
  const failed = [...new Set((verify.failed ?? []).map((f) => f.toLowerCase()))];
  const category = verify.failureCategory ?? null;
  if (category && category !== 'code') {
    const label = category === 'timeout' ? 'Verification timed out' : category === 'invalid-command' ? 'Bad verify command' : 'Verifier unavailable';
    return {
      code: `verify:${category}`,
      spec: { label, infra: category !== 'timeout', advice: category === 'timeout' ? ['Keep the change small enough that the repo’s checks finish in time.'] : ['The verifier itself could not run; fix the repo’s verify setup.'], constraint: category === 'timeout' ? 'Keep the change small so verification finishes quickly.' : null },
      failedKinds: failed,
    };
  }
  const kind = ['typecheck', 'test', 'lint', 'build'].find((k) => failed.some((f) => f.includes(k))) ?? null;
  const labels: Record<string, string> = { typecheck: 'Typecheck failed', test: 'Tests failed', lint: 'Lint failed', build: 'Build failed' };
  return {
    code: kind ? `verify:${kind}` : 'verify:failed',
    spec: {
      label: kind ? labels[kind]! : 'Verification failed',
      infra: false,
      advice: [kind ? `Run the repo’s ${kind} before proposing and fix what it reports.` : 'Run the repo’s own verify commands before proposing, and fix what fails.'],
      constraint: kind ? `Run the repository’s ${kind} for what you changed and make it pass before finishing.` : GATE_CAUSES['verify-failed']!.constraint,
    },
    failedKinds: failed,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `src/core/fleet/x.ts` → `src/core/fleet/**`; top-level files stay exact. At most 4, most common first. */
export function pathGlobsFor(paths: readonly string[], max = 4): string[] {
  const counts = new Map<string, number>();
  for (const raw of paths) {
    const p = raw.replace(/^\.?\//, '').trim();
    if (!p || p.includes('..')) continue;
    const parts = p.split('/');
    const glob = parts.length <= 1 ? p : parts.length === 2 ? `${parts[0]}/**` : `${parts.slice(0, Math.min(parts.length - 1, 3)).join('/')}/**`;
    counts.set(glob, (counts.get(glob) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([g]) => g);
}

/** Repo-relative paths from a unified diff's headers. Pure. */
export function diffPaths(diff: string | null | undefined, max = 50): string[] {
  if (!diff) return [];
  const out = new Set<string>();
  for (const line of diff.split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line) ?? /^--- a\/(.+)$/.exec(line);
    if (m && m[1] && m[1] !== '/dev/null') out.add(m[1].trim());
    if (out.size >= max) break;
  }
  return [...out];
}

function firstLines(text: string | null | undefined, maxChars: number): string {
  if (!text) return '';
  return cleanText(text.split('\n').filter((l) => l.trim()).slice(0, 6).join(' '), maxChars);
}

function scope(repo: string | null, paths: readonly string[], kinds: TaskKind[]): KnowledgeScope {
  return { repo, pathGlobs: pathGlobsFor(paths), taskKinds: kinds };
}

function betterPrompt(asked: string, constraints: (string | null)[]): string | null {
  const lines = [...new Set(constraints.filter((c): c is string => !!c))];
  if (!asked || lines.length === 0) return null;
  return `${asked}\n\nConstraints learned from the last attempt:\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

function where(repo: string | null, globs: readonly string[]): string {
  const repoPart = repo ? repo : 'this repo';
  return globs.length > 0 ? `${repoPart} (${globs.slice(0, 2).join(', ')})` : repoPart;
}

function baseRetro(parts: {
  sourceKey: string;
  source: RetroSource;
  taskId: string;
  repo: string | null;
  endKind: RetroEndKind;
  endedAt: string;
  taskKind: TaskKind;
  asked: string;
  happened: string;
  rootCause: RetroRootCause | null;
  doDifferently: string[];
  betterPrompt: string | null;
  candidates: KnowledgeCandidate[];
  paths: readonly string[];
  createdAt: string;
}): RetroV1 {
  return {
    v: 1,
    id: retroIdFor(parts.sourceKey),
    sourceKey: parts.sourceKey,
    source: parts.source,
    taskId: parts.taskId,
    repo: parts.repo,
    endKind: parts.endKind,
    endedAt: parts.endedAt,
    taskKind: parts.taskKind,
    asked: parts.asked,
    happened: cleanText(parts.happened, 600),
    rootCause: parts.rootCause
      ? { ...parts.rootCause, detail: cleanText(parts.rootCause.detail, 400) }
      : null,
    doDifferently: parts.doDifferently.map((d) => cleanText(d, 300)).filter(Boolean).slice(0, 3),
    betterPrompt: parts.betterPrompt,
    candidates: parts.candidates
      .map((c) => ({ text: cleanText(c.text, 600), scope: c.scope }))
      .filter((c) => c.text.length >= 12)
      .slice(0, 3),
    paths: parts.paths.slice(0, 20),
    model: null,
    createdAt: parts.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

/** Generic close reasons that say nothing about the work (no lesson in them). */
const GENERIC_CLOSE = /^(closed (in verse|on github)( without landing)?\.?|closed from ashlr verse.*|dismissed in verse\.?|superseded.*)$/i;

export function retroFromFleet(input: FleetEndInput, createdAt: string): RetroV1 {
  const asked = firstLines([input.title, input.summary].filter(Boolean).join('\n'), 400) || '(no request recorded)';
  const kind = classifyTaskKind(`${input.title ?? ''} ${input.summary ?? ''}`);
  const globs = pathGlobsFor(input.paths);
  const at = where(input.repo, globs);
  const kinds: TaskKind[] = kind === 'other' ? [] : [kind];
  const sourceKey = `fleet:${input.proposalId}:${input.endKind}`;
  const common = {
    sourceKey,
    source: 'fleet' as const,
    taskId: input.proposalId,
    repo: input.repo,
    endKind: input.endKind,
    endedAt: input.endedAt,
    taskKind: kind,
    asked,
    paths: input.paths,
    createdAt,
  };
  const engine = input.engine ? ` (${input.engine})` : '';

  if (input.endKind === 'merged') {
    return baseRetro({
      ...common,
      happened: `Merged${engine} into ${input.repo ?? 'the repo'}${input.paths.length ? ` touching ${input.paths.length} file(s)` : ''}.`,
      rootCause: null,
      doDifferently: [],
      betterPrompt: null,
      candidates: [],
    });
  }

  if (input.endKind === 'reverted') {
    const pm = input.postMerge;
    const red = pm ? (pm.ci === 'red' ? 'ci' : pm.suite === 'fail' ? 'suite' : 'red') : 'red';
    const code = `revert:${red === 'ci' ? 'ci-red' : red === 'suite' ? 'suite-failed' : 'post-merge-red'}`;
    const detail = pm?.detail || 'The post-merge watch went red and the change was reverted.';
    const advice = red === 'suite'
      ? `Changes in ${at} passed the gates but broke the full suite after merge; run the whole suite, not only targeted tests.`
      : `Changes in ${at} went red on CI after merge; run the same checks CI runs before proposing.`;
    return baseRetro({
      ...common,
      happened: `Merged${engine}, went red in the post-merge watch, and was reverted: ${detail}`,
      rootCause: { code, label: red === 'ci' ? 'Red on CI after merge' : red === 'suite' ? 'Suite failed after merge' : 'Red after merge', detail, evidence: 'post-merge watch' },
      doDifferently: [advice],
      betterPrompt: betterPrompt(asked, ['Run the full test suite and every CI check before finishing, not only the tests nearest the change.']),
      candidates: [{ text: advice, scope: scope(input.repo, input.paths, []) }],
    });
  }

  if (input.endKind === 'verify-failed' || (input.gate && input.gate.code === 'verify-failed' && input.verify && !input.verify.passed)) {
    const v = input.verify ?? { passed: false };
    const { code, spec, failedKinds } = verifyCause(v);
    const detail = v.detail || input.gate?.reason || `Verification failed${failedKinds.length ? ` (${failedKinds.join(', ')})` : ''}.`;
    const cmds = (v.ran ?? []).filter((r) => failedKinds.length === 0 || failedKinds.some((f) => r.kind.toLowerCase().includes(f) || f.includes(r.kind.toLowerCase())))
      .map((r) => r.cmd.join(' ')).filter(Boolean).slice(0, 2);
    const candidateText = spec.infra
      ? null
      : `In ${at}, ${kind === 'other' ? '' : `${kind} `}changes failed ${spec.label.toLowerCase().replace(' failed', '')}${cmds.length ? `; run \`${cmds[0]}\` before proposing` : '; run the repo’s verify commands before proposing'}.`;
    return baseRetro({
      ...common,
      endKind: 'verify-failed',
      sourceKey: `fleet:${input.proposalId}:verify-failed`,
      happened: `Verification failed${engine}: ${detail}`,
      rootCause: { code, label: spec.label, detail, evidence: 'verify output' },
      doDifferently: spec.advice,
      betterPrompt: betterPrompt(asked, [spec.constraint, cmds.length ? `Run \`${cmds.join('` and `')}\` and make it pass.` : null]),
      candidates: candidateText ? [{ text: candidateText, scope: scope(input.repo, input.paths, kinds) }] : [],
    });
  }

  if (input.endKind === 'gate-refused' || input.endKind === 'owner-laned') {
    const g = input.gate ?? { gate: '?', code: 'unknown', reason: 'A merge gate stopped it.' };
    const spec = gateCause(g.code);
    const refused = input.endKind === 'owner-laned' ? 'sent to the owner lane' : 'refused';
    const candidateText = spec.infra
      ? null
      : g.code.startsWith('protected-') || g.code === 'tree-protected-path'
        ? `Autonomous changes to ${at} touch protected paths and always go to Mason’s owner lane; keep fleet tasks out of them or say the fix needs one.`
        : g.code === 'judge-rejected' || g.code === 'judge-no-merge-intent'
          ? `In ${at}, a reviewer rejected a ${kind === 'other' ? '' : `${kind} `}change: ${cleanText(g.reason, 220)}`
          : `In ${at}: ${spec.advice[0]}`;
    return baseRetro({
      ...common,
      happened: `${g.gate} ${refused} it${engine}: ${g.reason}`,
      rootCause: { code: `gate:${g.code.startsWith('protected-') ? 'protected-path' : g.code}`, label: spec.label, detail: g.reason, evidence: `gate ${g.gate} memo` },
      doDifferently: spec.advice,
      betterPrompt: betterPrompt(asked, [spec.constraint]),
      candidates: candidateText ? [{ text: candidateText, scope: scope(input.repo, input.paths, g.code.startsWith('protected-') ? [] : kinds) }] : [],
    });
  }

  if (input.endKind === 'closed') {
    const reason = input.close?.reason?.trim() || 'Closed without landing.';
    const byMason = input.close?.actor === 'mason';
    const ttl = /unreviewed for \d+ days/i.test(reason);
    const informative = !GENERIC_CLOSE.test(reason) && !ttl;
    const code = ttl ? 'closed:owner-lane-ttl' : byMason ? 'closed:by-mason' : 'closed:by-fleet';
    const label = ttl ? 'Owner lane expired unreviewed' : byMason ? 'Closed by Mason' : 'Closed by the fleet';
    const doNext = ttl
      ? ['Owner-lane work that nobody reviews expires; avoid protected paths or ask for review explicitly.']
      : informative
        ? [`Address the close reason before retrying: ${cleanText(reason, 200)}`]
        : ['Confirm the request is still wanted before re-running it.'];
    return baseRetro({
      ...common,
      happened: `PR closed without landing${byMason ? ' by Mason' : ''}: ${reason}`,
      rootCause: { code, label, detail: reason, evidence: 'close reason' },
      doDifferently: doNext,
      betterPrompt: informative ? betterPrompt(asked, [`Mason closed the last attempt because: ${cleanText(reason, 200)}`]) : null,
      candidates: informative && byMason
        ? [{ text: `Mason closed a ${kind === 'other' ? '' : `${kind} `}change in ${at} without landing: ${cleanText(reason, 240)}`, scope: scope(input.repo, input.paths, kinds) }]
        : [],
    });
  }

  // failed: apply / producer failure with no finer evidence.
  return baseRetro({
    ...common,
    endKind: 'failed',
    happened: `The task failed${engine}${input.close?.reason ? `: ${input.close.reason}` : '.'}`,
    rootCause: { code: 'fleet:failed', label: 'Run failed', detail: input.close?.reason ?? 'No reason was recorded.', evidence: 'proposal status' },
    doDifferently: ['Check the run log; nothing recorded why it failed.'],
    betterPrompt: null,
    candidates: [],
  });
}

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

const CLOUD_FAILURES: Readonly<Record<string, { label: string; infra: boolean; advice: string }>> = {
  'seat-unavailable': { label: 'Cloud seat unavailable', infra: true, advice: 'The claude-a launcher was missing; fix the seat before relaunching.' },
  auth: { label: 'Cloud not signed in', infra: true, advice: 'Sign the cloud seat in to claude.ai before relaunching.' },
  'not-enabled': { label: 'Cloud not enabled', infra: true, advice: 'Enable cloud sessions for the account.' },
  'rate-limited': { label: 'Cloud rate-limited', infra: true, advice: 'Credits or limits ran out; relaunch after the window resets.' },
  'no-remote': { label: 'Branch not on GitHub', infra: false, advice: 'Push the base branch to origin before launching a cloud task on it.' },
  'checkout-failed': { label: 'Checkout failed', infra: true, advice: 'The isolated checkout could not be prepared; check the local clone.' },
  budget: { label: 'Cloud budget refused', infra: true, advice: 'The cloud budget refused the launch; raise it or wait for the window.' },
  timeout: { label: 'Cloud launch timed out', infra: true, advice: 'The CLI produced no session in time; retry.' },
  unparsed: { label: 'Cloud launch unreadable', infra: true, advice: 'The CLI output was not recognised; retry or update the CLI.' },
  unknown: { label: 'Cloud launch failed', infra: true, advice: 'The launch failed for an unknown reason; check the Verse log.' },
};

export function retroFromCloud(input: CloudEndInput, createdAt: string): RetroV1 {
  const asked = firstLines([input.title, input.prompt].join('\n'), 400) || '(no request recorded)';
  const kind = classifyTaskKind(`${input.title} ${input.prompt}`);
  const kinds: TaskKind[] = kind === 'other' ? [] : [kind];
  const endKind: RetroEndKind = input.state;
  const common = {
    sourceKey: `cloud:${input.taskId}:${input.state}`,
    source: 'cloud' as const,
    taskId: input.taskId,
    repo: input.repo,
    endKind,
    endedAt: input.endedAt,
    taskKind: kind,
    asked,
    paths: [] as string[],
    createdAt,
  };
  const report = input.report;

  if (input.state === 'merged') {
    return baseRetro({
      ...common,
      happened: `Landed${report?.summary ? `: ${report.summary}` : '.'}`,
      rootCause: null,
      doDifferently: [],
      betterPrompt: null,
      candidates: [],
    });
  }

  if (input.state === 'failed') {
    const f = CLOUD_FAILURES[input.failure ?? 'unknown'] ?? CLOUD_FAILURES['unknown']!;
    return baseRetro({
      ...common,
      happened: `The cloud launch failed: ${input.stateReason ?? f.label}.`,
      rootCause: { code: `cloud:${input.failure ?? 'unknown'}`, label: f.label, detail: input.stateReason ?? f.advice, evidence: 'launch failure code' },
      doDifferently: [f.advice],
      betterPrompt: null,
      candidates: f.infra ? [] : [{ text: `Cloud tasks in ${input.repo}: ${f.advice}`, scope: { repo: input.repo, pathGlobs: [], taskKinds: [] } }],
    });
  }

  if (input.state === 'expired') {
    return baseRetro({
      ...common,
      happened: 'No pull request arrived before the task expired.',
      rootCause: { code: 'cloud:no-pr', label: 'No PR delivered', detail: input.stateReason ?? 'The session never opened its pull request.', evidence: 'task state' },
      doDifferently: ['Make the delivery step explicit and small: push the branch and open the draft PR even when blocked.'],
      betterPrompt: betterPrompt(asked, ['Open the draft pull request early and push progress to it, even if the work is blocked.']),
      candidates: [],
    });
  }

  // closed: the report's own status and risks are the richest evidence.
  const reason = input.stateReason?.trim() || 'Closed without landing.';
  const blocked = report && (report.status === 'blocked' || report.status === 'partial');
  const informative = !GENERIC_CLOSE.test(reason);
  const cause: RetroRootCause = blocked
    ? { code: `cloud:${report.status}`, label: report.status === 'blocked' ? 'Session blocked' : 'Partial delivery', detail: report.summary || reason, evidence: 'PR report' }
    : report?.status === 'no-change'
      ? { code: 'cloud:no-change', label: 'Nothing to change', detail: report.summary || reason, evidence: 'PR report' }
      : informative
        ? { code: 'closed:by-mason', label: 'Closed by Mason', detail: reason, evidence: 'close reason' }
        : { code: 'closed:unreviewed', label: 'Closed without a reason', detail: reason, evidence: 'close reason' };
  const doNext = blocked
    ? [`Unblock before relaunching: ${cleanText(report.summary, 200)}`]
    : report?.status === 'no-change'
      ? ['Check the request is still needed; the session found nothing to change.']
      : informative
        ? [`Address the close reason before retrying: ${cleanText(reason, 200)}`]
        : ['Record a close reason next time so the lesson is not lost.'];
  const candidates: KnowledgeCandidate[] = [];
  if (blocked && report.summary) {
    candidates.push({ text: `Cloud ${kind === 'other' ? '' : `${kind} `}tasks in ${input.repo} got ${report.status}: ${cleanText(report.summary, 240)}`, scope: { repo: input.repo, pathGlobs: [], taskKinds: kinds } });
  } else if (informative && cause.code === 'closed:by-mason') {
    candidates.push({ text: `Mason closed a cloud ${kind === 'other' ? '' : `${kind} `}change in ${input.repo} without landing: ${cleanText(reason, 240)}`, scope: { repo: input.repo, pathGlobs: [], taskKinds: kinds } });
  }
  const risks = (report?.risks ?? []).slice(0, 2).map((r) => cleanText(r, 160)).filter(Boolean);
  return baseRetro({
    ...common,
    happened: `PR closed without landing: ${reason}${report ? ` (report: ${report.status}${report.summary ? ` — ${cleanText(report.summary, 200)}` : ''})` : ''}`,
    rootCause: cause,
    doDifferently: [...doNext, ...risks.map((r) => `Reviewer risk flagged: ${r}`)],
    betterPrompt: blocked || (informative && cause.code === 'closed:by-mason')
      ? betterPrompt(asked, [blocked ? `The last attempt got ${report.status}: ${cleanText(report.summary, 200)}` : `Mason closed the last attempt because: ${cleanText(reason, 200)}`])
      : null,
    candidates,
  });
}

// ---------------------------------------------------------------------------
// Leader
// ---------------------------------------------------------------------------

/**
 * A vetoed / failed / refused Leader action. No knowledge candidates: a veto
 * already becomes a playbook delta the Leader reads back (Mason's own act —
 * it needs no second approval), and a refused action is the policy working.
 */
export function retroFromLeader(input: LeaderEndInput, createdAt: string): RetroV1 {
  const asked = cleanText(`${input.summary} — ${input.why}`, 400);
  const status = input.status;
  const endKind: RetroEndKind = status === 'vetoed' ? 'vetoed' : status === 'refused' ? 'gate-refused' : 'failed';
  const cause: RetroRootCause = status === 'vetoed'
    ? { code: `leader:vetoed:${input.kind}`, label: 'Vetoed by Mason', detail: input.note ? `Mason: ${input.note}` : 'Mason vetoed it without a note.', evidence: 'veto note' }
    : status === 'refused'
      ? { code: `leader:refused:${input.kind}`, label: 'Outside the grant', detail: input.statusReason ?? 'The policy check refused it.', evidence: 'policy check' }
      : { code: `leader:failed:${input.kind}`, label: 'Leader action failed', detail: input.statusReason ?? 'Applying it threw.', evidence: 'apply result' };
  return baseRetro({
    sourceKey: `leader:${input.actionId}:${status}`,
    source: 'leader',
    taskId: input.actionId,
    repo: input.repo,
    endKind,
    endedAt: input.endedAt,
    taskKind: 'leader',
    asked,
    happened: status === 'vetoed' ? `Mason vetoed “${input.summary}”.` : `“${input.summary}” was ${status}: ${cause.detail}`,
    rootCause: cause,
    doDifferently: status === 'vetoed'
      ? [input.note ? `Weigh Mason’s objection before proposing a similar ${input.kind}: ${cleanText(input.note, 200)}` : `Weigh this veto before proposing a similar ${input.kind}.`]
      : status === 'refused'
        ? ['Stay inside the standing grant; propose a grant change to Mason instead.']
        : ['Check the action’s inputs; applying it failed.'],
    betterPrompt: null,
    candidates: [],
    paths: [],
    createdAt,
  });
}
