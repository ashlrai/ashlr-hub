/**
 * Knowledge injection (3.15) — trigger matching, the 16 KiB cap, and the
 * read-back of the Leader's veto playbook deltas.
 *
 * Only APPROVED notes are ever injected (a pending candidate is invisible
 * here). Each note carries a trigger scope — repo, path globs, task kinds —
 * and reaches a prompt only when the task matches all three:
 *
 *   repo       null matches any; otherwise `owner/name` case-insensitively,
 *              also against a daemon work item's checkout path (the fleet's
 *              mirrors are named `owner__name`; a plain clone by its name).
 *   pathGlobs  [] matches any; with the task's paths known, any path under
 *              any glob; with no paths yet (a brief is written before the
 *              work), the glob's literal prefix must appear in the task text.
 *   taskKinds  [] matches any; otherwise the task's kind (given, or inferred
 *              from its text) must be listed.
 *
 * Most specific notes first (repo + path + kind), then most used, then
 * newest; the rendered block never exceeds KNOWLEDGE_INJECT_CAP_BYTES of
 * UTF-8, and a note that does not fit whole is left out, never cut.
 *
 * Veto deltas (vision/playbook.ts, section `strategy`, written by the
 * Leader's veto path) were stored and never read. They are read back here:
 * into the Leader's evidence always, and into a task prompt only when the
 * task came from the Leader — a coding engine fixing a test gains nothing
 * from "Mason vetoed pausing goal X".
 *
 * SYNCHRONOUS on purpose: fleet goal assembly is synchronous. It reads two
 * small private files under ~/.ashlr and never an operator folder. Hits are
 * recorded fire-and-forget; a lost hit is a lost counter, never a lost note.
 */
import { globMatches } from '../../authority/protected-paths.js';
import { getEntries, type PlaybookEntry } from '../../vision/playbook.js';
import { readApprovedKnowledgeSync, recordKnowledgeHits } from './store.js';
import {
  KNOWLEDGE_INJECT_CAP_BYTES,
  type KnowledgeNoteV1,
  type KnowledgeScope,
  type KnowledgeTarget,
  type TaskKind,
} from './types.js';

// ---------------------------------------------------------------------------
// Task kind
// ---------------------------------------------------------------------------

/** Coarse task kind from free text. Pure; order matters (revert beats fix beats tests…). */
export function classifyTaskKind(text: string | null | undefined): TaskKind {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return 'other';
  if (/\brevert(s|ed|ing)?\b/.test(t)) return 'revert';
  if (/\b(bump|deps|dependency|dependencies|upgrade|renovate|dependabot|lockfile)\b/.test(t)) return 'deps';
  if (/\b(ci|workflow|workflows|github actions|pipeline)\b/.test(t)) return 'ci';
  if (/\b(fix|fixes|fixed|bug|bugs|crash|regression|hotfix|broken|repair)\b/.test(t)) return 'fix';
  if (/\b(test|tests|testing|coverage|vitest|jest|spec)\b/.test(t)) return 'tests';
  if (/\b(doc|docs|documentation|readme|changelog|agents\.md)\b/.test(t)) return 'docs';
  if (/\b(refactor|cleanup|clean-up|rename|restructure|simplify|dedupe|tidy)\b/.test(t)) return 'refactor';
  if (/\b(add|adds|implement|implements|build|create|support|introduce|feature|new)\b/.test(t)) return 'feature';
  return 'other';
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Does `target` (an `owner/name`, or an absolute checkout path) name the
 * scope's repo? A checkout path is matched by its last segment: a fleet
 * mirror `…/mirrors/owner__name`, or a plain clone `…/name`.
 */
export function repoMatches(scopeRepo: string | null, target: string | null): boolean {
  if (scopeRepo === null) return true;
  if (!target) return false;
  const want = scopeRepo.toLowerCase();
  const t = target.toLowerCase().replace(/\/+$/, '');
  if (t === want) return true;
  if (!t.startsWith('/') && !/^[a-z]:[\\/]/.test(t)) return false;
  const base = t.split(/[\\/]/).pop() ?? '';
  const [owner, name] = want.split('/');
  return base === `${owner}__${name}` || base === name;
}

/** The literal part of a glob before its first wildcard, e.g. `src/core/**` → `src/core/`. */
function globPrefix(glob: string): string {
  const i = glob.search(/[*?{]/);
  return (i === -1 ? glob : glob.slice(0, i)).toLowerCase();
}

export function scopeMatches(scope: KnowledgeScope, target: KnowledgeTarget): boolean {
  if (!repoMatches(scope.repo, target.repo)) return false;
  if (scope.taskKinds.length > 0) {
    const kind = target.kind ?? classifyTaskKind(target.text);
    if (!scope.taskKinds.includes(kind)) return false;
  }
  if (scope.pathGlobs.length > 0) {
    if (target.paths.length > 0) {
      if (!target.paths.some((p) => scope.pathGlobs.some((g) => globMatches(g, p.replace(/^\.?\//, ''))))) return false;
    } else {
      const text = (target.text ?? '').toLowerCase();
      const prefixes = scope.pathGlobs.map(globPrefix).filter((p) => p.length >= 3);
      if (prefixes.length === 0 || !prefixes.some((p) => text.includes(p.replace(/\/$/, '')))) return false;
    }
  }
  return true;
}

function specificity(scope: KnowledgeScope): number {
  return (scope.repo ? 4 : 0) + (scope.pathGlobs.length > 0 ? 2 : 0) + (scope.taskKinds.length > 0 ? 1 : 0);
}

/** Approved notes that match, most specific / most used / newest first. Pure. */
export function selectKnowledge(notes: readonly KnowledgeNoteV1[], target: KnowledgeTarget): KnowledgeNoteV1[] {
  return notes
    .filter((n) => n.status === 'approved' && scopeMatches(n.scope, target))
    .sort((a, b) => specificity(b.scope) - specificity(a.scope)
      || b.hits - a.hits
      || (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)
      || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Veto playbook read-back
// ---------------------------------------------------------------------------

/** The Leader's veto path writes exactly this prefix (leader-apply.ts vetoPlaybook). */
const VETO_PREFIX = 'Mason vetoed the Leader';

/** Active veto deltas, most repeated then newest first. Pure over the entries. */
export function vetoLessons(entries: readonly PlaybookEntry[], limit = 12): PlaybookEntry[] {
  return entries
    .filter((e) => !e.retired && e.section === 'strategy' && e.text.startsWith(VETO_PREFIX))
    .sort((a, b) => b.hits - a.hits || b.lastUsedAt.localeCompare(a.lastUsedAt) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function readVetoLessonsSync(limit?: number): PlaybookEntry[] {
  try {
    return vetoLessons(getEntries(), limit);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rendering (the cap)
// ---------------------------------------------------------------------------

const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

function scopeTag(scope: KnowledgeScope): string {
  const parts = [scope.repo ?? 'any repo'];
  if (scope.pathGlobs.length) parts.push(scope.pathGlobs.join(', '));
  if (scope.taskKinds.length) parts.push(scope.taskKinds.join('/'));
  return parts.join(' · ');
}

export interface RenderedKnowledge {
  /** '' when nothing matched. */
  text: string;
  /** Note ids that made it into `text`. */
  noteIds: string[];
  vetoes: number;
  bytes: number;
}

export const KNOWLEDGE_HEADING = '## Lessons from earlier tasks (approved by Mason)';
const KNOWLEDGE_PREAMBLE = 'These come from how similar tasks ended before. Treat them as guidance; the task above still decides what to change.';
const VETO_HEADING = '### Leader vetoes to respect';

/**
 * Render notes (then veto lessons) under one heading, whole lines only,
 * never past `capBytes` of UTF-8. Pure.
 */
export function renderKnowledgeBlock(
  notes: readonly KnowledgeNoteV1[],
  vetoes: readonly Pick<PlaybookEntry, 'text'>[],
  capBytes: number = KNOWLEDGE_INJECT_CAP_BYTES,
): RenderedKnowledge {
  if (notes.length === 0 && vetoes.length === 0) return { text: '', noteIds: [], vetoes: 0, bytes: 0 };
  const lines: string[] = [KNOWLEDGE_HEADING, KNOWLEDGE_PREAMBLE];
  let used = utf8(lines.join('\n'));
  if (used > capBytes) return { text: '', noteIds: [], vetoes: 0, bytes: 0 };
  const noteIds: string[] = [];
  for (const note of notes) {
    const line = `- [${scopeTag(note.scope)}] ${note.text.replace(/\s+/g, ' ').trim()}`;
    const cost = utf8(line) + 1;
    if (used + cost > capBytes) continue; // a shorter note further down may still fit
    lines.push(line);
    used += cost;
    noteIds.push(note.id);
  }
  let vetoCount = 0;
  if (vetoes.length > 0 && used + utf8(VETO_HEADING) + 1 <= capBytes) {
    const vetoLines: string[] = [];
    let vetoUsed = utf8(VETO_HEADING) + 1;
    for (const v of vetoes) {
      const line = `- ${v.text.replace(/\s+/g, ' ').trim()}`;
      const cost = utf8(line) + 1;
      if (used + vetoUsed + cost > capBytes) continue;
      vetoLines.push(line);
      vetoUsed += cost;
    }
    if (vetoLines.length > 0) {
      lines.push(VETO_HEADING, ...vetoLines);
      used += vetoUsed;
      vetoCount = vetoLines.length;
    }
  }
  if (noteIds.length === 0 && vetoCount === 0) return { text: '', noteIds: [], vetoes: 0, bytes: 0 };
  const text = lines.join('\n');
  return { text, noteIds, vetoes: vetoCount, bytes: utf8(text) };
}

// ---------------------------------------------------------------------------
// Prompt entry points
// ---------------------------------------------------------------------------

export interface KnowledgeBlockOptions {
  /** The task came from the Leader: its veto lessons apply. */
  fromLeader?: boolean;
  capBytes?: number;
  /** Record hits (default true). Tests and previews pass false. */
  recordHits?: boolean;
  /** Injected for tests. */
  notes?: readonly KnowledgeNoteV1[];
  vetoes?: readonly Pick<PlaybookEntry, 'text'>[];
}

/** The knowledge block for one task ('' when nothing applies). Never throws. */
export function knowledgeBlockFor(target: KnowledgeTarget, opts: KnowledgeBlockOptions = {}): RenderedKnowledge {
  try {
    const notes = selectKnowledge(opts.notes ?? readApprovedKnowledgeSync(), target);
    const vetoes = opts.fromLeader ? (opts.vetoes ?? readVetoLessonsSync()) : [];
    const rendered = renderKnowledgeBlock(notes, vetoes, opts.capBytes ?? KNOWLEDGE_INJECT_CAP_BYTES);
    if (rendered.noteIds.length > 0 && opts.recordHits !== false) void recordKnowledgeHits(rendered.noteIds);
    return rendered;
  } catch {
    return { text: '', noteIds: [], vetoes: 0, bytes: 0 };
  }
}

/**
 * Append the matching knowledge to a prompt. No match ⇒ the prompt is
 * returned byte-identical (so a machine with no approved notes behaves
 * exactly as before this feature).
 */
export function withApprovedKnowledge(prompt: string, target: KnowledgeTarget, opts: KnowledgeBlockOptions = {}): string {
  const block = knowledgeBlockFor({ ...target, text: target.text ?? prompt }, opts);
  return block.text ? `${prompt}\n\n${block.text}` : prompt;
}

/** What the Leader's evidence carries: every approved note (portfolio-wide) and the veto lessons. */
export interface LeaderLessonsEvidence {
  vetoes: { text: string; repeats: number }[];
  knowledge: { text: string; scope: string }[];
}

/**
 * The Leader reads ALL approved notes (it steers the whole portfolio) and the
 * veto deltas, within the same cap. null when there is nothing, so a Leader
 * with no lessons keeps an unchanged evidence digest.
 */
export function leaderLessons(opts: { notes?: readonly KnowledgeNoteV1[]; vetoes?: readonly PlaybookEntry[]; capBytes?: number } = {}): LeaderLessonsEvidence | null {
  try {
    const cap = opts.capBytes ?? KNOWLEDGE_INJECT_CAP_BYTES;
    const notes = [...(opts.notes ?? readApprovedKnowledgeSync())]
      .filter((n) => n.status === 'approved')
      .sort((a, b) => b.hits - a.hits || (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt) || a.id.localeCompare(b.id));
    const vetoes = opts.vetoes ? vetoLessons(opts.vetoes) : readVetoLessonsSync();
    const out: LeaderLessonsEvidence = { vetoes: [], knowledge: [] };
    let used = 0;
    for (const v of vetoes) {
      const cost = utf8(v.text) + 16;
      if (used + cost > cap) continue;
      out.vetoes.push({ text: v.text, repeats: v.hits + 1 });
      used += cost;
    }
    for (const n of notes) {
      const tag = scopeTag(n.scope);
      const cost = utf8(n.text) + utf8(tag) + 16;
      if (used + cost > cap) continue;
      out.knowledge.push({ text: n.text, scope: tag });
      used += cost;
    }
    return out.vetoes.length === 0 && out.knowledge.length === 0 ? null : out;
  } catch {
    return null;
  }
}
