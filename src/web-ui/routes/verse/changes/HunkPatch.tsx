/**
 * routes/verse/changes/HunkPatch.tsx — one file's changes in the Changes pane:
 * unified or side-by-side, syntax-highlighted, with WORD-level emphasis, and
 * an Accept / Reject bar on every hunk.
 *
 * Reuses the inbox parser (`parseUnifiedDiff`, `toSplitRows`) and highlighter
 * (`tokenizeLine`) and the Review pane's table styles, so a change looks the
 * same here, in Review, and in the transcript.
 *
 * Hunks are matched to the server's by position AND header: the server hashes
 * each hunk and a Reject names that hash, so a hunk that moved since the diff
 * was read is refused by the server instead of misapplied.
 */
import { useMemo, useState } from 'react';
import type { VerseCheckpointDecision, VerseCheckpointHunkInfo } from '../../../../core/verse/checkpoint-types.js';
import { parseUnifiedDiff, toSplitRows, type DiffLine } from '../../inbox/diff-parser.js';
import { languageForPath, tokenizeLine, type LangFamily } from '../../inbox/highlight.js';
import { wordDiff, type Span } from './changes-model.js';
import review from '../git/DiffPane.module.css';
import styles from './ChangesPanel.module.css';

export type PatchLayout = 'unified' | 'split';

/** Rows rendered before "Show all" (every row is DOM). */
export const HUNK_ROW_LIMIT = 3_000;

export interface HunkPatchProps {
  path: string;
  text: string;
  truncated: boolean;
  binary: boolean;
  hunks: readonly VerseCheckpointHunkInfo[];
  layout: PatchLayout;
  /** Accept/Reject are offered (a `since` view with no turn running). */
  actionable: boolean;
  /** The hunk hash whose action is in flight. */
  busyHunk: string | null;
  onHunk: (hash: string, decision: VerseCheckpointDecision) => void;
}

interface HunkView {
  key: string;
  label: string;
  info: VerseCheckpointHunkInfo | null;
  unified: Array<{ key: string; line: DiffLine; spans: Span[] }>;
  split: Array<{ key: string; left: DiffLine | null; right: DiffLine | null; leftSpans: Span[]; rightSpans: Span[] }>;
}

const HEADER_CORE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

function hunkLabel(header: string, index: number): string {
  const section = header.replace(/^@@[^@]*@@/, '').trim();
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  const where = m ? `Line ${m[2]}` : `Hunk ${index + 1}`;
  return section ? `${where} · ${section}` : where;
}

function build(text: string, infos: readonly VerseCheckpointHunkInfo[]): { hunks: HunkView[]; notice: string | null; status: string } {
  const file = parseUnifiedDiff(text).files[0];
  if (!file) return { hunks: [], notice: null, status: 'modified' };
  const hunks = file.hunks.map((hunk, h): HunkView => {
    const candidate = infos[h];
    const core = HEADER_CORE.exec(hunk.header)?.[0];
    const info = candidate && core && candidate.header.startsWith(core) ? candidate : null;
    const pairs = toSplitRows(hunk.lines);
    const spansOf = new Map<DiffLine, Span[]>();
    for (const p of pairs) {
      if (p.left && p.right && p.left.kind === 'del' && p.right.kind === 'add') {
        const w = wordDiff(p.left.text, p.right.text);
        if (w) {
          spansOf.set(p.left, w.old);
          spansOf.set(p.right, w.new);
        }
      }
    }
    return {
      key: `h${h}`,
      label: hunkLabel(hunk.header, h),
      info,
      unified: hunk.lines.map((line, i) => ({ key: `h${h}l${i}`, line, spans: spansOf.get(line) ?? [] })),
      split: pairs.map((p, i) => ({
        key: `h${h}p${i}`,
        left: p.left,
        right: p.right,
        leftSpans: p.left ? spansOf.get(p.left) ?? [] : [],
        rightSpans: p.right ? spansOf.get(p.right) ?? [] : [],
      })),
    };
  });
  return { hunks, notice: file.unparsedNotice, status: file.status };
}

export function HunkPatch({ path, text, truncated, binary, hunks, layout, actionable, busyHunk, onHunk }: HunkPatchProps) {
  const lang = languageForPath(path);
  const built = useMemo(() => build(text, hunks), [text, hunks]);
  const [showAll, setShowAll] = useState(false);

  if (binary) return <p className={review.patchNotice}>Binary file — accept or reject it as a whole.</p>;
  if (built.hunks.length === 0) {
    if (built.notice) return <p className={review.patchNotice}>{built.notice}</p>;
    return (
      <p className={review.patchNotice}>
        {built.status === 'renamed' ? 'Renamed with no content changes.' : 'No line changes (a mode or permission change).'}
      </p>
    );
  }

  let budget = showAll ? Number.POSITIVE_INFINITY : HUNK_ROW_LIMIT;
  let cut = false;
  const totalRows = built.hunks.reduce((n, h) => n + (layout === 'split' ? h.split.length : h.unified.length), 0);

  return (
    <div className={review.patch}>
      {truncated ? (
        <p className={review.truncated} role="note">
          Showing the first 256 KB of this file’s changes. Reject it as a whole, or open it in your editor for the rest.
        </p>
      ) : null}
      <table className={review.grid} data-layout={layout} aria-label={`Changes in ${path}`}>
        {built.hunks.map((hunk) => {
          if (budget <= 0) {
            cut = true;
            return null;
          }
          const rows = layout === 'split' ? hunk.split : hunk.unified;
          const shown = rows.slice(0, Math.max(0, budget));
          budget -= shown.length;
          if (shown.length < rows.length) cut = true;
          const accepted = hunk.info?.accepted ?? false;
          const busy = hunk.info !== null && busyHunk === hunk.info.hash;
          return (
            <tbody key={hunk.key} className={styles.hunk} data-accepted={accepted ? 'true' : undefined}>
              <tr className={review.hunkRow}>
                <td colSpan={5}>
                  <div className={styles.hunkBar}>
                    <span className={styles.hunkLabel}>{hunk.label}</span>
                    {accepted ? <span className={styles.reviewed}>Accepted</span> : null}
                    {actionable && hunk.info ? (
                      <span className={styles.hunkActions}>
                        {!accepted ? (
                          <button
                            type="button"
                            className={styles.hunkButton}
                            disabled={busyHunk !== null}
                            onClick={() => onHunk(hunk.info!.hash, 'accept')}
                            aria-label={`Accept the change at ${hunk.label} in ${path}`}
                          >
                            Accept
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={styles.hunkButton}
                          data-tone="danger"
                          disabled={busyHunk !== null}
                          aria-busy={busy || undefined}
                          onClick={() => onHunk(hunk.info!.hash, 'reject')}
                          aria-label={`Reject the change at ${hunk.label} in ${path} (restore it from the checkpoint)`}
                        >
                          {busy ? 'Restoring…' : 'Reject'}
                        </button>
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
              {layout === 'unified'
                ? (shown as HunkView['unified']).map((row) => (
                  <tr key={row.key} className={review.lineRow} data-kind={row.line.kind}>
                    <td className={review.no} aria-hidden="true">{row.line.oldLineNo ?? ''}</td>
                    <td className={review.no} aria-hidden="true">{row.line.newLineNo ?? ''}</td>
                    <td className={review.gutter} aria-hidden="true" />
                    <td className={review.marker} aria-hidden="true">
                      {row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '−' : ''}
                    </td>
                    <td className={review.code} aria-label={lineLabel(row.line)}>
                      <Code text={row.line.text} lang={lang} spans={row.line.kind === 'context' ? [] : row.spans} />
                    </td>
                  </tr>
                ))
                : (shown as HunkView['split']).map((row) => (
                  <tr key={row.key} className={review.lineRow} data-kind="pair">
                    <td className={review.no} aria-hidden="true">{row.left?.oldLineNo ?? ''}</td>
                    <td className={review.half} data-kind={row.left?.kind ?? 'empty'} aria-label={row.left ? lineLabel(row.left) : undefined}>
                      {row.left ? <Code text={row.left.text} lang={lang} spans={row.left.kind === 'context' ? [] : row.leftSpans} /> : null}
                    </td>
                    <td className={review.gutter} aria-hidden="true" />
                    <td className={review.no} aria-hidden="true">{row.right?.newLineNo ?? ''}</td>
                    <td className={review.half} data-kind={row.right?.kind ?? 'empty'} aria-label={row.right && row.right !== row.left ? lineLabel(row.right) : undefined}>
                      {row.right ? <Code text={row.right.text} lang={lang} spans={row.right.kind === 'context' ? [] : row.rightSpans} /> : null}
                    </td>
                  </tr>
                ))}
            </tbody>
          );
        })}
      </table>
      {cut ? (
        <button type="button" className={review.showAll} onClick={() => setShowAll(true)}>
          Show all {totalRows.toLocaleString('en-US')} lines
        </button>
      ) : null}
    </div>
  );
}

function lineLabel(line: DiffLine): string {
  const n = line.kind === 'del' ? line.oldLineNo : line.newLineNo;
  const what = line.kind === 'add' ? 'added' : line.kind === 'del' ? 'removed' : 'unchanged';
  return `Line ${n ?? '—'}, ${what}: ${line.text}`;
}

/** Highlighted tokens, cut at the word-diff spans so highlighting and emphasis compose. */
function Code({ text, lang, spans }: { text: string; lang: LangFamily; spans: readonly Span[] }) {
  const tokens = tokenizeLine(text, lang);
  if (spans.length === 0) {
    return (
      <code className={review.codeText}>
        {tokens.map((t, i) => (
          <span key={i} className={review[`tok_${t.kind}`]}>{t.text}</span>
        ))}
      </code>
    );
  }
  const inSpan = (at: number) => spans.some(([a, b]) => at >= a && at < b);
  const cuts = new Set<number>([0, text.length]);
  for (const [a, b] of spans) {
    cuts.add(a);
    cuts.add(b);
  }
  const parts: Array<{ text: string; kind: string; em: boolean }> = [];
  let at = 0;
  for (const t of tokens) {
    const start = at;
    const end = at + t.text.length;
    const points = [start, ...[...cuts].filter((c) => c > start && c < end).sort((x, y) => x - y), end];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      if (b > a) parts.push({ text: text.slice(a, b), kind: t.kind, em: inSpan(a) });
    }
    at = end;
  }
  return (
    <code className={review.codeText}>
      {parts.map((p, i) => (
        <span key={i} className={`${review[`tok_${p.kind}`] ?? ''} ${p.em ? review.em : ''}`} data-em={p.em ? 'true' : undefined}>{p.text}</span>
      ))}
    </code>
  );
}
