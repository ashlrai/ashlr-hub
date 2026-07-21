/**
 * skill-library.ts — M243: positive skill-library write-back.
 *
 * Closes the learning loop on the SUCCESS path: when the authoritative inbox
 * proposal is applied and its persisted verification/evidence remains bound to
 * the current diff, extract a reusable workflow and persist both the legacy
 * genome note and a structured verified SkillCard.
 *
 * Mirrors M235 (self-improve.ts) structurally — same safety invariants, same
 * fire-and-forget contract, complementary polarity (success vs. rejection).
 *
 * SAFETY INVARIANTS:
 *  - WRITE TARGET: genome hub + skill-card ledger + decisions ledger ONLY.
 *    Never touches merge.ts gate logic, sandbox confinement, scope-cap, M54,
 *    or any policy file.
 *  - FIRE-AND-FORGET: learnFromApplied() never throws, never awaits
 *    anything on the critical path. All I/O is wrapped in try/catch.
 *  - GATED: every code path checks cfg.foundry?.skillLibrary !== false
 *    (default ON). When the flag is explicitly false the function returns
 *    immediately — byte-identical to having no call at all.
 *  - VERIFIED-ONLY: caller state is never authoritative. The live proposal and
 *    realized-merge witness and autonomy evidence pack must prove applied
 *    status, current verification, passing gates/policy, matching hashes, and
 *    a known producer tier.
 *  - NO SKILL CHAINS: proposals whose authoritative route/evidence snapshot
 *    contains selectedSkillIds are not distilled into another skill.
 *  - ADDITIVE: the genome entry is informational grounding for future runs.
 *    It is NOT an execution directive; it does not alter the merge gate,
 *    the judge, or any safety policy.
 *  - CURATOR CAP: genome entries written by this module carry the tag
 *    'm243:skill'. curateSkills() trims entries older than STALE_DAYS and
 *    caps total injected chars at SKILL_INJECT_CAP so the genome never
 *    injects stale noise.
 *  - TELEMETRY: a usage counter is appended to the decisions ledger under
 *    action 'skill-library:written' for observability (no PII, no secrets).
 *  - AWM/Voyager principle: the captured workflow is an ABSTRACTED recipe
 *    (task-class + plan→do→verify pattern + engine), NOT the raw diff verbatim.
 */

import { appendHubEntry } from '../genome/store.js';
import {
  readAutonomyEvidencePack,
  verifyAutonomyEvidencePackV3,
  type AutonomyEvidencePack,
  type SignedAutonomyEvidencePackV3,
} from '../autonomy/evidence-pack.js';
import { hashDiff, verifyProvenance } from '../foundry/provenance.js';
import { loadProposal } from '../inbox/store.js';
import { hasRealizedMergeEvidence } from '../inbox/realized-merge.js';
import { scrubSecrets } from '../util/scrub.js';
import { recordDecision } from './decisions-ledger.js';
import {
  POST_MERGE_CREDIT_RELEASE_LABEL,
  hasReleasedPostMergeCredit,
} from './post-merge-credit.js';
import { attestSkillCard } from './skill-attestation.js';
import { recordSkillCard, sanitizeSkillCard } from './skill-records.js';
import type { AshlrConfig, GenomeEntry, Proposal, SkillCard } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on total characters injected from skill entries per run. */
export const SKILL_INJECT_CAP = 800;

/** Tag prefix for all genome entries written by this module. */
const TAG = 'm243:skill';

/** Exact genome/card marker for a released positive-credit skill. */
export const SKILL_CREDIT_RELEASE_TAG = 'credit:released-v1' as const;

const RAW_PAYLOAD_MARKER = /\bRAW_[A-Z0-9_]*(?:PROMPT|DIFF|STDOUT|STDERR|ENV|FILE_CONTENTS?|ARGV|COMMAND_OUTPUT)[A-Z0-9_]*\b/g;
const DIFF_PAYLOAD_START = /(?:^|\n)(?:diff --git |--- [ab]\/|\+\+\+ [ab]\/|@@ )/m;

function boundedMetadataText(value: unknown, max: number, fallback = ''): string {
  try {
    if (typeof value !== 'string') return fallback;
    let text = scrubSecrets(value).replace(RAW_PAYLOAD_MARKER, '[REDACTED]');
    const diffStart = text.search(DIFF_PAYLOAD_START);
    if (diffStart >= 0) text = `${text.slice(0, diffStart)} [REDACTED]`;
    text = text.replace(/\s+/g, ' ').trim() || fallback;
    return text.length > max ? text.slice(0, max) : text;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Workflow distillation (pure, deterministic, no LLM)
// ---------------------------------------------------------------------------

/**
 * Derive a short reusable WORKFLOW recipe from a shipped proposal.
 *
 * AWM/Voyager principle: produce an ABSTRACTED workflow keyed by task
 * description (plan → do → verify pattern + which engine), NOT the raw diff
 * verbatim. This gives future agents positive grounding: "here is a proven
 * recipe for this class of task."
 *
 * Pure; never throws.
 */
export function distillWorkflow(proposal: Proposal): string {
  const safeTitle = boundedMetadataText(proposal.title, 80, '(untitled)');
  const safeSummary = boundedMetadataText(proposal.summary, 400);
  const engine = boundedMetadataText(proposal.engineModel ?? proposal.engineTier, 40, 'unknown');
  const repo = boundedMetadataText(proposal.repo, 60, '(no repo)');

  // Derive a task-class label from the proposal title heuristically.
  const taskClass = deriveTaskClass(safeTitle);

  const summaryPart = safeSummary
    ? `\n\nWhat was done: ${safeSummary}`
    : '';

  return (
    `Skill: proven workflow for "${safeTitle}"\n\n` +
    `Task class: ${taskClass}\n` +
    `Engine/model: ${engine}\n` +
    `Repo: ${repo}` +
    summaryPart +
    `\n\nPattern (plan→do→verify): this proposal was applied with current, ` +
    `diff-bound verification and allowed autonomy evidence. Future agents: if your task matches this pattern, ` +
    `this recipe is a proven baseline — adapt, don't just copy the diff.`
  );
}

interface VerifiedSkillInput {
  proposal: Proposal;
  evidence: SignedAutonomyEvidencePackV3;
  diffHash: string;
  commandKinds: string[];
}

function commandKindsFromVerification(proposal: Proposal): string[] {
  if (!Array.isArray(proposal.verifyResult?.ran)) return [];
  const kinds = new Set<string>();
  for (const command of proposal.verifyResult.ran) {
    if (
      !command ||
      !Array.isArray(command.cmd) ||
      !command.cmd.some((part) => typeof part === 'string' && part.trim() !== '')
    ) continue;
    const kind = boundedMetadataText(command.kind, 80);
    if (kind) kinds.add(kind);
  }
  return [...kinds].slice(0, 12);
}

function routeHasSkillSelection(route: Proposal['routeSnapshot']): boolean {
  return route?.selectedSkillIds !== undefined;
}

function evidenceGatesPassed(evidence: AutonomyEvidencePack): boolean {
  try {
    const required = [
      evidence.gates.authority,
      evidence.gates.provenance,
      evidence.gates.verification,
      evidence.gates.risk,
      evidence.gates.scope,
    ];
    if (!required.every((gate) => gate?.ok === true)) return false;
    return Object.values(evidence.gates).every((gate) => gate?.ok === true);
  } catch {
    return false;
  }
}

function hasMatchingVerifierAuthoritySnapshot(
  proposal: Proposal,
  evidence: SignedAutonomyEvidencePackV3,
): boolean {
  const verify = proposal.verifyResult;
  const snapshot = evidence.verification;
  const oidPattern = verify?.verifierAuthorityObjectFormat === 'sha1'
    ? /^[0-9a-f]{40}$/
    : verify?.verifierAuthorityObjectFormat === 'sha256'
      ? /^[0-9a-f]{64}$/
      : null;
  return Boolean(
    verify &&
    verify.verifierAuthoritySnapshotVersion === 1 &&
    snapshot.verifierAuthoritySnapshotVersion === 1 &&
    oidPattern &&
    typeof verify.baseTreeOid === 'string' && oidPattern.test(verify.baseTreeOid) &&
    typeof verify.candidateTreeOid === 'string' && oidPattern.test(verify.candidateTreeOid) &&
    typeof verify.authoritySnapshotDigest === 'string' && /^[0-9a-f]{64}$/.test(verify.authoritySnapshotDigest) &&
    snapshot.verifierAuthorityObjectFormat === verify.verifierAuthorityObjectFormat &&
    snapshot.baseTreeOid === verify.baseTreeOid &&
    snapshot.candidateTreeOid === verify.candidateTreeOid &&
    snapshot.authoritySnapshotDigest === verify.authoritySnapshotDigest
  );
}

/** Load and validate the authoritative state used for skill distillation. */
function verifiedSkillInput(proposalId: string): VerifiedSkillInput | null {
  try {
    const proposal = loadProposal(proposalId);
    if (!proposal || proposal.id !== proposalId || proposal.status !== 'applied' ||
      !hasRealizedMergeEvidence(proposal)) return null;
    if (!hasReleasedPostMergeCredit(proposal.labelBasis)) return null;
    if (typeof proposal.diff !== 'string' || proposal.diff.length === 0) return null;
    if (!verifyProvenance(proposal).ok) return null;

    const commandKinds = commandKindsFromVerification(proposal);
    const currentDiffHash = hashDiff(proposal.diff);
    if (
      proposal.verifyResult?.passed !== true ||
      commandKinds.length === 0 ||
      proposal.diffHash !== currentDiffHash ||
      proposal.verifyResult.diffHash !== currentDiffHash
    ) return null;

    const evidence = readAutonomyEvidencePack(proposalId);
    if (!evidence || evidence.version !== 3 || !verifyAutonomyEvidencePackV3(evidence).ok ||
      evidence.proposal.id !== proposalId) return null;
    if (!hasMatchingVerifierAuthoritySnapshot(proposal, evidence)) return null;
    if (
      evidence.proposal.repo !== proposal.repo ||
      evidence.proposal.createdAt !== proposal.createdAt ||
      evidence.proposal.origin !== proposal.origin ||
      evidence.proposal.kind !== proposal.kind ||
      evidence.producer.engineModel !== proposal.engineModel ||
      evidence.producer.engineTier !== proposal.engineTier ||
      evidence.diff.hash !== currentDiffHash ||
      evidence.verification.diffHash !== currentDiffHash ||
      evidence.verification.passed !== true ||
      !Array.isArray(evidence.verification.commandKinds) ||
      !evidence.verification.commandKinds.some((kind) => typeof kind === 'string' && kind.trim() !== '')
    ) return null;
    if (!evidenceGatesPassed(evidence) || evidence.target !== 'main' ||
      evidence.trustBasis !== 'evidence' || evidence.remotePreferred !== true ||
      evidence.policy?.allowed !== true || evidence.policy.tier !== 'T4' ||
      evidence.policy.action !== 'merge-main') return null;
    if (!proposal.engineTier) return null;
    if (routeHasSkillSelection(proposal.routeSnapshot) || routeHasSkillSelection(evidence.routeSnapshot)) return null;

    return { proposal, evidence, diffHash: currentDiffHash, commandKinds };
  } catch {
    return null;
  }
}

function skillCardFromVerified(input: VerifiedSkillInput, ts: string): SkillCard {
  const { proposal, evidence, diffHash, commandKinds } = input;
  const taskClass = deriveTaskClass(boundedMetadataText(proposal.title, 100, 'verified workflow'));
  const safeTitle = `Verified ${taskClass} workflow`;
  const safeSummary = boundedMetadataText(
    `Evidence-bound ${taskClass} workflow verified with ${commandKinds.join(', ')} commands at ${evidence.riskClass} risk.`,
    400,
  );
  const gateCount = Object.values(evidence.gates).length;
  return {
    schemaVersion: 1,
    skillId: `skill.proposal.${boundedMetadataText(proposal.id, 200, 'unknown')}`,
    revision: 1,
    ts,
    name: safeTitle,
    summary: safeSummary,
    status: 'verified',
    source: 'verified-proposal',
    tags: [
      TAG,
      SKILL_CREDIT_RELEASE_TAG,
      `engine:${proposal.engineTier}`,
      `proposal:${boundedMetadataText(proposal.id, 24, 'unknown')}`,
    ],
    taskKinds: [taskClass],
    commandKinds,
    verification: {
      passed: true,
      ...(proposal.verifyResult?.verifiedAt || evidence.verification.verifiedAt
        ? { verifiedAt: proposal.verifyResult?.verifiedAt ?? evidence.verification.verifiedAt }
        : {}),
      commandKinds,
      diffHash,
      riskClass: evidence.riskClass,
      evidenceCount: gateCount + 1,
    },
    proposalId: proposal.id,
    ...(proposal.runId ? { runId: proposal.runId } : {}),
    ...(proposal.trajectoryId ?? evidence.trajectoryId
      ? { trajectoryId: proposal.trajectoryId ?? evidence.trajectoryId }
      : {}),
    ...(proposal.routeSnapshot ?? evidence.routeSnapshot
      ? { routeSnapshot: proposal.routeSnapshot ?? evidence.routeSnapshot }
      : {}),
    ...(proposal.runEventSummary ?? evidence.runEventSummary
      ? { runEventSummary: proposal.runEventSummary ?? evidence.runEventSummary }
      : {}),
    evidenceOutcome: {
      target: evidence.target,
      trustBasis: evidence.trustBasis,
      riskClass: evidence.riskClass,
      verificationPassed: true,
      policyAllowed: true,
      policyAction: evidence.policy?.action,
      policyTier: evidence.policy?.tier,
      gateCount,
    },
    learningSource: 'verified-proposal',
    labelBasis: POST_MERGE_CREDIT_RELEASE_LABEL,
    ...(proposal.routerPolicyVersion ?? evidence.routerPolicyVersion
      ? { routerPolicyVersion: proposal.routerPolicyVersion ?? evidence.routerPolicyVersion }
      : {}),
    learningEpoch: ts.slice(0, 10),
  };
}

/**
 * Heuristically derive a short task-class label from a proposal title.
 * Pure; never throws; returns a safe default on any input.
 */
function deriveTaskClass(title: string): string {
  const t = title.toLowerCase();
  if (/\b(fix|bug|patch|crash|error|exception|broken)\b/.test(t)) return 'bug-fix';
  if (/\b(add|implement|feature|support|new)\b/.test(t)) return 'feature-add';
  if (/\b(refactor|rename|move|extract|clean|tidy)\b/.test(t)) return 'refactor';
  if (/\b(test|spec|coverage|vitest|jest)\b/.test(t)) return 'test-improvement';
  if (/\b(dep|dependency|bump|upgrade|update.*package)\b/.test(t)) return 'dependency-update';
  if (/\b(doc|readme|comment|jsdoc|changelog)\b/.test(t)) return 'documentation';
  if (/\b(perf|optim|speed|latency|throughput)\b/.test(t)) return 'performance';
  if (/\b(security|vuln|cve|audit)\b/.test(t)) return 'security';
  if (/\b(type|typescript|lint|eslint)\b/.test(t)) return 'type-lint';
  return 'general';
}

// ---------------------------------------------------------------------------
// Public: learnFromApplied
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget skill write-back.
 *
 * Called after a proposal merge attempt. Persisted state must include an exact
 * realized-merge witness before any skill is written. Writes:
 *   1. A genome hub entry (skill workflow) tagged 'm243:skill'.
 *   2. A structured, append-only verified SkillCard.
 *   3. A decisions-ledger entry for telemetry/observability.
 *
 * NEVER THROWS. All reads and writes are synchronous and guarded by try/catch.
 * Gated on cfg.foundry?.skillLibrary !== false (default ON).
 *
 * @param proposal  A proposal lookup hint; persisted state is authoritative.
 * @param cfg  Fleet config.
 */
export function learnFromApplied(proposal: Proposal, cfg: AshlrConfig): void {
  // Gate: default ON; explicit false = no-op (byte-identical to no call).
  try {
    const foundry = cfg.foundry as Record<string, unknown> | undefined;
    if (foundry?.['skillLibrary'] === false) return;
  } catch {
    return;
  }

  // Caller fields (including status, verification, route, and tier) are only a
  // lookup hint. Every authority-bearing field comes from the persisted state.
  let verified: VerifiedSkillInput | null;
  try {
    verified = verifiedSkillInput(proposal.id);
  } catch {
    return;
  }
  if (!verified) return;

  const authoritative = verified.proposal;
  const now = new Date().toISOString();
  const structuredCard = attestSkillCard(sanitizeSkillCard(skillCardFromVerified(verified, now)));
  if (!structuredCard) return;

  // Preserve the legacy genome note for compatibility.
  try {
    const workflow = distillWorkflow(authoritative);
    const safeTitle = boundedMetadataText(authoritative.title, 60, 'untitled');
    const title = `Skill: ${authoritative.engineTier} — ${safeTitle}`;

    appendHubEntry({
      title,
      text: workflow,
      tags: [
        TAG,
        SKILL_CREDIT_RELEASE_TAG,
        `engine:${boundedMetadataText(authoritative.engineTier, 24, 'unknown')}`,
        `proposal:${boundedMetadataText(authoritative.id, 24, 'unknown')}`,
      ],
      hubOnly: true,
    });
  } catch {
    // appendHubEntry never throws by contract; guard defensively.
  }

  // Structured skill history is append-only and independently best-effort.
  try {
    recordSkillCard(structuredCard);
  } catch {
    // Skill history must never disrupt the applied proposal path.
  }

  // Telemetry: record to decisions ledger (action 'skill-library:written').
  try {
    recordDecision({
      ts: new Date().toISOString(),
      proposalId: authoritative.id,
      action: 'skill-library:written' as Parameters<typeof recordDecision>[0]['action'],
      detail: `engine=${authoritative.engineTier}`,
      labelBasis: POST_MERGE_CREDIT_RELEASE_LABEL,
      repo: authoritative.repo ?? '',
      engine: authoritative.engineModel ?? '',
      model: '',
    } as Parameters<typeof recordDecision>[0]);
  } catch {
    // Ledger write is best-effort observability only.
  }
}

// ---------------------------------------------------------------------------
// Curator: curateSkills
// ---------------------------------------------------------------------------

/**
 * Skill injection remains disabled until a distinct post-merge release proof
 * and verifier exist. Tags and generic genome persistence are not authority.
 */
export function curateSkills(_entries: GenomeEntry[]): GenomeEntry[] {
  return [];
}
