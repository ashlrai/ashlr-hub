/**
 * Config + path constants for ashlr-hub.
 *
 * Handles reading, writing, and defaulting the ~/.ashlr/config.json file.
 * All ~ paths are expanded to the real homedir at module load time.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import type { AshlrConfig, TidyRule } from './types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './fleet/local-store-lock.js';

// ---------------------------------------------------------------------------
// Path constants (exported, resolved immediately)
// ---------------------------------------------------------------------------

const HOME = homedir();

/** Absolute path to the hub's config/index home: ~/.ashlr */
export const CONFIG_DIR: string = join(HOME, '.ashlr');

/** Absolute path to the config file: ~/.ashlr/config.json */
export const CONFIG_PATH: string = join(CONFIG_DIR, 'config.json');

/** Absolute path to the index file: ~/.ashlr/index.json */
export const INDEX_PATH: string = join(CONFIG_DIR, 'index.json');

// ---------------------------------------------------------------------------
// Runtime path resolution
// ---------------------------------------------------------------------------
// The exported constants above are resolved once at module load for external
// consumers. The functions below re-resolve from homedir() at call time so a
// changed HOME (e.g. in tests, or a relocated home dir) is always honored.
// This keeps the public constants stable while making load/save correct under
// a moving HOME.

function resolveConfigDir(): string {
  return join(homedir(), '.ashlr');
}

function resolveConfigPath(): string {
  return join(resolveConfigDir(), 'config.json');
}

/**
 * Absolute path to the M26 self-improvement / meta-learning home:
 * `~/.ashlr/learn`. Re-resolved from `homedir()` at call time so tests that
 * relocate HOME work. This is the ONLY directory `ashlr reflect` writes to for
 * its reports/snapshots — it NEVER writes CONFIG_PATH / router policy / prompts.
 * This function does NOT create the directory; the learn store creates it lazily.
 */
export function learnDir(): string {
  return join(resolveConfigDir(), 'learn');
}

/**
 * Absolute path to the M27 quality / health-review home: `~/.ashlr/quality`.
 * Re-resolved from `homedir()` at call time so tests that relocate HOME work.
 * This is the ONLY directory `ashlr health` writes to for its HealthReport
 * snapshots (trend tracking) — it NEVER writes CONFIG_PATH / router policy /
 * prompts, and NEVER touches a user repo working tree. This function does NOT
 * create the directory; the quality store creates it lazily.
 */
export function qualityDir(): string {
  return join(resolveConfigDir(), 'quality');
}

/**
 * Absolute path to the M28 goal planning/tracking home: `~/.ashlr/goals`.
 * Re-resolved from `homedir()` at call time so tests that relocate HOME work.
 * This is the ONLY directory `ashlr goals` writes its planning/tracking data
 * to — it NEVER writes CONFIG_PATH / router policy / prompts, and NEVER touches
 * a user repo working tree. This function does NOT create the directory; the
 * goals store creates it lazily. Single source of truth for the ~/.ashlr root.
 */
export function goalsDir(): string {
  return join(resolveConfigDir(), 'goals');
}

/**
 * Absolute path to the M29 portfolio-digest home: `~/.ashlr/digests`.
 * Re-resolved from `homedir()` at call time so tests that relocate HOME work.
 * This is the ONLY directory `ashlr digest` writes to (JSON + markdown digest
 * artifacts for day-over-day trend) — it NEVER writes CONFIG_PATH / router
 * policy / prompts, and NEVER touches a user repo working tree. This function
 * does NOT create the directory; the digest store creates it lazily. Single
 * source of truth for the ~/.ashlr root.
 */
export function digestsDir(): string {
  return join(resolveConfigDir(), 'digests');
}

// ---------------------------------------------------------------------------
// Default tidy rules
// ---------------------------------------------------------------------------

/**
 * Conservative, opinionated rules for tidying loose top-level Desktop files.
 * Rules are applied in order — first match wins (enforced by the tidy engine).
 * Only moves clearly-typed files; ambiguous or structurally-important items
 * should be added to `keepers` instead.
 */
const DEFAULT_TIDY_RULES: TidyRule[] = [
  // ── Screenshots ──────────────────────────────────────────────────────────
  {
    match: 'Screenshot*',
    matchType: 'glob',
    dest: join(HOME, 'Desktop/Assets/Screenshots'),
    description: 'macOS screenshot files captured to Desktop',
  },
  {
    match: 'Screen Recording*',
    matchType: 'glob',
    dest: join(HOME, 'Desktop/Assets/Screenshots'),
    description: 'macOS screen recordings captured to Desktop',
  },

  // ── Images ────────────────────────────────────────────────────────────────
  {
    match: 'png',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose PNG images',
  },
  {
    match: 'jpg',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose JPEG images',
  },
  {
    match: 'jpeg',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose JPEG images',
  },
  {
    match: 'gif',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose GIF images',
  },
  {
    match: 'webp',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose WebP images',
  },
  {
    match: 'svg',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose SVG files',
  },
  {
    match: 'heic',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose HEIC images (iPhone captures)',
  },

  // ── Documents — PDF ───────────────────────────────────────────────────────
  {
    match: '*Invoice*',
    matchType: 'glob',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Invoice PDFs and documents',
  },
  {
    match: '*Receipt*',
    matchType: 'glob',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Receipt PDFs and documents',
  },
  {
    match: '*Contract*',
    matchType: 'glob',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Contract documents',
  },
  {
    match: 'pdf',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Loose PDF documents (generic catch-all for PDFs not matched above)',
  },

  // ── Documents — Office / text ─────────────────────────────────────────────
  {
    match: 'docx',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Loose Word documents',
  },
  {
    match: 'doc',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Loose Word documents (legacy format)',
  },
  {
    match: 'xlsx',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Loose Excel spreadsheets',
  },
  {
    match: 'xls',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Loose Excel spreadsheets (legacy format)',
  },
  {
    match: 'pptx',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Loose PowerPoint presentations',
  },
  {
    match: 'ppt',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Loose PowerPoint presentations (legacy format)',
  },
  {
    match: 'numbers',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Loose Numbers spreadsheets',
  },
  {
    match: 'pages',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Loose Pages documents',
  },
  {
    match: 'keynote',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Business'),
    description: 'Loose Keynote presentations',
  },

  // ── Notes / Markdown ──────────────────────────────────────────────────────
  {
    match: 'md',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Knowledge'),
    description: 'Loose Markdown notes and documents',
  },
  {
    match: 'txt',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Knowledge'),
    description: 'Loose plain-text notes',
  },
  {
    match: 'rtf',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Knowledge'),
    description: 'Loose RTF notes',
  },

  // ── Archives / downloads ──────────────────────────────────────────────────
  {
    match: 'zip',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/archive'),
    description: 'Loose ZIP archives (downloads, exports)',
  },
  {
    match: 'tar',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/archive'),
    description: 'Loose tar archives',
  },
  {
    match: 'gz',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/archive'),
    description: 'Loose gzip archives',
  },
  {
    match: 'dmg',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/archive'),
    description: 'Loose disk image installers',
  },
  {
    match: 'pkg',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/archive'),
    description: 'Loose macOS package installers',
  },

  // ── Audio / video ─────────────────────────────────────────────────────────
  {
    match: 'mp3',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose audio files',
  },
  {
    match: 'wav',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose WAV audio files',
  },
  {
    match: 'mp4',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose MP4 video files',
  },
  {
    match: 'mov',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose QuickTime video files',
  },
  {
    match: 'mkv',
    matchType: 'ext',
    dest: join(HOME, 'Desktop/Assets'),
    description: 'Loose MKV video files',
  },
];

// ---------------------------------------------------------------------------
// Category map (Desktop doc-folder categories; git-category entries come from
// the github/<category> subdirectory layout and are added dynamically in
// the index engine, but we seed the doc-folder ones here for tidy purposes).
// ---------------------------------------------------------------------------

const DEFAULT_CATEGORIES: Record<string, string> = {
  // Git repo categories (path-based; used by classify.ts to resolve category)
  'dev-tools': join(HOME, 'Desktop/github/dev-tools'),
  'side-projects': join(HOME, 'Desktop/github/side-projects'),
  'professional-tools': join(HOME, 'Desktop/github/professional-tools'),
  'artist-encyclopedias': join(HOME, 'Desktop/github/artist-encyclopedias'),
  'client-engagements': join(HOME, 'Desktop/github/client-engagements'),
  forks: join(HOME, 'Desktop/github/forks'),
  ashlrai: join(HOME, 'Desktop/github/ashlrai'),

  // Desktop document folders
  Business: join(HOME, 'Desktop/Business'),
  'Client-Work': join(HOME, 'Desktop/Client-Work'),
  'Product-Docs': join(HOME, 'Desktop/Product-Docs'),
  Knowledge: join(HOME, 'Desktop/Knowledge'),
  Assets: join(HOME, 'Desktop/Assets'),
  archive: join(HOME, 'Desktop/archive'),
};

// ---------------------------------------------------------------------------
// Keeper list
// These basenames / absolute paths must NEVER be moved or deleted by tidy.
// ---------------------------------------------------------------------------

const DEFAULT_KEEPERS: string[] = [
  'Rent Application.pdf',
  'ASHLRAI',
  'rde-other',
  'Keys & Recovery',
  'github',
  'Evero Notes',
  'OneDrive - James Madison University',
  // Top-level symlinks that happen to mirror github/ structure — never double-count
  'tts agents',
];

// ---------------------------------------------------------------------------
// defaultConfig()
// ---------------------------------------------------------------------------

/**
 * Produce a sensible default AshlrConfig for a fresh install.
 * All paths are resolved to absolute values (no ~ remaining).
 */
export function defaultConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [
      join(HOME, 'Desktop/github'),
      join(HOME, 'Desktop'),
    ],
    editor: 'cursor',
    staleDays: 30,
    categories: DEFAULT_CATEGORIES,
    tidyRules: DEFAULT_TIDY_RULES,
    keepers: DEFAULT_KEEPERS,
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['lmstudio', 'ollama', 'anthropic'],
    },
    telemetry: {},
    tools: {},
    // M33: plugin system defaults — DEFAULT EMPTY (enabled:[] = no plugins load).
    plugins: {
      enabled: [],
      settings: {},
      integrity: {},
    },
    // M109: user identity — absent by default (opt-in per machine).
    // Set cfg.user.id to your email and cfg.user.name to your display name;
    // the cofounder sets theirs on their machine. Fleet work created on this
    // machine is then stamped with this owner and attributed in pulse team views.
    // user: { id: 'you@example.com', name: 'Your Name' },

    // M111: multi-machine work-queue coordination — absent by default (single-machine).
    // trustedCoherentStorage defaults to false. To enable authority on a
    // verified coherent shared filesystem (not iCloud/Dropbox), set e.g.:
    //   fleet: { sharedQueue: { mode: 'filesystem', path: '/path/to/shared/folder', trustedCoherentStorage: true } }
    // This operator attestation is separate from local filesystem probing,
    // which cannot establish cross-host linearizability.
    // machineId defaults to os.hostname() when not explicitly set.
    // fleet: { sharedQueue: { mode: 'off', trustedCoherentStorage: false } },

    // M124: value filter gate — drop items below this value threshold before
    // the fleet selects work. Default 2 drops value-1 trivia. Configurable:
    //
    //   "foundry": { "minItemValue": 3 }   ← raise the bar further
    //   "foundry": { "minItemValue": 1 }   ← disable (allow all values)
    //
    // Goal focus mode is default-on: when 4+ repo-bound active goals already
    // have concrete pending/in-progress milestones, autonomous producers defer
    // new planning/invent expansion until existing goals close. Opt out with:
    //   "foundry": { "goalFocusMode": false }
    //
    // M115: local-coder (Ollama) fleet engine — FREE, unlimited, mid-tier.
    // Activate on any machine running Ollama by adding to ~/.ashlr/config.json:
    //
    //   "foundry": {
    //     "allowedBackends": ["builtin", "local-coder", "claude"],
    //     "models": { "local-coder": "qwen2.5:72b-instruct-q4_K_M" }
    //   }
    //
    // Upgrade coding quality: `ollama pull qwen2.5-coder:32b` then set:
    //   "models": { "local-coder": "qwen2.5-coder:32b" }
    //
    // The router (M115) automatically prefers local-coder for bulk items and
    // reserves frontier (claude/codex) for hard items (effort≥4 or score≥8)
    // and escalation re-tries. local-coder is mid-tier: branch-eligible but
    // NEVER granted merge-to-main authority (frontier-only gate).
  };
}

// ---------------------------------------------------------------------------
// Deep merge helper
// ---------------------------------------------------------------------------

/**
 * Recursively merge `override` on top of `base`.
 * Arrays from `override` replace those in `base` entirely (no concat) —
 * this lets users fully replace roots/keepers/tidyRules in their config file.
 * Plain objects are merged recursively; all other values override directly.
 */
function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result: Record<string, unknown> = { ...base } as Record<string, unknown>;

  for (const key of Object.keys(override) as Array<keyof T>) {
    const baseVal = base[key];
    const overVal = override[key];

    if (
      overVal !== null &&
      overVal !== undefined &&
      typeof overVal === 'object' &&
      !Array.isArray(overVal) &&
      typeof baseVal === 'object' &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      // Both sides are plain objects — recurse
      result[key as string] = deepMerge(
        baseVal as object,
        overVal as Partial<object>,
      );
    } else if (overVal !== undefined) {
      // Array, primitive, or null — take override's value
      result[key as string] = overVal;
    }
  }

  return result as T;
}

// ---------------------------------------------------------------------------
// loadConfig()
// ---------------------------------------------------------------------------

/**
 * Load config from CONFIG_PATH.
 * - If CONFIG_DIR does not exist, creates it.
 * - If CONFIG_PATH does not exist, writes the default config and returns it.
 * - Otherwise, reads the file, JSON-parses it, deep-merges over defaultConfig()
 *   (so new keys added in future versions are always present), and returns.
 * - On parse error, logs a warning and falls back to the default config
 *   (we intentionally do NOT overwrite the user's potentially-fixable file).
 */
export function loadConfig(): AshlrConfig {
  const configDir = resolveConfigDir();
  const configPath = resolveConfigPath();

  // Ensure the config directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  // If the config file does not exist, bootstrap it with defaults
  if (!existsSync(configPath)) {
    const defaults = defaultConfig();
    saveConfig(defaults);
    return defaults;
  }

  // Read and parse the existing config file
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    console.warn(
      `[ashlr] Warning: could not read config at ${configPath}: ${String(err)}. Using defaults.`,
    );
    return defaultConfig();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[ashlr] Warning: config file at ${configPath} is not valid JSON: ${String(err)}. Using defaults.`,
    );
    return defaultConfig();
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn(
      `[ashlr] Warning: config file at ${configPath} does not contain a JSON object. Using defaults.`,
    );
    return defaultConfig();
  }

  // Deep-merge the user's persisted config over the defaults so newly-added
  // fields always have a value even on older config files.
  return deepMerge(defaultConfig(), parsed as Partial<AshlrConfig>);
}

// ---------------------------------------------------------------------------
// saveConfig()
// ---------------------------------------------------------------------------

type FileStat = Stats;

function sameFile(left: FileStat, right: FileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownedByCurrentUser(stat: FileStat): boolean {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

function privateMode(stat: FileStat): boolean {
  return process.platform === 'win32' || (Number(stat.mode) & 0o077) === 0;
}

function migratableMode(stat: FileStat): boolean {
  return process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0;
}

function directoryOpenFlags(): number {
  return fsConstants.O_RDONLY |
    (process.platform === 'win32' ? 0 : fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
}

function secureConfigDirectory(configDir: string): { fd?: number; stat: FileStat } {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const before = lstatSync(configDir);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !ownedByCurrentUser(before) ||
    !migratableMode(before)
  ) {
    throw new Error(`[ashlr] Refusing to use unsafe config directory: ${configDir}`);
  }

  // Node cannot open directories as file descriptors on every supported
  // Windows filesystem. Atomic replacement still applies there; the POSIX
  // descriptor binding and directory fsync are additional guarantees.
  if (process.platform === 'win32') return { stat: before };

  const fd = openSync(configDir, directoryOpenFlags());
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || !sameFile(before, opened)) {
      throw new Error(`[ashlr] Config directory changed while opening it: ${configDir}`);
    }
    fchmodSync(fd, 0o700);
    const after = fstatSync(fd);
    const namedAfter = lstatSync(configDir);
    if (
      !sameFile(before, after) ||
      !sameFile(after, namedAfter) ||
      !after.isDirectory() ||
      !ownedByCurrentUser(after) ||
      !privateMode(after)
    ) {
      throw new Error(`[ashlr] Config directory changed while securing it: ${configDir}`);
    }
    return { fd, stat: after };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

function secureExistingConfig(configPath: string): FileStat | undefined {
  let before: FileStat;
  try {
    before = lstatSync(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }

  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    Number(before.nlink) !== 1 ||
    !ownedByCurrentUser(before) ||
    !migratableMode(before)
  ) {
    throw new Error(`[ashlr] Refusing to replace unsafe config file: ${configPath}`);
  }

  if (process.platform === 'win32') return before;

  const fd = openSync(configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new Error(`[ashlr] Config file changed while opening it: ${configPath}`);
    }
    const after = fstatSync(fd);
    const namedAfter = lstatSync(configPath);
    if (
      !sameFile(before, after) ||
      !sameFile(after, namedAfter) ||
      !after.isFile() ||
      Number(after.nlink) !== 1 ||
      !ownedByCurrentUser(after) ||
      !migratableMode(after)
    ) {
      throw new Error(`[ashlr] Config file changed while securing it: ${configPath}`);
    }
    return after;
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('[ashlr] Config write made no progress');
    offset += written;
  }
}

function currentConfigMatches(configPath: string, expected: FileStat | undefined): boolean {
  try {
    const current = lstatSync(configPath);
    return expected !== undefined &&
      !current.isSymbolicLink() &&
      current.isFile() &&
      Number(current.nlink) === 1 &&
      ownedByCurrentUser(current) &&
      migratableMode(current) &&
      sameFile(expected, current);
  } catch (err) {
    return expected === undefined && (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Persist `c` to CONFIG_PATH as pretty-printed JSON.
 * Creates CONFIG_DIR if needed, then durably replaces the config through a
 * private, same-directory temporary file. Existing owner-controlled installs
 * with legacy read permissions are tightened in place before migration.
 */
export function saveConfig(c: AshlrConfig): void {
  const configDir = resolveConfigDir();
  const configPath = resolveConfigPath();
  const bytes = Buffer.from(JSON.stringify(c, null, 2) + '\n', 'utf8');
  const securedDirectory = secureConfigDirectory(configDir);
  const directory = securedDirectory.stat;
  const directoryFd = securedDirectory.fd;
  const lock = acquireLocalStoreLock(join(configDir, '.config-write.lock'));
  if (!lock) {
    if (directoryFd !== undefined) closeSync(directoryFd);
    throw new Error('[ashlr] Config is being updated by another process');
  }
  let tempFd: number | undefined;
  let tempPath: string | undefined;

  try {
    const existingConfig = secureExistingConfig(configPath);

    tempPath = join(configDir, `.config.json.${process.pid}.${randomUUID()}.tmp`);
    tempFd = openSync(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    if (process.platform !== 'win32') fchmodSync(tempFd, 0o600);
    const openedTemp = fstatSync(tempFd);
    if (!openedTemp.isFile() || Number(openedTemp.nlink) !== 1 || !ownedByCurrentUser(openedTemp) || !privateMode(openedTemp)) {
      throw new Error('[ashlr] Refusing to write unsafe config temporary file');
    }

    writeAll(tempFd, bytes);
    fsyncSync(tempFd);
    const writtenTemp = fstatSync(tempFd);
    const namedTemp = lstatSync(tempPath);
    const currentDirectory = lstatSync(configDir);
    if (
      writtenTemp.size !== bytes.length ||
      !sameFile(openedTemp, writtenTemp) ||
      Number(writtenTemp.nlink) !== 1 ||
      !ownedByCurrentUser(writtenTemp) ||
      !privateMode(writtenTemp) ||
      namedTemp.isSymbolicLink() ||
      !namedTemp.isFile() ||
      !sameFile(writtenTemp, namedTemp) ||
      !sameFile(directory, currentDirectory) ||
      !privateMode(currentDirectory) ||
      !currentConfigMatches(configPath, existingConfig)
    ) {
      throw new Error('[ashlr] Config paths changed during save');
    }

    closeSync(tempFd);
    tempFd = undefined;
    renameSync(tempPath, configPath);
    const installed = lstatSync(configPath);
    const directoryAfterRename = lstatSync(configDir);
    if (
      installed.isSymbolicLink() ||
      !installed.isFile() ||
      Number(installed.nlink) !== 1 ||
      !ownedByCurrentUser(installed) ||
      !sameFile(writtenTemp, installed) ||
      !privateMode(installed) ||
      !sameFile(directory, directoryAfterRename)
    ) {
      throw new Error('[ashlr] Config installation identity check failed');
    }
    tempPath = undefined;

    // Directory fsync is not supported by Windows; the atomic replacement is.
    if (directoryFd !== undefined) fsyncSync(directoryFd);
  } finally {
    if (tempFd !== undefined) {
      try { closeSync(tempFd); } catch { /* preserve the persistence error */ }
    }
    if (tempPath !== undefined) {
      try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    }
    releaseLocalStoreLock(lock);
    if (directoryFd !== undefined) {
      try { closeSync(directoryFd); } catch { /* all durable work is already complete */ }
    }
  }
}
