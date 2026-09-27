/**
 * Suggested knowledge — the review queue (3.15).
 *
 * Retros suggest candidate notes; they land here as `pending` and do nothing
 * until Mason decides in Verse (Growth › Lessons):
 *
 *   approve          the note becomes injectable (inject.ts), as written
 *   approve + edit   Mason's text / scope replace the suggestion (`edited`)
 *   reject           kept (so the same suggestion is not re-queued), never used
 *
 * The same lesson suggested again (same normalized text + scope ⇒ same id)
 * bumps `seen` instead of queuing a duplicate; a rejected one stays rejected.
 *
 * AGENTS.md: an approved note with a repo can be proposed for that repo's
 * AGENTS.md. That files an ordinary fleet task (task-source enqueueTask,
 * requestedBy mason, deduped per note): the change arrives as a proposal and
 * passes every merge gate like any other. Nothing here writes a repo.
 */
import { getEntries } from '../../vision/playbook.js';
import { vetoLessons } from './inject.js';
import {
  cleanText,
  listRetros,
  noteIdFor,
  normalizeScope,
  readKnowledge,
  readKnowledgeHits,
  readSweepState,
  updateKnowledge,
} from './store.js';
import {
  KNOWLEDGE_INJECT_CAP_BYTES,
  KNOWLEDGE_NOTE_MAX_CHARS,
  RETRO_FAILURE_KINDS,
  type KnowledgeDecisionRequest,
  type KnowledgeNoteV1,
  type LessonsCauseRow,
  type LessonsStateV1,
  type RetroSource,
  type RetroSummary,
  type RetroV1,
} from './types.js';

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Queue a retro's candidates. Returns how many NEW pending notes were added. */
export async function enqueueCandidates(retro: RetroV1, nowIso: string): Promise<number> {
  if (retro.candidates.length === 0) return 0;
  return updateKnowledge((notes) => {
    let added = 0;
    const byId = new Map(notes.map((n) => [n.id, n]));
    for (const c of retro.candidates) {
      const text = cleanText(c.text, KNOWLEDGE_NOTE_MAX_CHARS);
      const scope = normalizeScope(c.scope);
      if (!text || !scope) continue;
      const id = noteIdFor(text, scope);
      const existing = byId.get(id);
      if (existing) {
        existing.seen += 1;
        continue;
      }
      const note: KnowledgeNoteV1 = {
        v: 1,
        id,
        text,
        scope,
        status: 'pending',
        retroId: retro.id,
        source: retro.source,
        createdAt: nowIso,
        decidedAt: null,
        edited: false,
        hits: 0,
        lastHitAt: null,
        seen: 1,
        agentsMdTaskId: null,
      };
      notes.push(note);
      byId.set(id, note);
      added += 1;
    }
    return { notes, result: added };
  });
}

export type KnowledgeDecisionResult =
  | { ok: true; note: KnowledgeNoteV1 }
  | { ok: false; status: 400 | 404 | 409; reason: string };

/** Approve (optionally edited) or reject one note. */
export async function decideKnowledge(req: KnowledgeDecisionRequest, nowIso: string): Promise<KnowledgeDecisionResult> {
  if (req.decision !== 'approve' && req.decision !== 'reject') return { ok: false, status: 400, reason: 'decision must be approve or reject.' };
  let text: string | null = null;
  if (req.text !== undefined) {
    text = cleanText(req.text, KNOWLEDGE_NOTE_MAX_CHARS);
    if (text.length < 8) return { ok: false, status: 400, reason: 'The note needs at least a short sentence.' };
  }
  const scope = req.scope === undefined ? null : normalizeScope(req.scope);
  if (req.scope !== undefined && scope === null) return { ok: false, status: 400, reason: 'scope must be {repo: owner/name | null, pathGlobs: string[], taskKinds: TaskKind[]}.' };
  if (req.decision === 'reject' && (text !== null || scope !== null)) return { ok: false, status: 400, reason: 'A rejection takes no text or scope.' };
  return updateKnowledge<KnowledgeDecisionResult>((notes) => {
    const note = notes.find((n) => n.id === req.id);
    if (!note) return { notes, result: { ok: false, status: 404, reason: 'No knowledge note with that id.' } };
    if (req.decision === 'reject') {
      note.status = 'rejected';
      note.decidedAt = nowIso;
      return { notes, result: { ok: true, note: { ...note } } };
    }
    const edited = (text !== null && text !== note.text) || (scope !== null && JSON.stringify(scope) !== JSON.stringify(note.scope));
    if (text !== null) note.text = text;
    if (scope !== null) note.scope = scope;
    note.edited = note.edited || edited;
    note.status = 'approved';
    note.decidedAt = nowIso;
    return { notes, result: { ok: true, note: { ...note } } };
  });
}

// ---------------------------------------------------------------------------
// AGENTS.md via a proposal (never a direct write)
// ---------------------------------------------------------------------------

export interface AgentsMdTaskInput {
  repo: string;
  source: 'manual';
  title: string;
  detail: string;
  difficulty: 'low';
  value: number;
  requestedBy: 'mason';
  dedupeKey: string;
}

export type AgentsMdEnqueue = (input: AgentsMdTaskInput) => Promise<{ ok: true; taskId: string } | { ok: false; reason: string }>;

/** The fleet task text for one note. Pure. */
export function agentsMdTask(note: KnowledgeNoteV1): AgentsMdTaskInput | null {
  if (!note.scope.repo) return null;
  const where = [note.scope.pathGlobs.length ? `paths ${note.scope.pathGlobs.join(', ')}` : null, note.scope.taskKinds.length ? `${note.scope.taskKinds.join('/')} tasks` : null]
    .filter(Boolean).join('; ');
  return {
    repo: note.scope.repo,
    source: 'manual',
    title: 'Add an approved lesson to AGENTS.md',
    detail: [
      'Add this lesson to the repository’s AGENTS.md (create the file at the repo root if it does not exist).',
      'Put it under a "Lessons" heading, as one bullet, in plain words; do not change anything else.',
      where ? `It applies to ${where}.` : 'It applies to the whole repository.',
      '',
      `Lesson: ${note.text}`,
    ].join('\n'),
    difficulty: 'low',
    value: 2,
    requestedBy: 'mason',
    dedupeKey: `knowledge-agents-md:${note.id}`,
  };
}

export async function proposeAgentsMd(id: string, enqueue: AgentsMdEnqueue): Promise<KnowledgeDecisionResult & { taskId?: string }> {
  const note = (await readKnowledge()).find((n) => n.id === id);
  if (!note) return { ok: false, status: 404, reason: 'No knowledge note with that id.' };
  if (note.status !== 'approved') return { ok: false, status: 409, reason: 'Approve the note before proposing it for AGENTS.md.' };
  const task = agentsMdTask(note);
  if (!task) return { ok: false, status: 409, reason: 'The note is not scoped to one repo, so there is no AGENTS.md to propose it to. Edit its scope first.' };
  const queued = await enqueue(task);
  if (!queued.ok) return { ok: false, status: 409, reason: queued.reason };
  return updateKnowledge((notes) => {
    const n = notes.find((x) => x.id === id);
    if (n) n.agentsMdTaskId = queued.taskId;
    return { notes, result: { ok: true as const, note: { ...(n ?? note), agentsMdTaskId: queued.taskId }, taskId: queued.taskId } };
  });
}

// ---------------------------------------------------------------------------
// Lessons view state
// ---------------------------------------------------------------------------

function summarize(r: RetroV1): RetroSummary {
  return {
    id: r.id,
    source: r.source,
    taskId: r.taskId,
    repo: r.repo,
    endKind: r.endKind,
    endedAt: r.endedAt,
    taskKind: r.taskKind,
    asked: r.asked,
    happened: r.happened,
    rootCause: r.rootCause,
    doDifferently: r.doDifferently,
    betterPrompt: r.betterPrompt,
    candidates: r.candidates.length,
    modelAssisted: r.model !== null,
  };
}

/** Group failure retros by root-cause code. Pure. */
export function recurringCauses(retros: readonly RetroV1[]): LessonsCauseRow[] {
  const rows = new Map<string, LessonsCauseRow>();
  for (const r of retros) {
    if (!r.rootCause || !RETRO_FAILURE_KINDS.has(r.endKind)) continue;
    // Leader codes carry the action kind; the chart groups on the status.
    const code = r.rootCause.code.startsWith('leader:') ? r.rootCause.code.split(':').slice(0, 2).join(':') : r.rootCause.code;
    const row = rows.get(code) ?? { code, label: r.rootCause.label, count: 0, bySource: { fleet: 0, cloud: 0, leader: 0 } as Record<RetroSource, number> };
    row.count += 1;
    row.bySource[r.source] += 1;
    rows.set(code, row);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export async function buildLessonsState(nowMs: number, windowDays = 30): Promise<LessonsStateV1> {
  const since = new Date(nowMs - windowDays * 86_400_000).toISOString();
  const [all, notes, hits, sweep] = await Promise.all([listRetros(), readKnowledge(), readKnowledgeHits(), readSweepState()]);
  const inWindow = all.filter((r) => r.endedAt >= since);
  const endKinds: LessonsStateV1['endKinds'] = {};
  for (const r of inWindow) endKinds[r.endKind] = (endKinds[r.endKind] ?? 0) + 1;
  const withHits = notes.map((n) => {
    const h = hits.get(n.id);
    return h ? { ...n, hits: n.hits + h.hits, lastHitAt: h.lastHitAt ?? n.lastHitAt } : n;
  });
  const approved = withHits.filter((n) => n.status === 'approved')
    .sort((a, b) => b.hits - a.hits || (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
  const pending = withHits.filter((n) => n.status === 'pending')
    .sort((a, b) => b.seen - a.seen || b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100);
  let playbook: LessonsStateV1['playbook'] = [];
  try {
    playbook = vetoLessons(getEntries(), 20).map((e) => ({ text: e.text, hits: e.hits, addedAt: e.addedAt }));
  } catch {
    playbook = [];
  }
  return {
    v: 1,
    retros: all.slice(0, 50).map(summarize),
    endKinds,
    causes: recurringCauses(inWindow).slice(0, 12),
    windowDays,
    knowledge: {
      pending,
      approved,
      rejected: withHits.filter((n) => n.status === 'rejected').length,
      approvedBytes: approved.reduce((s, n) => s + Buffer.byteLength(n.text, 'utf8'), 0),
      capBytes: KNOWLEDGE_INJECT_CAP_BYTES,
    },
    playbook,
    sweptAt: sweep.sweptAt,
  };
}
