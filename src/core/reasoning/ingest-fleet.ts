/**
 * Fleet agent logs → reasoning store (V3.10, unit A7).
 *
 * `~/.ashlr/agent-logs/` (run/agent-diagnostics.ts) holds two generations:
 *
 *  - LEGACY `*.log` text files (pre-M-diagnostics): one or more invocation
 *    sections, each a header (`=== [invocation <iso>] <engine> (<engine>:
 *    <model>) sandbox=… worktree=… ===`, `ok=`, `error=`, `tokensIn=`, `cmd=`)
 *    followed by `--- agent output (truncated 40k) ---` and the CLI's raw
 *    stream: claude `stream-json` rows (thinking / tool_use / tool_result) or
 *    codex `exec --json` rows (reasoning / command_execution / file_change).
 *    Truncation means the stream is often cut mid-line; unparsable lines are
 *    skipped, and what parses is analysed like any other turn.
 *  - CURRENT `*.jsonl` metadata rows (runRef, engine, ok, errorClass,
 *    terminationReason, tokens) — no text at all. Each becomes a feature row
 *    with an outcome and error class, which is exactly what the "struggle"
 *    insight needs (e.g. codex runs failing on `configuration`).
 *
 * Fleet `repo` is null: sandboxes are throwaway worktrees and the logs do not
 * name the source repository (honesty rule — unknown, not guessed).
 * Evidence refs: step ids for reasoning, `run:<runId>#<n>` for tool events
 * (fleet runs have no session, so the contract's `session:` form does not fit).
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { agentDiagnosticsDir, classifyAgentDiagnosticError } from '../run/agent-diagnostics.js';
import { TurnAccumulator, type ToolHandle, type TurnFeaturesV1 } from './extractors.js';
import {
  appendFeatures,
  appendStepsChunked,
  readStoreState,
  reasoningRoot,
  writeStoreState,
} from './store.js';
import type { ReasoningOutcome, ReasoningStepV1 } from './types.js';

const CURSOR_NAME = 'fleet-cursor';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES_PER_RUN = 2_000;
const LOG_NAME_RE = /^((?:run|attempt)-[A-Za-z0-9_-]{1,120})\.log$/;
const JSONL_NAME_RE = /^([0-9a-f]{16,128})\.jsonl$/;
const HEADER_RE = /^=== (?:invocation (\S+) )?([a-z0-9_-]+) \(([^)]*)\)(?: [^\n]*)? ===$/;
const OUTPUT_MARKER_RE = /^--- agent output\b.*---$/;

interface FileCursor {
  size: number;
  mtimeMs: number;
  /** jsonl only: bytes already ingested. */
  offset?: number;
}

interface CursorState {
  v: 1;
  files: Record<string, FileCursor>;
}

export interface FleetIngestOptions {
  root?: string;
  logsDir?: string;
}

export interface FleetIngestResult {
  filesSeen: number;
  filesRead: number;
  invocations: number;
  steps: number;
  features: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Legacy .log parsing
// ---------------------------------------------------------------------------

export interface LegacyInvocation {
  index: number;
  at: string | null;
  engine: string;
  model: string | null;
  ok: boolean | null;
  durationMs: number | null;
  error: string | null;
  terminationReason: string | null;
  outputLines: string[];
}

/** Split a legacy agent log into invocation sections (pure). */
export function parseLegacyAgentLog(text: string): LegacyInvocation[] {
  const out: LegacyInvocation[] = [];
  let current: LegacyInvocation | null = null;
  let inOutput = false;
  for (const line of text.split('\n')) {
    const header = HEADER_RE.exec(line);
    if (header) {
      const [, ts, engine, spec] = header;
      const model = spec?.includes(':') ? spec.slice(spec.indexOf(':') + 1) : null;
      const at = ts && Number.isFinite(Date.parse(ts)) ? new Date(Date.parse(ts)).toISOString() : null;
      current = {
        index: out.length,
        at,
        engine: engine ?? 'unknown',
        model: model && model !== '' ? model : null,
        ok: null,
        durationMs: null,
        error: null,
        terminationReason: null,
        outputLines: [],
      };
      out.push(current);
      inOutput = false;
      continue;
    }
    if (!current) continue;
    if (inOutput) {
      current.outputLines.push(line);
      continue;
    }
    if (OUTPUT_MARKER_RE.test(line)) {
      inOutput = true;
      continue;
    }
    const status = /^ok=(true|false)\b(?:.*?\bterminationReason=(\S+))?(?:.*?\bdurationMs=(\d+))?/.exec(line);
    if (status) {
      current.ok = status[1] === 'true';
      current.terminationReason = status[2] && status[2] !== '-' ? status[2] : null;
      current.durationMs = status[3] ? Number(status[3]) : null;
      continue;
    }
    const error = /^error=(.*)$/.exec(line);
    if (error) current.error = error[1] && error[1] !== '-' ? error[1] : null;
  }
  return out;
}

interface InvocationTrace {
  steps: ReasoningStepV1[];
  feature: TurnFeaturesV1;
}

/**
 * Analyse one legacy invocation. `runId` is the log's run/attempt id;
 * `fallbackAt` (file mtime) dates sections whose header had no timestamp.
 */
export function traceLegacyInvocation(inv: LegacyInvocation, runId: string, fallbackAt: string): InvocationTrace {
  const endedAt = inv.at && inv.durationMs !== null
    ? new Date(Date.parse(inv.at) + inv.durationMs).toISOString()
    : inv.at ?? fallbackAt;
  const startedAt = inv.at ?? (inv.durationMs !== null ? new Date(Date.parse(fallbackAt) - inv.durationMs).toISOString() : null);
  const stepAt = startedAt ?? endedAt;
  const turnId = `inv${inv.index}`;
  let model = inv.model;
  const acc = new TurnAccumulator({
    id: `fleet:${runId}:${turnId}`,
    source: 'fleet',
    sessionId: null,
    runId,
    repo: null,
    engine: inv.engine,
    model,
    turnId,
    startedAt,
  });
  const steps: ReasoningStepV1[] = [];
  const tools = new Map<string, ToolHandle>();
  let pending: ReasoningStepV1 | null = null;
  let resultError = false;
  let n = 0;
  let stepCount = 0;
  const flush = (toolAfter: string | null): void => {
    if (pending) steps.push({ ...pending, toolAfter });
    pending = null;
  };
  const thinking = (text: string, kind: ReasoningStepV1['kind']): void => {
    if (text === '') return;
    flush(null);
    stepCount += 1;
    const id = `fleet:${runId}:${turnId}:s${stepCount}`;
    acc.addThinking(id, stepAt, text);
    pending = {
      v: 1, id, source: 'fleet', sessionId: null, runId, repo: null, engine: inv.engine, model,
      at: stepAt, turnId, kind, text, tokens: null, toolAfter: null, outcome: null,
    };
  };
  const tool = (name: string, input: unknown, ok: boolean | null, callId: string | null): void => {
    flush(name);
    const handle = acc.addTool(`run:${runId}#${n}`, stepAt, name, input, ok);
    if (callId) tools.set(callId, handle);
  };

  for (const raw of inv.outputLines) {
    n += 1;
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // truncated stream
    }
    if (!isObject(row)) continue;
    const type = str(row['type']);
    // claude stream-json
    if (type === 'system' && str(row['subtype']) === 'init') {
      model = str(row['model']) || model;
      continue;
    }
    if (type === 'assistant' && isObject(row['message']) && Array.isArray(row['message']['content'])) {
      for (const block of row['message']['content']) {
        if (!isObject(block)) continue;
        const blockType = str(block['type']);
        if (blockType === 'thinking') thinking(str(block['thinking']), 'thinking');
        else if (blockType === 'tool_use') tool(str(block['name']) || 'tool', block['input'], null, str(block['id']) || null);
        else if (blockType === 'text') {
          flush(null);
          acc.addMessage(`run:${runId}#${n}`, stepAt, str(block['text']));
        }
      }
      continue;
    }
    if (type === 'user' && isObject(row['message']) && Array.isArray(row['message']['content'])) {
      for (const block of row['message']['content']) {
        if (!isObject(block) || str(block['type']) !== 'tool_result') continue;
        const handle = tools.get(str(block['tool_use_id']));
        if (handle !== undefined) acc.resolveTool(handle, block['is_error'] !== true);
      }
      continue;
    }
    if (type === 'result') {
      resultError = row['is_error'] === true || str(row['subtype']).startsWith('error');
      continue;
    }
    // codex exec --json
    if (type === 'item.completed' && isObject(row['item'])) {
      const item = row['item'];
      const itemType = str(item['type']);
      if (itemType === 'reasoning') thinking(str(item['text']), 'summary');
      else if (itemType === 'command_execution') {
        const code = item['exit_code'];
        const ok = str(item['status']) === 'failed' ? false : typeof code === 'number' ? code === 0 : null;
        tool('command_execution', { command: item['command'] }, ok, null);
      } else if (itemType === 'file_change') {
        tool('file_change', { changes: item['changes'] }, str(item['status']) === 'failed' ? false : true, null);
      } else if (itemType === 'mcp_tool_call') {
        const name = str(item['server']) && str(item['tool']) ? `mcp:${str(item['server'])}.${str(item['tool'])}` : 'mcp_tool_call';
        tool(name, item['arguments'] ?? {}, str(item['status']) === 'failed' ? false : null, null);
      } else if (itemType === 'agent_message') {
        flush(null);
        acc.addMessage(`run:${runId}#${n}`, stepAt, str(item['text']));
      }
      continue;
    }
    if (type === 'turn.failed' || type === 'error') resultError = true;
  }
  flush(null);

  const outcome: ReasoningOutcome | null = inv.ok === null ? null : inv.ok && !resultError ? 'ok' : 'error';
  let errorClass: string | null = null;
  if (outcome === 'error') {
    const cls = classifyAgentDiagnosticError(inv.error ?? '');
    errorClass = cls !== 'none' ? cls : inv.terminationReason;
  }
  const feature = acc.finish(outcome, endedAt, errorClass);
  // Honest attribution: the model the stream reported beats the header's.
  feature.model = model;
  for (const step of steps) step.model = model;
  return { steps, feature };
}

// ---------------------------------------------------------------------------
// Current .jsonl metadata rows
// ---------------------------------------------------------------------------

/** One metadata diagnostic row → one text-free feature row (null when malformed). */
export function featureFromDiagnosticRow(row: unknown): TurnFeaturesV1 | null {
  if (!isObject(row) || row['schemaVersion'] !== 1) return null;
  const runRef = str(row['runRef']);
  const ts = str(row['ts']);
  const engine = str(row['engine']);
  if (!/^[0-9a-f]{16,128}$/.test(runRef) || !Number.isFinite(Date.parse(ts)) || engine === '') return null;
  // Full 64-hex refs look like secrets to the public-JSON scrubber; a 24-hex
  // prefix is unique enough and survives sanitisation intact.
  const runId = `rr-${runRef.slice(0, 24)}`;
  const attempt = typeof row['attempt'] === 'number' ? row['attempt'] : 1;
  const durationMs = typeof row['durationMs'] === 'number' && row['durationMs'] >= 0 ? row['durationMs'] : null;
  const endedAt = new Date(Date.parse(ts)).toISOString();
  const startedAt = durationMs !== null ? new Date(Date.parse(ts) - durationMs).toISOString() : null;
  const ok = row['ok'] === true;
  const errorClass = !ok
    ? (str(row['errorClass']) && str(row['errorClass']) !== 'none' ? str(row['errorClass']) : str(row['terminationReason']) || null)
    : null;
  const acc = new TurnAccumulator({
    id: `fleet:${runId}:a${attempt}:${Date.parse(ts)}`,
    source: 'fleet',
    sessionId: null,
    runId,
    repo: null,
    engine,
    model: null,
    turnId: `a${attempt}`,
    startedAt,
  });
  const feature = acc.finish(ok ? 'ok' : 'error', endedAt, errorClass);
  if (!ok) feature.evidence = { struggle: [{ ref: `run:${runId}#a${attempt}`, at: endedAt }] };
  return feature;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/** Incrementally ingest fleet agent logs. Never throws. */
export async function ingestFleetAgentLogs(options: FleetIngestOptions = {}): Promise<FleetIngestResult> {
  const root = options.root ?? reasoningRoot();
  const dir = options.logsDir ?? agentDiagnosticsDir();
  const result: FleetIngestResult = { filesSeen: 0, filesRead: 0, invocations: 0, steps: 0, features: 0 };
  try {
    const prior = readStoreState<CursorState>(CURSOR_NAME, root);
    const cursor: CursorState = prior?.v === 1 && isObject(prior.files) ? prior : { v: 1, files: {} };
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return result;
    }
    const present = new Set<string>();
    for (const name of names.slice(0, MAX_FILES_PER_RUN)) {
      const legacy = LOG_NAME_RE.exec(name);
      const meta = legacy ? null : JSONL_NAME_RE.exec(name);
      if (!legacy && !meta) continue;
      present.add(name);
      result.filesSeen += 1;
      const path = join(dir, name);
      let stat;
      try {
        stat = await lstat(path);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      const previous = cursor.files[name];
      if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) continue;
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      result.filesRead += 1;
      const steps: ReasoningStepV1[] = [];
      const features: TurnFeaturesV1[] = [];
      if (legacy) {
        // Legacy logs are frozen (the writer moved to .jsonl); a changed one is
        // re-analysed whole and de-duplicated by deterministic ids on read.
        const runId = legacy[1] ?? basename(name, '.log');
        const fallbackAt = new Date(stat.mtimeMs).toISOString();
        for (const inv of parseLegacyAgentLog(text)) {
          const traced = traceLegacyInvocation(inv, runId, fallbackAt);
          steps.push(...traced.steps);
          features.push(traced.feature);
          result.invocations += 1;
        }
        cursor.files[name] = { size: stat.size, mtimeMs: stat.mtimeMs };
      } else {
        const start = previous?.offset !== undefined && previous.offset <= Buffer.byteLength(text, 'utf8') ? previous.offset : 0;
        const bytes = Buffer.from(text, 'utf8');
        const tail = bytes.subarray(start).toString('utf8');
        const lastNewline = tail.lastIndexOf('\n');
        const complete = lastNewline === -1 ? '' : tail.slice(0, lastNewline + 1);
        for (const line of complete.split('\n')) {
          if (line.trim() === '') continue;
          try {
            const feature = featureFromDiagnosticRow(JSON.parse(line));
            if (feature) {
              features.push(feature);
              result.invocations += 1;
            }
          } catch {
            /* torn row */
          }
        }
        cursor.files[name] = { size: stat.size, mtimeMs: stat.mtimeMs, offset: start + Buffer.byteLength(complete, 'utf8') };
      }
      result.steps += await appendStepsChunked(steps, root);
      result.features += appendFeatures(features, root);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const name of Object.keys(cursor.files)) {
      if (!present.has(name)) delete cursor.files[name];
    }
    writeStoreState(CURSOR_NAME, cursor, root);
  } catch {
    /* best-effort maintenance */
  }
  return result;
}
