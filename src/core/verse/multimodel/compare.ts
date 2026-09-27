/**
 * Compare and cross-family review — the same prompt to 2–3 seats at once, and
 * "ask another model to review this" in one click.
 *
 * FAN-OUT GOES THROUGH THE FRONT DOOR. `fanOut` takes its two effects as
 * injected functions, and the app passes the SAME `createVerseSession` /
 * `sendVerseTurn` a hand-typed chat uses — so every answer passes the spend
 * chokepoint, the readiness gate, the local-only gate and the mutation token.
 * One seat failing (not ready, signed out, refused) never sinks the others:
 * each target settles on its own and reports why.
 *
 * Every Compare answer is a real chat, linked to its thread
 * (`relation: 'compare'`), so "pick one to continue" is simply opening that
 * chat — its context is already there — and the per-chat meter counts all of
 * them.
 *
 * BROWSER-SAFE and deterministic (the effects are injected).
 */
import type { SeatAdviceOption } from './types.js';

/** Most seats one Compare may fan out to. */
export const COMPARE_MAX_SEATS = 3;

export interface CompareTarget {
  seatId: string;
  model: string | null;
  label: string;
  engine: string;
}

export interface FanOutDeps {
  /** Create a chat on `target` (POST /api/verse/sessions); resolves to its id. */
  createSession(target: CompareTarget): Promise<{ id: string }>;
  /** Send turn 1 (POST /api/verse/sessions/:id/turns). */
  sendTurn(sessionId: string, text: string): Promise<unknown>;
  /** Record the thread link (best effort — a failure here never fails the answer). */
  link?(childSessionId: string): Promise<unknown>;
}

export type FanOutEntry =
  | { target: CompareTarget; ok: true; sessionId: string }
  | { target: CompareTarget; ok: false; sessionId: string | null; error: string };

function message(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return typeof err === 'string' && err ? err : 'The request failed.';
}

/** Distinct seats, capped at COMPARE_MAX_SEATS, in the caller's order. */
export function normalizeTargets(targets: readonly CompareTarget[]): CompareTarget[] {
  const seen = new Set<string>();
  const out: CompareTarget[] = [];
  for (const t of targets) {
    if (!t.seatId || seen.has(t.seatId)) continue;
    seen.add(t.seatId);
    out.push(t);
    if (out.length === COMPARE_MAX_SEATS) break;
  }
  return out;
}

/**
 * Send `text` to every target in parallel. Never throws: each entry says
 * whether its chat was created and its turn accepted.
 */
export async function fanOut(targets: readonly CompareTarget[], text: string, deps: FanOutDeps): Promise<FanOutEntry[]> {
  const list = normalizeTargets(targets);
  return Promise.all(list.map(async (target): Promise<FanOutEntry> => {
    let sessionId: string | null = null;
    try {
      sessionId = (await deps.createSession(target)).id;
      if (deps.link) {
        try { await deps.link(sessionId); } catch { /* the meter just misses this link */ }
      }
      await deps.sendTurn(sessionId, text);
      return { target, ok: true, sessionId };
    } catch (err) {
      return { target, ok: false, sessionId, error: message(err) };
    }
  }));
}

/**
 * Default Compare set: the Auto choice plus the best seats of OTHER engines
 * (a second account of the same provider is not a second opinion), with one
 * local model when there is one — so a typical set is Claude + Codex + local.
 */
export function defaultCompareSet(choice: SeatAdviceOption | null, alternatives: readonly SeatAdviceOption[], max = COMPARE_MAX_SEATS): SeatAdviceOption[] {
  const pool = [...(choice ? [choice] : []), ...alternatives];
  const out: SeatAdviceOption[] = [];
  const engines = new Set<string>();
  const take = (o: SeatAdviceOption) => {
    if (out.length >= max || out.some((x) => x.seatId === o.seatId)) return;
    out.push(o);
    engines.add(o.engine);
  };
  for (const o of pool) if (!engines.has(o.engine) && !o.local) take(o);
  const local = pool.find((o) => o.local);
  if (local && !out.some((o) => o.local)) {
    // Make room for one local voice when the set is all paid seats.
    if (out.length === max) out.pop();
    take(local);
  }
  for (const o of pool) take(o);
  return out.slice(0, max);
}

/**
 * The reviewer for cross-family review: the best-ranked seat whose engine
 * differs from the author's. Claude-on-Ollama (`local`) counts as a different
 * family from `claude` — it is a different model. Null when every candidate
 * shares the author's engine.
 */
export function crossFamilyReviewer(authorEngine: string, ranked: readonly SeatAdviceOption[]): SeatAdviceOption | null {
  return ranked.find((o) => o.engine !== authorEngine) ?? null;
}

export interface ReviewSubject {
  /** What Mason asked, when reviewing an answer. */
  question?: string | null;
  /** The answer under review. */
  answer?: string | null;
  /** `git diff --stat` / a diff excerpt, when reviewing changes. */
  diff?: string | null;
  authorLabel: string;
}

const REVIEW_MAX_CHARS = 24_000;

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated for review)`;
}

/** The review turn: an independent critique, read-only, with a verdict line first. */
export function reviewPrompt(subject: ReviewSubject): string {
  const parts = [
    `You are reviewing work produced by another model (${subject.authorLabel}). Be an independent, skeptical reviewer.`,
    'The repository is open to you: read files or run read-only commands (such as a diff) to check claims, but change nothing.',
    'Start with one line: "Verdict: ship", "Verdict: fix first" or "Verdict: wrong", then list concrete problems (correctness, missed edge cases, security, simpler alternatives), most important first. Say plainly when you find nothing.',
  ];
  if (subject.question) parts.push('', 'The request was:', '', cap(subject.question.trim(), 4_000));
  if (subject.answer) parts.push('', 'The answer to review:', '', cap(subject.answer.trim(), REVIEW_MAX_CHARS));
  if (subject.diff) {
    const diff = cap(subject.diff.trim(), REVIEW_MAX_CHARS);
    // A fence longer than any backtick run inside: a diff of Markdown that
    // itself holds ``` must not close the block early.
    const longest = Math.max(0, ...Array.from(diff.matchAll(/`+/g), (m) => m[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    parts.push('', 'The changes to review:', '', `${fence}diff`, diff, fence);
  }
  return parts.join('\n');
}

/**
 * Turn 1 of a Compare chat. Mid-thread, each seat gets the zero-spend handoff
 * note first (none of them has the conversation), then the prompt.
 */
export function comparePrompt(text: string, handoffNote: string | null): string {
  if (!handoffNote) return text;
  return `${handoffNote.trim()}\n\n---\n\nThe request to answer now:\n\n${text}`;
}
