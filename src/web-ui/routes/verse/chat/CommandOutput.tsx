/**
 * routes/verse/chat/CommandOutput.tsx — a shell run, readable.
 *
 * Three things were wrong with dumping `tool-result.output` into a <pre>:
 * escape sequences printed as `[0;32m` litter, progress bars repeated every
 * carriage-return frame, and a thousand-line build log pushed the rest of
 * the turn off the screen. All three are fixed here without losing anything:
 * `ansi.ts` cleans the text, long output collapses to a head with an exact
 * count of what is hidden, and "Show all" restores it.
 *
 * The status line is honest (DESIGN §6). A stated exit code is printed as a
 * number; when the tool never stated one, the line says whether the call
 * failed and does not invent a code.
 *
 * 3.10 (SPEC-310C §2, unit C2): "Run in terminal" opens the dock's Terminal
 * with the command PASTED at the prompt — never executed. The operator reads
 * it there and presses Enter; an agent's command must not re-run because
 * someone clicked near it. Offered only once the Terminal pane exists in
 * this build (C4's slot).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { isSlotAvailable } from '../shell/slots.js';
import { requestTerminal } from '../dock/dock-store.js';
import { cleanTerminalOutput, countLines, hasAnsi, headLines } from './ansi.js';
import type { CommandFacts } from './tool-semantics.js';
import styles from './chat.module.css';

const PREVIEW_LINES = 20;
/** Hard ceiling: past this, the DOM cost stops being worth it. */
const MAX_RENDER_CHARS = 200_000;

export interface CommandOutputProps {
  command: CommandFacts | null;
  output: string;
  /** The tool reported failure for this call. */
  isError: boolean;
  pending: boolean;
  /**
   * Replaces the raw output block. A command whose output IS a diff
   * (`git diff`, `git show`) keeps its command line and exit status here and
   * renders the diff properly instead of as terminal text.
   */
  body?: ReactNode;
  /** Whether "Run in terminal" is offered; defaults to whether C4's Terminal pane is in this build (tests inject it). */
  terminalAvailable?: boolean;
}

export function CommandOutput({ command, output, isError, pending, body, terminalAvailable = isSlotAvailable('terminal-pane') }: CommandOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const cleaned = useMemo(() => {
    const text = cleanTerminalOutput(output);
    return text.length > MAX_RENDER_CHARS
      ? `${text.slice(0, MAX_RENDER_CHARS)}\n… (${text.length - MAX_RENDER_CHARS} more characters not shown)`
      : text;
  }, [output]);
  const { head, hidden } = useMemo(() => headLines(cleaned, PREVIEW_LINES), [cleaned]);
  const shown = expanded ? cleaned : head;
  const exit = command?.exitCode ?? null;

  return (
    <div className={styles.command} data-failed={isError ? 'true' : undefined}>
      {command ? (
        <div className={styles.commandLine}>
          <span className={styles.commandPrompt} aria-hidden="true">$</span>
          <code className={styles.commandText}>{command.command}</code>
          {terminalAvailable && command.command.trim() ? (
            <button type="button" className={styles.commandRun}
              title="Opens the Terminal with this command typed at the prompt. It does not run until you press Enter."
              onClick={() => requestTerminal({ paste: command.command })}>
              Run in terminal
            </button>
          ) : null}
        </div>
      ) : null}
      <div className={styles.commandStatus}>
        <span className={styles.commandStatusText} data-tone={pending ? 'pending' : isError ? 'bad' : 'ok'}>
          {pending
            ? 'running…'
            : exit !== null
              ? `exit ${exit}`
              : isError
                ? 'failed — no exit code reported'
                : 'completed — no exit code reported'}
        </span>
        {!pending && !body && cleaned.length === 0 ? <span className={styles.commandMeta}>no output</span> : null}
        {!pending && !body && cleaned.length > 0 ? (
          <span className={styles.commandMeta}>
            {countLines(cleaned)} line{countLines(cleaned) === 1 ? '' : 's'}
            {hasAnsi(output) ? ' · colour codes stripped' : ''}
          </span>
        ) : null}
      </div>
      {pending ? (
        <p className={styles.commandPending}>Waiting for the command to finish…</p>
      ) : body ? (
        body
      ) : cleaned.length > 0 ? (
        <>
          <pre className={styles.commandPre}>{shown}</pre>
          {hidden > 0 ? (
            <button type="button" className={styles.commandMore} aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Collapse output' : `Show ${hidden} more line${hidden === 1 ? '' : 's'}`}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
