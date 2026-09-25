/**
 * routes/verse/git/PrChip.tsx — a pull request as one chip: an icon WITH a
 * word (`#463 · Merged ✓`, `#481 · Open · 2 of 9 checks failing`) — never a
 * colour alone (DESIGN §13.2 status rule; SPEC-310C §2 "PR chips").
 *
 * It is a link to the PR on GitHub (a new window; the desktop shell hands it
 * to the browser). The title is shown at wide widths and folded into the
 * accessible name at narrow ones.
 */
import type { VerseGitPr } from '../../../data/api-types.js';
import { prChip, type GitCheckCounts, type PrTone } from './git-model.js';
import styles from './PrChip.module.css';

export interface PrChipProps {
  pr: VerseGitPr;
  counts?: GitCheckCounts | null;
  /** Show the PR title (wide layouts). */
  showTitle?: boolean;
}

export function PrChip({ pr, counts = null, showTitle = true }: PrChipProps) {
  const model = prChip(pr, counts);
  return (
    <a
      className={styles.chip}
      data-tone={model.tone}
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${model.label}. Opens on GitHub.`}
      title={`${model.label}. Opens on GitHub.`}
    >
      <PrGlyph tone={model.tone} state={pr.state} />
      <span className={styles.number}>{model.number}</span>
      {showTitle && pr.title ? <span className={styles.title}>{pr.title}</span> : null}
      <span className={styles.state}>
        {model.state}
        {pr.state === 'merged' ? ' ✓' : ''}
      </span>
      {model.checks ? <span className={styles.checks}>{model.checks}</span> : null}
    </a>
  );
}

/** Small state glyph, drawn in currentColor so it follows the tone token. */
function PrGlyph({ tone, state }: { tone: PrTone; state: VerseGitPr['state'] }) {
  const common = { width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': true as const, className: styles.glyph };
  if (state === 'merged') {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="4" cy="3.5" r="1.8" />
        <circle cx="4" cy="12.5" r="1.8" />
        <circle cx="12" cy="8" r="1.8" />
        <path d="M4 5.3v5.4M5.2 4.6c1.4 2.2 3.2 3.4 5 3.4" />
      </svg>
    );
  }
  if (state === 'closed') {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="4" cy="3.5" r="1.8" />
        <circle cx="4" cy="12.5" r="1.8" />
        <path d="M4 5.3v5.4M10 3l4 4M14 3l-4 4" />
      </svg>
    );
  }
  if (tone === 'running') return <span className={styles.pulse} aria-hidden="true" />;
  if (tone === 'danger') {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="8" cy="8" r="6" />
        <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
      </svg>
    );
  }
  if (tone === 'success') {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6" />
        <path d="M5.2 8.2l2 2 3.6-4" />
      </svg>
    );
  }
  // Open or draft with nothing to report: the pull-request glyph (dashed for a draft).
  return (
    <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray={state === 'draft' ? '2 2' : undefined}>
      <circle cx="4" cy="3.5" r="1.8" />
      <circle cx="4" cy="12.5" r="1.8" />
      <circle cx="12" cy="12.5" r="1.8" />
      <path d="M4 5.3v5.4M12 10.7V6.5c0-1.4-.8-2.2-2.2-2.2H7.5" />
    </svg>
  );
}
