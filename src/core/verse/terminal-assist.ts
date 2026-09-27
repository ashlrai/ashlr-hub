/**
 * core/verse/terminal-assist.ts — the terminal's local-model helper (3.15).
 *
 * MINIMAL ON PURPOSE. This file currently carries one job — error-fix chips:
 * a command in a terminal tab exited non-zero, and the operator's LOCAL model
 * proposes at most three commands that might fix it. The plain-language
 * command feature lands in this same module from its own branch; the two are
 * reconciled there (same file name, disjoint exports).
 *
 * NEVER RUNS ANYTHING. The suggestions are strings the page shows as chips:
 * [Paste] types one at a prompt and stops; the operator presses Enter.
 *
 * NEVER A PAID SEAT, NEVER A SECRET. The only transport is the local Ollama
 * endpoint (behind the local-only gate, like the local Leader), and the text
 * it gets is the block's `format=chat` text — already scrubbed — scrubbed once
 * more here and cut to its last FIX_INPUT_MAX_BYTES.
 */
import type { AshlrConfig } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import { ollamaLeaderTransport } from '../vision/leader-seat.js';
import { preferredLocalTags, resolveOllamaBaseUrl } from './seats.js';

/** What the model sees of the output: the tail (the error is at the end). */
export const FIX_INPUT_MAX_BYTES = 4 * 1024;
export const FIX_MAX_SUGGESTIONS = 3;
/** A suggestion is one shell line; longer is not a command worth a chip. */
export const FIX_COMMAND_MAX_CHARS = 300;
export const FIX_WHY_MAX_CHARS = 160;
/** The local call's wall clock: a chip that takes longer than this is no help. */
export const FIX_TIMEOUT_MS = 45_000;

export interface FixSuggestionInput {
  command: string;
  output: string;
  exitCode: number | null;
  cwd: string | null;
}

export interface FixSuggestion {
  command: string;
  why: string;
}

/** (system, user) → the model's raw text. Injected in tests. */
export type AssistComplete = (system: string, user: string) => Promise<string>;

/** The last `maxBytes` of `text` (UTF-8), starting at a line when one begins close by. */
export function tailBytes(text: string, maxBytes = FIX_INPUT_MAX_BYTES): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  // Skip a partial UTF-8 sequence at the cut (continuation bytes are 10xxxxxx).
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  let tail = buf.subarray(start).toString('utf8');
  const nl = tail.indexOf('\n');
  if (nl >= 0 && nl < 200) tail = tail.slice(nl + 1);
  return tail;
}

const SYSTEM_PROMPT = [
  'You help a developer whose shell command just failed.',
  'Reply with JSON only: {"suggestions":[{"command":"...","why":"..."}]}.',
  'Give at most 3 suggestions, best first. Each "command" is ONE line the developer could type next in the same shell',
  '(a corrected command, or the command that fixes the cause, such as installing a missing package).',
  'Each "why" is one short sentence. Never suggest destructive commands (rm -rf, git reset --hard, force pushes, sudo).',
  'If nothing sensible can be suggested, reply {"suggestions":[]}.',
].join(' ');

export function buildFixPrompt(input: FixSuggestionInput): { system: string; user: string } {
  const output = tailBytes(scrubSecrets(input.output));
  const lines = [
    `Command: ${scrubSecrets(input.command).slice(0, 1_000)}`,
    `Exit code: ${input.exitCode ?? 'unknown'}`,
    ...(input.cwd ? [`Directory: ${input.cwd}`] : []),
    'Output (last part):',
    output,
  ];
  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}

/**
 * Commands a chip must never offer, however the model phrased them: the
 * operator pastes a chip with one click, so the obviously destructive ones are
 * dropped rather than shown.
 */
const DESTRUCTIVE_RE = /(^|[\s;&|(])(sudo|rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|mkfs|dd\s+if=|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+push\s+.*--force|:\(\)\s*\{)/i;

function oneLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  return clean.length > max ? null : clean;
}

/** The model's text → at most three safe, single-line, distinct suggestions. Fails closed to []. */
export function parseFixSuggestions(raw: string, failedCommand = ''): FixSuggestion[] {
  let parsed: unknown;
  const text = raw.trim();
  try {
    parsed = JSON.parse(text);
  } catch {
    // A model that wrapped its JSON in prose or a fence: take the outermost object.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  const list = parsed !== null && typeof parsed === 'object' ? (parsed as { suggestions?: unknown }).suggestions : null;
  if (!Array.isArray(list)) return [];
  const out: FixSuggestion[] = [];
  const seen = new Set<string>();
  const failed = failedCommand.trim();
  for (const item of list) {
    if (out.length >= FIX_MAX_SUGGESTIONS) break;
    if (item === null || typeof item !== 'object') continue;
    const command = oneLine((item as { command?: unknown }).command, FIX_COMMAND_MAX_CHARS);
    if (!command || DESTRUCTIVE_RE.test(command)) continue;
    // Re-running exactly what failed is not a fix.
    if (command === failed || seen.has(command)) continue;
    seen.add(command);
    const why = oneLine((item as { why?: unknown }).why, 10_000);
    out.push({ command: scrubSecrets(command), why: why ? (why.length > FIX_WHY_MAX_CHARS ? `${why.slice(0, FIX_WHY_MAX_CHARS - 1)}…` : why) : '' });
  }
  return out;
}

export async function suggestFixCommands(input: FixSuggestionInput, complete: AssistComplete): Promise<FixSuggestion[]> {
  const { system, user } = buildFixPrompt(input);
  const raw = await complete(system, user);
  return parseFixSuggestions(raw, input.command);
}

/** The local model the chips use: the operator's local coder tag, over Ollama, local-only gated. */
export function localAssistComplete(cfg: AshlrConfig): { complete: AssistComplete; model: string } {
  const model = preferredLocalTags(cfg)[0]!;
  const complete = ollamaLeaderTransport(resolveOllamaBaseUrl(cfg), model, cfg, FIX_TIMEOUT_MS, { maxOutputTokens: 400, contextTokens: 4_096 });
  return { complete, model };
}
