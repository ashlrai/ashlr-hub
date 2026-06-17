/**
 * examples/plugins/backlog-scanner/index.ts
 *
 * Reference plugin — M33 plugin system authoring example.
 *
 * WHAT IT DOES:
 *   Scans a repo for `FIXME(<owner>):` ownership-tagged comment lines using
 *   Node's built-in fs/readline. Each unique (file, owner, message) triple
 *   becomes one backlog WorkItem. Bounded: at most 100 items (the wrapper
 *   enforces this too, but we stop early to be a good citizen). Never throws.
 *
 * AUTHORING NOTES (see README.md):
 *   - Import types via '@ashlr/hub/plugin' in published plugins.
 *   - Use definePlugin() for full TypeScript checking.
 *   - Return plain WorkItem-shaped objects; the hub wrapper namespaces ids,
 *     recomputes score, clamps value/effort, scrubs secrets, and forces
 *     source:'plugin' — don't fight those transforms.
 *   - Respect the AbortSignal (ctx.signal) for timeout compliance.
 *   - Never throw from scan() — catch internally and return [] on error.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  AshlrPlugin,
  PluginHost,
  PluginContributions,
  PluginScanner,
} from '../../../src/core/plugins/types.js';
import { definePlugin } from '../../../src/core/plugins/types.js';
import type { WorkItem } from '../../../src/core/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Pattern: FIXME(<owner>): <message> — owner is [A-Za-z0-9_-]+ */
const FIXME_RE = /FIXME\(([A-Za-z0-9_-]+)\):\s*(.+)/;

/** File extensions to scan. */
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.md']);

/** Directories to skip. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv']);

/** Max files to read (prevents runaway on huge repos). */
const MAX_FILES = 500;

/** Value assigned to each FIXME item (medium importance — owner-tagged so it's known debt). */
const ITEM_VALUE = 3;

/** Effort assigned (investigating + fixing a tagged FIXME is moderate). */
const ITEM_EFFORT = 2;

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

/** Collect scannable files under dir, respecting SKIP_DIRS and MAX_FILES. */
function collectFiles(dir: string, signal: AbortSignal): string[] {
  const results: string[] = [];

  function walk(d: string): void {
    if (signal.aborted || results.length >= MAX_FILES) return;

    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (signal.aborted || results.length >= MAX_FILES) return;
      if (SKIP_DIRS.has(entry)) continue;

      const full = join(d, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const dot = entry.lastIndexOf('.');
        if (dot !== -1 && SCAN_EXTS.has(entry.slice(dot))) {
          results.push(full);
        }
      }
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const SCANNER_ID = 'fixme-ownership';

const fixmeOwnershipScanner: PluginScanner = {
  id: SCANNER_ID,

  async scan(repo: string, ctx: { signal: AbortSignal }): Promise<WorkItem[]> {
    try {
      const files = collectFiles(repo, ctx.signal);
      const items: WorkItem[] = [];
      const ts = new Date().toISOString();

      for (const filePath of files) {
        if (ctx.signal.aborted) break;
        if (items.length >= 100) break;

        let content: string;
        try {
          content = readFileSync(filePath, 'utf8');
        } catch {
          continue;
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (items.length >= 100) break;
          const line = lines[i] ?? '';
          const match = FIXME_RE.exec(line);
          if (!match) continue;

          const owner = match[1] ?? 'unknown';
          const message = (match[2] ?? '').trim();
          const relPath = relative(repo, filePath);
          const lineNum = i + 1;

          // Stable id: relative path + line number (unique within a repo)
          const rawId = `${relPath}:${lineNum}`;

          items.push({
            id: rawId,
            repo,
            // The wrapper forces this to 'plugin'; we set it correctly anyway
            // per the WorkItem contract.
            source: 'plugin',
            title: `FIXME(${owner}): ${message}`,
            detail: `${relPath}:${lineNum}`,
            value: ITEM_VALUE,
            effort: ITEM_EFFORT,
            // score is recomputed by the wrapper; 0 here is intentional
            score: 0,
            tags: ['fixme', owner],
            ts,
          });
        }
      }

      return items;
    } catch {
      // Never throw — return [] on any unexpected error
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// Plugin definition — using definePlugin() for full TypeScript checking
// ---------------------------------------------------------------------------

const backlogScannerPlugin: AshlrPlugin = definePlugin({
  activate(_host: PluginHost): PluginContributions {
    _host.log('backlog-scanner activated');
    return {
      scanners: [fixmeOwnershipScanner],
    };
  },
});

export default backlogScannerPlugin;
