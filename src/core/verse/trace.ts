/**
 * core/verse/trace.ts — one typed schema for "what the agent thought, did,
 * and drew on", whichever seat ran the turn (V3.15, additive).
 *
 * Every adapter already lowers its CLI's stream into the persisted VerseEvent
 * log (`thinking`, `tool-use`, `tool-result`, …). What each consumer then had
 * to re-derive on its own — which tool calls READ something, which URL a
 * fetch hit, what a turn amounted to, whether a seat's silence about its
 * reasoning is a choice or an absence — lives here, as pure functions:
 *
 *   - `VerseTraceEvent`       the normalized shape: `thinking`, `tool-call`,
 *                             `tool-result`, `source`, `summary`;
 *   - `normalizeVerseEvents`  VerseEvent[] → VerseTraceEvent[] (read side);
 *   - `lowerTraceEvent`       VerseTraceEvent → persisted VerseEvent shapes
 *                             (write side). A new adapter — the Devin chat
 *                             seat — can emit the normalized schema and let
 *                             this turn it into the events every existing
 *                             client already renders;
 *   - `sourcesFromToolCall`   the files / pages / searches one call proves the
 *                             agent saw, with the exact line range when the
 *                             payload or its output says so;
 *   - `collateSources`        numbered, de-duplicated citations;
 *   - `describeTurnWork`      the one-line "what it did" for a turn;
 *   - `reasoningPolicyFor`    an honest label for a seat that keeps its
 *                             reasoning to itself.
 *
 * DERIVED, NOT STORED. A source that a tool call proves is recomputed from the
 * call on every read, so it can never disagree with the call it came from;
 * only sources NO call shows (injected context, a remote seat's report) are
 * persisted as a `source` event. Same for summaries: a summary is a function
 * of the turn's events, so it is never written to the log.
 *
 * BROWSER-SAFE: type-only imports, no node:*. The web transcript and the
 * server share every classification below, so a Read is a read on both sides.
 *
 * Honesty rule (DESIGN §6, VERSE-TELEMETRY-V2): unknown is absent, never 0.
 */
import type { VerseEvent, VerseSource, VerseSourceKind, VerseThinkingKind } from './types.js';

// ---------------------------------------------------------------------------
// Tool classification (shared with web-ui chat/tool-semantics.ts)
// ---------------------------------------------------------------------------

export type VerseToolAction =
  | 'read'
  | 'edit'
  | 'create'
  | 'delete'
  | 'command'
  | 'search'
  | 'task'
  | 'web'
  | 'other';

/** Bare tool names (lower-case, transport prefix removed) → what the call does. */
export const VERSE_TOOL_ACTION_BY_NAME: ReadonlyMap<string, VerseToolAction> = new Map<string, VerseToolAction>([
  ['read', 'read'], ['readfile', 'read'], ['read_file', 'read'], ['view', 'read'],
  ['notebookread', 'read'], ['notebook_read', 'read'], ['cat', 'read'], ['open', 'read'],
  ['read_many_files', 'read'], ['view_file', 'read'],
  ['edit', 'edit'], ['multiedit', 'edit'], ['multi_edit', 'edit'], ['notebookedit', 'edit'],
  ['notebook_edit', 'edit'], ['str_replace', 'edit'], ['str_replace_editor', 'edit'],
  ['str_replace_based_edit_tool', 'edit'], ['apply_patch', 'edit'], ['patch', 'edit'],
  ['edit_structural', 'edit'], ['search_replace_regex', 'edit'], ['rename_file', 'edit'],
  ['update', 'edit'], ['applydiff', 'edit'], ['apply_diff', 'edit'], ['file_change', 'edit'],
  ['write', 'create'], ['create', 'create'], ['create_file', 'create'], ['writefile', 'create'],
  ['write_file', 'create'], ['new_file', 'create'],
  ['delete', 'delete'], ['delete_file', 'delete'], ['remove_file', 'delete'], ['rm', 'delete'],
  ['bash', 'command'], ['shell', 'command'], ['exec', 'command'], ['run', 'command'],
  ['run_command', 'command'], ['runcommand', 'command'], ['run_terminal_cmd', 'command'],
  ['bash_start', 'command'], ['bash_tail', 'command'], ['terminal', 'command'], ['test', 'command'],
  ['command_execution', 'command'], ['exec_command', 'command'], ['run_shell_command', 'command'],
  ['grep', 'search'], ['glob', 'search'], ['search', 'search'], ['find', 'search'],
  ['codebase_search', 'search'], ['ls', 'search'], ['tree', 'search'], ['list_dir', 'search'],
  ['task', 'task'], ['agent', 'task'], ['dispatch_agent', 'task'], ['subagent', 'task'],
  ['webfetch', 'web'], ['web_fetch', 'web'], ['fetch', 'web'], ['fetch_url', 'web'], ['http', 'web'],
  ['browser', 'web'], ['navigate', 'web'], ['open_page', 'web'], ['read_url', 'web'], ['browse', 'web'],
  ['websearch', 'web'], ['web_search', 'web'], ['search_web', 'web'], ['google_search', 'web'],
  ['brave_search', 'web'], ['bing_search', 'web'], ['tavily_search', 'web'], ['exa_search', 'web'],
  ['search_query', 'web'],
]);

/** Web tools whose INPUT is a query, not an address. */
const WEB_SEARCH_NAMES: ReadonlySet<string> = new Set([
  'websearch', 'web_search', 'search_web', 'google_search', 'brave_search', 'bing_search',
  'tavily_search', 'exa_search', 'search_query',
]);

/**
 * Strip transport prefixes so an MCP-routed call reads as the call it is:
 * `mcp__plugin_ashlr_ashlr__ashlr__edit` → `edit`, codex `mcp:ashlr.read` → `read`.
 */
export function baseToolName(name: string): string {
  let bare = name.trim();
  if (/^mcp:/i.test(bare)) {
    const dot = bare.lastIndexOf('.');
    bare = dot >= 0 ? bare.slice(dot + 1) : bare.slice(4);
  }
  const parts = bare.split('__').filter(Boolean);
  return (parts[parts.length - 1] ?? bare).trim().toLowerCase();
}

export function toolActionForName(name: string): VerseToolAction {
  return VERSE_TOOL_ACTION_BY_NAME.get(baseToolName(name)) ?? 'other';
}

/** True for a web tool whose argument is a query (the search itself is the source). */
export function isWebSearchTool(name: string): boolean {
  return WEB_SEARCH_NAMES.has(baseToolName(name));
}

// ---------------------------------------------------------------------------
// Payload readers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function posInt(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 100_000_000 ? n : null;
}

const PATH_KEYS = [
  'file_path', 'filePath', 'notebook_path', 'notebookPath', 'target_file',
  'path', 'file', 'filename', 'fileName', 'relative_workspace_path', 'absolute_path',
];

/**
 * Every path-ish string in a tool payload, first-seen order, de-duplicated —
 * including list forms (`paths`, `files`) and codex `file_change`'s
 * `changes: [{path, kind}]`.
 */
export function toolInputPaths(input: unknown): string[] {
  const rec = record(input);
  if (!rec) return [];
  const out: string[] = [];
  const push = (value: unknown) => {
    const s = str(value);
    if (s && !s.includes('\0') && !out.includes(s)) out.push(s);
  };
  for (const key of PATH_KEYS) push(rec[key]);
  for (const key of ['paths', 'file_paths', 'files', 'changes']) {
    const list = rec[key];
    if (Array.isArray(list)) for (const item of list) push(typeof item === 'string' ? item : record(item)?.['path']);
  }
  return out;
}

/** `src/web-ui/App.tsx` → `App.tsx`. */
export function pathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** How many sources one call may contribute (a search page lists many links). */
export const MAX_SOURCES_PER_CALL = 12;
const MAX_TITLE_CHARS = 160;
const MAX_URL_CHARS = 2048;
/** Output is only ever scanned at its head/tail — a build log must not cost a regex over megabytes. */
const OUTPUT_SCAN_CHARS = 16_384;

export const VERSE_SOURCE_KINDS: readonly VerseSourceKind[] = ['file', 'url', 'search', 'doc', 'memory', 'knowledge'];

function cleanTitle(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS - 1)}…` : flat;
}

/**
 * What kind of file-ish source a path is. Shared memory lives under
 * `~/.ashlr/verse/memory/` (project-memory.ts); approved knowledge and retros
 * under `~/.ashlr/learn/` (#535); the private repo wiki under
 * `~/.ashlr/knowledge/wiki/` (#537). Repository prose (`*.md`, `docs/`) is
 * documentation; everything else is a file.
 */
export function classifyPath(path: string): Extract<VerseSourceKind, 'file' | 'doc' | 'memory' | 'knowledge'> {
  const p = path.replace(/\\/g, '/');
  if (/\/\.ashlr\/verse\/memory\//.test(p) || /\/\.claude\/projects\/[^/]+\/memory\//.test(p) || /(^|\/)MEMORY\.md$/.test(p)) return 'memory';
  if (/\/\.ashlr\/knowledge\/wiki\//.test(p)) return 'doc';
  if (/\/\.ashlr\/(?:learn|knowledge)\//.test(p)) return 'knowledge';
  if (/\.(?:md|mdx|markdown|rst|adoc)$/i.test(p) || /(^|\/)docs?\//i.test(p)) return 'doc';
  return 'file';
}

/** A normalized http(s) URL (no fragment, no trailing slash on the path) and its bare domain, or null. */
export function normalizeUrl(raw: string): { url: string; domain: string } | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_URL_CHARS || !/^https?:\/\//i.test(text)) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // Credentials in a URL are a secret, not a citation.
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  let url = parsed.toString();
  if (parsed.pathname !== '/' && url.endsWith('/') && !parsed.search) url = url.slice(0, -1);
  if (parsed.pathname === '/' && !parsed.search) url = url.replace(/\/$/, '');
  return { url, domain: parsed.hostname.replace(/^www\./i, '').toLowerCase() };
}

function urlSource(raw: string, title: string | null, toolUseId: string | undefined): VerseSource | null {
  const norm = normalizeUrl(raw);
  if (!norm) return null;
  let fallback = norm.domain;
  try {
    const path = new URL(norm.url).pathname;
    if (path && path !== '/') fallback = `${norm.domain}${path.length > 60 ? `${path.slice(0, 59)}…` : path}`;
  } catch { /* normalizeUrl already parsed it */ }
  const source: VerseSource = {
    kind: 'url',
    ref: norm.url,
    title: cleanTitle(title && title.trim() ? title : fallback),
    origin: 'tool',
    url: norm.url,
    domain: norm.domain,
  };
  if (toolUseId) source.toolUseId = toolUseId;
  return source;
}

function fileSource(path: string, range: LineRange | null, toolUseId: string | undefined): VerseSource {
  const source: VerseSource = { kind: classifyPath(path), ref: path, title: pathBasename(path), origin: 'tool', path };
  if (range) {
    source.lineStart = range.start;
    if (range.end !== null) source.lineEnd = range.end;
  }
  if (toolUseId) source.toolUseId = toolUseId;
  return source;
}

interface LineRange { start: number; end: number | null }

/** A line range the INPUT names (Read offset/limit, view_range, start/end lines). */
function inputRange(rec: Record<string, unknown>): LineRange | null {
  const view = rec['view_range'];
  if (Array.isArray(view) && view.length === 2) {
    const a = posInt(view[0]);
    const b = typeof view[1] === 'number' && view[1] === -1 ? null : posInt(view[1]);
    if (a !== null) return { start: a, end: b !== null && b >= a ? b : null };
  }
  const start = posInt(rec['start_line']) ?? posInt(rec['startLine']) ?? posInt(rec['line_start']) ?? posInt(rec['offset'])
    ?? posInt(rec['start']) ?? posInt(rec['line']);
  const end = posInt(rec['end_line']) ?? posInt(rec['endLine']) ?? posInt(rec['line_end']) ?? posInt(rec['end']);
  const limit = posInt(rec['limit']);
  if (start === null && limit === null) return null;
  const from = start ?? 1;
  if (end !== null && end >= from) return { start: from, end };
  if (limit !== null) return { start: from, end: from + limit - 1 };
  return { start: from, end: null };
}

/**
 * The range a READ's OUTPUT proves, from the line numbers the tool printed
 * (`   12→text` — Claude Code's Read; `12\ttext` — cat -n / nl). Only the head
 * and tail are looked at.
 */
function outputRange(output: string): LineRange | null {
  const head = output.slice(0, 400);
  const first = /^\s*(\d{1,7})(?:→|\t)/.exec(head);
  if (!first) return null;
  const tail = output.length > 800 ? output.slice(-800) : output;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^\s*(\d{1,7})(?:→|\t)/.exec(lines[i]!);
    if (m) {
      const start = Number(first[1]);
      const end = Number(m[1]);
      return end >= start && start > 0 ? { start, end } : null;
    }
  }
  return null;
}

// ---- shell reads (codex reads files with sed/cat/nl, not a Read tool) ------

/** `bash -lc '<inner>'` / `['bash','-lc','<inner>']` → `<inner>`; anything else unchanged. */
function unwrapShell(command: unknown): string | null {
  if (Array.isArray(command)) {
    const argv = command.filter((a): a is string => typeof a === 'string');
    const flag = argv.findIndex((a) => /^-l?c$/.test(a) || a === '-lc');
    if (flag >= 1 && argv[flag + 1] !== undefined) return argv[flag + 1]!;
    return argv.join(' ') || null;
  }
  const text = str(command);
  if (!text) return null;
  const wrapped = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(text);
  if (!wrapped) return text;
  const inner = wrapped[2]!;
  return wrapped[1] === "'" ? inner.replace(/'\\''/g, "'") : inner.replace(/\\"/g, '"');
}

/** Minimal shell word splitter: quotes and backslashes, nothing else. */
function shellWords(segment: string): string[] {
  const out: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < segment.length) word += segment[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < segment.length) { word += segment[++i]; has = true; continue; }
    if (/\s/.test(c)) {
      if (has || word) out.push(word);
      word = '';
      has = false;
      continue;
    }
    word += c;
    has = true;
  }
  if (has || word) out.push(word);
  return out;
}

const READ_COMMANDS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'bat', 'less', 'more', 'batcat']);
const NOT_A_FILE = /[*?$`<>|;&(){}]|^\/dev\//;

/** `sed -n '12,40p'` → 12..40; `sed -n 12p` → 12..12. */
function sedRange(script: string): LineRange | null {
  const m = /^\s*(\d+)\s*(?:,\s*(\d+|\$)\s*)?p\s*$/.exec(script);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : m[2] === '$' ? null : Number(m[2]);
  return start > 0 && (end === null || end >= start) ? { start, end } : null;
}

/**
 * The files a shell command line READS, with the line range when `sed -n`
 * / `head -n` says so. Deliberately narrow: only the viewing commands above,
 * only literal path arguments. `grep`/`rg` searched; they did not read.
 */
export function shellReads(command: unknown): Array<{ path: string; range: LineRange | null }> {
  const inner = unwrapShell(command);
  if (!inner || inner.length > 4000) return [];
  const out: Array<{ path: string; range: LineRange | null }> = [];
  // `&&` / `;` / newline separate commands; `|` feeds the next one (nl … | sed -n 'a,bp').
  for (const chain of inner.split(/&&|\|\||;|\n/).slice(0, 20)) {
    const stages = chain.split('|').map((s) => shellWords(s.trim())).filter((w) => w.length > 0);
    let pending: Array<{ path: string; range: LineRange | null }> = [];
    for (const words of stages) {
      const cmd = pathBasename(words[0]!);
      if (!READ_COMMANDS.has(cmd)) {
        pending = [];
        continue;
      }
      const args = words.slice(1);
      let range: LineRange | null = null;
      const files: string[] = [];
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]!;
        // `> out` / `2>&1` / `>> log`: what follows is written, not read.
        if (/^\d*>/.test(arg)) break;
        if (cmd === 'sed') {
          if (arg === '-n') continue;
          if (arg === '-e' && args[i + 1] !== undefined) { range = sedRange(args[++i]!) ?? range; continue; }
          const r = sedRange(arg);
          if (r) { range = r; continue; }
        }
        if ((cmd === 'head' || cmd === 'tail') && (arg === '-n' || arg === '-c')) {
          const n = posInt(args[++i]);
          if (cmd === 'head' && arg === '-n' && n !== null) range = { start: 1, end: n };
          continue;
        }
        if (cmd === 'head' && /^-\d+$/.test(arg)) { range = { start: 1, end: Number(arg.slice(1)) }; continue; }
        if (arg.startsWith('-')) continue;
        if (cmd === 'sed' && files.length === 0 && range === null && /^[\d,$]*[a-z]/i.test(arg) && !arg.includes('/')) continue;
        if (!NOT_A_FILE.test(arg) && arg.length < 1024) files.push(arg);
      }
      if (files.length === 0 && pending.length > 0 && range) {
        // `nl -ba f | sed -n '10,40p'` — the range belongs to the piped file.
        for (const entry of pending) entry.range = range;
        continue;
      }
      pending = files.map((path) => ({ path, range }));
      out.push(...pending);
    }
  }
  const seen = new Set<string>();
  return out.filter((entry) => (seen.has(entry.path) ? false : (seen.add(entry.path), true))).slice(0, MAX_SOURCES_PER_CALL);
}

// ---- web ------------------------------------------------------------------

/** Claude Code's WebSearch result: `Links: [{"title":…,"url":…}, …]`. */
function searchResultLinks(output: string): Array<{ title: string | null; url: string }> {
  const head = output.slice(0, OUTPUT_SCAN_CHARS);
  const links: Array<{ title: string | null; url: string }> = [];
  const block = /Links:\s*(\[[\s\S]*?\])\s*(?:\n|$)/.exec(head);
  if (block) {
    try {
      const parsed: unknown = JSON.parse(block[1]!);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const rec = record(item);
          const url = str(rec?.['url']);
          if (url) links.push({ title: str(rec?.['title']), url });
        }
      }
    } catch { /* not JSON after all — fall through to markdown links */ }
  }
  if (links.length === 0) {
    const md = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;
    for (let m = md.exec(head); m && links.length < MAX_SOURCES_PER_CALL; m = md.exec(head)) links.push({ title: m[1]!, url: m[2]! });
  }
  return links;
}

/** A fetched page's title: a leading `# Heading` or `Title: …` line in its output. */
function pageTitle(output: string): string | null {
  const head = output.slice(0, 2000);
  const m = /^(?:#\s+(.+)|Title:\s*(.+))$/m.exec(head);
  const title = m ? (m[1] ?? m[2] ?? '').trim() : '';
  return title.length > 0 ? title : null;
}

const URL_KEYS = ['url', 'uri', 'href', 'link', 'page_url'];

export interface ToolCallForSources {
  name: string;
  input: unknown;
  /** Null while the call is still running. */
  output: string | null;
  isError: boolean;
  toolUseId?: string;
}

/**
 * The sources ONE tool call proves the agent saw. A failed or unfinished
 * call proves nothing (a Read that errored read nothing), so it yields none.
 * Pure and bounded: at most MAX_SOURCES_PER_CALL entries, output scanned at
 * its head and tail only.
 */
export function sourcesFromToolCall(call: ToolCallForSources): VerseSource[] {
  if (call.output === null || call.isError) return [];
  const action = toolActionForName(call.name);
  const rec = record(call.input);
  const id = call.toolUseId;
  const out: VerseSource[] = [];

  if (action === 'read') {
    const range = (rec ? inputRange(rec) : null) ?? outputRange(call.output);
    for (const path of toolInputPaths(call.input)) out.push(fileSource(path, range, id));
    return out.slice(0, MAX_SOURCES_PER_CALL);
  }

  if (action === 'web' || (action === 'other' && rec && URL_KEYS.some((k) => str(rec[k])?.startsWith('http')))) {
    const query = rec ? str(rec['query']) ?? str(rec['q']) ?? str(rec['search_query']) : null;
    if (isWebSearchTool(call.name) || (query && !URL_KEYS.some((k) => rec?.[k]))) {
      if (query) {
        const source: VerseSource = { kind: 'search', ref: `search:${query.trim().toLowerCase()}`, title: cleanTitle(query), origin: 'tool', query: query.trim() };
        if (id) source.toolUseId = id;
        out.push(source);
      }
      for (const link of searchResultLinks(call.output)) {
        const source = urlSource(link.url, link.title, id);
        if (source) out.push(source);
        if (out.length >= MAX_SOURCES_PER_CALL) break;
      }
    }
    if (rec) {
      for (const key of URL_KEYS) {
        const raw = str(rec[key]);
        if (!raw) continue;
        const source = urlSource(raw, pageTitle(call.output), id);
        if (source) out.push(source);
        break;
      }
    }
    return out.slice(0, MAX_SOURCES_PER_CALL);
  }

  if (action === 'command' && rec) {
    const command = rec['command'] ?? rec['cmd'] ?? rec['script'] ?? rec['commandLine'];
    for (const read of shellReads(command)) out.push(fileSource(read.path, read.range, id));
    return out;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

export interface VerseCitation {
  /** 1-based citation number, in order of first use. */
  n: number;
  /** The first sighting's source (title/kind/url), ranges merged below. */
  source: VerseSource;
  /** Merged, sorted line ranges seen; empty = the whole file (or not a file). */
  ranges: Array<{ start: number; end: number | null }>;
  /** Every tool call that produced it, first first. */
  toolUseIds: string[];
  /** How many sightings were folded into this citation. */
  count: number;
}

/** Union of line ranges; an open-ended range (`end: null`) swallows everything after its start. */
export function mergeRanges(ranges: ReadonlyArray<{ start: number; end: number | null }>): Array<{ start: number; end: number | null }> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number | null }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && (last.end === null || r.start <= last.end + 1)) {
      last.end = last.end === null || r.end === null ? null : Math.max(last.end, r.end);
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/**
 * De-duplicate by `ref` and number in order of first use. A file read whole
 * anywhere is cited whole (no ranges); otherwise its ranges are merged.
 */
export function collateSources(sources: readonly VerseSource[]): VerseCitation[] {
  const byRef = new Map<string, VerseCitation & { whole: boolean; raw: Array<{ start: number; end: number | null }> }>();
  for (const source of sources) {
    let entry = byRef.get(source.ref);
    if (!entry) {
      entry = { n: byRef.size + 1, source, ranges: [], toolUseIds: [], count: 0, whole: false, raw: [] };
      byRef.set(source.ref, entry);
    }
    entry.count += 1;
    if (source.toolUseId && !entry.toolUseIds.includes(source.toolUseId)) entry.toolUseIds.push(source.toolUseId);
    if (source.lineStart !== undefined) entry.raw.push({ start: source.lineStart, end: source.lineEnd ?? null });
    else if (source.kind !== 'url' && source.kind !== 'search') entry.whole = true;
  }
  return [...byRef.values()].map(({ whole, raw, ...citation }) => ({
    ...citation,
    ranges: whole ? [] : mergeRanges(raw),
  }));
}

/** `12-40, 88` — how a citation's ranges read after a path. */
export function formatRanges(ranges: ReadonlyArray<{ start: number; end: number | null }>): string {
  return ranges.map((r) => (r.end === null ? `${r.start}+` : r.end === r.start ? `${r.start}` : `${r.start}-${r.end}`)).join(', ');
}

// ---------------------------------------------------------------------------
// Turn summary
// ---------------------------------------------------------------------------

export interface VerseTurnStats {
  /** Distinct files by strongest action. */
  filesRead: number;
  filesEdited: number;
  filesCreated: number;
  filesDeleted: number;
  /** Diff line totals; absent when no call carried a diff. */
  additions?: number;
  deletions?: number;
  commands: number;
  commandsFailed: number;
  codeSearches: number;
  webLookups: number;
  subagents: number;
  otherTools: number;
  /** Failing tool calls of any kind. */
  failed: number;
  sources: number;
  /** Reasoning blocks shown (text) and hidden (redacted markers). */
  thoughts: number;
  hiddenThoughts: number;
}

export function emptyTurnStats(): VerseTurnStats {
  return {
    filesRead: 0, filesEdited: 0, filesCreated: 0, filesDeleted: 0,
    commands: 0, commandsFailed: 0, codeSearches: 0, webLookups: 0, subagents: 0, otherTools: 0,
    failed: 0, sources: 0, thoughts: 0, hiddenThoughts: 0,
  };
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one line a settled turn is summarized by — "Read 8 files · edited 3
 * files (+42 −7) · ran 4 commands (1 failed) · 2 web lookups". Built only
 * from counts; empty when the turn did no tool work (a plain answer needs no
 * summary line). Sources are listed under the answer, so they are not
 * repeated here.
 */
export function describeTurnWork(stats: VerseTurnStats, separator = ' · '): string {
  const parts: string[] = [];
  if (stats.filesRead > 0) parts.push(`read ${count(stats.filesRead, 'file', 'files')}`);
  const changed: string[] = [];
  if (stats.filesEdited > 0) changed.push(`edited ${count(stats.filesEdited, 'file', 'files')}`);
  if (stats.filesCreated > 0) changed.push(`created ${count(stats.filesCreated, 'file', 'files')}`);
  if (stats.filesDeleted > 0) changed.push(`deleted ${count(stats.filesDeleted, 'file', 'files')}`);
  if (changed.length > 0) {
    const delta = (stats.additions ?? 0) > 0 || (stats.deletions ?? 0) > 0
      ? ` (+${stats.additions ?? 0} −${stats.deletions ?? 0})`
      : '';
    changed[changed.length - 1] += delta;
    parts.push(...changed);
  }
  if (stats.commands > 0) {
    parts.push(`ran ${count(stats.commands, 'command', 'commands')}${stats.commandsFailed > 0 ? ` (${stats.commandsFailed} failed)` : ''}`);
  }
  if (stats.codeSearches > 0) parts.push(`searched the code ${stats.codeSearches === 1 ? 'once' : `${stats.codeSearches}×`}`);
  if (stats.webLookups > 0) parts.push(count(stats.webLookups, 'web lookup', 'web lookups'));
  if (stats.subagents > 0) parts.push(`ran ${count(stats.subagents, 'subagent', 'subagents')}`);
  if (stats.otherTools > 0) parts.push(`used ${count(stats.otherTools, 'other tool', 'other tools')}`);
  const nonCommandFailures = stats.failed - stats.commandsFailed;
  if (nonCommandFailures > 0) parts.push(`${nonCommandFailures} failed call${nonCommandFailures === 1 ? '' : 's'}`);
  const line = parts.join(separator);
  return line.length > 0 ? `${line[0]!.toUpperCase()}${line.slice(1)}` : '';
}

// ---------------------------------------------------------------------------
// Reasoning visibility
// ---------------------------------------------------------------------------

/**
 * What a seat shows of its reasoning.
 *  - `raw`     the model's own chain of thought (local models);
 *  - `summary` a provider-written summary (Claude 4+, hosted Codex models);
 *  - `hidden`  the provider keeps it to itself (Grok's CLI, remote agents);
 *  - `varies`  depends on the model behind the seat.
 */
export type VerseReasoningVisibility = 'raw' | 'summary' | 'hidden' | 'varies';

export interface VerseReasoningPolicy {
  visibility: VerseReasoningVisibility;
  /**
   * What to say under a SETTLED turn that carried no reasoning at all. Null
   * when silence is itself the truth: Claude marks a withheld think with a
   * redacted block, so no block means it did not think; a local model that
   * does not reason has nothing to show.
   */
  silentTurnNote: string | null;
}

export function reasoningPolicyFor(engine: string | null | undefined): VerseReasoningPolicy {
  switch (engine) {
    case 'claude':
      return { visibility: 'summary', silentTurnNote: null };
    case 'codex':
      return { visibility: 'summary', silentTurnNote: 'No reasoning summary was returned for this turn' };
    case 'grok':
      return { visibility: 'hidden', silentTurnNote: 'Reasoning not shared by this model' };
    case 'local':
      return { visibility: 'varies', silentTurnNote: null };
    default:
      // A seat this build does not know (the Devin chat seat, a future CLI):
      // say what is true — nothing was shared — without blaming a model.
      return { visibility: 'hidden', silentTurnNote: engine ? 'Reasoning not shared by this seat' : null };
  }
}

// ---------------------------------------------------------------------------
// The normalized schema
// ---------------------------------------------------------------------------

export type VerseTraceEvent =
  | {
    type: 'thinking';
    turnId: string;
    text: string;
    /** The seat thought but withheld the words. */
    redacted: boolean;
    durationMs: number | null;
    kind: VerseThinkingKind | null;
  }
  | {
    type: 'tool-call';
    turnId: string;
    callId: string;
    /** The seat's own tool name, verbatim. */
    tool: string;
    action: VerseToolAction;
    input: unknown;
  }
  | { type: 'tool-result'; turnId: string; callId: string; output: string; isError: boolean }
  | { type: 'source'; turnId: string | null; source: VerseSource }
  | { type: 'summary'; turnId: string; text: string; stats: VerseTurnStats; ok: boolean; durationMs: number | null };

export type VerseTraceEventType = VerseTraceEvent['type'];

/** A VerseEvent before the engine stamps `seq`/`at` (mirrors adapters/index.ts, which is node-side). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type VerseUnstampedEvent = DistributiveOmit<VerseEvent, 'seq' | 'at'>;

/**
 * Normalized → the persisted events every client already renders (write side).
 * `source` persists only when no tool call proves it (origin `engine`/`agent`);
 * a `summary` is never persisted — it is re-derived from the turn's events.
 */
export function lowerTraceEvent(event: VerseTraceEvent): VerseUnstampedEvent[] {
  switch (event.type) {
    case 'thinking': {
      const out: Extract<VerseUnstampedEvent, { type: 'thinking' }> = { type: 'thinking', turnId: event.turnId, text: event.redacted ? '' : event.text };
      if (event.redacted) out.redacted = true;
      if (event.durationMs !== null && event.durationMs >= 0) out.durationMs = Math.round(event.durationMs);
      if (event.kind) out.kind = event.kind;
      return [out];
    }
    case 'tool-call':
      return [{ type: 'tool-use', turnId: event.turnId, toolUseId: event.callId, name: event.tool, input: event.input }];
    case 'tool-result':
      return [{ type: 'tool-result', turnId: event.turnId, toolUseId: event.callId, output: event.output, isError: event.isError }];
    case 'source':
      return event.source.origin === 'tool' ? [] : [{ type: 'source', turnId: event.turnId, source: event.source }];
    case 'summary':
      return [];
    default: {
      const never: never = event;
      return never;
    }
  }
}

interface TurnAccumulator {
  stats: VerseTurnStats;
  files: Map<string, VerseToolAction>;
  refs: Set<string>;
  calls: Map<string, { name: string; input: unknown }>;
}

const FILE_STRENGTH: Partial<Record<VerseToolAction, number>> = { read: 0, edit: 1, create: 2, delete: 3 };

function tallyFiles(acc: TurnAccumulator): void {
  const s = acc.stats;
  s.filesRead = 0; s.filesEdited = 0; s.filesCreated = 0; s.filesDeleted = 0;
  for (const action of acc.files.values()) {
    if (action === 'read') s.filesRead += 1;
    else if (action === 'edit') s.filesEdited += 1;
    else if (action === 'create') s.filesCreated += 1;
    else if (action === 'delete') s.filesDeleted += 1;
  }
}

/**
 * The persisted log, read as the normalized schema. Each `tool-result` is
 * followed by the sources its call proves, and each `turn-done` by that
 * turn's `summary`. Transient and bookkeeping events are skipped.
 */
export function normalizeVerseEvents(events: readonly VerseEvent[]): VerseTraceEvent[] {
  const out: VerseTraceEvent[] = [];
  const turns = new Map<string, TurnAccumulator>();
  const turnFor = (turnId: string): TurnAccumulator => {
    let acc = turns.get(turnId);
    if (!acc) {
      acc = { stats: emptyTurnStats(), files: new Map(), refs: new Set(), calls: new Map() };
      turns.set(turnId, acc);
    }
    return acc;
  };
  const addSource = (turnId: string | null, source: VerseSource) => {
    out.push({ type: 'source', turnId, source });
    if (turnId === null) return;
    const acc = turnFor(turnId);
    if (!acc.refs.has(source.ref)) {
      acc.refs.add(source.ref);
      acc.stats.sources += 1;
    }
  };

  for (const event of events) {
    switch (event.type) {
      case 'thinking': {
        const redacted = event.redacted === true || event.text.length === 0;
        out.push({
          type: 'thinking',
          turnId: event.turnId,
          text: event.text,
          redacted,
          durationMs: typeof event.durationMs === 'number' ? event.durationMs : null,
          kind: event.kind ?? null,
        });
        const acc = turnFor(event.turnId);
        if (redacted) acc.stats.hiddenThoughts += 1;
        else acc.stats.thoughts += 1;
        break;
      }
      case 'tool-use': {
        const action = toolActionForName(event.name);
        out.push({ type: 'tool-call', turnId: event.turnId, callId: event.toolUseId, tool: event.name, action, input: event.input });
        const acc = turnFor(event.turnId);
        acc.calls.set(event.toolUseId, { name: event.name, input: event.input });
        if (action === 'command') acc.stats.commands += 1;
        else if (action === 'search') acc.stats.codeSearches += 1;
        else if (action === 'web') acc.stats.webLookups += 1;
        else if (action === 'task') acc.stats.subagents += 1;
        else if (action === 'other') acc.stats.otherTools += 1;
        const strength = FILE_STRENGTH[action];
        if (strength !== undefined) {
          for (const path of toolInputPaths(event.input)) {
            const prev = acc.files.get(path);
            if (prev === undefined || strength > (FILE_STRENGTH[prev] ?? -1)) acc.files.set(path, action);
          }
          tallyFiles(acc);
        }
        break;
      }
      case 'tool-result': {
        out.push({ type: 'tool-result', turnId: event.turnId, callId: event.toolUseId, output: event.output, isError: event.isError });
        const acc = turnFor(event.turnId);
        const call = acc.calls.get(event.toolUseId);
        if (event.isError) {
          acc.stats.failed += 1;
          if (call && toolActionForName(call.name) === 'command') acc.stats.commandsFailed += 1;
        }
        if (call) {
          for (const source of sourcesFromToolCall({ name: call.name, input: call.input, output: event.output, isError: event.isError, toolUseId: event.toolUseId })) {
            addSource(event.turnId, source);
          }
        }
        break;
      }
      case 'source':
        addSource(event.turnId, event.source);
        break;
      case 'turn-done': {
        const acc = turnFor(event.turnId);
        out.push({
          type: 'summary',
          turnId: event.turnId,
          text: describeTurnWork(acc.stats),
          stats: { ...acc.stats },
          ok: event.ok,
          durationMs: event.durationMs > 0 ? event.durationMs : null,
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wire validation (shared by the session store and the web SSE reader)
// ---------------------------------------------------------------------------

const SOURCE_KIND_SET: ReadonlySet<string> = new Set(VERSE_SOURCE_KINDS);
const ORIGINS: ReadonlySet<string> = new Set(['tool', 'engine', 'agent']);

const optionalString = (v: unknown, max: number): boolean => v === undefined || (typeof v === 'string' && v.length <= max);
const optionalLine = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v > 0);

/** A `source` payload is well-formed. Malformed lines are dropped, never drawn. */
export function isVerseSource(value: unknown): value is VerseSource {
  const rec = record(value);
  if (!rec) return false;
  return typeof rec['kind'] === 'string' && SOURCE_KIND_SET.has(rec['kind'])
    && typeof rec['ref'] === 'string' && rec['ref'].length > 0 && rec['ref'].length <= 4096
    && typeof rec['title'] === 'string' && rec['title'].length <= 1024
    && typeof rec['origin'] === 'string' && ORIGINS.has(rec['origin'])
    && optionalString(rec['path'], 4096) && optionalString(rec['url'], MAX_URL_CHARS)
    && optionalString(rec['domain'], 255) && optionalString(rec['query'], 2048)
    && optionalString(rec['toolUseId'], 256) && optionalString(rec['detail'], 1024)
    && optionalLine(rec['lineStart']) && optionalLine(rec['lineEnd']);
}
