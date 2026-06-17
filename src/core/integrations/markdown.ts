/**
 * M68: ashlr-md rendering integration — opt-in, best-effort, never-throws.
 *
 * When ashlr-md (https://github.com/ashlrai/ashlr-md) is installed, operators
 * can open generated Markdown (proposals, digests, specs) in the beautiful
 * AI-native viewer instead of receiving a raw terminal dump.
 *
 * The integration is strictly additive:
 *   - When ashlr-md is absent, every function degrades gracefully: no error,
 *     no side-effect, caller receives ok:false / rendered:false and falls back
 *     to its own terminal output.
 *   - When ashlr-md IS present, a temp .md file is written to
 *     ~/.ashlr/tmp (or os.tmpdir() as fallback) and opened via `mdopen <file>`.
 *     The spawn is detached and unref()d — it never blocks the hub process.
 *
 * CLI command confirmed from ashlr-md's install.sh:
 *   mdopen <path-to-file.md>
 * Installed to /usr/local/bin/mdopen or ~/.local/bin/mdopen by the ashlr-md
 * installer script.
 *
 * Seam: `ashlr inbox` / `ashlr digest` will call `presentMarkdown(title, body)`
 * and fall back to their existing terminal rendering when rendered === false.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Timeout (ms) for the `which mdopen` probe. Must be short — it's synchronous. */
const WHICH_TIMEOUT_MS = 2_000;

/**
 * Returns true when `mdopen` is on PATH (i.e. ashlr-md CLI is installed).
 * Never throws.
 */
export function ashlrMdInstalled(): boolean {
  try {
    execFileSync('which', ['mdopen'], {
      timeout: WHICH_TIMEOUT_MS,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a .md file in the ashlr-md viewer (detached, non-blocking).
 *
 * Returns { ok: true } when the spawn is successfully started, or
 * { ok: false, detail: <reason> } when ashlr-md is not installed or the
 * spawn fails. Never throws.
 *
 * The child process is detached and unref()d: it outlives the hub process
 * (the user sees the GUI window) without keeping the event loop alive.
 */
export function openInAshlrMd(filePath: string): { ok: boolean; detail: string } {
  if (!ashlrMdInstalled()) {
    return { ok: false, detail: 'mdopen not found on PATH — ashlr-md not installed' };
  }

  try {
    const child = spawn('mdopen', [filePath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, detail: `opened ${filePath} in ashlr-md` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `mdopen spawn failed: ${msg}` };
  }
}

/**
 * Write a Markdown document to a temp file and return its path.
 *
 * Writes to ~/.ashlr/tmp/ (created on demand) with a timestamp-based name so
 * multiple calls don't collide. Falls back to os.tmpdir() if the ashlr dir
 * cannot be created. Returns null on any write failure. Never throws.
 */
export function renderToTempMarkdown(title: string, body: string): string | null {
  try {
    // Prefer ~/.ashlr/tmp so files land in a predictable, inspectable place.
    let dir: string;
    try {
      dir = join(homedir(), '.ashlr', 'tmp');
      mkdirSync(dir, { recursive: true });
    } catch {
      dir = tmpdir();
    }

    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'ashlr-doc';
    const ts = Date.now();
    // Add a random suffix so two calls in the same millisecond never collide.
    const rand = Math.random().toString(36).slice(2, 8);
    const filename = `${slug}-${ts}-${rand}.md`;
    const filePath = join(dir, filename);

    const content = `# ${title}\n\n${body}\n`;
    writeFileSync(filePath, content, 'utf8');
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Write a temp Markdown file and open it in ashlr-md if installed.
 *
 * This is the primary seam for `ashlr inbox` / `ashlr digest`. Callers should
 * check `rendered` and fall back to terminal output when false.
 *
 * @returns
 *   - { rendered: true,  path: string, detail: string } — file written + viewer launched
 *   - { rendered: false, path: string, detail: string } — file written but viewer absent/failed
 *   - { rendered: false, detail: string }               — temp write failed
 */
export function presentMarkdown(
  title: string,
  body: string,
): { rendered: boolean; path?: string; detail: string } {
  const path = renderToTempMarkdown(title, body);
  if (path === null) {
    return { rendered: false, detail: 'failed to write temp markdown file' };
  }

  const result = openInAshlrMd(path);
  return {
    rendered: result.ok,
    path,
    detail: result.detail,
  };
}
