/** Canonical hashing and domain-separated attestation for skill-card revisions. */

import { createHash } from 'node:crypto';
import type { SkillCard } from '../types.js';
import {
  signSkillCardAttestation,
  verifySkillCardAttestation,
} from '../foundry/provenance.js';
import { hasReleasedPostMergeCredit } from './post-merge-credit.js';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) out[key] = stableValue(entry);
  }
  return out;
}

function immutablePayload(card: SkillCard): Record<string, unknown> {
  const { contentHash: _contentHash, attestation: _attestation, ...payload } = card;
  return stableValue(payload) as Record<string, unknown>;
}

export function skillCardContentHash(card: SkillCard): string {
  return createHash('sha256')
    .update(JSON.stringify(immutablePayload(card)), 'utf8')
    .digest('hex');
}

export function attestSkillCard(card: SkillCard): SkillCard | null {
  try {
    // The generic attester cannot mint positive post-merge learning authority.
    // A future release protocol must own that proof and its signing boundary.
    if (hasReleasedPostMergeCredit(card.labelBasis)) return null;
    const diffHash = card.verification?.diffHash;
    if (!card.proposalId || !diffHash) return null;
    const contentHash = skillCardContentHash(card);
    const attestation = signSkillCardAttestation({
      contentHash,
      skillId: card.skillId,
      revision: card.revision,
      proposalId: card.proposalId,
      diffHash,
    });
    return attestation ? { ...card, contentHash, attestation } : null;
  } catch {
    return null;
  }
}

export function verifyAttestedSkillCard(card: SkillCard): boolean {
  try {
    const diffHash = card.verification?.diffHash;
    if (!card.contentHash || !card.attestation || !card.proposalId || !diffHash) return false;
    if (skillCardContentHash(card) !== card.contentHash) return false;
    return verifySkillCardAttestation(card.attestation, {
      contentHash: card.contentHash,
      skillId: card.skillId,
      revision: card.revision,
      proposalId: card.proposalId,
      diffHash,
    }).ok;
  } catch {
    return false;
  }
}
