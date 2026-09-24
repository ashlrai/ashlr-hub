/**
 * Deterministic reasoning extractors (V3.10, unit A7). NO model calls.
 *
 * A turn — one Verse turn, one codex rollout task, one fleet invocation — is
 * folded action by action into a TurnAccumulator, which keeps only COUNTERS
 * and short derived labels (tool signatures, phrase keys, evidence refs),
 * never the reasoning text itself. `finish()` emits a TurnFeaturesV1 row:
 * text-free, so it outlives the 30-day text window (180 days) and is what
 * insights.ts aggregates.
 *
 * What is detected, per turn:
 *  - tool FAILURES grouped by signature (`npm test`, `edit foo.ts`), and
 *    REPEATED failures (same signature failing ≥ 2×);
 *  - LOOPS: the same call repeated ≥ LOOP_MIN times with no edit in between
 *    (re-running a test after each fix is progress, not a loop);
 *  - UNCERTAINTY / BACKTRACK / GIVE-UP phrases in reasoning text (weighted
 *    phrase lists — "maybe" alone is not doubt, "I'm not sure" is);
 *  - VERIFICATION GAPS: edits with no test/build after the last one, and a
 *    final message claiming "tests pass" with no passing test/build in the
 *    turn (claim-vs-evidence);
 *  - WINS: a passing test/build after the last edit (or a failing test that
 *    later passes) on a turn that did not end in error.
 *
 * Everything here is pure: same inputs → same features. Tested on fixtures.
 */

import { basename } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import type {
  ReasoningEvidence,
  ReasoningInsightKind,
  ReasoningOutcome,
  ReasoningSource,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolCategory = 'edit' | 'test' | 'build' | 'read' | 'search' | 'shell' | 'agent' | 'other';

export interface ClassifiedTool {
  category: ToolCategory;
  /** Short, scrub-safe grouping key: `npm test`, `edit store.ts`, `Grep`. Never file contents or full commands. */
  signature: string;
  /** File basename for edit/read tools; null otherwise. */
  target: string | null;
}

export interface SignatureCount {
  signature: string;
  count: number;
  /** The newest occurrence, so an insight about this signature can link to it. */
  evidence?: ReasoningEvidence;
}

/** Turn identity + attribution, known when the turn starts. */
export interface TurnMeta {
  /** Deterministic feature id (dedupe key): e.g. `verse:<sessionId>:<turnId>`. */
  id: string;
  source: ReasoningSource;
  sessionId: string | null;
  runId: string | null;
  repo: string | null;
  engine: string;
  model: string | null;
  turnId: string | null;
  startedAt: string | null;
}

/** One persisted feature row per finished turn. Text-free by construction. */
export interface TurnFeaturesV1 {
  v: 1;
  type: 'turn';
  id: string;
  source: ReasoningSource;
  sessionId: string | null;
  runId: string | null;
  repo: string | null;
  engine: string;
  model: string | null;
  turnId: string | null;
  /** Partition time: start of the turn (end when the start is unknown). */
  at: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: ReasoningOutcome | null;
  /** Stable error category (`rate-limit`, `native-thread-missing`, …); null when none/unknown. */
  errorClass: string | null;
  thinkingSteps: number;
  thinkingChars: number;
  /** Thinking blocks the CLI sent without text (signature-only / redacted). */
  redactedThinking: number;
  toolCalls: number;
  toolErrors: number;
  edits: number;
  editedFiles: number;
  tests: number;
  testsPassed: number;
  testsFailed: number;
  builds: number;
  /** Turn start → first edit, when both are known. */
  firstEditMs: number | null;
  verifiedAfterEdit: boolean;
  verificationGap: boolean;
  claimUnverified: boolean;
  /** Weighted uncertainty phrase score (strong markers 2, weak 1). */
  uncertaintyScore: number;
  uncertaintyKeys: string[];
  backtrackHits: number;
  /** Files edited ≥ REEDIT_MIN times in the turn. */
  reEditedFiles: number;
  giveUpHits: number;
  failures: SignatureCount[];
  loops: SignatureCount[];
  struggle: boolean;
  win: boolean;
  gaveUp: boolean;
  /** Actions past MAX_TRACKED_TOOLS were counted but not individually analysed. */
  truncated: boolean;
  evidence: Partial<Record<ReasoningInsightKind, ReasoningEvidence[]>>;
}

// ---------------------------------------------------------------------------
// Thresholds (named so tests and insights share them)
// ---------------------------------------------------------------------------

export const LOOP_MIN = 3;
export const REEDIT_MIN = 3;
export const REPEATED_FAILURE_MIN = 2;
export const UNCERTAIN_TURN_SCORE = 4;
export const BACKTRACK_TURN_MIN = 2;
export const STRUGGLE_TOOL_ERRORS = 3;
const MAX_TRACKED_TOOLS = 2_000;
const MAX_EVIDENCE_PER_KIND = 3;
const MAX_SIGNATURES = 10;
const MAX_SIGNATURE_CHARS = 80;

// ---------------------------------------------------------------------------
// Phrase detection
// ---------------------------------------------------------------------------

interface PhraseRule {
  key: string;
  weight: number;
  re: RegExp;
}

/**
 * Strong markers (weight 2) say the model does not know; weak ones (1) are
 * ordinary hedging that only matters in bulk. A turn is "uncertain" at
 * UNCERTAIN_TURN_SCORE — two strong markers, or a pile of hedges.
 */
const UNCERTAINTY_RULES: PhraseRule[] = [
  { key: 'not-sure', weight: 2, re: /\bnot\s+(?:entirely\s+|completely\s+|quite\s+|really\s+|100%\s+)?(?:sure|certain|confident)\b|\bunsure\b/gi },
  { key: 'dont-know', weight: 2, re: /\b(?:i\s+don'?t\s+know|i\s+do\s+not\s+know|no\s+idea|can'?t\s+tell|cannot\s+tell|hard\s+to\s+(?:say|tell))\b/gi },
  { key: 'unclear', weight: 2, re: /\b(?:unclear|ambiguous|confusing|confused|puzzling|doesn'?t\s+make\s+sense|does\s+not\s+make\s+sense)\b/gi },
  { key: 'stuck', weight: 2, re: /\b(?:i'?m\s+stuck|still\s+stuck|going\s+in\s+circles|still\s+(?:failing|broken|not\s+working)|same\s+error\s+again)\b/gi },
  { key: 'guess', weight: 1, re: /\b(?:i\s+guess|i'?m\s+guessing|my\s+guess|presumably)\b/gi },
  { key: 'maybe', weight: 1, re: /\b(?:maybe|perhaps)\b/gi },
  { key: 'recheck', weight: 1, re: /\b(?:let\s+me\s+(?:check|look|verify)\s+(?:again|once\s+more)|double[-\s]check|re-?check)\b/gi },
];

// `\bwait` never matches inside `await` (no word boundary), and the trailing
// punctuation keeps `wait(…)` / `waitFor` out.
const BACKTRACK_RE = /\bactually,|\bwait[,.!—–-]|\bon\s+second\s+thought\b|\bscratch\s+that\b|\bthat'?s\s+(?:wrong|not\s+right|incorrect)\b|\bi\s+was\s+wrong\b|\bmy\s+mistake\b|\boops\b|\blet\s+me\s+(?:revert|undo|reconsider|rethink|start\s+over|go\s+back)\b|\brevert(?:ing)?\s+(?:the|my|this|that)\s+(?:change|edit|fix)\b/gi;

const GIVE_UP_RE = /\b(?:give\s+up|giving\s+up|i\s+can'?t\s+(?:figure|solve|fix|get\s+(?:it|this))|unable\s+to\s+(?:fix|solve|resolve|figure|proceed|complete)|cannot\s+proceed|can'?t\s+proceed|out\s+of\s+ideas|i'?ll\s+stop\s+here)\b/gi;

/** A final message that asserts verification. Checked against the turn's actual test/build evidence. */
const CLAIM_RE = /\b(?:all\s+)?tests?\s+(?:now\s+)?(?:pass(?:es|ed|ing)?|are\s+(?:passing|green)|green)\b|\b(?:typecheck|type-check|tsc|build|lint)\s+(?:is\s+|now\s+)?(?:clean|pass(?:es|ed)?|succeed(?:s|ed)?|green)\b|\bverified\s+(?:that|it|the\s+fix|end[-\s]to[-\s]end)\b/i;

function countMatches(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let count = 0;
  while (re.exec(text) !== null) count += 1;
  return count;
}

export interface PhraseHits {
  uncertaintyScore: number;
  uncertaintyKeys: string[];
  backtrack: number;
  giveUp: number;
}

/** Count uncertainty / backtrack / give-up markers in one block of reasoning text. */
export function detectPhrases(text: string): PhraseHits {
  let score = 0;
  const keys: string[] = [];
  for (const rule of UNCERTAINTY_RULES) {
    const hits = countMatches(rule.re, text);
    if (hits > 0) {
      score += hits * rule.weight;
      keys.push(rule.key);
    }
  }
  return {
    uncertaintyScore: score,
    uncertaintyKeys: keys,
    backtrack: countMatches(BACKTRACK_RE, text),
    giveUp: countMatches(GIVE_UP_RE, text),
  };
}

/** True when a final message claims tests/build/verification succeeded. */
export function claimsVerification(text: string): boolean {
  return CLAIM_RE.test(text);
}

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

const TEST_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnpx\s+(?:vitest|jest|mocha|playwright\s+test|ava|tap)\b|\b(?:vitest|jest|mocha|pytest|rspec|phpunit|ctest|nextest)\b|\b(?:go|cargo|swift|dotnet|mix|deno|bun|zig)\s+test\b|\bnode\s+--test\b|\bmake\s+(?:test|check)\b|\b(?:mvn|gradle|\.\/gradlew)\s+(?:\S+\s+)*?test\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b|\btox\b/;
const BUILD_RE = /\b(?:npx\s+)?tsc\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:build|typecheck|type-check|lint|check|compile)\b|\b(?:eslint|mypy|ruff|pyright|clippy|biome)\b|\b(?:cargo|go)\s+(?:build|check|vet)\b|\bswift\s+build\b|\b(?:gradle|\.\/gradlew)\s+build\b|\bmvn\s+(?:compile|package|verify)\b|\bmake(?:\s+(?!test|check)[\w-]+)?\s*$/;
const SHELL_EDIT_RE = /\bapply_patch\b|\bsed\s+-i\b|\bperl\s+-pi\b/;
const SHELL_READ_RE = /^(?:cat|head|tail|less|wc|ls|tree|stat|file|nl)\b/;
const SHELL_SEARCH_RE = /^(?:rg|grep|ag|find|fd|git\s+grep)\b/;

const SHELL_NAMES = new Set([
  'bash', 'shell', 'local_shell', 'command_execution', 'exec_command', 'run_terminal_cmd', 'run_command',
  'execute_command', 'terminal', 'exec', 'run_shell_command', 'shell_command', 'container.exec', 'bash_start',
]);
const EDIT_NAMES = new Set([
  'edit', 'multiedit', 'write', 'notebookedit', 'file_change', 'apply_patch', 'search_replace', 'str_replace',
  'str_replace_editor', 'str_replace_based_edit_tool', 'write_file', 'edit_file', 'create_file', 'replace_in_file',
  'multi_edit', 'insert', 'patch', 'edit_structural', 'search_replace_regex', 'notebook_edit', 'rename_file',
]);
const READ_NAMES = new Set(['read', 'read_file', 'view', 'view_file', 'open_file', 'notebookread', 'ls', 'list_dir', 'list_directory', 'tree']);
const SEARCH_NAMES = new Set([
  'grep', 'glob', 'search', 'find', 'codebase_search', 'grep_search', 'file_search', 'web_search', 'websearch',
  'webfetch', 'web_fetch', 'search_files',
]);
/**
 * Orchestration / polling calls. They are counted but never form "loops":
 * a codex session legitimately calls `wait` hundreds of times.
 */
const AGENT_NAMES = new Set([
  'task', 'agent', 'spawn_agent', 'send_message', 'wait_agent', 'close_agent', 'list_agents', 'followup_task',
  'send_input', 'todowrite', 'todo_write', 'update_plan', 'wait', 'sleep', 'write_stdin', 'get_goal',
  'request_user_input', 'request_user_input_async', 'exitplanmode', 'bash_output', 'killshell', 'bash_tail',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Last segment of a namespaced tool name: `mcp__plugin_x__ashlr__edit` → `edit`, `mcp:server.read_file` → `read_file`. */
function baseToolName(name: string): string {
  const lower = name.trim().toLowerCase();
  const parts = lower.split(/__|:|\./).filter((part) => part !== '');
  return parts[parts.length - 1] ?? lower;
}

function commandText(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!isObject(input)) return null;
  const raw = input['command'] ?? input['cmd'] ?? input['script'];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const parts = raw.filter((part): part is string => typeof part === 'string');
    // codex: ['/bin/zsh', '-lc', 'npm test'] — the script is the last arg.
    if (parts.length >= 3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(parts[0] ?? '') && /^-\w*c$/.test(parts[1] ?? '')) {
      return parts.slice(2).join(' ');
    }
    return parts.join(' ');
  }
  return null;
}

function fileTarget(input: unknown): string | null {
  if (!isObject(input)) return null;
  for (const key of ['file_path', 'filePath', 'path', 'target_file', 'notebook_path', 'file']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  const changes = input['changes'];
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (isObject(change) && typeof change['path'] === 'string') return change['path'];
    }
  } else if (isObject(changes)) {
    const first = Object.keys(changes)[0];
    if (first) return first;
  }
  return null;
}

/** Stable, bounded identity of a tool input (for exact-repeat detection). */
function inputKey(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 1_024);
  try {
    return (JSON.stringify(input) ?? '').slice(0, 1_024);
  } catch {
    return '';
  }
}

/** Every file an edit call touches (codex file_change can carry several). */
export function editTargets(input: unknown): string[] {
  if (!isObject(input)) return [];
  const changes = input['changes'];
  const out: string[] = [];
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (isObject(change) && typeof change['path'] === 'string') out.push(change['path']);
    }
  } else if (isObject(changes)) {
    out.push(...Object.keys(changes));
  }
  if (out.length === 0) {
    const single = fileTarget(input);
    if (single) out.push(single);
  }
  return out.map((path) => basename(path)).filter((name) => name !== '');
}

/** Signatures are persisted for 180 days: always scrubbed, single-line, bounded. */
function shortLabel(text: string): string {
  const cleaned = scrubSecrets(text).replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_SIGNATURE_CHARS ? `${cleaned.slice(0, MAX_SIGNATURE_CHARS - 1)}…` : cleaned;
}

/**
 * Reduce a shell command to a stable, low-risk signature: the segment that
 * matters (the test/build step of a `cd x && npm test` chain), env
 * assignments and wrappers dropped, at most three tokens before the first
 * flag, quoted arguments dropped, paths reduced to basenames.
 * `npx vitest run test/a.test.ts --reporter=dot` → `npx vitest run`. Arguments beyond the verb are exactly where secrets and
 * personal paths live, so they are deliberately not kept.
 */
export function commandSignature(command: string): string {
  const unwrapped = unwrapShell(command);
  const segments = unwrapped.split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter((s) => s !== '');
  const meaningful = segments.filter((segment) => !/^(?:cd|pushd|popd|export|set|source|\.)\b/.test(segment));
  const chosen = meaningful.find((segment) => TEST_RE.test(segment) || BUILD_RE.test(segment)) ?? meaningful[0] ?? segments[0] ?? '';
  // Quote-aware split so a quoted argument is dropped WHOLE (never half-kept).
  const tokens = chosen.match(/"(?:\\.|[^"\\])*"?|'[^']*'?|`[^`]*`?|\S+/g) ?? [];
  const kept: string[] = [];
  for (const token of tokens) {
    if (kept.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // FOO=bar prefix
    if (kept.length === 0 && /^(?:sudo|time|timeout|nice|env|nohup|exec)$/.test(token)) continue;
    if (kept.length === 0 && /^\d+[smh]?$/.test(token)) continue; // `timeout 60`'s duration
    // Everything from the first flag on is arguments (`-H <header>`, `-p <password>`):
    // stop there rather than guess which flags take secret values.
    if (token.startsWith('-')) break;
    // A redirection ends the command proper (`> out.txt` is not part of it).
    if (/^(?:\d*[<>]|&>)/.test(token)) break;
    // Quoted args and substitutions: never kept (that is where secrets,
    // patterns and personal paths live).
    if (/^["'`$({]|\$\(/.test(token)) continue;
    kept.push(token.includes('/') ? basename(token) || token : token);
    if (kept.length >= 3) break;
  }
  return shortLabel(kept.join(' ') || 'shell');
}

const SHELL_WRAPPER_RE = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+-\w*c\s+(["'])([\s\S]*)\1\s*$/;

/** `/bin/zsh -lc "npm test"` → `npm test` (codex/grok wrap every command this way). */
export function unwrapShell(command: string): string {
  let current = command;
  for (let i = 0; i < 3; i += 1) {
    const match = SHELL_WRAPPER_RE.exec(current);
    if (!match) break;
    const inner = match[2] ?? '';
    current = match[1] === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner;
  }
  return current;
}

/** Classify one tool call. Name-first, then the command text for shells. */
export function classifyTool(name: string, input: unknown): ClassifiedTool {
  const base = baseToolName(name);
  const displayName = shortLabel(name.trim() || 'tool');
  if (AGENT_NAMES.has(base)) return { category: 'agent', signature: displayName, target: null };
  if (EDIT_NAMES.has(base) || (/(?:^|_)(?:edit|write|patch)(?:_|$)/.test(base) && !/stdin|todo/.test(base))) {
    const targets = editTargets(input);
    const target = targets[0] ?? null;
    return { category: 'edit', signature: target ? shortLabel(`edit ${target}`) : displayName, target };
  }
  if (SHELL_NAMES.has(base) || base.endsWith('bash') || base.endsWith('shell')) {
    const raw = commandText(input);
    if (!raw) return { category: 'shell', signature: displayName, target: null };
    const command = unwrapShell(raw);
    const signature = commandSignature(command);
    const head = command.replace(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '').trim();
    if (TEST_RE.test(command)) return { category: 'test', signature, target: null };
    if (BUILD_RE.test(command)) return { category: 'build', signature, target: null };
    if (SHELL_EDIT_RE.test(command)) return { category: 'edit', signature, target: null };
    if (SHELL_SEARCH_RE.test(head)) return { category: 'search', signature, target: null };
    if (SHELL_READ_RE.test(head)) return { category: 'read', signature, target: null };
    return { category: 'shell', signature, target: null };
  }
  if (READ_NAMES.has(base) || /(?:^|_)read(?:_|$)/.test(base)) {
    const file = fileTarget(input);
    const target = file ? basename(file) : null;
    return { category: 'read', signature: target ? shortLabel(`read ${target}`) : displayName, target };
  }
  if (SEARCH_NAMES.has(base) || /(?:^|_)(?:grep|glob|search)(?:_|$)/.test(base)) {
    return { category: 'search', signature: displayName, target: null };
  }
  return { category: 'other', signature: displayName, target: null };
}

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

interface ToolRecord {
  ref: string;
  at: string;
  category: ToolCategory;
  signature: string;
  /** Exact-call identity (signature + input). In memory only — never persisted. */
  loopKey: string;
  targets: string[];
  ok: boolean | null;
}

export type ToolHandle = number;

function pushEvidence(
  evidence: Partial<Record<ReasoningInsightKind, ReasoningEvidence[]>>,
  kind: ReasoningInsightKind,
  item: ReasoningEvidence,
): void {
  const list = evidence[kind] ?? (evidence[kind] = []);
  if (list.length < MAX_EVIDENCE_PER_KIND && !list.some((e) => e.ref === item.ref)) list.push(item);
}

function topSignatures(
  counts: Map<string, number>,
  min: number,
  refs: Map<string, ReasoningEvidence>,
): SignatureCount[] {
  return [...counts.entries()]
    .filter(([, count]) => count >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SIGNATURES)
    .map(([signature, count]) => {
      const ref = refs.get(signature);
      return ref ? { signature, count, evidence: ref } : { signature, count };
    });
}

/**
 * Folds one turn's actions into features. Holds counters and tool metadata
 * only — reasoning text is inspected in `addThinking` and then dropped.
 */
export class TurnAccumulator {
  readonly meta: TurnMeta;
  private readonly tools: ToolRecord[] = [];
  private readonly evidence: Partial<Record<ReasoningInsightKind, ReasoningEvidence[]>> = {};
  private thinkingSteps = 0;
  private thinkingChars = 0;
  private redactedThinking = 0;
  private uncertaintyScore = 0;
  private readonly uncertaintyKeys = new Set<string>();
  private backtrackHits = 0;
  private giveUpHits = 0;
  private extraToolCalls = 0;
  private extraToolErrors = 0;
  private lastMessageClaims = false;
  private lastMessageRef: ReasoningEvidence | null = null;
  private lastActivityAt: string | null;

  constructor(meta: TurnMeta) {
    this.meta = meta;
    this.lastActivityAt = meta.startedAt;
  }

  /** ISO time of the newest action seen (for idle sweeps). */
  get lastAt(): string | null {
    return this.lastActivityAt;
  }

  get actionCount(): number {
    return this.thinkingSteps + this.tools.length + this.extraToolCalls;
  }

  addThinking(ref: string, at: string, text: string, redacted = false): void {
    this.lastActivityAt = at;
    this.thinkingSteps += 1;
    this.thinkingChars += text.length;
    if (redacted || text === '') {
      this.redactedThinking += redacted ? 1 : 0;
      return;
    }
    const hits = detectPhrases(text);
    const item = { ref, at };
    if (hits.uncertaintyScore > 0) {
      this.uncertaintyScore += hits.uncertaintyScore;
      for (const key of hits.uncertaintyKeys) this.uncertaintyKeys.add(key);
      pushEvidence(this.evidence, 'uncertainty', item);
    }
    if (hits.backtrack > 0) {
      this.backtrackHits += hits.backtrack;
      pushEvidence(this.evidence, 'backtrack', item);
    }
    if (hits.giveUp > 0) {
      this.giveUpHits += hits.giveUp;
      pushEvidence(this.evidence, 'struggle', item);
    }
  }

  /** Record a tool call; resolve its result later with `resolveTool` (ok stays null = unknown otherwise). */
  addTool(ref: string, at: string, name: string, input: unknown, ok: boolean | null = null): ToolHandle {
    this.lastActivityAt = at;
    if (this.tools.length >= MAX_TRACKED_TOOLS) {
      this.extraToolCalls += 1;
      if (ok === false) this.extraToolErrors += 1;
      return -1;
    }
    const classified = classifyTool(name, input);
    const targets = classified.category === 'edit' ? editTargets(input) : [];
    this.tools.push({
      ref, at, category: classified.category, signature: classified.signature, targets, ok,
      loopKey: `${classified.signature}\u0000${inputKey(input)}`,
    });
    return this.tools.length - 1;
  }

  resolveTool(handle: ToolHandle, ok: boolean, at?: string): void {
    if (at) this.lastActivityAt = at;
    if (handle < 0) {
      if (!ok) this.extraToolErrors += 1;
      return;
    }
    const record = this.tools[handle];
    if (record) record.ok = ok;
  }

  /** The assistant's visible message. Only the LAST one's claim matters (it is the turn's answer). */
  addMessage(ref: string, at: string, text: string): void {
    this.lastActivityAt = at;
    this.lastMessageClaims = claimsVerification(text);
    this.lastMessageRef = { ref, at };
  }

  finish(outcome: ReasoningOutcome | null, endedAt: string | null, errorClass: string | null = null): TurnFeaturesV1 {
    const tools = this.tools;
    const evidence = this.evidence;
    const toolErrors = tools.filter((t) => t.ok === false).length + this.extraToolErrors;

    // Failures by signature.
    const failureCounts = new Map<string, number>();
    const failureRefs = new Map<string, ReasoningEvidence>();
    for (const tool of tools) {
      if (tool.ok !== false) continue;
      failureCounts.set(tool.signature, (failureCounts.get(tool.signature) ?? 0) + 1);
      failureRefs.set(tool.signature, { ref: tool.ref, at: tool.at });
    }
    const failures = topSignatures(failureCounts, 1, failureRefs);
    const repeated = failures.filter((f) => f.count >= REPEATED_FAILURE_MIN);
    for (const tool of tools) {
      if (tool.ok === false && (failureCounts.get(tool.signature) ?? 0) >= REPEATED_FAILURE_MIN) {
        pushEvidence(evidence, 'struggle', { ref: tool.ref, at: tool.at });
      }
    }

    // Loops: the IDENTICAL call (same input, not just the same signature —
    // paging through a file with different ranges is not a loop) repeated
    // with no edit in between. Reported under the signature label.
    const run = new Map<string, number>();
    const loopMax = new Map<string, number>();
    const loopRefs = new Map<string, ReasoningEvidence>();
    const editsPerFile = new Map<string, number>();
    let edits = 0;
    let lastEditIdx = -1;
    let firstEditAt: string | null = null;
    tools.forEach((tool, idx) => {
      if (tool.category === 'edit') {
        edits += 1;
        lastEditIdx = idx;
        firstEditAt ??= tool.at;
        run.clear();
        for (const file of tool.targets) editsPerFile.set(file, (editsPerFile.get(file) ?? 0) + 1);
        return;
      }
      if (tool.category === 'agent') return;
      const next = (run.get(tool.loopKey) ?? 0) + 1;
      run.set(tool.loopKey, next);
      if (next > (loopMax.get(tool.signature) ?? 0)) loopMax.set(tool.signature, next);
      if (next === LOOP_MIN) loopRefs.set(tool.signature, { ref: tool.ref, at: tool.at });
    });
    const loops = topSignatures(loopMax, LOOP_MIN, loopRefs);
    for (const loop of loops) {
      const ref = loopRefs.get(loop.signature);
      if (ref) pushEvidence(evidence, 'loop', ref);
    }
    const reEditedFiles = [...editsPerFile.values()].filter((count) => count >= REEDIT_MIN).length;
    if (reEditedFiles > 0) {
      const reEdit = tools.filter((t) => t.category === 'edit').slice(-1)[0];
      if (reEdit) pushEvidence(evidence, 'backtrack', { ref: reEdit.ref, at: reEdit.at });
    }

    // Verification.
    const verifications = tools
      .map((tool, idx) => ({ tool, idx }))
      .filter(({ tool }) => tool.category === 'test' || tool.category === 'build');
    const tests = tools.filter((t) => t.category === 'test');
    const verifiedAfterEdit = edits > 0 && verifications.some(({ idx }) => idx > lastEditIdx);
    const verificationGap = edits > 0 && !verifiedAfterEdit && outcome !== 'cancelled';
    const anyPassingVerification = verifications.some(({ tool }) => tool.ok === true);
    const claimUnverified = this.lastMessageClaims && !anyPassingVerification;
    if (verificationGap) {
      const lastEdit = tools[lastEditIdx];
      if (lastEdit) pushEvidence(evidence, 'verification-gap', { ref: lastEdit.ref, at: lastEdit.at });
    }
    if (claimUnverified && this.lastMessageRef) pushEvidence(evidence, 'verification-gap', this.lastMessageRef);

    // Wins: last verification after the last edit passed, or a failing test later passed.
    const afterEdit = verifications.filter(({ idx }) => idx > lastEditIdx);
    const lastAfterEdit = afterEdit[afterEdit.length - 1];
    const editWin = edits > 0 && lastAfterEdit !== undefined && lastAfterEdit.tool.ok === true;
    let recovered: ToolRecord | null = null;
    const failedTests = new Set<string>();
    for (const tool of tests) {
      if (tool.ok === false) failedTests.add(tool.signature);
      else if (tool.ok === true && failedTests.has(tool.signature)) recovered = tool;
    }
    const lastTest = tests[tests.length - 1];
    const recoveredWin = recovered !== null && lastTest?.ok === true;
    const win = (editWin || recoveredWin) && outcome !== 'error' && outcome !== 'cancelled';
    if (win) {
      const ref = editWin && lastAfterEdit ? lastAfterEdit.tool : recovered;
      if (ref) pushEvidence(evidence, 'win', { ref: ref.ref, at: ref.at });
    }

    const gaveUp = this.giveUpHits > 0 && edits === 0;
    const struggle = outcome === 'error' || repeated.length > 0 || gaveUp || toolErrors >= STRUGGLE_TOOL_ERRORS;
    if (outcome === 'error' && !(evidence.struggle?.length)) {
      // A failed turn with no finer-grained evidence still needs a pointer an
      // operator can open: its last action, else the conversation itself.
      const lastTool = tools[tools.length - 1];
      const fallbackAt = endedAt ?? this.lastActivityAt ?? this.meta.startedAt;
      const conversationRef = this.meta.sessionId ? `session:${this.meta.sessionId}` : this.meta.runId ? `run:${this.meta.runId}` : null;
      if (lastTool) pushEvidence(evidence, 'struggle', { ref: lastTool.ref, at: lastTool.at });
      else if (this.lastMessageRef) pushEvidence(evidence, 'struggle', this.lastMessageRef);
      else if (conversationRef && fallbackAt) pushEvidence(evidence, 'struggle', { ref: conversationRef, at: fallbackAt });
    }

    const startedMs = this.meta.startedAt ? Date.parse(this.meta.startedAt) : Number.NaN;
    const endedMs = endedAt ? Date.parse(endedAt) : Number.NaN;
    const firstEditMs = firstEditAt && Number.isFinite(startedMs)
      ? Math.max(0, Date.parse(firstEditAt) - startedMs)
      : null;
    const at = this.meta.startedAt ?? endedAt ?? this.lastActivityAt ?? new Date(0).toISOString();

    return {
      v: 1,
      type: 'turn',
      id: this.meta.id,
      source: this.meta.source,
      sessionId: this.meta.sessionId,
      runId: this.meta.runId,
      repo: this.meta.repo,
      engine: this.meta.engine,
      model: this.meta.model,
      turnId: this.meta.turnId,
      at,
      endedAt,
      durationMs: Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : null,
      outcome,
      errorClass,
      thinkingSteps: this.thinkingSteps,
      thinkingChars: this.thinkingChars,
      redactedThinking: this.redactedThinking,
      toolCalls: tools.length + this.extraToolCalls,
      toolErrors,
      edits,
      editedFiles: editsPerFile.size,
      tests: tests.length,
      testsPassed: tests.filter((t) => t.ok === true).length,
      testsFailed: tests.filter((t) => t.ok === false).length,
      builds: tools.filter((t) => t.category === 'build').length,
      firstEditMs: firstEditMs !== null && Number.isFinite(firstEditMs) ? firstEditMs : null,
      verifiedAfterEdit,
      verificationGap,
      claimUnverified,
      uncertaintyScore: this.uncertaintyScore,
      uncertaintyKeys: [...this.uncertaintyKeys].sort(),
      backtrackHits: this.backtrackHits,
      reEditedFiles,
      giveUpHits: this.giveUpHits,
      failures,
      loops,
      struggle,
      win,
      gaveUp,
      truncated: this.extraToolCalls > 0,
      evidence,
    };
  }
}

// ---------------------------------------------------------------------------
// Whole-trace convenience (fixtures, backfills)
// ---------------------------------------------------------------------------

export type TraceAction =
  | { kind: 'thinking'; ref: string; at: string; text: string; redacted?: boolean }
  | { kind: 'tool'; ref: string; at: string; name: string; input: unknown; ok: boolean | null }
  | { kind: 'message'; ref: string; at: string; text: string };

export interface TurnTrace extends TurnMeta {
  actions: TraceAction[];
  outcome: ReasoningOutcome | null;
  endedAt: string | null;
  errorClass?: string | null;
}

/** Fold a complete trace into features (pure). */
export function extractTurnFeatures(trace: TurnTrace): TurnFeaturesV1 {
  const acc = new TurnAccumulator(trace);
  for (const action of trace.actions) {
    if (action.kind === 'thinking') acc.addThinking(action.ref, action.at, action.text, action.redacted === true);
    else if (action.kind === 'tool') acc.addTool(action.ref, action.at, action.name, action.input, action.ok);
    else acc.addMessage(action.ref, action.at, action.text);
  }
  return acc.finish(trace.outcome, trace.endedAt, trace.errorClass ?? null);
}

/**
 * Human label for a repo key: the last path segment (`~/src/ashlr-hub` →
 * `ashlr-hub`), or the slug itself.
 */
export function repoLabel(repo: string | null): string | null {
  if (!repo) return null;
  const trimmed = repo.replace(/[\\/]+$/, '');
  const last = trimmed.split(/[\\/]/).pop();
  return last && last !== '~' ? last : trimmed;
}
