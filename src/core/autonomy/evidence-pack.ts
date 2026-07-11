/**
 * Autonomy evidence packs are the durable "why this was safe" record for
 * autonomous engineering actions. They intentionally sit beside the existing
 * merge gate: the gate still enforces safety, while this module turns its
 * scattered observations into one auditable artifact.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
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
import { hashDiff } from '../foundry/provenance.js';
import { causalMetadata } from '../learning/causal.js';

export const READY_EVIDENCE_MAX_AGE_MS = 60 * 60 * 1000;
export const READY_EVIDENCE_MAX_FUTURE_SKEW_MS = 60 * 1000;

const MAX_EVIDENCE_FILES = 2_048;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;

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

export interface AutonomyEvidenceSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  filesRead: number;
  bytesRead: number;
  invalidFiles: number;
  unreadableFiles: number;
  limitExceeded: boolean;
}

export interface AutonomyEvidencePacksReadResult extends AutonomyEvidenceSourceQuality {
  packs: AutonomyEvidencePack[];
}

export type AutonomyEvidencePackList = AutonomyEvidencePack[] & {
  sourceQuality?: AutonomyEvidenceSourceQuality;
};

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
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dirStat = lstatSync(dir);
    if (
      dirStat.isSymbolicLink() ||
      !dirStat.isDirectory() ||
      (typeof process.getuid === 'function' && dirStat.uid !== process.getuid())
    ) return false;
    chmodSync(dir, 0o700);
    const dest = evidencePath(pack.proposal.id);
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(pack, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, dest);
    chmodSync(dest, 0o600);
    return true;
  } catch {
    return false;
  }
}

function isGateEvidence(value: unknown): value is AutonomyGateEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const gate = value as Record<string, unknown>;
  return typeof gate['ok'] === 'boolean' && typeof gate['detail'] === 'string';
}

function isAutonomyEvidencePack(value: unknown): value is AutonomyEvidencePack {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const proposal = v['proposal'];
  const diff = v['diff'];
  const gates = v['gates'];
  const verification = v['verification'];
  const policy = v['policy'];
  const proposalRecord = proposal as Record<string, unknown> | null;
  const diffRecord = diff as Record<string, unknown> | null;
  const gatesRecord = gates as Record<string, unknown> | null;
  const verificationRecord = verification as Record<string, unknown> | null;
  return (
    v['version'] === 1 &&
    typeof v['generatedAt'] === 'string' &&
    proposal !== null &&
    typeof proposal === 'object' &&
    !Array.isArray(proposal) &&
    typeof proposalRecord?.['id'] === 'string' &&
    typeof proposalRecord['status'] === 'string' &&
    typeof proposalRecord['kind'] === 'string' &&
    diff !== null &&
    typeof diff === 'object' &&
    !Array.isArray(diff) &&
    Array.isArray(diffRecord?.['files']) &&
    diffRecord['files'].every((file) => typeof file === 'string') &&
    typeof diffRecord['changedLines'] === 'number' &&
    gates !== null &&
    typeof gates === 'object' &&
    !Array.isArray(gates) &&
    isGateEvidence(gatesRecord?.['authority']) &&
    isGateEvidence(gatesRecord?.['provenance']) &&
    isGateEvidence(gatesRecord?.['verification']) &&
    isGateEvidence(gatesRecord?.['risk']) &&
    isGateEvidence(gatesRecord?.['scope']) &&
    verification !== null &&
    typeof verification === 'object' &&
    !Array.isArray(verification) &&
    typeof verificationRecord?.['passed'] === 'boolean' &&
    typeof verificationRecord['detail'] === 'string' &&
    Array.isArray(verificationRecord['commandKinds']) &&
    verificationRecord['commandKinds'].every((kind) => typeof kind === 'string') &&
    (policy === undefined || (
      policy !== null &&
      typeof policy === 'object' &&
      !Array.isArray(policy) &&
      typeof (policy as Record<string, unknown>)['allowed'] === 'boolean' &&
      typeof (policy as Record<string, unknown>)['action'] === 'string'
    ))
  );
}

function timestampsAreFresh(pack: AutonomyEvidencePack, nowMs: number, maxAgeMs: number): boolean {
  const generatedMs = Date.parse(pack.generatedAt);
  const verifiedMs = Date.parse(pack.verification.verifiedAt ?? '');
  if (!Number.isFinite(generatedMs) || !Number.isFinite(verifiedMs)) return false;
  if (generatedMs > nowMs + READY_EVIDENCE_MAX_FUTURE_SKEW_MS) return false;
  if (verifiedMs > nowMs + READY_EVIDENCE_MAX_FUTURE_SKEW_MS) return false;
  if (generatedMs < nowMs - maxAgeMs || verifiedMs < nowMs - maxAgeMs) return false;
  return generatedMs + READY_EVIDENCE_MAX_FUTURE_SKEW_MS >= verifiedMs;
}

/** Fail-closed binding check for evidence used by daemon scheduling. */
export function evidencePackMatchesLiveProposal(
  pack: AutonomyEvidencePack,
  proposal: Proposal,
  opts: { nowMs?: number; maxAgeMs?: number } = {},
): boolean {
  const verify = proposal.verifyResult;
  const currentDiffHash = hashDiff(proposal.diff ?? '');
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = typeof opts.maxAgeMs === 'number' && Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs > 0
    ? opts.maxAgeMs
    : READY_EVIDENCE_MAX_AGE_MS;
  const requiredGates = [
    pack.gates.authority,
    pack.gates.provenance,
    pack.gates.verification,
    pack.gates.risk,
    pack.gates.scope,
    pack.gates.manager,
    pack.gates.selfTarget,
    pack.gates.edv,
    pack.gates.remoteProtection,
  ].filter((gate): gate is AutonomyGateEvidence => gate !== undefined);

  return (
    proposal.status === 'pending' &&
    pack.proposal.id === proposal.id &&
    pack.proposal.status === 'pending' &&
    pack.proposal.kind === proposal.kind &&
    pack.target === 'main' &&
    pack.policy?.allowed === true &&
    pack.policy.action === 'merge-main' &&
    pack.verification.passed === true &&
    pack.verification.commandKinds.length > 0 &&
    requiredGates.every((gate) => gate.ok) &&
    typeof proposal.diffHash === 'string' &&
    proposal.diffHash === currentDiffHash &&
    pack.diff.hash === currentDiffHash &&
    pack.verification.diffHash === currentDiffHash &&
    verify?.passed === true &&
    verify.diffHash === currentDiffHash &&
    typeof verify.baseBranch === 'string' &&
    verify.baseBranch.length > 0 &&
    pack.verification.baseBranch === verify.baseBranch &&
    typeof verify.baseHead === 'string' &&
    verify.baseHead.length > 0 &&
    pack.verification.baseHead === verify.baseHead &&
    typeof verify.source === 'string' &&
    verify.source.length > 0 &&
    pack.verification.source === verify.source &&
    pack.verification.verifiedAt === verify.verifiedAt &&
    timestampsAreFresh(pack, nowMs, maxAgeMs)
  );
}

export function readAutonomyEvidencePack(proposalId: string): AutonomyEvidencePack | null {
  const result = readAutonomyEvidencePacksDetailed(MAX_EVIDENCE_FILES);
  if (result.sourceState !== 'healthy' || !result.complete) return null;
  return result.packs.find((pack) => pack.proposal.id === proposalId) ?? null;
}

function emptyEvidenceRead(
  sourceState: AutonomyEvidenceSourceQuality['sourceState'],
  overrides: Partial<AutonomyEvidencePacksReadResult> = {},
): AutonomyEvidencePacksReadResult {
  return {
    packs: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    filesRead: 0,
    bytesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
    limitExceeded: false,
    ...overrides,
  };
}

export function readAutonomyEvidencePacksDetailed(limit = 50): AutonomyEvidencePacksReadResult {
  try {
    const dir = evidenceDir();
    if (!existsSync(dir)) return emptyEvidenceRead('missing');
    const dirStat = lstatSync(dir);
    const ownerOk = typeof process.getuid !== 'function' || dirStat.uid === process.getuid();
    if (
      dirStat.isSymbolicLink() ||
      !dirStat.isDirectory() ||
      !ownerOk ||
      (process.platform !== 'win32' && (dirStat.mode & 0o077) !== 0)
    ) {
      return emptyEvidenceRead('degraded', { complete: false, unreadableFiles: 1 });
    }
    const files: string[] = [];
    const handle = opendirSync(dir);
    try {
      let physicalEntries = 0;
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        physicalEntries++;
        if (physicalEntries > MAX_EVIDENCE_FILES) {
          return emptyEvidenceRead('degraded', { complete: false, limitExceeded: true });
        }
        if (entry.name.endsWith('.json') && !entry.name.includes('.tmp-')) files.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
    files.sort().reverse();
    const result = emptyEvidenceRead('healthy', { sourcePresent: true });
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
    const proposalIds = new Set<string>();
    for (const file of files) {
      let fd: number | undefined;
      try {
        const path = join(dir, file);
        const noFollow = 'O_NOFOLLOW' in fsConstants
          ? (fsConstants as typeof fsConstants & { O_NOFOLLOW: number }).O_NOFOLLOW
          : 0;
        fd = openSync(path, fsConstants.O_RDONLY | noFollow);
        const before = fstatSync(fd);
        if (!before.isFile() || before.size > MAX_EVIDENCE_FILE_BYTES) {
          result.invalidFiles++;
          continue;
        }
        if (result.bytesRead + before.size > MAX_EVIDENCE_BYTES) {
          result.limitExceeded = true;
          result.complete = false;
          break;
        }
        result.bytesRead += before.size;
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count <= 0) break;
          offset += count;
        }
        const after = fstatSync(fd);
        const pathStat = lstatSync(path);
        const stableIdentity =
          !pathStat.isSymbolicLink() &&
          pathStat.isFile() &&
          offset === before.size &&
          after.size === before.size &&
          pathStat.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs &&
          pathStat.mtimeMs === after.mtimeMs &&
          pathStat.ctimeMs === after.ctimeMs &&
          before.nlink === 1 &&
          (typeof process.getuid !== 'function' || before.uid === process.getuid()) &&
          (process.platform === 'win32' || (before.mode & 0o077) === 0) &&
          (before.ino === 0 || pathStat.ino === 0 || (before.dev === pathStat.dev && before.ino === pathStat.ino));
        if (!stableIdentity) {
          result.invalidFiles++;
          continue;
        }
        const raw = bytes.toString('utf8');
        result.filesRead++;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (
            isAutonomyEvidencePack(parsed) &&
            file === `${parsed.proposal.id}.json` &&
            !proposalIds.has(parsed.proposal.id)
          ) {
            proposalIds.add(parsed.proposal.id);
            result.packs.push(parsed);
          } else result.invalidFiles++;
        } catch {
          result.invalidFiles++;
        }
      } catch {
        result.unreadableFiles++;
      } finally {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* read health already fails closed */ }
        }
      }
    }
    if (result.invalidFiles > 0 || result.unreadableFiles > 0 || !result.complete) {
      result.sourceState = 'degraded';
      result.complete = false;
    }
    result.packs.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
    result.packs = result.packs.slice(0, cap);
    return result;
  } catch {
    return emptyEvidenceRead('degraded', { complete: false, unreadableFiles: 1 });
  }
}

export function listAutonomyEvidencePacks(limit = 50): AutonomyEvidencePackList {
  const result = readAutonomyEvidencePacksDetailed(limit);
  const packs = result.packs as AutonomyEvidencePackList;
  Object.defineProperty(packs, 'sourceQuality', {
    value: {
      sourceState: result.sourceState,
      sourcePresent: result.sourcePresent,
      complete: result.complete,
      filesRead: result.filesRead,
      bytesRead: result.bytesRead,
      invalidFiles: result.invalidFiles,
      unreadableFiles: result.unreadableFiles,
      limitExceeded: result.limitExceeded,
    } satisfies AutonomyEvidenceSourceQuality,
    enumerable: false,
  });
  return packs;
}
