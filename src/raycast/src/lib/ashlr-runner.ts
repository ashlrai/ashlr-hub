/**
 * ashlr-runner.ts — shared helpers for the Raycast extension.
 *
 * Provides:
 *  - resolveAshlr()      : locate the `ashlr` binary
 *  - runAshlrJson()      : spawn `ashlr <args> --json` and parse the result
 *  - readJsonFile()      : read + parse any ~/.ashlr/*.json file (best-effort)
 *  - useAutoRevalidate() : React hook that calls a revalidate fn on an interval
 *
 * Zero new runtime dependencies — Node builtins + @raycast/api only.
 */

import { execFile as execFileCb, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { useEffect, useRef } from "react";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

const ASHLR_CANDIDATES = [
  join(homedir(), ".local", "bin", "ashlr"),
  "/usr/local/bin/ashlr",
  "/opt/homebrew/bin/ashlr",
  "ashlr",
];

let _resolved: string | null = null;

/**
 * Locate the `ashlr` binary. Tries known install locations first, then falls
 * back to the bare name (relies on PATH). Result is cached for the lifetime of
 * the extension process.
 */
export function resolveAshlr(): string {
  if (_resolved !== null) return _resolved;
  for (const candidate of ASHLR_CANDIDATES) {
    if (candidate === "ashlr") {
      _resolved = candidate;
      return _resolved;
    }
    try {
      execFileSync("test", ["-f", candidate], { timeout: 500 });
      _resolved = candidate;
      return _resolved;
    } catch {
      // not at this path, try next
    }
  }
  _resolved = "ashlr";
  return _resolved;
}

// ---------------------------------------------------------------------------
// JSON subprocess runner
// ---------------------------------------------------------------------------

export interface RunResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Spawn `ashlr <args>` and parse stdout as JSON of type T.
 *
 * The subprocess is given a PATH that includes ~/.local/bin so the binary is
 * found even when Raycast is launched outside a shell session.
 *
 * Resolves with { ok: false, error } on any failure; never rejects.
 */
export async function runAshlrJson<T>(
  args: string[],
  timeoutMs = 30_000,
): Promise<RunResult<T>> {
  const bin = resolveAshlr();
  const env = {
    ...process.env,
    PATH: `${join(homedir(), ".local", "bin")}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };

  try {
    const { stdout, stderr } = await execFile(bin, args, {
      timeout: timeoutMs,
      env,
    });
    const out = stdout.trim();
    if (!out) {
      return {
        ok: false,
        error: `ashlr ${args[0]} produced no output. ${stderr.trim()}`,
      };
    }
    try {
      const data = JSON.parse(out) as T;
      return { ok: true, data };
    } catch {
      return {
        ok: false,
        error: `Failed to parse JSON from ashlr ${args[0]}: ${out.slice(0, 200)}`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not run ashlr: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// JSON file reader
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file at `filePath`. Returns null on any error (missing
 * file, bad JSON, etc.) — never throws.
 */
export function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Convenience: read ~/.ashlr/<name>.json.
 */
export function readAshlrFile<T>(name: string): T | null {
  return readJsonFile<T>(join(homedir(), ".ashlr", name));
}

// ---------------------------------------------------------------------------
// Auto-revalidate hook
// ---------------------------------------------------------------------------

/**
 * useAutoRevalidate — calls `revalidate()` on a repeating interval.
 *
 * @param revalidate  Function to call on each tick (e.g. from usePromise).
 * @param intervalMs  Milliseconds between ticks (default 2000).
 * @param enabled     Set false to pause (default true).
 */
export function useAutoRevalidate(
  revalidate: () => void,
  intervalMs = 2_000,
  enabled = true,
): void {
  const revalidateRef = useRef(revalidate);
  revalidateRef.current = revalidate;

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => revalidateRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
}
