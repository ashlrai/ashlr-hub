/**
 * What Mason means (3.15) — intent routing for the Leader line.
 *
 * Every text Mason sends the Leader is classified into ONE intent, and the
 * line acts on it:
 *
 *   status     "status" / "update" / "what's up"  → an instant brief
 *   detail     "more" / "details"                 → the rest of the last reply
 *   approve    "approve" (+ action ids, or as a reply to an action/memo message)
 *   veto       "veto" / "undo" (same)
 *   answer     a reply to one of the Leader's questions
 *   directive  standing guidance ("focus: …", "from now on …")
 *   task       "go build X" → real work at once (a launch / task / backlog item)
 *   chat       everything else → the Leader's reply
 *
 * JEV FIRST, RULES ALWAYS. When the decision engine (src/core/decide, "Jev
 * decides" — landing concurrently) is present, its `classifyOperatorIntent`
 * answer is used whenever it came from Jev itself (path 'jev': Jev gates its
 * own confidence). Otherwise — no module, a timeout, an error, Jev's own
 * fallback, or a label outside this vocabulary — the deterministic rules
 * below decide. Approve and veto change what autonomy does, so they are
 * NEVER taken from a model's guess alone: they need an explicit action id or
 * a reply to a message that carries actions (the rules check that, whatever
 * Jev said).
 *
 * The adapter also exposes Jev's `worthInterrupting` (should this event ping
 * Mason now?) and `chooseLane` (which lane runs this task?), each with the
 * caller's deterministic fallback.
 *
 * NODE-ONLY but cheap: no model plumbing is imported here.
 */

export type OperatorIntentKind = 'status' | 'detail' | 'approve' | 'veto' | 'answer' | 'directive' | 'task' | 'chat';

export const OPERATOR_INTENT_KINDS: readonly OperatorIntentKind[] = ['status', 'detail', 'approve', 'veto', 'answer', 'directive', 'task', 'chat'];

export type TaskLane = 'fleet' | 'cloud' | 'devin' | 'backlog';

export interface TaskRequest {
  /** The work, in Mason's words (the command verb kept). */
  text: string;
  /** owner/name when Mason named one; null = the line's default repo. */
  repo: string | null;
  size: 'small' | 'pr';
  /** A lane Mason asked for by name ("with devin", "on cloud", "locally"); null = cheapest capable. */
  lane: TaskLane | null;
}

export interface OperatorIntent {
  kind: OperatorIntentKind;
  source: 'jev' | 'rules';
  /** Jev's confidence when it decided; null for rules. */
  confidence: number | null;
  /** approve / veto: the Leader actions named (explicitly or by the replied-to message). */
  actionIds?: string[];
  task?: TaskRequest;
}

export interface IntentContext {
  /** What the message replies to (telegram thread map kind), if anything. */
  replyToKind?: string | null;
  /** Actions carried by the replied-to message. */
  replyActionIds?: readonly string[];
}

const ACTION_ID_RE = /\bla-\d{14}-[a-f0-9]{6}-\d{1,3}\b/g;
const REPO_RE = /\b(?:in|on|for|to|at)\s+(?:repo\s+)?([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\b/i;

const STATUS_RE = /^\s*\/?(?:status|update|updates|brief|briefing|report|sitrep|progress|what'?s\s+up|whats\s+up|wassup|sup|what'?s\s+new|where\s+are\s+we|how'?s\s+it\s+going|how\s+are\s+we\s+doing|what'?s\s+happening|anything\s+new)\s*(?:\?|!|\.)*\s*$/i;
const DETAIL_RE = /^\s*(?:more|details?|the\s+rest|go\s+on|full\s+version|expand|continue)\s*(?:\?|!|\.)*\s*$/i;
/** Unambiguous approvals; the short words ("yes", "ok") count only as the whole message (≤ 3 words). */
const APPROVE_RE = /^\s*(?:approve[ds]?|go\s+ahead|do\s+it|ship\s+it|lgtm|green\s*light|send\s+it)\b/i;
const APPROVE_SHORT_RE = /^\s*(?:yes|yep|yeah|y|ok|okay|go|sure)\b/i;
/** Unambiguous vetoes; "no" / "stop" count only as the whole message (≤ 3 words). */
const VETO_RE = /^\s*(?:veto(?:ed)?|undo|cancel|abort|kill\s+(?:it|that)|stop\s+(?:that|it)|revert\s+that)\b/i;
const VETO_SHORT_RE = /^\s*(?:no|nope|n|don'?t|stop)\b/i;
const DIRECTIVE_PREFIX_RE = /^\s*(?:directive|focus|stop|priority)\s*:/i;
const STANDING_RE = /\b(from now on|going forward|always|never|priorit\w*|deprioriti\w*|double down|no more|only work|focus on)\b/i;
const TASK_RE = /^\s*(?:(?:please|pls|hey|ok|okay|leader)[,\s]+)*(?:(?:can|could|would)\s+you\s+|go\s+(?:and\s+)?|let'?s\s+|i\s+(?:want|need)\s+(?:you\s+to\s+)?|i'?d\s+like\s+(?:you\s+to\s+)?)?(build|ship|fix|add|make|implement|create|write|launch|refactor|investigate|spin\s+up|kick\s+off|wire(?:\s+up)?|port|upgrade|migrate|remove|delete|clean\s+up|improve|speed\s+up|optimi[sz]e|harden|document|research|prototype|design|redo|rewrite)\b/i;
const SMALL_RE = /\b(typo|rename|bump|tweak|small|quick|minor|one[- ]?liner|copy|wording|lint|label|comment|readme)\b/i;

function lanePreference(text: string): TaskLane | null {
  if (/\b(?:with|via|using|on|use)\s+devin\b/i.test(text)) return 'devin';
  if (/\b(?:with|via|using|on|in|use)\s+(?:the\s+)?cloud\b/i.test(text) || /\bclaude\s+cloud\b/i.test(text)) return 'cloud';
  if (/\b(?:locally|local\s+models?|the\s+fleet|with\s+grok|on\s+grok)\b/i.test(text)) return 'fleet';
  if (/\b(?:backlog|later|someday|when\s+there'?s\s+budget)\b/i.test(text)) return 'backlog';
  return null;
}

/** The work Mason asked for, or null when the text is not a task request. */
export function parseTaskRequest(text: string): TaskRequest | null {
  const trimmed = text.trim();
  if (trimmed.length < 8) return null;
  const m = TASK_RE.exec(trimmed);
  if (!m) return null;
  // "can you fix X?" is a request; "why did you fix X?" is not (it would not match TASK_RE's start).
  const repo = REPO_RE.exec(trimmed)?.[1] ?? null;
  const words = trimmed.split(/\s+/).length;
  const size: TaskRequest['size'] = SMALL_RE.test(trimmed) || words <= 6 ? 'small' : 'pr';
  // Keep the command from the verb on ("build a /brief command"), without the politeness prefix.
  const fromVerb = trimmed.slice(m.index + m[0].length - m[1]!.length).trim();
  return { text: fromVerb.replace(/[?!.]+$/, '').trim() || trimmed, repo, size, lane: lanePreference(trimmed) };
}

function actionIdsIn(text: string): string[] {
  return [...new Set(text.match(ACTION_ID_RE) ?? [])];
}

/**
 * The deterministic rules. Total and pure — the fallback whenever Jev is
 * absent, slow, wrong-shaped or unsure, and the authority check for
 * approve / veto whatever Jev said.
 */
export function classifyIntentByRules(text: string, ctx: IntentContext = {}): OperatorIntent {
  const rules = (kind: OperatorIntentKind, extra: Partial<OperatorIntent> = {}): OperatorIntent => ({ kind, source: 'rules', confidence: null, ...extra });
  const trimmed = text.trim();
  if (ctx.replyToKind === 'question') return rules('answer');
  if (DETAIL_RE.test(trimmed)) return rules('detail');
  if (STATUS_RE.test(trimmed)) return rules('status');

  const named = actionIdsIn(trimmed);
  const replied = [...(ctx.replyActionIds ?? [])];
  const targets = named.length > 0 ? named : replied;
  // Approve / veto need a target: an id in the text, or a reply to a message carrying actions.
  const words = trimmed.split(/\s+/).length;
  if (targets.length > 0 && words <= 12) {
    if (APPROVE_RE.test(trimmed) || (words <= 3 && APPROVE_SHORT_RE.test(trimmed))) return rules('approve', { actionIds: targets });
    if (VETO_RE.test(trimmed) || (words <= 3 && VETO_SHORT_RE.test(trimmed))) return rules('veto', { actionIds: targets });
  }
  if (named.length > 0 && /\bapprove\b/i.test(trimmed)) return rules('approve', { actionIds: named });
  if (named.length > 0 && /\bveto\b/i.test(trimmed)) return rules('veto', { actionIds: named });

  if (DIRECTIVE_PREFIX_RE.test(trimmed)) return rules('directive');
  const task = parseTaskRequest(trimmed);
  // "From now on, always fix X first" is guidance, not a one-off job.
  if (task && !STANDING_RE.test(trimmed)) return rules('task', { task });
  if (STANDING_RE.test(trimmed) && !/\?\s*$/.test(trimmed)) return rules('directive');
  return rules('chat');
}

// ---------------------------------------------------------------------------
// Jev adapter (src/core/decide — "Jev decides")
// ---------------------------------------------------------------------------

/**
 * Structural copies of the slice of Jev's STABLE PUBLIC API the Leader line
 * calls (src/core/decide/index.ts: classifyOperatorIntent, worthInterrupting,
 * chooseLane). Jev lands concurrently; until it does these types are what we
 * code against, and its module is feature-detected at runtime.
 */
export interface JevDecision<T> {
  readonly value: T;
  /** 'fallback' = Jev's own deterministic reading (unkeyed, off, slow, unsure). */
  readonly path: 'jev' | 'fallback';
  readonly confidence: number;
}

export type JevOperatorIntent = 'status-request' | 'directive' | 'answer' | 'approval' | 'veto' | 'task-request' | 'chit-chat';

export interface JevOperatorIntentContext {
  readonly pendingQuestion?: string | null;
  readonly pendingApproval?: boolean;
  readonly lastBotMessage?: string | null;
  readonly isReply?: boolean;
  readonly channel?: 'telegram' | 'verse' | 'cli';
}

export interface JevAttentionItem {
  readonly id: string;
  readonly title: string;
  readonly detail?: string | null;
  readonly kind?: string;
  readonly source?: string;
  readonly severity?: 'info' | 'warn' | 'high';
  readonly since?: string | null;
  readonly expiresAt?: string | null;
  readonly blocking?: boolean;
}

export interface JevInterruptContext {
  readonly quietHours?: boolean;
  readonly minutesSinceLastPush?: number | null;
  readonly operatorActive?: boolean;
  readonly pushesToday?: number;
}

export type JevWorkLane = 'fleet' | 'cloud' | 'devin' | 'interactive';

export interface JevLaneTask {
  readonly title: string;
  readonly body?: string | null;
  readonly repo?: string | null;
  readonly githubRepo?: boolean;
  readonly estimatedFiles?: number | null;
  readonly labels?: readonly string[];
  readonly protectedPaths?: boolean;
}

export interface JevLaneContext {
  readonly available?: Partial<Record<JevWorkLane, boolean>>;
  readonly preferred?: JevWorkLane;
  readonly operatorPresent?: boolean;
}

export interface JevPort {
  classifyOperatorIntent?(text: string, context?: JevOperatorIntentContext): Promise<JevDecision<string>>;
  worthInterrupting?(item: JevAttentionItem, context?: JevInterruptContext): Promise<JevDecision<boolean>>;
  chooseLane?(task: JevLaneTask, context?: JevLaneContext): Promise<JevDecision<string>>;
}

let jevOverride: JevPort | null | undefined;
let jevCache: Promise<JevPort | null> | null = null;

/** Test hook: a fake Jev (null = none; undefined = production detection). */
export function setJevForTest(port: JevPort | null | undefined): void {
  jevOverride = port;
  jevCache = null;
}

/**
 * TODO(3.15): switch to a literal `import('../decide/index.js')` once the Jev
 * branch (src/core/decide) is merged. The specifier is a variable only so
 * this compiles before that module exists.
 */
const JEV_ENTRY = '../decide/index.js';

export async function loadJev(): Promise<JevPort | null> {
  if (jevOverride !== undefined) return jevOverride;
  if (!jevCache) {
    jevCache = (async () => {
      try {
        const mod = (await import(JEV_ENTRY)) as Record<string, unknown>;
        const port: JevPort = {};
        if (typeof mod['classifyOperatorIntent'] === 'function') port.classifyOperatorIntent = mod['classifyOperatorIntent'] as JevPort['classifyOperatorIntent'];
        if (typeof mod['worthInterrupting'] === 'function') port.worthInterrupting = mod['worthInterrupting'] as JevPort['worthInterrupting'];
        if (typeof mod['chooseLane'] === 'function') port.chooseLane = mod['chooseLane'] as JevPort['chooseLane'];
        return Object.keys(port).length > 0 ? port : null;
      } catch {
        return null; // not in this build
      }
    })();
  }
  return jevCache;
}

const JEV_INTENT_MAP: Readonly<Record<JevOperatorIntent, OperatorIntentKind>> = {
  'status-request': 'status',
  directive: 'directive',
  answer: 'answer',
  approval: 'approve',
  veto: 'veto',
  'task-request': 'task',
  'chit-chat': 'chat',
};

/** Jev must answer within this; the rules answer otherwise (a phone chat cannot wait). */
export const JEV_TIMEOUT_MS = 4_000;

async function withTimeout<T>(p: Promise<T> | T, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Only a real Jev answer counts; its own fallback path defers to OUR rules (tuned to this line). */
function jevValue<T>(decision: unknown): { value: T; confidence: number } | null {
  if (!decision || typeof decision !== 'object') return null;
  const d = decision as Partial<JevDecision<T>>;
  if (d.path !== 'jev' || d.value === undefined) return null;
  return { value: d.value as T, confidence: typeof d.confidence === 'number' ? d.confidence : 0 };
}

/**
 * Classify one message: Jev when it answers (path 'jev' — it gates its own
 * confidence), the rules otherwise. Never throws.
 */
export async function classifyOperatorText(text: string, ctx: IntentContext & { pendingQuestion?: string | null; lastBotMessage?: string | null } = {}, opts: { timeoutMs?: number } = {}): Promise<OperatorIntent> {
  const rules = classifyIntentByRules(text, ctx);
  // A reply to a question is an answer, full stop; status / detail are cheap, exact matches.
  if (rules.kind === 'answer' || rules.kind === 'status' || rules.kind === 'detail') return rules;
  let jev: JevPort | null = null;
  try {
    jev = await loadJev();
  } catch {
    jev = null;
  }
  if (!jev?.classifyOperatorIntent) return rules;
  let decided: { value: string; confidence: number } | null = null;
  try {
    decided = jevValue<string>(await withTimeout(jev.classifyOperatorIntent(text, {
      channel: 'telegram',
      isReply: Boolean(ctx.replyToKind),
      pendingApproval: (ctx.replyActionIds?.length ?? 0) > 0,
      pendingQuestion: ctx.pendingQuestion ?? null,
      lastBotMessage: ctx.lastBotMessage ?? null,
    }), opts.timeoutMs ?? JEV_TIMEOUT_MS));
  } catch {
    decided = null;
  }
  const kind = decided ? JEV_INTENT_MAP[decided.value as JevOperatorIntent] : undefined;
  if (!decided || !kind) return rules;
  // Authority-affecting intents stay with the rules: Jev may not invent an approval or a veto target.
  if (kind === 'approve' || kind === 'veto') {
    return rules.kind === kind ? { ...rules, source: 'jev', confidence: decided.confidence } : rules;
  }
  if (kind === 'task') {
    const task = rules.task ?? parseTaskRequest(text) ?? { text: text.trim(), repo: REPO_RE.exec(text)?.[1] ?? null, size: 'pr' as const, lane: lanePreference(text) };
    return { kind: 'task', source: 'jev', confidence: decided.confidence, task };
  }
  // A "status" guess on a real question would answer it with a brief; only the rules' exact phrases get the fast path.
  if (kind === 'answer' || kind === 'detail' || kind === 'status') return rules;
  return { kind, source: 'jev', confidence: decided.confidence };
}

/**
 * Jev's worthInterrupting for a proactive ping, with the caller's
 * deterministic answer as the fallback. Jev never suppresses a `high` item.
 */
export async function jevWorthInterrupting(item: JevAttentionItem, context: JevInterruptContext, fallback: boolean, opts: { timeoutMs?: number } = {}): Promise<{ interrupt: boolean; source: 'jev' | 'rules' }> {
  if (item.severity === 'high' || item.blocking === true) return { interrupt: true, source: 'rules' };
  try {
    const jev = await loadJev();
    if (jev?.worthInterrupting) {
      const got = jevValue<boolean>(await withTimeout(jev.worthInterrupting(item, context), opts.timeoutMs ?? JEV_TIMEOUT_MS));
      if (got && typeof got.value === 'boolean') return { interrupt: got.value, source: 'jev' };
    }
  } catch { /* fall back */ }
  return { interrupt: fallback, source: 'rules' };
}

/**
 * Jev's chooseLane among the lanes open right now (never `interactive` — the
 * line is for work that runs without Mason), with the caller's fallback.
 */
export async function jevChooseLane(task: JevLaneTask, open: readonly TaskLane[], fallback: TaskLane, opts: { timeoutMs?: number } = {}): Promise<{ lane: TaskLane; source: 'jev' | 'rules' }> {
  try {
    const jev = await loadJev();
    if (jev?.chooseLane && open.length > 1) {
      const available: Partial<Record<JevWorkLane, boolean>> = {
        fleet: open.includes('fleet'), cloud: open.includes('cloud'), devin: open.includes('devin'), interactive: false,
      };
      const got = jevValue<string>(await withTimeout(jev.chooseLane(task, { available, preferred: fallback === 'backlog' ? 'fleet' : fallback }), opts.timeoutMs ?? JEV_TIMEOUT_MS));
      if (got && (open as readonly string[]).includes(got.value)) return { lane: got.value as TaskLane, source: 'jev' };
    }
  } catch { /* fall back */ }
  return { lane: fallback, source: 'rules' };
}
