/**
 * terminal/blocks-model.ts — command blocks on the page (3.15): the
 * operator's own (from the server's `block` frames) and the agents' (from
 * the chat transcript's tool events), in one shape, plus the text a block
 * becomes when it is sent to a chat.
 *
 * AGENT BLOCKS ARE A READING, NEVER A RUN. They are derived from tool-use /
 * tool-result events the chat already holds (useVerseTranscript) — the
 * command the agent's CLI reported and the output it got back. Nothing here
 * executes anything; "Paste in terminal" types the command at a prompt and
 * stops, exactly like the transcript's own "Run in terminal".
 */
import type { VerseTerminalBlock } from '../../../data/api-types.js';
import type { TranscriptItem } from '../verse-transcript.js';
import { readToolFacts } from '../chat/tool-semantics.js';

/** One block as the list renders it. */
export interface BlockView {
  /** Terminal: the server's `b-<n>`. Agent: the tool call id. */
  id: string;
  source: 'terminal' | 'agent';
  command: string;
  cwd: string | null;
  startedAt: string;
  durationMs: number | null;
  exitCode: number | null;
  /** Agent calls often report failure without a code. */
  failed: boolean;
  running: boolean;
  /** Terminal blocks: output is fetched on demand. Agent blocks: already here. */
  output: string | null;
  truncated: boolean;
  fullscreen: boolean;
  /** Agent blocks: the tool that ran it (Bash, command_execution…). */
  tool?: string;
}

// ---------------------------------------------------------------------------
// Terminal blocks
// ---------------------------------------------------------------------------

/** Merge a `block` frame into the ordered list (a block arrives when it starts and again when it finishes). */
export function upsertBlock(list: readonly VerseTerminalBlock[], block: VerseTerminalBlock, max = 500): VerseTerminalBlock[] {
  const i = list.findIndex((b) => b.id === block.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = block;
    return next;
  }
  const next = [...list, block];
  // Server ids are b-<n> in order; keep them sorted even if a replay interleaves.
  next.sort((a, b) => blockNumber(a.id) - blockNumber(b.id));
  return next.length > max ? next.slice(next.length - max) : next;
}

function blockNumber(id: string): number {
  const n = Number.parseInt(id.slice(2), 10);
  return Number.isFinite(n) ? n : 0;
}

export function terminalBlockView(block: VerseTerminalBlock): BlockView {
  return {
    id: block.id,
    source: 'terminal',
    command: block.command,
    cwd: block.cwd,
    startedAt: block.startedAt,
    durationMs: block.durationMs,
    exitCode: block.exitCode,
    failed: block.exitCode !== null && block.exitCode !== 0,
    running: block.state === 'running',
    output: null,
    truncated: block.truncated || block.evicted,
    fullscreen: block.fullscreen,
  };
}

/** The key a block's xterm marker is filed under: its C mark's frame and position in that frame. */
export function markerKey(seq: number, ordinal: number): string {
  return `${seq}:${ordinal}`;
}

// ---------------------------------------------------------------------------
// Agent blocks
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Every shell command the chat's agents ran, oldest first: a tool call whose
 * input carries a command line (Claude Code's Bash, Codex's
 * command_execution, a local seat's run_command…), paired with its result.
 */
export function agentBlocksFromTranscript(items: readonly TranscriptItem[]): BlockView[] {
  const out: BlockView[] = [];
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    const facts = readToolFacts({ name: item.name, input: item.input, result: item.result });
    if (!facts.command) continue;
    const input = record(item.input);
    const cwd = typeof input?.['cwd'] === 'string' ? (input['cwd'] as string)
      : typeof input?.['workdir'] === 'string' ? (input['workdir'] as string) : null;
    const pending = item.result === null;
    const exitCode = facts.command.exitCode;
    out.push({
      id: item.toolUseId,
      source: 'agent',
      command: facts.command.command,
      cwd,
      startedAt: item.at,
      durationMs: item.durationMs,
      exitCode,
      failed: item.result?.isError === true || (exitCode !== null && exitCode !== 0),
      running: pending,
      output: item.result?.output ?? null,
      truncated: false,
      fullscreen: false,
      tool: item.name,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1_000);
  if (m < 60) return s > 0 ? `${m} m ${s} s` : `${m} m`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} m`;
}

/** What the status chip says: an honest exit (no code invented). */
export function blockStatus(block: Pick<BlockView, 'running' | 'exitCode' | 'failed'>): { tone: 'running' | 'ok' | 'error' | 'unknown'; label: string } {
  if (block.running) return { tone: 'running', label: 'Running' };
  if (block.exitCode === 0) return { tone: 'ok', label: 'Exit 0' };
  if (block.exitCode !== null) return { tone: 'error', label: `Exit ${block.exitCode}` };
  if (block.failed) return { tone: 'error', label: 'Failed' };
  return { tone: 'unknown', label: 'Done' };
}

// ---------------------------------------------------------------------------
// Chat text
// ---------------------------------------------------------------------------

/** Output past this is cut to its tail for a chat message (the error is at the end). */
export const CHAT_OUTPUT_MAX_CHARS = 12_000;
export const CHAT_OUTPUT_MAX_LINES = 200;

/** A fence one backtick longer than any run inside (≥ 3), so the text cannot close it early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export function tailForChat(output: string): { text: string; cut: boolean } {
  let text = output.replace(/\s+$/, '');
  let cut = false;
  const lines = text.split('\n');
  if (lines.length > CHAT_OUTPUT_MAX_LINES) {
    text = lines.slice(-CHAT_OUTPUT_MAX_LINES).join('\n');
    cut = true;
  }
  if (text.length > CHAT_OUTPUT_MAX_CHARS) {
    text = text.slice(-CHAT_OUTPUT_MAX_CHARS);
    const nl = text.indexOf('\n');
    if (nl >= 0 && nl < 200) text = text.slice(nl + 1);
    cut = true;
  }
  return { text, cut };
}

export type ChatIntent = 'send' | 'explain';

/**
 * The message a block becomes. `command` and `output` must ALREADY be the
 * server's `format=chat` text (plain, secrets scrubbed) — or, for an agent
 * block, the transcript's own (scrubbed on the way to the page).
 */
export function blockChatText(
  block: Pick<BlockView, 'exitCode' | 'failed' | 'cwd' | 'source' | 'running'>,
  command: string,
  output: string,
  intent: ChatIntent,
): string {
  const { text, cut } = tailForChat(output);
  const body = `$ ${command}${text ? `\n${text}` : ''}`;
  const fence = fenceFor(body);
  const status = block.running ? 'still running'
    : block.exitCode !== null ? `exit ${block.exitCode}`
      : block.failed ? 'failed' : 'finished';
  const where = block.cwd ? ` in \`${block.cwd}\`` : '';
  const whose = block.source === 'agent' ? 'An agent ran this command' : 'I ran this in my terminal';
  const lines: string[] = [];
  if (intent === 'explain') {
    lines.push(`${whose}${where} (${status}). Explain what went wrong and how to fix it — propose the fix, don't run anything yet.`);
  } else {
    lines.push(`${whose}${where} (${status}):`);
  }
  lines.push('', `${fence}console`, body, fence);
  if (cut) lines.push('', '_(output cut to its last lines)_');
  return lines.join('\n');
}
