/**
 * M42: Native engineering tool surface — REAL, sandboxed tools for the hub's
 * local-model agent loop.
 *
 * The hub loop (src/core/run/agent-loop.ts) only EXECUTES a tool spec that
 * carries a callable `fn` (it builds toolExecutors from `spec.fn`). The native
 * gateway tools from `listNativeTools()` ship NO `fn`, so they were dead in the
 * loop. This module fixes that two ways:
 *   1. `buildEngineerToolSpecs(eng)` — NEW read/write/exec tools (read_file,
 *      glob, grep, write_file, edit_file, bash), each wrapped with a `fn` that
 *      runs through `callEngineerTool` (the gated pipeline below).
 *   2. `buildNativeToolSpecsWithFn()` — wraps the existing 11 native tools so
 *      they are executable in-process via `callNativeTool`.
 *
 * SECURITY MODEL — defense in depth, in order of authority:
 *   1. WORKSPACE BOUNDARY (the primary spine): every path is resolved with
 *      `resolveInside(root, p)`, which realpath-resolves both the root and the
 *      target and refuses anything that is not the root itself or a descendant
 *      of `root + sep`. `workspaceRoot` is an absolute sandbox worktree path —
 *      NEVER `/` or `~`. A symlink that points outside the root is rejected
 *      because realpath resolves it before the prefix check.
 *   2. KILL SWITCH + ENROLLMENT (reused, NOT reinvented): every mutating tool
 *      calls `assertMayMutate(eng.sourceRepo, { allowAnyRepo: true })`, which
 *      ALWAYS throws when ~/.ashlr/KILL is present and (unless the test env seam
 *      ASHLR_TEST_ALLOW_ANY_REPO=1 is set) when the repo is not enrolled.
 *      `callEngineerTool` also refuses non-read tools when the kill switch is on
 *      BEFORE loading config or running a handler.
 *   3. COMMAND DENY-LIST (`assertCommandAllowed`): a best-effort guard against
 *      egress / destructive shell verbs. This is DEFENSE IN DEPTH only — the
 *      worktree boundary + kill-switch + minimal env are the real containment.
 *   4. MINIMAL ENV (`minimalEnv`): `bash` spawns with a hand-built env (PATH +
 *      a scratch HOME under os.tmpdir() + LANG) merged with ashlr's NON-SECRET
 *      keys via `withToolEnv`. The full `process.env` (and thus any API keys it
 *      carries) is NEVER handed to the shell.
 *
 * Every tool result is rendered through `renderToolText` (serialize + scrub
 * secrets + 32KB cap), and every call (ok / refused / error) is audited as
 * 'mcp:engineer-call'. `callEngineerTool` NEVER throws — failures surface as
 * error text the model can read.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve, sep, join, relative, basename, dirname } from 'node:path';

import type { AshlrConfig, NativeToolSafety } from './types.js';
import { loadConfig } from './config.js';
import {
  renderToolText,
  listNativeTools,
  callNativeTool,
} from './mcp-native.js';
import { assertMayMutate, killSwitchOn } from './sandbox/policy.js';
import { audit } from './sandbox/audit.js';
import { withToolEnv } from './env-bridge.js';
import { applyEdit } from './run/diff.js';
import { detectVerifyCommands, runVerifyCommandAsync } from './run/verify-commands.js';

// ---------------------------------------------------------------------------
// Constants — bounds keep a tool reply from blowing agent context.
// ---------------------------------------------------------------------------

/** Max bytes read by read_file in a single call (renderToolText caps again). */
const MAX_READ_BYTES = 256 * 1024;
/**
 * Hard ceiling on the on-disk size of a file read_file will load into memory.
 * Checked via statSync BEFORE readFileSync so a multi-GB file is refused rather
 * than OOMing the process (the line-window cap above only applies AFTER the
 * whole file is already in memory).
 */
const MAX_READ_FILE_BYTES = 1024 * 1024;

/**
 * Basenames that look like secrets material — read_file refuses them and the JS
 * grep fallback silently skips them. The knowledge indexer
 * (src/core/knowledge/index.ts) defines its own SECRET_FILENAME_RE / SECRET_FILES
 * but does NOT export them, so this is a deliberate local equivalent kept in sync
 * with that intent: .env*, *.pem, *.key, id_rsa, *.p12, *.pfx, credentials, secret.
 */
const SECRET_FILE_RE = /(^\.env)|(\.pem$)|(\.key$)|(id_rsa)|(\.p12$)|(\.pfx$)|credentials|secret/i;
/** Max matched paths returned by glob. */
const MAX_GLOB_RESULTS = 500;
/** Max files the JS grep fallback will scan. */
const MAX_GREP_FILES = 2000;
/** Max bytes of a single file the JS grep fallback will read. */
const MAX_GREP_FILE_BYTES = 512 * 1024;
/** Max matched lines grep returns. */
const MAX_GREP_LINES = 1000;
/** Hard byte cap on combined bash stdout+stderr capture (raw). */
const MAX_BASH_OUTPUT_BYTES = 256 * 1024;
/** Default bash timeout (ms) and clamp bounds. */
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MIN_BASH_TIMEOUT_MS = 1;
const MAX_BASH_TIMEOUT_MS = 600_000;

/** Directory names the file walkers never descend into. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
  'coverage', '__pycache__', '.cache', 'vendor', 'out', '.output',
  '.vercel', '.serverless', 'target', '.yarn',
]);

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The agent's engineering context: the absolute sandbox worktree it may read /
 * write / exec within, the source repo used for the kill-switch + enrollment
 * gate, and the per-session capability flags.
 *
 * `workspaceRoot` MUST be an absolute path to a real sandbox worktree directory
 * — NEVER `/` or `~`. Callers create it (a git worktree / tmp checkout) before
 * constructing the context.
 */
export interface EngineerContext {
  /** Absolute root the agent may read/write/exec within (a sandbox worktree). */
  workspaceRoot: string;
  /** Source repo path used for the assertMayMutate (kill-switch + enrollment) gate. */
  sourceRepo: string;
  /** Whether write_file / edit_file are permitted this session. */
  allowWrite: boolean;
  /** Whether bash is permitted this session. */
  allowExec: boolean;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Clamp `n` into [min, max]. NaN/non-finite collapses to `min`. */
export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * The security spine: resolve `p` relative to `root` and refuse anything that
 * escapes the workspace boundary. Both the root and the target are realpath-
 * resolved so a symlink can never lead outside the worktree.
 *
 * For a NOT-YET-EXISTING target (e.g. a new file for write_file) a purely
 * lexical resolve is NOT enough: a symlinked intermediate directory (the model
 * does `ln -s /victim/.ssh evil` then `write_file('evil/authorized_keys', …)`)
 * would escape because `resolve` never touches the filesystem. So we walk up to
 * the NEAREST EXISTING ANCESTOR and canonicalize THAT (resolving any symlinked
 * parent), then re-append the non-existing tail to the canonical base before the
 * boundary check.
 */
function resolveInside(root: string, p: string): string {
  // Canonicalize the root FIRST so the lexical join below is already in the
  // realpath namespace (on macOS os.tmpdir() lives under /var -> /private/var,
  // so resolving against the raw root and a canonical root never match for a
  // not-yet-existing target).
  const realRoot = realpathSync(root);
  const abs = resolve(realRoot, p);
  // Walk up to the nearest existing ancestor and canonicalize THAT (resolves any
  // symlinked parent), then re-append the non-existing tail to the canonical base.
  let probe = abs;
  while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
  const realProbe = realpathSync(probe);
  const tail = relative(probe, abs);
  const realAbs = tail ? join(realProbe, tail) : realProbe;
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) {
    throw new Error(`path escapes workspace boundary: ${p}`);
  }
  return realAbs;
}

/** True when `dir` is (or sits within) a git repo we can `git grep` in. */
function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A scratch HOME under os.tmpdir() for spawned shells — so a tool can never
 * read or clobber the real user home, and never inherit dotfile-sourced env.
 * Created once per process; best-effort (falls back to tmpdir root). The dir is
 * guaranteed to exist (mkdirSync recursive) so Windows tools that demand a real
 * USERPROFILE/TEMP do not fail.
 */
let scratchHomeCache: string | null = null;
function scratchHome(): string {
  if (scratchHomeCache && existsSync(scratchHomeCache)) return scratchHomeCache;
  try {
    scratchHomeCache = mkdtempSync(join(tmpdir(), 'ashlr-engineer-home-'));
  } catch {
    scratchHomeCache = tmpdir();
  }
  // Defensive: ensure the scratch home really exists on disk.
  try {
    mkdirSync(scratchHomeCache, { recursive: true });
  } catch {
    /* best-effort; tmpdir() itself always exists */
  }
  return scratchHomeCache;
}

/**
 * Build the MINIMAL, cross-platform env for a spawned shell. Deliberately does
 * NOT pass the full process.env — that would leak ANTHROPIC_API_KEY and friends
 * to the shell. The full process.env (and any API keys it carries) is NEVER
 * handed to the shell; ashlr's non-secret config keys are layered on by the
 * caller via withToolEnv.
 *
 * Always carried: PATH and a scratch home dir under os.tmpdir().
 *   - posix: HOME = scratch, LANG = process.env.LANG ?? 'C'.
 *   - win32: USERPROFILE = scratch, plus the handful of system vars Windows
 *     tools genuinely NEED to function (SystemRoot/windir/COMSPEC/PATHEXT/…)
 *     and TEMP/TMP pointed AT the scratch dir. No secrets are passed through.
 */
export function minimalEnv(): NodeJS.ProcessEnv {
  // Windows uses `Path`; POSIX uses `PATH`. Tolerate either source key.
  const path = process.env.PATH ?? process.env.Path ?? '';
  const scratch = scratchHome();

  if (process.platform === 'win32') {
    const env: NodeJS.ProcessEnv = {
      PATH: path,
      USERPROFILE: scratch,
      TEMP: scratch,
      TMP: scratch,
    };
    // Pass through ONLY the non-secret system vars Windows tools need to run.
    // (cmd.exe, PowerShell, and most native tools fail without SystemRoot.)
    const passthrough = [
      'SYSTEMROOT',
      'SystemRoot',
      'windir',
      'PATHEXT',
      'COMSPEC',
      'NUMBER_OF_PROCESSORS',
      'PROCESSOR_ARCHITECTURE',
    ];
    for (const key of passthrough) {
      const val = process.env[key];
      if (val !== undefined) env[key] = val;
    }
    return env;
  }

  return {
    PATH: path,
    HOME: scratch,
    LANG: process.env.LANG ?? 'C',
  };
}

// ---------------------------------------------------------------------------
// Command deny-list (DEFENSE IN DEPTH — not the primary boundary)
// ---------------------------------------------------------------------------

/**
 * Refuse a bash command that matches an egress / destructive / privilege verb.
 *
 * This is intentionally a coarse, defense-in-depth guard layered ON TOP of the
 * real containment (workspace boundary + kill-switch + minimal env). It is NOT
 * meant to be a complete shell parser — a determined adversary can obfuscate
 * around any deny-list, which is exactly why the boundary + minimal env (no
 * secrets, scratch HOME, cwd pinned to the worktree) are the load-bearing
 * controls. Throws with a clear message on a match.
 *
 * NOTE: `bash` grants local code execution WITH network access; it must only be
 * enabled (`--bash` / eng.allowExec) for goals you trust. This deny-list reduces
 * the blast radius of an obviously-hostile command but is NOT the security
 * boundary and must never be relied on as one.
 */
export function assertCommandAllowed(command: string): void {
  const cmd = command.trim();
  const lower = cmd.toLowerCase();

  // Network egress: curl/wget (incl. the Windows curl.exe / wget.exe) are
  // allowed ONLY when the target URL's host is exactly localhost / 127.0.0.1 /
  // ::1. A naive substring check is bypassable (`http://localhost@evil.com`,
  // `http://127.0.0.1.evil.com`), so parse the URL and compare the real
  // hostname. `\bcurl\b` / `\bwget\b` also match `curl.exe` / `wget.exe`
  // (the `.` is a word boundary), so the Windows variants route here too.
  if (/\b(curl|wget)\b/.test(lower)) {
    if (!curlWgetTargetsLocalhostOnly(cmd)) {
      throw new Error('command refused: network egress (curl/wget) is only allowed to localhost');
    }
  }

  const denials: Array<{ re: RegExp; why: string }> = [
    { re: /\bgit\s+push\b/, why: 'git push (outward publish)' },
    { re: /\bgit\s+remote\b/, why: 'git remote (mutates remotes)' },
    { re: /\bgh\s/, why: 'gh CLI (GitHub outward actions)' },
    { re: /\bnpm\s+publish\b/, why: 'npm publish' },
    { re: /\byarn\s+publish\b/, why: 'yarn publish' },
    { re: /\bpnpm\s+publish\b/, why: 'pnpm publish' },
    { re: /\bssh\b/, why: 'ssh' },
    { re: /\bscp\b/, why: 'scp' },
    { re: /\brsync\b/, why: 'rsync' },
    { re: /\bnc\s/, why: 'nc / netcat (network egress)' },
    { re: /\bncat\b/, why: 'ncat (network egress)' },
    { re: /\btelnet\b/, why: 'telnet (network egress)' },
    { re: /\/dev\/tcp\//, why: '/dev/tcp/ (bash network socket)' },
    { re: /\bnode\s+-e\b/, why: 'node -e (inline code execution)' },
    { re: /\bpython3?\s+-c\b/, why: 'python -c (inline code execution)' },
    { re: /\bruby\s+-e\b/, why: 'ruby -e (inline code execution)' },
    { re: /\bperl\s+-e\b/, why: 'perl -e (inline code execution)' },
    { re: /\bbase64\s+-d\b/, why: 'base64 -d (decode-to-execute primitive)' },
    { re: /\bln\s+-s\b/, why: 'ln -s (symlink-escape primitive)' },
    { re: /\bsudo\b/, why: 'sudo (privilege escalation)' },
    { re: /\brm\s+-rf\s+\//, why: 'rm -rf / (catastrophic delete)' },
    { re: /\brm\s+-rf\s+~/, why: 'rm -rf ~ (home delete)' },
    { re: /:\(\)\s*\{/, why: 'fork bomb' },
    { re: /\bmkfs\b/, why: 'mkfs (filesystem format)' },
    { re: /\bdd\s+if=/, why: 'dd if= (raw device write)' },
    { re: />\s*\/dev\//, why: 'redirect to /dev/ device' },
    { re: /\bshutdown\b/, why: 'shutdown' },
    { re: /\breboot\b/, why: 'reboot' },
    // Windows destructive / egress verbs (defense in depth; matched lowercased).
    { re: /\bdel\s+\//, why: 'del / (cmd recursive delete)' },
    { re: /\brd\s+\/s\b/, why: 'rd /s (cmd recursive dir delete)' },
    { re: /\brmdir\s+\/s\b/, why: 'rmdir /s (cmd recursive dir delete)' },
    { re: /\bformat\s/, why: 'format (disk format)' },
    { re: /\bremove-item\b[\s\S]*(-recurse|-force)\b/, why: 'Remove-Item -Recurse/-Force (PowerShell recursive/forced delete)' },
    { re: /\binvoke-webrequest\b/, why: 'Invoke-WebRequest (PowerShell network egress)' },
    { re: /\biwr\s/, why: 'iwr (Invoke-WebRequest alias, network egress)' },
    { re: /\binvoke-restmethod\b/, why: 'Invoke-RestMethod (PowerShell network egress)' },
    { re: /\bcertutil\b[\s\S]*-urlcache\b/, why: 'certutil -urlcache (download primitive)' },
    { re: /\bbitsadmin\b/, why: 'bitsadmin (background download/egress)' },
    { re: /\bpowershell\b[\s\S]*(-enc\b|-encodedcommand\b)/, why: 'powershell -EncodedCommand (obfuscated execution)' },
  ];

  for (const d of denials) {
    if (d.re.test(lower)) {
      throw new Error(`command refused by deny-list: ${d.why}`);
    }
  }
}

/** Hostnames that count as "localhost" for the curl/wget egress allow. */
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * True iff EVERY http(s) URL in a curl/wget command resolves to a localhost
 * host. Extracts URL-shaped tokens, parses each with `new URL()`, and compares
 * the parsed hostname against the allow-set — so `http://localhost@evil.com`
 * (host = evil.com) and `http://127.0.0.1.evil.com` (host = 127.0.0.1.evil.com)
 * are correctly DENIED. If no URL token can be parsed, deny (fail closed).
 */
function curlWgetTargetsLocalhostOnly(command: string): boolean {
  // Match http/https URL tokens (stop at whitespace, quotes, or shell metachars).
  const urlTokens = command.match(/https?:\/\/[^\s'"`;|&<>]+/gi) ?? [];
  if (urlTokens.length === 0) return false; // fail closed: no parseable target
  for (const token of urlTokens) {
    let host: string;
    try {
      host = new URL(token).hostname.toLowerCase();
    } catch {
      return false; // unparseable URL — fail closed
    }
    // URL.hostname wraps IPv6 in brackets; strip them for the set compare.
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    if (!LOCALHOST_HOSTS.has(bare)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// runBash — the dangerous tool, contained in order
// ---------------------------------------------------------------------------

interface BashResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Resolve the shell + argv for the current platform.
 *   - win32: COMSPEC (or cmd.exe) with ['/d', '/s', '/c', command].
 *   - posix: /bin/bash when present, else /bin/sh, with ['-c', command].
 */
function resolveShell(command: string): { shell: string; shellArgs: string[] } {
  if (process.platform === 'win32') {
    const shell = process.env.COMSPEC || 'cmd.exe';
    return { shell, shellArgs: ['/d', '/s', '/c', command] };
  }
  const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { shell, shellArgs: ['-c', command] };
}

/**
 * Execute `command` inside the workspace, contained in order:
 *   1. assertMayMutate(sourceRepo) — kill-switch + enrollment gate.
 *   2. assertCommandAllowed(command) — deny-list (defense in depth).
 *   3. spawn the platform shell (posix: /bin/bash || /bin/sh -c; win32:
 *      cmd.exe /d /s /c) with cwd pinned to the worktree, minimal env (no
 *      secrets), a clamped timeout, SIGKILL on timeout, and a hard output cap.
 *
 * NOTE: on Windows the `bash` tool runs the command via cmd.exe — shell
 * semantics differ from POSIX, but it is still confined to the sandbox cwd
 * (eng.workspaceRoot) and the sanitized, secret-free minimal env.
 */
async function runBash(
  args: Record<string, unknown>,
  cfg: AshlrConfig,
  eng: EngineerContext,
): Promise<BashResult> {
  const command = typeof args['command'] === 'string' ? args['command'] : '';
  if (command.trim() === '') {
    throw new Error('bash: "command" is required and must be a non-empty string');
  }

  // 1. Kill-switch + enrollment gate (throws on KILL or non-enrolled repo).
  assertMayMutate(eng.sourceRepo, { allowAnyRepo: true });

  // 2. Deny-list (defense in depth).
  assertCommandAllowed(command);

  const rawTimeout = typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : DEFAULT_BASH_TIMEOUT_MS;
  const timeout = clamp(Math.floor(rawTimeout), MIN_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);

  // 3. Spawn with minimal env + ashlr non-secret keys layered on top.
  const env = withToolEnv(cfg, minimalEnv());

  return await new Promise<BashResult>((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const { shell, shellArgs } = resolveShell(command);
    const child = spawn(shell, shellArgs, {
      cwd: eng.workspaceRoot,
      env,
      timeout,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_BASH_OUTPUT_BYTES) {
        const remaining = MAX_BASH_OUTPUT_BYTES - stdoutBytes;
        stdout += chunk.toString('utf8', 0, Math.min(chunk.length, remaining));
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_BASH_OUTPUT_BYTES) {
        const remaining = MAX_BASH_OUTPUT_BYTES - stderrBytes;
        stderr += chunk.toString('utf8', 0, Math.min(chunk.length, remaining));
        stderrBytes += chunk.length;
      }
    });

    child.on('error', (err: Error & { code?: string }) => {
      // ETIMEDOUT surfaces here on some platforms; treat as timeout.
      if (err.code === 'ETIMEDOUT') timedOut = true;
      resolvePromise({
        exitCode: null,
        stdout,
        stderr: stderr || String(err),
        timedOut,
      });
    });

    child.on('close', (code, signal) => {
      // node sets signal 'SIGKILL' when the timeout killed the child.
      if (signal === 'SIGKILL') timedOut = true;
      resolvePromise({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/** read_file — read a file inside the boundary, optional line window. */
async function handleReadFile(
  args: Record<string, unknown>,
  _cfg: AshlrConfig,
  eng: EngineerContext,
): Promise<unknown> {
  const p = typeof args['path'] === 'string' ? args['path'] : '';
  if (p === '') throw new Error('read_file: "path" is required');
  const abs = resolveInside(eng.workspaceRoot, p);

  // Refuse files that look like secrets material (keys, .env, credentials).
  if (SECRET_FILE_RE.test(basename(abs))) {
    throw new Error(`refused: "${p}" looks like a secrets file`);
  }

  const st = statSync(abs);
  if (st.isDirectory()) throw new Error(`read_file: "${p}" is a directory`);
  // Size guard BEFORE loading: refuse oversized files rather than OOMing.
  if (st.size > MAX_READ_FILE_BYTES) {
    throw new Error(
      `read_file: "${p}" is ${st.size} bytes, over the ${MAX_READ_FILE_BYTES}-byte ` +
      'read cap; use grep or offset/limit on a smaller window',
    );
  }

  const raw = readFileSync(abs, 'utf8');
  const all = raw.split('\n');

  const offset = typeof args['offset'] === 'number' ? Math.max(0, Math.floor(args['offset'])) : 0;
  const limit = typeof args['limit'] === 'number' ? Math.max(1, Math.floor(args['limit'])) : all.length;
  const slice = all.slice(offset, offset + limit);

  // Line-numbered, 1-based, capped by total bytes.
  let out = '';
  let bytes = 0;
  let truncated = false;
  for (let i = 0; i < slice.length; i++) {
    const lineNo = offset + i + 1;
    const line = `${String(lineNo).padStart(6, ' ')}\t${slice[i]}\n`;
    if (bytes + line.length > MAX_READ_BYTES) {
      truncated = true;
      break;
    }
    out += line;
    bytes += line.length;
  }

  return {
    path: relative(eng.workspaceRoot, abs) || basename(abs),
    totalLines: all.length,
    offset,
    returnedLines: out === '' ? 0 : out.split('\n').length - 1,
    truncated,
    content: out,
  };
}

/** Recursively collect files under `dir` matching a simple glob `pattern`. */
function walkGlob(root: string, pattern: string): string[] {
  const re = globToRegExp(pattern);
  const results: string[] = [];

  function walk(dir: string): void {
    if (results.length >= MAX_GLOB_RESULTS) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_GLOB_RESULTS) break;
      if (entry.isSymbolicLink()) continue; // never follow symlinks out of the boundary
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Normalize to forward slashes so the (forward-slash) glob regex matches
      // on Windows too, where relative() yields backslash-separated paths.
      const rel = relative(root, full).split(sep).join('/');
      if (re.test(rel)) results.push(rel);
    }
  }

  walk(root);
  return results.sort();
}

/**
 * Translate a glob pattern into a RegExp matched against a repo-relative path.
 * Supports `**` (any depth, including none), `*` (no path sep), and `?`.
 */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** — match across path separators (and an optional trailing slash).
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c as string)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** glob — list files matching `pattern`, scoped to the boundary. */
async function handleGlob(
  args: Record<string, unknown>,
  _cfg: AshlrConfig,
  eng: EngineerContext,
): Promise<unknown> {
  const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : '';
  if (pattern === '') throw new Error('glob: "pattern" is required');

  const cwdArg = typeof args['cwd'] === 'string' && args['cwd'] !== '' ? args['cwd'] : '.';
  const resolvedCwd = resolveInside(eng.workspaceRoot, cwdArg);
  // M225 FIX: walkGlob requires a directory. Normalise a file path to its parent.
  let base = resolvedCwd;
  try {
    if (existsSync(resolvedCwd) && statSync(resolvedCwd).isFile()) {
      base = dirname(resolvedCwd);
    }
  } catch { /* stat failure — keep base as-is */ }

  const matches = walkGlob(base, pattern);
  return {
    cwd: relative(eng.workspaceRoot, base) || '.',
    pattern,
    count: matches.length,
    truncated: matches.length >= MAX_GLOB_RESULTS,
    files: matches,
  };
}

/** grep — `git grep` when the workspace is a git repo, else a bounded JS scan. */
async function handleGrep(
  args: Record<string, unknown>,
  _cfg: AshlrConfig,
  eng: EngineerContext,
): Promise<unknown> {
  const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : '';
  if (pattern === '') throw new Error('grep: "pattern" is required');

  const pathArg = typeof args['path'] === 'string' && args['path'] !== '' ? args['path'] : '.';
  const resolvedPath = resolveInside(eng.workspaceRoot, pathArg);
  // M225 FIX: git -C and the JS walk both require a directory. When the model
  // passes a FILE path (e.g. "src/core/goals/store.ts"), resolveInside returns
  // the file's absolute path — which git rejects with "Not a directory". Normalise
  // to the containing directory so grep still searches the right subtree.
  let base = resolvedPath;
  try {
    if (existsSync(resolvedPath) && statSync(resolvedPath).isFile()) {
      base = dirname(resolvedPath);
    }
  } catch { /* stat failure — keep base as-is, git/walk will surface the error */ }
  const globFilter = typeof args['glob'] === 'string' ? args['glob'] : undefined;

  // --- git grep (preferred; arg arrays, NO shell) ---
  if (isGitRepo(eng.workspaceRoot)) {
    try {
      const gitArgs = [
        '-C', base,
        'grep', '-n', '-I',
        '--no-color',
        '--untracked', // also search new files not yet committed (still skips .gitignored)
        '-e', pattern,
      ];
      if (globFilter) {
        gitArgs.push('--', globFilter);
      }
      const out = execFileSync('git', gitArgs, {
        timeout: 30_000,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      const lines = out.split('\n').filter(Boolean).slice(0, MAX_GREP_LINES);
      return {
        engine: 'git-grep',
        pattern,
        count: lines.length,
        truncated: lines.length >= MAX_GREP_LINES,
        matches: lines,
      };
    } catch (err) {
      // git grep exits 1 when there are zero matches — that is NOT an error.
      const code = (err as { status?: number }).status;
      if (code === 1) {
        return { engine: 'git-grep', pattern, count: 0, truncated: false, matches: [] };
      }
      // Any other failure: fall through to the JS scan.
    }
  }

  // --- bounded JS scan fallback ---
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    // Treat an invalid regex as a literal substring search.
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const globRe = globFilter ? globToRegExp(globFilter) : null;

  const matches: string[] = [];
  let filesScanned = 0;

  function walk(dir: string): void {
    if (matches.length >= MAX_GREP_LINES || filesScanned >= MAX_GREP_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_GREP_LINES || filesScanned >= MAX_GREP_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Never read secrets material into a grep result — silently skip.
      if (SECRET_FILE_RE.test(entry.name)) continue;
      const rel = relative(eng.workspaceRoot, full).split(sep).join('/');
      if (globRe && !globRe.test(rel)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.size > MAX_GREP_FILE_BYTES) continue;
      filesScanned++;
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const fileLines = text.split('\n');
      for (let i = 0; i < fileLines.length; i++) {
        if (matches.length >= MAX_GREP_LINES) break;
        if (re.test(fileLines[i]!)) {
          matches.push(`${rel}:${i + 1}:${fileLines[i]}`);
        }
      }
    }
  }

  walk(base);
  return {
    engine: 'js-scan',
    pattern,
    count: matches.length,
    truncated: matches.length >= MAX_GREP_LINES,
    matches,
  };
}

/** write_file — write content to a file inside the boundary (gated). */
async function handleWriteFile(
  args: Record<string, unknown>,
  _cfg: AshlrConfig,
  eng: EngineerContext,
): Promise<unknown> {
  const p = typeof args['path'] === 'string' ? args['path'] : '';
  if (p === '') throw new Error('write_file: "path" is required');
  const content = typeof args['content'] === 'string' ? args['content'] : '';

  // Kill-switch + enrollment gate (allowAnyRepo honored only under the env seam).
  assertMayMutate(eng.sourceRepo, { allowAnyRepo: true });

  const abs = resolveInside(eng.workspaceRoot, p);
  mkdirSync(resolve(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');

  return {
    written: true,
    path: relative(eng.workspaceRoot, abs) || basename(abs),
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

/** edit_file — fuzzy-ladder string replace (M140: exact→whitespace→elision→fuzzy). */
async function handleEditFile(
  args: Record<string, unknown>,
  cfg: AshlrConfig,
  eng: EngineerContext,
): Promise<unknown> {
  const p = typeof args['path'] === 'string' ? args['path'] : '';
  if (p === '') throw new Error('edit_file: "path" is required');
  const oldString = typeof args['old_string'] === 'string' ? args['old_string'] : '';
  const newString = typeof args['new_string'] === 'string' ? args['new_string'] : '';
  const replaceAll = args['replace_all'] === true;

  if (oldString === '') throw new Error('edit_file: "old_string" is required and must be non-empty');
  if (oldString === newString) throw new Error('edit_file: "old_string" and "new_string" are identical');

  // Kill-switch + enrollment gate.
  assertMayMutate(eng.sourceRepo, { allowAnyRepo: true });

  const abs = resolveInside(eng.workspaceRoot, p);
  const original = readFileSync(abs, 'utf8');

  // replaceAll: use exact multi-occurrence path (unchanged behaviour).
  if (replaceAll) {
    let count = 0;
    let idx = original.indexOf(oldString);
    while (idx !== -1) { count++; idx = original.indexOf(oldString, idx + oldString.length); }
    if (count === 0) {
      throw new Error(`edit_file: old_string not found in "${p}" (0 matches)`);
    }
    const updated = original.split(oldString).join(newString);
    writeFileSync(abs, updated, 'utf8');
    return { edited: true, path: relative(eng.workspaceRoot, abs) || basename(abs), replacements: count, rung: 'exact' };
  }

  // Strict precision guard (edit_file contract): >1 exact occurrences without
  // replace_all is ambiguous — error rather than silently editing one (M140.1).
  {
    let exactCount = 0;
    let i = original.indexOf(oldString);
    while (i !== -1) { exactCount++; i = original.indexOf(oldString, i + oldString.length); }
    if (exactCount > 1) {
      throw new Error(`edit_file: old_string is ambiguous in "${p}" (${exactCount} matches); pass replace_all or add more context`);
    }
  }

  // Single-replacement path: run the fuzzy ladder (M140).
  const result = applyEdit(original, oldString, newString);

  if (!result.ok) {
    // Structured failure: give the model the closest matching window so it can
    // self-correct without re-reading the whole file.
    throw new Error(
      `edit_file: old_string not found in "${p}" (0 matches) after exact/whitespace/elision/fuzzy attempts.\n` +
      (result.hint ?? 'No close match found.')
    );
  }

  // Ambiguity check for non-exact rungs: if exact count > 1 we would have
  // caught it above; for fuzzy rungs a unique window was found.
  writeFileSync(abs, result.updated!, 'utf8');

  // M140: lint/typecheck-on-edit — fast syntax check after write.
  // Reject a syntactically broken edit BEFORE spending a test run.
  const lintResult = await runLintOnEdit(abs, eng.workspaceRoot, cfg);
  if (lintResult !== null && !lintResult.ok) {
    // Roll back the broken write.
    writeFileSync(abs, original, 'utf8');
    throw new Error(
      `edit_file: edit rejected — typecheck failed after applying to "${p}".\n` +
      `Fix the syntax error first:\n${lintResult.output.slice(0, 2000)}`
    );
  }

  return {
    edited: true,
    path: relative(eng.workspaceRoot, abs) || basename(abs),
    replacements: 1,
    rung: result.rung,
  };
}

/**
 * M140: Run a fast typecheck (kind='typecheck') on the workspace after an edit.
 * Returns null when no typecheck command is available (graceful degrade).
 * Returns { ok, output } otherwise. Never throws.
 */
async function runLintOnEdit(
  _editedFile: string,
  workspaceRoot: string,
  cfg: AshlrConfig,
): Promise<{ ok: boolean; output: string } | null> {
  try {
    const cmds = detectVerifyCommands(workspaceRoot);
    const typecheck = cmds.find((c) => c.kind === 'typecheck');
    if (!typecheck) return null;
    const r = await runVerifyCommandAsync(typecheck, workspaceRoot, cfg, { timeoutMs: 30_000 });
    return { ok: r.ok, output: r.output };
  } catch {
    return null; // graceful degrade — never fail an edit on a lint tool error
  }
}

/** bash — execute a command inside the workspace (gated + deny-listed). */
async function handleBash(
  args: Record<string, unknown>,
  cfg: AshlrConfig,
  eng: EngineerContext,
): Promise<unknown> {
  const r = await runBash(args, cfg, eng);
  return {
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut,
  };
}

// ---------------------------------------------------------------------------
// Tool table
// ---------------------------------------------------------------------------

interface EngineerTool {
  name: string;
  description: string;
  inputSchema: object;
  safety: NativeToolSafety;
  handler: (
    args: Record<string, unknown>,
    cfg: AshlrConfig,
    eng: EngineerContext,
  ) => Promise<unknown>;
}

const ENGINEER_TOOLS: EngineerTool[] = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file inside the workspace. Returns line-numbered content; ' +
      'use offset/limit to window large files. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        offset: { type: 'number', description: '0-based start line (default 0).' },
        limit: { type: 'number', description: 'Max lines to return (default all).' },
      },
      required: ['path'],
    },
    safety: 'read',
    handler: handleReadFile,
  },
  {
    name: 'glob',
    description:
      'List files matching a glob pattern (supports **, *, ?) scoped to the workspace. ' +
      `Skips node_modules/.git/build dirs; caps at ${MAX_GLOB_RESULTS} results. Read-only.`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob, e.g. "src/**/*.ts".' },
        cwd: { type: 'string', description: 'Workspace-relative base dir (default ".").' },
      },
      required: ['pattern'],
    },
    safety: 'read',
    handler: handleGlob,
  },
  {
    name: 'grep',
    description:
      'Search file contents for a regex inside the workspace (uses git grep when ' +
      'available, else a bounded scan). Returns file:line:text matches. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex (or literal) to search for.' },
        path: { type: 'string', description: 'Workspace-relative dir to scope to (default ".").' },
        glob: { type: 'string', description: 'Optional pathspec/glob filter, e.g. "*.ts".' },
      },
      required: ['pattern'],
    },
    safety: 'read',
    handler: handleGrep,
  },
  {
    name: 'write_file',
    description:
      'Write (create or overwrite) a UTF-8 file inside the workspace. Gated by the ' +
      'kill switch + repo enrollment and the workspace boundary.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    },
    safety: 'write',
    handler: handleWriteFile,
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file inside the workspace. Errors if old_string ' +
      'matches 0 times, or >1 time without replace_all. Gated like write_file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        old_string: { type: 'string', description: 'Exact text to find.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    safety: 'write',
    handler: handleEditFile,
  },
  {
    name: 'bash',
    description:
      'Run a shell command inside the workspace (cwd = worktree root, minimal env ' +
      'with NO secrets, clamped timeout). Gated by the kill switch + enrollment and ' +
      'a destructive/egress deny-list. Returns {exitCode, stdout, stderr, timedOut}.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run via the platform shell (posix: /bin/bash || /bin/sh -c; win32: cmd.exe /c).' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (1..600000, default 120000).' },
      },
      required: ['command'],
    },
    safety: 'exec',
    handler: handleBash,
  },
];

// ---------------------------------------------------------------------------
// callEngineerTool — the gated pipeline (mirrors callNativeTool)
// ---------------------------------------------------------------------------

/** Audit one engineer-tool outcome under the shared 'mcp:engineer-call' action. */
function auditEngineerCall(
  eng: EngineerContext,
  summary: string,
  result: 'ok' | 'refused' | 'error',
): void {
  audit({
    action: 'mcp:engineer-call',
    repo: eng.sourceRepo ?? null,
    sandboxId: null,
    summary,
    result,
  });
}

/**
 * Execute an engineer tool through the full safety pipeline. NEVER throws:
 * unknown tools, capability/kill-switch refusals, and handler failures all
 * surface as rendered error text. Every outcome is audited. The returned
 * string is always rendered through `renderToolText` (scrub + 32KB cap).
 */
export async function callEngineerTool(
  name: string,
  rawArgs: unknown,
  eng: EngineerContext,
): Promise<string> {
  const args: Record<string, unknown> =
    rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  const argKeys = Object.keys(args).sort().join(',') || '(none)';

  const tool = ENGINEER_TOOLS.find((t) => t.name === name);
  if (!tool) {
    auditEngineerCall(eng, `${name} keys=${argKeys} — unknown engineer tool`, 'error');
    return renderToolText(`Unknown engineer tool "${name}".`);
  }

  // ── Kill-switch gate: refuse all non-read tools when KILL is engaged ──────
  if (tool.safety !== 'read' && killSwitchOn()) {
    auditEngineerCall(eng, `${tool.name} keys=${argKeys} — refused: kill switch on`, 'refused');
    return renderToolText(
      `${tool.name} refused: the ashlr kill switch is engaged (~/.ashlr/KILL). ` +
      'Read-only tools still work; writes/exec are disabled until `ashlr enroll kill off`.',
    );
  }

  // ── Capability gates ──────────────────────────────────────────────────────
  if (tool.safety === 'write' && !eng.allowWrite) {
    auditEngineerCall(eng, `${tool.name} keys=${argKeys} — refused: write not allowed`, 'refused');
    return renderToolText(`${tool.name} refused: write tools are not enabled for this session.`);
  }
  if (tool.safety === 'exec' && !eng.allowExec) {
    auditEngineerCall(eng, `${tool.name} keys=${argKeys} — refused: exec not allowed`, 'refused');
    return renderToolText(`${tool.name} refused: exec (bash) is not enabled for this session.`);
  }

  // ── Load config ───────────────────────────────────────────────────────────
  let cfg: AshlrConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    auditEngineerCall(eng, `${tool.name} keys=${argKeys} — config load failed`, 'error');
    return renderToolText(
      `${tool.name} failed: could not load ~/.ashlr/config.json ` +
      `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  try {
    const payload = await tool.handler(args, cfg, eng);
    auditEngineerCall(eng, `${tool.name} keys=${argKeys} — ok`, 'ok');
    return renderToolText(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditEngineerCall(eng, `${tool.name} keys=${argKeys} — error: ${msg}`, 'error');
    return renderToolText(`${tool.name} failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Spec builders (the shape agent-loop.ts toolExecutors consumes: { name, fn })
// ---------------------------------------------------------------------------

/** A tool spec carrying an executable `fn`, ready for the agent loop. */
export interface ExecutableToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: object };
  name: string;
  fn: (args: unknown) => Promise<string>;
}

/**
 * Build executable specs for the engineer tools, filtered by capability:
 * read tools always; write tools only when eng.allowWrite; exec tools only when
 * eng.allowExec. Each spec's `fn` routes through `callEngineerTool` so the full
 * gated pipeline (boundary + kill-switch + audit + render) always runs.
 */
export function buildEngineerToolSpecs(eng: EngineerContext): ExecutableToolSpec[] {
  return ENGINEER_TOOLS.filter((t) => {
    if (t.safety === 'write') return eng.allowWrite;
    if (t.safety === 'exec') return eng.allowExec;
    return true; // read
  }).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
    name: t.name,
    fn: (args: unknown) => callEngineerTool(t.name, args, eng),
  }));
}

/**
 * Wrap the existing native tools (from listNativeTools) so they are EXECUTABLE
 * in-process via `callNativeTool`. This fixes the pre-existing dead-tool bug:
 * the native specs the gateway exposes carry no `fn`, so the agent loop's
 * toolExecutors map never picked them up.
 */
export function buildNativeToolSpecsWithFn(): ExecutableToolSpec[] {
  return listNativeTools().map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
    name: t.name,
    fn: async (args: unknown): Promise<string> => {
      const r = await callNativeTool(t.name, args);
      return r.content[0]?.text ?? '';
    },
  }));
}
