/**
 * core/verse/terminal-agent-hooks.ts — live status for CLI agents running in
 * terminal tabs (3.15): Claude Code, Codex, Devin, Grok launched by Apps
 * [Launch ▸] (or a launch configuration) into a tab.
 *
 * TWO CHANNELS.
 *   hooks      The agent's own lifecycle hooks, installed PER LAUNCH:
 *                - Claude Code: `claude --settings <file>` — a temporary
 *                  settings file whose UserPromptSubmit / PostToolUse
 *                  (running), Stop (idle) and Notification (needs you) hooks
 *                  run our script. `--settings` ADDS to the operator's own
 *                  settings for this process only.
 *                - Codex: `codex -c 'notify=[…]'` — a config override for this
 *                  process only; Codex runs it when a turn completes (idle).
 *                  (It stands in for any `notify` of the operator's own for
 *                  this one launch.)
 *              The script POSTs to `/api/verse/terminal/<tab>/agent-state`
 *              with the tab's own random token — the operator's mutation
 *              token never leaves the page. NEVER a change to ~/.claude,
 *              ~/.codex or any other global config.
 *   heuristic  Devin, Grok, and any launch through Ollama: read from the
 *              tab's output (terminal.ts) — output flowing = running, quiet =
 *              idle, a question / y-n prompt on screen = needs you.
 *
 * FILES. One private directory per tab under the per-user temp dir (0700,
 * refused if it is a symlink, someone else's or group/world-writable), holding
 * the hook script (the token lives only there) and Claude's settings file.
 * Removed when the tab closes.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VerseTerminalAgentKind } from './workbench-types.js';

/** Catalog app id → the agent kind whose tab reports a status. */
const APP_AGENT_KIND: Readonly<Record<string, VerseTerminalAgentKind>> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  devin: 'devin',
  grok: 'grok',
};

export function agentKindForApp(appId: string | null | undefined): VerseTerminalAgentKind | null {
  if (!appId) return null;
  return APP_AGENT_KIND[appId] ?? null;
}

/** Agents whose own hooks we can install for one launch. */
export function agentSupportsHooks(kind: VerseTerminalAgentKind): boolean {
  return kind === 'claude-code' || kind === 'codex';
}

export const AGENT_TOKEN_BYTES = 24;
export function newAgentToken(): string {
  return randomBytes(AGENT_TOKEN_BYTES).toString('hex');
}

/** The per-user parent of every tab's hook directory. */
export function defaultAgentHooksRoot(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return join(tmpdir(), `ashlr-verse-agent-hooks-${uid}`);
}

async function assertPrivateDir(dir: string): Promise<void> {
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('agent hooks dir is not a plain directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('agent hooks dir is not ours');
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new Error('agent hooks dir is readable by others');
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, content, { mode });
  await rename(temp, path);
}

/** Single-quote for sh. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Launch arguments as typed into the shell: quoted only when needed (preview.ts shellJoin's rule). */
export function shellJoinArgs(args: readonly string[]): string {
  return args.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : sq(a))).join(' ');
}

/**
 * The hook script. `$1` is the state; the agent's event JSON is the second
 * argument (Codex's notify) or stdin (Claude Code's hooks), passed through as
 * the body — the server reads only the fields it knows. Always exits 0 and
 * prints nothing: a hook must never block, fail or steer the agent.
 */
export function agentHookScript(url: string, token: string): string {
  return `#!/bin/sh
# Ashlr Verse: this terminal tab's agent status hook. Temporary: removed when the tab closes.
state="$1"
case "$state" in running|idle|needs-you) ;; *) exit 0 ;; esac
if [ -n "$2" ]; then body="$2"; else body=$(head -c 16384 2>/dev/null); fi
[ -n "$body" ] || body='{}'
curl_bin=/usr/bin/curl
[ -x "$curl_bin" ] || curl_bin=$(command -v curl 2>/dev/null) || exit 0
printf '%s' "$body" | "$curl_bin" -s -m 3 -o /dev/null -X POST \\
  -H 'content-type: application/json' \\
  -H ${sq(`x-ashlr-agent-token: ${token}`)} \\
  --data-binary @- ${sq(`${url}?state=`)}"$state" >/dev/null 2>&1
exit 0
`;
}

/** Claude Code's per-launch settings: our hooks only. */
export function claudeHookSettings(scriptPath: string): Record<string, unknown> {
  const hook = (state: string) => [{ hooks: [{ type: 'command', command: `/bin/sh ${sq(scriptPath)} ${state}`, timeout: 5 }] }];
  return {
    hooks: {
      UserPromptSubmit: hook('running'),
      PostToolUse: hook('running'),
      Stop: hook('idle'),
      Notification: hook('needs-you'),
    },
  };
}

export interface AgentHookInstall {
  /** Arguments appended to the agent's launch command. */
  args: string[];
  /** The tab's hook directory (removed with the tab). */
  dir: string;
}

export interface AgentHookInstallOptions {
  kind: VerseTerminalAgentKind;
  tabId: string;
  token: string;
  /** `http://127.0.0.1:<port>` — the server's own loopback listener. */
  baseUrl: string;
  root?: string;
}

/**
 * Write the tab's hook files and return the launch arguments, or null for an
 * agent without hooks. Throws when the directory is not safe; the caller then
 * falls back to the heuristic channel.
 */
export async function installAgentHooks(opts: AgentHookInstallOptions): Promise<AgentHookInstall | null> {
  if (!agentSupportsHooks(opts.kind)) return null;
  if (!/^t-[a-z0-9]{1,32}$/.test(opts.tabId)) throw new Error('bad tab id');
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(opts.baseUrl)) throw new Error('hooks only call the loopback server');
  const root = opts.root ?? defaultAgentHooksRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertPrivateDir(root);
  const dir = join(root, opts.tabId);
  await mkdir(dir, { mode: 0o700 });
  await assertPrivateDir(dir);
  const url = `${opts.baseUrl}/api/verse/terminal/${opts.tabId}/agent-state`;
  const script = join(dir, 'hook.sh');
  await writeAtomic(script, agentHookScript(url, opts.token), 0o700);
  if (opts.kind === 'claude-code') {
    const settings = join(dir, 'claude-settings.json');
    await writeAtomic(settings, `${JSON.stringify(claudeHookSettings(script), null, 2)}\n`, 0o600);
    return { args: ['--settings', settings], dir };
  }
  // codex: TOML array, one process only.
  return { args: ['-c', `notify=${JSON.stringify(['/bin/sh', script, 'idle'])}`], dir };
}

export async function removeAgentHooks(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* best effort: the temp dir is private and swept by the OS */
  }
}

// ---------------------------------------------------------------------------
// The callback's body
// ---------------------------------------------------------------------------

export const AGENT_MESSAGE_MAX_CHARS = 200;

/**
 * What a hook callback tells us beyond its state: Claude Code's Notification
 * `message` (and `notification_type`). Claude also notifies after sitting at
 * its prompt for a while ("waiting for your input") — that is idle, not a
 * question, so it is read as idle.
 */
export function readHookBody(body: unknown, state: 'running' | 'idle' | 'needs-you'): { state: 'running' | 'idle' | 'needs-you'; message: string | null } {
  if (state !== 'needs-you' || body === null || typeof body !== 'object' || Array.isArray(body)) return { state, message: null };
  const record = body as Record<string, unknown>;
  const type = typeof record['notification_type'] === 'string' ? record['notification_type'] : '';
  const raw = typeof record['message'] === 'string' ? record['message'] : '';
  if (type === 'idle_prompt' || /waiting for your input/i.test(raw)) return { state: 'idle', message: null };
  return { state, message: raw ? cleanAgentMessage(raw) : null };
}

export function cleanAgentMessage(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > AGENT_MESSAGE_MAX_CHARS ? `${text.slice(0, AGENT_MESSAGE_MAX_CHARS - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// The output heuristic
// ---------------------------------------------------------------------------

/**
 * A question on screen that waits for the operator: an approval, a y/n, a
 * "press enter". Tested against the last lines of output once it goes quiet.
 */
const NEEDS_YOU_PATTERNS: readonly RegExp[] = [
  /\((?:y\/n|Y\/n|y\/N|yes\/no)\)/,
  /\[(?:y\/n|Y\/n|y\/N)\]/,
  /\bdo you want to\b.*\?/i,
  /\b(?:allow|approve|permit)\b[^\n]{0,80}\?/i,
  /\bwaiting for (?:your )?(?:approval|confirmation)\b/i,
  /\bpress enter to (?:continue|confirm)\b/i,
  /\b(?:requires?|needs?) (?:your )?(?:approval|permission)\b/i,
];

/** The line that asks, when the output's tail asks the operator something; else null. */
export function needsYouLine(tailText: string): string | null {
  const lines = tailText.split('\n').map((l) => l.trim()).filter(Boolean).slice(-12);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (NEEDS_YOU_PATTERNS.some((re) => re.test(line))) return cleanAgentMessage(line);
  }
  return null;
}
