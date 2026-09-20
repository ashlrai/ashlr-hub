/**
 * routes/verse/ToolUseCard.tsx — one tool call.
 *
 * Collapsed it is a single dense line (DESIGN §5): a 12px glyph, the tool
 * name in mono, a truncated argument, and a right-aligned duration.
 * Expanded, input and output are bordered mono blocks. A failure tints the
 * left rule and nothing else — the word "error" carries the state.
 */
import { formatDuration, prettyJson, summarizeToolInput } from './verse-model.js';
import styles from './Transcript.module.css';

export interface ToolUseCardProps {
  name: string;
  input: unknown;
  result: { output: string; isError: boolean } | null;
  /** Stable id so open/closed state can survive re-renders (data-state-key). */
  toolUseId: string;
  /** tool-use → tool-result wall time, when both frames were stamped. */
  durationMs?: number | null;
}

const MAX_OUTPUT_CHARS = 20_000;

export function ToolUseCard({ name, input, result, toolUseId, durationMs = null }: ToolUseCardProps) {
  const summary = summarizeToolInput(input);
  const isError = result?.isError === true;
  const pending = result === null;
  const state = pending ? 'running' : isError ? 'error' : durationMs !== null && durationMs > 0 ? formatDuration(durationMs) : 'done';
  const output = result
    ? result.output.length > MAX_OUTPUT_CHARS
      ? `${result.output.slice(0, MAX_OUTPUT_CHARS)}\n… (${result.output.length - MAX_OUTPUT_CHARS} more characters)`
      : result.output
    : '';
  return (
    <details className={`${styles.tool} ${isError ? styles.toolFailed : ''}`} data-state-key={`tool:${toolUseId}`}>
      <summary className={styles.toolLine} aria-label={`${name}${summary ? `: ${summary}` : ''} (${state})`}>
        <span className={styles.toolGlyph} aria-hidden="true" />
        <span className={styles.toolName}>{name}</span>
        {summary ? <span className={styles.toolArg} title={summary}>{summary}</span> : null}
        <span className={styles.toolState}>{state}</span>
      </summary>
      <div className={styles.toolBody}>
        {input !== null && input !== undefined ? (
          <section>
            <h4 className={styles.toolLabel}>Input</h4>
            <pre className={styles.toolPre}>{prettyJson(input)}</pre>
          </section>
        ) : null}
        <section>
          <h4 className={styles.toolLabel}>{isError ? 'Error' : 'Result'}</h4>
          {pending ? <p className={styles.toolPending}>Waiting for the tool to finish…</p>
            : <pre className={styles.toolPre}>{output || '(empty)'}</pre>}
        </section>
      </div>
    </details>
  );
}
