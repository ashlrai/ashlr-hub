/**
 * routes/verse/resources/ResourcesHandle.tsx — the slim tab on the right edge
 * of every surface that opens the Resources drawer, its icon and its status
 * dot (unit 3.11 C6).
 *
 * Part of the ResourcesChrome chunk, fetched right after first paint (like the
 * rail's capacity ring). Until the summary has read there is no dot — "not
 * known" is never drawn as "fine". The dot is a shape plus words in the
 * accessible name, never colour alone.
 */
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import type { ResourcesSummary } from './resources-model.js';
import styles from './ResourcesChrome.module.css';

/** Three stacked capacity bars: accounts, compute, credits. 16px, 1.5px stroke, like the shared set. */
export function ResourcesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M2.75 4h10.5M2.75 8h10.5M2.75 12h10.5" opacity=".35" />
      <path d="M2.75 4h7M2.75 8h4M2.75 12h8.5" />
    </svg>
  );
}

/** `rail`: pinned to the corner of a rail icon, like the rail's own badges. */
export function ResourcesDot({ summary, rail = false }: { summary: ResourcesSummary | null; rail?: boolean }) {
  if (!summary || summary.tone === 'unknown') return null;
  const dot = <span className={styles.dot} data-tone={summary.tone} data-resources-dot={summary.tone} aria-hidden="true" />;
  return rail ? <span className={styles.railDot}>{dot}</span> : dot;
}

/** "Resources — 2 usable · 1 spent": the tooltip and the accessible name. */
export function resourcesLabel(summary: ResourcesSummary | null): string {
  return summary ? `Resources — ${summary.spoken}` : 'Resources';
}

export function ResourcesHandle({ summary, shortcut, onOpen, onWarm }: { summary: ResourcesSummary | null; shortcut: string | undefined; onOpen: () => void; onWarm?: () => void }) {
  return (
    <Tooltip label={resourcesLabel(summary)} shortcut={shortcut} placement="left">
      <button type="button" className={styles.handle} data-resources-handle aria-label={resourcesLabel(summary)} aria-haspopup="dialog" onClick={onOpen} onPointerEnter={onWarm} onFocus={onWarm}>
        <ResourcesIcon />
        <ResourcesDot summary={summary} />
      </button>
    </Tooltip>
  );
}
