/**
 * routes/verse/multimodel/multimodel-flows.ts — the multi-model actions, as
 * sequences of ORDINARY session calls.
 *
 * Every flow here is built from the same four calls a hand-driven chat makes
 * — create a session, build the zero-spend handoff note, send a turn, open a
 * chat — so each spent turn passes the server's spend chokepoint, readiness
 * gate, local-only gate and mutation token exactly as a typed message does.
 * The calls are injected (`FlowApi`) so the flows are testable without a
 * server; `DEFAULT_FLOW_API` wires the real ones.
 *
 *   routeMessage   Auto sent this message to another seat: continue the
 *                  conversation there (handoff note + the message).
 *   quickHandoff   One click from the seat chip: note built, chat created on
 *                  the target, note PREFILLED in its composer, chat opened.
 *                  Nothing is spent until Mason presses Send.
 *   startCompare   The same prompt to 2–3 seats in parallel (compare.ts fanOut).
 *   pickWinner     "Continue with this one": record the pick, open that chat.
 *   startReview    A cross-family reviewer asked about the last answer.
 *   escalate       Cheap-first: a weak local draft moves to a frontier seat.
 */
import type { VerseCreateSessionRequest, VerseHandoffPreview, VerseHandoffPreviewRequest, VerseSession, VerseTurnResponse } from '../../../../core/verse/types.js';
import { comparePrompt, fanOut, reviewPrompt, type CompareTarget, type FanOutEntry } from '../../../../core/verse/multimodel/compare.js';
import { escalationPrompt, type DraftVerdict } from '../../../../core/verse/multimodel/escalation.js';
import { classifyPrompt } from '../../../../core/verse/multimodel/classify.js';
import { compareOutcomes } from '../../../../core/verse/multimodel/learning.js';
import type { PromptKind, SeatOutcomeRequest, ThreadLinkRequest } from '../../../../core/verse/multimodel/types.js';
import { saveDraft } from '../chat/composer-state.js';
import { createHandoffSession, fetchHandoffPreview, type HandoffSessionInput } from '../context/context-queries.js';
import { createVerseSession, sendVerseTurn } from '../verse-queries.js';
import { getVerseSessionHead } from '../verse-store.js';
import { getVerseTranscript } from '../verse-transcript.js';
import { openVerseSession } from '../verse-ui-store.js';
import { linkThread, recordOutcome } from './multimodel-queries.js';

export interface FlowApi {
  createSession(req: VerseCreateSessionRequest): Promise<VerseSession>;
  createHandoffSession(input: HandoffSessionInput): Promise<VerseSession>;
  fetchHandoffPreview(sessionId: string, req?: VerseHandoffPreviewRequest): Promise<VerseHandoffPreview>;
  sendTurn(sessionId: string, text: string): Promise<VerseTurnResponse | unknown>;
  link(req: ThreadLinkRequest): Promise<boolean>;
  outcome(req: SeatOutcomeRequest): Promise<boolean>;
  saveDraft(sessionId: string, text: string): void;
  open(sessionId: string): void;
}

export const DEFAULT_FLOW_API: FlowApi = {
  createSession: createVerseSession,
  createHandoffSession,
  fetchHandoffPreview,
  sendTurn: sendVerseTurn,
  link: linkThread,
  outcome: recordOutcome,
  saveDraft,
  open: openVerseSession,
};

export interface FlowTarget {
  seatId: string;
  model: string | null;
  label: string;
  engine: string;
}

/**
 * A new chat on the SAME pinned roots as `source`, with no handoff: the
 * source's own `projectPath` + `extraRoots` (never its workspace id — see
 * context-queries `createHandoffSession` for why pinned roots are the honest set).
 */
export function siblingRequest(source: VerseSession, target: FlowTarget, title?: string): VerseCreateSessionRequest {
  const req: VerseCreateSessionRequest = { projectPath: source.projectPath, seatId: target.seatId };
  const extras = (source.extraRoots ?? []).filter((r) => typeof r === 'string' && r.length > 0 && r !== source.projectPath);
  if (extras.length > 0) req.extraRoots = extras;
  if (target.model) req.model = target.model;
  const t = title?.trim();
  if (t) req.title = t.slice(0, 120);
  return req;
}

/** Continue `source` on `target`: a handoff mid-thread, a plain sibling chat when it has no turns yet. */
async function continuation(api: FlowApi, source: VerseSession, target: FlowTarget, title?: string): Promise<{ session: VerseSession; note: string | null }> {
  if (source.turnCount > 0) {
    const preview = await api.fetchHandoffPreview(source.id);
    const session = await api.createHandoffSession({ source, seatId: target.seatId, ...(target.model ? { model: target.model } : {}), ...(title ? { title } : {}) });
    return { session, note: preview.text };
  }
  return { session: await api.createSession(siblingRequest(source, target, title)), note: null };
}

export async function routeMessage(
  api: FlowApi,
  input: { source: VerseSession; target: FlowTarget; text: string; kind: PromptKind; overridden?: { seatId: string } | null },
): Promise<VerseSession> {
  const { session, note } = await continuation(api, input.source, input.target);
  await api.sendTurn(session.id, comparePrompt(input.text, note));
  void api.outcome({ seatId: input.target.seatId, kind: input.kind, signal: input.overridden ? 'switch-to' : 'auto-followed', sessionId: session.id });
  if (input.overridden) void api.outcome({ seatId: input.overridden.seatId, kind: input.kind, signal: 'auto-overridden' });
  api.open(session.id);
  return session;
}

/** A plan worth carrying verbatim: a "Plan" heading, or three or more numbered / checklist steps. */
export function looksLikePlan(text: string | null | undefined): boolean {
  if (!text) return false;
  if (/^#{1,4}\s*(?:the\s+)?plan\b/im.test(text)) return true;
  return (text.match(/^\s*(?:\d+[.)]|[-*] \[[ x]\])\s+\S/gm) ?? []).length >= 3;
}

export async function quickHandoff(
  api: FlowApi,
  input: { source: VerseSession; target: FlowTarget; lastAssistant?: string | null; kind: PromptKind },
): Promise<VerseSession> {
  // The last answer rides along verbatim when it is a plan — the note's own
  // sections list files and asks, but not the plan the agent just wrote.
  const carryPlan = looksLikePlan(input.lastAssistant);
  const preview = await api.fetchHandoffPreview(input.source.id, carryPlan ? { includeLastAssistant: true } : {});
  const session = await api.createHandoffSession({ source: input.source, seatId: input.target.seatId, ...(input.target.model ? { model: input.target.model } : {}) });
  api.saveDraft(session.id, preview.text);
  void api.outcome({ seatId: input.source.seatId, kind: input.kind, signal: 'switch-away', sessionId: input.source.id });
  void api.outcome({ seatId: input.target.seatId, kind: input.kind, signal: 'switch-to', sessionId: session.id });
  api.open(session.id);
  return session;
}

/**
 * `quickHandoff` for a chat by id — what the seat chip calls. Reads the chat's
 * record and last answer from the store (this module is lazy, so the
 * transcript derivation stays off the composer's first-paint path).
 */
export async function quickHandoffFromChat(sessionId: string, target: FlowTarget, api: FlowApi = DEFAULT_FLOW_API): Promise<VerseSession | null> {
  const source = getVerseSessionHead(sessionId).session;
  // Nothing to hand off yet: the caller opens a plain new chat instead.
  if (!source || source.turnCount === 0) return null;
  const items = getVerseTranscript(sessionId).items;
  let lastUser = '';
  let lastAssistant: string | null = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]!;
    if (lastAssistant === null && it.kind === 'assistant') lastAssistant = it.text;
    if (it.kind === 'user') { lastUser = it.text; break; }
  }
  return quickHandoff(api, { source, target, lastAssistant, kind: classifyPrompt(lastUser).kind });
}

export async function startCompare(
  api: FlowApi,
  input: { source: VerseSession; targets: readonly FlowTarget[]; text: string },
): Promise<FanOutEntry[]> {
  // One note for every seat: built once, zero spend.
  const note = input.source.turnCount > 0 ? (await api.fetchHandoffPreview(input.source.id)).text : null;
  const title = (label: string) => `${input.source.title.slice(0, 80)} · ${label}`;
  return fanOut(input.targets as readonly CompareTarget[], comparePrompt(input.text, note), {
    createSession: (t) => (input.source.turnCount > 0
      ? api.createHandoffSession({ source: input.source, seatId: t.seatId, ...(t.model ? { model: t.model } : {}), title: title(t.label) })
      : api.createSession(siblingRequest(input.source, t, title(t.label)))),
    sendTurn: (id, text) => api.sendTurn(id, text),
    link: (child) => api.link({ parentSessionId: input.source.id, childSessionId: child, relation: 'compare' }),
  });
}

export async function pickWinner(
  api: FlowApi,
  input: { winnerSessionId: string; entries: ReadonlyArray<{ sessionId: string; seatId: string; engine: string; model?: string }>; kind: PromptKind },
): Promise<void> {
  const rows = compareOutcomes(input.winnerSessionId, input.entries, input.kind, new Date().toISOString());
  await Promise.all(rows.map((r) => api.outcome({ seatId: r.seatId, kind: r.kind, signal: r.signal, ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(r.model ? { model: r.model } : {}) })));
  api.open(input.winnerSessionId);
}

export async function startReview(
  api: FlowApi,
  input: { source: VerseSession; reviewer: FlowTarget; question: string | null; answer: string; authorLabel: string },
): Promise<VerseSession> {
  const session = await api.createSession(siblingRequest(input.source, input.reviewer, `Review · ${input.source.title.slice(0, 80)}`));
  void api.link({ parentSessionId: input.source.id, childSessionId: session.id, relation: 'review' });
  await api.sendTurn(session.id, reviewPrompt({ question: input.question, answer: input.answer, authorLabel: input.authorLabel }));
  return session;
}

export async function escalate(
  api: FlowApi,
  input: { source: VerseSession; target: FlowTarget; question: string; draft: string; verdict: DraftVerdict; draftLabel: string; kind: PromptKind },
): Promise<VerseSession> {
  const { session, note } = await continuation(api, input.source, input.target);
  void api.link({ parentSessionId: input.source.id, childSessionId: session.id, relation: 'escalate' });
  await api.sendTurn(session.id, comparePrompt(escalationPrompt(input.question, input.draft, input.verdict, input.draftLabel), note));
  void api.outcome({ seatId: input.source.seatId, kind: input.kind, signal: 'escalated', sessionId: input.source.id });
  api.open(session.id);
  return session;
}
