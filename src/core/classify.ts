/**
 * classify.ts — cheap, synchronous heuristics for categorising Desktop items.
 *
 * Rules:
 *  - Never throw; return null / 'other' on any error.
 *  - Zero runtime deps (Node builtins only).
 *  - Synchronous everywhere — called in a tight scan loop.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import type { AshlrConfig, ItemKind } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the active config. We intentionally do NOT cache across calls:
 * `loadConfig()` reads a tiny JSON file and a stale cache would yield wrong
 * categories if the config changes between scans (or between tests). The cost
 * is negligible relative to the filesystem work each classify call already does.
 */
function cfg(): AshlrConfig {
  try {
    return loadConfig();
  } catch {
    // loadConfig unavailable / config missing — return a minimal default.
    return {
      version: 1,
      roots: [path.join(process.env['HOME'] ?? '/Users/masonwyatt', 'Desktop')],
      editor: 'cursor',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
    };
  }
}

/**
 * Inline `.git` detection — avoids a circular dep on git.ts (which may not
 * exist when classify.ts is compiled in isolation).
 */
function hasGitDir(dir: string): boolean {
  try {
    const gitPath = path.join(dir, '.git');
    const st = fs.lstatSync(gitPath);
    // .git is either a directory (normal clone) or a file (worktree/submodule)
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/** Read a file as UTF-8 text, return null on any error. */
function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Truncate a string to at most `max` characters (full words not required). */
function cap(s: string, max = 160): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// Known doc-category folder basenames (top-level Desktop directories that
// are NOT git repos and are NOT under github/).
// ---------------------------------------------------------------------------
const DOC_CATEGORY_FOLDERS = new Set([
  'Business',
  'Client-Work',
  'Product-Docs',
  'Knowledge',
  'Assets',
  'archive',
  // sub-folders users commonly have
  'CMP',
  'RDE',
  'Aether',
  'Chaos-Engine',
]);

// File extensions considered "documents".
const DOC_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.rst', '.pdf', '.docx', '.doc',
  '.pages', '.rtf', '.tex', '.org', '.adoc', '.asciidoc',
  '.html', '.htm', '.csv', '.xlsx', '.xls', '.json', '.yaml', '.yml',
  '.toml', '.ini', '.conf', '.env',
]);

// File extensions considered "assets" (images, media, fonts, …).
const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.flac', '.aac',
  '.m4a', '.ogg', '.otf', '.ttf', '.woff', '.woff2', '.eot',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.sketch', '.fig', '.xd', '.psd', '.ai',
]);

// ---------------------------------------------------------------------------
// categoryOf
// ---------------------------------------------------------------------------

/**
 * Return the category bucket for `itemPath`:
 *  - For a path under `github/<category>/<repo>` → the category name
 *    (e.g. "dev-tools", "side-projects").
 *  - For a path directly under the Desktop (or its known doc folders) →
 *    the top-level folder name (e.g. "Business", "Client-Work").
 *  - Otherwise → null.
 */
export function categoryOf(itemPath: string): string | null {
  try {
    const config = cfg();

    // 1. Check against configured categories map (category → absolute dir).
    //    A repo at /…/github/dev-tools/my-repo has itemPath that starts with
    //    the category dir.
    for (const [name, catDir] of Object.entries(config.categories)) {
      const normalCat = catDir.endsWith('/') ? catDir : catDir + '/';
      if (itemPath.startsWith(normalCat) || itemPath === catDir) {
        return name;
      }
    }

    // 2. Heuristic: detect github/<category> in path segments.
    //    Works even when categories map is empty (e.g. during first run).
    const parts = itemPath.split(path.sep);
    const githubIdx = parts.lastIndexOf('github');
    if (githubIdx !== -1 && githubIdx + 1 < parts.length) {
      const category = parts[githubIdx + 1];
      // Must be a known-style category (not a repo name) — the item itself
      // is at githubIdx+2 or deeper.
      if (category && githubIdx + 2 <= parts.length - 1) {
        return category;
      }
    }

    // 3. Top-level Desktop folder: if the item's parent matches a doc folder.
    //    Resolve the Desktop root explicitly rather than assuming roots[0] is
    //    the Desktop — roots[0] is typically '.../Desktop/github', which would
    //    make every relative path start with '..' and silently disable this
    //    heuristic. Prefer a root whose basename is 'Desktop', else strip a
    //    trailing '/github' from a github root, else fall back to HOME/Desktop.
    const desktop =
      config.roots.find((r) => path.basename(r) === 'Desktop') ??
      (() => {
        const gh = config.roots.find((r) => path.basename(r) === 'github');
        if (gh) return path.dirname(gh);
        return path.join(process.env['HOME'] ?? '', 'Desktop');
      })();
    const rel = path.relative(desktop, itemPath);
    if (!rel.startsWith('..') && rel !== '') {
      const topSegment = rel.split(path.sep)[0];
      if (topSegment && DOC_CATEGORY_FOLDERS.has(topSegment)) {
        return topSegment;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------

/**
 * Return a one-line description for `itemPath` (a directory or file):
 *  1. package.json "description" field (if present and non-empty).
 *  2. First H1 (`# …`) in README.md / README.markdown / README (stripped of `#`).
 *  3. First non-empty non-heading line in the README.
 *  4. null if none found.
 *
 * Capped at 160 characters.
 */
export function describe(itemPath: string): string | null {
  try {
    // Determine directory to search
    let dir: string;
    try {
      const st = fs.lstatSync(itemPath);
      dir = st.isDirectory() ? itemPath : path.dirname(itemPath);
    } catch {
      return null;
    }

    // 1. README first H1 (highest priority per contract).
    const readmeCandidates = [
      'README.md', 'README.markdown', 'README.txt', 'README.rst', 'README',
      'readme.md', 'Readme.md',
    ];

    for (const fname of readmeCandidates) {
      const text = readText(path.join(dir, fname));
      if (!text) continue;

      const lines = text.split('\n');
      for (const line of lines) {
        // Markdown H1: # Title
        const h1Match = line.match(/^#\s+(.+)/);
        if (h1Match && h1Match[1]) {
          const title = h1Match[1].trim();
          if (title) return cap(title);
        }
        // HTML H1: <h1>Title</h1> or <h1>Title (unclosed)
        const htmlH1Match = line.match(/<h1[^>]*>(.*?)<\/h1>/i)
          ?? line.match(/<h1[^>]*>([^<]+)/i);
        if (htmlH1Match && htmlH1Match[1]) {
          const title = htmlH1Match[1].trim();
          if (title) return cap(title);
        }
      }
      // README present but no H1 — stop scanning further README candidates;
      // fall through to package.json. (No body-line fallback by design.)
      break;
    }

    // 2. package.json "description" fallback.
    const pkgText = readText(path.join(dir, 'package.json'));
    if (pkgText) {
      try {
        const pkg = JSON.parse(pkgText) as Record<string, unknown>;
        if (typeof pkg['description'] === 'string' && pkg['description'].trim()) {
          return cap(pkg['description'].trim());
        }
      } catch {
        // malformed JSON — fall through
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// primaryLanguage
// ---------------------------------------------------------------------------

/** Extension → language name map for source-counting fallback. */
const EXT_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.swift': 'Swift',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.c': 'C',
  '.h': 'C',
  '.hpp': 'C++',
  '.php': 'PHP',
  '.lua': 'Lua',
  '.r': 'R',
  '.R': 'R',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.fish': 'Shell',
  '.dart': 'Dart',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.elm': 'Elm',
  '.hs': 'Haskell',
  '.clj': 'Clojure',
  '.scala': 'Scala',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
};

/**
 * Cheap heuristic language detection (no AST, no external tools):
 *  1. package.json present → JavaScript or TypeScript (check for .ts devDeps).
 *  2. Cargo.toml → Rust.
 *  3. pyproject.toml | requirements.txt | setup.py → Python.
 *  4. Package.swift → Swift.
 *  5. go.mod → Go.
 *  6. Gemfile | *.gemspec → Ruby.
 *  7. pom.xml | build.gradle → Java/Kotlin.
 *  8. Shallow directory scan — most common source extension wins.
 *  9. null if undetermined.
 */
export function primaryLanguage(itemPath: string): string | null {
  try {
    let dir: string;
    try {
      const st = fs.lstatSync(itemPath);
      if (st.isSymbolicLink()) return null;
      dir = st.isDirectory() ? itemPath : path.dirname(itemPath);
    } catch {
      return null;
    }

    // Helper: does a file exist in dir?
    const has = (fname: string): boolean => {
      try { fs.accessSync(path.join(dir, fname)); return true; } catch { return false; }
    };

    // 1. package.json → JS or TS
    if (has('package.json')) {
      // If there are .ts files or typescript in devDeps → TypeScript
      if (has('tsconfig.json') || has('tsconfig.base.json')) return 'TypeScript';
      const pkgText = readText(path.join(dir, 'package.json'));
      if (pkgText) {
        try {
          const pkg = JSON.parse(pkgText) as Record<string, unknown>;
          const allDeps = {
            ...(pkg['dependencies'] as Record<string, unknown> | undefined ?? {}),
            ...(pkg['devDependencies'] as Record<string, unknown> | undefined ?? {}),
          };
          if ('typescript' in allDeps) return 'TypeScript';
        } catch { /* fall through */ }
      }
      return 'JavaScript';
    }

    // 2. Rust
    if (has('Cargo.toml')) return 'Rust';

    // 3. Python
    if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('setup.cfg')) {
      return 'Python';
    }

    // 4. Swift
    if (has('Package.swift')) return 'Swift';

    // 5. Go
    if (has('go.mod')) return 'Go';

    // 6. Ruby
    if (has('Gemfile') || has('.gemspec')) return 'Ruby';

    // 7. Java / Kotlin
    if (has('pom.xml')) return 'Java';
    if (has('build.gradle') || has('build.gradle.kts')) {
      // build.gradle.kts → likely Kotlin
      return has('build.gradle.kts') ? 'Kotlin' : 'Java';
    }

    // 8. Shallow extension-frequency scan
    return dominantLanguageFromEntries(dir);
  } catch {
    return null;
  }
}

/** Count source extensions in a shallow directory listing and return the winner. */
function dominantLanguageFromEntries(dir: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const counts: Record<string, number> = {};

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ext || !(ext in EXT_LANGUAGE)) continue;
      counts[ext] = (counts[ext] ?? 0) + 1;
    }

    // Also do one level deeper (src/)
    const srcDir = path.join(dir, 'src');
    try {
      const srcEntries = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const entry of srcEntries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!ext || !(ext in EXT_LANGUAGE)) continue;
        // Weight src/ files slightly higher
        counts[ext] = (counts[ext] ?? 0) + 2;
      }
    } catch { /* src/ may not exist */ }

    let bestExt: string | null = null;
    let bestCount = 0;
    for (const [ext, count] of Object.entries(counts)) {
      if (count > bestCount) {
        bestCount = count;
        bestExt = ext;
      }
    }

    return bestExt ? (EXT_LANGUAGE[bestExt] ?? null) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// kindOf
// ---------------------------------------------------------------------------

/**
 * Determine the fundamental kind of `itemPath`:
 *  - 'symlink'    — lstat shows it's a symbolic link (checked first).
 *  - 'repo'       — directory that contains a .git entry.
 *  - 'doc-folder' — directory whose basename is a known doc-category folder.
 *  - 'doc'        — file with a document extension.
 *  - 'asset'      — file with an image/media/archive extension.
 *  - 'other'      — anything else.
 */
export function kindOf(itemPath: string): ItemKind {
  try {
    // Use lstat so we inspect the link itself, not its target.
    const st = fs.lstatSync(itemPath);

    // 1. Symlink — highest priority
    if (st.isSymbolicLink()) return 'symlink';

    if (st.isDirectory()) {
      // 2. Repo — has .git dir or file
      if (hasGitDir(itemPath)) return 'repo';

      // 3. Known doc-category folder
      const base = path.basename(itemPath);
      if (DOC_CATEGORY_FOLDERS.has(base)) return 'doc-folder';

      return 'other';
    }

    if (st.isFile()) {
      const ext = path.extname(itemPath).toLowerCase();

      // 4. Document
      if (DOC_EXTENSIONS.has(ext)) return 'doc';

      // 5. Asset
      if (ASSET_EXTENSIONS.has(ext)) return 'asset';

      return 'other';
    }

    return 'other';
  } catch {
    return 'other';
  }
}
