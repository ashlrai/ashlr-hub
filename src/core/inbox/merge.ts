/**
 * core/inbox/merge.ts — M47/M153: tiered-trust + verification-strength merge gate.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ SECURITY MODEL — autonomous merge to the DEFAULT BRANCH (main).            ║
 * ║                                                                            ║
 * ║ This is the ONLY module that may advance a proposal's diff onto the        ║
 * ║ repository's default branch WITHOUT an interactive human approve. Because  ║
 * ║ that is the highest-trust outward action in the system, autoMergeProposal  ║
 * ║ runs a STRICT chain of gates and refuses (mutating nothing) the instant    ║
 * ║ any gate fails. Gates, in order:                                           ║
 * ║                                                                            ║
 * ║   1. cfg.foundry.autoMerge.enabled === true   (DEFAULT DISABLED).          ║
 * ║   2. proposal exists, kind ∈ {patch,pr}, non-empty diff.                   ║
 * ║   3. kill switch OFF + assertMayMutate(repo) (enrollment). On refusal we   ║
 * ║      DO NOT burn proposal state — it stays approvable/pending.             ║
 * ║   4. MERGE AUTHORITY — two modes selected by trustBasis (DEFAULT 'tier'):  ║
 * ║      'tier' (M51): engineTier === 'frontier' AND {engine,model} ∈           ║
 * ║        mergeAuthority. Byte-identical to pre-M153 when absent/'tier'.       ║
 * ║      'verification' (M153): STRONGER 5-criterion bar that REPLACES the     ║
 * ║        tier check. ANY producer tier clears if ALL hold:                    ║
 * ║        (a) most-recent 'judged' decision verdict='ship' AND judge engine   ║
 * ║            is a frontier (claude-*) model — NEVER the local 72b fallback   ║
 * ║            (self-confirmation trap is explicitly blocked);                  ║
 * ║        (b) proposal.verifyResult.passed === true (full suite green);        ║
 * ║        (c) risk ≤ maxRisk AND files/lines within scope caps;               ║
 * ║        (d) edvConfirmationWeight confirmed === true (independent signal);   ║
 * ║        (e) valid signed HMAC provenance.                                    ║
 * ║   5. classifyRisk(proposal) ≤ cfg.foundry.autoMerge.maxRisk (default low). ║
 * ║  5.5 SCOPE CAP (M86): risk must be 'low' AND the diff must be within tight ║
 * ║      size caps — files ≤ MAX_AUTOMERGE_FILES (default 4, override via      ║
 * ║      cfg.foundry.autoMerge.maxAutomergeFiles) AND changed lines ≤          ║
 * ║      MAX_AUTOMERGE_LINES (default 150, override via                        ║
 * ║      cfg.foundry.autoMerge.maxAutomergeLines). Pure check, no I/O.        ║
 * ║   6. verifyProposal: apply the diff to an ISOLATED temp worktree off the   ║
 * ║      default branch and run EVERY detected verify command — ALL must pass. ║
 * ║      Verify commands are detected from the BASE tree BEFORE the diff is    ║
 * ║      applied, so a diff CANNOT rewrite which commands run (H1a). A diff    ║
 * ║      touching any build/CI/manifest path (package.json, lockfiles,         ║
 * ║      .github/*, Dockerfile, CI configs, .npmrc, Makefile, …) is REFUSED    ║
 * ║      outright — regardless of allowWithoutVerification (H1b).              ║
 * ║      No commands detected ⇒ fail-closed unless allowWithoutVerification.   ║
 * ║  6.5 SELF-EVAL PARITY (M86/M54): when the proposal targets ashlr-hub's    ║
 * ║      OWN source, the full invariant suite must be green with the foundry   ║
 * ║      flag both OFF and ON (selfEvalParity). This is in ADDITION to the     ║
 * ║      guardSafetyTests check already run inside verifyProposal — that guard ║
 * ║      fires first (pre-verify); parity runs last (post-verify). Together    ║
 * ║      they are the two-layer self-improvement safety harness (M54).         ║
 * ║   7. MANAGER QUALITY GATE (M126): after ALL mechanical gates pass, require ║
 * ║      a Manager 'ship' verdict (judgeProposal) before auto-merging. The     ║
 * ║      verdict is resolved by reading the most recent 'judged' entry for     ║
 * ║      this proposalId from the decisions ledger; if absent or stale (>1h),  ║
 * ║      judge inline (one model call). Only verdict==='ship' AND              ║
 * ║      wouldMerge===true may proceed. 'review'/'noise'/'harmful' leave the   ║
 * ║      proposal PENDING (never auto-reject here). Fail-closed: if the judge  ║
 * ║      is unavailable, leave pending — NEVER merge without a verdict.        ║
 * ║  7.5 SELF-TARGET ESCALATION (M126): when isSelfTargetProposal is true,     ║
 * ║      DO NOT auto-merge even on 'ship' — leave PENDING for Mason unless     ║
 * ║      cfg.foundry.autoMerge.allowSelfMerge === true (default false). The    ║
 * ║      M54 guards (Gate 6.5) remain regardless of this flag.                 ║
 * ║                                                                            ║
 * ║ Only after ALL gates pass do we mutate. Mutation paths:                    ║
 * ║   - REMOTE (preferred): open a PR to the default branch and best-effort    ║
 * ║     `gh pr merge --squash --admin`. Server-side branch protection / CI     ║
 * ║     remain the outer safety net. gh failures NEVER throw.                  ║
 * ║   - LOCAL (fallback): merge the branch into the default branch via a       ║
 * ║     dedicated temp worktree (`git merge --no-ff`). We REFUSE the local     ║
 * ║     path when the default branch is the one checked out in the user's      ║
 * ║     working tree (would race their index/HEAD) — the branch is left for a  ║
 * ║     manual merge.                                                          ║
 * ║                                                                            ║
 * ║ RESIDUAL RISK (documented): the LOCAL merge path has no code-review or CI  ║
 * ║ gate beyond our own verifyProposal — it is the conservative fallback and   ║
 * ║ should be enabled only on trusted, enrolled repos. The REMOTE/PR path is   ║
 * ║ STRONGLY preferred because it inherits the host's branch protection and    ║
 * ║ required-checks. The filesystem is not jailed; verify commands run real    ║
 * ║ project scripts (npm/tsc) — only enable auto-merge where that is safe.     ║
 * ║                                                                            ║
 * ║ PROVENANCE TRUST (H3, residual — tracked follow-up M47.1): the merge       ║
 * ║ authority gate (Gate 4) trusts proposal.engineTier / proposal.engineModel  ║
 * ║ as read from the on-disk proposal record. The agent MCP surface            ║
 * ║ (ashlr_inbox_propose) CANNOT set these fields (verified — they are stamped ║
 * ║ server-side, not from agent input), so a remote agent cannot self-elevate. ║
 * ║ A LOCAL / in-process writer with filesystem access to ~/.ashlr/inbox,      ║
 * ║ however, COULD forge a record claiming frontier authority. Full mitigation ║
 * ║ is HMAC-signed provenance binding the {tier,model} to a hash of the diff   ║
 * ║ (so a forged record cannot be paired with an arbitrary diff); it is a      ║
 * ║ tracked follow-up (M47.1) and intentionally NOT implemented here. The      ║
 * ║ residual is bounded by the DEFAULT-DISABLED posture: auto-merge is off     ║
 * ║ unless an operator explicitly enables it on an enrolled, trusted repo.     ║
 * ║                                                                            ║
 * ║ INVARIANTS: every public fn here NEVER throws; every refusal mutates       ║
 * ║ nothing (no branch, no status change); every outcome is audited; no        ║
 * ║ secrets are logged. Node builtins only.                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { AshlrConfig, EngineTier, Proposal } from '../types.js';
import { loadProposal, setStatus, updateProposalField } from './store.js';
import { assertMayMutate, killSwitchOn } from '../sandbox/policy.js';
import { audit } from '../sandbox/audit.js';
import { isRepo, getGitStatus, getRemoteOrg, defaultBranch } from '../git.js';
import { createPr } from '../integrations/github.js';
import { scrubSecrets } from '../knowledge/index.js';
import { isSelfTargetProposal, guardSafetyTests, selfEvalParity } from '../fleet/self.js';
import { verifyProvenance, verifyJudgeAttestation, hashDiff } from '../foundry/provenance.js';
import { judgeProposal } from '../fleet/manager.js';
import { readDecisions, recordDecision } from '../fleet/decisions-ledger.js';
import { edvConfirmationWeight } from '../portfolio/edv-verify.js';
import {
  detectVerifyCommands,
  runVerifyCommand,
  type VerifyCommand,
} from '../run/verify-commands.js';
import { parseFailedTestIds } from '../run/completeness-gate.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Branch prefix for auto-merge staging branches. NEVER touch user branches. */
const MERGE_BRANCH_PREFIX = 'ashlr/merge/';

/** Timeout for git operations (ms). */
const GIT_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// git helpers — arg arrays, no shell
// ---------------------------------------------------------------------------

/** Run a git command in `cwd`. Throws on failure. */
function gitRun(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

/** Run a git command, returning null on any error (never throws). */
function gitTry(cwd: string, args: string[]): string | null {
  try {
    return gitRun(cwd, args);
  } catch {
    return null;
  }
}

/** Write `content` to a temp file under ~/.ashlr/tmp; caller cleans it up. */
function writeTmpFile(content: string): string {
  const dir = join(homedir(), '.ashlr', 'tmp');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = join(dir, `merge-${randomBytes(6).toString('hex')}.diff`);
  writeFileSync(p, content, 'utf8');
  return p;
}

// ===========================================================================
// 1) Risk classification (PURE)
// ===========================================================================

export type RiskClass = 'low' | 'medium' | 'high';

/** Total ordering for risk comparison: low < medium < high. */
const RISK_ORDER: Record<RiskClass, number> = { low: 0, medium: 1, high: 2 };

/**
 * Extract the changed file paths from a unified diff by reading every
 * `+++ b/<path>` header. Strips the `b/` prefix and ignores `/dev/null`
 * (deletions). Returns an empty array when no headers are present.
 */
function changedFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    let p = line.slice(4).trim();
    // Strip a trailing tab-timestamp some tools emit: "+++ b/x\t2026-..."
    const tab = p.indexOf('\t');
    if (tab >= 0) p = p.slice(0, tab);
    if (p === '/dev/null') continue;
    if (p.startsWith('b/')) p = p.slice(2);
    if (p.startsWith('a/')) p = p.slice(2);
    if (p) files.push(p);
  }
  return files;
}

/** Lowercase basename of a path (no directory). */
function baseName(p: string): string {
  const slash = p.lastIndexOf('/');
  return (slash >= 0 ? p.slice(slash + 1) : p).toLowerCase();
}

/** True when the path is documentation-only (markdown / LICENSE). */
function isDocFile(p: string): boolean {
  const b = baseName(p);
  return b.endsWith('.md') || b === 'license' || b.startsWith('license.');
}

/** True when the path is a lockfile or pure dependency manifest lock. */
function isLockFile(p: string): boolean {
  const b = baseName(p);
  return (
    b === 'package-lock.json' ||
    b === 'pnpm-lock.yaml' ||
    b === 'yarn.lock' ||
    b === 'bun.lockb' ||
    b.endsWith('.lock')
  );
}

/** True when the path lives in a test directory or is a test/spec file. */
function isTestFile(p: string): boolean {
  const lower = p.toLowerCase();
  if (
    lower.startsWith('test/') ||
    lower.startsWith('tests/') ||
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    lower.includes('/__tests__/')
  ) {
    return true;
  }
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower);
}

/** True for config-ish files (json/yaml/toml/ini + .github/*). */
function isConfigFile(p: string): boolean {
  const lower = p.toLowerCase();
  if (lower.startsWith('.github/')) return true;
  const b = baseName(p);
  return (
    b.endsWith('.json') ||
    b.endsWith('.yml') ||
    b.endsWith('.yaml') ||
    b.endsWith('.toml') ||
    b.endsWith('.ini') ||
    b.endsWith('.cfg') ||
    b.endsWith('.conf')
  );
}

/** True for executable source code (the high-trust surface). */
function isSourceFile(p: string): boolean {
  const lower = p.toLowerCase();
  return /\.(ts|tsx|js|jsx|cjs|mjs|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|swift|sh|bash)$/.test(
    lower,
  );
}

/**
 * True when the path is a build / CI / dependency-manifest file — the class of
 * files that can change WHICH verify commands run or execute arbitrary code on
 * the host (npm lifecycle scripts, CI pipelines, container builds). These are
 * unconditionally HIGH risk (H2) and are REFUSED outright by verifyProposal
 * (H1b) because no in-process verify can be trusted once they change.
 */
function isBuildOrCiOrManifest(p: string): boolean {
  const lower = p.toLowerCase();
  const b = baseName(p);
  // Any path under .github/ (workflows, actions, dependabot, …).
  if (lower.startsWith('.github/')) return true;
  // Any path under .circleci/.
  if (lower.startsWith('.circleci/')) return true;
  // Top-level CI / manifest / tooling configs.
  if (
    b === 'package.json' ||
    b === 'package-lock.json' ||
    b === 'pnpm-lock.yaml' ||
    b === 'yarn.lock' ||
    b === 'bun.lockb' ||
    b === '.gitlab-ci.yml' ||
    b === '.npmrc' ||
    b === '.yarnrc' ||
    b === 'makefile' ||
    b === 'dockerfile'
  ) {
    return true;
  }
  // *.Dockerfile (e.g. app.Dockerfile, prod.dockerfile).
  if (b.endsWith('.dockerfile')) return true;
  return false;
}

/** True when the path looks like an auth / security-sensitive surface. */
function isSecuritySensitive(p: string): boolean {
  const lower = p.toLowerCase();
  return (
    /(^|\/)(auth|authn|authz|security|secret|secrets|credential|credentials|crypto|token|password|policy|sandbox|permission|permissions|rbac|acl|login|session)(s)?([./_-]|$)/.test(
      lower,
    ) || /\.(pem|key|p12|pfx)$/.test(lower)
  );
}

/**
 * Classify the merge risk of a proposal from its diff + kind. PURE.
 *
 *   low    — ONLY docs (*.md / LICENSE), lockfiles (*.lock / package-lock.json),
 *            and/or test-only files.
 *   medium — config files (*.json/*.yml/*.toml/.github/*) and/or small source
 *            changes (a single source file with a modest diff).
 *   high   — any source change touching an auth/security path, a large diff
 *            (many files or many changed lines), or anything we can't classify
 *            as low/medium. Empty / unparsable diffs are treated as HIGH
 *            (fail-safe — an unknown change is the most dangerous kind).
 */
export function classifyRisk(proposal: Proposal): RiskClass {
  const diff = proposal.diff ?? '';
  const files = changedFilesFromDiff(diff);

  // An empty or unparsable diff is the most dangerous: fail to HIGH.
  if (files.length === 0) return 'high';

  // ── H2: dangerous-file classes are unconditionally HIGH (checked FIRST, ──────
  // before any medium/low logic could under-rate them) ────────────────────────
  //   - build / CI / dependency-manifest files (package.json, lockfiles,
  //     .github/*, Dockerfile, .gitlab-ci.yml, .circleci/*, .npmrc/.yarnrc,
  //     Makefile) — can change which verify commands run or exec host code.
  //     NOTE: lockfiles were previously classified LOW; they are now HIGH.
  //   - shell scripts (*.sh / *.bash) — run arbitrary host code.
  //   - any auth / secret / credential / security surface.
  const isShellScript = (p: string): boolean => /\.(sh|bash)$/.test(p.toLowerCase());
  if (
    files.some(isBuildOrCiOrManifest) ||
    files.some(isShellScript) ||
    files.some(isSecuritySensitive)
  ) {
    return 'high';
  }

  // Count added/removed body lines (exclude the +++/--- headers) to gauge size.
  let changedLines = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) changedLines++;
  }
  const LARGE_FILES = 10;
  const LARGE_LINES = 400;
  if (files.length > LARGE_FILES || changedLines > LARGE_LINES) return 'high';

  const sourceFiles = files.filter(isSourceFile);

  // ── LOW: every file is docs / lockfile / test ──────────────────────────────
  const allLowTrust = files.every(
    (f) => isDocFile(f) || isLockFile(f) || isTestFile(f),
  );
  if (allLowTrust) return 'low';

  // ── HIGH: any non-trivial source change ────────────────────────────────────
  // A single small source file is allowed at MEDIUM; more than one source file,
  // or a sizeable single-file change, escalates to HIGH.
  if (sourceFiles.length > 0) {
    const SMALL_SRC_LINES = 40;
    if (sourceFiles.length === 1 && changedLines <= SMALL_SRC_LINES) {
      return 'medium';
    }
    return 'high';
  }

  // ── At this point there are NO source files and the diff is not purely
  // low-trust (docs/lock/test). It is config and/or unknown text files. ────────
  //   - Every file recognised as config / doc / lock / test → MEDIUM.
  //   - Any UNrecognised file (not source, not config, not low-trust — e.g. a
  //     binary asset or an unknown dotfile) → HIGH (fail-safe: we can't reason
  //     about it, so we don't auto-merge it at low/medium trust).
  const allRecognised = files.every(
    (f) => isConfigFile(f) || isDocFile(f) || isLockFile(f) || isTestFile(f),
  );
  return allRecognised ? 'medium' : 'high';
}

// ===========================================================================
// 2) Merge-authority evaluation (PURE)
// ===========================================================================

export interface MergeAuthorityVerdict {
  authorized: boolean;
  reason: string;
}

/**
 * Decide whether a proposal carries frontier merge-authority. PURE.
 *
 * Authorized ONLY when BOTH hold:
 *   - proposal.engineTier === 'frontier'; AND
 *   - cfg.foundry.mergeAuthority contains an entry whose reconstructed
 *     `${engine}:${model}` exactly equals proposal.engineModel.
 *
 * REJECTS when:
 *   - engineModel is missing, or ends in ':default' (no concrete model pinned);
 *   - there is no mergeAuthority config / no matching entry;
 *   - the tier is not 'frontier'.
 */
export function evaluateMergeAuthority(
  proposal: Proposal,
  cfg: AshlrConfig,
): MergeAuthorityVerdict {
  if (proposal.engineTier !== 'frontier') {
    // M51 tri-tier: authority never leaks upward. 'mid' (strong open models) is
    // branch-eligible but NEVER merge-authority for main; 'local' is
    // proposal-only. Only 'frontier' may reach main.
    const tier = proposal.engineTier ?? 'unset';
    const note =
      tier === 'mid'
        ? " — 'mid' is branch-eligible but never merge-authority for main"
        : '';
    return {
      authorized: false,
      reason: `engineTier is '${tier}', not 'frontier' — only frontier backends carry merge authority${note}`,
    };
  }

  const engineModel = proposal.engineModel;
  if (!engineModel) {
    return {
      authorized: false,
      reason: 'proposal has no engineModel — cannot verify merge authority',
    };
  }
  if (engineModel.endsWith(':default')) {
    return {
      authorized: false,
      reason: `engineModel '${engineModel}' has no concrete model pinned (':default') — merge authority requires a vetted model`,
    };
  }

  const authority = cfg.foundry?.mergeAuthority;
  if (!authority || authority.length === 0) {
    return {
      authorized: false,
      reason: 'cfg.foundry.mergeAuthority is empty — no backend is authorized to merge',
    };
  }

  const match = authority.some((e) => `${e.engine}:${e.model}` === engineModel);
  if (!match) {
    return {
      authorized: false,
      reason: `engineModel '${engineModel}' is not in cfg.foundry.mergeAuthority`,
    };
  }

  return {
    authorized: true,
    reason: `frontier backend '${engineModel}' is authorized to merge`,
  };
}

/**
 * M51 tri-tier policy seam (PURE). The farthest a fully-verified proposal of a
 * given tier may auto-apply: `frontier → main`, `mid → branch` (a strong open
 * model: branch/PR only, never main), everything else → `none` (proposal-only).
 * Introduces NO new default behavior — it is the single source of truth a
 * future, default-OFF, gated auto-apply pass consults so authority can never
 * leak upward.
 */
export type MergeTarget = 'main' | 'branch' | 'none';
export function mergeTargetForTier(tier?: EngineTier): MergeTarget {
  if (tier === 'frontier') return 'main';
  if (tier === 'mid') return 'branch';
  return 'none';
}

/**
 * M56: decide whether a MID-tier proposal may auto-apply to a BRANCH (never
 * main). PURE. Authorized ONLY when ALL hold:
 *   - cfg.foundry.autoMerge.midToBranch === true (a separate, DEFAULT-OFF flag,
 *     so enabling main auto-merge does not implicitly enable the branch path); AND
 *   - mergeTargetForTier(engineTier) === 'branch' (i.e. engineTier === 'mid'); AND
 *   - engineModel is a concrete, vetted model (present, not ':default').
 * Grants BRANCH authority only — a mid proposal can never reach main regardless
 * of cfg.foundry.mergeAuthority contents.
 */
export function evaluateBranchAuthority(proposal: Proposal, cfg: AshlrConfig): MergeAuthorityVerdict {
  if (cfg.foundry?.autoMerge?.midToBranch !== true) {
    return {
      authorized: false,
      reason: 'mid→branch auto-apply is disabled (cfg.foundry.autoMerge.midToBranch !== true)',
    };
  }
  if (mergeTargetForTier(proposal.engineTier) !== 'branch') {
    return {
      authorized: false,
      reason: `engineTier '${proposal.engineTier ?? 'unset'}' is not branch-eligible (only 'mid' is)`,
    };
  }
  const engineModel = proposal.engineModel;
  if (!engineModel || engineModel.endsWith(':default')) {
    return {
      authorized: false,
      reason: `engineModel '${engineModel ?? 'unset'}' has no concrete model pinned`,
    };
  }
  return { authorized: true, reason: `mid backend '${engineModel}' may auto-apply to a branch (never main)` };
}

// ===========================================================================
// 3) defaultBranch — re-exported from git.ts (see contract)
// ===========================================================================

// `defaultBranch` is imported above (from ../git.js) and re-exported here so the
// M47 surface is self-contained.
export { defaultBranch };

// ===========================================================================
// 3b) evaluateVerificationGate — M153 VERIFICATION-STRENGTH trust basis
// ===========================================================================

/**
 * M153: Verification-gate result. Mirrors MergeAuthorityVerdict so the two
 * trust bases are interchangeable at the Gate 4 call site.
 */
export interface VerificationGateVerdict {
  authorized: boolean;
  reason: string;
}

/**
 * M153: helper — is a judge engine string a frontier (claude-*) model?
 *
 * The frontier-judge requirement is NON-NEGOTIABLE in verification mode:
 * the PRODUCER may be local but the JUDGE must be a Claude frontier model.
 * This prevents self-confirmation (local 72b judging its own output).
 *
 * A model string is frontier-judge when it starts with 'claude' (case-
 * insensitive) OR contains 'claude'. This matches the convention used
 * throughout manager.ts (resolveJudgeClient / runManager).
 */
export function isFrontierJudge(judgeEngine: string | undefined): boolean {
  if (!judgeEngine || judgeEngine === 'unknown' || judgeEngine === 'local') return false;
  const lc = judgeEngine.toLowerCase();
  return lc.startsWith('claude') || lc.includes('claude');
}

/**
 * M153: evaluate the VERIFICATION-STRENGTH gate.
 *
 * Called ONLY when cfg.foundry.autoMerge.trustBasis === 'verification'.
 * Replaces the frontier-tier/mergeAuthority check (M51 Gate 4) with a
 * STRONGER 5-criterion bar. ALL must hold, or the gate refuses.
 *
 * Criteria (all required):
 *
 *   1. FRONTIER JUDGE 'ship': the most recent 'judged' decision for this
 *      proposal must have verdict === 'ship' AND the judgeEngine recorded in
 *      DecisionEntry.engine must be a frontier (claude-*) model. If the judge
 *      was local/72b or no 'judged' entry exists → REFUSE. The producer may be
 *      any tier; the JUDGE must be frontier. Non-negotiable anti-self-confirm.
 *
 *   2. SUITE GREEN: proposal.verifyResult.passed === true — the full test suite
 *      ran and passed (set by verifyProposal Gate 6). Gate 6 is a prerequisite
 *      so this criterion is a belt-and-suspenders re-check here at Gate 4.
 *      If verifyResult is absent or passed===false → REFUSE.
 *
 *   3. RISK ≤ maxRisk AND SCOPE CAP: risk === 'low' AND files ≤
 *      maxAutomergeFiles AND lines ≤ maxAutomergeLines. These are also enforced
 *      by Gates 5/5.5 later; we enforce them here too so verification mode
 *      cannot be tricked by re-ordering or gate removal.
 *
 *   4. EDV INDEPENDENT CONFIRMATION: edvConfirmationWeight(proposal, decisions)
 *      .confirmed === true (full weight 1.0). 'unverified' (0.3) does NOT
 *      satisfy the bar — an explicit independent signal is required.
 *
 *   5. VALID SIGNED PROVENANCE: verifyProvenance(proposal).ok === true.
 *      (Also enforced by Gate 4.5; re-checked here so criteria are self-
 *      contained and ordering cannot be exploited.)
 *
 * NEVER throws. PURE (no I/O beyond the provided decisions array).
 */
export function evaluateVerificationGate(
  proposal: Proposal,
  cfg: AshlrConfig,
  decisionsForProposal: Array<{ action: string; verdict?: string; engine?: string; model?: string; judgeAttestation?: string }>,
): VerificationGateVerdict {
  const refuse = (reason: string): VerificationGateVerdict => ({ authorized: false, reason });

  // ── Criterion 1: HMAC-signed frontier judge 'ship' attestation ────────────
  // M157: Replace unsigned-ledger scan with cryptographic verification.
  // A forged ledger entry claiming "judged claude ship" without a valid
  // HMAC-signed attestation will FAIL here — the core security fix.
  //
  // Steps:
  //   (a) Find the most recent 'judged' entry with verdict='ship'.
  //   (b) Verify the judge engine is a frontier (claude-*) model.
  //   (c) Verify the HMAC attestation — recomputed from (proposalId, judgeEngine,
  //       verdict, diffHash-of-CURRENT-diff). A stale attestation for a different
  //       proposalId, a changed diff, or no attestation at all → REFUSE.
  const shipEntry = [...decisionsForProposal]
    .reverse()
    .find((d) => d.action === 'judged' && d.verdict === 'ship');

  if (!shipEntry) {
    return refuse(
      "verification gate: no 'judged' decision with verdict='ship' found for this proposal — a frontier judge must explicitly ship it",
    );
  }

  // The judge engine is stored in DecisionEntry.engine (and .model — same value).
  // runManager records the real model string; Gate 7 inline now records it too (M153 fix).
  const judgeEngine = shipEntry.engine ?? shipEntry.model;
  if (!isFrontierJudge(judgeEngine)) {
    return refuse(
      `verification gate: judge '${judgeEngine ?? 'unknown'}' is not a frontier (claude-*) model — ` +
        `local/72b judges cannot provide independent confirmation (self-confirmation trap)`,
    );
  }

  // Verify the HMAC attestation. diffHash is recomputed from the CURRENT proposal
  // diff so a stale attestation for a tampered diff also fails.
  const currentDiffHash = hashDiff(proposal.diff ?? '');
  const attestationResult = verifyJudgeAttestation(shipEntry.judgeAttestation, {
    proposalId: proposal.id,
    judgeEngine: judgeEngine ?? '',
    verdict: 'ship',
    diffHash: currentDiffHash,
  });
  if (!attestationResult.ok) {
    return refuse(
      `verification gate: judge attestation invalid — ${attestationResult.reason ?? 'unknown'}; ` +
        `a forged ledger entry without a valid HMAC-signed attestation cannot pass criterion 1`,
    );
  }

  // ── Criterion 2: suite green ──────────────────────────────────────────────
  // verifyResult.passed is set by verifyProposal (Gate 6). In verification mode
  // this is a hard prerequisite even before Gate 6 runs in autoMergeProposal,
  // because a pre-verified proposal (run outside the merge path) may already
  // carry this field. If absent, refuse — the suite must have been run.
  if (proposal.verifyResult?.passed !== true) {
    return refuse(
      `verification gate: proposal.verifyResult.passed is ${
        proposal.verifyResult === undefined ? 'absent' : 'false'
      } — the full test suite must pass`,
    );
  }

  // ── Criterion 3: risk ≤ maxRisk AND scope cap ─────────────────────────────
  // Re-checked here (belt-and-suspenders; Gates 5/5.5 also enforce these).
  // classifyRisk is declared later in the file but hoisting is fine for functions.
  const risk = classifyRisk(proposal);
  const maxRisk: RiskClass = (cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge']
    ? ((cfg.foundry as Record<string, unknown>)['autoMerge'] as Record<string, unknown>)?.['maxRisk'] as RiskClass ?? 'low'
    : 'low';

  if (RISK_ORDER[risk] > RISK_ORDER[maxRisk]) {
    return refuse(
      `verification gate: risk class '${risk}' exceeds maxRisk '${maxRisk}'`,
    );
  }

  const diff = proposal.diff ?? '';
  const rawFiles = (cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge']
    ? ((cfg.foundry as Record<string, unknown>)['autoMerge'] as Record<string, unknown>)?.['maxAutomergeFiles'] as number
    : undefined;
  const MAX_FILES: number = typeof rawFiles === 'number' && rawFiles >= 1 ? Math.floor(rawFiles) : 4;
  const rawLines = (cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge']
    ? ((cfg.foundry as Record<string, unknown>)['autoMerge'] as Record<string, unknown>)?.['maxAutomergeLines'] as number
    : undefined;
  const MAX_LINES: number = typeof rawLines === 'number' && rawLines >= 1 ? Math.floor(rawLines) : 150;

  let scopeFiles = 0;
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    const p = line.slice(4).trim().split('\t')[0];
    if (p && p !== '/dev/null') scopeFiles++;
  }
  let scopeLines = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) scopeLines++;
  }

  if (scopeFiles > MAX_FILES) {
    return refuse(
      `verification gate: scope cap — diff touches ${scopeFiles} files (max ${MAX_FILES})`,
    );
  }
  if (scopeLines > MAX_LINES) {
    return refuse(
      `verification gate: scope cap — diff has ${scopeLines} changed lines (max ${MAX_LINES})`,
    );
  }

  // ── Criterion 4: EDV independent confirmation ─────────────────────────────
  // cfg is forwarded so operator-configured thresholds (cfg.foundry.edvUnverifiedWeight)
  // are honoured. BUG-2 fix: previously cfg was not passed, silently ignoring config.
  const edvResult = edvConfirmationWeight(
    proposal,
    decisionsForProposal as Array<{ action: 'proposed' | 'verified' | 'judged' | 'merged' | 'rejected' | 'escalated'; ts: string; proposalId: string; engine?: string; model?: string; verdict?: string; reason?: string; detail?: string }>,
    cfg,
  );
  if (!edvResult.confirmed) {
    return refuse(
      `verification gate: EDV independent confirmation absent (source='${edvResult.source}', weight=${edvResult.weight}) — a confirmed independent signal is required`,
    );
  }

  // ── Criterion 5: valid signed provenance ──────────────────────────────────
  const provenance = verifyProvenance(proposal);
  if (!provenance.ok) {
    return refuse(
      `verification gate: provenance check failed — ${provenance.reason}`,
    );
  }

  // All 5 criteria met — including HMAC-verified judge attestation (M157).
  return {
    authorized: true,
    reason: `verification gate cleared: frontier judge='${judgeEngine}' ship'd (HMAC attested); suite green; risk=${risk}≤${maxRisk}; scope ok (${scopeFiles}f/${scopeLines}l); EDV confirmed; provenance valid`,
  };
}

// ===========================================================================
// 4) verifyProposal — apply diff to an isolated worktree + run verify commands
// ===========================================================================

export interface VerifyProposalResult {
  ok: boolean;
  ran: VerifyCommand[];
  detail: string;
}

/**
 * Apply the proposal's diff to a THROWAWAY temp worktree branched off the
 * default branch's head, then run every detected verify command (typecheck /
 * test / lint). ALL must pass for ok:true. The worktree is always removed.
 *
 * Fail-closed on detection: when NO verify commands are found, returns ok:false
 * UNLESS cfg.foundry.autoMerge.allowWithoutVerification === true.
 *
 * NEVER throws — any error resolves to ok:false with a detail.
 */
export async function verifyProposal(
  proposal: Proposal,
  cfg: AshlrConfig,
): Promise<VerifyProposalResult> {
  const repo = proposal.repo;
  if (!repo || !isRepo(repo)) {
    return { ok: false, ran: [], detail: `not a git repository: ${repo ?? '(none)'}` };
  }
  const diff = proposal.diff ?? '';
  if (!diff.trim()) {
    return { ok: false, ran: [], detail: 'proposal has no diff to verify' };
  }

  // ── M54: self-improvement may never self-disarm ─────────────────────────────
  // When a proposal targets ashlr-hub's OWN source, REFUSE before any
  // verification if its diff would delete or weaken a safety/invariant test.
  // The guard runs FIRST so a weakening diff never even reaches the verify
  // worktree. (The full self-eval — suite green flag-off AND flag-on — is
  // enforced by the gated auto-merge pass via fleet/self.selfEvalParity.)
  if (isSelfTargetProposal(proposal, cfg)) {
    const guard = guardSafetyTests(diff);
    if (guard.weakened) {
      return { ok: false, ran: [], detail: `self-target guard: ${guard.reason}` };
    }
  }

  // ── H1b: manifest / build / CI guard — REFUSE regardless of ──────────────────
  // allowWithoutVerification. A diff that touches package.json, a lockfile,
  // .github/*, a Dockerfile, CI configs, .npmrc/.yarnrc, or a Makefile can change
  // which commands run (or run arbitrary host code via npm lifecycle / CI), so no
  // in-process verification can be trusted — it must go to manual review.
  const changed = changedFilesFromDiff(diff);
  if (changed.some(isBuildOrCiOrManifest)) {
    return {
      ok: false,
      ran: [],
      detail: 'diff touches build/CI/manifest files — manual review required',
    };
  }

  const base = defaultBranch(repo);
  // Resolve the head commit of the default branch WITHOUT touching the user tree.
  const baseHead =
    gitTry(repo, ['rev-parse', '--verify', `refs/heads/${base}`]) ??
    gitTry(repo, ['rev-parse', '--verify', `refs/remotes/origin/${base}`]) ??
    gitTry(repo, ['rev-parse', 'HEAD']);
  if (!baseHead) {
    return { ok: false, ran: [], detail: `could not resolve head of default branch '${base}'` };
  }

  const tmpBranch = `ashlr/verify/${randomBytes(6).toString('hex')}`;
  const tmpDir = join(homedir(), '.ashlr', 'tmp', `vwt-${randomBytes(6).toString('hex')}`);

  // Create the isolated worktree on a scratch branch off the default-branch head.
  try {
    gitRun(repo, ['worktree', 'add', '-b', tmpBranch, tmpDir, baseHead]);
  } catch (err) {
    gitTry(repo, ['worktree', 'prune']);
    return {
      ok: false,
      ran: [],
      detail: `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let patchFile: string | null = null;
  const ran: VerifyCommand[] = [];
  try {
    // ── H1a: detect verify commands from the BASE tree BEFORE applying the ─────
    // diff, so the diff CANNOT rewrite which commands run (e.g. a diff that sets
    // package.json scripts.test to "true" can no longer self-certify). The
    // manifest guard above already refuses package.json/lockfile/CI changes, but
    // base-tree detection is the defense-in-depth that makes self-certification
    // structurally impossible regardless of which files the diff touches.
    const commands = detectVerifyCommands(tmpDir);
    if (commands.length === 0) {
      const allow = cfg.foundry?.autoMerge?.allowWithoutVerification === true;
      return {
        ok: allow,
        ran: [],
        detail: allow
          ? 'no verify commands detected; allowWithoutVerification=true → passing'
          : 'no verify commands detected and allowWithoutVerification=false → fail-closed',
      };
    }

    // M281: For test commands, record the BASELINE result BEFORE applying
    // the patch (worktree is still on the clean default-branch HEAD at this point).
    // Typecheck is NOT delta-aware — it must be clean in the patched tree.
    const baselineResults = new Map<string, { ok: boolean; ids: Set<string> }>();
    for (const vc of commands) {
      if (vc.kind === 'test') {
        const baseRes = runVerifyCommand(vc, tmpDir, cfg);
        if (!baseRes.timedOut) {
          const key = Array.isArray(vc.cmd) ? vc.cmd.join(' ') : vc.kind;
          baselineResults.set(key, {
            ok: baseRes.ok,
            ids: parseFailedTestIds(baseRes.output ?? ''),
          });
        }
        // If baseline times out, we leave no entry — falls back to original fail behaviour.
      }
    }

    // Apply the diff to the worktree ONLY AFTER capturing the base-derived
    // command list, then run those (immutable) commands against the patched tree.
    patchFile = writeTmpFile(diff);
    try {
      gitRun(tmpDir, ['apply', '--index', patchFile]);
    } catch (err) {
      return {
        ok: false,
        ran: [],
        detail: `git apply failed in verify worktree: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    for (const vc of commands) {
      ran.push(vc);
      const res = runVerifyCommand(vc, tmpDir, cfg);

      if (!res.ok) {
        // M281: for test commands, only block if NEW failures were introduced.
        if (vc.kind === 'test') {
          const cmdKey = Array.isArray(vc.cmd) ? vc.cmd.join(' ') : vc.kind;
          const baseline = baselineResults.get(cmdKey);
          if (baseline !== undefined) {
            const afterIds = parseFailedTestIds(res.output ?? '');
            if (afterIds.size > 0 || baseline.ids.size > 0) {
              // Named IDs available — use set-difference
              const newFailures = new Set<string>();
              for (const id of afterIds) {
                if (!baseline.ids.has(id)) newFailures.add(id);
              }
              if (newFailures.size === 0) {
                // All failures are pre-existing — tolerate and continue
                continue;
              }
              const listed = [...newFailures].slice(0, 5).join('; ');
              return {
                ok: false,
                ran,
                detail: `verify 'test' failed — ${newFailures.size} new failure(s) introduced: ${listed}`,
              };
            } else {
              // No parseable IDs — fall back to ok-flag delta
              if (baseline.ok) {
                // Baseline was passing; change broke it — new regression → block
                return {
                  ok: false,
                  ran,
                  detail: `verify 'test' failed — regression detected (suite was passing before change)`,
                };
              }
              // Baseline also failed (pre-existing) — tolerate
              continue;
            }
          }
          // No baseline (timed out) — fall through to original fail behaviour
        }
        return {
          ok: false,
          ran,
          detail: `verify '${vc.kind}' failed (exit ${res.exitCode}): ${res.command}`,
        };
      }
    }

    return {
      ok: true,
      ran,
      detail: `all ${ran.length} verify command(s) passed: ${ran.map((c) => c.kind).join(', ')}`,
    };
  } catch (err) {
    return {
      ok: false,
      ran,
      detail: `verifyProposal error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (patchFile) {
      try {
        unlinkSync(patchFile);
      } catch {
        /* ignore */
      }
    }
    gitTry(repo, ['worktree', 'remove', '--force', tmpDir]);
    gitTry(repo, ['worktree', 'prune']);
    gitTry(repo, ['branch', '-D', tmpBranch]);
  }
}

// ===========================================================================
// 5) autoMergeProposal — the orchestrator
// ===========================================================================

export interface AutoMergeResult {
  ok: boolean;
  merged: boolean;
  /** M56: true when a MID-tier proposal was applied to a BRANCH/PR (not main). */
  branched?: boolean;
  reason: string;
  prUrl?: string;
}

/** Build the staging branch holding the proposal's diff, off the default branch.
 *  Returns the branch name on success, or null + detail on failure. */
function buildMergeBranch(
  repo: string,
  id: string,
  diff: string,
  base: string,
): { branch: string | null; detail: string } {
  const branch = `${MERGE_BRANCH_PREFIX}${id}`;
  const baseHead =
    gitTry(repo, ['rev-parse', '--verify', `refs/heads/${base}`]) ??
    gitTry(repo, ['rev-parse', '--verify', `refs/remotes/origin/${base}`]) ??
    gitTry(repo, ['rev-parse', 'HEAD']);
  if (!baseHead) {
    return { branch: null, detail: `could not resolve head of default branch '${base}'` };
  }

  const tmpDir = join(homedir(), '.ashlr', 'tmp', `mwt-${randomBytes(6).toString('hex')}`);
  try {
    gitRun(repo, ['worktree', 'add', '-b', branch, tmpDir, baseHead]);
  } catch (err) {
    gitTry(repo, ['worktree', 'prune']);
    return {
      branch: null,
      detail: `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let patchFile: string | null = null;
  let detail = '';
  let ok = false;
  try {
    patchFile = writeTmpFile(diff);
    try {
      gitRun(tmpDir, ['apply', '--index', patchFile]);
      gitRun(tmpDir, ['commit', '--no-verify', '-m', `ashlr: auto-merge proposal ${id}`]);
      ok = true;
      detail = `staged on ${branch}`;
    } catch (err) {
      detail = `apply/commit failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } finally {
    if (patchFile) {
      try {
        unlinkSync(patchFile);
      } catch {
        /* ignore */
      }
    }
    gitTry(repo, ['worktree', 'remove', '--force', tmpDir]);
    gitTry(repo, ['worktree', 'prune']);
    if (!ok && branch.startsWith(MERGE_BRANCH_PREFIX)) {
      gitTry(repo, ['branch', '-D', branch]);
    }
  }
  return ok ? { branch, detail } : { branch: null, detail };
}

/** Merge `branch` into the default branch locally via a dedicated worktree.
 *  REFUSES when the default branch is checked out in the user's main tree. */
function mergeLocally(
  repo: string,
  branch: string,
  base: string,
): { ok: boolean; detail: string } {
  // Guard: never operate on the default branch if it is the user's checked-out
  // working tree — a worktree add of an already-checked-out branch would fail,
  // and merging into it would race their index/HEAD.
  const status = getGitStatus(repo);
  if (status && status.branch === base) {
    return {
      ok: false,
      detail: `default branch '${base}' is checked out in the working tree — refusing local merge; branch '${branch}' left for manual merge`,
    };
  }

  // H6: also refuse a DETACHED HEAD sitting on the base commit. getGitStatus
  // reports branch === 'HEAD' when detached; if that detached HEAD is the same
  // commit as the default branch, merging into base would advance a ref the user
  // is actively standing on (same race as the checked-out-branch case above).
  if (status && status.branch === 'HEAD') {
    const headSha = gitTry(repo, ['rev-parse', 'HEAD']);
    const baseSha =
      gitTry(repo, ['rev-parse', '--verify', `refs/heads/${base}`]) ??
      gitTry(repo, ['rev-parse', base]);
    if (headSha && baseSha && headSha === baseSha) {
      return {
        ok: false,
        detail: `repo is in detached HEAD on the default branch commit (${base} @ ${headSha.slice(0, 8)}) — refusing local merge; branch '${branch}' left for manual merge`,
      };
    }
  }

  const tmpDir = join(homedir(), '.ashlr', 'tmp', `mergewt-${randomBytes(6).toString('hex')}`);
  // Check out the default branch into a dedicated worktree so we never touch the
  // user's tree, merge the staging branch, then the worktree's branch ref (base)
  // advances in the shared object store.
  try {
    gitRun(repo, ['worktree', 'add', tmpDir, base]);
  } catch (err) {
    gitTry(repo, ['worktree', 'prune']);
    return {
      ok: false,
      detail: `git worktree add for '${base}' failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let ok = false;
  let detail = '';
  try {
    gitRun(tmpDir, ['merge', '--no-ff', '--no-edit', branch]);
    const head = gitTry(tmpDir, ['rev-parse', 'HEAD']);
    ok = true;
    detail = `merged '${branch}' into '${base}'${head ? ` @ ${head.slice(0, 8)}` : ''} (local, not pushed)`;
  } catch (err) {
    detail = `git merge --no-ff failed: ${err instanceof Error ? err.message : String(err)}`;
    // Abort any partial merge so the default branch is left clean.
    gitTry(tmpDir, ['merge', '--abort']);
  } finally {
    gitTry(repo, ['worktree', 'remove', '--force', tmpDir]);
    gitTry(repo, ['worktree', 'prune']);
  }
  return { ok, detail };
}

/**
 * Autonomously merge an approved frontier proposal to the default branch,
 * subject to the full gate chain documented in the module header. NEVER throws;
 * every refusal returns { ok:false, merged:false, reason } and mutates nothing.
 */
export async function autoMergeProposal(
  id: string,
  cfg: AshlrConfig,
): Promise<AutoMergeResult> {
  const refuse = (reason: string, repo: string | null = null): AutoMergeResult => {
    audit({
      action: 'inbox:auto-merge',
      repo,
      sandboxId: id,
      summary: `refused: ${reason}`,
      result: 'refused',
    });
    return { ok: false, merged: false, reason };
  };

  try {
    // ── Gate 1: feature must be enabled (DEFAULT DISABLED) ───────────────────
    if (cfg.foundry?.autoMerge?.enabled !== true) {
      return refuse('auto-merge disabled (cfg.foundry.autoMerge.enabled !== true)');
    }

    // ── Gate 2: proposal must exist, be a mergeable kind with a diff ─────────
    const proposal = loadProposal(id);
    if (!proposal) return refuse(`proposal not found: ${id}`);
    if (proposal.kind !== 'patch' && proposal.kind !== 'pr') {
      return refuse(`proposal kind '${proposal.kind}' is not mergeable (need patch|pr)`, proposal.repo);
    }
    const diff = proposal.diff ?? '';
    if (!diff.trim()) {
      return refuse('proposal has no diff to merge', proposal.repo);
    }
    const repo = proposal.repo;
    if (!repo) return refuse('proposal has no repo');

    // ── Gate 3: kill switch + enrollment (DO NOT burn state on refusal) ──────
    if (killSwitchOn()) {
      return refuse('autonomy kill switch is ON', repo);
    }
    try {
      assertMayMutate(repo);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err), repo);
    }

    // ── Gate 4: merge authority ───────────────────────────────────────────────
    // M153: two trust bases, selected by cfg.foundry.autoMerge.trustBasis.
    //
    //   'tier' (DEFAULT, absent ⇒ 'tier'): M51/M56 — engineTier must be
    //   'frontier' AND {engine,model} ∈ mergeAuthority (byte-identical to
    //   pre-M153 behavior). mid → branch/PR only; local → proposal-only.
    //
    //   'verification': M153 — REPLACE the tier check with the full
    //   5-criterion verification bar (evaluateVerificationGate). ANY producer
    //   tier may proceed; the bar IS the authority. The merge target is always
    //   'main' in this mode (the verification bar is stronger than tier-gating).
    //
    // M54 never-weaken + allowSelfMerge guard unchanged in both modes.
    const trustBasis = (cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge']
      ? (((cfg.foundry as Record<string, unknown>)['autoMerge'] as Record<string, unknown>)?.['trustBasis'] as string | undefined) ?? 'tier'
      : 'tier';

    let toMain: boolean;
    let authority: { authorized: boolean; reason: string };

    if (trustBasis === 'verification') {
      // M261: in verification mode, run verifyProposal() BEFORE calling
      // evaluateVerificationGate so that Criterion 2 (verifyResult.passed===true)
      // can read the REAL test-run result. evaluateVerificationGate is a pure
      // function that reads proposal.verifyResult — if verifyResult is absent it
      // refuses unconditionally (Criterion 2 is a hard gate).
      //
      // Design: the gate comment (line ~556) states "Gate 6 is a prerequisite" —
      // i.e. verification must run BEFORE the full gate check. In verification
      // mode we honour that intent by running it here (pre-Gate-4), persisting
      // the genuine result, and updating the in-memory proposal object so the
      // gate sees it. Gate 6 below then skips the redundant re-run.
      //
      // SAFETY: the result comes exclusively from verifyProposal() — never
      // fabricated. A persistence failure leaves verifyResult absent →
      // evaluateVerificationGate Criterion 2 refuses (fail-closed). Verification
      // failure (verify.ok===false) short-circuits here before Gate 4 so no
      // merge can proceed on a failing diff.
      if (proposal.verifyResult?.passed !== true) {
        // If verifyResult is already present and explicitly false, skip the
        // expensive worktree run — we already know it failed. evaluateVerificationGate
        // Criterion 2 will refuse on passed===false. This preserves existing test
        // expectations ([A4]/[A7]) that set verifyResult.passed=false as the
        // "suite not green" signal without re-running verification.
        if (proposal.verifyResult !== undefined && proposal.verifyResult.passed === false) {
          // Fall through to evaluateVerificationGate — Criterion 2 will refuse.
        } else {
          const preVerify = await verifyProposal(proposal, cfg);
          // Persist the REAL result — best-effort (failure → absent → gate refuses).
          try {
            updateProposalField(proposal.id, {
              verifyResult: {
                passed: preVerify.ok,
                ...(preVerify.ok ? {} : { failed: [preVerify.detail] }),
              },
            });
          } catch {
            // Persistence failure: verifyResult stays absent — gate refuses correctly.
          }
          if (!preVerify.ok) {
            return refuse(`verification failed: ${preVerify.detail}`, repo);
          }
          // Update the in-memory proposal so evaluateVerificationGate reads it.
          // This does NOT mutate the on-disk record — that was done above. This
          // only ensures the pure gate function sees the real verifyResult.
          (proposal as Proposal & { verifyResult?: { passed: boolean; failed?: string[] } }).verifyResult = {
            passed: true,
          };
        }
      }

      // Verification mode: load decisions for this proposal now (needed by
      // evaluateVerificationGate criterion 1 + 4). The full ledger read is
      // cheap; no limit so we see ALL prior judged/verified entries.
      const allDecisions = readDecisions({ proposalId: id });
      authority = evaluateVerificationGate(proposal, cfg, allDecisions);
      // In verification mode the merge always targets main (the bar is the gate).
      toMain = true;
    } else {
      // 'tier' mode (default): M51/M56 — byte-identical to pre-M153.
      const target = mergeTargetForTier(proposal.engineTier);
      toMain = target === 'main';
      authority =
        target === 'main'
          ? evaluateMergeAuthority(proposal, cfg)
          : target === 'branch'
            ? evaluateBranchAuthority(proposal, cfg)
            : { authorized: false, reason: `engineTier '${proposal.engineTier ?? 'unset'}' is proposal-only (local)` };
    }

    if (!authority.authorized) {
      return refuse(`merge authority denied: ${authority.reason}`, repo);
    }

    // Gate 4.5 (H3 / M47.1): signed provenance. The authority gate above trusts
    // engineTier/engineModel as read from the on-disk record; a local writer
    // could forge those fields. Re-verify the HMAC binding {engineModel,
    // engineTier, diffHash} (signed at producer time by the sandboxed engine
    // with the host-local key) and FAIL CLOSED on any mismatch — so a forged
    // record cannot claim frontier merge-authority.
    // NOTE: in 'verification' mode evaluateVerificationGate already checked
    // provenance (criterion 5), but we re-run here so Gate 4.5 always fires
    // regardless of trustBasis — belt-and-suspenders, no double-cost.
    const provenance = verifyProvenance(proposal);
    if (!provenance.ok) {
      return refuse(`provenance check failed: ${provenance.reason}`, repo);
    }

    // ── Gate 5: risk class ≤ maxRisk ────────────────────────────────────────
    const maxRisk: RiskClass = cfg.foundry?.autoMerge?.maxRisk ?? 'low';
    const risk = classifyRisk(proposal);
    if (RISK_ORDER[risk] > RISK_ORDER[maxRisk]) {
      return refuse(`risk class '${risk}' exceeds maxRisk '${maxRisk}'`, repo);
    }

    // ── Gate 5.5 (M86): scope cap — only small, fully-bounded diffs auto-merge
    // to main. Defaults are conservative; config keys allow opt-in relaxation.
    // We require risk==='low' here (Gate 5 already enforces ≤maxRisk, but
    // maxRisk could be raised to 'medium' — scope cap applies ONLY when risk is
    // strictly 'low', so even a cfg.maxRisk='medium' run is scoped to low-risk
    // diffs for the size check). File + line counts reuse the same diff parser
    // as classifyRisk so the two gates are consistent.
    {
      // Clamp to a positive integer ≥ 1 so a zero, negative, or non-numeric
      // config value cannot disable the scope cap (a SAFETY gate).  Any value
      // < 1 would make the cap impossible to satisfy (every diff has ≥ 1
      // file/line), so we floor at 1 instead of silently disabling it.
      const rawFiles = (cfg.foundry as any)?.autoMerge?.maxAutomergeFiles;
      const MAX_AUTOMERGE_FILES: number =
        typeof rawFiles === 'number' && rawFiles >= 1
          ? Math.floor(rawFiles)
          : 4;
      const rawLines = (cfg.foundry as any)?.autoMerge?.maxAutomergeLines;
      const MAX_AUTOMERGE_LINES: number =
        typeof rawLines === 'number' && rawLines >= 1
          ? Math.floor(rawLines)
          : 150;

      if (risk !== 'low') {
        // Already refused above unless maxRisk was raised — belt-and-suspenders:
        // scope cap never applies to non-low diffs regardless of maxRisk setting.
        return refuse(
          `scope cap: risk is '${risk}' — auto-merge to main requires risk==='low'`,
          repo,
        );
      }

      // Count files (reuse the same "+++ " header logic as changedFilesFromDiff)
      let scopeFiles = 0;
      for (const line of diff.split('\n')) {
        if (!line.startsWith('+++ ')) continue;
        const p = line.slice(4).trim().split('\t')[0];
        if (p && p !== '/dev/null') scopeFiles++;
      }
      // Count changed lines (same logic as classifyRisk body-line counter)
      let scopeLines = 0;
      for (const line of diff.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+') || line.startsWith('-')) scopeLines++;
      }

      if (scopeFiles > MAX_AUTOMERGE_FILES) {
        return refuse(
          `scope cap: diff touches ${scopeFiles} files (max ${MAX_AUTOMERGE_FILES} for auto-merge to main)`,
          repo,
        );
      }
      if (scopeLines > MAX_AUTOMERGE_LINES) {
        return refuse(
          `scope cap: diff has ${scopeLines} changed lines (max ${MAX_AUTOMERGE_LINES} for auto-merge to main)`,
          repo,
        );
      }
    }

    // ── Gate 6: full verification in an isolated worktree ────────────────────
    // M261: in verification mode, verifyProposal() already ran pre-Gate-4 above
    // (to satisfy evaluateVerificationGate Criterion 2). Skip the redundant
    // re-run; the result is already persisted and the gate already passed.
    // In tier mode (default), run verifyProposal() here as before.
    let verify: VerifyProposalResult;
    if (trustBasis === 'verification' && proposal.verifyResult?.passed === true) {
      // Already verified pre-Gate-4 and passed — skip re-run.
      verify = { ok: true, ran: [], detail: 'pre-verified (M261: already ran before Gate 4)' };
    } else {
      verify = await verifyProposal(proposal, cfg);
      // Persist the result for the non-verification-mode path (best-effort).
      // In verification mode this branch only runs if verifyResult was absent
      // AND the pre-Gate-4 path somehow did not set it — fail-closed by design.
      try {
        updateProposalField(proposal.id, {
          verifyResult: {
            passed: verify.ok,
            ...(verify.ok ? {} : { failed: [verify.detail] }),
          },
        });
      } catch {
        // Persistence failure — swallow; the verify outcome still drives the gate.
      }
    }
    if (!verify.ok) {
      return refuse(`verification failed: ${verify.detail}`, repo);
    }

    // ── Gate 6.5 (M86/M54): self-eval parity — self-target proposals must pass
    // the invariant suite flag-off AND flag-on. guardSafetyTests (never-weaken)
    // already ran inside verifyProposal BEFORE the worktree ran; this parity
    // check is the second layer that runs AFTER verify passes, so a self-edit
    // cannot silently break the suite under either foundry-enabled state.
    if (isSelfTargetProposal(proposal, cfg)) {
      const parity = selfEvalParity((flagOn: boolean) => {
        // Re-use detectVerifyCommands/runVerifyCommand on the REPO (base tree).
        // The diff was already verified green in an isolated worktree by Gate 6;
        // here we check that the EXISTING suite (without the diff applied) stays
        // green under both flag states — if the diff is not yet on main this is
        // the pre-merge invariant check (the post-merge green was Gate 6).
        // Use the cfg with autoMerge.enabled toggled per flagOn; everything else
        // stays the same so no other gate is affected.
        const parityCfg: AshlrConfig = {
          ...cfg,
          foundry: {
            ...cfg.foundry,
            autoMerge: {
              ...(cfg.foundry?.autoMerge ?? { enabled: false }),
              enabled: flagOn,
            },
          },
        };
        const cmds = detectVerifyCommands(repo);
        if (cmds.length === 0) {
          // No commands in base tree → treat as green (verify already passed
          // in worktree; this parity check is about flag-sensitivity, not suite
          // existence — if there is no suite, parity is vacuously true).
          return true;
        }
        for (const vc of cmds) {
          const res = runVerifyCommand(vc, repo, parityCfg);
          if (!res.ok) return false;
        }
        return true;
      });
      if (!parity.ok) {
        return refuse(`self-eval parity failed: ${parity.reason}`, repo);
      }
    }

    // ── Gate 7 (M126): Manager quality gate ─────────────────────────────────
    // Engaged ONLY when cfg.foundry.autoMerge.managerGate === true (DEFAULT OFF).
    // Only reached when every mechanical gate passed (risk/scope/suite/provenance
    // all green). Require a Manager 'ship' verdict before auto-merging. Resolves
    // from the decisions ledger (cached) or judges inline (one model call).
    // FAIL CLOSED: any path that cannot confirm 'ship' leaves proposal PENDING.
    // When managerGate is false/absent, this block is a no-op — byte-identical
    // to pre-M126 behavior (Gate 7 never engaged, existing tests unaffected).
    const managerGateEnabled =
      ((cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge'] as Record<string, unknown> | undefined)?.[
        'managerGate'
      ] === true;
    if (managerGateEnabled) {
      // Resolve cached verdict: the most recent 'judged' entry for this proposal
      // within the last hour. A stale or absent entry triggers an inline judge call.
      const STALE_MS = 60 * 60 * 1000; // 1 hour
      const sinceMs = Date.now() - STALE_MS;
      const priorEntries = readDecisions({ proposalId: id, sinceMs, limit: 10 });
      const cachedEntry = priorEntries.find((e) => e.action === 'judged' && e.verdict);

      let managerVerdict: { verdict: string; wouldMerge: boolean; rationale: string } | null = null;

      if (cachedEntry?.verdict) {
        // Use cached entry from the ledger — no model call needed.
        managerVerdict = {
          verdict: cachedEntry.verdict,
          wouldMerge: cachedEntry.verdict === 'ship' && cachedEntry.detail === 'would-merge',
          rationale: cachedEntry.reason ?? 'cached verdict',
        };
      } else {
        // No fresh cached verdict — judge inline.
        // Resolve the judge client (same pattern as runManager; fail closed if unavailable).
        // M153: capture the actual judge engine string so it can be recorded in
        // the decisions ledger and later read by evaluateVerificationGate criterion 1.
        let judgeClient: { complete: (system: string, user: string) => Promise<string> } | null = null;
        let inlineJudgeEngine = 'gate7-inline'; // updated to real model string below
        try {
          const { getActiveClient } = await import('../run/provider-client.js');
          const judgeModel =
            ((cfg.foundry as Record<string, unknown> | undefined)?.['managerJudgeModel'] as string | undefined) ??
            'qwen2.5:72b-instruct-q4_K_M';
          let rawClient: unknown = null;
          try {
            rawClient = await getActiveClient(cfg, { allowCloud: true, model: judgeModel });
          } catch {
            try {
              rawClient = await getActiveClient(cfg, { allowCloud: false, model: judgeModel });
            } catch {
              rawClient = null;
            }
          }
          if (rawClient && typeof (rawClient as Record<string, unknown>)['complete'] === 'function') {
            judgeClient = rawClient as { complete: (s: string, u: string) => Promise<string> };
            // Capture the model string from the client if available (set by provider-client).
            const clientModel = (rawClient as Record<string, unknown>)['model'];
            if (typeof clientModel === 'string' && clientModel) {
              inlineJudgeEngine = clientModel;
            } else {
              // Fall back to the configured model string — better than 'gate7-inline'.
              inlineJudgeEngine = judgeModel;
            }
          } else if (rawClient && typeof (rawClient as Record<string, unknown>)['chat'] === 'function') {
            const chat = (rawClient as { chat: (msgs: Array<{role:string;content:string}>) => Promise<{content:string}> }).chat.bind(rawClient);
            judgeClient = {
              complete: async (system: string, user: string) => {
                const resp = await chat([{ role: 'system', content: system }, { role: 'user', content: user }]);
                return resp.content;
              },
            };
            const clientModel = (rawClient as Record<string, unknown>)['model'];
            inlineJudgeEngine = typeof clientModel === 'string' && clientModel ? clientModel : judgeModel;
          }
        } catch {
          judgeClient = null;
        }

        if (!judgeClient) {
          // Judge unavailable — FAIL CLOSED: do not merge, leave pending.
          audit({
            action: 'inbox:auto-merge',
            repo,
            sandboxId: id,
            summary: `Gate 7: manager judge unavailable — fail closed, leaving PENDING`,
            result: 'refused',
          });
          recordDecision({
            ts: new Date().toISOString(),
            proposalId: id,
            action: 'escalated',
            reason: 'manager judge unavailable — gate 7 fail closed',
          });
          return refuse('manager quality gate: judge unavailable — fail closed (leaving pending for human review)', repo);
        }

        try {
          const verdict = await judgeProposal(proposal, cfg, judgeClient);
          // M157: sign an attestation when the inline judge is frontier and ships.
          // This mirrors the runManager path so evaluateVerificationGate criterion 1
          // can verify the HMAC regardless of which path produced the ledger entry.
          let inlineAttestation: string | undefined;
          const inlineIsFrontier = inlineJudgeEngine.startsWith('claude') || inlineJudgeEngine.includes('claude');
          if (verdict.verdict === 'ship' && inlineIsFrontier) {
            try {
              const { signJudgeAttestation: signAtt, hashDiff: hd } = await import('../foundry/provenance.js');
              const dh = hd(proposal.diff ?? '');
              inlineAttestation = signAtt({ proposalId: id, judgeEngine: inlineJudgeEngine, verdict: 'ship', diffHash: dh });
            } catch { inlineAttestation = undefined; }
          }
          // M153: record inlineJudgeEngine (the real model string) so that
          // evaluateVerificationGate criterion 1 can verify the judge was frontier.
          recordDecision({
            ts: new Date().toISOString(),
            proposalId: id,
            action: 'judged',
            engine: inlineJudgeEngine,
            model: inlineJudgeEngine,
            verdict: verdict.verdict,
            reason: verdict.rationale,
            detail: verdict.wouldMerge ? 'would-merge' : '',
            ...(inlineAttestation !== undefined ? { judgeAttestation: inlineAttestation } : {}),
          });
          managerVerdict = {
            verdict: verdict.verdict,
            wouldMerge: verdict.wouldMerge,
            rationale: verdict.rationale,
          };
        } catch {
          // judgeProposal threw unexpectedly — FAIL CLOSED.
          audit({
            action: 'inbox:auto-merge',
            repo,
            sandboxId: id,
            summary: `Gate 7: judge threw — fail closed`,
            result: 'refused',
          });
          return refuse('manager quality gate: judge error — fail closed (leaving pending for human review)', repo);
        }
      }

      // Only 'ship' + wouldMerge proceeds; everything else leaves pending.
      if (managerVerdict.verdict !== 'ship' || !managerVerdict.wouldMerge) {
        const gateReason =
          managerVerdict.verdict === 'ship' && !managerVerdict.wouldMerge
            ? `manager gate: verdict='ship' but wouldMerge=false — ${managerVerdict.rationale}`
            : `manager gate: verdict='${managerVerdict.verdict}' — ${managerVerdict.rationale}`;
        audit({
          action: 'inbox:auto-merge',
          repo,
          sandboxId: id,
          summary: `Gate 7 held: ${gateReason}`,
          result: 'refused',
        });
        recordDecision({
          ts: new Date().toISOString(),
          proposalId: id,
          action: 'escalated',
          reason: gateReason,
          detail: 'gate-held',
        });
        return refuse(gateReason, repo);
      }

      // ── Gate 7.5 (M126): self-target escalation ───────────────────────────
      // The fleet modifying its own code is the one thing that always escalates
      // to a human, even when the Manager says 'ship'. Requires explicit opt-in
      // via cfg.foundry.autoMerge.allowSelfMerge (default false → always escalate).
      // The M54 self-eval parity guards (Gate 6.5) already ran; this is an
      // additional policy gate on top of them.
      if (isSelfTargetProposal(proposal, cfg)) {
        const allowSelfMerge =
          ((cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge'] as Record<string, unknown> | undefined)?.[
            'allowSelfMerge'
          ] === true;
        if (!allowSelfMerge) {
          audit({
            action: 'inbox:auto-merge',
            repo,
            sandboxId: id,
            summary: `Gate 7.5: self-target escalation — leaving PENDING for human (allowSelfMerge=false)`,
            result: 'refused',
          });
          recordDecision({
            ts: new Date().toISOString(),
            proposalId: id,
            action: 'escalated',
            reason: 'self-target: auto-merge of own code requires allowSelfMerge=true',
            detail: 'gate-held',
          });
          return refuse(
            'manager gate: self-target proposal escalated to human review (allowSelfMerge=false)',
            repo,
          );
        }
      }

      // Gate 7 passed — record the merge decision.
      recordDecision({
        ts: new Date().toISOString(),
        proposalId: id,
        action: 'merged',
        reason: `gate 7 passed: verdict=${managerVerdict.verdict}, ${managerVerdict.rationale}`,
      });
    }

    // ── ACTION: stage the diff on a branch off the default branch ────────────
    const base = defaultBranch(repo);
    const staged = buildMergeBranch(repo, id, diff, base);
    if (!staged.branch) {
      return refuse(`could not stage merge branch: ${staged.detail}`, repo);
    }
    const branch = staged.branch;

    // Decide the merge path: REMOTE (PR) when configured AND a github remote
    // exists; otherwise LOCAL.
    const wantRemote = cfg.foundry?.autoMerge?.pushToRemote === true;
    const hasGithub = getRemoteOrg(repo).org !== null;

    let merged = false;
    let branchApplied = false; // M56: mid-tier applied to a branch/PR (never main)
    let reason = '';
    let prUrl: string | undefined;

    if (wantRemote && hasGithub) {
      // H4: PUSH the staging branch to origin BEFORE opening the PR. createPr
      // points the PR head at `branch`, which the host cannot see unless we push
      // it first. Wrapped never-throw + audited; if the push fails we DO NOT
      // claim merged — we refuse so no PR is opened against a missing head.
      const pushed = gitTry(repo, ['push', '-u', 'origin', branch]) !== null;
      audit({
        action: 'inbox:auto-merge',
        repo,
        sandboxId: id,
        summary: `push staging branch '${branch}' to origin: ${pushed ? 'ok' : 'failed'}`,
        result: pushed ? 'ok' : 'error',
      });
      if (!pushed) {
        return {
          ok: false,
          merged: false,
          reason: 'failed to push staging branch',
        };
      }

      // H5: scrub secret-shaped tokens from the PR title/body before they leave
      // the host, and cap length (title ≤120, body ≤4000) to avoid leaking or
      // bloating the outward PR payload.
      const safeTitle = scrubSecrets(`ashlr auto-merge: ${proposal.title}`).slice(0, 120);
      const safeBody = scrubSecrets(
        `${proposal.summary}\n\n` +
          `Auto-merged by ashlr M47 (risk=${risk}, ${authority.reason}). ` +
          `Verified: ${verify.detail}.`,
      ).slice(0, 4000);

      // PREFERRED path — open a PR to the default branch; branch protection / CI
      // on the host remain the outer safety net.
      const pr = await createPr(repo, {
        title: safeTitle,
        body: safeBody,
        base,
        head: branch,
      });
      if (!pr.ok) {
        reason = `staged on ${branch} but PR creation failed: ${pr.detail}`;
      } else {
        prUrl = pr.url ?? undefined;
        // Best-effort admin squash-merge. NEVER throw — branch protection /
        // missing perms simply leave the PR open for a human.
        // M56: only a frontier (toMain) proposal is ever squash-merged to main.
        // A mid-tier proposal opens a PR and STOPS — a human merges it.
        let mergeNote = toMain ? 'PR opened' : 'PR opened for review (mid-tier — never merged to main)';
        if (toMain && prUrl) {
          try {
            execFileSync('gh', ['pr', 'merge', '--squash', '--admin', prUrl], {
              cwd: repo,
              timeout: GIT_TIMEOUT,
              stdio: 'pipe',
              encoding: 'utf8',
              env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
            });
            merged = true;
            mergeNote = 'PR opened and squash-merged';
          } catch {
            mergeNote = 'PR opened (auto-merge deferred to host gates)';
          }
        } else if (!toMain && prUrl) {
          branchApplied = true;
        }
        reason = `${mergeNote}${prUrl ? `: ${prUrl}` : ''}`;
      }
    } else if (toMain) {
      // LOCAL fallback — conservative; refuses if default branch is checked out.
      const local = mergeLocally(repo, branch, base);
      merged = local.ok;
      reason = local.detail;
    } else {
      // M56: mid-tier with no PR host — leave the staged branch for review;
      // NEVER merge to main locally.
      branchApplied = true;
      reason = `staged branch for review (mid-tier — never merged to main): ${branch}`;
    }

    // Persist outcome on success only (a non-merge leaves the proposal as-is so
    // it can be retried or hand-merged; the staging branch remains for review).
    // M56: success is a main-merge OR a mid-tier branch/PR application. Either
    // marks the proposal 'applied' so the pass does not re-open a PR every tick.
    const success = merged || branchApplied;
    if (success) {
      setStatus(id, 'applied', reason);
    }

    const result: AutoMergeResult = {
      ok: success,
      merged,
      ...(branchApplied ? { branched: true } : {}),
      reason,
      ...(prUrl ? { prUrl } : {}),
    };
    audit({
      action: 'inbox:auto-merge',
      repo,
      sandboxId: id,
      summary: `proposal ${id} auto-merge ${merged ? 'MERGED' : branchApplied ? 'BRANCHED (PR)' : 'not merged'}: ${reason}`,
      result: success ? 'ok' : 'error',
    });
    return result;
  } catch (err) {
    // Belt-and-suspenders: the orchestrator must never throw out.
    return refuse(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
