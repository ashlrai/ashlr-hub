/**
 * index-reader.ts
 *
 * Reads ~/.ashlr/index.json for the Raycast extension.
 *
 * The key difference from index.ts (which provides a synchronous loadIndex):
 *  - readIndex() is async and auto-triggers `ashlr index` when the file is
 *    missing or older than 10 minutes, then re-reads the fresh result.
 *  - attentionItems() and byCategory() are derived-data helpers for commands
 *    that need sliced/sorted views without re-computing them in every command.
 *
 * Does NOT import from the root workspace — types are pulled from types.ts
 * which lives alongside this file in the Raycast package.
 */

import { execFile as execFileCb } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AshlrIndex, IndexedItem } from "./types.js";

const execFile = promisify(execFileCb);

/** Absolute path to the index file produced by `ashlr index`. */
const INDEX_PATH = join(homedir(), ".ashlr", "index.json");

/** Age threshold in ms — rebuild the index if it is older than this. */
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when a rebuild is needed because the index is missing or stale.
 */
function needsRebuild(): boolean {
  try {
    const st = statSync(INDEX_PATH);
    return Date.now() - st.mtimeMs > MAX_AGE_MS;
  } catch {
    // ENOENT or any other stat error — file doesn't exist yet
    return true;
  }
}

/**
 * Run `ashlr index` to regenerate ~/.ashlr/index.json.
 * Tries the resolved PATH entry first, then the documented install location
 * (~/.local/bin/ashlr). Throws if neither binary succeeds within 60 s.
 */
async function rebuildIndex(): Promise<void> {
  const candidates = ["ashlr", join(homedir(), ".local", "bin", "ashlr")];

  let lastError: Error | null = null;
  for (const bin of candidates) {
    try {
      await execFile(bin, ["index"], {
        timeout: 60_000,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      });
      return; // success — stop trying
    } catch (err) {
      lastError = err as Error;
    }
  }

  throw lastError ?? new Error("ashlr binary not found — cannot rebuild index");
}

/**
 * Parse the index from disk.
 * Throws on missing file, JSON parse errors, or unexpected shape.
 */
function parseIndex(): AshlrIndex {
  const raw = readFileSync(INDEX_PATH, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)["version"] !== "number" ||
    !Array.isArray((parsed as Record<string, unknown>)["items"])
  ) {
    throw new Error(`Malformed or empty index at ${INDEX_PATH}`);
  }
  return parsed as AshlrIndex;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the Ashlr index, rebuilding it via `ashlr index` if it is missing or
 * older than 10 minutes.
 *
 * @throws When the rebuild fails AND the index cannot subsequently be read.
 */
export async function readIndex(): Promise<AshlrIndex> {
  if (needsRebuild()) {
    await rebuildIndex();
  }
  return parseIndex();
}

/**
 * Surface items that need the developer's attention:
 *  - Repos with uncommitted changes (git.dirty > 0)
 *  - Repos ahead of their upstream (git.ahead > 0)
 *  - Stale repos (active === false) that still have git state
 *
 * Symlinks are always excluded. Results are sorted by dirty-file count
 * descending, then by lastModified descending.
 */
export function attentionItems(idx: AshlrIndex): IndexedItem[] {
  return idx.items
    .filter((item) => {
      if (item.kind === "symlink") return false;
      if (item.git) {
        if (item.git.dirty > 0) return true;
        if (item.git.ahead > 0) return true;
        if (!item.active) return true; // stale repo with known git state
      }
      return false;
    })
    .sort((a, b) => {
      const dirtyDiff = (b.git?.dirty ?? 0) - (a.git?.dirty ?? 0);
      if (dirtyDiff !== 0) return dirtyDiff;
      return b.lastModified.localeCompare(a.lastModified);
    });
}

/**
 * Group all indexed items by their `category` field.
 * Items with category === null are placed under the key "__uncategorized__".
 * Each group is sorted alphabetically by item name for stable display.
 */
export function byCategory(idx: AshlrIndex): Record<string, IndexedItem[]> {
  const groups: Record<string, IndexedItem[]> = {};

  for (const item of idx.items) {
    const key = item.category ?? "__uncategorized__";
    (groups[key] ??= []).push(item);
  }

  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.name.localeCompare(b.name));
  }

  return groups;
}
