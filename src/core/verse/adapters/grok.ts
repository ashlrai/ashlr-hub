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
 * `stream_event` wrapper and whole-message envelopes. Grok's terminal `result`
 * carries `modelUsage.<key>.contextWindow` on the current model's row only
 * (the key can differ from the CLI id — `grok-4.6-build` for `grok-4.6`), and
 * a `system/compact_boundary` line marks an auto-compaction; the shared parser
 * turns both into the usage event's window and a `compaction` event.
 *
 * V3.9 context. Grok has no per-invocation compaction budget flag, so there
 * are no mode flags: it always runs its catalog budget (80% of 500k). Shared
 * project memory reaches it as `--rules=<block>` — `--rules <RULES>` "Extra
 * rules to append to the system prompt" (alias `--append-system-prompt`) is in
 * `grok --help` on the pinned 0.2.118 binary. Grok can reach only `--cwd`, so
 * the memory directory itself is never granted; the block carries the file's
 * contents and says this seat may only read it (`writable: false`).
 *
 * V3.10:
 *  - `--no-auto-update` on EVERY turn. The native-profile launcher leaves it
 *    to the caller ("The caller supplies --no-auto-update … do not duplicate
 *    it"), and a seat turn is no place for the CLI to replace its own binary
 *    under a pinned profile. The flag is hidden from `--help` but documented
 *    in grok's headless-mode guide; verified accepted by clap on 0.2.106 and
 *    0.2.118 (`grok --no-auto-update --version` exits 0, while an unknown
 *    `--zzz-bogus` exits 2 with "unexpected argument").
 *  - reasoning streams live: the shared parser turns grok's `thinking_delta`
 *    frames into transient `thinking-delta` events and each block into one
 *    persisted `thinking` (kind left unknown: xAI does not say whether the
 *    text is raw or summarised).
 *  - `--session-id` vs `--resume` follows the conversation on disk
 *    (`<GROK_HOME>/sessions/<encoded-cwd>/<id>/`), with the same rule and
 *    reasons as the claude adapter (`chooseNativeSession`): grok's
 *    `--session-id` also "errors if … already in use under the target session
 *    directory".
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { canonicalModelId } from '../context-math.js';
import type { VerseSession, VerseTurnLaunch } from '../types.js';
import type { VerseSeatLaunch } from '../session-engine.js';
import type { VerseAdapter } from './index.js';
import { grokEffortArgs, grokPermissionArgs } from '../session-controls.js';
import {
  chooseNativeSession,
  createAnthropicStreamParser,
  grokConversationState,
  nativeSessionOverride,
  nativeStateDir,
} from './claude.js';

/** `--session-id <id>` or `--resume <id>` for a grok turn (see the file header). */
export function grokNativeSessionArgs(session: VerseSession, launch: VerseSeatLaunch): string[] {
  const id = session.nativeSessionId ?? '';
  const home = nativeStateDir(launch.launcher, 'grok', join(homedir(), '.grok'));
  const choice = chooseNativeSession(session, grokConversationState(home, session.projectPath, id), nativeSessionOverride(launch));
  return choice === 'resume' ? ['--resume', id] : ['--session-id', id];
}

/** The launch record's memory block, when the snapshot is well-formed; anything else means memory off. */
function launchMemoryBlock(launch: VerseSeatLaunch): string | null {
  const memory: unknown = launch.memory;
  if (typeof memory !== 'object' || memory === null) return null;
  const block = (memory as { block?: unknown }).block;
  return typeof block === 'string' && block.trim().length > 0 ? block : null;
}

function buildGrokLaunch(session: VerseSession, text: string, launch: VerseSeatLaunch): VerseTurnLaunch {
  if (!session.nativeSessionId) {
    throw new Error('grok session is missing its native session id');
  }
  const prefix = launch.launcher ? [...launch.launcher] : ['grok'];
  const memoryBlock = launchMemoryBlock(launch);
  const argv = [
    ...prefix,
    '--no-auto-update',
    '--output-format', 'streaming-messages-json',
    '--include-partial-messages',
    '--cwd', session.projectPath,
    '--model', canonicalModelId(session.model),
    // NOT 'acceptEdits'. Grok's acceptEdits auto-approves edits but NOT
    // `run_terminal_command`, and there is no interactive approver in a seat, so
    // the first shell command cancels the turn: measured
    // `subtype=error_during_execution, stop_reason=cancelled` after 13s, with
    // the file left untouched. Grok reaches for a terminal command on most
    // tasks (it shells out to find files), so this failed nearly always.
    // 'dontAsk' and 'auto' both complete; 'dontAsk' is the narrower of the two.
    // V3.10: the per-chat permission mode (session-controls.ts) — "Accept
    // edits", the default, still maps to 'dontAsk' for exactly this reason.
    ...grokPermissionArgs(session),
    // V3.10 per-chat effort; nothing by default.
    ...grokEffortArgs(session),
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

    // Shared project memory, the SAME snapshotted block every turn (cache-
    // stable). The `=` spelling is the one clap accepts for a value that
    // starts with `-`, exactly as for `--single` below.
    ...(memoryBlock !== null ? [`--rules=${memoryBlock}`] : []),
    ...grokNativeSessionArgs(session, launch),
    `--single=${text}`,
  ];
  return { argv, cwd: session.projectPath, env: {}, stdin: null };
}

export const grokAdapter: VerseAdapter = {
  buildLaunch: buildGrokLaunch,
  createParser: (turnId: string) => createAnthropicStreamParser(turnId, 'grok'),
};
