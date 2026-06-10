/**
 * Config + path constants for ashlr-hub.
 *
 * Handles reading, writing, and defaulting the ~/.ashlr/config.json file.
 * All ~ paths are expanded to the real homedir at module load time.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AshlrConfig, TidyRule } from './types.js';

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

/**
 * Persist `c` to CONFIG_PATH as pretty-printed JSON.
 * Creates CONFIG_DIR if it does not yet exist.
 */
export function saveConfig(c: AshlrConfig): void {
  const configDir = resolveConfigDir();
  const configPath = resolveConfigPath();

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const json = JSON.stringify(c, null, 2) + '\n';
  writeFileSync(configPath, json, 'utf8');
}
