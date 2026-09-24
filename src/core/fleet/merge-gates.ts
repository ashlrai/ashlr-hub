/**
 * Merge gates G0–G7 under a standing grant — V3.10 Track B (owner: unit U3).
 *
 * SPEC-310B §2. Gates run in GATE_ORDER and fail closed; each writes one
 * `gate:result` row to the authority ledger, and the combined digest of a
 * landing's rows becomes its `Ashlr-Gates` commit trailer.
 *
 *   G0  Authority    live standing policy, repo at `merge`, switch autonomous,
 *                    Stop off, no hold, under the daily cap, a judge seat free.
 *   G1  Protected    protected path ⇒ owner lane (PR opened, never merged).
 *   G1b Tamper       removed test calls / .skip / .only / snapshot edits ⇒
 *                    high risk ⇒ refused.
 *   G2  Scope        risk and size ≤ min(grant stage, config, ceilings);
 *                    local-authored and local-enforcement work capped lower.
 *   G3  Verify       verifyAndPersistProposal off the current base head, the
 *                    exact tree bound; ashlr-hub adds self-eval parity.
 *   G4  Claims       claim-vs-diff, forced on.
 *   G5  Blast radius unchanged (flag-gated blast radius / red team / spec).
 *   G6  Judge        an eligible frontier judge of a DIFFERENT family, HMAC
 *                    attested; waits (never downgrades) when no seat is free.
 *   G7  GitHub       App PR; every required check green on the head SHA; no
 *                    checks ⇒ owner lane; SHA-pinned squash merge.
 *
 * Everything here is PURE (inputs in, verdict out) except `recordGateRow`,
 * which appends to the ledger through an injected sink. The orchestration —
 * reading GitHub, running verification, calling the judge — lives in
 * standing-merge-pass.ts and host-merge.ts, so every gate decision can be
 * tested exhaustively without I/O.
 *
 * Verdicts (fleet-types.ts GateVerdict): `pass` continue · `refuse` the
 * proposal stops · `owner-lane` PR for Mason, never auto-merged · `wait`
 * retry later (the reason says until when).
 */
import { createHash } from 'node:crypto';

import { canonicalizeDaemonActivationValue } from '../daemon/activation-permit.js';
import {
  STANDING_GRANT_CEILINGS,
  type EffectiveMergePolicy,
  type EffectivePolicy,
  type EffectiveRepoPolicy,
} from '../authority/types.js';
import {
  detectTestTampering,
  protectedPathHits,
  type ProtectedPathHit,
} from '../authority/protected-paths.js';
import { hashDiff, verifyJudgeAttestation } from '../foundry/provenance.js';
import { scrubSecrets } from '../util/scrub.js';
import type { DecisionEntry } from '../types.js';
import {
  evaluateJudgeEligibility,
  judgeLanePreference,
  producerModelFamily,
  reviewModelFamily,
  type ReviewModelFamily,
} from './reviewer-independence.js';
import type { FleetMergeStateV1 } from './fleet-merge-state.js';
import {
  GATE_ORDER,
  MERGE_RISK_RANK,
  type FleetEngine,
  type GateId,
  type GateResult,
  type GateVerdict,
  type JudgeId,
  type MergeRisk,
  type RepoEnforcement,
  type RepoHold,
  type WouldMergeRecord,
} from './fleet-types.js';

export const GATE_ROW_DOMAIN = 'ashlr:gate-result:v1\0';
export const GATES_DIGEST_DOMAIN = 'ashlr:gates:v1\0';

/** A judge's ship stays usable this long (it is bound to the diff hash, so a changed diff never reuses it). */
export const JUDGE_VERDICT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** SPEC-310B §2 G6: wait this long for the preferred judge lane, then any other qualifying lane. */
export const JUDGE_PREFERENCE_WAIT_MS = 24 * 60 * 60 * 1000;
/** Required checks still pending this long after the PR head was pushed are treated as failed. */
export const CHECKS_MAX_PENDING_MS = 24 * 60 * 60 * 1000;
/** "Merges per day" is a rolling 24 h window: never more than the cap in ANY 24 h span. */
export const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_REASON_CHARS = 400;

export type RiskClass = 'low' | 'medium' | 'high';

/** One gate's decision before it becomes a ledger row. */
export interface GateEvaluation {
  verdict: GateVerdict;
  /** Stable machine reason (the funnel groups on it). */
  code: string;
  /** One specific sentence for Mason. */
  reason: string;
  /** The canonical facts the verdict rests on (hashed into the row digest). */
  inputs: Record<string, unknown>;
  /** For `wait`: when retrying can help; null = unknown. */
  nextEligibleAt: string | null;
}

function evaluation(
  verdict: GateVerdict,
  code: string,
  reason: string,
  inputs: Record<string, unknown>,
  nextEligibleAt: string | null = null,
): GateEvaluation {
  return { verdict, code, reason: clampReason(reason), inputs, nextEligibleAt };
}

function clampReason(reason: string): string {
  const scrubbed = scrubSecrets(reason).replace(/\s+/g, ' ').trim();
  return scrubbed.length <= MAX_REASON_CHARS ? scrubbed : `${scrubbed.slice(0, MAX_REASON_CHARS - 1)}…`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Rows and digests
// ---------------------------------------------------------------------------

/**
 * sha256 over the gate's canonical inputs + verdict. `reason` and `at` are
 * deliberately NOT hashed: a wait whose explanation mentions a time must not
 * mint a new row every tick, and two evaluations of the same facts must
 * produce the same digest (that is what makes the dedup and the trailer
 * reproducible).
 */
export function gateRowDigest(fields: {
  gate: GateId;
  proposalId: string;
  repo: string;
  headSha: string | null;
  verdict: GateVerdict;
  code: string;
  inputs: Record<string, unknown>;
}): string {
  return sha256(`${GATE_ROW_DOMAIN}${canonicalizeDaemonActivationValue({
    gate: fields.gate,
    proposalId: fields.proposalId,
    repo: fields.repo.toLowerCase(),
    headSha: fields.headSha,
    verdict: fields.verdict,
    code: fields.code,
    inputs: fields.inputs,
  })}`);
}

export function buildGateResult(input: {
  gate: GateId;
  proposalId: string;
  repo: string;
  headSha: string | null;
  evaluation: GateEvaluation;
  nowMs: number;
}): GateResult {
  const { evaluation: e } = input;
  return {
    v: 1,
    gate: input.gate,
    proposalId: input.proposalId,
    repo: input.repo,
    headSha: input.headSha,
    verdict: e.verdict,
    code: e.code,
    reason: e.reason,
    at: iso(input.nowMs),
    digest: gateRowDigest({
      gate: input.gate,
      proposalId: input.proposalId,
      repo: input.repo,
      headSha: input.headSha,
      verdict: e.verdict,
      code: e.code,
      inputs: e.inputs,
    }),
  };
}

/**
 * The `Ashlr-Gates` value: one digest over a landing's rows in GATE_ORDER.
 * Throws when a gate is missing or out of order — a trailer that silently
 * skipped a gate would attest to a check that never ran.
 */
export function combinedGatesDigest(rows: readonly Pick<GateResult, 'gate' | 'digest' | 'verdict'>[]): string {
  const byGate = new Map<GateId, Pick<GateResult, 'gate' | 'digest' | 'verdict'>>();
  for (const row of rows) byGate.set(row.gate, row);
  const ordered: string[] = [];
  for (const gate of GATE_ORDER) {
    const row = byGate.get(gate);
    if (!row) throw new Error(`gate ${gate} has no row`);
    if (row.verdict !== 'pass') throw new Error(`gate ${gate} did not pass (${row.verdict})`);
    ordered.push(`${gate}:${row.digest}`);
  }
  return sha256(`${GATES_DIGEST_DOMAIN}${ordered.join('\n')}`);
}

/** A digest over the rows a PR was opened under (G0–G6, in order, whatever passed). */
export function openGatesDigest(rows: readonly Pick<GateResult, 'gate' | 'digest'>[]): string {
  const ordered = GATE_ORDER.filter((gate) => gate !== 'G7')
    .map((gate) => `${gate}:${rows.find((row) => row.gate === gate)?.digest ?? 'none'}`);
  return sha256(`${GATES_DIGEST_DOMAIN}open\0${ordered.join('\n')}`);
}

export type GateLedgerAppend = (row: GateResult, grantId: string | null) => { ok: true } | { ok: false; reason: string };

/**
 * Append a gate row unless the SAME decision (same digest) is already
 * ledgered for this proposal — a proposal waiting on a judge for a day
 * writes one `wait` row, not one per tick, so the gate funnel counts
 * decisions, not polls. Mutates `state.gates` (the caller persists it).
 * A failed append returns ok:false: the caller must not act on the verdict.
 */
export function recordGateRow(
  state: Pick<FleetMergeStateV1, 'gates'>,
  row: GateResult,
  grantId: string | null,
  append: GateLedgerAppend,
): { ok: true; written: boolean } | { ok: false; reason: string } {
  const prior = state.gates[row.gate];
  if (prior && prior.digest === row.digest) return { ok: true, written: false };
  let result: { ok: true } | { ok: false; reason: string };
  try {
    result = append(row, grantId);
  } catch (error) {
    result = { ok: false, reason: `ledger append threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!result.ok) return result;
  state.gates[row.gate] = {
    digest: row.digest,
    verdict: row.verdict,
    code: row.code,
    headSha: row.headSha,
    at: row.at,
  };
  return { ok: true, written: true };
}

// ---------------------------------------------------------------------------
// Shared policy helpers
// ---------------------------------------------------------------------------

/** The effective repo policy for `repo` (nameWithOwner, case-insensitive), or null when not in the current stage. */
export function repoPolicyFor(policy: EffectivePolicy, repo: string): EffectiveRepoPolicy | null {
  const lower = repo.toLowerCase();
  return policy.repos.find((entry) => entry.nameWithOwner.toLowerCase() === lower) ?? null;
}

/** min() over merge risks, where an absent bound imposes nothing. */
function minRisk(...risks: (MergeRisk | RiskClass | null | undefined)[]): MergeRisk {
  let best: MergeRisk = 'medium';
  for (const risk of risks) {
    if (!risk) continue;
    if (risk === 'high') continue; // `high` as a cap bound is looser than the ceiling; it never widens anything.
    if (MERGE_RISK_RANK[risk] < MERGE_RISK_RANK[best]) best = risk;
  }
  return best;
}

function minPositive(...values: (number | null | undefined)[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (value < best) best = value;
  }
  return Number.isFinite(best) ? Math.max(0, Math.floor(best)) : 0;
}

/** The daily merge cap for a repo: min(stage/grant cap, compiled ceiling, local-enforcement ceiling). */
export function dailyMergeCap(repoPolicy: EffectiveRepoPolicy): number {
  return minPositive(
    repoPolicy.maxMergesPerDay,
    STANDING_GRANT_CEILINGS.maxMergesPerRepoPerDay,
    repoPolicy.enforcement === 'local' ? STANDING_GRANT_CEILINGS.localEnforcement.maxMergesPerDay : null,
  );
}

/** Why a merge that passed every gate is withheld, or null when this repo may merge now. */
export function mergeWithheldBecause(
  policy: EffectivePolicy,
  repoPolicy: EffectiveRepoPolicy,
): WouldMergeRecord['withheldBecause'] | null {
  if (policy.switch !== 'autonomous') return 'switch-propose';
  if (repoPolicy.stage !== 'merge') return 'stage-propose';
  if (dailyMergeCap(repoPolicy) === 0) return 'shadow';
  return null;
}

// ---------------------------------------------------------------------------
// G0 — authority
// ---------------------------------------------------------------------------

export interface G0Input {
  /** `revert`: a post-merge-watch revert (U4). Holds and the daily cap do not apply; Stop still does. */
  purpose: 'change' | 'revert';
  policy: EffectivePolicy | null;
  /** nameWithOwner. */
  repo: string;
  killOn: boolean;
  /** Active holds; null = the hold store could not be read (fail closed). */
  holds: readonly RepoHold[] | null;
  /** ISO times of this repo's fleet merges in the last 24 h; null = unknown. */
  mergeTimes24h: readonly string[] | null;
  /** Judge lanes with a seat that has headroom right now; null = not evaluated (reverts skip G6). */
  judgeLanes: readonly FleetEngine[] | null;
  /** When the earliest excluded judge seat reopens (SeatRouter); null = unknown. */
  judgeNextEligibleAt?: string | null;
  nowMs: number;
}

export function evaluateG0(input: G0Input): GateEvaluation {
  const base: Record<string, unknown> = { purpose: input.purpose };
  if (input.killOn) {
    return evaluation('wait', 'kill-on', 'Stop is on (~/.ashlr/KILL); nothing merges until it is cleared', base);
  }
  const policy = input.policy;
  if (!policy) {
    return evaluation(
      'wait',
      'no-standing-authority',
      'no standing grant is in force (none installed, expired, revoked, paused, switch off, or the ledger is broken)',
      base,
    );
  }
  const authority = {
    ...base,
    grantId: policy.grantId,
    grantSeq: policy.grantSeq,
    stageId: policy.rollout.stageId,
    switch: policy.switch,
  };
  const repoPolicy = repoPolicyFor(policy, input.repo);
  if (input.purpose === 'revert') {
    // A revert restores Mason's code after a fleet merge went red; U4 sets the
    // quarantine BEFORE reverting, so holds must not block it. Stop and a
    // missing grant still do (checked above).
    return evaluation('pass', 'authorized-revert', `revert authorized under grant ${policy.grantId}`, {
      ...authority,
      repoInStage: repoPolicy !== null,
    });
  }
  if (!repoPolicy) {
    return evaluation(
      'wait',
      'repo-not-in-stage',
      `${input.repo} is not in rollout stage "${policy.rollout.stageId}"; it waits until a stage includes it`,
      authority,
    );
  }
  const scoped = { ...authority, repoStage: repoPolicy.stage, enforcement: repoPolicy.enforcement };
  if (input.holds === null) {
    return evaluation('wait', 'holds-unreadable', 'the repo hold store could not be read, so the repo is treated as held', scoped);
  }
  const repoLower = input.repo.toLowerCase();
  const holds = input.holds.filter((hold) => hold.repo.toLowerCase() === repoLower &&
    (hold.until === null || Date.parse(hold.until) > input.nowMs));
  if (holds.length > 0) {
    const kinds = [...new Set(holds.map((hold) => hold.kind))].sort();
    const until = holds.some((hold) => hold.until === null)
      ? null
      : holds.map((hold) => hold.until!).sort().at(-1) ?? null;
    return evaluation(
      'wait',
      `hold-${kinds[0]}`,
      `${input.repo} is on hold (${kinds.join(', ')}): ${holds[0]!.reason}${until ? ` — until ${until}` : ''}`,
      { ...scoped, holds: kinds },
      until,
    );
  }
  const withheld = mergeWithheldBecause(policy, repoPolicy);
  if (withheld === null) {
    const cap = dailyMergeCap(repoPolicy);
    if (input.mergeTimes24h === null) {
      return evaluation('wait', 'daily-cap-unknown', 'today\'s merge count for this repo could not be read from the ledger', scoped);
    }
    const recent = input.mergeTimes24h
      .map((at) => Date.parse(at))
      .filter((ms) => Number.isFinite(ms) && ms > input.nowMs - DAILY_CAP_WINDOW_MS)
      .sort((a, b) => a - b);
    if (recent.length >= cap) {
      const reopens = recent[recent.length - cap];
      const next = reopens !== undefined ? iso(reopens + DAILY_CAP_WINDOW_MS) : null;
      return evaluation(
        'wait',
        'daily-cap',
        `${input.repo} already has ${recent.length} fleet merge(s) in the last 24 h (cap ${cap})`,
        { ...scoped, cap, capReached: true },
        next,
      );
    }
  }
  if (input.judgeLanes !== null && input.judgeLanes.length === 0) {
    return evaluation(
      'wait',
      'no-judge-seat',
      `no eligible judge seat has headroom right now${input.judgeNextEligibleAt ? `; the earliest reopens ${input.judgeNextEligibleAt}` : ''}`,
      { ...scoped, judgeLanes: [] },
      input.judgeNextEligibleAt ?? null,
    );
  }
  return evaluation(
    'pass',
    withheld === null ? 'authorized-merge' : 'authorized-propose',
    withheld === null
      ? `grant ${policy.grantId} (stage ${policy.rollout.stageId}) allows ${input.repo} to merge`
      : `grant ${policy.grantId} allows PRs only here (${withheld})`,
    { ...scoped, withheld, judgeLanes: input.judgeLanes === null ? null : [...input.judgeLanes].sort() },
  );
}

// ---------------------------------------------------------------------------
// G1 — protected paths
// ---------------------------------------------------------------------------

export interface G1Input {
  /** Paths the diff touches (both sides of renames); null = the diff could not be parsed. */
  paths: readonly string[] | null;
  selfRepo: boolean;
  testsImportingTier1?: ReadonlySet<string>;
}

export function evaluateG1(input: G1Input): GateEvaluation & { hits: ProtectedPathHit[] } {
  if (input.paths === null) {
    return { ...evaluation('refuse', 'diff-unparseable', 'the diff could not be parsed, so its paths cannot be checked', {}), hits: [] };
  }
  const hits = protectedPathHits(input.paths, {
    selfRepo: input.selfRepo,
    ...(input.testsImportingTier1 ? { testsImportingTier1: input.testsImportingTier1 } : {}),
  });
  const inputs = {
    selfRepo: input.selfRepo,
    paths: [...input.paths].map((p) => p.toLowerCase()).sort(),
    hits: hits.map((hit) => `${hit.ruleId}:${hit.path.toLowerCase()}`).sort(),
  };
  if (hits.length > 0) {
    const listed = hits.slice(0, 3).map((hit) => `${hit.path} (${hit.ruleId})`).join(', ');
    return {
      ...evaluation(
        'owner-lane',
        `protected-${hits[0]!.ruleId}`,
        `touches protected path${hits.length > 1 ? 's' : ''} ${listed}${hits.length > 3 ? ` and ${hits.length - 3} more` : ''}: ${hits[0]!.why}`,
        inputs,
      ),
      hits,
    };
  }
  return { ...evaluation('pass', 'no-protected-paths', 'no protected path touched', inputs), hits };
}

// ---------------------------------------------------------------------------
// G1b — test tampering
// ---------------------------------------------------------------------------

export function evaluateG1b(diff: string): GateEvaluation {
  const scan = detectTestTampering(diff);
  if (scan.parseError) {
    return evaluation('refuse', 'tamper-unreadable', `test tampering could not be ruled out: ${scan.parseError}`, {});
  }
  if (scan.findings.length > 0) {
    const kinds = [...new Set(scan.findings.map((finding) => finding.kind))].sort();
    return evaluation(
      'refuse',
      'test-tamper',
      `test tampering makes this change high risk, which is never auto-merged: ${scan.findings.slice(0, 3).map((f) => f.detail).join('; ')}`,
      { findings: scan.findings.map((f) => `${f.kind}:${f.path.toLowerCase()}`).sort(), kinds },
    );
  }
  return evaluation('pass', 'no-tamper', 'no test tampering', {});
}

// ---------------------------------------------------------------------------
// G2 — risk and scope
// ---------------------------------------------------------------------------

export interface G2Input {
  partial: boolean;
  provenance: { ok: boolean; reason?: string };
  risk: RiskClass;
  /** null = the diff could not be measured. */
  scope: { files: number; changedLines: number } | null;
  repoPolicy: EffectiveRepoPolicy;
  mergePolicy: EffectiveMergePolicy;
  /** EXPLICIT config values only (absent keys impose nothing); config can only tighten. */
  config: { maxRisk?: RiskClass; maxFiles?: number; maxLines?: number };
  /** The producer is a local model (or its family is unknown — the stricter reading). */
  producerLocal: boolean;
}

export interface G2Caps {
  maxRisk: MergeRisk;
  maxFiles: number;
  maxLines: number;
}

/** min(grant stage, config, compiled ceilings, local-authored, local-enforcement). */
export function effectiveScopeCaps(input: Omit<G2Input, 'partial' | 'provenance' | 'risk' | 'scope'>): G2Caps {
  const localAuthor = input.producerLocal ? STANDING_GRANT_CEILINGS.localAuthored : null;
  const localEnforcement = input.repoPolicy.enforcement === 'local' ? STANDING_GRANT_CEILINGS.localEnforcement : null;
  return {
    maxRisk: minRisk(
      input.repoPolicy.maxRisk,
      STANDING_GRANT_CEILINGS.maxRisk,
      input.config.maxRisk,
      localAuthor ? input.mergePolicy.localAuthored.maxRisk : null,
      localAuthor?.maxRisk,
      localEnforcement?.maxRisk,
    ),
    maxFiles: minPositive(
      input.repoPolicy.maxFiles,
      input.mergePolicy.maxFiles,
      STANDING_GRANT_CEILINGS.maxFiles,
      input.config.maxFiles,
      localAuthor ? input.mergePolicy.localAuthored.maxFiles : null,
      localAuthor?.maxFiles,
      localEnforcement?.maxFiles,
    ),
    maxLines: minPositive(
      input.repoPolicy.maxLines,
      input.mergePolicy.maxLines,
      STANDING_GRANT_CEILINGS.maxLines,
      input.config.maxLines,
      localAuthor ? input.mergePolicy.localAuthored.maxLines : null,
      localAuthor?.maxLines,
      localEnforcement?.maxLines,
    ),
  };
}

export function evaluateG2(input: G2Input): GateEvaluation & { caps: G2Caps } {
  const caps = effectiveScopeCaps(input);
  const inputs = {
    risk: input.risk,
    files: input.scope?.files ?? null,
    lines: input.scope?.changedLines ?? null,
    caps,
    producerLocal: input.producerLocal,
    enforcement: input.repoPolicy.enforcement,
  };
  const out = (e: GateEvaluation): GateEvaluation & { caps: G2Caps } => ({ ...e, caps });
  if (input.partial) {
    return out(evaluation('refuse', 'partial-capture', 'a partial / timeout-captured proposal is review evidence, never mergeable', inputs));
  }
  if (!input.provenance.ok) {
    return out(evaluation(
      'refuse',
      'provenance-invalid',
      `the producer identity is not authenticated (${input.provenance.reason ?? 'signature check failed'}); risk caps and judge family depend on it`,
      inputs,
    ));
  }
  if (!input.scope) {
    return out(evaluation('refuse', 'diff-unmeasurable', 'the diff could not be measured', inputs));
  }
  // Which bound bites decides the code. The local-author / local-enforcement
  // ceilings are compiled in and never rise, so their codes mean "never
  // mergeable"; the grant / stage / config caps can rise as the rollout
  // advances, so their codes mean "not yet" — and callers treat them so.
  const growable = effectiveScopeCaps({ ...input, producerLocal: false, repoPolicy: { ...input.repoPolicy, enforcement: 'server' } });
  const permanentCode = input.producerLocal ? 'local-author-cap' : 'local-enforcement-cap';
  if (input.risk === 'high') {
    return out(evaluation('refuse', 'risk-high', 'high risk is above every grant\'s ceiling and is never auto-merged', inputs));
  }
  if (MERGE_RISK_RANK[input.risk] > MERGE_RISK_RANK[caps.maxRisk]) {
    const grantBinds = MERGE_RISK_RANK[input.risk] > MERGE_RISK_RANK[growable.maxRisk];
    return out(evaluation(
      'refuse',
      grantBinds ? 'risk-over-cap' : permanentCode,
      `risk "${input.risk}" exceeds the cap "${caps.maxRisk}"${input.producerLocal ? ' (work a local model authored merges only at low risk)' : ''}`,
      inputs,
    ));
  }
  if (input.scope.files > caps.maxFiles) {
    return out(evaluation(
      'refuse',
      input.scope.files > growable.maxFiles ? 'files-over-cap' : permanentCode,
      `the diff touches ${input.scope.files} files (cap ${caps.maxFiles})`,
      inputs,
    ));
  }
  if (input.scope.changedLines > caps.maxLines) {
    return out(evaluation(
      'refuse',
      input.scope.changedLines > growable.maxLines ? 'lines-over-cap' : permanentCode,
      `the diff changes ${input.scope.changedLines} lines (cap ${caps.maxLines})`,
      inputs,
    ));
  }
  return out(evaluation(
    'pass',
    'within-caps',
    `risk ${input.risk}, ${input.scope.files} file(s), ${input.scope.changedLines} line(s) within ${caps.maxRisk} / ${caps.maxFiles} / ${caps.maxLines}`,
    inputs,
  ));
}

// ---------------------------------------------------------------------------
// G3 — verification
// ---------------------------------------------------------------------------

export interface G3Input {
  /** null = verification could not be run at all this pass. */
  verify: {
    ok: boolean;
    detail: string;
    failureCategory?: string;
    baseBranch?: string;
    baseHead?: string;
    /** Commands that ran (0 ⇒ nothing verified — never a pass under a standing grant). */
    commandKinds: readonly string[];
  } | null;
  /** Self-eval parity for ashlr-hub; null when not the self repo. */
  parity: { ok: boolean; reason: string } | null;
  /** The exact tree the PR head will carry; null = not computed. */
  tree: { ok: true; treeSha: string } | { ok: false; reason: string; conflict: boolean } | null;
  diffHash: string;
  /**
   * What git says the tree changes (path, new mode; null = deleted), and the
   * paths the diff parser reported to G1. Absent ⇒ not checked (reverts).
   */
  treeChanges?: { changes: readonly { path: string; mode: string | null }[] | string; parsedPaths: readonly string[]; selfRepo: boolean };
}

const INFRA_FAILURES = new Set(['tool', 'infra', 'timeout', 'cancelled', 'invalid-command']);

export function evaluateG3(input: G3Input): GateEvaluation {
  const verify = input.verify;
  if (!verify) return evaluation('wait', 'verify-unavailable', 'verification could not run this pass', { diffHash: input.diffHash });
  const inputs: Record<string, unknown> = {
    diffHash: input.diffHash,
    baseBranch: verify.baseBranch ?? null,
    baseHead: verify.baseHead ?? null,
    commands: [...verify.commandKinds],
  };
  if (!verify.ok) {
    if (verify.failureCategory && INFRA_FAILURES.has(verify.failureCategory)) {
      return evaluation('wait', 'verify-infra', `the verifier could not complete (${verify.failureCategory}): ${verify.detail}`, inputs);
    }
    return evaluation('refuse', 'verify-failed', `verification failed: ${verify.detail}`, inputs);
  }
  if (verify.commandKinds.length === 0) {
    // allowWithoutVerification is a LOOSENING; under a standing grant config
    // may only tighten, so "nothing to run" is a refusal, not a pass.
    return evaluation('refuse', 'no-verification-commands', 'no verify command ran; a standing grant never merges unverified work', inputs);
  }
  if (!verify.baseBranch || !verify.baseHead) {
    return evaluation('refuse', 'verify-unbound', 'verification did not record the base it ran on', inputs);
  }
  if (input.parity && !input.parity.ok) {
    return evaluation('refuse', 'self-eval-parity', `ashlr-hub self-eval parity failed: ${input.parity.reason}`, inputs);
  }
  if (!input.tree) return evaluation('wait', 'tree-unavailable', 'the verified tree could not be computed this pass', inputs);
  if (!input.tree.ok) {
    return input.tree.conflict
      ? evaluation('refuse', 'diff-does-not-apply', `the diff does not apply to ${verify.baseHead.slice(0, 12)}: ${input.tree.reason}`, inputs)
      : evaluation('wait', 'tree-unavailable', `the verified tree could not be computed: ${input.tree.reason}`, inputs);
  }
  if (input.treeChanges) {
    const { changes, parsedPaths, selfRepo } = input.treeChanges;
    if (typeof changes === 'string') {
      return evaluation('wait', 'tree-unavailable', `the verified tree's changes could not be read: ${changes}`, inputs);
    }
    // G1 judged the paths the diff parser reported; git's own view of the
    // tree is what lands. They must agree, and the tree may add no symlink or
    // submodule (a link can point anywhere on Mason's disk once checked out).
    const parsed = new Set(parsedPaths.map((p) => p.toLowerCase()));
    const unexpected = changes.filter((change) => !parsed.has(change.path.toLowerCase()));
    if (unexpected.length > 0) {
      return evaluation('refuse', 'tree-paths-unexpected', `the built tree changes paths the diff did not declare: ${unexpected.slice(0, 3).map((c) => c.path).join(', ')}`, inputs);
    }
    const links = changes.filter((change) => change.mode === '120000' || change.mode === '160000');
    if (links.length > 0) {
      return evaluation('refuse', 'link-or-submodule', `the change adds a symlink or submodule (${links.slice(0, 3).map((c) => c.path).join(', ')}); never auto-merged`, inputs);
    }
    const hits = protectedPathHits(changes.map((change) => change.path), { selfRepo });
    if (hits.length > 0) {
      return evaluation('refuse', 'tree-protected-path', `the built tree touches protected ${hits[0]!.path} that G1 did not see`, inputs);
    }
  }
  return evaluation(
    'pass',
    'verified',
    `${verify.commandKinds.length} verify command(s) green on ${verify.baseBranch}@${verify.baseHead.slice(0, 12)}${input.parity ? '; self-eval parity green' : ''}`,
    { ...inputs, treeSha: input.tree.treeSha, parity: input.parity ? input.parity.ok : null },
  );
}

// ---------------------------------------------------------------------------
// G4 — claims
// ---------------------------------------------------------------------------

export interface G4Input {
  /** turnIntegrity(claim, changedFileCount); null = the check itself failed. */
  integrity: string | null;
  claim: string | null;
  classifier: 'heuristic' | 'model';
  describe?: string;
  error?: string;
}

export function evaluateG4(input: G4Input): GateEvaluation {
  const inputs = { integrity: input.integrity, claim: input.claim, classifier: input.classifier };
  if (input.integrity === null) {
    return evaluation('refuse', 'claim-check-failed', `claim-vs-diff could not be checked: ${input.error ?? 'unknown error'}`, inputs);
  }
  if (input.integrity === 'unsupported-claim' || input.integrity === 'silent-change') {
    return evaluation('refuse', 'claim-mismatch', input.describe ?? `the producer's report does not match its diff (${input.integrity})`, inputs);
  }
  return evaluation('pass', 'claims-consistent', 'the producer\'s report matches what its diff did', inputs);
}

// ---------------------------------------------------------------------------
// G5 — blast radius (+ the flag-gated red team / spec contract)
// ---------------------------------------------------------------------------

export interface G5Check {
  name: 'blast-radius' | 'red-team' | 'spec-contract';
  outcome: 'ok' | 'blocked' | 'error';
  detail: string;
}

export function evaluateG5(checks: readonly G5Check[]): GateEvaluation {
  const inputs = { checks: checks.map((check) => `${check.name}:${check.outcome}`).sort() };
  const blocked = checks.find((check) => check.outcome !== 'ok');
  if (blocked) {
    return evaluation(
      'refuse',
      blocked.outcome === 'error' ? `${blocked.name}-error` : blocked.name,
      `${blocked.name} ${blocked.outcome === 'error' ? 'failed closed' : 'blocked the change'}: ${blocked.detail}`,
      inputs,
    );
  }
  return evaluation(
    'pass',
    checks.length === 0 ? 'no-blast-checks-enabled' : 'blast-radius-ok',
    checks.length === 0 ? 'no blast-radius check is enabled (unchanged from master)' : `${checks.map((c) => c.name).join(', ')} passed`,
    inputs,
  );
}

// ---------------------------------------------------------------------------
// G6 — judge
// ---------------------------------------------------------------------------

/**
 * Judge lanes this proposal may use now: the family preference's FIRST lane
 * (local → grok-cli, Grok → claude-cli …) until it has waited 24 h for a
 * judge, then every qualifying lane. Never a local or same-family lane —
 * judgeLanePreference (U7) lists none — and never anything for an unknown
 * producer family.
 */
export function allowedJudgeLanes(
  producerFamily: ReviewModelFamily,
  waitSinceMs: number | null,
  nowMs: number,
): readonly FleetEngine[] {
  const lanes = judgeLanePreference(producerFamily);
  if (lanes.length === 0) return [];
  const widened = waitSinceMs !== null && nowMs - waitSinceMs >= JUDGE_PREFERENCE_WAIT_MS;
  return widened ? lanes : lanes.slice(0, 1);
}

export interface G6Input {
  proposalId: string;
  producerModel: string | undefined;
  diff: string;
  /** Decisions for this proposal; null = the decisions ledger is degraded (fail closed). */
  decisions: readonly DecisionEntry[] | null;
  nowMs: number;
}

export interface G6Evaluation extends GateEvaluation {
  judgeId: JudgeId | null;
  /** The latest verdict is missing / stale / from an ineligible judge — the pass may call a judge. */
  needsJudge: boolean;
}

function g6(e: GateEvaluation, judgeId: JudgeId | null, needsJudge: boolean): G6Evaluation {
  return { ...e, judgeId, needsJudge };
}

export function evaluateG6(input: G6Input): G6Evaluation {
  const producerFamily = producerModelFamily(input.producerModel);
  const base = { producerFamily };
  if (input.decisions === null) {
    return g6(evaluation('wait', 'decisions-degraded', 'the decisions ledger is degraded; no judge verdict can be trusted', base), null, false);
  }
  const judged = input.decisions
    .filter((decision) => decision.action === 'judged')
    .map((decision, index) => ({ decision, index, ms: Date.parse(decision.ts) }))
    .sort((a, b) => {
      const av = Number.isFinite(a.ms); const bv = Number.isFinite(b.ms);
      if (av && bv && a.ms !== b.ms) return b.ms - a.ms;
      if (av !== bv) return av ? -1 : 1;
      return b.index - a.index;
    });
  const latest = judged[0]?.decision;
  if (!latest) {
    return g6(evaluation('wait', 'awaiting-judge', 'no judge has reviewed this proposal yet', base), null, true);
  }
  const judgeEngine = latest.engine ?? latest.model ?? '';
  const judgeFamily = reviewModelFamily(judgeEngine);
  const inputs = { ...base, judge: judgeEngine, judgeFamily, verdict: latest.verdict ?? null, at: latest.ts };
  if (latest.verdict !== 'ship') {
    const failure = latest.detail === 'judge-network-failure' || latest.detail === 'judge-parse-failure';
    if (failure) {
      return g6(evaluation('wait', 'judge-failed', `the last judge call failed (${latest.detail}); it will be retried`, inputs), null, true);
    }
    const eligibility = evaluateJudgeEligibility(input.producerModel, judgeEngine);
    if (!eligibility.eligible) {
      return g6(evaluation('wait', 'judge-ineligible', `${eligibility.reason}; an eligible judge must review it`, inputs), null, true);
    }
    return g6(evaluation(
      'refuse',
      'judge-rejected',
      `judge ${judgeEngine} returned "${latest.verdict ?? 'unknown'}" — a newer non-ship verdict overrides any older ship`,
      inputs,
    ), null, false);
  }
  const eligibility = evaluateJudgeEligibility(input.producerModel, judgeEngine);
  if (!eligibility.eligible) {
    // A ship from a local or same-family judge is never accepted and never
    // "downgraded into" a pass: the proposal waits for an eligible judge.
    return g6(evaluation('wait', 'judge-ineligible', eligibility.reason, inputs), null, true);
  }
  if (latest.detail !== 'would-merge' || latest.judgeAttestationIntent !== 'would-merge') {
    return g6(evaluation('refuse', 'judge-no-merge-intent', `judge ${judgeEngine} shipped without merge intent`, inputs), null, false);
  }
  const issuedAt = latest.judgeAttestationIssuedAt;
  const issuedMs = typeof issuedAt === 'string' ? Date.parse(issuedAt) : Number.NaN;
  if (typeof issuedAt !== 'string' || issuedAt !== latest.ts || !Number.isFinite(issuedMs) || issuedMs > input.nowMs + 60_000) {
    return g6(evaluation('wait', 'judge-attestation-invalid', 'the ship verdict carries no well-formed attestation time; re-judging', inputs), null, true);
  }
  if (input.nowMs - issuedMs > JUDGE_VERDICT_MAX_AGE_MS) {
    return g6(evaluation('wait', 'judge-stale', 'the ship verdict is older than 24 h; re-judging', inputs), null, true);
  }
  const attestation = verifyJudgeAttestation(latest.judgeAttestation, {
    proposalId: input.proposalId,
    judgeEngine,
    verdict: 'ship',
    diffHash: hashDiff(input.diff),
    issuedAt,
    mergeIntent: 'would-merge',
  });
  if (!attestation.ok) {
    return g6(evaluation(
      'wait',
      'judge-attestation-invalid',
      `the ship verdict's HMAC attestation does not verify for this exact diff (${attestation.reason ?? 'mismatch'}); re-judging`,
      inputs,
    ), null, true);
  }
  const judgeId = judgeEngine as JudgeId;
  return g6(evaluation(
    'pass',
    'judge-ship',
    `independent ${judgeFamily} judge ${judgeEngine} shipped it (attested ${issuedAt}); ${eligibility.reason}`,
    { ...inputs, attestation: sha256(latest.judgeAttestation ?? '') },
  ), judgeId, false);
}

// ---------------------------------------------------------------------------
// G7 — GitHub required checks
// ---------------------------------------------------------------------------

export interface RequiredCheck {
  context: string;
  /** GitHub App id the check must come from; null = any source. */
  appId: string | null;
}

export interface CheckRunObservation {
  id: number;
  name: string;
  appId: string | null;
  status: string;
  conclusion: string | null;
}

export interface StatusObservation {
  context: string;
  state: string;
}

export interface G7ChecksInput {
  enforcement: RepoEnforcement;
  /** Required contexts read from the server (rulesets + classic protection); null = unreadable. */
  required: readonly RequiredCheck[] | null;
  runs: readonly CheckRunObservation[] | null;
  statuses: readonly StatusObservation[] | null;
  /** When this head started waiting for checks (for the 24 h timeout). */
  pendingSinceMs: number;
  nowMs: number;
}

const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

type CheckState = 'green' | 'red' | 'pending';

function runState(run: CheckRunObservation): CheckState {
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion && OK_CONCLUSIONS.has(run.conclusion)) return 'green';
  if (run.conclusion && RED_CONCLUSIONS.has(run.conclusion)) return 'red';
  // cancelled / stale: superseded, not proof of anything — keep waiting.
  return 'pending';
}

function statusState(status: StatusObservation): CheckState {
  if (status.state === 'success') return 'green';
  if (status.state === 'failure' || status.state === 'error') return 'red';
  return 'pending';
}

export function evaluateG7Checks(input: G7ChecksInput): GateEvaluation & { state: 'green' | 'red' | 'pending' | 'none' } {
  const out = (e: GateEvaluation, state: 'green' | 'red' | 'pending' | 'none') => ({ ...e, state });
  if (input.required === null || input.runs === null || input.statuses === null) {
    return out(evaluation('wait', 'checks-unreadable', 'required checks could not be read from GitHub', {}), 'pending');
  }
  const latestRunByKey = new Map<string, CheckRunObservation>();
  for (const run of input.runs) {
    const key = `${run.name}\0${run.appId ?? ''}`;
    const prior = latestRunByKey.get(key);
    if (!prior || run.id > prior.id) latestRunByKey.set(key, run);
  }
  const latestRuns = [...latestRunByKey.values()];
  const states: { name: string; state: CheckState }[] = [];
  if (input.enforcement === 'server') {
    if (input.required.length === 0) {
      return out(evaluation(
        'owner-lane',
        'no-required-checks',
        'the default branch has no required checks, so GitHub cannot prove this PR green; it goes to the owner lane',
        { enforcement: 'server', required: [] },
      ), 'none');
    }
    for (const required of input.required) {
      const runs = latestRuns.filter((run) => run.name === required.context &&
        (required.appId === null || run.appId === required.appId));
      const statuses = required.appId === null ? input.statuses.filter((s) => s.context === required.context) : [];
      const observed = [...runs.map(runState), ...statuses.map(statusState)];
      const state: CheckState = observed.length === 0
        ? 'pending'
        : observed.includes('red') ? 'red' : observed.every((s) => s === 'green') ? 'green' : 'pending';
      states.push({ name: required.context, state });
    }
  } else {
    // Local enforcement: GitHub protects nothing here, so every check that
    // ran must be green and at least one must exist ("Actions green").
    for (const run of latestRuns) states.push({ name: run.name, state: runState(run) });
    for (const status of input.statuses) states.push({ name: status.context, state: statusState(status) });
    if (states.length === 0) {
      return out(evaluation(
        'owner-lane',
        'no-checks',
        'this local-enforcement repo reported no CI on the PR head; with nothing to prove it green it goes to the owner lane',
        { enforcement: 'local', required: [] },
      ), 'none');
    }
  }
  const inputs = {
    enforcement: input.enforcement,
    required: input.required.map((r) => `${r.context}@${r.appId ?? '*'}`).sort(),
    states: states.map((s) => `${s.name}:${s.state}`).sort(),
  };
  const red = states.filter((s) => s.state === 'red');
  if (red.length > 0) {
    return out(evaluation('refuse', 'required-check-failed', `check(s) failed on the PR head: ${red.map((s) => s.name).slice(0, 5).join(', ')}`, inputs), 'red');
  }
  const pending = states.filter((s) => s.state === 'pending');
  if (pending.length > 0) {
    if (input.nowMs - input.pendingSinceMs > CHECKS_MAX_PENDING_MS) {
      return out(evaluation('refuse', 'checks-timeout', `check(s) still pending after 24 h: ${pending.map((s) => s.name).slice(0, 5).join(', ')}`, inputs), 'red');
    }
    return out(evaluation('wait', 'checks-pending', `waiting on ${pending.map((s) => s.name).slice(0, 5).join(', ')}`, inputs), 'pending');
  }
  return out(evaluation('pass', 'checks-green', `every ${input.enforcement === 'server' ? 'required ' : ''}check is green on the head SHA`, inputs), 'green');
}

/** The one G7 pass row a landing is attested with: bound to the exact head, tree, base and checks. */
export function g7MergeEvaluation(input: {
  headSha: string;
  baseSha: string;
  treeSha: string;
  checks: GateEvaluation;
  protectionDigest: string;
  /**
   * Whether the base branch requires PR heads to be up to date. WHY it is
   * recorded: without it, a base that moves between our final re-check and
   * GitHub's squash is merged untested against the new base (the SHA pin only
   * pins the HEAD). It goes into the row's reason (the ledger row stores the
   * reason verbatim; the inputs only as a digest) so that residual race is
   * visible per landing.
   */
  strictUpToDate?: boolean | null;
}): GateEvaluation {
  const upToDate = input.strictUpToDate === true
    ? 'GitHub requires the head to be up to date with the base'
    : input.strictUpToDate === false
      ? 'GitHub does NOT require the head to be up to date with the base'
      : 'up-to-date policy unknown';
  return evaluation(
    'pass',
    'merge-ready',
    `head ${input.headSha.slice(0, 12)} (tree ${input.treeSha.slice(0, 12)}) on base ${input.baseSha.slice(0, 12)} is green and pinned; ${upToDate}`,
    {
      headSha: input.headSha,
      baseSha: input.baseSha,
      treeSha: input.treeSha,
      checks: input.checks.inputs,
      protection: input.protectionDigest,
      strictUpToDate: input.strictUpToDate ?? null,
    },
  );
}
