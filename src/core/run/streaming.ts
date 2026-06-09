/**
 * M11: streaming.ts — StreamSink type + nullSink / makeCliSink factories.
 *
 * A StreamSink receives live RunStreamEvents from the agent loop and renders
 * them to the terminal. The sink contract:
 *   - NEVER throws to the caller (all errors caught internally).
 *   - NEVER prints secret values (events carry metadata/text only).
 *   - model-delta events render incrementally (process.stdout/stderr.write,
 *     no trailing newline) so the token stream looks live.
 *   - Lifecycle events (task-start, task-done, retry, verify, tool-call, log)
 *     render as full labeled lines with glyphs + color.
 *   - When opts.json === true the human stream goes to STDERR so stdout stays
 *     clean machine JSON.
 */

import type { RunStreamEvent } from '../types.js';
import { makeColors } from '../../cli/ui.js';

/** A sink that receives live run events. Never throws to the caller. */
export type StreamSink = (e: RunStreamEvent) => void;

/** A no-op sink — used when streaming is disabled or in unit tests. */
export function nullSink(): StreamSink {
  return (_e: RunStreamEvent) => { /* intentional no-op */ };
}

/**
 * Build a CLI sink that renders a live, readable stream.
 *
 * - opts.json === true  → human lines go to STDERR (stdout stays clean JSON).
 * - opts.json === false → lines go to STDERR when isTTY, else STDOUT.
 *
 * model-delta events are written inline (no newline) so the token stream looks
 * continuous. All other event kinds start on their own labeled line.
 */
export function makeCliSink(opts: { json: boolean }): StreamSink {
  // Choose the output stream: always STDERR when json mode so stdout is clean.
  const out = opts.json ? process.stderr : process.stderr;
  const isTty = out.isTTY === true;
  const col = makeColors(isTty);

  // Track whether we're mid-line on a model-delta run (so we know when to
  // emit a leading newline before a lifecycle label).
  let midDelta = false;

  function write(s: string): void {
    try { out.write(s); } catch { /* never throw */ }
  }

  function writeln(s: string): void {
    // If we were streaming model deltas inline, break to a new line first.
    if (midDelta) {
      write('\n');
      midDelta = false;
    }
    write(s + '\n');
  }

  function taskTag(taskId: string | undefined): string {
    return taskId ? col.gray(`[${taskId}] `) : '';
  }

  return function sink(e: RunStreamEvent): void {
    try {
      switch (e.kind) {
        case 'task-start': {
          const tag = taskTag(e.taskId);
          writeln(`${col.cyan('▶')} ${tag}${col.bold(e.text ?? 'task starting')}`);
          break;
        }

        case 'model-delta': {
          // Inline write — no newline. May be empty string; skip.
          const chunk = e.text ?? '';
          if (chunk.length > 0) {
            write(chunk);
            midDelta = true;
          }
          break;
        }

        case 'tool-call': {
          const tag = taskTag(e.taskId);
          const name = e.text ?? (typeof e.data === 'object' && e.data !== null
            ? String((e.data as Record<string, unknown>)['name'] ?? 'tool')
            : 'tool');
          writeln(`${col.magenta('⚙')} ${tag}${col.dim('tool:')} ${col.magenta(name)}`);
          break;
        }

        case 'task-done': {
          const tag = taskTag(e.taskId);
          writeln(`${col.green('✓')} ${tag}${col.bold(e.text ?? 'done')}`);
          break;
        }

        case 'retry': {
          const tag = taskTag(e.taskId);
          writeln(`${col.yellow('↺')} ${tag}${col.yellow(e.text ?? 'retrying')}`);
          break;
        }

        case 'verify': {
          const tag = taskTag(e.taskId);
          // data may be a VerifyVerdict: { ok, reason, method }
          const verdict = (typeof e.data === 'object' && e.data !== null)
            ? e.data as { ok?: boolean; reason?: string; method?: string }
            : null;
          const ok = verdict?.ok ?? true;
          const reason = verdict?.reason ?? e.text ?? '';
          const method = verdict?.method ? col.dim(` (${verdict.method})`) : '';
          if (ok) {
            writeln(`${col.green('✔')} ${tag}${col.green('verify ok')}${method}${reason ? ': ' + reason : ''}`);
          } else {
            writeln(`${col.yellow('✘')} ${tag}${col.yellow('verify fail')}${method}${reason ? ': ' + reason : ''}`);
          }
          break;
        }

        case 'log': {
          const tag = taskTag(e.taskId);
          writeln(`${col.gray('·')} ${tag}${col.dim(e.text ?? '')}`);
          break;
        }

        default: {
          // Unknown future event kinds: silently ignore to stay forward-compatible.
          break;
        }
      }
    } catch {
      // Contract: never throw to caller regardless of render errors.
    }
  };
}
