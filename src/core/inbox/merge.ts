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
 * ║     `gh pr merge --auto --squash` so branch protection / required checks   ║
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
import { existsSync, mkdirSync, writeFileSync, unlinkSync, symlinkSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type {
  AshlrConfig,
  AutoMergeTrustBasis,
  DecisionEntry,
  EngineTier,
  Proposal,
  ProposalBrowserVerifyEvidence,
  ProposalVerifyResult,
} from '../types.js';
import { loadProposal, setStatus, updateProposalField } from './store.js';
import { canonicalModelTag } from '../run/model-catalog.js';
import { assertMayMutate, killSwitchOn } from '../sandbox/policy.js';
import { audit } from '../sandbox/audit.js';
import { isRepo, getGitStatus, getRemoteOrg, defaultBranch } from '../git.js';
import { createPr } from '../integrations/github.js';
import { scrubSecrets } from '../knowledge/index.js';
import { isSelfTargetProposal, guardSafetyTests, selfEvalParityAsync } from '../fleet/self.js';
import { verifyProvenance, verifyJudgeAttestation, hashDiff } from '../foundry/provenance.js';
import { judgeProposal } from '../fleet/manager.js';
import { readDecisions, recordDecision } from '../fleet/decisions-ledger.js';
import { edvConfirmationWeight } from '../portfolio/edv-verify.js';
import {
  detectVerifyCommands,
  runVerifyCommandAsync,
  type VerifyCommand,
} from '../run/verify-commands.js';
import {
  isWebApp,
  verifyInBrowser,
  type BrowserVerifyResult,
} from '../run/browser-verify.js';
import { parseFailedTestIds } from '../run/completeness-gate.js';
import {
  buildAutonomyEvidencePack,
  persistAutonomyEvidencePack,
  type AutonomyGateEvidence,
} from '../autonomy/evidence-pack.js';
import { evaluateAutonomyPolicy } from '../autonomy/policy.js';
import { causalMetadataFromProposal, evidenceOutcomeSummary } from '../learning/causal.js';
import { acquireProposalMutationLock, releaseProposalMutationLock } from './proposal-mutation-lock.js';

function decisionReadIsHealthy(decisions: DecisionEntry[]): boolean {
  const quality = (decisions as DecisionEntry[] & {
    sourceQuality?: { sourceState?: string; complete?: boolean };
  }).sourceQuality;
  return quality === undefined || (quality.sourceState !== 'degraded' && quality.complete === true);
}

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

/** Resolve the commit that auto-merge treats as the current default-branch base. */
function resolveDefaultBranchHead(repo: string, base: string): string | null {
  return (
    gitTry(repo, ['rev-parse', '--verify', `refs/heads/${base}`]) ??
    gitTry(repo, ['rev-parse', '--verify', `refs/remotes/origin/${base}`]) ??
    gitTry(repo, ['rev-parse', 'HEAD'])
  );
}

/** Resolve the protected remote branch head without fetching or mutating refs. */
function resolveRemoteBranchHead(repo: string, base: string): string | null {
  const out = gitTry(repo, ['ls-remote', '--heads', 'origin', base]);
  if (!out) return null;
  const first = out.split('\n').find((line) => line.trim().length > 0);
  if (!first) return null;
  const [sha] = first.trim().split(/\s+/);
  return /^[0-9a-f]{40}$/i.test(sha ?? '') ? sha! : null;
}

/** Write `content` to a temp file under ~/.ashlr/tmp; caller cleans it up. */
function writeTmpFile(content: string): string {
  const dir = join(homedir(), '.ashlr', 'tmp');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = join(dir, `merge-${randomBytes(6).toString('hex')}.diff`);
  // M292: `git apply` rejects a patch whose final line lacks a trailing newline
  // ("corrupt patch at line N"). Captured sandbox diffs frequently end without
  // one, which made EVERY verify/merge git-apply fail → no proposal could ever
  // merge. Ensure a trailing newline on the apply temp file (does NOT touch the
  // stored proposal.diff or its provenance hash — only this throwaway apply file).
  const body = content.endsWith('\n') ? content : content + '\n';
  writeFileSync(p, body, 'utf8');
  return p;
}

/**
 * M293: symlink the source repo's node_modules into an isolated verify/merge
 * worktree so verify commands (npm run typecheck / tsc / vitest) resolve their
 * binaries. Without it, `npm run typecheck` exits 127 ("command not found") in
 * the bare worktree → verifyProposal fails → no proposal could ever merge.
 * (Same fix M286 applied to the sandboxed-engine worktree; verifyProposal + the
 * merge worktrees create their OWN worktrees which also need the toolchain.)
 * Best-effort, never-throws.
 */
function linkNodeModules(repo: string, worktreeDir: string): void {
  try {
    const src = join(repo, 'node_modules');
    const dst = join(worktreeDir, 'node_modules');
    if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst, 'dir');
  } catch {
    // best-effort — verify still attempted; absence just risks exit-127 which is handled
  }
}

// ===========================================================================
// 1) Risk classification (PURE)
// ===========================================================================

export type RiskClass = 'low' | 'medium' | 'high';

/** Total ordering for risk comparison: low < medium < high. */
const RISK_ORDER: Record<RiskClass, number> = { low: 0, medium: 1, high: 2 };

function normalizeDiffPath(raw: string): string | undefined {
  let p = raw.trim();
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  if (!p || p === '/dev/null') return undefined;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p || undefined;
}

/**
 * Extract the changed file paths from a unified diff. Includes both old and new
 * paths so deletion-only and rename diffs still trigger build/CI/manifest guards.
 */
function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  const add = (raw: string): void => {
    const p = normalizeDiffPath(raw);
    if (p) files.add(p);
  };
  for (const line of diff.split('\n')) {
    const gitHeader = line.match(/^diff --git (a\/.+?) (b\/.+)$/);
    if (gitHeader) {
      add(gitHeader[1]!);
      add(gitHeader[2]!);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      add(line.slice(4));
      continue;
    }
    if (line.startsWith('rename from ')) {
      add(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      add(line.slice('rename to '.length));
    }
  }
  return [...files];
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
    b === 'ashlr.verify.json' ||
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

  // ── MEDIUM: ordinary source changes ─────────────────────────────────────────
  // M295: ordinary source changes are MEDIUM, not HIGH. The genuinely-dangerous
  // cases already returned 'high' ABOVE this point: security/secret/auth/sandbox
  // surfaces, build/CI/dependency-manifest files, shell scripts, and LARGE diffs
  // (>10 files or >400 changed lines). What remains here is normal application
  // source — a multi-file feature/fix — whose real protection for autonomous
  // merge is the judge-ship verdict + verify (typecheck + tests-delta + lint-delta)
  // + frontier-authority + HMAC attestation, NOT a crude file-count heuristic.
  // Classifying every 2-file change as HIGH made maxRisk:'low' block essentially
  // all real work. (maxRisk default raised to 'medium' to match.)
  if (sourceFiles.length > 0) {
    return 'medium';
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

  // M320: spelling-variant-safe matching. engineModel strings and mergeAuthority
  // entries may pin the same model under different spellings ('sonnet-5' vs
  // 'claude-sonnet-5' vs a doubled 'claude:claude-sonnet-5') — canonicalModelTag
  // maps all of them onto one catalog tag so a spelling mismatch can never
  // silently disable auto-merge for an authorized model. The exact-string match
  // is checked first (byte-identical for every pre-M320 config).
  const sep = engineModel.indexOf(':');
  const pEngine = sep > 0 ? engineModel.slice(0, sep) : '';
  const pTag = sep > 0 ? canonicalModelTag(pEngine, engineModel.slice(sep + 1)) : '';
  const match = authority.some(
    (e) =>
      `${e.engine}:${e.model}` === engineModel ||
      (pEngine !== '' &&
        String(e.engine) === pEngine &&
        canonicalModelTag(e.engine, e.model) === pTag),
  );
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
// 2b) Auto-merge readiness preflight (PURE, cheap, no ledger/worktree/model I/O)
// ===========================================================================

export interface AutoMergeReadinessPreflightResult {
  /**
   * true means "do not block the judge call on cheap static grounds".
   * It does NOT mean the proposal will merge; autoMergeProposal remains the
   * source of truth for every merge gate.
   */
  ready: boolean;
  /** Present when ready=false. Mirrors the downstream gate reason where possible. */
  reason?: string;
  /** All current blockers are static/permanent until the proposal record changes. */
  permanent?: boolean;
  /** Non-blocking notes for observability; callers may surface them. */
  advisories: string[];
}

/**
 * Cheap preflight for runAutoMergePass before it spends a frontier judge call.
 *
 * This deliberately reuses the pure gate helpers below instead of re-encoding
 * policy. It only blocks on facts that are already present on the proposal
 * record and cannot be fixed by a fresh judge verdict: missing merge inputs,
 * known failed verification, impossible tier/branch authority in tier mode,
 * invalid provenance, and risk above the configured cap.
 *
 * It does NOT inspect decisions-ledger state, run verify commands, check repo
 * enrollment, or duplicate the full scope/EDV/attestation gates.
 */
export function evaluateAutoMergeReadinessPreflight(
  proposal: Proposal,
  cfg: AshlrConfig,
): AutoMergeReadinessPreflightResult {
  const ready = (advisories: string[] = []): AutoMergeReadinessPreflightResult => ({
    ready: true,
    advisories,
  });
  const block = (reason: string, advisories: string[] = []): AutoMergeReadinessPreflightResult => ({
    ready: false,
    reason,
    permanent: true,
    advisories,
  });

  try {
    if (proposal.kind !== 'patch' && proposal.kind !== 'pr') {
      return block(`proposal kind '${proposal.kind}' is not mergeable (need patch|pr)`);
    }

    const diff = proposal.diff ?? '';
    if (!diff.trim()) return block('proposal has no diff to merge');
    if (!proposal.repo) return block('proposal has no repo');

    if (proposal.verifyResult?.passed === false) {
      const failed = proposal.verifyResult.failed?.filter(Boolean).join('; ');
      return block(
        `known verification failure: proposal.verifyResult.passed is false${
          failed ? ` (${failed})` : ''
        }`,
      );
    }

    const trustBasis = (cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge']
      ? (((cfg.foundry as Record<string, unknown>)['autoMerge'] as Record<string, unknown>)?.['trustBasis'] as string | undefined) ?? 'tier'
      : 'tier';

    const advisories: string[] = [];
    if ((trustBasis === 'verification' || trustBasis === 'evidence') && proposal.verifyResult === undefined) {
      advisories.push('verification result absent; autoMergeProposal may run verify before the full gate');
    }

    if (trustBasis === 'evidence') {
      const evidencePreflight = evaluateEvidenceAutoMergePreflight(proposal, cfg, {
        requireVerificationEvidence: false,
      });
      if (!evidencePreflight.authorized) {
        return block(evidencePreflight.reason, advisories);
      }
    }

    if (trustBasis === 'tier') {
      const target = mergeTargetForTier(proposal.engineTier);
      const authority =
        target === 'main'
          ? evaluateMergeAuthority(proposal, cfg)
          : target === 'branch'
            ? evaluateBranchAuthority(proposal, cfg)
            : { authorized: false, reason: `engineTier '${proposal.engineTier ?? 'unset'}' is proposal-only (local)` };

      if (!authority.authorized) {
        return block(`merge authority denied: ${authority.reason}`, advisories);
      }
    }

    const provenance = verifyProvenance(proposal);
    if (!provenance.ok) {
      return block(`provenance check failed: ${provenance.reason}`, advisories);
    }

    const maxRisk: RiskClass = ((cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge'] as Record<string, unknown> | undefined)?.['maxRisk'] as RiskClass ?? 'low';
    const risk = classifyRisk(proposal);
    if (RISK_ORDER[risk] > RISK_ORDER[maxRisk]) {
      return block(`risk class '${risk}' exceeds maxRisk '${maxRisk}'`, advisories);
    }

    return ready(advisories);
  } catch (err) {
    return block(`readiness preflight error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ===========================================================================
// 2c) Auto-merge gate explainer (PURE, read-only, shared display surface)
// ===========================================================================

export type AutoMergeGateCheckCode =
  | 'auto-merge-disabled'
  | 'proposal-missing'
  | 'proposal-kind'
  | 'missing-diff'
  | 'missing-repo'
  | 'merge-authority'
  | 'verification-gate'
  | 'missing-judge-evidence'
  | 'missing-verification-evidence'
  | 'missing-edv-evidence'
  | 'provenance'
  | 'evidence-preflight'
  | 'remote-protection'
  | 'risk-threshold'
  | 'scope-cap'
  | 'self-target-safety'
  | 'self-target-policy'
  | 'manager-gate';

export interface AutoMergeGateCheck {
  gate: string;
  code: AutoMergeGateCheckCode;
  ok: boolean;
  detail: string;
}

export interface AutoMergeGateFacts {
  trustBasis: AutoMergeTrustBasis;
  target: MergeTarget | 'main';
  maxRisk: RiskClass;
  risk?: RiskClass;
  scopeFiles?: number;
  scopeLines?: number;
  maxFiles?: number;
  maxLines?: number;
  selfTarget?: boolean;
  allowSelfMerge?: boolean;
}

export interface AutoMergeGateExplanation {
  mergeable: boolean;
  reason: string;
  checks: AutoMergeGateCheck[];
  blockers: AutoMergeGateCheck[];
  advisories: string[];
  facts: AutoMergeGateFacts;
}

export interface ExplainAutoMergeGateOptions {
  /**
   * Decision entries already loaded by the caller. Required for explaining the
   * verification trust basis without reading the decisions ledger here.
   */
  decisionsForProposal?: DecisionEntry[];
  /**
   * Pass true when the caller already knows the proposal targets ashlr-hub's own
   * source. The explainer stays pure/read-only and never probes package.json.
   */
  selfTarget?: boolean;
  /**
   * Optional manager verdict supplied by a caller that already has one. When the
   * manager gate is enabled and this is absent, the explainer reports missing
   * evidence instead of invoking a judge.
   */
  managerVerdict?: { verdict: string; wouldMerge: boolean; rationale?: string };
}

function autoMergeConfigValue(cfg: AshlrConfig, key: string): unknown {
  return ((cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge'] as Record<string, unknown> | undefined)?.[key];
}

function configuredTrustBasis(cfg: AshlrConfig): AutoMergeTrustBasis {
  const value = autoMergeConfigValue(cfg, 'trustBasis');
  return value === 'verification' || value === 'evidence' ? value : 'tier';
}

function configuredMaxRisk(cfg: AshlrConfig): RiskClass {
  const value = autoMergeConfigValue(cfg, 'maxRisk');
  return value === 'medium' || value === 'high' ? value : 'low';
}

function configuredScopeCaps(cfg: AshlrConfig): { maxFiles: number; maxLines: number } {
  const rawFiles = autoMergeConfigValue(cfg, 'maxAutomergeFiles');
  const rawLines = autoMergeConfigValue(cfg, 'maxAutomergeLines');
  return {
    maxFiles: typeof rawFiles === 'number' && rawFiles >= 1 ? Math.floor(rawFiles) : 4,
    maxLines: typeof rawLines === 'number' && rawLines >= 1 ? Math.floor(rawLines) : 150,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function countDiffScope(diff: string): { files: number; lines: number } {
  let files = 0;
  let lines = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim().split('\t')[0];
      if (p && p !== '/dev/null') files++;
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) lines++;
  }
  return { files, lines };
}

export interface EvidenceRemoteProtectionSignal {
  ok: boolean;
  detail: string;
  requiredChecks: string[];
}

export interface EvidenceAutoMergePreflightOptions {
  /** Whether the proposal targets Ashlr Hub's own source. */
  selfTarget?: boolean;
  /** Pass false when the caller already knows there is no GitHub remote. */
  remoteAvailable?: boolean;
  /**
   * When false, skip verification-result checks so daemon preflight can still
   * run verification later. The mutating merge gate uses the default true.
   */
  requireVerificationEvidence?: boolean;
}

export function evaluateEvidenceRemoteProtectionSignal(cfg: AshlrConfig): EvidenceRemoteProtectionSignal {
  const signal = autoMergeConfigValue(cfg, 'protectedRemote');
  if (!isObjectRecord(signal)) {
    return {
      ok: false,
      detail: 'missing foundry.autoMerge.protectedRemote branch-protection evidence',
      requiredChecks: [],
    };
  }
  const requiredChecks = Array.isArray(signal['requiredChecks'])
    ? signal['requiredChecks'].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  if (signal['branchProtection'] !== true) {
    return {
      ok: false,
      detail: 'branch protection is not confirmed for the remote default branch',
      requiredChecks,
    };
  }
  if (requiredChecks.length === 0) {
    return {
      ok: false,
      detail: 'required remote checks are not declared for the protected default branch',
      requiredChecks,
    };
  }
  return {
    ok: true,
    detail: `protected remote confirmed with required checks: ${requiredChecks.join(', ')}`,
    requiredChecks,
  };
}

/**
 * Evidence-mode activation contract. This helper is intentionally stricter
 * than the generic merge gates because trustBasis:"evidence" skips the judge:
 * it requires signed, command-bound verification and a protected remote PR
 * handoff instead of local main mutation.
 */
export function evaluateEvidenceAutoMergePreflight(
  proposal: Proposal,
  cfg: AshlrConfig,
  options: EvidenceAutoMergePreflightOptions = {},
): VerificationGateVerdict {
  const refuse = (reason: string): VerificationGateVerdict => ({
    authorized: false,
    reason: `evidence preflight: ${reason}`,
  });

  if (configuredTrustBasis(cfg) !== 'evidence') {
    return {
      authorized: true,
      reason: 'evidence preflight skipped: trustBasis is not evidence',
    };
  }

  if (cfg.foundry?.autoMerge?.allowWithoutVerification === true) {
    return refuse('allowWithoutVerification=true is not permitted in evidence mode');
  }
  if (cfg.foundry?.autoMerge?.pushToRemote !== true) {
    return refuse('pushToRemote=true is required; local merge fallback is not permitted in evidence mode');
  }
  if (options.remoteAvailable === false) {
    return refuse('a GitHub remote is required for protected remote PR handoff');
  }

  const remoteProtection = evaluateEvidenceRemoteProtectionSignal(cfg);
  if (!remoteProtection.ok) {
    return refuse(`protected remote signal missing: ${remoteProtection.detail}`);
  }

  if (options.selfTarget === true) {
    return refuse('self-target merges require judge or human review; evidence mode never self-merges');
  }
  if (proposal.isPartial === true) {
    return refuse('partial/timeout-captured proposals require judge or human review');
  }

  const changedFiles = changedFilesFromDiff(proposal.diff ?? '');
  if (changedFiles.some(isBuildOrCiOrManifest)) {
    return refuse('diff touches build/CI/manifest files — judge or human review required');
  }

  const guard = guardSafetyTests(proposal.diff ?? '');
  if (guard.weakened) {
    return refuse(`test-weakening change refused: ${guard.reason}`);
  }

  const provenance = verifyProvenance(proposal);
  if (!provenance.ok) {
    return refuse(`signed provenance is required: ${provenance.reason}`);
  }

  if (options.requireVerificationEvidence === false) {
    return {
      authorized: true,
      reason: `evidence preflight cleared before verification: ${remoteProtection.detail}`,
    };
  }

  if (!hasVerifiedBaseBinding(proposal.verifyResult)) {
    if (proposal.verifyResult?.passed === true) {
      return refuse('base-bound verification is missing — reverify required');
    }
    return refuse(
      `proposal.verifyResult.passed is ${
        proposal.verifyResult === undefined ? 'absent' : 'false'
      } — deterministic merge requires suite green`,
    );
  }
  if (!hasVerifiedDiffBinding(proposal)) {
    return refuse('verification diff binding is missing or stale — reverify required');
  }
  if (!proposal.verifyResult.ran || proposal.verifyResult.ran.length === 0) {
    return refuse('no verification command evidence recorded; no-command verification is not eligible');
  }
  if (!hasRequiredVerificationCommandEvidence(proposal.verifyResult)) {
    return refuse('no required verification command evidence recorded; advisory-only verification is not eligible');
  }

  return {
    authorized: true,
    reason: `evidence preflight cleared: command-bound verification and ${remoteProtection.detail}`,
  };
}

function verificationBlockerCode(reason: string): AutoMergeGateCheckCode {
  if (reason.includes('protected remote') || reason.includes('pushToRemote') || reason.includes('GitHub remote')) {
    return 'remote-protection';
  }
  if (reason.includes('evidence preflight') || reason.includes('allowWithoutVerification')) {
    return 'evidence-preflight';
  }
  if (reason.includes("no 'judged' decision") || reason.includes('judge attestation invalid')) {
    return 'missing-judge-evidence';
  }
  if (reason.includes('proposal.verifyResult.passed') || reason.includes('base-bound verification')) {
    return 'missing-verification-evidence';
  }
  if (reason.includes('EDV independent confirmation absent')) return 'missing-edv-evidence';
  if (reason.includes('risk class')) return 'risk-threshold';
  if (reason.includes('scope cap')) return 'scope-cap';
  if (reason.includes('provenance check failed')) return 'provenance';
  return 'verification-gate';
}

/**
 * Explain, without side effects, whether the proposal is auto-mergeable from
 * the evidence the caller already has. This is a display/helper surface for CLI,
 * API, and UI: it never reads the inbox, decisions ledger, git state, enrollment
 * policy, or package.json; it never runs verification or a judge.
 *
 * The mutating source of truth remains autoMergeProposal(). This helper reuses
 * the same pure gate functions for authority, verification trust, provenance,
 * risk, and self-target safety so display explanations follow gate behavior.
 */
export function explainAutoMergeGate(
  proposal: Proposal | null | undefined,
  cfg: AshlrConfig,
  options: ExplainAutoMergeGateOptions = {},
): AutoMergeGateExplanation {
  const checks: AutoMergeGateCheck[] = [];
  const advisories: string[] = [
    'read-only explainer: mutation-time gates still re-check kill switch, enrollment, git state, verification, evidence persistence, and merge/PR execution',
  ];
  const trustBasis = configuredTrustBasis(cfg);
  const maxRisk = configuredMaxRisk(cfg);
  const caps = configuredScopeCaps(cfg);
  const facts: AutoMergeGateFacts = {
    trustBasis,
    target: 'none',
    maxRisk,
    maxFiles: caps.maxFiles,
    maxLines: caps.maxLines,
  };
  const add = (gate: string, code: AutoMergeGateCheckCode, ok: boolean, detail: string): void => {
    checks.push({ gate, code, ok, detail });
  };
  const finish = (): AutoMergeGateExplanation => {
    const blockers = checks.filter((check) => !check.ok);
    return {
      mergeable: blockers.length === 0,
      reason:
        blockers.length === 0
          ? 'auto-merge gates are satisfied by available read-only evidence'
          : blockers[0]!.detail,
      checks,
      blockers,
      advisories,
      facts,
    };
  };

  if (cfg.foundry?.autoMerge?.enabled !== true) {
    add('config', 'auto-merge-disabled', false, 'auto-merge disabled (cfg.foundry.autoMerge.enabled !== true)');
    return finish();
  }
  add('config', 'auto-merge-disabled', true, 'auto-merge is enabled');

  if (!proposal) {
    add('proposal', 'proposal-missing', false, 'proposal not found');
    return finish();
  }

  if (proposal.kind !== 'patch' && proposal.kind !== 'pr') {
    add('proposal', 'proposal-kind', false, `proposal kind '${proposal.kind}' is not mergeable (need patch|pr)`);
    return finish();
  }
  add('proposal', 'proposal-kind', true, `proposal kind '${proposal.kind}' is mergeable`);

  const diff = proposal.diff ?? '';
  if (!diff.trim()) {
    add('proposal', 'missing-diff', false, 'proposal has no diff to merge');
    return finish();
  }
  add('proposal', 'missing-diff', true, 'proposal has a diff');

  if (!proposal.repo) {
    add('proposal', 'missing-repo', false, 'proposal has no repo');
    return finish();
  }
  add('proposal', 'missing-repo', true, 'proposal has a target repo');

  if (trustBasis === 'verification') {
    facts.target = 'main';
    const verdict = evaluateVerificationGate(proposal, cfg, options.decisionsForProposal ?? []);
    add('authority', verificationBlockerCode(verdict.reason), verdict.authorized, verdict.reason);
  } else if (trustBasis === 'evidence') {
    facts.target = 'main';
    const verdict = evaluateEvidenceGate(proposal, cfg, options.decisionsForProposal ?? []);
    add('authority', verificationBlockerCode(verdict.reason), verdict.authorized, verdict.reason);
  } else {
    const target = mergeTargetForTier(proposal.engineTier);
    facts.target = target;
    const authority =
      target === 'main'
        ? evaluateMergeAuthority(proposal, cfg)
        : target === 'branch'
          ? evaluateBranchAuthority(proposal, cfg)
          : { authorized: false, reason: `engineTier '${proposal.engineTier ?? 'unset'}' is proposal-only (local)` };
    add('authority', 'merge-authority', authority.authorized, authority.reason);
  }

  const provenance = verifyProvenance(proposal);
  add(
    'provenance',
    'provenance',
    provenance.ok,
    provenance.ok ? provenance.reason ?? 'valid signed provenance' : `provenance check failed: ${provenance.reason}`,
  );

  const risk = classifyRisk(proposal);
  facts.risk = risk;
  add(
    'risk',
    'risk-threshold',
    RISK_ORDER[risk] <= RISK_ORDER[maxRisk],
    RISK_ORDER[risk] <= RISK_ORDER[maxRisk]
      ? `risk class '${risk}' is within maxRisk '${maxRisk}'`
      : `risk class '${risk}' exceeds maxRisk '${maxRisk}'`,
  );

  const scope = countDiffScope(diff);
  facts.scopeFiles = scope.files;
  facts.scopeLines = scope.lines;
  add(
    'scope',
    'scope-cap',
    scope.files <= caps.maxFiles && scope.lines <= caps.maxLines,
    scope.files <= caps.maxFiles && scope.lines <= caps.maxLines
      ? `scope is within caps (${scope.files} file(s), ${scope.lines} line(s); max ${caps.maxFiles}/${caps.maxLines})`
      : `scope cap exceeded (${scope.files} file(s), ${scope.lines} line(s); max ${caps.maxFiles}/${caps.maxLines})`,
  );

  if (proposal.verifyResult?.passed !== true) {
    add(
      'verification',
      'missing-verification-evidence',
      false,
      proposal.verifyResult?.passed === false
        ? `verification did not pass: ${proposal.verifyResult.detail ?? proposal.verifyResult.failed?.join('; ') ?? 'failed'}`
        : 'verification evidence is missing: proposal.verifyResult.passed must be true',
    );
  } else {
    add('verification', 'missing-verification-evidence', true, proposal.verifyResult.detail ?? 'verification passed');
  }

  const selfTarget = options.selfTarget === true;
  facts.selfTarget = selfTarget;
  const allowSelfMerge = autoMergeConfigValue(cfg, 'allowSelfMerge') === true;
  facts.allowSelfMerge = allowSelfMerge;
  if (selfTarget) {
    const guard = guardSafetyTests(diff);
    add(
      'self-target',
      'self-target-safety',
      !guard.weakened,
      guard.weakened ? `self-target guard: ${guard.reason}` : 'self-target safety guard did not detect weakening',
    );
    add(
      'self-target',
      'self-target-policy',
      allowSelfMerge,
      allowSelfMerge
        ? 'self-target auto-merge is explicitly allowed'
        : 'self-target autonomous merge requires cfg.foundry.autoMerge.allowSelfMerge=true',
    );
  }

  const managerGateEnabled = autoMergeConfigValue(cfg, 'managerGate') === true;
  if (managerGateEnabled) {
    const verdict = options.managerVerdict;
    if (!verdict) {
      add('manager', 'manager-gate', false, 'manager quality gate evidence is missing');
    } else {
      add(
        'manager',
        'manager-gate',
        verdict.verdict === 'ship' && verdict.wouldMerge === true,
        verdict.verdict === 'ship' && verdict.wouldMerge === true
          ? `manager gate passed: verdict='${verdict.verdict}', wouldMerge=true`
          : `manager gate blocked: verdict='${verdict.verdict}', wouldMerge=${verdict.wouldMerge}${verdict.rationale ? ` — ${verdict.rationale}` : ''}`,
      );
    }
  }

  return finish();
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
  // claude-* (existing — primary frontier judge)
  if (lc.startsWith('claude') || lc.includes('claude')) return true;
  // M300: Codex/OpenAI frontier models — gpt-5.x and codex-* are genuine frontier
  // models already listed in cfg.foundry.mergeAuthority as {engine:'codex',model:'gpt-5.5'}.
  // Accepting them here lets a Codex judge produce a valid ship attestation; the
  // HMAC gate + mergeAuthority list + full scoring gate are ALL unchanged.
  // gpt-4* is intentionally excluded (gpt-4-mini etc. are not frontier-tier judges).
  if (lc.startsWith('gpt-5') || lc.startsWith('codex-') || lc === 'codex') return true;
  return false;
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
  decisionsForProposal: Array<{
    action: string;
    ts?: string;
    verdict?: string;
    engine?: string;
    model?: string;
    detail?: string;
    judgeAttestation?: string;
    judgeAttestationIssuedAt?: string;
    judgeAttestationIntent?: 'would-merge';
  }>,
): VerificationGateVerdict {
  const refuse = (reason: string): VerificationGateVerdict => ({ authorized: false, reason });

  // ── Criterion 1: HMAC-signed frontier judge 'ship' attestation ────────────
  // M157: Replace unsigned-ledger scan with cryptographic verification.
  // A forged ledger entry claiming "judged claude ship" without a valid
  // HMAC-signed attestation will FAIL here — the core security fix.
  //
  // Steps:
  //   (a) Find the most recent 'judged' entry, sorted by ts when available.
  //   (b) Require verdict='ship' on that newest judged entry.
  //   (c) Verify the judge engine is a frontier (claude-*) model.
  //   (d) Verify the HMAC attestation — recomputed from (proposalId, judgeEngine,
  //       verdict, diffHash-of-CURRENT-diff). A stale attestation for a different
  //       proposalId, a changed diff, or no attestation at all → REFUSE.
  const judgedEntries = decisionsForProposal
    .map((d, index) => ({ d, index }))
    .filter(({ d }) => d.action === 'judged')
    .sort((a, b) => {
      const aMs = typeof a.d.ts === 'string' ? Date.parse(a.d.ts) : NaN;
      const bMs = typeof b.d.ts === 'string' ? Date.parse(b.d.ts) : NaN;
      const aValid = Number.isFinite(aMs);
      const bValid = Number.isFinite(bMs);
      if (aValid && bValid && aMs !== bMs) return bMs - aMs;
      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      return a.index - b.index;
    });

  const shipEntry = judgedEntries[0]?.d;
  if (!shipEntry) {
    return refuse(
      "verification gate: no 'judged' decision found for this proposal — a frontier judge must explicitly ship it",
    );
  }
  if (shipEntry.verdict !== 'ship') {
    return refuse(
      `verification gate: most recent judged decision verdict='${shipEntry.verdict ?? 'unknown'}', not 'ship' — ` +
        `a newer non-ship verdict overrides any older ship attestation`,
    );
  }
  if (shipEntry.detail !== 'would-merge') {
    return refuse(
      `verification gate: most recent judged ship is not merge-authoritative ` +
        `(detail='${shipEntry.detail ?? 'missing'}') — judge must explicitly set wouldMerge=true`,
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
    ...(shipEntry.judgeAttestationIssuedAt !== undefined
      ? {
          issuedAt: shipEntry.judgeAttestationIssuedAt,
          mergeIntent: shipEntry.judgeAttestationIntent,
        }
      : {}),
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
    decisionsForProposal as Array<{ action: 'proposed' | 'verified' | 'judged' | 'merged' | 'handoff' | 'rejected' | 'escalated'; ts: string; proposalId: string; engine?: string; model?: string; verdict?: string; reason?: string; detail?: string }>,
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

/**
 * Evidence-strength authority gate for judge-free autonomous merge.
 *
 * This is intentionally separate from trustBasis='verification'. Verification
 * mode keeps the frontier judge requirement. Evidence mode trades that model
 * opinion for stricter deterministic proof: base-bound suite green, valid
 * provenance, low/scope-bounded diff, EDV confirmation, no partial capture, and
 * no build/CI/manifest changes that could rewrite the verifier.
 */
export function evaluateEvidenceGate(
  proposal: Proposal,
  cfg: AshlrConfig,
  decisionsForProposal: DecisionEntry[],
): VerificationGateVerdict {
  const refuse = (reason: string): VerificationGateVerdict => ({ authorized: false, reason });

  const activation = evaluateEvidenceAutoMergePreflight(proposal, cfg);
  if (!activation.authorized) return activation;

  if (proposal.isPartial === true) {
    return refuse('evidence gate: partial/timeout-captured proposals require judge or human review');
  }

  if (!hasVerifiedBaseBinding(proposal.verifyResult)) {
    if (proposal.verifyResult?.passed === true) {
      return refuse('evidence gate: base-bound verification is missing — reverify required');
    }
    return refuse(
      `evidence gate: proposal.verifyResult.passed is ${
        proposal.verifyResult === undefined ? 'absent' : 'false'
      } — deterministic merge requires suite green`,
    );
  }
  if (!hasVerifiedDiffBinding(proposal)) {
    return refuse('evidence gate: verification diff binding is missing or stale — reverify required');
  }

  const diff = proposal.diff ?? '';
  const changedFiles = changedFilesFromDiff(diff);
  if (changedFiles.some(isBuildOrCiOrManifest)) {
    return refuse('evidence gate: diff touches build/CI/manifest files — judge or human review required');
  }

  const provenance = verifyProvenance(proposal);
  if (!provenance.ok) {
    return refuse(`evidence gate: provenance check failed — ${provenance.reason}`);
  }

  const risk = classifyRisk(proposal);
  const maxRisk = configuredMaxRisk(cfg);
  if (RISK_ORDER[risk] > RISK_ORDER[maxRisk]) {
    return refuse(`evidence gate: risk class '${risk}' exceeds maxRisk '${maxRisk}'`);
  }

  const scope = countDiffScope(diff);
  const caps = configuredScopeCaps(cfg);
  if (scope.files > caps.maxFiles) {
    return refuse(`evidence gate: scope cap — diff touches ${scope.files} files (max ${caps.maxFiles})`);
  }
  if (scope.lines > caps.maxLines) {
    return refuse(`evidence gate: scope cap — diff has ${scope.lines} changed lines (max ${caps.maxLines})`);
  }

  const edvResult = edvConfirmationWeight(proposal, decisionsForProposal, cfg);
  if (!edvResult.confirmed) {
    return refuse(
      `evidence gate: EDV independent confirmation absent (source='${edvResult.source}', weight=${edvResult.weight}) — deterministic merge requires objective confirmation`,
    );
  }

  return {
    authorized: true,
    reason: `evidence gate cleared: base-bound suite green (${proposal.verifyResult.baseBranch}@${proposal.verifyResult.baseHead.slice(0, 8)}); risk=${risk}≤${maxRisk}; scope ok (${scope.files}f/${scope.lines}l); EDV confirmed; provenance valid`,
  };
}

// ===========================================================================
// 4) verifyProposal — apply diff to an isolated worktree + run verify commands
// ===========================================================================

export interface VerifyProposalResult {
  ok: boolean;
  ran: VerifyCommand[];
  detail: string;
  browser?: ProposalBrowserVerifyEvidence;
  /** Default branch name whose head was used to create the verify worktree. */
  baseBranch?: string;
  /** Exact commit checked out before applying the proposal diff in verification. */
  baseHead?: string;
}

export function verifyResultFromProposalResult(
  result: VerifyProposalResult,
  source: ProposalVerifyResult['source'] = 'auto-merge',
  verifiedAt = new Date().toISOString(),
  diffHash?: string,
): ProposalVerifyResult {
  return {
    passed: result.ok,
    ...(result.ok ? {} : { failed: [result.detail] }),
    detail: result.detail,
    ran: [...result.ran],
    ...(result.browser ? { browser: result.browser } : {}),
    ...(result.baseBranch ? { baseBranch: result.baseBranch } : {}),
    ...(result.baseHead ? { baseHead: result.baseHead } : {}),
    ...(diffHash ? { diffHash } : {}),
    verifiedAt,
    source,
  };
}

function hasVerifiedBaseBinding(
  result: ProposalVerifyResult | undefined,
): result is ProposalVerifyResult & { passed: true; baseBranch: string; baseHead: string } {
  return (
    result?.passed === true &&
    typeof result.baseBranch === 'string' &&
    result.baseBranch.length > 0 &&
    typeof result.baseHead === 'string' &&
    result.baseHead.length > 0
  );
}

function currentProposalDiffHash(proposal: Proposal): string {
  return hashDiff(proposal.diff ?? '');
}

function hasVerifiedDiffBinding(
  proposal: Proposal,
): proposal is Proposal & { verifyResult: ProposalVerifyResult & { passed: true; baseBranch: string; baseHead: string; diffHash: string } } {
  return (
    hasVerifiedBaseBinding(proposal.verifyResult) &&
    proposal.verifyResult.diffHash === currentProposalDiffHash(proposal)
  );
}

function hasRequiredVerificationCommandEvidence(result: ProposalVerifyResult | undefined): boolean {
  return Array.isArray(result?.ran) && result.ran.some((command) => command.required !== false);
}

function verifyCommandIdentity(command: VerifyCommand): string {
  return JSON.stringify([command.id ?? null, command.cwd ?? '.', command.cmd]);
}

function verifyResultFromStored(result: ProposalVerifyResult): VerifyProposalResult {
  return {
    ok: result.passed,
    ran: result.ran ?? [],
    detail: result.detail ?? (result.passed ? 'pre-verified' : 'stored verification failed'),
    ...(result.browser ? { browser: result.browser } : {}),
    ...(result.baseBranch ? { baseBranch: result.baseBranch } : {}),
    ...(result.baseHead ? { baseHead: result.baseHead } : {}),
  };
}

function truncateEvidenceText(text: string, limit = 500): string {
  const scrubbed = scrubSecrets(text);
  return scrubbed.length <= limit ? scrubbed : `${scrubbed.slice(0, limit - 16)}...[truncated]`;
}

function browserEvidenceFromResult(result: BrowserVerifyResult): ProposalBrowserVerifyEvidence {
  return {
    ok: result.ok,
    renderOk: result.renderOk,
    consoleErrorCount: result.consoleErrors.length,
    screenshotCaptured: result.screenshotPath !== undefined,
    detail: truncateEvidenceText(result.detail),
    ...(result.visualGrounding ? { visualGrounding: result.visualGrounding } : {}),
  };
}

async function verifyProposalInBrowser(
  worktreeDir: string,
  cfg: AshlrConfig,
): Promise<ProposalBrowserVerifyEvidence | null> {
  if ((cfg.foundry as { browserVerify?: boolean } | undefined)?.browserVerify !== true) return null;
  if (!isWebApp(worktreeDir)) return null;
  const result = await verifyInBrowser(worktreeDir, cfg);
  if (result.skipped) return null;
  return browserEvidenceFromResult(result);
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
  const baseHead = resolveDefaultBranchHead(repo, base);
  if (!baseHead) {
    return { ok: false, ran: [], detail: `could not resolve head of default branch '${base}'`, baseBranch: base };
  }

  const tmpBranch = `ashlr/verify/${randomBytes(6).toString('hex')}`;
  const tmpDir = join(homedir(), '.ashlr', 'tmp', `vwt-${randomBytes(6).toString('hex')}`);

  // Create the isolated worktree on a scratch branch off the default-branch head.
  try {
    gitRun(repo, ['worktree', 'add', '-b', tmpBranch, tmpDir, baseHead]);
    linkNodeModules(repo, tmpDir);
  } catch (err) {
    gitTry(repo, ['worktree', 'prune']);
    return {
      ok: false,
      ran: [],
      detail: `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
      baseBranch: base,
      baseHead,
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
    const commands = detectVerifyCommands(tmpDir, 'merge');
    if (commands.length === 0) {
      const allow = cfg.foundry?.autoMerge?.allowWithoutVerification === true;
      return {
        ok: allow,
        ran: [],
        detail: allow
          ? 'no verify commands detected; allowWithoutVerification=true → passing'
          : 'no verify commands detected and allowWithoutVerification=false → fail-closed',
        baseBranch: base,
        baseHead,
      };
    }
    if (!commands.some((command) => command.required !== false)) {
      return {
        ok: false,
        ran: [],
        detail: 'merge profile has only advisory commands; required verification is fail-closed',
        baseBranch: base,
        baseHead,
      };
    }

    // M281: For test commands, record the BASELINE result BEFORE applying
    // the patch (worktree is still on the clean default-branch HEAD at this point).
    // Typecheck is NOT delta-aware — it must be clean in the patched tree.
    const baselineResults = new Map<string, { ok: boolean; ids: Set<string> }>();
    for (const vc of commands) {
      // M281: test commands → delta-aware (named-id set diff).
      // M293: lint is ALSO delta-aware — the repo carries large pre-existing lint
      // debt (hundreds of errors) that is NOT a correctness signal; a clean, typed,
      // tested change must not be blocked by lint debt it did not introduce. Baseline
      // lint and tolerate pre-existing failures (block only a clean→failing regression).
      if (vc.id === undefined && vc.required === undefined && (vc.kind === 'test' || vc.kind === 'lint')) {
        const baseRes = await runVerifyCommandAsync(vc, tmpDir, cfg);
        if (!baseRes.timedOut) {
          const key = verifyCommandIdentity(vc);
          baselineResults.set(key, {
            ok: baseRes.ok,
            ids: vc.kind === 'test' ? parseFailedTestIds(baseRes.output ?? '') : new Set<string>(),
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
        baseBranch: base,
        baseHead,
      };
    }

    for (const vc of commands) {
      ran.push(vc);
      const res = await runVerifyCommandAsync(vc, tmpDir, cfg);

      if (!res.ok) {
        if (vc.required === false) continue;
        if (vc.id !== undefined || vc.required === true) {
          return {
            ok: false,
            ran,
            detail: `required verify '${vc.kind}' failed (exit ${res.exitCode}): ${res.command}`,
            baseBranch: base,
            baseHead,
          };
        }
        // M281: for test commands, only block if NEW failures were introduced.
        if (vc.kind === 'test') {
          const cmdKey = verifyCommandIdentity(vc);
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
                baseBranch: base,
                baseHead,
              };
            } else {
              // No parseable IDs — fall back to ok-flag delta
              if (baseline.ok) {
                // Baseline was passing; change broke it — new regression → block
                return {
                  ok: false,
                  ran,
                  detail: `verify 'test' failed — regression detected (suite was passing before change)`,
                  baseBranch: base,
                  baseHead,
                };
              }
              return {
                ok: false,
                ran,
                detail: `verify 'test' failed and non-regression could not be proven from opaque baseline output`,
                baseBranch: base,
                baseHead,
              };
            }
          }
          // No baseline (timed out) — fall through to original fail behaviour
        }
        // M293: lint is delta-aware — tolerate pre-existing lint debt, block only a
        // clean→failing regression caused by this change.
        if (vc.kind === 'lint') {
          const cmdKey = verifyCommandIdentity(vc);
          const baseline = baselineResults.get(cmdKey);
          if (baseline !== undefined) {
            if (baseline.ok) {
              return {
                ok: false,
                ran,
                detail: `verify 'lint' failed — change introduced lint errors (lint was clean before)`,
                baseBranch: base,
                baseHead,
              };
            }
            // Lint already failing on base (pre-existing debt) — tolerate and continue.
            continue;
          }
          // No baseline (timed out) — fall through to original fail behaviour
        }
        return {
          ok: false,
          ran,
          detail: `verify '${vc.kind}' failed (exit ${res.exitCode}): ${res.command}`,
          baseBranch: base,
          baseHead,
        };
      }
    }

    const browser = await verifyProposalInBrowser(tmpDir, cfg);
    if (browser && !browser.ok) {
      return {
        ok: false,
        ran,
        detail: `browser verify failed: ${browser.detail}`,
        browser,
        baseBranch: base,
        baseHead,
      };
    }

    return {
      ok: true,
      ran,
      detail: `all ${ran.length} verify command(s) passed: ${ran.map((c) => c.kind).join(', ')}${browser ? '; browser verify passed' : ''}`,
      ...(browser ? { browser } : {}),
      baseBranch: base,
      baseHead,
    };
  } catch (err) {
    return {
      ok: false,
      ran,
      detail: `verifyProposal error: ${err instanceof Error ? err.message : String(err)}`,
      baseBranch: base,
      baseHead,
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
  /** True when a remote PR was opened and the host is responsible for final merge. */
  handoff?: boolean;
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
  expectedBaseHead?: string,
): { branch: string | null; detail: string } {
  const branch = `${MERGE_BRANCH_PREFIX}${id}`;
  const baseHead = resolveDefaultBranchHead(repo, base);
  if (!baseHead) {
    return { branch: null, detail: `could not resolve head of default branch '${base}'` };
  }
  if (expectedBaseHead && baseHead !== expectedBaseHead) {
    return {
      branch: null,
      detail: `default branch '${base}' moved since verification (verified ${expectedBaseHead.slice(0, 8)}, current ${baseHead.slice(0, 8)}) — reverify required`,
    };
  }

  const tmpDir = join(homedir(), '.ashlr', 'tmp', `mwt-${randomBytes(6).toString('hex')}`);
  try {
    gitRun(repo, ['worktree', 'add', '-b', branch, tmpDir, expectedBaseHead ?? baseHead]);
    linkNodeModules(repo, tmpDir);
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
  expectedBaseHead?: string,
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
    const baseSha = resolveDefaultBranchHead(repo, base);
    if (headSha && baseSha && headSha === baseSha) {
      return {
        ok: false,
        detail: `repo is in detached HEAD on the default branch commit (${base} @ ${headSha.slice(0, 8)}) — refusing local merge; branch '${branch}' left for manual merge`,
      };
    }
  }

  if (expectedBaseHead) {
    const baseHead = resolveDefaultBranchHead(repo, base);
    if (!baseHead) {
      return {
        ok: false,
        detail: `could not resolve head of default branch '${base}' before local merge; branch '${branch}' left for manual merge`,
      };
    }
    if (baseHead !== expectedBaseHead) {
      return {
        ok: false,
        detail: `default branch '${base}' moved since verification (verified ${expectedBaseHead.slice(0, 8)}, current ${baseHead.slice(0, 8)}) — refusing local merge; branch '${branch}' left for manual reverify`,
      };
    }
  }

  const tmpDir = join(homedir(), '.ashlr', 'tmp', `mergewt-${randomBytes(6).toString('hex')}`);
  // Check out the default branch into a dedicated worktree so we never touch the
  // user's tree, merge the staging branch, then the worktree's branch ref (base)
  // advances in the shared object store.
  try {
    gitRun(repo, ['worktree', 'add', tmpDir, base]);
    linkNodeModules(repo, tmpDir);
    if (expectedBaseHead) {
      const checkedOutHead = gitTry(tmpDir, ['rev-parse', 'HEAD']);
      if (checkedOutHead !== expectedBaseHead) {
        gitTry(repo, ['worktree', 'remove', '--force', tmpDir]);
        gitTry(repo, ['worktree', 'prune']);
        return {
          ok: false,
          detail: `default branch '${base}' moved while preparing local merge (verified ${expectedBaseHead.slice(0, 8)}, checked out ${checkedOutHead?.slice(0, 8) ?? 'unknown'}) — branch '${branch}' left for manual reverify`,
        };
      }
    }
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
    //   'evidence': judge-free deterministic authority. ANY producer tier may
    //   proceed only when base-bound verification, provenance, EDV, risk/scope,
    //   and manifest-safety facts satisfy evaluateEvidenceGate().
    //
    // M54 never-weaken + allowSelfMerge guard unchanged in both modes.
    const trustBasis = configuredTrustBasis(cfg);
    const expectedProposalStatus = proposal.status;
    const expectedProposalDiffHash = currentProposalDiffHash(proposal);
    const currentProposalConflict = (): string | null => {
      const current = loadProposal(id);
      if (!current) return 'proposal disappeared during merge evaluation';
      if (current.status !== expectedProposalStatus) {
        return `proposal status changed during merge evaluation (${expectedProposalStatus} -> ${current.status})`;
      }
      if (currentProposalDiffHash(current) !== expectedProposalDiffHash) {
        return 'proposal diff changed during merge evaluation';
      }
      if (trustBasis === 'verification' || trustBasis === 'evidence') {
        const expectedVerify = proposal.verifyResult;
        const currentVerify = current.verifyResult;
        if (
          !expectedVerify ||
          !currentVerify ||
          currentVerify.passed !== true ||
          currentVerify.diffHash !== expectedVerify.diffHash ||
          currentVerify.baseBranch !== expectedVerify.baseBranch ||
          currentVerify.baseHead !== expectedVerify.baseHead ||
          currentVerify.verifiedAt !== expectedVerify.verifiedAt ||
          currentVerify.source !== expectedVerify.source
        ) return 'proposal verification binding changed during merge evaluation';
      }
      return null;
    };

    let toMain: boolean;
    let authority: { authorized: boolean; reason: string };
    let evidenceRemoteProtection: AutonomyGateEvidence | undefined;
    let verifiedThisInvocation: VerifyProposalResult | undefined;

    if (trustBasis === 'evidence') {
      const activation = evaluateEvidenceAutoMergePreflight(proposal, cfg, {
        selfTarget: isSelfTargetProposal(proposal, cfg),
        remoteAvailable: getRemoteOrg(repo).org !== null,
        requireVerificationEvidence: false,
      });
      if (!activation.authorized) {
        return refuse(`merge authority denied: ${activation.reason}`, repo);
      }
    }

    if (trustBasis === 'verification' || trustBasis === 'evidence') {
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
      // Evidence mode has no judge dependency, so stored verifyResult is
      // observational only: proposal provenance does not authenticate that
      // mutable field. Every mutating evidence-mode invocation therefore
      // establishes fresh verification authority in an isolated worktree.
      // Verification mode retains its judge-attested cached-result behavior.
      const verifiedForCurrentDiff = trustBasis === 'verification' && hasVerifiedBaseBinding(proposal.verifyResult);
      const shouldVerify = trustBasis === 'evidence' || (
        proposal.verifyResult?.passed !== false && !verifiedForCurrentDiff
      );
      if (shouldVerify) {
        const preVerify = await verifyProposal(proposal, cfg);
        const preVerifyResult = verifyResultFromProposalResult(
          preVerify,
          'auto-merge',
          new Date().toISOString(),
          currentProposalDiffHash(proposal),
        );
        let persisted = false;
        try {
          persisted = updateProposalField(proposal.id, {
            verifyResult: preVerifyResult,
          });
        } catch {
          persisted = false;
        }
        if (!persisted) {
          return refuse(
            preVerify.ok
              ? 'verification result could not be persisted — refusing merge authority'
              : `verification failed: ${preVerify.detail}; result could not be persisted`,
            repo,
          );
        }
        if (!preVerify.ok) {
          return refuse(`verification failed: ${preVerify.detail}`, repo);
        }
        proposal.verifyResult = preVerifyResult;
        verifiedThisInvocation = preVerify;
      }

      // Evidence-backed modes load decisions for this proposal now. Verification
      // mode needs judged + EDV entries; evidence mode needs EDV entries only.
      const proposalCreatedMs = Date.parse(proposal.createdAt);
      const allDecisions = readDecisions({
        proposalId: id,
        ...(Number.isFinite(proposalCreatedMs) ? { sinceMs: proposalCreatedMs - 60_000 } : {}),
        requireComplete: true,
      });
      if (!decisionReadIsHealthy(allDecisions)) {
        return refuse('merge authority denied: decisions ledger source is degraded or incomplete', repo);
      }
      if (trustBasis === 'evidence') {
        const activation = evaluateEvidenceAutoMergePreflight(proposal, cfg, {
          selfTarget: isSelfTargetProposal(proposal, cfg),
          remoteAvailable: getRemoteOrg(repo).org !== null,
        });
        if (!activation.authorized) {
          return refuse(`merge authority denied: ${activation.reason}`, repo);
        }
        const remoteProtection = evaluateEvidenceRemoteProtectionSignal(cfg);
        evidenceRemoteProtection = {
          ok: true,
          detail: remoteProtection.detail,
        };
      }
      authority = trustBasis === 'verification'
        ? evaluateVerificationGate(proposal, cfg, allDecisions)
        : evaluateEvidenceGate(proposal, cfg, allDecisions);
      // Evidence-backed modes always target main (the bar is the gate).
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

    let scopeFilesForEvidence = 0;
    let scopeLinesForEvidence = 0;
    let maxFilesForEvidence = 4;
    let maxLinesForEvidence = 150;

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
      const autoMergeCfg = (cfg.foundry as { autoMerge?: Record<string, unknown> } | undefined)
        ?.autoMerge;
      const rawFiles = autoMergeCfg?.maxAutomergeFiles;
      const MAX_AUTOMERGE_FILES: number =
        typeof rawFiles === 'number' && rawFiles >= 1
          ? Math.floor(rawFiles)
          : 4;
      const rawLines = autoMergeCfg?.maxAutomergeLines;
      const MAX_AUTOMERGE_LINES: number =
        typeof rawLines === 'number' && rawLines >= 1
          ? Math.floor(rawLines)
          : 150;
      maxFilesForEvidence = MAX_AUTOMERGE_FILES;
      maxLinesForEvidence = MAX_AUTOMERGE_LINES;

      // M295: respect cfg.foundry.autoMerge.maxRisk instead of hardcoding 'low'.
      // Previously this required risk==='low' for the size-based main merge even
      // when maxRisk was raised — so NO ordinary source change (all 'medium' now)
      // could ever auto-merge to main, defeating the autonomous fleet's purpose.
      // Now the size cap (files/lines below) applies up to maxRisk; HIGH-risk
      // (security/build/shell surfaces + large diffs) is still refused. The real
      // protection remains: judge-ship + verify(typecheck/tests-delta/lint-delta)
      // + frontier-authority + HMAC attestation + the file/line scope cap.
      const scopeMaxRisk = (autoMergeCfg?.maxRisk ?? 'low') as RiskClass;
      if (RISK_ORDER[risk] > RISK_ORDER[scopeMaxRisk]) {
        return refuse(
          `scope cap: risk '${risk}' exceeds maxRisk '${scopeMaxRisk}'`,
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
      scopeFilesForEvidence = scopeFiles;
      // Count changed lines (same logic as classifyRisk body-line counter)
      let scopeLines = 0;
      for (const line of diff.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+') || line.startsWith('-')) scopeLines++;
      }
      scopeLinesForEvidence = scopeLines;

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
    // M261/M342: evidence-backed modes use only the fresh result established
    // during this invocation. Tier mode runs verification here as before.
    let verify: VerifyProposalResult;
    if ((trustBasis === 'verification' || trustBasis === 'evidence') && verifiedThisInvocation) {
      verify = verifiedThisInvocation;
    } else if (trustBasis === 'verification' && hasVerifiedBaseBinding(proposal.verifyResult)) {
      verify = verifyResultFromStored(proposal.verifyResult);
    } else {
      verify = await verifyProposal(proposal, cfg);
      // Persist the result for the non-verification-mode path (best-effort).
      // In verification mode this branch only runs if verifyResult was absent
      // AND the pre-Gate-4 path somehow did not set it — fail-closed by design.
      try {
        updateProposalField(proposal.id, {
	          verifyResult: verifyResultFromProposalResult(
	            verify,
	            'auto-merge',
	            new Date().toISOString(),
	            currentProposalDiffHash(proposal),
	          ),
        });
      } catch {
        // Persistence failure — swallow; the verify outcome still drives the gate.
      }
    }
    if (!verify.ok) {
      return refuse(`verification failed: ${verify.detail}`, repo);
    }
    if (!verify.baseBranch || !verify.baseHead) {
      return refuse('verification did not record a default-branch base head — reverify required', repo);
    }

    // ── Gate 6.5 (M86/M54): self-eval parity — self-target proposals must pass
    // the invariant suite flag-off AND flag-on. guardSafetyTests (never-weaken)
    // already ran inside verifyProposal BEFORE the worktree ran; this parity
    // check is the second layer that runs AFTER verify passes, so a self-edit
    // cannot silently break the suite under either foundry-enabled state.
    if (isSelfTargetProposal(proposal, cfg)) {
      const parity = await selfEvalParityAsync(async (flagOn: boolean) => {
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
        // M296: prefer the targeted invariant suite (`test:invariants` =
        // `vitest run test/h*.test.ts`) over the full `npm run test`.  The full
        // suite can have pre-existing failures in unrelated tests (e.g. m240,
        // m86) that are NOT invariant regressions — running all tests would
        // permanently block every self-edit even when the h1-h8 safety tests
        // are perfectly green.  `test:invariants` scopes to exactly the files
        // guarded by guardSafetyTests, so a real invariant breakage is still
        // caught.  When the script is absent (e.g. older installs, test repos)
        // we fall back to detectVerifyCommands so the gate is never a no-op.
        // Read the package.json scripts inline (readPackageJson/scriptsOf are
        // internal to verify-commands.ts and not exported).
        const scriptsForParity: Record<string, string> = {};
        try {
          const raw = readFileSync(join(repo, 'package.json'), 'utf8');
          const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
          if (pkg.scripts && typeof pkg.scripts === 'object') {
            for (const [k, v] of Object.entries(pkg.scripts)) {
              if (typeof v === 'string') scriptsForParity[k] = v;
            }
          }
        } catch { /* best-effort */ }
        const pm = existsSync(join(repo, 'pnpm-lock.yaml'))
          ? 'pnpm'
          : existsSync(join(repo, 'yarn.lock'))
            ? 'yarn'
            : existsSync(join(repo, 'bun.lockb'))
              ? 'bun'
              : 'npm';
        if (scriptsForParity['test:invariants']) {
          // Fast path: run only the invariant suite.
          const invariantCmd: VerifyCommand = {
            kind: 'test',
            cmd: [pm, 'run', 'test:invariants'],
          };
          const res = await runVerifyCommandAsync(invariantCmd, repo, parityCfg);
          return res.ok;
        }
        // Fallback: no targeted script — run all detected verify commands.
        const cmds = detectVerifyCommands(repo, 'merge');
        if (cmds.length === 0) {
          // No commands → parity is vacuously true (verify already passed in
          // the worktree; flag-sensitivity cannot be tested without a suite).
          return true;
        }
        for (const vc of cmds) {
          const res = await runVerifyCommandAsync(vc, repo, parityCfg);
          if (!res.ok && vc.required !== false) return false;
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
    let managerGateEvidence: AutonomyGateEvidence | undefined;
    if (managerGateEnabled) {
      // Resolve cached verdict: the most recent 'judged' entry for this proposal
      // within the last hour. A stale or absent entry triggers an inline judge call.
      const STALE_MS = 60 * 60 * 1000; // 1 hour
      const sinceMs = Date.now() - STALE_MS;
      const priorEntries = readDecisions({ proposalId: id, sinceMs, limit: 10, requireComplete: true });
      if (!decisionReadIsHealthy(priorEntries)) {
        return refuse('manager quality gate denied: decisions ledger source is degraded or incomplete', repo);
      }
      const cachedEntry = priorEntries.find((e) => e.action === 'judged' && e.verdict);

      let managerVerdict: { verdict: string; wouldMerge: boolean; rationale: string } | null = null;

      const cachedJudgeEngine = cachedEntry?.engine ?? cachedEntry?.model;
      const cachedIssuedAt = cachedEntry?.judgeAttestationIssuedAt;
      const cachedIssuedMs = typeof cachedIssuedAt === 'string' ? Date.parse(cachedIssuedAt) : NaN;
      const cacheNow = Date.now();
      const cachedShipAuthorized = cachedEntry?.verdict === 'ship' &&
        cachedEntry.detail === 'would-merge' &&
        cachedEntry.judgeAttestationIntent === 'would-merge' &&
        cachedIssuedAt === cachedEntry.ts &&
        Number.isFinite(cachedIssuedMs) &&
        cachedIssuedMs <= cacheNow + 60_000 &&
        cachedIssuedMs >= cacheNow - STALE_MS &&
        isFrontierJudge(cachedJudgeEngine) &&
        verifyJudgeAttestation(cachedEntry.judgeAttestation, {
          proposalId: proposal.id,
          judgeEngine: cachedJudgeEngine ?? '',
          verdict: 'ship',
          diffHash: hashDiff(proposal.diff ?? ''),
          issuedAt: cachedIssuedAt,
          mergeIntent: 'would-merge',
        }).ok;
      if (cachedEntry?.verdict && (cachedEntry.verdict !== 'ship' || cachedShipAuthorized)) {
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
          const ts = new Date().toISOString();
          recordDecision({
            ts,
            proposalId: id,
            ...causalMetadataFromProposal(proposal, {
              ts,
              learningSource: 'decision-ledger',
              labelBasis: 'merge-gate',
            }),
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
          const ts = new Date().toISOString();
          if (verdict.verdict === 'ship' && verdict.wouldMerge === true && isFrontierJudge(inlineJudgeEngine)) {
            try {
              const { signJudgeAttestation: signAtt, hashDiff: hd } = await import('../foundry/provenance.js');
              const dh = hd(proposal.diff ?? '');
              inlineAttestation = signAtt({
                proposalId: id,
                judgeEngine: inlineJudgeEngine,
                verdict: 'ship',
                diffHash: dh,
                issuedAt: ts,
                mergeIntent: 'would-merge',
              });
            } catch { inlineAttestation = undefined; }
          }
          // M153: record inlineJudgeEngine (the real model string) so that
          // evaluateVerificationGate criterion 1 can verify the judge was frontier.
          recordDecision({
            ts,
            proposalId: id,
            ...causalMetadataFromProposal(proposal, {
              ts,
              learningSource: 'decision-ledger',
              labelBasis: 'judge-verdict',
            }),
            action: 'judged',
            engine: inlineJudgeEngine,
            model: inlineJudgeEngine,
            verdict: verdict.verdict,
            reason: verdict.rationale,
            detail: verdict.wouldMerge ? 'would-merge' : '',
            ...(inlineAttestation !== undefined ? { judgeAttestation: inlineAttestation } : {}),
            ...(inlineAttestation !== undefined
              ? { judgeAttestationIssuedAt: ts, judgeAttestationIntent: 'would-merge' as const }
              : {}),
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
        const ts = new Date().toISOString();
        recordDecision({
          ts,
          proposalId: id,
          ...causalMetadataFromProposal(proposal, {
            ts,
            learningSource: 'decision-ledger',
            labelBasis: 'merge-gate',
          }),
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
          const ts = new Date().toISOString();
          recordDecision({
            ts,
            proposalId: id,
            ...causalMetadataFromProposal(proposal, {
              ts,
              learningSource: 'decision-ledger',
              labelBasis: 'merge-gate',
            }),
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
      managerGateEvidence = {
        ok: true,
        detail: `manager verdict '${managerVerdict.verdict}' with wouldMerge=true`,
      };
      const ts = new Date().toISOString();
      recordDecision({
        ts,
        proposalId: id,
        ...causalMetadataFromProposal(proposal, {
          ts,
          learningSource: 'decision-ledger',
          labelBasis: 'merge-gate',
        }),
        action: 'merged',
        reason: `gate 7 passed: verdict=${managerVerdict.verdict}, ${managerVerdict.rationale}`,
      });
    }

    // ── Gate 8: first-class autonomy policy verdict + durable evidence pack ──
    // At this point every existing mechanical gate has passed. Before mutating
    // anything, turn those scattered facts into one persisted evidence artifact
    // and ask the policy engine what the farthest allowed autonomous action is.
    // If the pack cannot be written, fail closed: an autonomous merge without an
    // evidence trail recreates the human-as-integrator bottleneck.
    const preEvidenceConflict = currentProposalConflict();
    if (preEvidenceConflict) return refuse(preEvidenceConflict, repo);
    const wantRemote = cfg.foundry?.autoMerge?.pushToRemote === true;
    const hasGithub = getRemoteOrg(repo).org !== null;
    const selfTarget = isSelfTargetProposal(proposal, cfg);
    const allowSelfMerge =
      ((cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge'] as Record<string, unknown> | undefined)?.[
        'allowSelfMerge'
      ] === true;
    if (trustBasis === 'evidence' && toMain) {
      const base = verify.baseBranch;
      const verifiedBaseHead = verify.baseHead;
      if (!base || !verifiedBaseHead) {
        return refuse('verification did not record a default-branch base head — reverify required', repo);
      }
      const currentDefaultBranch = defaultBranch(repo);
      if (currentDefaultBranch !== base) {
        return refuse(
          `default branch changed since verification (verified '${base}', current '${currentDefaultBranch}') — reverify required`,
          repo,
        );
      }
      const localBaseHeadBeforeEvidence = resolveDefaultBranchHead(repo, base);
      if (!localBaseHeadBeforeEvidence || localBaseHeadBeforeEvidence !== verifiedBaseHead) {
        return refuse(
          `default branch '${base}' moved since verification — refusing evidence pack; reverify required`,
          repo,
        );
      }
      if (wantRemote && hasGithub) {
        const remoteBaseHeadBeforeEvidence = resolveRemoteBranchHead(repo, base);
        if (!remoteBaseHeadBeforeEvidence) {
          return refuse(
            `could not resolve protected remote branch '${base}' before evidence pack — reverify required`,
            repo,
          );
        }
        if (remoteBaseHeadBeforeEvidence !== verifiedBaseHead) {
          return refuse(
            `protected remote branch '${base}' moved since verification (verified ${verifiedBaseHead.slice(0, 8)}, remote ${remoteBaseHeadBeforeEvidence.slice(0, 8)}) — refusing evidence pack; reverify required`,
            repo,
          );
        }
        if (evidenceRemoteProtection) {
          evidenceRemoteProtection = {
            ok: evidenceRemoteProtection.ok,
            detail: `${evidenceRemoteProtection.detail}; remote base ${base}@${remoteBaseHeadBeforeEvidence.slice(0, 8)} matches verification`,
          };
        }
      }
    }
    const evidencePack = buildAutonomyEvidencePack({
      proposal,
      target: toMain ? 'main' : 'branch',
      trustBasis,
      remotePreferred: wantRemote && hasGithub,
      riskClass: risk,
      authority: { ok: true, detail: authority.reason },
      provenance: { ok: true, detail: provenance.reason ?? 'valid signed provenance' },
      verification: {
        passed: verify.ok,
        detail: verify.detail,
        commandKinds: verify.ran.map((cmd) => cmd.kind),
        ...(verify.baseBranch ? { baseBranch: verify.baseBranch } : {}),
        ...(verify.baseHead ? { baseHead: verify.baseHead } : {}),
        ...(proposal.verifyResult?.diffHash ? { diffHash: proposal.verifyResult.diffHash } : {}),
        ...(proposal.verifyResult?.verifiedAt ? { verifiedAt: proposal.verifyResult.verifiedAt } : {}),
        ...(proposal.verifyResult?.source ? { source: proposal.verifyResult.source } : {}),
        ...(verify.browser ? { browser: verify.browser } : {}),
      },
      risk: { ok: true, detail: `risk '${risk}' within maxRisk '${maxRisk}'` },
      scope: {
        ok: true,
        detail: `${scopeFilesForEvidence} file(s), ${scopeLinesForEvidence} changed line(s) within caps ${maxFilesForEvidence}/${maxLinesForEvidence}`,
      },
      ...(managerGateEvidence ? { manager: managerGateEvidence } : {}),
      ...(evidenceRemoteProtection ? { remoteProtection: evidenceRemoteProtection } : {}),
      ...(selfTarget
        ? {
            selfTarget: {
              ok: allowSelfMerge,
              detail: allowSelfMerge
                ? 'self-target allowed by cfg.foundry.autoMerge.allowSelfMerge=true'
                : 'self-target autonomous merge requires cfg.foundry.autoMerge.allowSelfMerge=true',
            },
          }
        : {}),
    });
    const policy = evaluateAutonomyPolicy(evidencePack, cfg);
    evidencePack.policy = policy;
    evidencePack.evidenceOutcome = evidenceOutcomeSummary({
      ...(evidencePack.evidenceOutcome ?? {}),
      policyAllowed: policy.allowed,
      policyAction: policy.action,
      policyTier: policy.tier,
    });
    if (!persistAutonomyEvidencePack(evidencePack)) {
      return refuse('autonomy evidence pack could not be persisted — fail closed', repo);
    }
    if (!policy.allowed) {
      return refuse(`autonomy policy denied ${policy.action}: ${policy.reason}`, repo);
    }
    if (toMain && policy.action !== 'merge-main') {
      return refuse(`autonomy policy returned '${policy.action}' but main merge requires 'merge-main'`, repo);
    }
    if (!toMain && policy.action !== 'apply-local-branch' && policy.action !== 'open-ready-pr') {
      return refuse(`autonomy policy returned '${policy.action}' but branch application requires branch/PR action`, repo);
    }

    // Fence proposal authority from the last state check through the outward
    // mutation and terminal proposal update. Store writers share this lock.
    const authorityFence = acquireProposalMutationLock(id);
    if (!authorityFence) return refuse('proposal mutation lock unavailable — refusing merge authority', repo);
    try {
      const fencedConflict = currentProposalConflict();
      if (fencedConflict) return refuse(fencedConflict, repo);

    // ── ACTION: stage the diff on a branch off the default branch ────────────
    const base = verify.baseBranch;
    const currentDefaultBranch = defaultBranch(repo);
    if (currentDefaultBranch !== base) {
      return refuse(
        `default branch changed since verification (verified '${base}', current '${currentDefaultBranch}') — reverify required`,
        repo,
      );
    }
    const staged = buildMergeBranch(repo, id, diff, base, verify.baseHead);
    if (!staged.branch) {
      return refuse(`could not stage merge branch: ${staged.detail}`, repo);
    }
    const branch = staged.branch;

    let merged = false;
    let branchApplied = false; // M56: mid-tier applied to a branch/PR (never main)
    let remoteHandoff = false; // Remote PR created; host gates own the actual merge.
    let reason = '';
    let prUrl: string | undefined;

    if (wantRemote && hasGithub) {
      const prePushConflict = currentProposalConflict();
      if (prePushConflict) return refuse(prePushConflict, repo);
      const baseHeadBeforePush = resolveDefaultBranchHead(repo, base);
      if (!baseHeadBeforePush || baseHeadBeforePush !== verify.baseHead) {
        return refuse(
          `default branch '${base}' moved since verification — refusing remote handoff; branch '${branch}' left for manual reverify`,
          repo,
        );
      }
      if (configuredTrustBasis(cfg) === 'evidence') {
        const remoteBaseHeadBeforePush = resolveRemoteBranchHead(repo, base);
        if (!remoteBaseHeadBeforePush) {
          return refuse(
            `could not resolve protected remote branch '${base}' before evidence handoff — branch '${branch}' left for manual reverify`,
            repo,
          );
        }
        if (remoteBaseHeadBeforePush !== verify.baseHead) {
          return refuse(
            `protected remote branch '${base}' moved since verification (verified ${verify.baseHead.slice(0, 8)}, remote ${remoteBaseHeadBeforePush.slice(0, 8)}) — refusing evidence handoff; branch '${branch}' left for manual reverify`,
            repo,
          );
        }
      }
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
        // Best-effort host auto-merge. Never request privileged bypass:
        // branch protection / required checks must remain the outer safety net.
        // M56: only a frontier (toMain) proposal is ever squash-merged to main.
        // A mid-tier proposal opens a PR and STOPS — a human merges it.
        remoteHandoff = true;
        let mergeNote = toMain ? 'PR opened' : 'PR opened for review (mid-tier — never merged to main)';
        if (toMain && prUrl) {
          try {
            execFileSync('gh', ['pr', 'merge', '--auto', '--squash', prUrl], {
              cwd: repo,
              timeout: GIT_TIMEOUT,
              stdio: 'pipe',
              encoding: 'utf8',
              env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
            });
            mergeNote = 'PR opened with host auto-merge enabled';
          } catch {
            mergeNote = 'PR opened; host auto-merge not enabled';
          }
        } else if (!toMain && prUrl) {
          branchApplied = true;
          remoteHandoff = false;
        }
        reason = `${mergeNote}${prUrl ? `: ${prUrl}` : ''}`;
        if (remoteHandoff && !merged) {
          branchApplied = false;
        }
        // A created remote PR is a successful handoff, but not a merge. Keep it
        // out of pending without claiming the work landed; a later reconciler can
        // prove the host merged it and advance to applied.
        if (remoteHandoff) {
          reason = `${reason} (remote handoff; awaiting host merge)`;
        }
      }
    } else if (toMain) {
      // LOCAL fallback — conservative; refuses if default branch is checked out.
      const preMergeConflict = currentProposalConflict();
      if (preMergeConflict) return refuse(preMergeConflict, repo);
      const local = mergeLocally(repo, branch, base, verify.baseHead);
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
    const success = merged || branchApplied || remoteHandoff;
    if (success) {
      if (remoteHandoff) {
        const now = new Date().toISOString();
        updateProposalField(id, {
          remoteHandoff: {
            provider: 'github',
            state: 'awaiting-host-merge',
            ...(prUrl ? { prUrl } : {}),
            branch,
            base,
            createdAt: now,
            updatedAt: now,
            detail: reason,
          },
        }, authorityFence);
        setStatus(id, 'awaiting-host-merge', reason, reason, authorityFence);
      } else {
        setStatus(id, 'applied', reason, undefined, authorityFence);
      }
    }

    const result: AutoMergeResult = {
      ok: success,
      merged,
      ...(branchApplied ? { branched: true } : {}),
      ...(remoteHandoff ? { handoff: true } : {}),
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
    } finally {
      releaseProposalMutationLock(authorityFence);
    }
  } catch (err) {
    // Belt-and-suspenders: the orchestrator must never throw out.
    return refuse(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
