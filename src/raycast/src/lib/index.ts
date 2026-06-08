/**
 * Load the ashlr-hub index from ~/.ashlr/index.json.
 *
 * Raycast commands never re-scan the filesystem; they read the pre-built
 * index produced by `ashlr index`. This module is the single entry point
 * for that data inside the Raycast extension.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AshlrIndex } from "./types.js";

/** Absolute path to the index file written by the CLI. */
const INDEX_PATH = join(homedir(), ".ashlr", "index.json");

/**
 * Read and parse ~/.ashlr/index.json.
 *
 * Returns null when:
 *  - the file does not exist (CLI has never run `ashlr index`)
 *  - the file is not valid JSON
 *  - the parsed value does not look like an AshlrIndex
 */
export function loadIndex(): AshlrIndex | null {
  try {
    const raw = readFileSync(INDEX_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isAshlrIndex(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Cheap structural guard — not a full validator, just enough to fail fast. */
function isAshlrIndex(v: unknown): v is AshlrIndex {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["version"] === "number" &&
    typeof obj["generatedAt"] === "string" &&
    typeof obj["root"] === "string" &&
    Array.isArray(obj["items"])
  );
}
