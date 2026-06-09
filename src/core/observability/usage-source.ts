/**
 * usage-source.ts — local-first UsageEvent collector (M5 observability).
 *
 * PRIVACY GUARDRAILS: reads ONLY token counts, model id, timestamp, and the
 * project path (decoded from the encoded dir name). Never reads or retains
 * message content, tool args/results, prompts, or completions.
 *
 * PERFORMANCE: streams line-by-line; skips files whose mtime is older than
 * sinceMs; tolerates malformed lines; never throws.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { UsageEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Absolute path to ~/.claude/projects (honors $HOME). */
export function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Decode an encoded Claude Code project dir name back to an absolute path.
 *
 * Claude encodes the absolute path by replacing the leading `/` with a `-`
 * and then replacing every subsequent `/` with `-`. For example:
 *   '-Users-you-Desktop-foo' -> '/Users/you/Desktop/foo'
 *
 * This is lossy for path segments that naturally contain `-`, but we do
 * the best-effort reconstruction by:
 *   1. Stripping the leading `-`
 *   2. Re-prefixing with `/`
 *   3. Replacing remaining `-` with `/`
 *
 * The result is a plausible absolute path suitable for display/grouping.
 */
export function decodeProjectPath(dirName: string): string {
  // Remove leading dash (represents the leading `/` of an absolute path)
  const withoutLeadingDash = dirName.startsWith("-")
    ? dirName.slice(1)
    : dirName;
  // Re-add leading slash and replace dashes with path separators
  return "/" + withoutLeadingDash.replace(/-/g, "/");
}

/**
 * Collapse a real absolute path to the dash-normalized form Claude uses to
 * encode project dir names: every `/` AND every `-` becomes `-`.
 *
 * Both the real path '/Users/x/dev-tools/ashlr-hub' and its lossy decode
 * '/Users/x/dev/tools/ashlr/hub' normalize to the SAME string
 * '-Users-x-dev-tools-ashlr-hub'. That makes dashNormalize a reliable join key
 * between the index's REAL paths and the transcript's MANGLED decoded paths,
 * which recovers correct grouping/labels for any repo whose name has a dash.
 */
export function dashNormalize(absPath: string): string {
  return absPath.replace(/[/-]/g, "-");
}

/**
 * Resolve a (possibly mangled) decoded project path against known real paths
 * from the index. Returns the matching real path when the dash-normalized
 * forms agree, otherwise returns the input unchanged (best-effort decode).
 *
 * `realByNorm` maps dashNormalize(realPath) -> realPath and is built once by
 * the caller so this stays O(1) per event.
 */
export function reconcileProjectPath(
  decodedPath: string,
  realByNorm: Map<string, string>,
): string {
  const match = realByNorm.get(dashNormalize(decodedPath));
  return match ?? decodedPath;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Chunk size for the streaming reader (64 KiB). */
const READ_CHUNK = 64 * 1024;
/**
 * Hard cap on bytes scanned per transcript (256 MiB). Transcripts can be
 * hundreds of MB; this bounds worst-case work while still covering any
 * realistic session. Peak memory stays ~one chunk + one line regardless.
 */
const MAX_BYTES_PER_FILE = 256 * 1024 * 1024;

/**
 * Read a file line-by-line with BOUNDED memory, calling cb for each non-empty
 * line. Instead of readFileSync + split (which loads the whole file as a string
 * AND a full line array — pathological for 100+ MB transcripts), we pull fixed
 * 64 KiB chunks via fs.readSync and split on newlines incrementally, carrying a
 * partial-line buffer across chunk boundaries. Peak memory is ~one chunk plus
 * one line, not the whole file. Never throws.
 */
function eachLine(filePath: string, cb: (line: string) => void): void {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return; // unreadable — skip silently
  }

  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    let pending = ""; // partial line carried across chunk boundaries
    let bytesRead = 0;

    for (;;) {
      let n: number;
      try {
        n = fs.readSync(fd, chunk, 0, READ_CHUNK, null);
      } catch {
        break; // read error — stop, keep whatever we collected
      }
      if (n <= 0) break; // EOF
      bytesRead += n;

      pending += chunk.toString("utf8", 0, n);

      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line.length > 0) cb(line);
      }

      // Bound total work per file.
      if (bytesRead >= MAX_BYTES_PER_FILE) break;
    }

    // Flush any trailing line without a newline.
    const last = pending.trim();
    if (last.length > 0) cb(last);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

/** Extract a UsageEvent from a parsed JSONL line, or null if not applicable. */
function extractClaudeEvent(
  raw: unknown,
  project: string,
  sinceMs: number
): UsageEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  // Only process assistant-type events
  if (obj["type"] !== "assistant") return null;

  // Timestamp lives at top level
  const ts = typeof obj["timestamp"] === "string" ? obj["timestamp"] : null;
  if (!ts) return null;

  // Filter by window early
  try {
    if (new Date(ts).getTime() < sinceMs) return null;
  } catch {
    return null;
  }

  // Model and usage are nested under `message`
  const message = obj["message"];
  if (typeof message !== "object" || message === null) return null;
  const msg = message as Record<string, unknown>;

  const model = typeof msg["model"] === "string" ? msg["model"] : "";
  if (!model) return null;

  const usage = msg["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;

  // PRIVACY: extract ONLY the four numeric token counts — nothing else
  const tokensIn = typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0;
  const tokensOut =
    typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0;
  const cacheRead =
    typeof u["cache_read_input_tokens"] === "number"
      ? u["cache_read_input_tokens"]
      : 0;
  const cacheWrite =
    typeof u["cache_creation_input_tokens"] === "number"
      ? u["cache_creation_input_tokens"]
      : 0;

  // Skip events with zero useful usage (e.g. pure-tool events)
  if (tokensIn === 0 && tokensOut === 0) return null;

  return {
    ts,
    project,
    model,
    source: "claude",
    tokensIn,
    tokensOut,
    cacheRead,
    cacheWrite,
  };
}

// ---------------------------------------------------------------------------
// Claude Code transcript ingestion
// ---------------------------------------------------------------------------

function collectClaudeEvents(sinceMs: number): UsageEvent[] {
  const events: UsageEvent[] = [];
  const projectsRoot = claudeProjectsDir();

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return events; // ~/.claude/projects doesn't exist or isn't readable
  }

  for (const dirName of projectDirs) {
    const dirPath = path.join(projectsRoot, dirName);
    const project = decodeProjectPath(dirName);

    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(dirPath, entry.name);

      // Performance: skip files that haven't been modified since our window
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }

      // Stream line-by-line; PRIVACY: parse only; never retain content
      eachLine(filePath, (line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return; // malformed line — skip silently
        }
        const event = extractClaudeEvent(parsed, project, sinceMs);
        if (event) events.push(event);
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// M4 run record ingestion
// ---------------------------------------------------------------------------

function collectRunEvents(sinceMs: number): UsageEvent[] {
  const events: UsageEvent[] = [];
  const runsDir = path.join(os.homedir(), ".ashlr", "runs");

  let files: string[];
  try {
    files = fs.readdirSync(runsDir);
  } catch {
    return events; // no runs dir — fine
  }

  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(runsDir, name);

    // Performance: skip files older than window
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < sinceMs) continue;
    } catch {
      continue;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    let run: unknown;
    try {
      run = JSON.parse(raw);
    } catch {
      continue; // malformed — skip
    }

    if (typeof run !== "object" || run === null) continue;
    const r = run as Record<string, unknown>;

    // Validate createdAt is within window
    const ts = typeof r["createdAt"] === "string" ? r["createdAt"] : null;
    if (!ts) continue;
    try {
      if (new Date(ts).getTime() < sinceMs) continue;
    } catch {
      continue;
    }

    const model =
      typeof r["provider"] === "string" ? r["provider"] : "unknown";

    // Extract ONLY the numeric usage fields
    const usage = r["usage"];
    if (typeof usage !== "object" || usage === null) continue;
    const u = usage as Record<string, unknown>;

    const tokensIn =
      typeof u["tokensIn"] === "number" ? u["tokensIn"] : 0;
    const tokensOut =
      typeof u["tokensOut"] === "number" ? u["tokensOut"] : 0;

    if (tokensIn === 0 && tokensOut === 0) continue;

    events.push({
      ts,
      project: null,
      model,
      source: "run",
      tokensIn,
      tokensOut,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect normalized UsageEvents from all local sources with ts >= sinceMs.
 *
 * Sources:
 *   (a) ~/.claude/projects/<encoded-dir>/*.jsonl  — METADATA ONLY
 *   (b) ~/.ashlr/runs/*.json  — M4 RunState records
 *
 * Streams line-by-line; skips files older than sinceMs by mtime; tolerates
 * malformed lines; never reads message content. Never throws.
 */
export function collectUsageEvents(sinceMs: number): UsageEvent[] {
  try {
    const claude = collectClaudeEvents(sinceMs);
    const runs = collectRunEvents(sinceMs);
    return [...claude, ...runs];
  } catch {
    return []; // belt-and-suspenders: top-level guard
  }
}
