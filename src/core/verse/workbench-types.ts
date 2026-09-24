/**
 * Verse 3.10 workbench — cross-unit contracts (unit C0, frozen once written).
 *
 * SPEC-310C builds the workbench in parallel: C1 shell/palette/activity, C2
 * chat + dock, C3 composer, C4 terminal + preview, C5 git, C6 apps, C7
 * surfaces, C8 native — and Track B's autonomy units feed it (R1). Every shape
 * two of those units exchange is declared HERE, once, so each can build
 * against fixtures on day 0 and the pieces fit when they land:
 *
 *   §1 information architecture (surfaces, tray, the v2 → v3 migration)
 *   §2 Needs you (R1: the item B-U1 / B-U5 / B-U8 export, and the drawer acts on)
 *   §3 activity + session meta (C1; the engine signatures C3 implements)
 *   §4 session controls, attachments, queue, files (C3)
 *   §5 terminal (C4)   §6 preview (C4)   §7 git / review / PR (C5)
 *   §8 apps & accounts (C6)
 *   §9 the route families C0 mounts in verse-api.ts
 *
 * Honesty rule (docs/VERSE-TELEMETRY-V2.md): `null` means UNKNOWN, never
 * "none" or "zero". Copy is operator language with units; no file paths,
 * stack traces or secrets in any string field.
 *
 * BROWSER-SAFE: the web bundle imports this (type-only via data/api-types.ts,
 * plus the plain constants). Type-only imports and plain data — no node:
 * modules, ever.
 */
import type {
  VerseEffort,
  VerseEngine,
  VersePermissionMode,
  VerseProgressPhase,
  VerseSessionControls,
} from './types.js';

export type { VerseEffort, VersePermissionMode, VerseSessionControls };

// ===========================================================================
// §1 Information architecture (SPEC-310C §0.1, SPEC-310B §6)
// ===========================================================================

/** The rail, in ⌘1–⌘5 order. Chat moved from ⌘1 to ⌘5 in 3.10. */
export const WORKBENCH_SURFACES = ['command', 'fleet', 'growth', 'mind', 'chat'] as const;
export type WorkbenchSurfaceId = (typeof WORKBENCH_SURFACES)[number];

/** Sections reached from the gear tray, not the rail (Shortcuts is an overlay, not a section). */
export const WORKBENCH_TRAY_SECTIONS = ['settings', 'apps', 'usage'] as const;
export type WorkbenchTraySectionId = (typeof WORKBENCH_TRAY_SECTIONS)[number];

export type WorkbenchSectionId = WorkbenchSurfaceId | WorkbenchTraySectionId;

export const WORKBENCH_SECTION_IDS: readonly WorkbenchSectionId[] = [...WORKBENCH_SURFACES, ...WORKBENCH_TRAY_SECTIONS];

export function isWorkbenchSectionId(value: unknown): value is WorkbenchSectionId {
  return typeof value === 'string' && (WORKBENCH_SECTION_IDS as readonly string[]).includes(value);
}

/** The `section` values `ashlr.verse.ui.v2` could hold. */
export type LegacyVerseSectionId = 'chat' | 'autonomy' | 'approvals' | 'usage' | 'settings' | 'mcp';

export interface SectionMigration {
  section: WorkbenchSectionId;
  /** Approvals became the Needs-you drawer: land on Command WITH the drawer open. */
  openNeedsYou: boolean;
}

/**
 * v2 → v3 (SPEC-310C §0.1): autonomy → fleet, approvals → command + drawer,
 * mcp → apps. Chat, Usage and Settings keep their ids.
 */
export const LEGACY_SECTION_MIGRATION: Readonly<Record<LegacyVerseSectionId, SectionMigration>> = {
  chat: { section: 'chat', openNeedsYou: false },
  autonomy: { section: 'fleet', openNeedsYou: false },
  approvals: { section: 'command', openNeedsYou: true },
  usage: { section: 'usage', openNeedsYou: false },
  settings: { section: 'settings', openNeedsYou: false },
  mcp: { section: 'apps', openNeedsYou: false },
};

/**
 * A stored `section` value → its v3 home. A v3 id passes through; a v2 id is
 * migrated; anything else (a hand-edited or future value) is null, and the
 * caller falls back to its own default rather than to a guess.
 */
export function migrateSectionId(value: unknown): SectionMigration | null {
  if (typeof value !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(LEGACY_SECTION_MIGRATION, value)) {
    return LEGACY_SECTION_MIGRATION[value as LegacyVerseSectionId];
  }
  return isWorkbenchSectionId(value) ? { section: value, openNeedsYou: false } : null;
}

/**
 * Engine identity is a 2px tick plus a one-letter monogram — never a vendor
 * logo (SPEC-310C §6). One table so the rail, sidebar, Apps and the native
 * notifications all print the same letter.
 */
export const ENGINE_MONOGRAM: Readonly<Record<VerseEngine, 'C' | 'X' | 'G' | 'L'>> = {
  claude: 'C',
  codex: 'X',
  grok: 'G',
  local: 'L',
};

// ===========================================================================
// §2 Needs you (cross-track request R1)
// ===========================================================================
//
// ONE inbox for everything waiting on Mason: approvals, fleet holds, Leader
// questions and vetoes, grant renewal, failed chats, seats to reconnect.
// Producers:
//   - C1 derives `approvals` (inbox), `chats` and `accounts` (A2 health);
//   - B-U1, B-U5 and B-U8 each EXPORT `needsYouItems(): NeedsYouItem[]` —
//     see NEEDS_YOU_PROVIDERS for where C1's activity route looks for them.
// An item carries its own actions (route + confirmation), so the drawer is
// generic: it never needs to know what a grant or an owner-lane PR is.

export const NEEDS_YOU_SOURCES = ['approvals', 'authority', 'fleet', 'leader', 'chats', 'accounts'] as const;
export type NeedsYouSource = (typeof NEEDS_YOU_SOURCES)[number];

/**
 * What the item is. A new kind is a C0 contract change (send the request):
 * the drawer's split and the native notification copy both key off it.
 */
export const NEEDS_YOU_KINDS = [
  // approvals split
  'approval', // an inbox proposal waiting for approve / reject
  'owner-lane-pr', // G1: a fleet PR on the owner lane — never auto-merged
  'class-c', // a Leader action outside the grant: Mason only, argument attached
  // fleet split
  'veto-window', // a class-B Leader action that applies when its window closes
  'leader-question', // the memo's questionsForMason
  'owner-hold', // a repo on owner-hold (one-click resume)
  'quarantine', // a repo quarantined after a post-merge red
  'revert', // a fleet merge was reverted
  'grant', // grant renewal / expiring / paused ("authority code changed")
  'kill', // the fleet is stopped (KILL or a soft kill)
  // chats split
  'chat-failed', // a turn failed and has not been looked at
  'queue-held', // a queued follow-up is held after a failure or Stop
  // accounts split
  'reconnect', // a seat is signed out or its credential is expiring
  'repin', // a seat is pinned to an older CLI than the newest installed
] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

/** The drawer's splits besides All (SPEC-310C §1: H / L switch between them). */
export const NEEDS_YOU_CATEGORIES = ['approvals', 'fleet', 'chats', 'accounts'] as const;
export type NeedsYouCategory = (typeof NEEDS_YOU_CATEGORIES)[number];

/** Split is a pure function of kind, so a producer can never file an item in the wrong one. */
export const NEEDS_YOU_KIND_CATEGORY: Readonly<Record<NeedsYouKind, NeedsYouCategory>> = {
  approval: 'approvals',
  'owner-lane-pr': 'approvals',
  'class-c': 'approvals',
  'veto-window': 'fleet',
  'leader-question': 'fleet',
  'owner-hold': 'fleet',
  quarantine: 'fleet',
  revert: 'fleet',
  grant: 'fleet',
  kill: 'fleet',
  'chat-failed': 'chats',
  'queue-held': 'chats',
  reconnect: 'accounts',
  repin: 'accounts',
};

export function needsYouCategory(item: Pick<NeedsYouItem, 'kind'>): NeedsYouCategory {
  return NEEDS_YOU_KIND_CATEGORY[item.kind];
}

/** Same vocabulary as ReasoningInsight severity. */
export type NeedsYouSeverity = 'info' | 'warn' | 'high';

/**
 * Drawer keys (SPEC-310C §1): A approves, R rejects, V vetoes, E marks done.
 * `resume`, `renew` and `fix` are buttons only.
 */
export const NEEDS_YOU_ACTION_KINDS = ['approve', 'reject', 'veto', 'done', 'resume', 'renew', 'fix'] as const;
export type NeedsYouActionKind = (typeof NEEDS_YOU_ACTION_KINDS)[number];

export const NEEDS_YOU_ACTION_KEYS: Readonly<Partial<Record<NeedsYouActionKind, 'A' | 'R' | 'V' | 'E'>>> = {
  approve: 'A',
  reject: 'R',
  veto: 'V',
  done: 'E',
};

export interface NeedsYouConfirm {
  title: string;
  body: string;
  confirmLabel: string;
}

export interface NeedsYouAction {
  kind: NeedsYouActionKind;
  /** Button text, operator language: "Approve", "Veto", "Resume repo". */
  label: string;
  /**
   * The same-origin route the drawer POSTs (JSON body, mutation token) — always
   * under `/api/` (isNeedsYouItem enforces it). Null when the action cannot be
   * taken from the page (it needs Touch ID or a terminal): the drawer opens the
   * item's `target` instead, where that flow lives.
   */
  request: { method: 'POST'; path: string; body: Record<string, unknown> } | null;
  /**
   * Dialog text. The drawer confirms approve / reject / veto ALWAYS
   * (SPEC-310C: keyboard triage goes through confirmation, then the token) —
   * a null here gets its generic copy; other kinds confirm only when set.
   */
  confirm: NeedsYouConfirm | null;
  /** Painted as a destructive action (reject, veto, close). */
  destructive: boolean;
}

/** Where Enter goes. */
export type NeedsYouTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'approval'; proposalId: string }
  | { kind: 'section'; section: WorkbenchSectionId; anchor: string | null }
  | { kind: 'seat'; seatId: string }
  /** Opened outside the app (a GitHub PR). https only. */
  | { kind: 'url'; url: string };

/** What the row is about, for its meta line. Every field null when not applicable. */
export interface NeedsYouSubject {
  repo: string | null;
  pr: number | null;
  seatId: string | null;
  sessionId: string | null;
  engine: VerseEngine | null;
}

export interface NeedsYouItem {
  /**
   * Stable across polls AND restarts — `<source>:<kind>:<ref>` (e.g.
   * `fleet:owner-hold:ashlrai/binshield`). The drawer's selection, "seen" and
   * native "N new" counting all key on it.
   */
  id: string;
  source: NeedsYouSource;
  kind: NeedsYouKind;
  severity: NeedsYouSeverity;
  /** One line, ≤ 120 chars, operator language with units. Never a path or a trace. */
  title: string;
  /** Optional second line — the Leader's argument, the failing check. */
  detail: string | null;
  /** ISO time it became actionable. */
  since: string;
  /** ISO time it stops being actionable on its own (veto window close, grant expiry); null = never. */
  expiresAt: string | null;
  subject: NeedsYouSubject;
  target: NeedsYouTarget;
  actions: NeedsYouAction[];
}

/**
 * R1: `export function needsYouItems(): NeedsYouItem[]`. PURE and served from
 * the producer's own cache: activity calls it on every poll (Rust every 5 s),
 * so it must return in well under a millisecond and never do I/O on the
 * caller's stack. A producer that cannot answer throws — activity then reports
 * `sources.<source>: 'error'` rather than an all-clear it cannot vouch for.
 */
export type NeedsYouItemsProvider = () => NeedsYouItem[];

/**
 * Where C1's activity route lazy-imports each Track B producer from: the
 * unit's own mounted API module (§9), which activity can import without a
 * load-time edge into core/{authority,fleet,vision}. A module that has not
 * landed makes activity report that source `unavailable` — never a false
 * all-clear. Moving a producer is a C0 contract change.
 */
export const NEEDS_YOU_PROVIDERS = [
  { source: 'authority', owner: 'B-U1', module: 'src/core/verse/authority-api.ts', exportName: 'needsYouItems' },
  { source: 'fleet', owner: 'B-U5', module: 'src/core/verse/fleet-live-api.ts', exportName: 'needsYouItems' },
  { source: 'leader', owner: 'B-U8', module: 'src/core/verse/leader-api.ts', exportName: 'needsYouItems' },
] as const satisfies readonly { source: NeedsYouSource; owner: string; module: string; exportName: 'needsYouItems' }[];

export const NEEDS_YOU_TITLE_MAX = 120;
export const NEEDS_YOU_DETAIL_MAX = 400;
const NEEDS_YOU_ID_MAX = 200;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isIso(value: unknown): value is string {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function isNullableString(value: unknown, max: number): boolean {
  return value === null || (typeof value === 'string' && value.length <= max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A same-origin API route: `/api/…`, no scheme, no host, no `..`, no
 * backslash, no whitespace. The drawer POSTs these WITH the mutation token, so
 * an item must never be able to aim that token anywhere else.
 */
export function isSafeApiRoute(path: unknown): path is string {
  return typeof path === 'string'
    && path.length <= 512
    && path.startsWith('/api/')
    && !path.startsWith('//')
    && !path.includes('..')
    && !/[\s\\]/.test(path);
}

function isTarget(value: unknown): value is NeedsYouTarget {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'session':
      return typeof value['sessionId'] === 'string' && value['sessionId'].length > 0;
    case 'approval':
      return typeof value['proposalId'] === 'string' && value['proposalId'].length > 0;
    case 'section':
      return isWorkbenchSectionId(value['section']) && isNullableString(value['anchor'], 200);
    case 'seat':
      return typeof value['seatId'] === 'string' && value['seatId'].length > 0;
    case 'url':
      return typeof value['url'] === 'string' && /^https:\/\/[^\s]+$/.test(value['url']) && value['url'].length <= 2048;
    default:
      return false;
  }
}

function isAction(value: unknown): value is NeedsYouAction {
  if (!isRecord(value)) return false;
  if (!(NEEDS_YOU_ACTION_KINDS as readonly unknown[]).includes(value['kind'])) return false;
  if (typeof value['label'] !== 'string' || value['label'].length === 0 || value['label'].length > 60) return false;
  if (typeof value['destructive'] !== 'boolean') return false;
  const request = value['request'];
  if (request !== null) {
    if (!isRecord(request) || request['method'] !== 'POST' || !isSafeApiRoute(request['path']) || !isRecord(request['body'])) {
      return false;
    }
  }
  const confirm = value['confirm'];
  if (confirm !== null) {
    if (!isRecord(confirm)) return false;
    for (const key of ['title', 'body', 'confirmLabel'] as const) {
      if (typeof confirm[key] !== 'string' || (confirm[key] as string).length === 0) return false;
    }
  }
  return true;
}

/**
 * Boundary check for items that come from ANOTHER unit's producer. Activity
 * drops (and counts) anything that fails, so one malformed producer degrades
 * to "that source errored" instead of breaking the drawer or smuggling a
 * foreign route into a token-bearing POST.
 */
export function isNeedsYouItem(value: unknown): value is NeedsYouItem {
  if (!isRecord(value)) return false;
  const id = value['id'];
  if (typeof id !== 'string' || id.length === 0 || id.length > NEEDS_YOU_ID_MAX) return false;
  if (!(NEEDS_YOU_SOURCES as readonly unknown[]).includes(value['source'])) return false;
  if (!(NEEDS_YOU_KINDS as readonly unknown[]).includes(value['kind'])) return false;
  if (!['info', 'warn', 'high'].includes(value['severity'] as string)) return false;
  const title = value['title'];
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > NEEDS_YOU_TITLE_MAX) return false;
  if (!isNullableString(value['detail'], NEEDS_YOU_DETAIL_MAX)) return false;
  if (!isIso(value['since'])) return false;
  if (value['expiresAt'] !== null && !isIso(value['expiresAt'])) return false;
  const subject = value['subject'];
  if (!isRecord(subject)) return false;
  for (const key of ['repo', 'seatId', 'sessionId'] as const) {
    if (!isNullableString(subject[key], 300)) return false;
  }
  if (subject['pr'] !== null && !(Number.isInteger(subject['pr']) && (subject['pr'] as number) > 0)) return false;
  if (subject['engine'] !== null && !['claude', 'codex', 'grok', 'local'].includes(subject['engine'] as string)) return false;
  if (!isTarget(value['target'])) return false;
  const actions = value['actions'];
  return Array.isArray(actions) && actions.length <= 6 && actions.every(isAction);
}

// ===========================================================================
// §3 Activity + session meta (C1) and the engine signatures behind it (C3)
// ===========================================================================

export const VERSE_ACTIVITY_PATH = '/api/verse/activity';
export const VERSE_ACTIVITY_SEEN_PATH = '/api/verse/activity/seen';
export const VERSE_SESSION_META_PATH = '/api/verse/session-meta';

/** Activity must answer in < 5 ms (SPEC-310C budgets): everything it reads is already in memory. */
export const VERSE_ACTIVITY_BUDGET_MS = 5;

/**
 * ENGINE SIGNATURE (C3 implements on the engine handle; C1's activity reads
 * it): what a running turn is doing right now, folded from the transient
 * `progress` / `thinking-delta` events the engine already fans out. Returns
 * null when the session has no running turn. O(1), no I/O.
 */
export interface VerseLiveStatus {
  sessionId: string;
  turnId: string;
  /** ISO start of the running turn. */
  startedAt: string;
  /** Last `progress.phase`; null before the first progress event. */
  phase: VerseProgressPhase | null;
  /** The running tool when `phase` is `tool` ("npm test"); null otherwise. */
  tool: string | null;
  /** Wall time since `startedAt`, computed at peek time. */
  elapsedMs: number;
  /** Last ≤ VERSE_LIVE_THINKING_TAIL_CHARS of streamed reasoning, scrubbed; null when none streamed. */
  thinkingTail: string | null;
  outTokens: number | null;
  tokPerSec: number | null;
}
export type PeekLiveStatus = (sessionId: string) => VerseLiveStatus | null;
export const VERSE_LIVE_THINKING_TAIL_CHARS = 160;

export type VerseTurnOutcome = 'ok' | 'failed' | 'cancelled';

/**
 * ENGINE SIGNATURE (C3): one finished turn. `seq` is an engine-wide counter,
 * PROCESS-LOCAL — it restarts at 0 with the server, which is why activity's
 * wire cursor (VerseActivityResponse.cursor) is opaque and carries a boot id.
 */
export interface VerseTurnEnd {
  seq: number;
  sessionId: string;
  turnId: string;
  outcome: VerseTurnOutcome;
  /** ISO end time. */
  at: string;
  durationMs: number | null;
  /** The session's turnCount after this turn — unread = turnCount > seenTurnCount. */
  turnCount: number;
}

/**
 * ENGINE SIGNATURE (C3): turn ends with `seq > cursor`, oldest first. The
 * engine keeps the last VERSE_TURN_END_BUFFER in memory; a cursor older than
 * that gets what is left (activity never replays a log from disk).
 */
export type TurnEndsSince = (cursor: number) => { cursor: number; ends: VerseTurnEnd[] };
export const VERSE_TURN_END_BUFFER = 200;

export interface VerseActivityLive {
  phase: VerseProgressPhase | null;
  tool: string | null;
  elapsedMs: number;
  thinkingTail: string | null;
}

export interface VerseActivityRunning {
  sessionId: string;
  title: string;
  engine: VerseEngine;
  seatId: string;
  startedAt: string;
  /** Null when the engine could not be peeked (the row still shows "running"). */
  live: VerseActivityLive | null;
}

export interface VerseActivityCompletion {
  sessionId: string;
  title: string;
  outcome: VerseTurnOutcome;
  at: string;
  durationMs: number | null;
}

export interface VerseActivityCounts {
  running: number;
  needsYou: number;
  unread: number;
}

/**
 * Per producer: `ok` answered; `unavailable` its module has not landed or is
 * not mounted in this build; `error` it threw or returned items that failed
 * isNeedsYouItem. Anything but `ok` means the drawer must NOT say "All clear"
 * for that split.
 */
export type VerseActivitySourceState = 'ok' | 'unavailable' | 'error';
export type VerseActivitySources = Record<NeedsYouSource, VerseActivitySourceState>;

/** The rail's Fleet badge (SPEC-310C §1). Null in the response = unknown. */
export interface VerseAutonomyBadge {
  /** The clamp switch (B-U1): Off | Propose | Autonomous. */
  mode: 'off' | 'propose' | 'autonomous';
  /** Grant paused ("authority code changed — re-approve") or expired. */
  paused: boolean;
  /** KILL / soft kill in force. */
  stopped: boolean;
  /** Operator-language one-liner for the tooltip: "Autonomous · 5 building". */
  label: string;
}

/** The rail foot's capacity ring: the scarcest seat. */
export interface VerseCapacityBadge {
  seatId: string;
  engine: VerseEngine;
  label: string;
  /** 0–100 of the binding window. */
  usedPercent: number;
  /** Window label as the seat names it ("5h", "weekly"). */
  window: string;
  resetsAt: string | null;
}

/** The rail's Mind dot. */
export interface VerseMindBadge {
  latestMemoAt: string | null;
  /** A memo newer than the operator last opened Mind. */
  unseen: boolean;
}

/** GET /api/verse/activity?since=<cursor> */
export interface VerseActivityResponse {
  /** Opaque; send back as `?since=`. A different boot id resets completions (never an error). */
  cursor: string;
  generatedAt: string;
  running: VerseActivityRunning[];
  needsYou: NeedsYouItem[];
  /** Turn ends after `since`, oldest first (empty on the first poll: history is not "new"). */
  completions: VerseActivityCompletion[];
  counts: VerseActivityCounts;
  sources: VerseActivitySources;
  autonomy: VerseAutonomyBadge | null;
  capacity: VerseCapacityBadge | null;
  mind: VerseMindBadge | null;
}

/** POST /api/verse/activity/seen — the operator has looked at this chat up to `turnCount`. */
export interface VerseActivitySeenRequest {
  sessionId: string;
  turnCount: number;
}

/** Per-chat organisation + read state (NOT in the session record: the engine owns that). */
export interface VerseSessionMeta {
  sessionId: string;
  pinned: boolean;
  archived: boolean;
  /** Highest turnCount the operator has seen; 0 = never opened. */
  seenTurnCount: number;
}

/** GET /api/verse/session-meta → every chat with non-default meta. GET …/:id → VerseSessionMeta. */
export interface VerseSessionMetaResponse {
  sessions: Record<string, VerseSessionMeta>;
}

/** POST /api/verse/session-meta/:id — unknown keys are a 400. */
export interface VerseSessionMetaUpdate {
  pinned?: boolean;
  archived?: boolean;
}

// ===========================================================================
// §4 Session controls, attachments, queue, files (C3)
// ===========================================================================

export const VERSE_SESSION_CONTROLS_PATH = '/api/verse/session-controls';
export const VERSE_SESSION_CONTROL_DEFAULTS_PATH = '/api/verse/session-controls/defaults';
export const VERSE_ATTACHMENTS_PATH = '/api/verse/attachments';
export const VERSE_QUEUE_PATH = '/api/verse/queue';
export const VERSE_FILES_PATH = '/api/verse/files';

/** One picker option. Unavailable options are shown DISABLED with `reason`, never hidden. */
export interface VerseControlOption<T extends string = string> {
  id: T;
  label: string;
  available: boolean;
  reason?: string;
  /** Painted red (bypass). */
  danger?: boolean;
}

/** GET|POST /api/verse/session-controls/:id */
export interface VerseSessionControlsResponse {
  sessionId: string;
  /** Effective values: `model` is the session's model; `effort` null = the CLI's own default. */
  controls: { model: string; effort: VerseEffort | null; permissionMode: VersePermissionMode };
  /** True while a turn runs: the change is recorded now and applies from the next turn. */
  appliesNextTurn: boolean;
  options: {
    models: VerseControlOption[];
    efforts: VerseControlOption<VerseEffort>[];
    permissionModes: VerseControlOption<VersePermissionMode>[];
  };
}

/**
 * POST /api/verse/session-controls/:id — unknown keys are a 400. `effort: null`
 * resets to the CLI default. Setting `permissionMode: 'bypass'` REQUIRES
 * `confirmBypass: true` (400 otherwise): the palette and the picker both
 * reach this route, and neither may turn every check off with one keystroke.
 */
export interface VerseSessionControlsUpdate {
  model?: string;
  effort?: VerseEffort | null;
  permissionMode?: VersePermissionMode;
  confirmBypass?: true;
}

/**
 * GET|POST /api/verse/session-controls/defaults — what a NEW chat starts with.
 * `bypass` is refused here: it is confirmed per chat, never inherited.
 */
export interface VerseSessionControlDefaults {
  global: VerseSessionControls;
  seats: Record<string, VerseSessionControls>;
}
export interface VerseSessionControlDefaultsUpdate {
  /** Absent = the global default. */
  seatId?: string;
  effort?: VerseEffort | null;
  permissionMode?: Exclude<VersePermissionMode, 'bypass'>;
}

/** POST /api/verse/attachments/:sessionId (body cap raised for this route only). */
export interface VerseAttachmentUpload {
  name: string;
  mime: string;
  dataBase64: string;
}
export interface VerseAttachment {
  id: string;
  sessionId: string;
  /** Sanitised display name. */
  name: string;
  mime: string;
  bytes: number;
  /** The `@path` token the composer inserts (`~`-relative, as every response is sanitised). */
  ref: string;
  createdAt: string;
}
/** Per file. Stored 0600 under ~/.ashlr/verse/attachments/<sid>/ and granted with exactly that `--add-dir`. */
export const VERSE_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/** GET /api/verse/queue/:sessionId; POST …/:sessionId {text}; POST …/:sessionId/:qid/delete */
export interface VerseQueuedTurn {
  id: string;
  sessionId: string;
  text: string;
  createdAt: string;
}
export interface VerseQueueResponse {
  sessionId: string;
  items: VerseQueuedTurn[];
  /** After a failed or stopped turn the queue HOLDS and asks, instead of draining. */
  held: boolean;
  heldReason: string | null;
}
/**
 * POST /api/verse/queue/:sessionId. `sendNow` (⇧⌘↩ / "Send now") stops the
 * running turn and makes this text the next turn instead of queueing it last.
 */
export interface VerseQueueRequest {
  text: string;
  sendNow?: boolean;
}
/**
 * POST /api/verse/queue/:sessionId (and POST …/:sessionId/:qid/send) answer
 * with the queue PLUS the turn they started, if any — null when the text was
 * only queued behind a running turn.
 */
export interface VerseQueueSendResponse extends VerseQueueResponse {
  sentTurnId: string | null;
}
/** Additional queue route (C3): send one queued item now. */
export const VERSE_QUEUE_SEND_SUFFIX = '/send';
/** Enter during a running turn queues server-side, at most this many. */
export const VERSE_QUEUE_MAX = 3;

/** GET /api/verse/files?sessionId=&q= — the `@` fuzzy finder over the chat's roots. */
export interface VerseFileMatch {
  /** Path relative to `root`. */
  path: string;
  root: string;
}
export interface VerseFilesResponse {
  sessionId: string;
  query: string;
  files: VerseFileMatch[];
  truncated: boolean;
  /**
   * The chat's primary root (C3 addition): matches in it are inserted as bare
   * relative `@path`s, matches in other roots keep their root. Optional — an
   * older server omits it and every match is shown with its root.
   */
  primaryRoot?: string | null;
}
/*
 * Attachment routes beyond the upload (C3 additions; same family):
 *   GET  /api/verse/attachments/:sessionId            → { attachments: VerseAttachment[] }
 *   POST /api/verse/attachments/:sessionId/:aid/delete → { ok: true }
 */
export interface VerseAttachmentListResponse {
  attachments: VerseAttachment[];
}

// ===========================================================================
// §5 Terminal (C4)
// ===========================================================================

export const VERSE_TERMINAL_PATH = '/api/verse/terminal';
export const VERSE_TERMINAL_MAX_TABS = 8;
/** Per request, before base64. */
export const VERSE_TERMINAL_INPUT_MAX_BYTES = 16 * 1024;
/** Per tab, in memory only — never written to disk. */
export const VERSE_TERMINAL_SCROLLBACK_BYTES = 256 * 1024;
export const VERSE_TERMINAL_IDLE_KILL_MS = 12 * 60 * 60 * 1000;
/** SSE frames are coalesced to at most this rate. */
export const VERSE_TERMINAL_MAX_FRAME_HZ = 60;

export interface VerseTerminalTab {
  id: string;
  sessionId: string | null;
  /** The session root (or discovered project) the shell started in. */
  root: string;
  /** From the shell's OSC title; falls back to the root's name. */
  title: string;
  cols: number;
  rows: number;
  createdAt: string;
  lastActivityAt: string;
  /** Set when the shell exited; the tab stays until closed so its output can be read. */
  exited: { code: number | null; signal: string | null; at: string } | null;
  /** Opened from Apps' [Launch ▸] or Preview's dev-server Start, when it was. */
  appId: string | null;
  devServerId: string | null;
}

/** GET /api/verse/terminal. `available: false` under Node (no Bun PTY) — `reason` says "needs the desktop app". */
export interface VerseTerminalListResponse {
  available: boolean;
  reason: string | null;
  tabs: VerseTerminalTab[];
}

/** How an Apps [Launch ▸] runs an agent: its own command, or `ollama launch <id>` (C6). */
export type VerseTerminalLaunchVia = 'native' | 'ollama';

/**
 * POST /api/verse/terminal. With `appId`, the server resolves the command from
 * the apps catalog and the installed binaries (`resolveAppLaunch`) — the page
 * never supplies a command. `via` / `model` choose HOW that app launches:
 * `model` is an installed Ollama tag and implies `via: 'ollama'` (a local
 * model only launches through Ollama). Both are refused without `appId`.
 */
export interface VerseTerminalCreateRequest {
  sessionId: string;
  root?: string;
  appId?: string;
  via?: VerseTerminalLaunchVia;
  model?: string;
  devServerId?: string;
  cols: number;
  rows: number;
}

/**
 * POST /api/verse/terminal/open-external { sessionId, root? } → 202 — opens
 * Terminal.app at the root (C4 addition: the pane header's "Open in
 * Terminal.app", and the pane's fallback where no Bun PTY exists).
 */
export const VERSE_TERMINAL_OPEN_EXTERNAL_PATH = '/api/verse/terminal/open-external';
export interface VerseTerminalOpenExternalRequest {
  sessionId: string;
  root?: string;
}

/** POST /api/verse/terminal/:id/input */
export interface VerseTerminalInputRequest {
  dataBase64: string;
}

/** POST /api/verse/terminal/:id/resize */
export interface VerseTerminalResizeRequest {
  cols: number;
  rows: number;
}

/**
 * GET /api/verse/terminal/:id/stream?after=<seq> — SSE. Scrollback is sent
 * first (as `output` frames), so a reload re-attaches. `seq` counts output
 * frames per tab; `after` resumes past what the client already has.
 */
export type VerseTerminalFrame =
  | { type: 'output'; seq: number; dataBase64: string }
  | { type: 'title'; title: string }
  | { type: 'exit'; code: number | null; signal: string | null };

// ===========================================================================
// §6 Preview (C4)
// ===========================================================================

export const VERSE_PREVIEW_TARGETS_PATH = '/api/verse/preview/targets';
export const VERSE_PREVIEW_RAW_PATH = '/api/verse/preview/raw';
/** preview/raw serves at most this much (nosniff, `CSP: sandbox allow-scripts`). */
export const VERSE_PREVIEW_RAW_MAX_BYTES = 5 * 1024 * 1024;

export type VersePreviewDevServerSource = 'launch-json' | 'package-json' | 'listening';

export interface VersePreviewDevServer {
  id: string;
  label: string;
  /** Loopback http only (127.0.0.1 / localhost). */
  url: string;
  port: number;
  source: VersePreviewDevServerSource;
  running: boolean;
  root: string;
  /**
   * Exactly what Start types into a terminal tab (`npm run dev`, a launch.json
   * `runtimeExecutable` + args), so the row can show it BEFORE the click
   * (C4 addition). Null for a server only observed listening — there is
   * nothing to start. Optional: an older server omits it.
   */
  command?: string | null;
}

export type VersePreviewArtifactKind = 'html' | 'md' | 'svg' | 'image' | 'pdf';

export interface VersePreviewArtifact {
  /** Relative to the session root it lives in; served only through preview/raw. */
  path: string;
  kind: VersePreviewArtifactKind;
  bytes: number;
}

/** GET /api/verse/preview/targets?sessionId= */
export interface VersePreviewTargetsResponse {
  devServers: VersePreviewDevServer[];
  artifacts: VersePreviewArtifact[];
}

/*
 * Preview frame tickets (C4 addition). An `<iframe src>` cannot send the
 * read-client header, and a srcdoc/blob frame would inherit the page's
 * script-src, so an artifact frame is loaded through a one-file ticket:
 *   GET /api/verse/preview/ticket?sessionId=&path=  (read session)  → { url, expiresAt, kind }
 *   GET /api/verse/preview/frame/<43-char ticket>   (NO read-session check; the
 *        ticket expires in 5 min and redeems only with the minting session's cookie)
 * That frame path is the ONE route in the workbench exempt from the read-session
 * gate (core/web/server.ts), and it serves under `CSP: sandbox allow-scripts`.
 */
export const VERSE_PREVIEW_TICKET_PATH = '/api/verse/preview/ticket';
export const VERSE_PREVIEW_FRAME_PATH = '/api/verse/preview/frame';
/** The frame path's exact shape — the one server.ts lets past the read boundary. */
export const VERSE_PREVIEW_FRAME_PATH_RE = /^\/api\/verse\/preview\/frame\/([A-Za-z0-9_-]{43})$/;
export interface VersePreviewTicketResponse {
  /** The frame URL carrying the ticket (`/api/verse/preview/frame/<ticket>`). */
  url: string;
  expiresAt: string;
  kind: VersePreviewArtifactKind;
}

/**
 * Loopback http only — the one rule the Preview URL bar, the iframe and the
 * server's `frame-src` all share. Anything else gets "Open in browser ↗".
 */
export function isLoopbackPreviewUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    && url.username === ''
    && url.password === '';
}

// ===========================================================================
// §7 Git, review, PR (C5)
// ===========================================================================

export const VERSE_GIT_PATH = '/api/verse/git';
export const VERSE_GIT_STATUS_PATH = '/api/verse/git/status';
export const VERSE_GIT_DIFF_PATH = '/api/verse/git/diff';
/** Patches load lazily per file, each capped here. */
export const VERSE_GIT_PATCH_MAX_BYTES = 256 * 1024;
/** git/status answers < 300 ms and is cached this long. */
export const VERSE_GIT_STATUS_CACHE_MS = 5_000;
/** Every git/gh subprocess: async execFile, this timeout. */
export const VERSE_GIT_TIMEOUT_MS = 60_000;
/** "Isolate in worktree": ~/.ashlr-worktrees/<repo>/<name> on branch verse/<name>. */
export const VERSE_WORKTREE_DIR = '~/.ashlr-worktrees';
export const VERSE_WORKTREE_BRANCH_PREFIX = 'verse/';

/** The branch bar's primary button (SPEC-310C §2). `merge` only with green checks and a mergeable branch. */
export type VerseGitSuggestedAction = 'commit' | 'push' | 'create-pr' | 'merge' | 'view-pr' | 'none';
export type VersePrState = 'open' | 'draft' | 'merged' | 'closed';
export type VersePrChecks = 'passing' | 'failing' | 'pending' | 'none' | 'unknown';

export interface VerseGitPr {
  number: number;
  title: string;
  url: string;
  state: VersePrState;
  checks: VersePrChecks;
  /** GitHub's mergeability; null while GitHub is still computing it. */
  mergeable: boolean | null;
  headSha: string | null;
  baseRef: string;
  headRef: string;
}

export interface VerseGitDiffstat {
  files: number;
  additions: number;
  deletions: number;
}

/** GET /api/verse/git/status?root= */
export interface VerseGitStatus {
  root: string;
  name: string;
  /** Null on a detached HEAD. */
  branch: string | null;
  upstream: string | null;
  /** The branch the PR would target; null when unknown. */
  base: string | null;
  ahead: number;
  behind: number;
  /** Changed paths in the working tree (staged + unstaged + untracked). */
  dirty: number;
  /** Everything this branch would ship against `base`, uncommitted work included (the bar's ± counts). */
  diffstat: VerseGitDiffstat;
  pr: VerseGitPr | null;
  suggested: VerseGitSuggestedAction;
  checkedAt: string;
}

/**
 * `pr` is only as good as GitHub's answer (C5 addition):
 *   ok          GitHub answered — `pr: null` really means "no PR";
 *   pending     the answer is being fetched in the background (the bar says
 *               "Checking GitHub…" and re-reads shortly);
 *   unavailable gh missing, signed out, offline, or not a GitHub remote —
 *               `pr: null` means "could not look", never "no PR".
 */
export type VerseGitPrLookup = 'ok' | 'pending' | 'unavailable';

/** The counts behind `pr.checks`, for "3 of 9 checks failing". */
export interface VerseGitCheckCounts {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

/**
 * What GET /api/verse/git/status actually serves: the frozen VerseGitStatus
 * plus C5's additive fields. Kept a separate interface (not new required
 * fields on VerseGitStatus) so a fixture written against §7 still compiles.
 */
export interface VerseGitStatusDetail extends VerseGitStatus {
  /** The repository's top level. Several chat roots inside one repo share one bar row. */
  gitRoot: string;
  prLookup: VerseGitPrLookup;
  prCheckCounts: VerseGitCheckCounts | null;
  /** Conflicted paths (merge/rebase in progress). Commit is refused while > 0. */
  conflicts: number;
  /** HEAD's commit subject — the Create PR dialog's default title. Null on an unborn branch. */
  headSubject: string | null;
  /** HEAD's SHA; null on an unborn branch. */
  headSha: string | null;
}

/** Server scopes. The UI adds `turn` (from the chat's own events). */
export type VerseGitDiffScope = 'working' | 'branch';
export type VerseReviewScope = 'turn' | VerseGitDiffScope;
export type VerseGitFileStatus = 'M' | 'A' | 'D' | 'R' | 'U';

export interface VerseGitDiffFile {
  path: string;
  /** Previous path for a rename. */
  oldPath: string | null;
  status: VerseGitFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface VerseGitPatch {
  path: string;
  /** Unified diff text, possibly cut at VERSE_GIT_PATCH_MAX_BYTES. */
  text: string;
  truncated: boolean;
}

/** GET /api/verse/git/diff?root=&scope=working|branch[&file=] — `patch` only when `file` was asked. */
export interface VerseGitDiffResponse {
  root: string;
  scope: VerseGitDiffScope;
  base: string | null;
  files: VerseGitDiffFile[];
  patch: VerseGitPatch | null;
}

/** POST /api/verse/git/commit — no `paths` = every change. */
export interface VerseGitCommitRequest {
  root: string;
  message: string;
  paths?: string[];
}
/** POST /api/verse/git/push */
export interface VerseGitPushRequest {
  root: string;
}
/** POST /api/verse/git/pr — pushes first (gh refuses an unpushed branch), then opens the PR. */
export interface VerseGitPrRequest {
  root: string;
  title: string;
  body?: string;
  draft?: boolean;
  base?: string;
}
/**
 * POST /api/verse/git/pr/merge — refused unless every check passes AND GitHub's
 * head SHA still equals `headSha` (no merging a commit the operator never
 * saw). Never `--admin`.
 */
export interface VerseGitMergeRequest {
  root: string;
  number: number;
  headSha: string;
}
/** POST /api/verse/git/worktree */
export interface VerseGitWorktreeRequest {
  root: string;
  name: string;
}
export interface VerseGitWorktreeResponse {
  path: string;
  branch: string;
}
/** Every git POST answers with the fresh status (and the PR when one was opened or merged). A busy root is a 409. */
export interface VerseGitActionResponse {
  ok: true;
  status: VerseGitStatus;
  pr: VerseGitPr | null;
}

// ===========================================================================
// §8 Apps & accounts (C6; the static catalog is apps-catalog.ts)
// ===========================================================================

export const VERSE_APPS_PATH = '/api/verse/apps';

export const VERSE_APP_GROUPS = ['accounts', 'desktop', 'terminal-agents', 'local-models', 'mcp-servers'] as const;
export type VerseAppGroupId = (typeof VERSE_APP_GROUPS)[number];

export type VerseAppHealthState = 'ok' | 'warn' | 'error' | 'off' | 'unknown';

/** A dot WITH a word — never colour alone. */
export interface VerseAppHealth {
  state: VerseAppHealthState;
  /** "connected", "not installed", "8.5 tok/s", "signed out". */
  label: string;
}

export type VerseAppActionKind = 'launch' | 'reconnect' | 'fix' | 'edit-budget' | 'restore' | 'add-mcp';

export interface VerseAppAction {
  kind: VerseAppActionKind;
  label: string;
  /** The command it runs or shows (argv, never a shell string; never a secret). */
  command: string[] | null;
  /** Disabled WITH a reason, never hidden. */
  disabledReason: string | null;
}

/**
 * A toggle that changes ANOTHER app's settings (Claude Desktop "Use Ollama
 * models", Hermes Desktop). Turning it either way needs `confirm: true` and the
 * confirmation shows `command` and `restoreCommand` verbatim.
 */
export interface VerseAppToggle {
  enabled: boolean;
  command: string[];
  restoreCommand: string[];
}

export interface VerseAppRow {
  id: string;
  name: string;
  /** 32px tile letter(s). */
  monogram: string;
  /** Tints the tile for seats and engine-backed agents; null = neutral tile. */
  engine: VerseEngine | null;
  description: string;
  health: VerseAppHealth;
  /** Null = not checked (e.g. a seat row). */
  installed: boolean | null;
  version: string | null;
  /** The copy pill (⧉ → ✓ for 1.2 s). */
  copy: { label: string; text: string } | null;
  /** `ollama launch <id>`, only when the INSTALLED ollama's `launch --help` lists it. */
  ollamaLaunch: string[] | null;
  toggle: VerseAppToggle | null;
  actions: VerseAppAction[];
  /** For seat rows: the Verse seat it represents. */
  seatId: string | null;
  /** Second line: "5h 62% · weekly 40% · resets Thu · reserved for you 40%". */
  detail: string | null;
}

export interface VerseAppGroup {
  id: VerseAppGroupId;
  title: string;
  /** A standing caveat shown under the header (MCP: claude and local seats load none). */
  caveat: string | null;
  apps: VerseAppRow[];
}

/** GET /api/verse/apps (POST /api/verse/apps/refresh re-probes and answers the same). */
export interface VerseAppsResponse {
  checkedAt: string;
  /** Where binary detection looked: the login shell's PATH, or the fallback dirs (see login-path.ts). */
  pathSource: 'login-shell' | 'fallback';
  groups: VerseAppGroup[];
}

/** POST /api/verse/apps/:id/toggle — `confirm: true` is required; anything else is a 400. */
export interface VerseAppToggleRequest {
  enabled: boolean;
  confirm: true;
}

/**
 * POST /api/verse/apps/:id/launch (C6 addition) — opens the agent in a
 * visible Terminal.app window at `root` (a chat folder or discovered
 * project). The command is resolved server-side from the catalog and the
 * installed binaries; `model` is an installed Ollama tag and implies Ollama.
 */
export interface VerseAppLaunchRequest {
  root: string;
  via?: VerseTerminalLaunchVia;
  model?: string;
}
export interface VerseAppLaunchResponse {
  ok: true;
  opened: 'terminal-app';
  /** The command as the operator would type it (bare argv[0]). */
  command: string[];
}

// ===========================================================================
// §9 Route families C0 mounts (verse-api.ts WORKBENCH mount table)
// ===========================================================================

/**
 * Every Track B / C route family, its owner, the module and export the specs
 * name, and the path prefixes it — and ONLY it — answers. The mount in
 * verse-api.ts routes by these prefixes (segment boundary: `/api/verse/git`
 * owns `/api/verse/git/status`, never `/api/verse/github`), so a module can
 * neither shadow another family nor a V1 route, and a family whose module has
 * not landed is a plain 404 that touches nothing else.
 *
 * `/api/verse/fleet/history` is A8's (Track A) and `/api/verse/fleet` is the
 * V2.2 control route: Track B's live fleet is `/api/verse/fleet/live` ONLY.
 */
export const WORKBENCH_ROUTE_FAMILIES = [
  {
    id: 'activity',
    owner: 'C1',
    module: 'src/core/verse/activity-api.ts',
    handler: 'handleActivityApi',
    prefixes: ['/api/verse/activity', '/api/verse/session-meta'],
  },
  {
    id: 'session-controls',
    owner: 'C3',
    module: 'src/core/verse/session-controls-api.ts',
    handler: 'handleSessionControlsApi',
    prefixes: ['/api/verse/session-controls', '/api/verse/attachments', '/api/verse/queue', '/api/verse/files'],
  },
  {
    id: 'terminal',
    owner: 'C4',
    module: 'src/core/verse/terminal-api.ts',
    handler: 'handleTerminalApi',
    prefixes: ['/api/verse/terminal'],
  },
  {
    id: 'preview',
    owner: 'C4',
    module: 'src/core/verse/preview-api.ts',
    handler: 'handlePreviewApi',
    prefixes: ['/api/verse/preview'],
  },
  { id: 'git', owner: 'C5', module: 'src/core/verse/git-api.ts', handler: 'handleGitApi', prefixes: ['/api/verse/git'] },
  { id: 'apps', owner: 'C6', module: 'src/core/verse/apps-api.ts', handler: 'handleAppsApi', prefixes: ['/api/verse/apps'] },
  {
    id: 'authority',
    owner: 'B-U1',
    module: 'src/core/verse/authority-api.ts',
    handler: 'handleAuthorityApi',
    prefixes: ['/api/verse/authority'],
  },
  {
    id: 'overnight',
    owner: 'B-U5',
    module: 'src/core/verse/overnight-api.ts',
    handler: 'handleOvernightApi',
    prefixes: ['/api/verse/overnight'],
  },
  {
    id: 'fleet-live',
    owner: 'B-U5',
    module: 'src/core/verse/fleet-live-api.ts',
    handler: 'handleFleetLiveApi',
    prefixes: ['/api/verse/fleet/live'],
  },
  {
    id: 'leader',
    owner: 'B-U8',
    module: 'src/core/verse/leader-api.ts',
    handler: 'handleLeaderApi',
    prefixes: ['/api/verse/leader'],
  },
  {
    id: 'learning',
    owner: 'B-U9',
    module: 'src/core/verse/learning-api.ts',
    handler: 'handleLearningApi',
    prefixes: ['/api/verse/learning'],
  },
] as const satisfies readonly {
  id: string;
  owner: string;
  module: string;
  handler: string;
  prefixes: readonly string[];
}[];

export type WorkbenchRouteFamily = (typeof WORKBENCH_ROUTE_FAMILIES)[number];
export type WorkbenchRouteFamilyId = WorkbenchRouteFamily['id'];

/** Exact path or path + '/…' — the only prefix rule the mount uses. */
export function routePrefixOwns(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The family that owns `path`, or null. Prefixes never overlap (tested), so at most one matches. */
export function workbenchFamilyFor(path: string): WorkbenchRouteFamily | null {
  for (const family of WORKBENCH_ROUTE_FAMILIES) {
    if (family.prefixes.some((prefix) => routePrefixOwns(prefix, path))) return family;
  }
  return null;
}
