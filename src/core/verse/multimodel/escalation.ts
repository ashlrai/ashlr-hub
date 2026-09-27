/**
 * Cheap-first escalation — a local model drafts, a frontier seat is used only
 * when it is needed. Two PURE decisions and one piece of arithmetic:
 *
 *   triage(classification)  BEFORE sending: is this message one a local model
 *                           should even try? Hard work, large messages and a
 *                           confident "needs frontier" from the decision
 *                           layer go straight to the frontier seat — a weak
 *                           draft there would cost a round trip and save
 *                           nothing.
 *   assessDraft(draft)      AFTER the local turn: is the draft good enough?
 *                           Legible heuristics, each named in the verdict —
 *                           the turn failed, the answer is empty or cut off,
 *                           it hedges, it loops, an edit request produced no
 *                           code. Below ESCALATE_BELOW the composer escalates.
 *   savedUsd(tokens, price) What answering locally saved, at the frontier
 *                           seat's API list price — an EQUIVALENT (a Max
 *                           subscription is not billed per token), labelled
 *                           as such wherever it is shown.
 *
 * Escalation itself is an ordinary handoff: the conversation continues on the
 * frontier seat from the zero-spend handoff note, with the local draft quoted
 * for it to check — through the same session routes as any other turn.
 *
 * BROWSER-SAFE.
 */
import type { PromptClassification } from './types.js';

/** A draft scoring below this is escalated. */
export const ESCALATE_BELOW = 0.55;

export interface TriageVerdict {
  route: 'local' | 'frontier';
  reason: string;
}

export function triage(cls: PromptClassification, opts: { localAvailable: boolean }): TriageVerdict {
  if (!opts.localAvailable) return { route: 'frontier', reason: 'No local model is running, so there is nothing to draft with.' };
  if ((cls.needsFrontier ?? 0) >= 0.7) return { route: 'frontier', reason: `Jev says this needs a frontier model (${Math.round((cls.needsFrontier ?? 0) * 100)}%).` };
  if (cls.difficulty === 'high') return { route: 'frontier', reason: `A ${cls.label} goes straight to a frontier seat — a local draft would not save anything.` };
  if (cls.size === 'large') return { route: 'frontier', reason: 'A message this large goes straight to a frontier seat.' };
  return { route: 'local', reason: `A ${cls.label} — a local model drafts it first.` };
}

export interface DraftInput {
  text: string;
  /** The turn ended cleanly (turn-done ok). */
  ok: boolean;
  classification: PromptClassification;
  /** Tool calls the turn made (an edit request answered with edits has no code block to show). */
  toolUses?: number;
}

export interface DraftVerdict {
  escalate: boolean;
  /** 0–1: how much the heuristics trust the draft. */
  confidence: number;
  /** Every heuristic that fired, as a short sentence. */
  reasons: string[];
}

const HEDGES = [
  /\bI(?:'m| am) not (?:sure|certain)\b/i,
  /\bI (?:don't|do not) know\b/i,
  /\bI (?:can't|cannot|am unable to|'m unable to)\b/i,
  /\bunable to (?:determine|access|find|help)\b/i,
  /\bas an AI\b/i,
  /\bI (?:don't|do not) have access\b/i,
  /\bwithout more (?:context|information)\b/i,
  /\bit(?:'s| is) (?:unclear|hard to say)\b/i,
];

/** A line repeated three or more times — small models loop. */
function loops(text: string): boolean {
  const counts = new Map<string, number>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length < 12) continue;
    const n = (counts.get(line) ?? 0) + 1;
    if (n >= 3) return true;
    counts.set(line, n);
  }
  return false;
}

function cutOff(text: string): boolean {
  const t = text.trimEnd();
  if (t.length < 400) return false;
  if (/```\s*$/.test(t) && (t.match(/```/g) ?? []).length % 2 === 1) return true;
  return !/[.!?:)\]`"'*>|]$/.test(t);
}

export function assessDraft(input: DraftInput): DraftVerdict {
  const reasons: string[] = [];
  const text = input.text.trim();
  if (!input.ok) return { escalate: true, confidence: 0, reasons: ['The local turn did not finish cleanly.'] };
  if (text.length === 0) return { escalate: true, confidence: 0, reasons: ['The local model returned nothing.'] };

  let confidence = 1;
  const trivial = input.classification.difficulty === 'low';
  // A short reply after edits made through tools is a normal "done".
  if (text.length < 40 && !trivial && (input.toolUses ?? 0) === 0) {
    confidence -= 0.5;
    reasons.push('The answer is very short for the question.');
  }
  const hedges = HEDGES.filter((re) => re.test(text)).length;
  if (hedges > 0) {
    confidence -= Math.min(0.6, 0.3 * hedges);
    reasons.push(hedges === 1 ? 'The answer hedges.' : `The answer hedges ${hedges} times.`);
  }
  if (loops(text)) {
    confidence -= 0.5;
    reasons.push('The answer repeats itself.');
  }
  if (cutOff(text)) {
    confidence -= 0.3;
    reasons.push('The answer looks cut off.');
  }
  const edit = input.classification.kind === 'code' || input.classification.kind === 'debug' || input.classification.kind === 'refactor';
  if (edit && !/```/.test(text) && (input.toolUses ?? 0) === 0) {
    confidence -= 0.3;
    reasons.push('A code request got neither code nor edits.');
  }
  confidence = Math.max(0, Math.round(confidence * 100) / 100);
  if (reasons.length === 0) reasons.push('The draft reads complete.');
  return { escalate: confidence < ESCALATE_BELOW, confidence, reasons };
}

export interface ListPrice {
  /** USD per million input tokens. */
  inPerM: number;
  /** USD per million output tokens. */
  outPerM: number;
}

/** What `tokens` would have cost at `price` (cache reads at a tenth of the input rate). */
export function listCostUsd(tokens: { input: number; output: number; cacheRead?: number }, price: ListPrice): number {
  const usd = (tokens.input * price.inPerM + (tokens.cacheRead ?? 0) * price.inPerM * 0.1 + tokens.output * price.outPerM) / 1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

/** The escalation turn: the question again, with the local draft quoted for the frontier seat to check. */
export function escalationPrompt(question: string, draft: string, verdict: DraftVerdict, draftSeatLabel: string): string {
  const quoted = draft.length > 6_000 ? `${draft.slice(0, 6_000)}\n…(draft truncated)` : draft;
  return [
    question.trim(),
    '',
    `---`,
    `A local model (${draftSeatLabel}) drafted an answer first; it was escalated because: ${verdict.reasons.join(' ')}`,
    'Use it only if it is right. Its draft:',
    '',
    quoted.split('\n').map((l) => `> ${l}`).join('\n'),
  ].join('\n');
}
