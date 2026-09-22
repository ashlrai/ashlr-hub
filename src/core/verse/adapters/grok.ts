/**
 * Grok adapter.
 *
 * Launch: `grok --output-format streaming-messages-json --include-partial-messages
 * --cwd <cwd> --model <m> --permission-mode dontAsk` plus `--session-id <uuid>`
 * on the first turn (`--resume <uuid>` after), then the prompt as one
 * `--single=<text>` element: `-p, --single <PROMPT>` is a clap value option and
 * a leading-dash value is only accepted in the `--opt=value` spelling, so a
 * bullet-list message is never rejected (or honoured) as a flag.
 *
 * Parse: NDJSON in the Anthropic Messages API wire format (message_start,
 * content_block_start/delta/stop, message_delta{usage}, message_stop). The
 * parser is the shared Anthropic-stream parser, which also accepts claude's
 * `stream_event` wrapper and whole-message envelopes.
 */

import type { VerseSession, VerseTurnLaunch } from '../types.js';
import type { VerseSeatLaunch } from '../session-engine.js';
import type { VerseAdapter } from './index.js';
import { createAnthropicStreamParser } from './claude.js';

function buildGrokLaunch(session: VerseSession, text: string, launch: VerseSeatLaunch): VerseTurnLaunch {
  if (!session.nativeSessionId) {
    throw new Error('grok session is missing its native session id');
  }
  const prefix = launch.launcher ? [...launch.launcher] : ['grok'];
  const argv = [
    ...prefix,
    '--output-format', 'streaming-messages-json',
    '--include-partial-messages',
    '--cwd', session.projectPath,
    '--model', session.model,
    // NOT 'acceptEdits'. Grok's acceptEdits auto-approves edits but NOT
    // `run_terminal_command`, and there is no interactive approver in a seat, so
    // the first shell command cancels the turn: measured
    // `subtype=error_during_execution, stop_reason=cancelled` after 13s, with
    // the file left untouched. Grok reaches for a terminal command on most
    // tasks (it shells out to find files), so this failed nearly always.
    // 'dontAsk' and 'auto' both complete; 'dontAsk' is the narrower of the two.
    '--permission-mode', 'dontAsk',
    // NO MULTI-ROOT FLAG IS EMITTED HERE, deliberately. A workspace session on
    // a Grok seat gets its primary root and nothing else.
    //
    // Checked on grok 0.2.118, not recalled: `grok --help` exposes `--cwd
    // <CWD>` and `--sandbox <PROFILE>` (a profile NAME, not a root list), and
    // `grok agent --help` adds only `--plugin-dir`. There is no `--add-dir`,
    // no `--allow-dir`, no writable-roots option anywhere in either. Inventing
    // one would fail the turn at argv parsing, before inference — which is
    // exactly how the invented Grok model ids failed.
    //
    // `workspaces.ts engineSupportsExtraRoots()` returns false for grok, so
    // the roots view marks the extras unreachable and says why, instead of
    // letting the operator believe the agent can see them.
    ...(session.turnCount > 0 ? ['--resume', session.nativeSessionId] : ['--session-id', session.nativeSessionId]),
    `--single=${text}`,
  ];
  return { argv, cwd: session.projectPath, env: {}, stdin: null };
}

export const grokAdapter: VerseAdapter = {
  buildLaunch: buildGrokLaunch,
  createParser: (turnId: string) => createAnthropicStreamParser(turnId, 'grok'),
};
