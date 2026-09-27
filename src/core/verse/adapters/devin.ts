/**
 * Devin adapter (3.15).
 *
 * Launch: Verse's OWN turn process (core/devin/chat-turn-process.ts, argv
 * resolved per runtime by chat-turn-invocation.ts, no operand), with the whole request as ONE JSON object on stdin —
 * the lane (cloud API session / local `devin acp`), the chat's native id
 * (the Devin task id `dv_…` on the cloud lane, the ACP session id on the CLI
 * lane), the text, the permission mode, the CLI path and model. Nothing
 * secret: the turn process reads the Devin key from the Keychain itself.
 *
 * Parse: the process prints turn-protocol lines (core/devin/turn-protocol.ts)
 * that are already in Verse's vocabulary. They are still re-validated field by
 * field here — a line that does not match its shape exactly is dropped.
 *
 * Native id: like codex, Devin names the conversation, so a new chat has none
 * until the first turn prints `native-session`.
 */
import { devinChatTurnArgv } from '../../devin/chat-turn-invocation.js';
import type { DevinTurnPayload } from '../../devin/turn-protocol.js';
import { effectiveControls } from '../session-controls.js';
import { VERSE_REMOTE_STATES, type VerseDevinLane, type VerseRemoteState, type VerseSession, type VerseTurnLaunch } from '../types.js';
import type { VerseSeatLaunch } from '../session-engine.js';
import type { VerseAdapter, VerseParsedEvent, VerseTurnParser } from './index.js';

/** The model option a Devin seat lists when it runs the CLI's (or Devin's) own default. */
export const DEVIN_DEFAULT_MODEL_ID = 'devin';

const MAX_TEXT = 100_000;
const MAX_ID = 200;
const PROGRESS_PHASES = new Set(['thinking', 'tool', 'writing', 'waiting']);
const REMOTE_STATES = new Set<string>(VERSE_REMOTE_STATES);
const GITHUB_PR = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

/** Env the turn process needs besides the engine's base set: where Ashlr and the Devin CLI keep their state. */
const PASS_ENV = ['ASHLR_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'] as const;

export function devinLaneOf(session: Pick<VerseSession, 'seatId'>, launch: Pick<VerseSeatLaunch, 'devin'>): VerseDevinLane {
  const lane = launch.devin?.lane;
  if (lane === 'cloud' || lane === 'cli') return lane;
  return session.seatId === 'devin-cli' ? 'cli' : 'cloud';
}

function buildDevinLaunch(session: VerseSession, text: string, launch: VerseSeatLaunch): VerseTurnLaunch {
  const lane = devinLaneOf(session, launch);
  const cliPath = lane === 'cli' ? launch.devin?.cliPath ?? null : null;
  if (lane === 'cli' && !cliPath) throw new Error('the Devin CLI was not found on this Mac');
  const payload: DevinTurnPayload = {
    v: 1,
    lane,
    verseSessionId: session.id,
    nativeId: session.nativeSessionId,
    projectPath: session.projectPath,
    text,
    permissionMode: effectiveControls(session).permissionMode,
    cliPath,
    model: lane === 'cli' && session.model && session.model !== DEVIN_DEFAULT_MODEL_ID ? session.model : null,
  };
  const env: Record<string, string> = {};
  for (const key of PASS_ENV) {
    const value = process.env[key];
    if (typeof value === 'string' && value.startsWith('/')) env[key] = value;
  }
  // Resolved per turn, never read from the launch record: the turn process is
  // Verse's own (not an account's identity), and the node binary or install
  // path it lives at can change between the chat's creation and this turn.
  return { argv: devinChatTurnArgv(), cwd: session.projectPath, env, stdin: JSON.stringify(payload) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length <= max ? value : null;
const nullableNumber = (value: unknown): number | null | undefined =>
  value === null ? null : typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function httpsUrl(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** One protocol line → an event, or null (dropped). Exported for tests. */
export function devinLineToEvent(line: Record<string, unknown>, turnId: string): VerseParsedEvent | null {
  switch (line['type']) {
    case 'assistant-message':
    case 'text-delta':
    case 'thinking':
    case 'thinking-delta': {
      const text = str(line['text'], MAX_TEXT);
      if (text === null || text === '') return null;
      return { type: line['type'], turnId, text } as VerseParsedEvent;
    }
    case 'tool-use': {
      const toolUseId = str(line['toolUseId'], MAX_ID);
      const name = str(line['name'], MAX_ID);
      if (!toolUseId || !name) return null;
      return { type: 'tool-use', turnId, toolUseId, name, input: line['input'] ?? {} };
    }
    case 'tool-result': {
      const toolUseId = str(line['toolUseId'], MAX_ID);
      const output = str(line['output'], MAX_TEXT);
      if (!toolUseId || output === null || typeof line['isError'] !== 'boolean') return null;
      return { type: 'tool-result', turnId, toolUseId, output, isError: line['isError'] };
    }
    case 'progress': {
      const phase = line['phase'];
      const elapsedMs = line['elapsedMs'];
      if (typeof phase !== 'string' || !PROGRESS_PHASES.has(phase) || typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
      const tool = str(line['tool'], 80);
      return { type: 'progress', turnId, phase: phase as 'thinking', elapsedMs, ...(tool ? { tool } : {}) };
    }
    case 'remote-status': {
      const state = line['state'];
      const message = str(line['message'], 500);
      const url = httpsUrl(line['url']);
      const acusConsumed = nullableNumber(line['acusConsumed']);
      const acuCap = nullableNumber(line['acuCap']);
      if (typeof state !== 'string' || !REMOTE_STATES.has(state) || !message || url === undefined || acusConsumed === undefined || acuCap === undefined) return null;
      return { type: 'remote-status', turnId, provider: 'devin', state: state as VerseRemoteState, message, url, acusConsumed, acuCap };
    }
    case 'remote-pr': {
      const url = typeof line['url'] === 'string' && GITHUB_PR.test(line['url']) ? line['url'] : null;
      const state = line['state'] === null ? null : str(line['state'], 40);
      if (!url || (line['state'] !== null && state === null)) return null;
      return { type: 'remote-pr', turnId, provider: 'devin', url, state };
    }
    case 'error': {
      const message = str(line['message'], 4_000);
      if (!message) return null;
      const code = str(line['code'], 60);
      return { type: 'error', turnId, message, ...(code ? { code } : {}) };
    }
    default:
      return null;
  }
}

export function createDevinParser(turnId: string): VerseTurnParser {
  let nativeId: string | null = null;
  return {
    push(raw: string): VerseParsedEvent[] {
      const trimmed = raw.trim();
      if (!trimmed.startsWith('{')) return [];
      let line: unknown;
      try {
        line = JSON.parse(trimmed);
      } catch {
        return [];
      }
      if (!isRecord(line)) return [];
      if (line['type'] === 'native-session') {
        const id = str(line['id'], MAX_ID);
        if (id && /^[A-Za-z0-9._:-]+$/.test(id)) nativeId = id;
        return [];
      }
      const event = devinLineToEvent(line, turnId);
      return event ? [event] : [];
    },
    finish(): VerseParsedEvent[] {
      return [];
    },
    nativeSessionId(): string | null {
      return nativeId;
    },
  };
}

export const devinAdapter: VerseAdapter = {
  buildLaunch: buildDevinLaunch,
  createParser: createDevinParser,
  // A cloud chat's FIRST message launches a Devin task (launchDevinTask), which
  // resolves the `!macro` itself and pins the version on the task record.
  // Follow-ups and every CLI turn get the block from the engine.
  resolvesPlaybooks: (session, launch) => devinLaneOf(session, launch) === 'cloud' && !session.nativeSessionId,
};
