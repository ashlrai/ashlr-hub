/**
 * First-class autonomy policy.
 *
 * The merge gate answers "did this candidate satisfy the mechanical checks?"
 * This policy answers "what is the farthest autonomous action Ashlr is allowed
 * to take with the evidence currently available?"
 */

import type { AshlrConfig } from '../types.js';
import type { AutonomyEvidencePack } from './evidence-pack.js';

export type AutonomyTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';

export type AutonomyAction =
  | 'escalate-human'
  | 'propose-only'
  | 'apply-local-branch'
  | 'open-ready-pr'
  | 'merge-main'
  | 'deploy-preview'
  | 'deploy-prod';

export interface AutonomyPolicyVerdict {
  tier: AutonomyTier;
  action: AutonomyAction;
  allowed: boolean;
  reason: string;
}

const RISK_ORDER: Record<'low' | 'medium' | 'high', number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function refuse(reason: string): AutonomyPolicyVerdict {
  return { tier: 'T0', action: 'escalate-human', allowed: false, reason };
}

function allow(tier: AutonomyTier, action: AutonomyAction, reason: string): AutonomyPolicyVerdict {
  return { tier, action, allowed: true, reason };
}

function autoMergeCfg(cfg: AshlrConfig): Record<string, unknown> {
  return ((cfg.foundry as Record<string, unknown> | undefined)?.['autoMerge'] as Record<string, unknown> | undefined) ?? {};
}

function maxRisk(cfg: AshlrConfig): 'low' | 'medium' | 'high' {
  const value = autoMergeCfg(cfg)['maxRisk'];
  return value === 'medium' || value === 'high' ? value : 'low';
}

export function evaluateAutonomyPolicy(
  pack: AutonomyEvidencePack,
  cfg: AshlrConfig,
): AutonomyPolicyVerdict {
  if (pack.proposal.kind === 'deploy') {
    return refuse('deploy proposals require a dedicated deploy/canary/rollback policy');
  }
  if (pack.proposal.kind !== 'patch' && pack.proposal.kind !== 'pr') {
    return allow('T1', 'propose-only', `proposal kind '${pack.proposal.kind}' is not code-applyable`);
  }
  if (pack.diff.files.length === 0 || pack.diff.changedLines === 0) {
    return refuse('diff evidence is empty or unparsable');
  }

  const required = [
    ['authority', pack.gates.authority],
    ['provenance', pack.gates.provenance],
    ['verification', pack.gates.verification],
    ['risk', pack.gates.risk],
    ['scope', pack.gates.scope],
  ] as const;
  for (const [name, gate] of required) {
    if (!gate.ok) return refuse(`${name} gate failed: ${gate.detail}`);
  }
  if (pack.gates.manager && !pack.gates.manager.ok) {
    return refuse(`manager gate failed: ${pack.gates.manager.detail}`);
  }
  if (pack.gates.edv && !pack.gates.edv.ok) {
    return refuse(`EDV gate failed: ${pack.gates.edv.detail}`);
  }
  if (pack.gates.selfTarget && !pack.gates.selfTarget.ok) {
    return refuse(`self-target gate failed: ${pack.gates.selfTarget.detail}`);
  }
  if (!pack.verification.passed) {
    return refuse(`verification did not pass: ${pack.verification.detail}`);
  }
  if (RISK_ORDER[pack.riskClass] > RISK_ORDER[maxRisk(cfg)]) {
    return refuse(`risk '${pack.riskClass}' exceeds configured maxRisk '${maxRisk(cfg)}'`);
  }

  if (pack.target === 'branch') {
    return pack.remotePreferred
      ? allow('T3', 'open-ready-pr', 'branch-target evidence passed; open a ready PR for host review')
      : allow('T2', 'apply-local-branch', 'branch-target evidence passed; stage a local review branch');
  }
  if (pack.target === 'main') {
    if (pack.trustBasis === 'evidence') {
      if (!pack.remotePreferred) {
        return refuse('evidence main merge requires protected remote PR handoff; local merge fallback is not permitted');
      }
      if (!pack.gates.remoteProtection?.ok) {
        return refuse(`remote protection gate failed: ${pack.gates.remoteProtection?.detail ?? 'missing protected remote evidence'}`);
      }
      if (pack.verification.commandKinds.length === 0) {
        return refuse('evidence main merge requires at least one real verification command');
      }
    }
    return allow(
      'T4',
      'merge-main',
      pack.remotePreferred
        ? 'main-target evidence passed; merge through protected remote PR path'
        : 'main-target evidence passed; local merge fallback is permitted by current config',
    );
  }
  if (pack.target === 'preview') {
    return allow('T5', 'deploy-preview', 'preview deployment evidence passed');
  }
  if (pack.target === 'production') {
    return refuse('production deployment requires explicit T5 rollout evidence');
  }
  return allow('T1', 'propose-only', 'proposal evidence recorded; no autonomous mutation target selected');
}
