/**
 * core/verse/verse-mcp-launch.ts — how each seat's turn is given Verse's MCP
 * server (3.15 agent tools, P0). Called from the adapters' buildLaunch, which
 * is where a turn's token is minted (verse-mcp-grants.ts).
 *
 * THE TOKEN NEVER RIDES IN ARGV. Argv is readable by every user on the Mac
 * (`ps`). It lives in private files under ~/.ashlr/verse/mcp (0700 dir, 0600
 * files, removed at turn end), or in a child's stdin:
 *
 *   Claude / local — `--mcp-config <private file>` holding one `http` server
 *                    with an `Authorization: Bearer` header, plus
 *                    `--allowedTools=mcp__ashlr-verse` (a `-p` turn cannot stop
 *                    to ask). `--strict-mcp-config` stays: nothing else loads.
 *   Codex          — `-c mcp_servers.ashlr-verse.*` on `exec` AND `exec resume`
 *                    naming the stdio bridge (`ashlr verse-mcp-stdio`) with the
 *                    token FILE's path in the server's env. NOT the HTTP form
 *                    with `bearer_token_env_var`: the native-profile launcher
 *                    (resources/native-profile.ts) passes the CLI only PATH,
 *                    HOME, TMPDIR, LANG, LC_ALL and CODEX_HOME, so a token in
 *                    the turn's env never reaches codex. Keys verified with
 *                    `--strict-config` (codex.ts strictConfigVerified).
 *   Grok           — no per-run MCP flag exists, and the same launcher strips
 *                    env. The Verse-owned GROK_HOME profile's config.toml gets
 *                    ONE persistent `[mcp_servers.ashlr-verse]` entry naming
 *                    the stdio bridge in parent-lookup mode (it finds its chat
 *                    through running.json by its parent pid). Never the
 *                    operator's ~/.grok, never a repo's ./.grok.
 *   Devin CLI      — the token travels in the turn process's stdin payload;
 *                    acp-bridge.ts hands Devin an `http` server (or the stdio
 *                    bridge with a token file) in session/new|load, and serves
 *                    Devin's terminal/* requests in a visible Verse tab.
 *   Devin cloud    — unsupported: it runs remotely and cannot reach loopback.
 *
 * Synchronous fs on purpose: buildLaunch is synchronous, and every path here
 * is Ashlr's own private state (never an operator folder).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { writePrivateFileAtomically } from './session-store.js';
import { mintVerseMcpTurn, type VerseMcpTurnCredential } from './verse-mcp-grants.js';
import { verseMcpStdioArgv } from './verse-mcp-stdio-invocation.js';
import {
  VERSE_MCP_DIR_ENV,
  VERSE_MCP_RESOLVE_ENV,
  VERSE_MCP_RUNNING_FILE_ENV,
  VERSE_MCP_TOKEN_FILE_ENV,
} from './verse-mcp-stdio.js';
import { VERSE_MCP_SERVER_NAME, type VerseMcpScope } from './verse-mcp-types.js';

/** Codex's per-call MCP timeout: the longest terminal_run (600 s) plus a confirmation (120 s) and slack. */
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 780;
const SESSION_RE = /^[A-Za-z0-9-]{1,80}$/;

/** ~/.ashlr/verse — resolved per call so a relocated HOME (tests) is honoured. */
function verseRoot(): string {
  return join(homedir(), '.ashlr', 'verse');
}

export function verseMcpRunDir(): string {
  return join(verseRoot(), 'mcp');
}

export function verseMcpTokenFile(sessionId: string): string {
  return join(verseMcpRunDir(), `${sessionId}.token.json`);
}

export function verseMcpClaudeConfigFile(sessionId: string): string {
  return join(verseMcpRunDir(), `${sessionId}.claude-mcp.json`);
}

function writePrivate(path: string, content: string): void {
  const dir = verseMcpRunDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFileAtomically(dir, path, content);
}

function removeTurnFilesSync(sessionId: string): void {
  for (const path of [verseMcpTokenFile(sessionId), verseMcpClaudeConfigFile(sessionId)]) {
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
  }
}

/** Turn end: the turn's private files go with its token (async; called from the engine's afterTurn hook). */
export async function removeVerseMcpTurnFiles(sessionId: string): Promise<void> {
  if (!SESSION_RE.test(sessionId)) return;
  await Promise.all([verseMcpTokenFile(sessionId), verseMcpClaudeConfigFile(sessionId)].map((p) => rm(p, { force: true }).catch(() => undefined)));
}

/**
 * Mint the turn's token and write the token file every stdio route reads.
 * Null (and no files) when the chat has no tools on.
 */
function mintWithTokenFile(sessionId: string, engine: string): VerseMcpTurnCredential | null {
  if (!SESSION_RE.test(sessionId)) return null;
  const credential = mintVerseMcpTurn(sessionId, engine);
  if (!credential) {
    removeTurnFilesSync(sessionId);
    return null;
  }
  try {
    writePrivate(verseMcpTokenFile(sessionId), `${JSON.stringify({ v: 1, sessionId, url: credential.url, token: credential.token })}\n`);
  } catch {
    // No private file, no server: a seat must never be handed a token another way.
    return null;
  }
  return credential;
}

// ---------------------------------------------------------------------------
// Claude / local
// ---------------------------------------------------------------------------

/**
 * `['--mcp-config', <file>, '--allowedTools=mcp__ashlr-verse']`, or null when
 * the chat has no tools (the caller then keeps the empty inline config).
 */
export function claudeVerseMcpArgs(sessionId: string, engine: 'claude' | 'local'): { args: string[]; scopes: VerseMcpScope[] } | null {
  const credential = mintWithTokenFile(sessionId, engine);
  if (!credential) return null;
  const path = verseMcpClaudeConfigFile(sessionId);
  const config = {
    mcpServers: {
      [VERSE_MCP_SERVER_NAME]: { type: 'http', url: credential.url, headers: { Authorization: `Bearer ${credential.token}` } },
    },
  };
  try {
    writePrivate(path, `${JSON.stringify(config)}\n`);
  } catch {
    return null;
  }
  return { args: ['--mcp-config', path, `--allowedTools=mcp__${VERSE_MCP_SERVER_NAME}`], scopes: credential.scopes };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function tomlString(value: string): string {
  // JSON string syntax is a subset of TOML basic strings for everything
  // JSON.stringify emits (\" \\ \n \t \uXXXX).
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/** The `-c` overrides that load the stdio bridge on this codex turn (exec and exec resume alike); [] when tools are off. */
export function codexVerseMcpOverrides(sessionId: string): string[] {
  const credential = mintWithTokenFile(sessionId, 'codex');
  if (!credential) return [];
  const [command, ...args] = verseMcpStdioArgv();
  const key = `mcp_servers.${VERSE_MCP_SERVER_NAME}`;
  return [
    '-c', `${key}.command=${tomlString(command!)}`,
    '-c', `${key}.args=${tomlArray(args)}`,
    '-c', `${key}.env.${VERSE_MCP_TOKEN_FILE_ENV}=${tomlString(verseMcpTokenFile(sessionId))}`,
    // `-p`-style turns have nobody to ask: the operator granted these tools in the sheet.
    '-c', `${key}.default_tools_approval_mode="approve"`,
    '-c', `${key}.startup_timeout_sec=20`,
    '-c', `${key}.tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}`,
  ];
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

const GROK_SECTION_RE = /^\s*\[\s*mcp_servers\.(?:ashlr-verse|"ashlr-verse")(?:\.[^\]]*)?\]\s*$/;

/** The persistent entry this sidecar writes into a Verse-owned GROK_HOME's config.toml. */
export function grokVerseMcpSection(): string {
  const [command, ...args] = verseMcpStdioArgv();
  return [
    `[mcp_servers.${VERSE_MCP_SERVER_NAME}]`,
    '# Written by Ashlr Verse (agent tools). The bridge serves tools only to a turn Verse granted them to.',
    `command = ${tomlString(command!)}`,
    `args = ${tomlArray(args)}`,
    'enabled = true',
    '',
    `[mcp_servers.${VERSE_MCP_SERVER_NAME}.env]`,
    `${VERSE_MCP_RESOLVE_ENV} = "parent"`,
    `${VERSE_MCP_DIR_ENV} = ${tomlString(verseMcpRunDir())}`,
    `${VERSE_MCP_RUNNING_FILE_ENV} = ${tomlString(join(verseRoot(), 'running.json'))}`,
    '',
  ].join('\n');
}

/** `text` with every `[mcp_servers.ashlr-verse…]` table removed, and ours appended. */
export function withGrokVerseMcpSection(text: string, section: string = grokVerseMcpSection()): string {
  const kept: string[] = [];
  let inOurs = false;
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) inOurs = GROK_SECTION_RE.test(line);
    if (!inOurs) kept.push(line);
  }
  const body = kept.join('\n').replace(/\n+$/, '');
  return `${body.length > 0 ? `${body}\n\n` : ''}${section}`;
}

/**
 * Make sure the seat's own GROK_HOME loads the bridge, and mint the turn's
 * token. `grokHome` must be the Verse-owned profile directory (the launcher's
 * GROK_HOME) — never the operator's ~/.grok: that one is refused.
 */
export function ensureGrokVerseMcp(sessionId: string, grokHome: string | null): { scopes: VerseMcpScope[] } | null {
  if (!grokHome || resolve(grokHome) === resolve(homedir(), '.grok')) return null;
  const credential = mintWithTokenFile(sessionId, 'grok');
  if (!credential) return null;
  const file = join(grokHome, 'config.toml');
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const next = withGrokVerseMcpSection(current);
    if (next !== current) writePrivateFileAtomically(grokHome, file, next);
  } catch {
    return null;
  }
  return { scopes: credential.scopes };
}

// ---------------------------------------------------------------------------
// Devin CLI
// ---------------------------------------------------------------------------

/** What a Devin CLI turn process gets on stdin (turn-protocol.ts `verseMcp`). */
export interface DevinVerseMcpPayload {
  url: string;
  token: string;
  tokenFile: string;
  stdio: string[];
  scopes: VerseMcpScope[];
}

export function devinVerseMcpPayload(sessionId: string): DevinVerseMcpPayload | null {
  const credential = mintWithTokenFile(sessionId, 'devin');
  if (!credential) return null;
  return { url: credential.url, token: credential.token, tokenFile: verseMcpTokenFile(sessionId), stdio: verseMcpStdioArgv(), scopes: credential.scopes };
}
