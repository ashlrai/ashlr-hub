/**
 * Codex rollouts → reasoning store (V3.10, unit A7).
 *
 * Codex writes every conversation to `$CODEX_HOME/sessions/YYYY/MM/DD/
 * rollout-*.jsonl`. Reasoning arrives as `reasoning` items whose
 * `encrypted_content` is opaque (NEVER stored) and whose plaintext
 * `summary[].text` (and, rarely, raw `content[].text`) is what we keep.
 *
 * SCOPE / CONSENT. Research (r3/cot-data.md) found ~4k rollouts, >99% of them
 * Mason's interactive Codex Desktop sessions. Those are personal, so they are
 * ingested ONLY when explicitly enabled (`includeInteractive`, wired from
 * `ASHLR_REASONING_CODEX_DESKTOP=1` or cfg `reasoning.codexDesktop: true`).
 * By default only non-interactive `codex exec` rollouts are read — and of
 * those, threads that belong to a Verse session are skipped because the
 * Verse tap already recorded them (no double counting).
 *
 * Incremental: a per-file cursor keeps the byte offset just past the last
 * COMPLETED turn plus the session meta, so a growing rollout is re-read only
 * from its unfinished tail. Evidence refs use `session:<threadId>#<byteOffset>`.
 *
 * Handles both rollout generations seen on disk: current (`event_msg/
 * item_completed` CommandExecution / FileChange / Reasoning items,
 * `function_call` exec_command with "Process exited with code N" output) and
 * older (`function_call` shell + `exec_command_end`, `agent_reasoning`).
 */

import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { TurnAccumulator, type TurnFeaturesV1 } from './extractors.js';
import {
  DAY_MS,
  appendFeatures,
  appendStepsChunked,
  cleanLabel,
  readStoreState,
  reasoningRoot,
  writeStoreState,
} from './store.js';
import { REASONING_TEXT_RETENTION_DAYS, type ReasoningOutcome, type ReasoningStepKind, type ReasoningStepV1 } from './types.js';
import { defaultVerseRoot } from './ingest-verse.js';

const CURSOR_NAME = 'codex-cursor';
const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
/**
 * First read of a file is small: most files are only SNIFFED (the session_meta
 * line, ~20 KB, decides consent/dedupe) and never read further.
 */
const FIRST_CHUNK_BYTES = 32 * 1024;
const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
/** A rollout untouched this long will never complete its open turn; finalize it. */
const STALE_OPEN_TURN_MS = 24 * 60 * 60 * 1_000;

export interface CodexIngestOptions {
  root?: string;
  /** `$CODEX_HOME/sessions` by default. */
  sessionsRoot?: string;
  verseRoot?: string;
  /** Opt-in for interactive (Codex Desktop / IDE / CLI) conversations. */
  includeInteractive?: boolean;
  /** Only rollouts created within this many days (default: the text window − 1). */
  lookbackDays?: number;
  maxFiles?: number;
  maxBytes?: number;
  nowMs?: number;
}

export interface CodexIngestResult {
  filesSeen: number;
  filesRead: number;
  filesSkipped: number;
  bytesRead: number;
  steps: number;
  features: number;
  truncated: boolean;
}

interface RolloutMeta {
  threadId: string;
  cwd: string | null;
  originator: string | null;
  interactive: boolean;
  model: string | null;
  cliVersion: string | null;
}

interface FileCursor {
  size: number;
  mtimeMs: number;
  /** Resume point: byte offset just past the last completed turn. */
  offset: number;
  /** How far the last pass read (≥ offset). A budget-cut pass leaves this < size. */
  readTo?: number;
  meta: RolloutMeta | null;
  /** Excluded by consent/dedupe policy; `policy` records which policy so a change re-evaluates it. */
  skipped?: string;
}

interface CursorState {
  v: 1;
  files: Record<string, FileCursor>;
}

export function codexSessionsRoot(): string {
  const configured = process.env['CODEX_HOME'];
  const base = typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.codex');
  return join(base, 'sessions');
}

/** Consent switch for interactive Codex conversations (env or cfg). */
export function codexInteractiveOptIn(cfg?: unknown): boolean {
  if (process.env['ASHLR_REASONING_CODEX_DESKTOP'] === '1') return true;
  const reasoning = (cfg as { reasoning?: { codexDesktop?: unknown } } | undefined)?.reasoning;
  return reasoning?.codexDesktop === true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Line reader with byte offsets
// ---------------------------------------------------------------------------

/**
 * Read `path` from `start`, calling `visit(line, offset)` for each complete
 * line (a trailing partial line is left for the next pass). Over-long lines
 * are skipped but still advance offsets. Returns bytes consumed.
 */
async function readLinesFrom(
  path: string,
  start: number,
  maxBytes: number,
  visit: (line: string, offset: number, nextOffset: number) => boolean | void,
): Promise<number> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let position = start;
    let carry: Buffer[] = [];
    let carryBytes = 0;
    let lineStart = start;
    let skipping = false;
    let consumed = 0;
    let stop = false;
    while (consumed < maxBytes && !stop) {
      // Never read past the budget: a partial line at the cut is simply
      // re-read next pass (the budget there is fresh, and far above MAX_LINE_BYTES).
      const want = Math.min(consumed === 0 ? FIRST_CHUNK_BYTES : buffer.length, maxBytes - consumed);
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      consumed += bytesRead;
      let from = 0;
      for (;;) {
        const nl = buffer.indexOf(0x0a, from);
        if (nl === -1 || nl >= bytesRead) break;
        if (!skipping) {
          const piece = buffer.subarray(from, nl);
          const line = carryBytes > 0 ? Buffer.concat([...carry, piece]).toString('utf8') : piece.toString('utf8');
          if (visit(line, lineStart, lineStart + carryBytes + (nl - from) + 1) === false) stop = true;
        }
        lineStart += carryBytes + (nl - from) + 1;
        carry = [];
        carryBytes = 0;
        skipping = false;
        from = nl + 1;
        if (stop) break;
      }
      if (stop) break;
      if (from < bytesRead) {
        const rest = bytesRead - from;
        if (!skipping && carryBytes + rest <= MAX_LINE_BYTES) {
          carry.push(Buffer.from(buffer.subarray(from, bytesRead)));
        } else {
          skipping = true;
          carry = [];
        }
        carryBytes += rest;
      }
    }
    // Partial trailing line: not consumed; the caller's cursor stops before it.
    return lineStart - start;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Rollout parser
// ---------------------------------------------------------------------------

interface PendingTool {
  ref: string;
  at: string;
  name: string;
  input: unknown;
  ok: boolean | null;
}

interface CodexTurn {
  turnId: string;
  startOffset: number;
  startedAt: string;
  model: string | null;
  acc: TurnAccumulator | null;
  steps: ReasoningStepV1[];
  seenReasoning: Set<string>;
  /** Tools from `item_completed` items (current format) and from response items (older). */
  itemTools: PendingTool[];
  responseTools: PendingTool[];
  callIndex: Map<string, PendingTool>;
  message: { ref: string; at: string; text: string } | null;
  errored: boolean;
  errorClass: string | null;
  lastAt: string;
}

function exitCodeOk(value: unknown): boolean | null {
  const code = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isFinite(code) ? code === 0 : null;
}

/** Tool success from a function_call_output body. Null when the output does not say. */
function outputOk(output: unknown): boolean | null {
  const text = typeof output === 'string' ? output : Array.isArray(output)
    ? output.map((part) => (isObject(part) ? str(part['text']) : '')).join('\n')
    : '';
  if (text === '') return null;
  const head = text.slice(0, 2_000);
  const exited = /Process exited with code (-?\d+)/.exec(head) ?? /\bExit code:?\s*(-?\d+)/i.exec(head);
  if (exited) return exited[1] === '0';
  if (/^Script failed\b/.test(head)) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isObject(parsed) && isObject(parsed['metadata'])) return exitCodeOk(parsed['metadata']['exit_code']);
  } catch {
    /* plain text */
  }
  return null;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

/** `custom_tool_call` `exec` wraps JS that calls tools; recover the inner call where it is recognisable. */
function describeCustomExec(name: string, input: unknown): { name: string; input: unknown } {
  if (name !== 'exec' || typeof input !== 'string') return { name, input };
  if (/tools\.apply_patch\b/.test(input)) return { name: 'apply_patch', input: {} };
  const cmd = /exec_command\(\s*\{[^}]*?\bcmd\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/s.exec(input);
  if (cmd) return { name: 'exec_command', input: { cmd: cmd[2] } };
  return { name: 'code_exec', input: {} };
}

function reasoningText(payload: Record<string, unknown>): { text: string; kind: ReasoningStepKind } | null {
  const raw = Array.isArray(payload['content'])
    ? payload['content'].map((part) => (isObject(part) ? str(part['text']) : '')).filter((t) => t !== '')
    : Array.isArray(payload['raw_content'])
      ? payload['raw_content'].map((part) => (isObject(part) ? str(part['text']) : str(part))).filter((t) => t !== '')
      : [];
  if (raw.length > 0) return { text: raw.join('\n\n'), kind: 'thinking' };
  const summary = Array.isArray(payload['summary'])
    ? payload['summary'].map((part) => (isObject(part) ? str(part['text']) : '')).filter((t) => t !== '')
    : Array.isArray(payload['summary_text'])
      ? payload['summary_text'].map((part) => (typeof part === 'string' ? part : isObject(part) ? str(part['text']) : '')).filter((t) => t !== '')
      : [];
  if (summary.length > 0) return { text: summary.join('\n\n'), kind: 'summary' };
  return null;
}

class RolloutParser {
  meta: RolloutMeta | null;
  private turn: CodexTurn | null = null;
  readonly steps: ReasoningStepV1[] = [];
  readonly features: TurnFeaturesV1[] = [];
  /** Byte offset just past the last completed turn (safe resume point). */
  safeOffset: number;
  private currentModel: string | null = null;
  private currentCwd: string | null = null;
  private readonly include: (meta: RolloutMeta) => boolean;
  excluded = false;

  constructor(meta: RolloutMeta | null, startOffset: number, include: (meta: RolloutMeta) => boolean) {
    this.meta = meta;
    this.safeOffset = startOffset;
    this.include = include;
    this.currentModel = meta?.model ?? null;
    this.currentCwd = meta?.cwd ?? null;
  }

  private ref(offset: number): string {
    return `session:${this.meta?.threadId ?? 'unknown'}#${offset}`;
  }

  private openTurn(turnId: string | null, at: string, offset: number): CodexTurn {
    if (this.turn && (turnId === null || this.turn.turnId === turnId)) return this.turn;
    if (this.turn) this.closeTurn(null, at, offset);
    this.turn = {
      turnId: turnId ?? `t${offset}`,
      startOffset: offset,
      startedAt: at,
      model: this.currentModel,
      acc: null,
      steps: [],
      seenReasoning: new Set(),
      itemTools: [],
      responseTools: [],
      callIndex: new Map(),
      message: null,
      errored: false,
      errorClass: null,
      lastAt: at,
    };
    return this.turn;
  }

  private accFor(turn: CodexTurn): TurnAccumulator {
    if (!turn.acc) {
      const threadId = this.meta?.threadId ?? 'unknown';
      turn.acc = new TurnAccumulator({
        id: `codex:${threadId}:${turn.turnId}`,
        source: 'codex-rollout',
        sessionId: threadId,
        runId: null,
        repo: cleanLabel(this.currentCwd ?? this.meta?.cwd ?? null, 512),
        engine: 'codex',
        model: turn.model ?? this.meta?.model ?? null,
        turnId: turn.turnId,
        startedAt: turn.startedAt,
      });
    }
    return turn.acc;
  }

  /** Close the open turn, emitting steps + one feature row. `endOffset` = byte offset past its last line. */
  closeTurn(outcome: ReasoningOutcome | null, endedAt: string, endOffset: number): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.safeOffset = endOffset;
    if (!this.meta) return;
    const acc = this.accFor(turn);
    // Prefer the richer item_completed view of tools; older rollouts only have response items.
    const tools = turn.itemTools.length > 0 ? turn.itemTools : turn.responseTools;
    const empty = turn.steps.length === 0 && tools.length === 0 && turn.message === null;
    if (empty) return; // bookkeeping-only turns (settings, compaction) carry no signal
    for (const tool of tools) acc.addTool(tool.ref, tool.at, tool.name, tool.input, tool.ok);
    if (turn.message) acc.addMessage(turn.message.ref, turn.message.at, turn.message.text);
    // toolAfter: the first tool that started after each step.
    for (const step of turn.steps) {
      const next = tools.find((tool) => Date.parse(tool.at) >= Date.parse(step.at));
      step.toolAfter = next ? next.name : null;
      this.steps.push(step);
    }
    const resolved = outcome ?? (turn.errored ? 'error' : null);
    this.features.push(acc.finish(resolved, endedAt, turn.errorClass));
  }

  /** Stale file at EOF: finalize the open turn with an unknown outcome. */
  finalizeOpen(endOffset: number): void {
    if (this.turn) this.closeTurn(null, this.turn.lastAt, endOffset);
  }

  private addReasoning(payload: Record<string, unknown>, at: string, offset: number): void {
    const found = reasoningText(payload);
    if (!found || !this.meta) return;
    const turn = this.openTurn(null, at, offset);
    const itemId = str(payload['id']);
    const dedupeKey = itemId || found.text;
    // The same reasoning item appears as a response_item AND an item_completed
    // event (and, in older rollouts, as agent_reasoning); keep it once.
    if (turn.seenReasoning.has(dedupeKey) || turn.seenReasoning.has(found.text)) return;
    turn.seenReasoning.add(dedupeKey);
    turn.seenReasoning.add(found.text);
    turn.lastAt = at;
    const id = `codex:${this.meta.threadId}:${/^[\x21-\x7e]{1,120}$/.test(itemId) ? itemId : `b${offset}`}`;
    this.accFor(turn).addThinking(id, at, found.text);
    turn.steps.push({
      v: 1,
      id,
      source: 'codex-rollout',
      sessionId: this.meta.threadId,
      runId: null,
      repo: cleanLabel(this.currentCwd ?? this.meta.cwd, 512),
      engine: 'codex',
      model: turn.model ?? this.meta.model,
      at,
      turnId: turn.turnId,
      kind: found.kind,
      text: found.text,
      tokens: null,
      toolAfter: null,
      outcome: null,
    });
  }

  /** Returns false to stop reading (file excluded by policy). */
  line(raw: string, offset: number, nextOffset: number): boolean {
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      return true;
    }
    if (!isObject(row)) return true;
    const type = str(row['type']);
    const payload = isObject(row['payload']) ? row['payload'] : {};
    const at = str(row['timestamp']) || str(payload['timestamp']) || new Date(0).toISOString();

    if (type === 'session_meta') {
      if (this.meta) return true; // forks carry a second meta line; the first is the thread
      const originator = str(payload['originator']) || null;
      const source = payload['source'];
      const interactive = !(originator === 'codex_exec' || source === 'exec');
      this.meta = {
        threadId: str(payload['id']) || str(payload['session_id']) || 'unknown',
        cwd: str(payload['cwd']) || null,
        originator,
        interactive,
        model: null,
        cliVersion: str(payload['cli_version']) || null,
      };
      this.currentCwd = this.meta.cwd;
      if (!this.include(this.meta)) {
        this.excluded = true;
        return false;
      }
      return true;
    }
    if (!this.meta) return true; // nothing attributable before the meta line

    if (type === 'turn_context') {
      this.currentModel = str(payload['model']) || this.currentModel;
      this.currentCwd = str(payload['cwd']) || this.currentCwd;
      if (this.meta.model === null && this.currentModel) this.meta.model = this.currentModel;
      if (this.turn && this.turn.model === null) this.turn.model = this.currentModel;
      return true;
    }

    if (type === 'response_item') {
      const kind = str(payload['type']);
      if (kind === 'reasoning') {
        this.addReasoning(payload, at, offset);
        return true;
      }
      if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
        const turn = this.openTurn(null, at, offset);
        turn.lastAt = at;
        let name = str(payload['name']) || kind;
        let input: unknown;
        if (kind === 'function_call') input = parseArgs(payload['arguments']);
        else if (kind === 'local_shell_call') {
          name = 'local_shell';
          input = isObject(payload['action']) ? { command: payload['action']['command'] } : {};
        } else {
          const described = describeCustomExec(name, payload['input']);
          name = described.name;
          input = described.input;
        }
        const tool: PendingTool = { ref: this.ref(offset), at, name, input, ok: null };
        turn.responseTools.push(tool);
        const callId = str(payload['call_id']);
        if (callId) turn.callIndex.set(callId, tool);
        return true;
      }
      if (kind === 'function_call_output' || kind === 'custom_tool_call_output' || kind === 'local_shell_call_output') {
        const tool = this.turn?.callIndex.get(str(payload['call_id']));
        if (tool && tool.ok === null) tool.ok = outputOk(payload['output']);
        return true;
      }
      return true;
    }

    if (type === 'event_msg') {
      const kind = str(payload['type']);
      switch (kind) {
        case 'task_started':
        case 'turn_started':
          this.openTurn(str(payload['turn_id']) || null, at, offset);
          return true;
        case 'task_complete':
        case 'turn_complete': {
          const turn = this.turn;
          const last = str(payload['last_agent_message']);
          if (turn && last && !turn.message) turn.message = { ref: this.ref(offset), at, text: last };
          this.closeTurn('ok', at, nextOffset);
          return true;
        }
        case 'turn_aborted':
          this.closeTurn('cancelled', at, nextOffset);
          return true;
        case 'error':
        case 'stream_error': {
          if (this.turn && kind === 'error') {
            this.turn.errored = true;
            this.turn.errorClass ??= /rate.?limit|429|usage limit/i.test(str(payload['message'])) ? 'rate-limit' : 'execution';
          }
          return true;
        }
        case 'agent_reasoning':
        case 'agent_reasoning_raw_content': {
          const text = str(payload['text']);
          if (text) this.addReasoning(kind === 'agent_reasoning' ? { summary: [{ text }] } : { content: [{ text }] }, at, offset);
          return true;
        }
        case 'agent_message': {
          const text = str(payload['message']);
          if (text) {
            const turn = this.openTurn(null, at, offset);
            turn.message = { ref: this.ref(offset), at, text };
          }
          return true;
        }
        case 'exec_command_end': {
          const tool = this.turn?.callIndex.get(str(payload['call_id']));
          if (tool) tool.ok = exitCodeOk(payload['exit_code']);
          return true;
        }
        case 'patch_apply_end': {
          const tool = this.turn?.callIndex.get(str(payload['call_id']));
          if (tool && typeof payload['success'] === 'boolean') tool.ok = payload['success'];
          return true;
        }
        case 'item_completed': {
          const item = isObject(payload['item']) ? payload['item'] : null;
          if (!item) return true;
          const itemType = str(item['type']);
          if (itemType === 'Reasoning') {
            this.addReasoning(item, at, offset);
            return true;
          }
          const turn = this.openTurn(null, at, offset);
          turn.lastAt = at;
          if (itemType === 'CommandExecution') {
            turn.itemTools.push({
              ref: this.ref(offset),
              at,
              name: 'command_execution',
              input: { command: item['command'] },
              ok: str(item['status']) === 'failed' ? false : exitCodeOk(item['exit_code']),
            });
          } else if (itemType === 'FileChange') {
            turn.itemTools.push({
              ref: this.ref(offset),
              at,
              name: 'file_change',
              input: { changes: item['changes'] },
              ok: str(item['status']) === 'failed' ? false : str(item['status']) === 'completed' ? true : null,
            });
          } else if (itemType === 'McpToolCall') {
            const server = str(item['server']) || str(item['appName']);
            const tool = str(item['tool']) || str(item['actionName']);
            const status = str(item['status']);
            turn.itemTools.push({
              ref: this.ref(offset),
              at,
              name: server && tool ? `mcp:${server}.${tool}` : 'mcp_tool_call',
              input: isObject(item['arguments']) ? item['arguments'] : {},
              ok: status === 'failed' || item['error'] ? false : status === 'completed' ? true : null,
            });
          }
          return true;
        }
        default:
          return true;
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function listRollouts(sessionsRoot: string, cutoffDay: string): Promise<string[]> {
  const out: string[] = [];
  const numeric = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir)).filter((name) => /^\d+$/.test(name)).sort();
    } catch {
      return [];
    }
  };
  for (const year of await numeric(sessionsRoot)) {
    if (`${year}-12-31` < cutoffDay) continue;
    for (const month of await numeric(join(sessionsRoot, year))) {
      if (`${year}-${month}-31` < cutoffDay) continue;
      for (const day of await numeric(join(sessionsRoot, year, month))) {
        if (`${year}-${month}-${day}` < cutoffDay) continue;
        const dir = join(sessionsRoot, year, month, day);
        try {
          for (const name of (await readdir(dir)).sort()) {
            if (ROLLOUT_RE.test(name)) out.push(join(dir, name));
          }
        } catch {
          /* vanished */
        }
      }
    }
  }
  return out;
}

/** Native thread ids of codex Verse sessions: the Verse tap already recorded those. */
async function verseCodexThreads(verseRoot: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const dir = join(verseRoot, 'sessions');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json') && !name.endsWith('.launch.json'));
  } catch {
    return ids;
  }
  for (const name of names.slice(0, 5_000)) {
    try {
      const path = join(dir, name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 1024 * 1024) continue;
      const record = JSON.parse(await readFile(path, 'utf8')) as { engine?: unknown; nativeSessionId?: unknown };
      if (record.engine === 'codex' && typeof record.nativeSessionId === 'string') ids.add(record.nativeSessionId);
    } catch {
      /* unreadable record */
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/** Incrementally ingest codex rollouts. Never throws. */
export async function ingestCodexRollouts(options: CodexIngestOptions = {}): Promise<CodexIngestResult> {
  const root = options.root ?? reasoningRoot();
  const nowMs = options.nowMs ?? Date.now();
  const sessionsRoot = options.sessionsRoot ?? codexSessionsRoot();
  const includeInteractive = options.includeInteractive === true;
  const policy = includeInteractive ? 'all' : 'exec-only';
  const lookbackDays = Math.max(1, Math.min(180, options.lookbackDays ?? REASONING_TEXT_RETENTION_DAYS - 1));
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  let budget = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const result: CodexIngestResult = {
    filesSeen: 0, filesRead: 0, filesSkipped: 0, bytesRead: 0, steps: 0, features: 0, truncated: false,
  };
  try {
    const prior = readStoreState<CursorState>(CURSOR_NAME, root);
    const cursor: CursorState = prior?.v === 1 && isObject(prior.files) ? prior : { v: 1, files: {} };
    const cutoffDay = new Date(nowMs - lookbackDays * DAY_MS).toISOString().slice(0, 10);
    const verseThreads = await verseCodexThreads(options.verseRoot ?? defaultVerseRoot());
    const include = (meta: RolloutMeta): boolean =>
      !verseThreads.has(meta.threadId) && (includeInteractive || !meta.interactive);

    const files = await listRollouts(sessionsRoot, cutoffDay);
    const present = new Set(files);
    result.filesSeen = files.length;
    let processed = 0;
    // Newest first: if the budget runs out, recent activity is what matters.
    for (const path of [...files].reverse()) {
      if (processed >= maxFiles || budget <= 0) {
        result.truncated = true;
        break;
      }
      let stat;
      try {
        stat = await lstat(path);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      const previous = cursor.files[path];
      if (previous?.skipped === policy && previous.size === stat.size) {
        result.filesSkipped += 1;
        continue;
      }
      if (
        previous && !previous.skipped && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs &&
        (previous.readTo ?? previous.size) >= stat.size
      ) continue;
      // A policy change (e.g. interactive opt-in turned on) re-reads skipped files from the start.
      const start = previous && !previous.skipped && previous.offset <= stat.size ? previous.offset : 0;
      const parser = new RolloutParser(start > 0 ? previous?.meta ?? null : null, start, include);
      const consumed = await readLinesFrom(path, start, budget, (line, offset, nextOffset) =>
        parser.line(line, offset, nextOffset)).catch(() => 0);
      budget -= consumed;
      result.bytesRead += consumed;
      if (parser.excluded) {
        cursor.files[path] = { size: stat.size, mtimeMs: stat.mtimeMs, offset: 0, meta: null, skipped: policy };
        result.filesSkipped += 1;
        continue;
      }
      result.filesRead += 1;
      // Only files actually ingested count against maxFiles; a policy sniff is one small read.
      processed += 1;
      if (nowMs - stat.mtimeMs > STALE_OPEN_TURN_MS && start + consumed >= stat.size) parser.finalizeOpen(start + consumed);
      result.steps += await appendStepsChunked(parser.steps, root);
      result.features += appendFeatures(parser.features, root);
      cursor.files[path] = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        offset: parser.safeOffset,
        readTo: start + consumed,
        meta: parser.meta,
      };
    }
    for (const path of Object.keys(cursor.files)) {
      if (!present.has(path)) delete cursor.files[path];
    }
    writeStoreState(CURSOR_NAME, cursor, root);
  } catch {
    /* ingest is best-effort maintenance */
  }
  return result;
}
