/**
 * routes/verse/resources/ResourceFacts.tsx — the facts row EVERY Resources
 * card carries, whatever the provider (3.15, "equal partners"):
 *
 *   Elite · subscription · Opus 5.5, Sonnet 5 +2 more
 *   Elite · credits · subscription · Devin, SWE, Opus · 10 ACUs kept for you
 *   Fast · free · SWE
 *
 * Tier and cost basis come from routing/tiers.ts — the same table the seat
 * router and the Auto seat rank with — so the drawer can never call a seat
 * elite that routing treats as something else.
 */
import { COST_BASIS_LABELS, TIER_BLURBS, TIER_LABELS, type CostBasis } from '../../../../core/routing/tiers.js';
import { modelsLine, type ResourceFactsView } from './resources-model.js';
import styles from './ResourcesDrawer.module.css';

export interface ResourceFactsProps {
  facts: ResourceFactsView;
  /** Extra cost bases a multi-seat card spans (Devin: cloud credits + CLI plan). */
  bases?: readonly CostBasis[];
}

export function ResourceFacts({ facts, bases }: ResourceFactsProps) {
  const models = modelsLine(facts.models);
  const allBases = [...new Set([facts.basis, ...(bases ?? [])])];
  return (
    <p className={styles.facts} data-resource-facts data-tier={facts.tier}>
      <span className={styles.tierChip} data-tier={facts.tier} title={TIER_BLURBS[facts.tier]}>{TIER_LABELS[facts.tier]}</span>
      <span title="What one more turn costs">{allBases.map((b) => COST_BASIS_LABELS[b]).join(' + ')}</span>
      {models !== null ? <span title={facts.models.join(', ')}>{models}</span> : null}
      {facts.reserve !== null ? <span>{facts.reserve}</span> : null}
    </p>
  );
}
