/**
 * core/verse/verse-mcp-types.ts — the contract of Verse's one MCP server for
 * every chat seat (3.15 agent tools, P0+P1).
 *
 * Three parties exchange these shapes:
 *   - a chat SEAT (Claude, local, Codex, Grok, Devin CLI) calls the MCP
 *     endpoint `POST /api/verse/agent-tools/mcp` with `Authorization: Bearer <turn token>`
 *     (verse-mcp.ts serves it; verse-mcp-grants.ts mints and revokes tokens);
 *   - the OPERATOR's page reads and changes the chat's grant (the "Agent
 *     tools" sheet), answers destructive-command confirmations, hands a shell
 *     back after a takeover, and shares operator shells per tab;
 *   - the sidecar, which enforces all of it.
 *
 * BROWSER-SAFE: imported by the web bundle. Plain data and pure functions only.
 */

/**
 * The route family. NOT `/api/verse/mcp`: that path (and /cli-health,
 * /proposal, /apply) is the MCP-management page's (mcp-control-api.ts), whose
 * GET sits behind the read session — a seat's MCP client probing GET there
 * would get a 401 and go looking for OAuth.
 */
export const VERSE_AGENT_TOOLS_PATH = '/api/verse/agent-tools';
/** POST (MCP streamable HTTP, stateless) — authenticated by the per-turn bearer token, not the mutation token. */
export const VERSE_MCP_PATH = `${VERSE_AGENT_TOOLS_PATH}/mcp`;
/** GET ?sessionId= → VerseAgentToolsState; POST VerseAgentToolsGrantRequest → VerseAgentToolsState. */
export const VERSE_MCP_GRANT_PATH = `${VERSE_AGENT_TOOLS_PATH}/grant`;
/** GET ?sessionId= → VerseAgentToolsActivity (pending confirmations, takeovers, recent actions). */
export const VERSE_MCP_ACTIVITY_PATH = `${VERSE_AGENT_TOOLS_PATH}/activity`;
/** POST { sessionId, id, answer } → { ok } */
export const VERSE_MCP_CONFIRM_PATH = `${VERSE_AGENT_TOOLS_PATH}/confirm`;
/** POST { tabId, sessionId, shared } → VerseAgentToolsState — "Share this shell with <seat>". */
export const VERSE_MCP_SHARE_PATH = `${VERSE_AGENT_TOOLS_PATH}/share`;
/** POST { tabId } → { ok } — "Resume agent" after the operator took a shell over. */
export const VERSE_MCP_RESUME_PATH = `${VERSE_AGENT_TOOLS_PATH}/resume`;
/** GET → { tabs: VerseAgentTabInfo[] } — ownership/takeover for the Terminal pane. */
export const VERSE_MCP_TABS_PATH = `${VERSE_AGENT_TOOLS_PATH}/tabs`;

/** The one server name every seat sees (`mcp__ashlr-verse__terminal_run`). */
export const VERSE_MCP_SERVER_NAME = 'ashlr-verse';

/** Newest-but-one first: an unknown version is answered with the first (what every current seat speaks). */
export const VERSE_MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2026-07-28', '2025-03-26', '2024-11-05'] as const;
export const VERSE_MCP_SERVER_INFO = { name: VERSE_MCP_SERVER_NAME, version: '1.0.0' };

/**
 * How `ashlr verse-mcp-stdio` finds its turn (verse-mcp-stdio.ts). Kept here,
 * with the other plain data, so the launch code (verse-mcp-launch.ts) names
 * them without importing the bridge.
 */
export const VERSE_MCP_TOKEN_FILE_ENV = 'ASHLR_VERSE_MCP_TOKEN_FILE';
export const VERSE_MCP_RESOLVE_ENV = 'ASHLR_VERSE_MCP_RESOLVE';
export const VERSE_MCP_DIR_ENV = 'ASHLR_VERSE_MCP_DIR';
export const VERSE_MCP_RUNNING_FILE_ENV = 'ASHLR_VERSE_RUNNING_FILE';

export function isVerseMcpEndpointPath(path: string): boolean {
  return path === VERSE_MCP_PATH;
}

/**
 * What a turn token may reach. A tool belongs to exactly one scope; tools/list
 * shows only the tools whose scope the chat's grant holds right now.
 */
export type VerseMcpScope = 'terminal' | 'browser' | 'browser_act' | 'browser_script' | 'computer';
export const VERSE_MCP_SCOPES: readonly VerseMcpScope[] = ['terminal', 'browser', 'browser_act', 'browser_script', 'computer'];

/** Terminal: off / agent-owned tabs only / agent tabs plus operator shells shared per tab. */
export type VerseAgentTerminalMode = 'off' | 'agent' | 'shared';
/** Browser: off / look (observe) / act on localhost / act on the origins allowed for this chat. */
export type VerseAgentBrowserMode = 'off' | 'look' | 'act-localhost' | 'act-allowed';
/** Computer use: off / only the listed apps. */
export type VerseAgentComputerMode = 'off' | 'apps';

export const VERSE_AGENT_TERMINAL_MODES: readonly VerseAgentTerminalMode[] = ['off', 'agent', 'shared'];
export const VERSE_AGENT_BROWSER_MODES: readonly VerseAgentBrowserMode[] = ['off', 'look', 'act-localhost', 'act-allowed'];
export const VERSE_AGENT_COMPUTER_MODES: readonly VerseAgentComputerMode[] = ['off', 'apps'];

/** The operator's per-chat choices. Memory only: a sidecar restart turns every chat's tools off. */
export interface VerseAgentToolsGrant {
  terminal: VerseAgentTerminalMode;
  browser: VerseAgentBrowserMode;
  /** Page scripts (JavaScript evaluation) on top of an act mode. */
  browserScript: boolean;
  computer: VerseAgentComputerMode;
  /** Apps computer use may drive (bundle ids or names), when `computer` is 'apps'. */
  computerApps: string[];
}

export const VERSE_AGENT_TOOLS_OFF: VerseAgentToolsGrant = Object.freeze({
  terminal: 'off',
  browser: 'off',
  browserScript: false,
  computer: 'off',
  computerApps: [] as string[],
}) as VerseAgentToolsGrant;

/** The scopes a grant holds. Pure: the sidecar and the page agree on it. */
export function scopesOfGrant(grant: VerseAgentToolsGrant): VerseMcpScope[] {
  const out: VerseMcpScope[] = [];
  if (grant.terminal !== 'off') out.push('terminal');
  if (grant.browser !== 'off') out.push('browser');
  if (grant.browser === 'act-localhost' || grant.browser === 'act-allowed') {
    out.push('browser_act');
    if (grant.browserScript) out.push('browser_script');
  }
  if (grant.computer === 'apps' && grant.computerApps.length > 0) out.push('computer');
  return out;
}

/** How a seat engine reaches the server, as the sheet explains it. */
export type VerseMcpSeatSupport =
  | { supported: true; transport: 'http' | 'stdio'; note: string }
  | { supported: false; reason: string };

/**
 * Per-engine injection (verse-mcp-launch.ts), for the sheet. Devin's cloud
 * lane runs on Cognition's machines and cannot reach this Mac's loopback
 * server, so it is the one seat that cannot use the tools.
 */
export function verseMcpSeatSupport(engine: string, devinLane: 'cloud' | 'cli' | null = null): VerseMcpSeatSupport {
  switch (engine) {
    case 'claude':
    case 'local':
      return { supported: true, transport: 'http', note: 'Loaded from a private per-turn config file.' };
    case 'codex':
      return { supported: true, transport: 'stdio', note: 'Loaded through Ashlr\'s stdio bridge for each turn.' };
    case 'grok':
      return { supported: true, transport: 'stdio', note: 'Loaded through Ashlr\'s stdio bridge from this account\'s own Grok profile.' };
    case 'devin':
      return devinLane === 'cloud'
        ? { supported: false, reason: 'Devin cloud runs on Cognition\'s machines and cannot reach tools on this Mac. Use the Devin CLI seat for terminal and browser tools.' }
        : { supported: true, transport: 'http', note: 'Offered to the Devin CLI over ACP, and Devin\'s own terminals run in a visible Verse tab.' };
    default:
      return { supported: false, reason: 'This seat cannot load Ashlr\'s tools.' };
  }
}

/** One command the agent ran or asked for, for the chat's recent-actions strip. */
export interface VerseAgentAction {
  id: string;
  at: string;
  tool: string;
  /** Short, scrubbed description (`npm test` in "proj"). */
  summary: string;
  tabId: string | null;
  outcome: 'ok' | 'error' | 'denied' | 'pending';
}

export type VerseMcpConfirmAnswer = 'once' | 'chat' | 'deny';

/** A destructive command waiting for the operator (≤ 120 s). */
export interface VerseAgentPendingConfirmation {
  id: string;
  sessionId: string;
  at: string;
  expiresAt: string;
  tool: string;
  /** The rule that matched (`rm-rf`, `git-force-push`, …) — "Allow for chat" allows this rule. */
  rule: string;
  /** Why it needs a yes, in one sentence. */
  reason: string;
  /** The command, scrubbed. */
  command: string;
  tabId: string | null;
}

/** An agent-controlled terminal tab as the Terminal pane sees it. */
export interface VerseAgentTabInfo {
  tabId: string;
  /** The chat whose agent opened it (agent tab) or may use it (shared shell). */
  sessionId: string;
  kind: 'agent' | 'shared';
  /** Set while the operator has taken the shell over; the agent's writes are refused until "Resume agent". */
  takenOverAt: string | null;
}

/** The seat's name as the sheet and the Terminal pane say it ("Share this shell with Codex"). */
export function verseSeatToolLabel(engine: string): string {
  switch (engine) {
    case 'claude': return 'Claude';
    case 'local': return 'the local model';
    case 'codex': return 'Codex';
    case 'grok': return 'Grok';
    case 'devin': return 'Devin';
    default: return 'the agent';
  }
}

export interface VerseAgentToolsState {
  sessionId: string;
  /** verseSeatToolLabel(engine) for the chat's seat. */
  seatLabel: string;
  grant: VerseAgentToolsGrant;
  scopes: VerseMcpScope[];
  /** Operator shells of this chat shared with its agent (tab ids). */
  sharedTabs: string[];
  support: VerseMcpSeatSupport;
  /** False under Node (no PTY / no native webview): terminal and computer tools answer "desktop app only". */
  desktop: boolean;
  /** A turn currently holds a live token. */
  turnActive: boolean;
}

export interface VerseAgentToolsActivity {
  sessionId: string;
  pending: VerseAgentPendingConfirmation[];
  actions: VerseAgentAction[];
  tabs: VerseAgentTabInfo[];
}

export interface VerseAgentToolsGrantRequest {
  sessionId: string;
  terminal?: VerseAgentTerminalMode;
  browser?: VerseAgentBrowserMode;
  browserScript?: boolean;
  computer?: VerseAgentComputerMode;
  computerApps?: string[];
}
