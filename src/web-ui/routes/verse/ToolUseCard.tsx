/**
 * routes/verse/ToolUseCard.tsx — one tool call.
 *
 * Collapsed it is a single dense line (DESIGN §5): a 12px glyph, the tool
 * name in mono, a truncated argument, and a right-aligned duration. A call
 * that changed a file also carries its `+12 −3` there, in the display font,
 * because the size of a change is the thing most worth knowing before
 * deciding to open it.
 *
 * Expanded, the body is chosen by what the call actually DID
 * (`chat/tool-semantics.ts`) rather than by dumping JSON:
 *
 *   - an edit / create / patch   → a real unified diff (`chat/DiffBlock`,
 *     which reuses the inbox parser, highlighter and multi-file viewer)
 *   - a shell run                → the command, an honest exit status, and
 *     output with ANSI stripped and long logs collapsed (`chat/CommandOutput`)
 *   - anything else              → the input and result as mono blocks, as before
 *
 * A failure tints the left rule and nothing else — the word "error" carries
 * the state (DESIGN §6).
 *
 * Paths read relative to the chat's roots (chat/path-display.ts): a Read of
 * `/private/tmp/…/e2e-proj-39/math.ts` is drawn as `math.ts`, with the full
 * path in the tooltip. The disclosure glyph is the same ▸ the activity row
 * and the reasoning row use, so every foldable line opens the same way.
 */
import { useMemo, useState } from 'react';
import { CommandOutput } from './chat/CommandOutput.js';
import { LiveTimer } from './chat/LiveTimer.js';
import { DiffBlock } from './chat/DiffBlock.js';
import { useDisplayPath } from './chat/path-display.js';
import { countDiffLines } from './chat/turn-model.js';
import { readToolFacts, toolAnchorId, type ToolFacts } from './chat/tool-semantics.js';
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
  /**
   * Derived once per transcript by `chat/turn-model.buildTurns` and handed
   * down, so a card never re-parses a diff the file-activity summary already
   * parsed. Omitted (tests, one-off renders) it is derived here.
   */
  facts?: ToolFacts;
  /** 3.10: ISO start of the call — a pending card counts up from it ("running 12s"). */
  startedAt?: string | null;
}

const MAX_OUTPUT_CHARS = 20_000;
/** Changed lines previewed under a collapsed edit (V3.15). */
const MINI_DIFF_LINES = 3;
const MINI_DIFF_LINE_CHARS = 140;

export interface MiniDiffLine { sign: '+' | '-'; text: string }

/**
 * The first few CHANGED lines of a unified diff — what a collapsed edit row
 * previews so a scan down the timeline shows what each edit did without a
 * click. Headers and context lines are skipped; `more` is the exact count of
 * changed lines not shown.
 */
export function miniDiffPreview(diffText: string, max = MINI_DIFF_LINES): { lines: MiniDiffLine[]; more: number } {
  const lines: MiniDiffLine[] = [];
  let changed = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const sign = line[0];
    if (sign !== '+' && sign !== '-') continue;
    changed += 1;
    if (lines.length < max) {
      const text = line.slice(1);
      lines.push({ sign, text: text.length > MINI_DIFF_LINE_CHARS ? `${text.slice(0, MINI_DIFF_LINE_CHARS - 1)}…` : text });
    }
  }
  return { lines, more: changed - lines.length };
}

export function ToolUseCard({ name, input, result, toolUseId, durationMs = null, facts, startedAt = null }: ToolUseCardProps) {
  const derived = useMemo(
    () => facts ?? readToolFacts({ name, input, result }),
    [facts, name, input, result],
  );
  const show = useDisplayPath();
  const [open, setOpen] = useState(false);
  // A file call names its file, relative to the chat's roots — never the
  // 96-character head of an absolute path whose filename the cut dropped. A
  // shell run keeps its command line verbatim. V3.15: a web call names its
  // query or its page (domain + path), a subagent call its brief.
  const target = derived.command ? null : derived.paths[0] ?? null;
  const summary = target !== null
    ? `${show(target)}${derived.paths.length > 1 ? ` +${derived.paths.length - 1}` : ''}`
    : derived.web
      ? derived.web.mode === 'search' && derived.web.query
        ? derived.web.query
        : derived.web.url ?? derived.web.query ?? summarizeToolInput(input)
      : derived.task?.description
        ? `${derived.task.agent ? `${derived.task.agent}: ` : ''}${derived.task.description}`
        : summarizeToolInput(input);
  const isError = derived.failed || result?.isError === true;
  const pending = result === null;
  const state = pending
    ? 'running'
    : isError
      ? 'error'
      : durationMs !== null && durationMs > 0
        ? formatDuration(durationMs)
        : 'done';
  // Re-splitting the whole diff on every render of every card is pure waste:
  // the text is immutable once the result has landed.
  const delta = useMemo(
    () => (derived.diff ? countDiffLines(derived.diff.text) : null),
    [derived.diff],
  );
  // V3.15: a collapsed edit previews its first changed lines under the row.
  const mini = useMemo(
    () => (derived.diff && (derived.action === 'edit' || derived.action === 'create') && !derived.command ? miniDiffPreview(derived.diff.text) : null),
    [derived.diff, derived.action, derived.command],
  );
  const output = result
    ? result.output.length > MAX_OUTPUT_CHARS
      ? `${result.output.slice(0, MAX_OUTPUT_CHARS)}\n… (${result.output.length - MAX_OUTPUT_CHARS} more characters)`
      : result.output
    : '';

  return (
    <>
    <details id={toolAnchorId(toolUseId)} className={`${styles.tool} ${isError ? styles.toolFailed : ''}`}
      data-state-key={`tool:${toolUseId}`} data-action={derived.action}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={styles.toolLine} aria-label={`${name}${summary ? `: ${summary}` : ''} (${state})`}>
        <span className={styles.toolGlyph} aria-hidden="true" />
        <span className={styles.toolName}>{name}</span>
        {summary ? <span className={styles.toolArg} title={target ?? derived.web?.url ?? summary}>{summary}</span> : null}
        {delta && (delta.additions > 0 || delta.deletions > 0) ? (
          <span className={styles.toolDelta} aria-hidden="true">
            {delta.additions > 0 ? <span className={styles.toolAdd}>+{delta.additions}</span> : null}
            {delta.deletions > 0 ? <span className={styles.toolDel}>−{delta.deletions}</span> : null}
          </span>
        ) : null}
        <span className={styles.toolState}>
          {pending && startedAt ? <>running <LiveTimer since={startedAt} /></> : state}
        </span>
      </summary>
      <div className={styles.toolBody}>
        <ToolBody input={input} output={output} facts={derived} pending={pending} isError={isError} />
      </div>
    </details>
    {mini && !open && mini.lines.length > 0 ? (
      <div className={styles.miniDiff} aria-hidden="true" data-kind="mini-diff">
        {mini.lines.map((line, i) => (
          <div key={i} className={line.sign === '+' ? styles.miniAdd : styles.miniDel}>
            <span className={styles.miniSign}>{line.sign === '+' ? '+' : '−'}</span>{line.text || ' '}
          </div>
        ))}
        {mini.more > 0 ? <div className={styles.miniMore}>{mini.more} more changed line{mini.more === 1 ? '' : 's'}</div> : null}
      </div>
    ) : null}
    </>
  );
}

interface ToolBodyProps {
  input: unknown;
  output: string;
  facts: ToolFacts;
  pending: boolean;
  isError: boolean;
}

function ToolBody({ input, output, facts, pending, isError }: ToolBodyProps) {
  const show = useDisplayPath();
  // A shell run: the command line and exit status always, with the diff in
  // place of the log when the command's own output is one.
  if (facts.command) {
    return (
      <CommandOutput command={facts.command} output={output} isError={isError} pending={pending}
        body={facts.diff ? <DiffBlock diff={facts.diff} path={facts.paths[0] ?? null} /> : undefined} />
    );
  }

  if (facts.diff) {
    return (
      <>
        <DiffBlock diff={facts.diff} path={facts.paths[0] ?? null} />
        {pending ? <p className={styles.toolPending}>Waiting for the tool to finish…</p> : null}
        {isError && output ? (
          <section>
            <h4 className={styles.toolLabel}>Error</h4>
            <pre className={styles.toolPre}>{output}</pre>
          </section>
        ) : null}
      </>
    );
  }

  if (facts.written) {
    return (
      <>
        <section>
          <h4 className={styles.toolLabel}>
            Contents written to <span className={styles.toolLabelPath} title={facts.written.path}>{show(facts.written.path)}</span>
          </h4>
          <pre className={styles.toolPre}>{facts.written.text}</pre>
          <p className={styles.toolNote}>
            The previous contents were not in this tool call, so there is nothing to diff against.
          </p>
        </section>
        <section>
          <h4 className={styles.toolLabel}>{isError ? 'Error' : 'Result'}</h4>
          {pending ? <p className={styles.toolPending}>Waiting for the tool to finish…</p>
            : <pre className={styles.toolPre}>{output || '(empty)'}</pre>}
        </section>
      </>
    );
  }

  return (
    <>
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
    </>
  );
}
