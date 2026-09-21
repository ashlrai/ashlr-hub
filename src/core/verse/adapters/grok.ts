/**
 * Grok adapter.
 *
 * Launch: `grok --output-format streaming-messages-json --include-partial-messages
 * --cwd <cwd> --model <m> --permission-mode acceptEdits` plus `--session-id <uuid>`
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
    '--permission-mode', 'acceptEdits',
    ...(session.turnCount > 0 ? ['--resume', session.nativeSessionId] : ['--session-id', session.nativeSessionId]),
    `--single=${text}`,
  ];
  return { argv, cwd: session.projectPath, env: {}, stdin: null };
}

export const grokAdapter: VerseAdapter = {
  buildLaunch: buildGrokLaunch,
  createParser: (turnId: string) => createAnthropicStreamParser(turnId, 'grok'),
};
