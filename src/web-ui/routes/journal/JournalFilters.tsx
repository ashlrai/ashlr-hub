/**
 * routes/journal/JournalFilters.tsx — fully controlled filter bar: source
 * toggles, free-text search, and a time-window quick-pick. Kept dumb on
 * purpose (all state lives in JournalView) so it stays trivially testable
 * and swappable.
 */
import type { JournalSource } from './journal-model.js';
import { startOfTodayMs } from './journal-model.js';
import styles from './JournalFilters.module.css';

const SOURCE_OPTIONS: { value: JournalSource; label: string }[] = [
  { value: 'run', label: 'Runs' },
  { value: 'merge', label: 'Merges' },
  { value: 'proposal', label: 'Proposals' },
  { value: 'agent-action', label: 'Agent actions' },
  { value: 'daemon-tick', label: 'Daemon ticks' },
];

// 'today' is dynamic (since local midnight, not a fixed rolling window) so
// it carries `dynamic: true` instead of a fixed `ms` — the select handler
// below recomputes it at selection time via startOfTodayMs(). Same value the
// command palette's "Open journal — today" action seeds JournalView with.
const WINDOW_OPTIONS: { value: string; label: string; ms: number | null; dynamic?: boolean }[] = [
  { value: '1h', label: 'Last hour', ms: 60 * 60 * 1000 },
  { value: 'today', label: 'Today', ms: null, dynamic: true },
  { value: '24h', label: 'Last 24h', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: 'all', label: 'All available', ms: null },
];

export interface JournalFiltersProps {
  sources: Set<JournalSource>;
  onSourcesChange: (next: Set<JournalSource>) => void;
  query: string;
  onQueryChange: (next: string) => void;
  windowValue: string;
  onWindowChange: (value: string, ms: number | null) => void;
}

export function JournalFilters({ sources, onSourcesChange, query, onQueryChange, windowValue, onWindowChange }: JournalFiltersProps) {
  function toggleSource(source: JournalSource) {
    const next = new Set(sources);
    if (next.has(source)) next.delete(source);
    else next.add(source);
    onSourcesChange(next);
  }

  return (
    <div className={styles.bar}>
      <input
        type="search"
        className={styles.search}
        placeholder="Search title, detail, repo…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        aria-label="Search the work journal"
      />
      <div className={styles.sources} role="group" aria-label="Filter by source">
        {SOURCE_OPTIONS.map((opt) => (
          <label key={opt.value} className={styles.sourceOption}>
            <input type="checkbox" checked={sources.has(opt.value)} onChange={() => toggleSource(opt.value)} />
            {opt.label}
          </label>
        ))}
      </div>
      <select
        className={styles.windowSelect}
        value={windowValue}
        onChange={(e) => {
          const opt = WINDOW_OPTIONS.find((o) => o.value === e.target.value);
          onWindowChange(e.target.value, opt?.dynamic ? startOfTodayMs() : (opt?.ms ?? null));
        }}
        aria-label="Time window"
      >
        {WINDOW_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export const ALL_JOURNAL_SOURCES = new Set<JournalSource>(SOURCE_OPTIONS.map((o) => o.value));
