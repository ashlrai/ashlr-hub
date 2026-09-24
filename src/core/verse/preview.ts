/**
 * core/verse/preview.ts — what the Preview pane can show (V3.10, unit C4).
 *
 *   1. DEV SERVERS for a chat's roots, from three sources:
 *        - `.claude/launch.json` configurations (the same file Claude's own
 *          preview reads: name, runtimeExecutable, runtimeArgs, port, url);
 *        - `package.json` scripts whose tool has a known port (vite 5173,
 *          next 3000, …) or states one (`--port 4000`, `PORT=4000`);
 *        - servers already LISTENING whose working directory is inside a root
 *          (lsof), so a server started in any terminal shows up too.
 *      Each says whether it is running. Start never happens here: the pane
 *      asks the dock for a terminal tab (terminal-api, `devServerId`), which
 *      types the command into the operator's own shell.
 *   2. ARTIFACTS — the html / md / svg / image / pdf files this chat wrote
 *      (from its tool-use events), and the file reads behind `preview/raw`.
 *   3. FRAME TICKETS — how a sandboxed <iframe> can load an artifact at all.
 *
 * WHY TICKETS. Every /api GET sits behind the read-session boundary, which
 * wants the HttpOnly cookie AND the per-tab client proof in a header
 * (server.ts). An <iframe src> cannot send a header, and the query-string
 * proof is reserved for EventSource paths. A `srcdoc` or `blob:` frame would
 * inherit the Verse page's own CSP (`script-src 'self'`), so an agent's
 * interactive HTML report could not run a line of its own script. So the page
 * (header-authenticated) mints a ticket for ONE file; the frame loads
 * `/api/verse/preview/frame/<ticket>`, which server.ts lets past the boundary
 * and this module redeems only when the request also carries the SAME read
 * session cookie the ticket was minted under (so a leaked URL alone is
 * worthless), within 5 minutes. The response is served with `CSP: sandbox
 * allow-scripts` — an opaque origin: it can run its own script but cannot
 * read Verse's cookies, storage or DOM.
 *
 * NEVER BLOCKS the event loop on a probe: lsof and port checks are async with
 * hard timeouts, cached for a few seconds and single-flight.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import { checkWorkspaceRootPath, expandHomePrefix, isUnderPath } from './path-guard.js';
import type { VerseEvent, VerseSession } from './types.js';
import {
  VERSE_PREVIEW_FRAME_PATH,
  VERSE_PREVIEW_FRAME_PATH_RE,
  VERSE_PREVIEW_RAW_MAX_BYTES,
  isLoopbackPreviewUrl,
  type VersePreviewArtifact,
  type VersePreviewArtifactKind,
  type VersePreviewDevServer,
} from './workbench-types.js';

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

/**
 * A chat's roots, primary first, each re-validated now (a root deleted or
 * turned into a symlink since the chat began is dropped). Physical paths.
 */
export function sessionRoots(session: Pick<VerseSession, 'projectPath' | 'extraRoots'>): string[] {
  const out: string[] = [];
  for (const raw of [session.projectPath, ...(session.extraRoots ?? [])]) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const checked = checkWorkspaceRootPath(raw);
    if (checked.ok && !out.includes(checked.path)) out.push(checked.path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dev servers
// ---------------------------------------------------------------------------

/** Internal record: the contract's row plus what Start needs. */
export interface DevServerRecord extends VersePreviewDevServer {
  /** Typed into a terminal tab on Start; '' for a server that is only observed listening. */
  command: string;
  /** Where Start runs it (the root, or a launch.json `cwd` inside it). */
  cwd: string;
}

export interface ListenerRow {
  pid: number;
  command: string;
  port: number;
  /** The process's working directory; null when lsof could not read it. */
  cwd: string | null;
}

/** POSIX single-quoting, only when needed (so `npm run dev` stays readable). */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;
}

function devServerId(source: string, root: string, name: string): string {
  return `dev-${createHash('sha256').update(`${source}\0${root}\0${name}`).digest('hex').slice(0, 12)}`;
}

function readJsonFile(path: string, maxBytes = 256 * 1024): unknown {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `.claude/launch.json` → dev servers (unreadable or odd entries are skipped, never fatal). */
export function readLaunchJson(root: string): DevServerRecord[] {
  const parsed = readJsonFile(join(root, '.claude', 'launch.json'));
  if (!isObject(parsed) || !Array.isArray(parsed['configurations'])) return [];
  const out: DevServerRecord[] = [];
  for (const cfg of parsed['configurations'].slice(0, 20)) {
    if (!isObject(cfg)) continue;
    const name = typeof cfg['name'] === 'string' ? cfg['name'].trim().slice(0, 80) : '';
    const exe = typeof cfg['runtimeExecutable'] === 'string' ? cfg['runtimeExecutable'] : '';
    const args = Array.isArray(cfg['runtimeArgs']) ? cfg['runtimeArgs'].filter((a): a is string => typeof a === 'string') : [];
    let url: string | null = null;
    let port: number | null = isPort(cfg['port']) ? cfg['port'] : null;
    if (typeof cfg['url'] === 'string' && isLoopbackPreviewUrl(cfg['url'])) {
      url = cfg['url'];
      if (port === null) {
        const fromUrl = Number(new URL(cfg['url']).port || 80);
        port = isPort(fromUrl) ? fromUrl : null;
      }
    }
    if (!name || port === null) continue;
    // A `cwd` may only narrow the root, never leave it.
    let cwd = root;
    if (typeof cfg['cwd'] === 'string' && cfg['cwd'].length > 0) {
      const candidate = resolvePath(root, cfg['cwd']);
      if (isUnderPath(candidate, root) && existsSync(candidate)) cwd = candidate;
    }
    out.push({
      id: devServerId('launch-json', root, name),
      label: name,
      url: url ?? `http://localhost:${port}/`,
      port,
      source: 'launch-json',
      running: false,
      root,
      command: exe ? shellJoin([exe, ...args]) : '',
      cwd,
    });
  }
  return out;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export function packageManagerFor(root: string): PackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

export function runScriptCommand(pm: PackageManager, script: string): string {
  const name = shellQuote(script);
  return pm === 'yarn' ? `yarn ${name}` : `${pm} run ${name}`;
}

/**
 * Default ports of the dev-server tools a script may call, first match wins
 * (so `vite preview` is tested before plain `vite`).
 */
const TOOL_PORTS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bvite\s+preview\b/, 4173],
  [/\bvitepress\s+(?:dev|preview)\b/, 5173],
  [/\bvite\b/, 5173],
  [/\bnext\s+(?:dev|start)\b/, 3000],
  [/\bastro(?:\s+(?:dev|preview))?(?:\s|$)/, 4321],
  [/\bstorybook\s+dev\b|\bstart-storybook\b/, 6006],
  [/\breact-scripts\s+start\b/, 3000],
  [/\bnuxi?\s+(?:dev|preview)\b/, 3000],
  [/\bgatsby\s+develop\b/, 8000],
  [/\bng\s+serve\b/, 4200],
  [/\bwebpack(?:-dev-server|\s+serve)\b/, 8080],
  [/\bparcel\b/, 1234],
  [/\bdocusaurus\s+start\b/, 3000],
  [/\bwrangler\s+(?:pages\s+)?dev\b/, 8787],
  [/\bhttp-server\b/, 8080],
  [/\blive-server\b/, 8080],
  [/\beleventy\b.*--serve\b/, 8080],
  [/\bhugo\s+server\b/, 1313],
  [/\bjekyll\s+serve\b/, 4000],
  [/(?:^|[\s;&|])(?:npx\s+)?serve(?:\s|$)/, 3000],
];

/** A port a vite config pins (`server: { port }` / `preview: { port }`), read as text — never executed. */
function vitePortFromConfig(root: string, command: string, block: 'server' | 'preview'): number | null {
  const explicit = /--config[=\s]+(\S+)/.exec(command)?.[1];
  const candidates = explicit
    ? [explicit.replace(/^['"]|['"]$/g, '')]
    : ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];
  for (const name of candidates) {
    const file = resolvePath(root, name);
    if (!isUnderPath(file, root)) continue;
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > 64 * 1024) continue;
      const text = readFileSync(file, 'utf8');
      const m = new RegExp(`\\b${block}\\s*:\\s*\\{[^}]*?\\bport\\s*:\\s*(\\d{2,5})`).exec(text);
      const port = m ? Number(m[1]) : null;
      if (isPort(port)) return port;
    } catch {
      /* unreadable config: fall back to the tool default */
    }
  }
  return null;
}

/**
 * The port a package.json script will serve on, or null when it cannot be
 * known (then the script is not offered — Start could not wait for it).
 *
 * A script counts as a server only when it runs a KNOWN dev-server tool, or
 * when it is NAMED like one (dev, start, serve, preview, storybook — also
 * `dev:web`) and states a port. A bare `-p 5432` in `"db": "docker run …"`
 * is a database, not a page to preview.
 */
export function inferScriptPort(command: string, root: string, scriptName = 'dev'): number | null {
  const explicitMatch = /(?:^|\s)--port(?:=|\s+)(\d{2,5})\b/.exec(command)
    ?? /(?:^|\s)-p(?:=|\s+)?(\d{2,5})\b/.exec(command)
    ?? /(?:^|\s)PORT=(\d{2,5})\b/.exec(command);
  const explicit = explicitMatch ? Number(explicitMatch[1]) : null;

  let toolPort: number | null = null;
  const http = /\bpython3?\s+-m\s+http\.server(?:\s+(\d{2,5}))?/.exec(command);
  if (http) {
    toolPort = http[1] ? Number(http[1]) : 8000;
  } else {
    for (const [re, port] of TOOL_PORTS) {
      if (!re.test(command)) continue;
      toolPort = port === 4173 || port === 5173
        ? vitePortFromConfig(root, command, port === 4173 ? 'preview' : 'server') ?? port
        : port;
      break;
    }
  }
  if (toolPort !== null) {
    const port = explicit ?? toolPort;
    return isPort(port) ? port : null;
  }
  const base = scriptName.split(':')[0] ?? scriptName;
  if (explicit !== null && SERVER_SCRIPT_ORDER.includes(base)) return isPort(explicit) ? explicit : null;
  return null;
}

/** Scripts people name as servers are listed first. */
const SERVER_SCRIPT_ORDER = ['dev', 'start', 'serve', 'preview', 'storybook'];

/** `package.json` scripts → dev servers (at most 8 per root). */
export function readPackageScripts(root: string): DevServerRecord[] {
  const parsed = readJsonFile(join(root, 'package.json'), 512 * 1024);
  if (!isObject(parsed) || !isObject(parsed['scripts'])) return [];
  const pm = packageManagerFor(root);
  const rows: Array<DevServerRecord & { rank: number }> = [];
  for (const [name, value] of Object.entries(parsed['scripts'])) {
    if (typeof value !== 'string' || name.length > 80 || value.length > 2_000) continue;
    const port = inferScriptPort(value, root, name);
    if (port === null) continue;
    const command = runScriptCommand(pm, name);
    const base = name.split(':')[0] ?? name;
    const rank = SERVER_SCRIPT_ORDER.includes(base) ? SERVER_SCRIPT_ORDER.indexOf(base) : SERVER_SCRIPT_ORDER.length;
    rows.push({
      id: devServerId('package-json', root, name),
      label: command,
      url: `http://localhost:${port}/`,
      port,
      source: 'package-json',
      running: false,
      root,
      command,
      cwd: root,
      rank,
    });
  }
  rows.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  return rows.slice(0, 8).map(({ rank: _rank, ...row }) => row);
}

/** Addresses a browser can reach as `localhost:<port>`. */
const LOOPBACK_OR_ANY = new Set(['*', '127.0.0.1', 'localhost', '[::1]', '[::]', '0.0.0.0', '::1', '::']);

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` (one field per line). Exported for tests. */
export function parseLsofListeners(stdout: string): Array<{ pid: number; command: string; port: number }> {
  const out: Array<{ pid: number; command: string; port: number }> = [];
  const seen = new Set<string>();
  let pid = 0;
  let command = '';
  for (const line of stdout.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') { pid = Number(value); command = ''; continue; }
    if (tag === 'c') { command = value; continue; }
    if (tag !== 'n' || !pid) continue;
    const colon = value.lastIndexOf(':');
    if (colon <= 0) continue;
    const host = value.slice(0, colon);
    const port = Number(value.slice(colon + 1));
    if (!isPort(port) || !LOOPBACK_OR_ANY.has(host)) continue;
    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid, command, port });
  }
  return out;
}

/** Parse `lsof -a -d cwd -Fpn -p …` → pid → cwd. Exported for tests. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid && isAbsolute(line.slice(1))) out.set(pid, line.slice(1));
  }
  return out;
}

function lsofPath(): string | null {
  for (const candidate of ['/usr/sbin/lsof', '/usr/bin/lsof']) if (existsSync(candidate)) return candidate;
  return null;
}

function runLsof(args: string[]): Promise<string | null> {
  const bin = lsofPath();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 2_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin', LC_ALL: 'C' } }, (error, stdout) => {
      // lsof exits 1 when a filter matched nothing: that is an empty answer, not a failure.
      const code = (error as { code?: unknown } | null)?.code;
      if (error && code !== 1) resolve(null);
      else resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

/** Listening TCP sockets of this user's processes, with their cwd. Null when lsof is unavailable. */
export async function listListenersWithLsof(): Promise<ListenerRow[] | null> {
  const listening = await runLsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  if (listening === null) return null;
  const rows = parseLsofListeners(listening).slice(0, 200);
  if (rows.length === 0) return [];
  const pids = [...new Set(rows.map((r) => r.pid))];
  const cwdOut = await runLsof(['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]);
  const cwds = cwdOut === null ? new Map<number, string>() : parseLsofCwds(cwdOut);
  return rows.map((r) => ({ ...r, cwd: cwds.get(r.pid) ?? null }));
}

/** True when something accepts a TCP connection on loopback `port` (IPv4 or IPv6). */
export function probeLoopbackPort(port: number, timeoutMs = 250): Promise<boolean> {
  const attempt = (host: string): Promise<boolean> => new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  return attempt('127.0.0.1').then((ok) => ok || attempt('::1'));
}

export interface DevServerDiscoveryDeps {
  /** Null = cannot list (then declared ports are probed instead). */
  listListeners?: () => Promise<ListenerRow[] | null>;
  probePort?: (port: number) => Promise<boolean>;
  now?: () => number;
}

const LISTENER_CACHE_MS = 3_000;
let listenerCache: { at: number; value: Promise<ListenerRow[] | null> } | null = null;

function cachedListeners(deps: DevServerDiscoveryDeps): Promise<ListenerRow[] | null> {
  if (deps.listListeners) return deps.listListeners().catch(() => null);
  const now = (deps.now ?? Date.now)();
  if (listenerCache && now - listenerCache.at < LISTENER_CACHE_MS) return listenerCache.value;
  const value = listListenersWithLsof().catch(() => null);
  listenerCache = { at: now, value };
  return value;
}

/** Test hygiene. */
export function resetPreviewCaches(): void {
  listenerCache = null;
  artifactCache.clear();
  frameTickets.clear();
}

/**
 * Every dev server for these roots, declared ones first (launch.json, then
 * package.json), then servers observed listening inside a root. `excludePorts`
 * holds the Verse server's own port — Verse must never offer to frame itself.
 */
export async function discoverDevServers(
  roots: readonly string[],
  opts: { excludePorts?: readonly number[]; deps?: DevServerDiscoveryDeps } = {},
): Promise<DevServerRecord[]> {
  const deps = opts.deps ?? {};
  const exclude = new Set(opts.excludePorts ?? []);
  const declared: DevServerRecord[] = [];
  const seenIds = new Set<string>();
  for (const root of roots) {
    for (const row of [...readLaunchJson(root), ...readPackageScripts(root)]) {
      if (exclude.has(row.port) || seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      declared.push(row);
    }
  }

  const listeners = await cachedListeners(deps);
  if (listeners === null) {
    // No listing: ask each declared port directly (bounded, in parallel).
    const probe = deps.probePort ?? probeLoopbackPort;
    const ports = [...new Set(declared.map((d) => d.port))].slice(0, 24);
    const up = new Map(await Promise.all(ports.map(async (p) => [p, await probe(p).catch(() => false)] as const)));
    return declared.map((d) => ({ ...d, running: up.get(d.port) === true }));
  }

  const listeningPorts = new Set(listeners.map((l) => l.port));
  const result = declared.map((d) => ({ ...d, running: listeningPorts.has(d.port) }));
  const declaredPorts = new Set(declared.map((d) => d.port));
  const observed = new Set<number>();
  for (const listener of listeners) {
    if (exclude.has(listener.port) || declaredPorts.has(listener.port) || observed.has(listener.port)) continue;
    const root = listener.cwd ? roots.find((r) => isUnderPath(listener.cwd!, r)) : undefined;
    if (!root) continue; // only servers started from inside this chat's roots
    observed.add(listener.port);
    const name = listener.command.slice(0, 40) || 'server';
    result.push({
      id: `port-${listener.port}`,
      label: `${name} :${listener.port}`,
      url: `http://localhost:${listener.port}/`,
      port: listener.port,
      source: 'listening',
      running: true,
      root,
      command: '',
      cwd: listener.cwd!,
    });
  }
  return result;
}

/** The contract row (no cwd) for the API. */
export function publicDevServer(row: DevServerRecord): VersePreviewDevServer {
  // `command` is what Start will type, shown on the row before the click; the
  // cwd stays server-side (Start re-resolves it from discovery, never the page).
  return {
    id: row.id, label: row.label, url: row.url, port: row.port, source: row.source, running: row.running, root: row.root,
    command: row.command.length > 0 ? row.command : null,
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

const KIND_BY_EXT: Readonly<Record<string, VersePreviewArtifactKind>> = {
  '.html': 'html',
  '.htm': 'html',
  '.md': 'md',
  '.markdown': 'md',
  '.svg': 'svg',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.bmp': 'image',
  '.ico': 'image',
  '.pdf': 'pdf',
};

const CONTENT_TYPE_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  // Markdown is rendered by the pane (sanitised); served as text so it never renders as HTML.
  '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

export function artifactKindOf(path: string): VersePreviewArtifactKind | null {
  return KIND_BY_EXT[extname(path).toLowerCase()] ?? null;
}

export function artifactContentType(path: string): string {
  return CONTENT_TYPE_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The CSP an artifact is served under. `sandbox allow-scripts` without
 * `allow-same-origin` gives the document an OPAQUE origin: its own inline
 * script runs (an agent's chart), but it can never reach Verse's cookies,
 * storage, DOM or API. `connect-src` stays closed; https assets (a CDN chart
 * library, a web font) load as they would if the file were opened in a
 * browser. Framable only by Verse itself.
 */
export const ARTIFACT_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * PDFs are the exception to `sandbox`: every browser's PDF viewer refuses to
 * run in a sandboxed document and shows a blocked page instead. A PDF is
 * rendered by the browser's own isolated viewer (PDF.js in its own context,
 * Chromium's out-of-process viewer, WebKit's PDFKit), never as a document
 * with access to this origin.
 */
export const PDF_CSP = "frame-ancestors 'self'";

/** Tool names whose input names a file the agent wrote (mirrors session-handoff.ts EDIT_TOOLS). */
const WRITE_TOOLS = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'write', 'write_file', 'search_replace', 'hashline_edit', 'edit_file', 'create_file',
]);
const PATH_KEYS = ['file_path', 'notebook_path', 'target_file', 'path', 'filePath', 'filename'] as const;

/** Paths a chat's tool calls wrote, oldest first, each at its LAST write. Exported for tests. */
export function collectWrittenPaths(events: readonly VerseEvent[]): string[] {
  const order = new Map<string, number>();
  let n = 0;
  const note = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 4096 || trimmed.includes('\0')) return;
    order.delete(trimmed);
    order.set(trimmed, n++);
  };
  for (const event of events) {
    if (event.type !== 'tool-use') continue;
    const input = event.input;
    if (!isObject(input)) continue;
    if (event.name === 'file_change' && Array.isArray(input['changes'])) {
      // Codex: { changes: [{ path, kind }] }; a deletion is not an artifact.
      for (const change of input['changes']) {
        if (isObject(change) && change['kind'] !== 'delete') note(change['path']);
      }
      continue;
    }
    if (!WRITE_TOOLS.has(event.name)) continue;
    for (const key of PATH_KEYS) {
      if (typeof input[key] === 'string') { note(input[key]); break; }
    }
  }
  return [...order.keys()];
}

export const PREVIEW_MAX_ARTIFACTS = 50;

/** Which root a (lexical) absolute path is under, and its relative path. */
function locate(abs: string, roots: readonly string[]): { root: string; rel: string } | null {
  for (const root of roots) {
    if (!isUnderPath(abs, root)) continue;
    const rel = relative(root, abs);
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) continue;
    return { root, rel: rel.split(sep).join('/') };
  }
  return null;
}

const artifactCache = new Map<string, { key: string; value: VersePreviewArtifact[] }>();

/**
 * The previewable files this chat wrote that still exist inside its roots,
 * newest first. Cached per session until the session changes (a chat's log
 * is parsed once per turn, not once per poll).
 */
export function listArtifacts(
  session: Pick<VerseSession, 'id' | 'projectPath' | 'extraRoots' | 'updatedAt' | 'turnCount'>,
  loadEvents: () => readonly VerseEvent[],
  roots: readonly string[] = sessionRoots(session),
): VersePreviewArtifact[] {
  const key = `${session.updatedAt}|${session.turnCount}|${roots.join('\0')}`;
  const cached = artifactCache.get(session.id);
  if (cached && cached.key === key) return cached.value;

  const written = collectWrittenPaths(loadEvents());
  const out: VersePreviewArtifact[] = [];
  const seen = new Set<string>();
  // Newest write first.
  for (let i = written.length - 1; i >= 0 && out.length < PREVIEW_MAX_ARTIFACTS; i--) {
    const raw = expandHomePrefix(written[i]!);
    const kind = artifactKindOf(raw);
    if (!kind) continue;
    const abs = isAbsolute(raw) ? resolvePath(raw) : resolvePath(session.projectPath, raw);
    const located = locate(abs, roots) ?? locate(physical(abs) ?? abs, roots);
    if (!located) continue;
    const resolved = resolveArtifactFile(roots, located.rel);
    if (!resolved.ok || seen.has(resolved.rel)) continue;
    seen.add(resolved.rel);
    out.push({ path: resolved.rel, kind, bytes: resolved.bytes });
  }
  if (artifactCache.size > 64) artifactCache.clear();
  artifactCache.set(session.id, { key, value: out });
  return out;
}

function physical(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

export type ResolvedArtifact =
  | { ok: true; abs: string; rel: string; root: string; kind: VersePreviewArtifactKind; bytes: number }
  | { ok: false; status: 400 | 404 | 413; error: string };

/**
 * Resolve a root-relative artifact path to a regular file INSIDE one of the
 * roots — physically, after symlinks, so a link pointing out of the root (at
 * ~/.ssh, at ~/.ashlr) is refused — of a previewable kind. Roots are tried
 * in order (primary first). Never reads the file.
 */
export function resolveArtifactFile(roots: readonly string[], relPath: string): ResolvedArtifact {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 4096 || relPath.includes('\0')) {
    return { ok: false, status: 400, error: 'path is required' };
  }
  const normalized = relPath.replace(/\\/g, '/');
  if (isAbsolute(normalized) || normalized.split('/').some((seg) => seg === '..')) {
    return { ok: false, status: 400, error: 'path must be relative to a chat root' };
  }
  const kind = artifactKindOf(normalized);
  if (!kind) return { ok: false, status: 400, error: 'only html, markdown, svg, image and pdf files can be previewed' };
  for (const root of roots) {
    const abs = resolvePath(root, normalized);
    if (!isUnderPath(abs, root)) continue;
    const real = physical(abs);
    const realRoot = physical(root) ?? root;
    if (!real || !isUnderPath(real, realRoot)) continue;
    let size: number;
    try {
      const st = statSync(real);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (size > VERSE_PREVIEW_RAW_MAX_BYTES) return { ok: false, status: 413, error: 'file is larger than 5 MB' };
    return { ok: true, abs: real, rel: normalized, root, kind, bytes: size };
  }
  return { ok: false, status: 404, error: 'file not found in this chat\'s roots' };
}

// ---------------------------------------------------------------------------
// Frame tickets
// ---------------------------------------------------------------------------

// The paths and the frame shape are contract (workbench-types.ts §6), so the
// server gate, this module and the docs cannot drift apart.
export { VERSE_PREVIEW_TICKET_PATH, VERSE_PREVIEW_FRAME_PATH_RE } from './workbench-types.js';
export const VERSE_PREVIEW_FRAME_PREFIX = `${VERSE_PREVIEW_FRAME_PATH}/`;
export const FRAME_TICKET_TTL_MS = 5 * 60 * 1000;
const FRAME_TICKET_MAX = 256;
/**
 * The read-session cookie (src/core/web/read-session.ts READ_SESSION_COOKIE).
 * Duplicated because read-session.ts keeps it private; the preview test mints
 * a real session through the real server and fails if the two drift.
 */
export const READ_SESSION_COOKIE_NAME = 'ashlr_read_session';

export function isPreviewFramePath(path: string): boolean {
  return VERSE_PREVIEW_FRAME_PATH_RE.test(path);
}

interface FrameTicket {
  sessionId: string;
  path: string;
  readSessionId: string;
  expiresAt: number;
}

const frameTickets = new Map<string, FrameTicket>();

/** Mint a ticket for one file of one chat, bound to the minting read session. */
export function mintFrameTicket(
  req: { sessionId: string; path: string; readSession: { id: string; expiresAt: number } },
  now = Date.now(),
): { ticket: string; url: string; expiresAt: string } {
  for (const [key, t] of frameTickets) if (t.expiresAt <= now) frameTickets.delete(key);
  while (frameTickets.size >= FRAME_TICKET_MAX) {
    const oldest = frameTickets.keys().next().value;
    if (oldest === undefined) break;
    frameTickets.delete(oldest);
  }
  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = Math.min(now + FRAME_TICKET_TTL_MS, req.readSession.expiresAt);
  frameTickets.set(ticket, { sessionId: req.sessionId, path: req.path, readSessionId: req.readSession.id, expiresAt });
  return { ticket, url: `${VERSE_PREVIEW_FRAME_PREFIX}${ticket}`, expiresAt: new Date(expiresAt).toISOString() };
}

/** The ONE read-session cookie value, or '' (absent, or duplicated — ambiguous, fail closed). */
export function readSessionCookie(cookieHeader: string | undefined): string {
  if (!cookieHeader || cookieHeader.length > 8_192) return '';
  let found = '';
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== READ_SESSION_COOKIE_NAME) continue;
    if (found) return '';
    found = part.slice(eq + 1).trim();
  }
  return found;
}

/**
 * Redeem a ticket: it must exist, be unexpired, and the request must carry the
 * cookie of the read session it was minted under (read-session.ts derives a
 * session's id as sha256(cookie value)). Reusable within its lifetime so the
 * artifact can reload itself; worthless without the cookie.
 */
export function redeemFrameTicket(
  ticket: string,
  cookieHeader: string | undefined,
  now = Date.now(),
): { sessionId: string; path: string } | null {
  const entry = frameTickets.get(ticket);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    frameTickets.delete(ticket);
    return null;
  }
  const cookie = readSessionCookie(cookieHeader);
  if (!cookie) return null;
  const id = createHash('sha256').update(cookie, 'utf8').digest('hex');
  const a = Buffer.from(id, 'utf8');
  const b = Buffer.from(entry.readSessionId, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { sessionId: entry.sessionId, path: entry.path };
}
