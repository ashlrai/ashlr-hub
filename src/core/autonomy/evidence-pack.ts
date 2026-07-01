/**
 * Autonomy evidence packs are the durable "why this was safe" record for
 * autonomous engineering actions. They intentionally sit beside the existing
 * merge gate: the gate still enforces safety, while this module turns its
 * scattered observations into one auditable artifact.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { EngineTier, Proposal } from '../types.js';

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
  trustBasis: 'tier' | 'verification';
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
  };
  verification: AutonomyVerificationEvidence;
  policy?: {
    tier: string;
    action: string;
    allowed: boolean;
    reason: string;
  };
}

export interface BuildAutonomyEvidenceInput {
  proposal: Proposal;
  target: AutonomyTarget;
  trustBasis: 'tier' | 'verification';
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
  const files: string[] = [];
  let changedLines = 0;

  for (const line of body.split('\n')) {
    if (line.startsWith('+++ ')) {
      let p = line.slice(4).trim().split('\t')[0];
      if (p === '/dev/null') continue;
      if (p.startsWith('b/')) p = p.slice(2);
      if (p.startsWith('a/')) p = p.slice(2);
      if (p) files.push(p);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) changedLines++;
  }

  return { files, changedLines };
}

export function buildAutonomyEvidencePack(input: BuildAutonomyEvidenceInput): AutonomyEvidencePack {
  const { proposal } = input;
  const diff = summarizeDiff(proposal.diff);
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
    },
    verification: input.verification,
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
