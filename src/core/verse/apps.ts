/**
 * core/verse/apps.ts — what Verse can run with on THIS Mac, detected (unit C6,
 * SPEC-310C §4). The static list is apps-catalog.ts (C0); this module answers,
 * for each entry: is it installed, which version, does the installed Ollama
 * know it (`ollama launch <id>`), is its runtime answering, and — for the two
 * desktop integrations — is Ollama's switch currently on.
 *
 * WHERE IT LOOKS. On the login shell's PATH (login-path.ts), never the
 * sidecar's: launchd starts the desktop sidecar with `/usr/bin:/bin:…`, where
 * Homebrew, `~/.local/bin` and `~/.grok/bin` do not exist and every row would
 * lie "not installed".
 *
 * WHAT IT COSTS. Zero model calls, zero paid anything:
 *   - binary detection is `stat` on the PATH entries;
 *   - a version comes from the binary's own install path first (Claude Code
 *     lives in `…/claude/versions/2.1.280`, Grok in `grok-0.2.118-macos-…`,
 *     Homebrew in `Cellar/<pkg>/<version>/`, npm next to a package.json) and
 *     only otherwise from `<bin> --version` — a status command. Versions are
 *     cached by (real path, mtime, size): a binary is asked once per install,
 *     not once per page view. `hermes --version` measured 10.2 s on this
 *     machine (it checks for updates), so a slow version never holds the page:
 *     the collect waits VERSION_WAIT_MS and the answer lands on the next read;
 *   - `ollama launch --help` (15 ms), cached by the ollama binary's identity;
 *   - loopback GETs with a 2 s timeout for Ollama, llama-server, LM Studio.
 *
 * NOTHING RUNS WITHOUT A CLICK. Launch and the desktop toggles open the exact
 * command in a Terminal window the operator can see (their prompts, their
 * output, their Ctrl-C). Verse never answers another tool's prompt for it
 * (no `-y`), never installs anything (Launch is refused for an agent that is
 * not installed, even when `ollama launch` could install it), and never
 * changes another app's settings in the background.
 *
 * PRIVACY. Absolute paths (binaries, the operator's home, llama-server's
 * GGUF path) stay server-side. Responses carry names, versions and argv
 * whose first element is the bare command name.
 */
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  constants as fsConstants,
  accessSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import {
  APPS_CATALOG,
  appCatalogEntry,
  parseOllamaLaunchIntegrations,
  type AppCatalogEntry,
} from './apps-catalog.js';
import {
  childProcessEnv,
  refreshLoginPath,
  resolveLoginPath,
  type LoginPathResult,
} from './login-path.js';
import {
  probeLlamaServer,
  probeOllamaResident,
  probeOllamaTags,
  VERSE_DEFAULT_LLAMA_SERVER_BASE,
  VERSE_DEFAULT_LMSTUDIO_BASE,
  VERSE_DEFAULT_OLLAMA_BASE,
  VERSE_LOCAL_PROBE_TIMEOUT_MS,
  type VerseLlamaServerReport,
} from './local-models.js';
import type { VerseEvent, VerseSession } from './types.js';
import type {
  VerseAppAction,
  VerseAppGroup,
  VerseAppHealth,
  VerseAppRow,
  VerseAppsResponse,
} from './workbench-types.js';

// ===========================================================================
// Constants
// ===========================================================================

/** A snapshot this young is served as-is; older ones are served AND re-probed in the background. */
export const APPS_SNAPSHOT_FRESH_MS = 60_000;
/** Refresh presses closer than this share one probe. */
export const APPS_REFRESH_MIN_GAP_MS = 5_000;
/** How long one collect waits for a `--version` before rendering without it. */
export const VERSION_WAIT_MS = 2_500;
/** The hard limit on a `--version` process; its answer is cached when it arrives. */
export const VERSION_TIMEOUT_MS = 15_000;
/** `ollama launch --help` is local and fast (15 ms measured); a stall here is a broken install. */
export const OLLAMA_HELP_TIMEOUT_MS = 5_000;
/** Launch-script files: one per click, deleted by the script itself on first run. */
export const APPS_SCRIPT_DIR_NAME = 'apps';
/** Ollama model tags as Ollama accepts them; anything else is refused before it reaches a script. */
export const OLLAMA_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Group titles, operator language. Accounts and MCP are composed by the page (see apps-api.ts). */
export const APP_GROUP_TITLES = {
  accounts: 'Accounts',
  desktop: 'Desktop',
  'terminal-agents': 'Terminal agents',
  'local-models': 'Local models',
  'mcp-servers': 'MCP servers',
} as const;

// ===========================================================================
// Detection state (server-side only; never serialised as-is)
// ===========================================================================

export interface BinaryFacts {
  /** The PATH hit, absolute. Server-only. */
  path: string;
  /** Symlinks resolved. Server-only. */
  realPath: string;
  mtimeMs: number;
  size: number;
}

export type DesktopToggleState = 'on' | 'off' | 'unknown';

export interface DesktopDetection {
  state: DesktopToggleState;
  /** `config`: read from the other app's own settings; `verse-record`: what Verse last asked for; `none`: nothing to go on. */
  source: 'config' | 'verse-record' | 'none';
  /** When Verse last ran the switch (either direction), ISO; null when never. */
  lastSetAt: string | null;
}

export interface OllamaReading {
  reachable: boolean;
  version: string | null;
  /** Installed tags (Ollama's own names). Empty when unreachable. */
  models: string[];
  resident: string[];
}

export interface LmStudioReading {
  reachable: boolean;
  modelCount: number | null;
}

/** End-to-end throughput of the last completed local turn (output tokens ÷ wall time). */
export interface LocalThroughput {
  model: string;
  tokPerSec: number;
  at: string;
}

export interface AppsSnapshot {
  checkedAt: string;
  pathSource: LoginPathResult['source'];
  binaries: ReadonlyMap<string, BinaryFacts | null>;
  versions: ReadonlyMap<string, string | null>;
  /** Integration ids the installed `ollama launch --help` lists; null = ollama missing or its help unreadable. */
  ollamaLaunchIds: ReadonlySet<string> | null;
  desktop: ReadonlyMap<string, DesktopDetection>;
  ollama: OllamaReading;
  llamaServer: VerseLlamaServerReport;
  lmStudio: LmStudioReading;
  throughput: LocalThroughput | null;
}

// ===========================================================================
// Pure helpers
// ===========================================================================

/** The first version-shaped token in a CLI's `--version` output. */
export function parseVersionOutput(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /(?:^|[\s(v:])v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)(?=$|[\s),;])/.exec(line);
    if (m) return m[1]!.slice(0, 40);
  }
  return null;
}

/**
 * A version the install path already states, so no process has to run:
 *   ~/.local/share/claude/versions/2.1.280           → 2.1.280
 *   ~/.grok/downloads/grok-0.2.118-macos-aarch64     → 0.2.118
 *   /opt/homebrew/Cellar/block-goose-cli/1.30.0/bin/goose → 1.30.0
 * Anything else (a venv shim, a node script, the Ollama.app bundle) → null.
 */
export function versionFromRealPath(realPath: string): string | null {
  const versions = /\/versions\/v?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)$/.exec(realPath);
  if (versions) return versions[1]!;
  const named = /\/[a-z][a-z0-9_-]*?-v?(\d+\.\d+\.\d+)(?:[-_][0-9A-Za-z_.-]*)?$/.exec(realPath);
  if (named) return named[1]!;
  const cellar = /\/Cellar\/[^/]+\/v?(\d+(?:\.\d+)+[0-9A-Za-z._-]*?)(?:_\d+)?\//.exec(realPath);
  if (cellar) return cellar[1]!;
  return null;
}

/**
 * npm-installed CLIs resolve to a script inside the package
 * (`…/node_modules/@openai/codex/bin/codex.js`); its package.json names the
 * version without running node. Walks up at most four directories and only
 * stops at a package.json that sits inside `node_modules`.
 */
export function versionFromPackageJson(realPath: string, readText: (path: string) => string | null): string | null {
  if (!realPath.includes('/node_modules/')) return null;
  let dir = dirname(realPath);
  for (let i = 0; i < 4 && dir.includes('/node_modules/'); i += 1) {
    const text = readText(join(dir, 'package.json'));
    if (text !== null) {
      try {
        const parsed = JSON.parse(text) as { version?: unknown };
        if (typeof parsed.version === 'string' && /^\d+\.\d+/.test(parsed.version)) return parsed.version.slice(0, 40);
      } catch {
        // not JSON — keep walking
      }
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Is `ollama launch claude-desktop` currently switched on? It rewrites Claude
 * Desktop's `claude_desktop_config.json` into a third-party deployment
 * (a top-level `deploymentMode`) and `--restore` removes it — so the key's
 * presence is the other app's own record of the switch. Unreadable or
 * unparseable → unknown, never "off".
 */
export function claudeDesktopOllamaState(configText: string | null): DesktopToggleState {
  if (configText === null) return 'unknown';
  try {
    const parsed = JSON.parse(configText) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
    const mode = (parsed as Record<string, unknown>)['deploymentMode'];
    if (mode === undefined || mode === null || mode === '' || mode === 'default' || mode === '1p') return 'off';
    return 'on';
  } catch {
    return 'unknown';
  }
}

export function claudeDesktopConfigPath(home: string): string {
  return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
}

/**
 * The last completed local turn's throughput: output tokens over the turn's
 * wall time. Honest about what it is — END TO END (it includes prompt
 * processing and any tool runs), so it is a floor on generation speed, and
 * the page says "end to end". Null when no local turn finished with both a
 * token count and a duration.
 */
export function lastLocalThroughput(
  sessions: readonly VerseSession[],
  getEvents: (sessionId: string) => readonly VerseEvent[],
): LocalThroughput | null {
  const local = sessions
    .filter((s) => s.engine === 'local' && s.turnCount > 0)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  // One session's events at most per read: the newest local chat answers it.
  const session = local[0];
  if (!session) return null;
  let events: readonly VerseEvent[];
  try {
    events = getEvents(session.id);
  } catch {
    return null;
  }
  const outputByTurn = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'usage' && typeof event.usage?.outputTokens === 'number') {
      outputByTurn.set(event.turnId, event.usage.outputTokens);
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type !== 'turn-done' || !event.ok) continue;
    const out = outputByTurn.get(event.turnId);
    if (out === undefined || out <= 0 || !(event.durationMs > 0)) continue;
    const tokPerSec = Math.round((out / (event.durationMs / 1000)) * 10) / 10;
    if (!Number.isFinite(tokPerSec) || tokPerSec <= 0) continue;
    return { model: session.model, tokPerSec, at: event.at };
  }
  return null;
}

/** POSIX single-quoting for a script line; nothing is ever interpolated unquoted. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** An argv as the operator would type it (bare words stay bare). */
export function commandText(argv: readonly string[]): string {
  return argv.map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : shellQuote(arg))).join(' ');
}

/** A folder name is operator data: no escape sequence may reach their terminal through the banner. */
function stripControl(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) ? ' ' : ch;
  }
  return out;
}

/**
 * The script Terminal runs for Launch and for a desktop toggle: delete
 * itself, say what it runs, cd, pin PATH to the login PATH detection used
 * (so what was detected is what runs), then exec — the command owns the
 * window from there.
 */
export function buildTerminalScript(input: {
  argv: readonly string[];
  display: readonly string[];
  cwd: string | null;
  path: string;
  banner: string;
}): string {
  const lines = [
    '#!/bin/sh',
    'rm -f -- "$0"',
    `printf '%s\\n' ${shellQuote(`Ashlr Verse: ${stripControl(input.banner).slice(0, 120)}`)}`,
    `printf '%s\\n\\n' ${shellQuote(`$ ${commandText(input.display)}`)}`,
    `export PATH=${shellQuote(input.path)}`,
  ];
  if (input.cwd !== null) lines.push(`cd -- ${shellQuote(input.cwd)} || exit 1`);
  lines.push(`exec ${input.argv.map(shellQuote).join(' ')}`, '');
  return lines.join('\n');
}

// ===========================================================================
// Launch resolution (exported for C4's terminal: `appId` → argv)
// ===========================================================================

export type AppLaunchVia = 'native' | 'ollama';

export interface AppLaunchPlan {
  /** What actually runs; argv[0] is absolute. Server-only. */
  argv: string[];
  /** What the operator sees; argv[0] is the bare command. */
  display: string[];
}

export type AppLaunchRefusal =
  | { code: 'unknown-app'; status: 404; error: string }
  | { code: 'not-launchable'; status: 409; error: string }
  | { code: 'not-installed'; status: 409; error: string }
  | { code: 'ollama-unavailable'; status: 409; error: string }
  | { code: 'model-invalid'; status: 400; error: string };

/**
 * Which command a Launch runs, from a snapshot. Pure. `via: 'ollama'` runs
 * `ollama launch <id> [--model <tag>]` and only when the INSTALLED ollama
 * lists the id; `native` runs the agent's own command. A model is an Ollama
 * tag and only meaningful through Ollama.
 */
export function resolveAppLaunch(
  snapshot: AppsSnapshot,
  appId: string,
  opts: { via?: AppLaunchVia; model?: string | null } = {},
): { ok: true; plan: AppLaunchPlan } | { ok: false; refusal: AppLaunchRefusal } {
  const entry = appCatalogEntry(appId);
  if (!entry) return { ok: false, refusal: { code: 'unknown-app', status: 404, error: 'no app with that id' } };
  if (entry.group !== 'terminal-agents' || entry.launch === null) {
    return { ok: false, refusal: { code: 'not-launchable', status: 409, error: `${entry.name} is not a terminal agent` } };
  }
  const model = opts.model ?? null;
  const via: AppLaunchVia = opts.via ?? (model !== null ? 'ollama' : 'native');
  const agent = snapshot.binaries.get(entry.id) ?? null;
  if (agent === null) {
    // Refused even for `ollama launch`, which could install it: a click on
    // Launch must never download software.
    return { ok: false, refusal: { code: 'not-installed', status: 409, error: `${entry.name} is not installed` } };
  }
  if (via === 'native') {
    if (model !== null) {
      return { ok: false, refusal: { code: 'model-invalid', status: 400, error: 'a local model launches through Ollama' } };
    }
    return { ok: true, plan: { argv: [agent.path, ...entry.launch.slice(1)], display: [...entry.launch] } };
  }
  const ollama = snapshot.binaries.get('ollama') ?? null;
  if (entry.ollamaLaunchId === null || ollama === null || !snapshot.ollamaLaunchIds?.has(entry.ollamaLaunchId)) {
    return {
      ok: false,
      refusal: { code: 'ollama-unavailable', status: 409, error: `the installed Ollama cannot launch ${entry.name}` },
    };
  }
  const tail = ['launch', entry.ollamaLaunchId];
  if (model !== null) {
    if (!OLLAMA_MODEL_RE.test(model)) {
      return { ok: false, refusal: { code: 'model-invalid', status: 400, error: 'not an Ollama model tag' } };
    }
    if (!snapshot.ollama.reachable) {
      return { ok: false, refusal: { code: 'ollama-unavailable', status: 409, error: 'Ollama is not running' } };
    }
    if (!snapshot.ollama.models.includes(model)) {
      return { ok: false, refusal: { code: 'model-invalid', status: 400, error: 'that model is not installed in Ollama' } };
    }
    tail.push('--model', model);
  }
  return { ok: true, plan: { argv: [ollama.path, ...tail], display: ['ollama', ...tail] } };
}

// ===========================================================================
// Rows (pure: snapshot → wire)
// ===========================================================================

function health(state: VerseAppHealth['state'], label: string): VerseAppHealth {
  return { state, label };
}

function action(kind: VerseAppAction['kind'], label: string, command: string[] | null, disabledReason: string | null = null): VerseAppAction {
  return { kind, label, command, disabledReason };
}

function ollamaLaunchFor(snapshot: AppsSnapshot, entry: AppCatalogEntry): string[] | null {
  if (entry.ollamaLaunchId === null || !snapshot.ollamaLaunchIds?.has(entry.ollamaLaunchId)) return null;
  return ['ollama', 'launch', entry.ollamaLaunchId];
}

function desktopRow(snapshot: AppsSnapshot, entry: AppCatalogEntry): VerseAppRow {
  const toggle = entry.desktopToggle!;
  const detection = snapshot.desktop.get(entry.id) ?? { state: 'unknown' as const, source: 'none' as const, lastSetAt: null };
  const ollamaInstalled = (snapshot.binaries.get('ollama') ?? null) !== null;
  const usable = ollamaInstalled && entry.ollamaLaunchId !== null && (snapshot.ollamaLaunchIds?.has(entry.ollamaLaunchId) ?? false);
  const base = {
    id: entry.id,
    name: entry.name,
    monogram: entry.monogram,
    engine: entry.engine,
    description: entry.description,
    installed: null,
    version: null,
    copy: null,
    ollamaLaunch: null,
    seatId: null,
  };
  if (!usable) {
    return {
      ...base,
      health: health('off', ollamaInstalled ? 'this Ollama has no such switch' : 'needs Ollama'),
      toggle: null,
      actions: [],
      detail: toggle.note,
    };
  }
  const word = detection.state === 'on'
    ? detection.source === 'verse-record' ? 'on (as last set from Verse)' : 'on'
    : detection.state === 'off'
      ? detection.source === 'verse-record' ? 'off (as last set from Verse)' : 'off'
      : 'state not read';
  return {
    ...base,
    health: health(detection.state === 'on' ? 'warn' : detection.state === 'off' ? 'off' : 'unknown', word),
    toggle: { enabled: detection.state === 'on', command: [...toggle.onCommand], restoreCommand: [...toggle.restoreCommand] },
    // Restore is always offered (SPEC-310C §0.5): it is the way back from a
    // switch someone flipped outside Verse, which Verse may not have seen.
    actions: [action('restore', 'Restore', [...toggle.restoreCommand])],
    detail: toggle.note,
  };
}

function agentRow(snapshot: AppsSnapshot, entry: AppCatalogEntry): VerseAppRow {
  const binary = snapshot.binaries.get(entry.id) ?? null;
  const installed = binary !== null;
  const version = installed ? (snapshot.versions.get(entry.id) ?? null) : null;
  const launch = entry.launch === null ? null : [...entry.launch];
  const ollamaLaunch = ollamaLaunchFor(snapshot, entry);
  return {
    id: entry.id,
    name: entry.name,
    monogram: entry.monogram,
    engine: entry.engine,
    description: entry.description,
    health: installed ? health('ok', 'installed') : health('off', 'not installed'),
    installed,
    version,
    copy: launch === null ? null : { label: commandText(launch), text: commandText(launch) },
    ollamaLaunch,
    toggle: null,
    actions: launch === null
      ? []
      : [action('launch', 'Launch', launch, installed
        ? null
        : ollamaLaunch !== null
          ? `Not installed. Running ${commandText(ollamaLaunch)} yourself can install it.`
          : 'Not installed.')],
    seatId: null,
    detail: null,
  };
}

function formatCount(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function runtimeRow(snapshot: AppsSnapshot, entry: AppCatalogEntry): VerseAppRow {
  const binary = snapshot.binaries.get(entry.id) ?? null;
  const base = {
    id: entry.id,
    name: entry.name,
    monogram: entry.monogram,
    engine: entry.engine,
    description: entry.description,
    installed: binary !== null,
    copy: null,
    ollamaLaunch: null,
    toggle: null,
    actions: [] as VerseAppAction[],
    seatId: null,
  };
  if (entry.id === 'ollama') {
    const o = snapshot.ollama;
    const version = o.version ?? (binary !== null ? (snapshot.versions.get(entry.id) ?? null) : null);
    if (o.reachable) {
      const parts = [formatCount(o.models.length, 'model', 'models')];
      if (o.resident.length > 0) parts.push(`${o.resident.length} loaded`);
      if (snapshot.throughput !== null) {
        parts.push(`≈${snapshot.throughput.tokPerSec} tok/s end to end, last local turn`);
      }
      return { ...base, installed: true, version, health: health('ok', 'running'), detail: parts.join(' · ') };
    }
    return {
      ...base,
      version,
      health: binary !== null ? health('warn', 'not running') : health('off', 'not installed'),
      detail: binary !== null ? 'Local seats need it running. Open the Ollama app, or run: ollama serve' : null,
    };
  }
  if (entry.id === 'llama-server') {
    const l = snapshot.llamaServer;
    const version = binary !== null ? (snapshot.versions.get(entry.id) ?? null) : null;
    const port = (() => {
      try {
        return `:${new URL(l.baseUrl).port || '80'}`;
      } catch {
        return null;
      }
    })();
    if (l.status === 'ok') {
      const parts = [port ?? 'serving'];
      if (l.slots !== null) parts.push(formatCount(l.slots, 'slot', 'slots'));
      if (l.models.length > 0) parts.push(l.models.join(', '));
      else if (l.modelCount !== null) parts.push(formatCount(l.modelCount, 'model', 'models'));
      return { ...base, installed: binary !== null ? true : null, version, health: health('ok', 'running'), detail: parts.join(' · ') };
    }
    if (l.status === 'loading') {
      return { ...base, version, health: health('warn', 'loading a model'), detail: port };
    }
    if (l.status === 'error') {
      return { ...base, version, health: health('error', 'answering with an error'), detail: port };
    }
    return {
      ...base,
      version,
      // Optional runtime: not running is a fact, not a fault.
      health: binary !== null ? health('off', 'not running') : health('off', 'not installed'),
      detail: binary !== null ? `Nothing answered on ${port ?? 'its port'}` : null,
    };
  }
  // LM Studio
  const s = snapshot.lmStudio;
  const version = binary !== null ? (snapshot.versions.get(entry.id) ?? null) : null;
  if (s.reachable) {
    return {
      ...base,
      installed: binary !== null ? true : null,
      version,
      health: health('ok', 'server running'),
      detail: s.modelCount === null ? null : formatCount(s.modelCount, 'model', 'models'),
    };
  }
  return {
    ...base,
    version,
    health: binary !== null ? health('off', 'server not running') : health('off', 'not installed'),
    detail: null,
  };
}

/**
 * Snapshot → the three groups this route owns, in SPEC-310C §4 order.
 * ACCOUNTS and MCP SERVERS are composed by the page from the reads that
 * already serve them (see apps-api.ts).
 */
export function buildAppsResponse(snapshot: AppsSnapshot): VerseAppsResponse {
  const groups: VerseAppGroup[] = [
    {
      id: 'desktop',
      title: APP_GROUP_TITLES.desktop,
      caveat: 'These switch another app to local Ollama models. Leave Claude Desktop off: Verse’s local seats already use Ollama.',
      apps: APPS_CATALOG.filter((e) => e.group === 'desktop').map((e) => desktopRow(snapshot, e)),
    },
    {
      id: 'terminal-agents',
      title: APP_GROUP_TITLES['terminal-agents'],
      caveat: null,
      apps: APPS_CATALOG.filter((e) => e.group === 'terminal-agents').map((e) => agentRow(snapshot, e)),
    },
    {
      id: 'local-models',
      title: APP_GROUP_TITLES['local-models'],
      caveat: null,
      apps: APPS_CATALOG.filter((e) => e.group === 'local-models').map((e) => runtimeRow(snapshot, e)),
    },
  ];
  return { checkedAt: snapshot.checkedAt, pathSource: snapshot.pathSource, groups };
}

// ===========================================================================
// Persisted record (what Verse last asked a desktop switch to be)
// ===========================================================================

export interface AppsStateFile {
  v: 1;
  desktop: Record<string, { enabled: boolean; at: string }>;
}

function emptyState(): AppsStateFile {
  return { v: 1, desktop: {} };
}

export function parseAppsState(text: string | null): AppsStateFile {
  if (text === null) return emptyState();
  try {
    const parsed = JSON.parse(text) as Partial<AppsStateFile>;
    if (parsed?.v !== 1 || parsed.desktop === null || typeof parsed.desktop !== 'object') return emptyState();
    const desktop: AppsStateFile['desktop'] = {};
    for (const [id, value] of Object.entries(parsed.desktop)) {
      if (appCatalogEntry(id)?.desktopToggle == null) continue;
      if (value && typeof value.enabled === 'boolean' && typeof value.at === 'string') desktop[id] = { enabled: value.enabled, at: value.at };
    }
    return { v: 1, desktop };
  } catch {
    return emptyState();
  }
}

// ===========================================================================
// Service
// ===========================================================================

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number; env: Record<string, string> },
) => Promise<RunResult>;

/** Everything the service touches, injectable (tests never touch a real shell, network or Terminal). */
export interface AppsDeps {
  loginPath: (refresh: boolean) => Promise<LoginPathResult>;
  childEnv: () => Promise<Record<string, string>>;
  /** stat + realpath of an executable regular file; null when absent or not executable. */
  statExecutable: (path: string) => BinaryFacts | null;
  readText: (path: string) => string | null;
  run: CommandRunner;
  fetchImpl: typeof fetch;
  /** Write a 0700 script and have Terminal run it (macOS). */
  openTerminal: (script: string, name: string) => Promise<void>;
  writeState: (text: string) => void;
  readState: () => string | null;
  home: string;
  platform: NodeJS.Platform;
  now: () => number;
  ollamaBaseUrl: string;
  llamaServerBaseUrl: string;
  lmStudioBaseUrl: string;
  /** The newest local turn's throughput; null when unknown (no engine yet, no local turn). */
  localThroughput: () => LocalThroughput | null;
  /** Folders a Launch may start in: session roots and discovered projects, already guarded. */
  allowedRoots: () => readonly string[];
  /** Validate one root (checkWorkspaceRootPath); returns the resolved path or an error sentence. */
  checkRoot: (raw: string) => { ok: true; path: string } | { ok: false; error: string };
}

export type AppsActionResult =
  | { ok: true; status: 202; body: { ok: true; opened: 'terminal-app'; command: string[] } }
  | { ok: false; status: 400 | 404 | 409 | 501 | 502; code: string; error: string };

export interface AppsService {
  /** Cached; never waits on a probe except the very first. */
  get(): Promise<VerseAppsResponse>;
  /** Re-ask the login shell and re-probe everything (coalesced within APPS_REFRESH_MIN_GAP_MS). */
  refresh(): Promise<VerseAppsResponse>;
  /** The raw snapshot (C4's terminal resolves `appId` against it). */
  snapshot(): Promise<AppsSnapshot>;
  toggle(appId: string, enabled: boolean): Promise<AppsActionResult>;
  launch(appId: string, opts: { root: string; via?: AppLaunchVia; model?: string | null }): Promise<AppsActionResult>;
}

interface VersionCacheEntry {
  key: string;
  value: string | null;
  pending: Promise<string | null> | null;
}

export function createAppsService(deps: AppsDeps): AppsService {
  let current: AppsSnapshot | null = null;
  /** Set by an action whose effect the next read must look for (a desktop switch just flipped). */
  let revalidate = false;
  let collecting: Promise<AppsSnapshot> | null = null;
  let lastCollectStarted = 0;
  const versionCache = new Map<string, VersionCacheEntry>();
  let ollamaHelp: { key: string; ids: Set<string> | null } | null = null;

  const identity = (facts: BinaryFacts): string => `${facts.realPath}\u0000${facts.mtimeMs}\u0000${facts.size}`;

  function findBinary(names: readonly string[], entries: readonly string[]): BinaryFacts | null {
    for (const name of names) {
      // A catalog name is a bare word; never let one walk out of a PATH entry.
      if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
      for (const dir of entries) {
        const facts = deps.statExecutable(join(dir, name));
        if (facts !== null) return facts;
      }
    }
    return null;
  }

  function readVersion(entry: AppCatalogEntry, facts: BinaryFacts, env: Record<string, string>): Promise<string | null> | string | null {
    const key = identity(facts);
    const cached = versionCache.get(entry.id);
    if (cached && cached.key === key) return cached.pending ?? cached.value;
    const fromPath = versionFromRealPath(facts.realPath) ?? versionFromPackageJson(facts.realPath, deps.readText);
    if (fromPath !== null || entry.versionArgs.length === 0) {
      versionCache.set(entry.id, { key, value: fromPath, pending: null });
      return fromPath;
    }
    const pending = deps
      .run(facts.path, entry.versionArgs, { timeoutMs: VERSION_TIMEOUT_MS, env })
      .then((r) => parseVersionOutput(`${r.stdout}\n${r.stderr}`))
      .catch(() => null)
      .then((value) => {
        const slot = versionCache.get(entry.id);
        if (slot && slot.key === key) {
          slot.value = value;
          slot.pending = null;
        }
        // A version that arrived after the collect gave up is patched into
        // the served snapshot, so the next read shows it without a re-probe.
        if (current !== null && current.binaries.get(entry.id) != null) {
          const versions = new Map(current.versions);
          versions.set(entry.id, value);
          current = { ...current, versions };
        }
        return value;
      });
    versionCache.set(entry.id, { key, value: null, pending });
    return pending;
  }

  async function readOllamaLaunchIds(facts: BinaryFacts | null, env: Record<string, string>): Promise<Set<string> | null> {
    if (facts === null) return null;
    const key = identity(facts);
    if (ollamaHelp !== null && ollamaHelp.key === key) return ollamaHelp.ids;
    let ids: Set<string> | null = null;
    try {
      const r = await deps.run(facts.path, ['launch', '--help'], { timeoutMs: OLLAMA_HELP_TIMEOUT_MS, env });
      const parsed = parseOllamaLaunchIntegrations(`${r.stdout}\n${r.stderr}`);
      ids = parsed.size > 0 ? parsed : null;
    } catch {
      ids = null;
    }
    // Only a successful parse is cached: an unreadable help (a broken install
    // mid-upgrade) is retried on the next collect.
    if (ids !== null) ollamaHelp = { key, ids };
    return ids;
  }

  async function probeOllama(): Promise<OllamaReading> {
    const timeout = VERSE_LOCAL_PROBE_TIMEOUT_MS;
    const [versionBody, tags, resident] = await Promise.all([
      (async () => {
        try {
          const res = await deps.fetchImpl(`${deps.ollamaBaseUrl}/api/version`, { signal: AbortSignal.timeout(timeout) });
          if (!res.ok) return null;
          return (await res.json()) as unknown;
        } catch {
          return null;
        }
      })(),
      probeOllamaTags(deps.fetchImpl, deps.ollamaBaseUrl, timeout).catch(() => null),
      probeOllamaResident(deps.fetchImpl, deps.ollamaBaseUrl, timeout).catch(() => null),
    ]);
    const version = versionBody !== null && typeof versionBody === 'object'
      && typeof (versionBody as { version?: unknown }).version === 'string'
      ? ((versionBody as { version: string }).version.slice(0, 40))
      : null;
    return {
      reachable: tags !== null || version !== null,
      version,
      models: (tags ?? []).map((t) => t.tag),
      resident: (resident ?? []).map((r) => r.tag),
    };
  }

  async function probeLmStudio(): Promise<LmStudioReading> {
    try {
      const res = await deps.fetchImpl(`${deps.lmStudioBaseUrl}/v1/models`, {
        signal: AbortSignal.timeout(VERSE_LOCAL_PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return { reachable: false, modelCount: null };
      const body = (await res.json()) as { data?: unknown };
      return { reachable: true, modelCount: Array.isArray(body?.data) ? body.data.length : null };
    } catch {
      return { reachable: false, modelCount: null };
    }
  }

  function readDesktop(): Map<string, DesktopDetection> {
    const state = parseAppsState(deps.readState());
    const out = new Map<string, DesktopDetection>();
    for (const entry of APPS_CATALOG) {
      if (entry.desktopToggle === null) continue;
      const record = state.desktop[entry.id] ?? null;
      let detection: DesktopDetection;
      if (entry.id === 'claude-desktop') {
        const fromConfig = claudeDesktopOllamaState(deps.readText(claudeDesktopConfigPath(deps.home)));
        detection = fromConfig !== 'unknown'
          ? { state: fromConfig, source: 'config', lastSetAt: record?.at ?? null }
          : record !== null
            ? { state: record.enabled ? 'on' : 'off', source: 'verse-record', lastSetAt: record.at }
            : { state: 'unknown', source: 'none', lastSetAt: null };
      } else {
        // Hermes Desktop keeps no setting Verse can read; Verse's own record
        // is the only evidence, and the row says "as last set from Verse".
        // Never having set it is reported as off: the switch ships off, and
        // `defaultEnabled: false` is the catalog's statement of that.
        detection = record !== null
          ? { state: record.enabled ? 'on' : 'off', source: 'verse-record', lastSetAt: record.at }
          : { state: 'off', source: 'none', lastSetAt: null };
      }
      out.set(entry.id, detection);
    }
    return out;
  }

  async function collect(refreshPath: boolean): Promise<AppsSnapshot> {
    lastCollectStarted = deps.now();
    const login = await deps.loginPath(refreshPath);
    const env = await deps.childEnv();
    const binaries = new Map<string, BinaryFacts | null>();
    for (const entry of APPS_CATALOG) {
      binaries.set(entry.id, entry.binaries.length === 0 ? null : findBinary(entry.binaries, login.entries));
    }

    const versionWaits: Array<Promise<void>> = [];
    const versions = new Map<string, string | null>();
    for (const entry of APPS_CATALOG) {
      const facts = binaries.get(entry.id) ?? null;
      if (facts === null) continue;
      const value = readVersion(entry, facts, env);
      if (value instanceof Promise) {
        versions.set(entry.id, null);
        versionWaits.push(value.then((v) => { versions.set(entry.id, v); }));
      } else {
        versions.set(entry.id, value);
      }
    }
    const waitVersions = Promise.race([
      Promise.all(versionWaits).then(() => undefined),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, VERSION_WAIT_MS);
        (t as { unref?: () => void }).unref?.();
      }),
    ]);

    const [ollamaLaunchIds, ollama, llamaServer, lmStudio] = await Promise.all([
      readOllamaLaunchIds(binaries.get('ollama') ?? null, env),
      probeOllama(),
      probeLlamaServer({ baseUrl: deps.llamaServerBaseUrl, fetchImpl: deps.fetchImpl }).catch((): VerseLlamaServerReport => ({
        reachable: false,
        baseUrl: deps.llamaServerBaseUrl,
        status: 'down',
        models: [],
        modelCount: null,
        slots: null,
        reason: 'llama-server-probe-failed',
      })),
      probeLmStudio(),
      waitVersions,
    ]);

    let throughput: LocalThroughput | null = null;
    try {
      throughput = deps.localThroughput();
    } catch {
      throughput = null;
    }

    const snapshot: AppsSnapshot = {
      checkedAt: new Date(deps.now()).toISOString(),
      pathSource: login.source,
      binaries,
      // Copy: late versions keep landing in `versions` via the patch above.
      versions: new Map(versions),
      ollamaLaunchIds,
      desktop: readDesktop(),
      ollama,
      llamaServer,
      lmStudio,
      throughput,
    };
    current = snapshot;
    return snapshot;
  }

  function startCollect(refreshPath: boolean): Promise<AppsSnapshot> {
    if (collecting !== null) return collecting;
    collecting = collect(refreshPath).finally(() => {
      collecting = null;
    });
    return collecting;
  }

  async function snapshot(): Promise<AppsSnapshot> {
    if (current === null) return startCollect(false);
    if (revalidate || deps.now() - Date.parse(current.checkedAt) > APPS_SNAPSHOT_FRESH_MS) {
      revalidate = false;
      // Stale-while-revalidate: a read never waits on a probe it did not need.
      void startCollect(false).catch(() => undefined);
    }
    return current;
  }

  async function openScript(argv: readonly string[], display: readonly string[], cwd: string | null, banner: string, name: string): Promise<AppsActionResult | null> {
    if (deps.platform !== 'darwin') {
      return { ok: false, status: 501, code: 'VERSE_APPS_UNSUPPORTED', error: 'Opening a Terminal window is supported on macOS only; copy the command instead.' };
    }
    const login = await deps.loginPath(false);
    const script = buildTerminalScript({ argv, display, cwd, path: login.path, banner });
    try {
      await deps.openTerminal(script, name);
    } catch {
      return { ok: false, status: 502, code: 'VERSE_APPS_TERMINAL_FAILED', error: 'Terminal could not be opened.' };
    }
    return null;
  }

  return {
    async get() {
      return buildAppsResponse(await snapshot());
    },
    async refresh() {
      if (collecting === null && current !== null && deps.now() - lastCollectStarted < APPS_REFRESH_MIN_GAP_MS) {
        return buildAppsResponse(current);
      }
      // A refresh re-asks the login shell: a PATH edited since launch is picked up.
      const fresh = collecting ?? startCollect(true);
      return buildAppsResponse(await fresh);
    },
    snapshot,
    async toggle(appId, enabled) {
      const entry = appCatalogEntry(appId);
      if (!entry) return { ok: false, status: 404, code: 'VERSE_APP_NOT_FOUND', error: 'no app with that id' };
      if (entry.desktopToggle === null) {
        return { ok: false, status: 409, code: 'VERSE_APP_NO_TOGGLE', error: `${entry.name} has no switch` };
      }
      const snap = await snapshot();
      const ollama = snap.binaries.get('ollama') ?? null;
      if (ollama === null || entry.ollamaLaunchId === null || !snap.ollamaLaunchIds?.has(entry.ollamaLaunchId)) {
        return { ok: false, status: 409, code: 'VERSE_APP_OLLAMA_UNAVAILABLE', error: 'the installed Ollama has no such switch' };
      }
      const display = [...(enabled ? entry.desktopToggle.onCommand : entry.desktopToggle.restoreCommand)];
      const argv = [ollama.path, ...display.slice(1)];
      const failed = await openScript(argv, display, null, `${enabled ? 'switching on' : 'restoring'} ${entry.name}. Answer its prompts here.`, entry.id);
      if (failed) return failed;
      // Recorded AFTER the window opened: this is what Verse asked for, and
      // the row labels it that way where the app's own setting is unreadable.
      const state = parseAppsState(deps.readState());
      state.desktop[entry.id] = { enabled, at: new Date(deps.now()).toISOString() };
      try {
        deps.writeState(`${JSON.stringify(state, null, 2)}\n`);
      } catch {
        // The window opened; a record we could not write only costs the label.
      }
      // Show the new record at once (file reads only), and look again on the
      // next read: the operator is answering the tool's prompt right now.
      if (current !== null) current = { ...current, desktop: readDesktop() };
      revalidate = true;
      return { ok: true, status: 202, body: { ok: true, opened: 'terminal-app', command: display } };
    },
    async launch(appId, opts) {
      const root = deps.checkRoot(opts.root);
      if (!root.ok) return { ok: false, status: 400, code: 'VERSE_INVALID', error: root.error };
      const allowed = deps.allowedRoots().map((r) => resolvePath(r));
      if (!allowed.includes(resolvePath(root.path))) {
        return { ok: false, status: 400, code: 'VERSE_INVALID', error: 'root must be a chat folder or a discovered project' };
      }
      const resolved = resolveAppLaunch(await snapshot(), appId, { via: opts.via, model: opts.model ?? null });
      if (!resolved.ok) {
        return { ok: false, status: resolved.refusal.status, code: `VERSE_APP_${resolved.refusal.code.toUpperCase().replace(/-/g, '_')}`, error: resolved.refusal.error };
      }
      const entry = appCatalogEntry(appId)!;
      const failed = await openScript(resolved.plan.argv, resolved.plan.display, root.path, `launching ${entry.name} in ${basename(root.path)}.`, entry.id);
      if (failed) return failed;
      return { ok: true, status: 202, body: { ok: true, opened: 'terminal-app', command: resolved.plan.display } };
    },
  };
}

// ===========================================================================
// Real dependencies
// ===========================================================================

export function defaultStatExecutable(path: string): BinaryFacts | null {
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    if (!st.isFile()) return null;
    accessSync(real, fsConstants.X_OK);
    return { path, realPath: real, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** Small text files only (configs, package.json). Anything larger is not what we are looking for. */
export function defaultReadText(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export const defaultCommandRunner: CommandRunner = (file, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: opts.env, windowsHide: true },
      (error, stdout, stderr) => {
        const err = error as { killed?: boolean; code?: unknown } | null;
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          timedOut: Boolean(err?.killed),
        });
      },
    );
    // A version command that reads stdin gets EOF, not a hang.
    child.stdin?.end();
  });

export function appsStateDir(home: string = homedir()): string {
  return join(home, '.ashlr', 'verse');
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Atomic 0600 write of ~/.ashlr/verse/apps.json. */
export function writeAppsStateFile(text: string, home: string = homedir()): void {
  const dir = appsStateDir(home);
  ensurePrivateDir(dir);
  const target = join(dir, 'apps.json');
  const tmp = join(dir, `.apps.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, target);
}

export function readAppsStateFile(home: string = homedir()): string | null {
  return defaultReadText(join(appsStateDir(home), 'apps.json'));
}

/**
 * Write the script (0700, in a 0700 directory, never overwriting) and hand it
 * to Terminal with `open -a Terminal` (no shell).
 */
export function terminalOpener(home: string = homedir(), open: (path: string) => Promise<void> = openWithTerminal) {
  return async (script: string, name: string): Promise<void> => {
    const dir = join(appsStateDir(home), APPS_SCRIPT_DIR_NAME);
    ensurePrivateDir(dir);
    const safe = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
    const file = join(dir, `${safe}-${randomBytes(4).toString('hex')}.command`);
    writeFileSync(file, script, { mode: 0o700, flag: 'wx' });
    await open(file);
  };
}

function openWithTerminal(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-a', 'Terminal', path], { timeout: 10_000 }, (error) => {
      if (error) reject(new Error('Terminal could not be opened'));
      else resolve();
    });
  });
}

export interface DefaultAppsDepsOptions {
  home?: string;
  ollamaBaseUrl?: string;
  llamaServerBaseUrl?: string;
  lmStudioBaseUrl?: string;
  localThroughput?: () => LocalThroughput | null;
  allowedRoots?: () => readonly string[];
  checkRoot?: AppsDeps['checkRoot'];
}

export function defaultAppsDeps(opts: DefaultAppsDepsOptions = {}): AppsDeps {
  const home = opts.home ?? homedir();
  return {
    loginPath: (refresh) => (refresh ? refreshLoginPath() : resolveLoginPath()),
    childEnv: () => childProcessEnv(),
    statExecutable: defaultStatExecutable,
    readText: defaultReadText,
    run: defaultCommandRunner,
    fetchImpl: fetch,
    openTerminal: terminalOpener(home),
    writeState: (text) => writeAppsStateFile(text, home),
    readState: () => readAppsStateFile(home),
    home,
    platform: process.platform,
    now: () => Date.now(),
    ollamaBaseUrl: opts.ollamaBaseUrl ?? VERSE_DEFAULT_OLLAMA_BASE,
    llamaServerBaseUrl: opts.llamaServerBaseUrl ?? VERSE_DEFAULT_LLAMA_SERVER_BASE,
    lmStudioBaseUrl: opts.lmStudioBaseUrl ?? VERSE_DEFAULT_LMSTUDIO_BASE,
    localThroughput: opts.localThroughput ?? (() => null),
    allowedRoots: opts.allowedRoots ?? (() => []),
    checkRoot: opts.checkRoot ?? ((raw) => ({ ok: false, error: `no root check configured for ${raw.length > 0 ? 'that folder' : 'an empty path'}` })),
  };
}

// Process-wide service (apps-api.ts creates it; C4's terminal reads it to resolve `appId`).
let service: AppsService | null = null;

export function getAppsService(): AppsService | null {
  return service;
}

export function setAppsService(next: AppsService | null): void {
  service = next;
}
