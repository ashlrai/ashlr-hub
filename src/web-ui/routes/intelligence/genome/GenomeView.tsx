/**
 * routes/intelligence/genome/GenomeView.tsx — cross-repo knowledge search
 * (GET /api/genome[?q=]). ~2,014 entries across ~564 projects on the
 * operator's machine (per the brief), so: debounce the query, cap how many
 * rows render in browse mode (no query — the full unfiltered list), and
 * never eagerly render thousands of DOM rows.
 */
import { useEffect, useMemo, useState } from 'react';
import { genomeQuery, isRecallHit } from '../../../data/queries.js';
import { useQuery } from '../../../data/hooks.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonRow } from '../../../components/primitives/Skeleton.js';
import { ChartContainer, BarChart, chartFormat, type CategoricalDatum } from '../../../components/charts/index.js';
import type { GenomeEntry, RecallHit } from '../../../data/api-types.js';
import styles from './GenomeView.module.css';

const BROWSE_LIMIT = 50;
const DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function snippetOf(text: string, max = 220): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function relativeTs(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function GenomeView() {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, DEBOUNCE_MS);
  const resourceQuery = useQuery(genomeQuery(debouncedQuery));
  const isSearching = debouncedQuery.trim().length > 0;

  const data = resourceQuery.data;

  const { rows, totalCount } = useMemo(() => {
    if (!data) return { rows: [] as (GenomeEntry | RecallHit)[], totalCount: 0 };
    if (isSearching) return { rows: data, totalCount: data.length };
    const entries = data as GenomeEntry[];
    const sorted = [...entries].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return { rows: sorted.slice(0, BROWSE_LIMIT), totalCount: entries.length };
  }, [data, isSearching]);

  const projectBars: CategoricalDatum[] = useMemo(() => {
    if (!data || isSearching) return [];
    const entries = data as GenomeEntry[];
    const counts = new Map<string, number>();
    for (const e of entries) {
      const key = e.project ?? '(unscoped)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, value]) => ({ label, value }));
  }, [data, isSearching]);

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Genome</h1>
        <div aria-live="polite">{resourceQuery.status === 'refreshing' ? <RefreshIndicator /> : null}</div>
      </header>

      <div className={styles.searchRow}>
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search the genome (title, tags, body text)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search cross-repo knowledge"
        />
        {data ? (
          <span className={styles.resultCount}>
            {isSearching
              ? `${totalCount} match${totalCount === 1 ? '' : 'es'}`
              : `showing ${rows.length} of ${totalCount}`}
          </span>
        ) : null}
      </div>

      {!isSearching && projectBars.length > 0 ? (
        <ChartContainer title="Top projects by genome entries" description="browse mode — all loaded entries">
          <BarChart
            data={projectBars}
            orientation="horizontal"
            ariaLabel="Top projects by genome entry count"
            formatValue={(v) => chartFormat.formatCompact(v)}
          />
        </ChartContainer>
      ) : null}

      {resourceQuery.status === 'loading' ? (
        <div className={styles.skeletons} aria-hidden="true">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : resourceQuery.status === 'error' ? (
        <div className={styles.error} role="alert">
          {resourceQuery.error?.message ?? 'Failed to load genome data.'}
        </div>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>
          {isSearching ? `No genome entries match "${debouncedQuery}".` : 'No genome entries recorded yet.'}
        </p>
      ) : (
        <ul className={styles.results}>
          {rows.map((item) => {
            const hit = isRecallHit(item) ? item : null;
            const entry = hit ? hit.entry : (item as GenomeEntry);
            return (
              <li key={entry.id} className={styles.row}>
                <div className={styles.rowHeader}>
                  <span className={styles.rowTitle}>{entry.title}</span>
                  <span className={styles.rowMeta}>
                    {hit ? <span className={styles.badge}>{hit.method} · {hit.score.toFixed(2)}</span> : null}
                    <span>{relativeTs(entry.ts)}</span>
                  </span>
                </div>
                <div className={styles.rowMeta}>
                  <span className={styles.badge}>{entry.project ?? 'unscoped'}</span>
                  <span className={styles.badge}>{entry.source}</span>
                </div>
                <p className={styles.snippet}>{snippetOf(entry.text)}</p>
                {entry.tags.length > 0 ? (
                  <div className={styles.tags}>
                    {entry.tags.map((t) => (
                      <span key={t} className={styles.tag}>
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
