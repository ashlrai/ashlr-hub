/**
 * Autonomy evidence packs are the durable "why this was safe" record for
 * autonomous engineering actions. They intentionally sit beside the existing
 * merge gate: the gate still enforces safety, while this module turns its
 * scattered observations into one auditable artifact.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  AutoMergeTrustBasis,
  EngineTier,
  EvidenceOutcomeSummary,
  LabelBasis,
  LearningSource,
  RouteSnapshot,
  RunEventSummary,
  Proposal,
  ProposalBrowserVerifyEvidence,
  ProposalVerifyResult,
  VisualGroundingEvidence,
} from '../types.js';
import { causalMetadata } from '../learning/causal.js';

export type AutonomyTarget = 'proposal' | 'branch' | 'main' | 'preview' | 'production';

export interface AutonomyGateEvidence {
  ok: boolean;
  detail: string;
}

export interface AutonomyDiffEvidence {
  hash?: string;
  files: string[];
  changedLines: number;
}

export interface AutonomyVerificationEvidence {
  passed: boolean;
  detail: string;
  commandKinds: string[];
  baseBranch?: string;
  baseHead?: string;
  diffHash?: string;
  verifiedAt?: string;
  source?: ProposalVerifyResult['source'];
  browser?: ProposalBrowserVerifyEvidence;
}

export interface AutonomyEvidencePack {
  version: 1;
  generatedAt: string;
  proposal: {
    id: string;
    repo: string | null;
    kind: Proposal['kind'];
    status: Proposal['status'];
    origin: Proposal['origin'];
    title: string;
    createdAt: string;
  };
  producer: {
    engineModel?: string;
    engineTier?: EngineTier;
  };
  diff: AutonomyDiffEvidence;
  target: AutonomyTarget;
  trustBasis: AutoMergeTrustBasis;
  remotePreferred: boolean;
  riskClass: 'low' | 'medium' | 'high';
  gates: {
    authority: AutonomyGateEvidence;
    provenance: AutonomyGateEvidence;
    verification: AutonomyGateEvidence;
    risk: AutonomyGateEvidence;
    scope: AutonomyGateEvidence;
    manager?: AutonomyGateEvidence;
    selfTarget?: AutonomyGateEvidence;
    edv?: AutonomyGateEvidence;
    remoteProtection?: AutonomyGateEvidence;
  };
  verification: AutonomyVerificationEvidence;
  policy?: {
    tier: string;
    action: string;
    allowed: boolean;
    reason: string;
  };
  trajectoryId?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
}

export interface BuildAutonomyEvidenceInput {
  proposal: Proposal;
  target: AutonomyTarget;
  trustBasis: AutoMergeTrustBasis;
  remotePreferred?: boolean;
  riskClass: 'low' | 'medium' | 'high';
  authority: AutonomyGateEvidence;
  provenance: AutonomyGateEvidence;
  verification: AutonomyVerificationEvidence;
  risk: AutonomyGateEvidence;
  scope: AutonomyGateEvidence;
  manager?: AutonomyGateEvidence;
  selfTarget?: AutonomyGateEvidence;
  edv?: AutonomyGateEvidence;
  remoteProtection?: AutonomyGateEvidence;
}

export function evidenceDir(): string {
  return join(homedir(), '.ashlr', 'evidence');
}

export function evidencePath(proposalId: string): string {
  if (!/^[\w.-]+$/.test(proposalId)) {
    throw new Error(`Invalid proposal id: ${JSON.stringify(proposalId)}`);
  }
  return join(evidenceDir(), `${proposalId}.json`);
}

export function summarizeDiff(diff: string | undefined): AutonomyDiffEvidence {
  const body = diff ?? '';
  const files = new Set<string>();
  let changedLines = 0;
  const addPath = (raw: string): void => {
    let p = raw.trim().split('\t')[0];
    if (p === '/dev/null') return;
    if (p.startsWith('b/') || p.startsWith('a/')) p = p.slice(2);
    if (p) files.add(p);
  };
  const addDiffGitPaths = (line: string): void => {
    const rest = line.slice('diff --git '.length).trim();
    const bIndex = rest.lastIndexOf(' b/');
    if (rest.startsWith('a/') && bIndex > 0) {
      addPath(rest.slice(0, bIndex));
      addPath(rest.slice(bIndex + 1));
      return;
    }
    const [left, ...right] = rest.split(/\s+/);
    if (left) addPath(left);
    if (right.length > 0) addPath(right.join(' '));
  };

  for (const line of body.split('\n')) {
    if (line.startsWith('diff --git ')) {
      addDiffGitPaths(line);
      continue;
    }
    if (line.startsWith('+++ ')) {
      addPath(line.slice(4));
      continue;
    }
    if (line.startsWith('--- ')) {
      addPath(line.slice(4));
      continue;
    }
    if (line.startsWith('rename from ')) {
      addPath(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      addPath(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) changedLines++;
  }

  return { files: [...files], changedLines };
}

export function buildAutonomyEvidencePack(input: BuildAutonomyEvidenceInput): AutonomyEvidencePack {
  const { proposal } = input;
  const diff = summarizeDiff(proposal.diff);
  const evidenceOutcome: EvidenceOutcomeSummary = {
    target: input.target,
    trustBasis: input.trustBasis,
    riskClass: input.riskClass,
    verificationPassed: input.verification.passed,
    gateCount: Object.values({
      authority: input.authority,
      provenance: input.provenance,
      verification: input.verification,
      risk: input.risk,
      scope: input.scope,
      manager: input.manager,
      selfTarget: input.selfTarget,
      edv: input.edv,
      remoteProtection: input.remoteProtection,
    }).filter(Boolean).length,
  };
  const causal = causalMetadata({
    proposalId: proposal.id,
    workItemId: proposal.workItemId,
    runId: proposal.runId,
    trajectoryId: proposal.trajectoryId,
    routeSnapshot: proposal.routeSnapshot,
    runEventSummary: proposal.runEventSummary,
    evidenceOutcome,
    learningSource: 'autonomy-evidence',
    labelBasis: 'evidence-policy',
    routerPolicyVersion: proposal.routerPolicyVersion,
    learningEpoch: proposal.learningEpoch,
    ts: proposal.createdAt,
  });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    proposal: {
      id: proposal.id,
      repo: proposal.repo,
      kind: proposal.kind,
      status: proposal.status,
      origin: proposal.origin,
      title: proposal.title,
      createdAt: proposal.createdAt,
    },
    producer: {
      ...(proposal.engineModel ? { engineModel: proposal.engineModel } : {}),
      ...(proposal.engineTier ? { engineTier: proposal.engineTier } : {}),
    },
    diff: {
      ...diff,
      ...(proposal.diffHash ? { hash: proposal.diffHash } : {}),
    },
    target: input.target,
    trustBasis: input.trustBasis,
    remotePreferred: input.remotePreferred === true,
    riskClass: input.riskClass,
    gates: {
      authority: input.authority,
      provenance: input.provenance,
      verification: { ok: input.verification.passed, detail: input.verification.detail },
      risk: input.risk,
      scope: input.scope,
      ...(input.manager ? { manager: input.manager } : {}),
      ...(input.selfTarget ? { selfTarget: input.selfTarget } : {}),
      ...(input.edv ? { edv: input.edv } : {}),
      ...(input.remoteProtection ? { remoteProtection: input.remoteProtection } : {}),
    },
    verification: copyVerificationEvidence(input.verification),
    ...causal,
  };
}

function copyVisualEvidence(input: VisualGroundingEvidence): VisualGroundingEvidence {
  return {
    status: input.status,
    provider: input.provider,
    boxCount: input.boxCount,
    boxes: input.boxes.map((box) => ({
      x1: box.x1,
      y1: box.y1,
      x2: box.x2,
      y2: box.y2,
      scale: box.scale,
      ...(box.label ? { label: box.label } : {}),
      ...(typeof box.confidence === 'number' ? { confidence: box.confidence } : {}),
    })),
    ...(input.image
      ? {
          image: {
            bytes: input.image.bytes,
            sha256: input.image.sha256,
          },
        }
      : {}),
    detail: input.detail,
  };
}

function copyBrowserEvidence(input: ProposalBrowserVerifyEvidence): ProposalBrowserVerifyEvidence {
  return {
    ok: input.ok,
    renderOk: input.renderOk,
    consoleErrorCount: input.consoleErrorCount,
    screenshotCaptured: input.screenshotCaptured,
    detail: input.detail,
    ...(input.visualGrounding ? { visualGrounding: copyVisualEvidence(input.visualGrounding) } : {}),
  };
}

function copyVerificationEvidence(input: AutonomyVerificationEvidence): AutonomyVerificationEvidence {
  return {
    passed: input.passed,
    detail: input.detail,
    commandKinds: [...input.commandKinds],
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(input.baseHead ? { baseHead: input.baseHead } : {}),
    ...(input.diffHash ? { diffHash: input.diffHash } : {}),
    ...(input.verifiedAt ? { verifiedAt: input.verifiedAt } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.browser ? { browser: copyBrowserEvidence(input.browser) } : {}),
  };
}

export function persistAutonomyEvidencePack(pack: AutonomyEvidencePack): boolean {
  try {
    const dir = evidenceDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const dest = evidencePath(pack.proposal.id);
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(pack, null, 2) + '\n', 'utf8');
    renameSync(tmp, dest);
    return true;
  } catch {
    return false;
  }
}

function isAutonomyEvidencePack(value: unknown): value is AutonomyEvidencePack {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const proposal = v['proposal'];
  const diff = v['diff'];
  const gates = v['gates'];
  const verification = v['verification'];
  return (
    v['version'] === 1 &&
    typeof v['generatedAt'] === 'string' &&
    proposal !== null &&
    typeof proposal === 'object' &&
    !Array.isArray(proposal) &&
    typeof (proposal as Record<string, unknown>)['id'] === 'string' &&
    diff !== null &&
    typeof diff === 'object' &&
    !Array.isArray(diff) &&
    gates !== null &&
    typeof gates === 'object' &&
    !Array.isArray(gates) &&
    verification !== null &&
    typeof verification === 'object' &&
    !Array.isArray(verification)
  );
}

export function readAutonomyEvidencePack(proposalId: string): AutonomyEvidencePack | null {
  try {
    const raw = readFileSync(evidencePath(proposalId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isAutonomyEvidencePack(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function listAutonomyEvidencePacks(limit = 50): AutonomyEvidencePack[] {
  try {
    const dir = evidenceDir();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.includes('.tmp-'))
      .sort()
      .reverse();
    const packs: AutonomyEvidencePack[] = [];
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
    const scanCap = Math.max(cap * 4, 200);
    for (const file of files.slice(0, scanCap)) {
      try {
        const raw = readFileSync(join(dir, file), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (isAutonomyEvidencePack(parsed)) packs.push(parsed);
      } catch {
        // Skip corrupt evidence files. The caller surfaces aggregate counts only.
      }
    }
    packs.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
    return packs.slice(0, cap);
  } catch {
    return [];
  }
}
