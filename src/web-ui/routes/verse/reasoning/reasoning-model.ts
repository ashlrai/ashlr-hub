/**
 * routes/verse/reasoning/reasoning-model.ts — the chat-level views behind the
 * Sources and Reasoning panes (V3.15). Pure over the transcript's TURNS
 * (chat/turn-model.ts), so the numbers the panes show are the numbers under
 * each answer by construction.
 *
 *  - `buildChatSources`   every citation in the chat, de-duplicated across
 *                         turns and numbered in order of first use, with the
 *                         turns that drew on each and a per-kind breakdown;
 *  - `buildReasoningTrail` every turn's reasoning in order — the blocks it
 *                         showed, what the provider withheld, and the one-line
 *                         summary of what the turn did — with an honest note
 *                         for a seat that shares nothing.
 */
import type { VerseSession, VerseSource, VerseSourceKind, VerseThinkingKind } from '../../../../core/verse/types.js';
import { collateSources, reasoningPolicyFor, type VerseCitation } from '../../../../core/verse/trace.js';
import type { TurnBlock, TurnReasoning } from '../chat/turn-model.js';
import { turnTitle } from '../chat/turn-model.js';
import type { ToolGroupItem, TranscriptItem } from '../verse-transcript.js';

export interface ChatSourceEntry {
  citation: VerseCitation;
  /** Turns (keys, in order) whose answers cite it. */
  turnKeys: string[];
}

export interface ChatSources {
  entries: ChatSourceEntry[];
  byKind: Record<VerseSourceKind, number>;
}

function zeroKinds(): Record<VerseSourceKind, number> {
  return { file: 0, url: 0, search: 0, doc: 0, memory: 0, knowledge: 0 };
}

/**
 * Context Verse itself put in front of the agent on every turn — today the
 * chat's pinned shared project memory (MEMORY.md). Derived from the session
 * record, not guessed: `memoryEnabled` is pinned at creation.
 */
export function injectedSources(session: Pick<VerseSession, 'memoryEnabled' | 'projectPath'> | null | undefined): VerseSource[] {
  if (!session?.memoryEnabled) return [];
  return [{
    kind: 'memory',
    ref: `memory:${session.projectPath}`,
    title: 'Shared project memory (MEMORY.md)',
    origin: 'engine',
    detail: 'Offered to the agent at the start of every turn in this chat.',
  }];
}

/** Chat-level sources: every turn's citations, plus chat-wide ones (turnId null) and injected context. */
export function buildChatSources(turns: readonly TurnBlock[], injected: readonly VerseSource[] = []): ChatSources {
  const all: VerseSource[] = [...injected];
  const turnsByRef = new Map<string, string[]>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.kind === 'source' && item.turnId === null) all.push(item.source);
    }
    for (const citation of turn.citations) {
      // Re-expand each turn citation's merged ranges so the chat-level merge
      // sees every range, not just the first sighting.
      const s = citation.source;
      const base = { ...s, toolUseId: citation.toolUseIds[0] ?? s.toolUseId };
      if (citation.ranges.length === 0) {
        const whole: VerseSource = { ...base };
        delete whole.lineStart;
        delete whole.lineEnd;
        all.push(whole);
      } else {
        for (const range of citation.ranges) {
          const ranged: VerseSource = { ...base, lineStart: range.start };
          if (range.end !== null) ranged.lineEnd = range.end;
          else delete ranged.lineEnd;
          all.push(ranged);
        }
      }
      const keys = turnsByRef.get(s.ref) ?? [];
      if (!keys.includes(turn.key)) keys.push(turn.key);
      turnsByRef.set(s.ref, keys);
    }
  }
  const byKind = zeroKinds();
  const entries = collateSources(all).map((citation) => {
    byKind[citation.source.kind] += 1;
    return { citation, turnKeys: turnsByRef.get(citation.source.ref) ?? [] };
  });
  return { entries, byKind };
}

export interface ReasoningThought {
  key: string;
  text: string;
  redacted: boolean;
  durationMs: number | null;
  estimatedTokens: number | null;
  kind: VerseThinkingKind | null;
}

export interface ReasoningTurnEntry {
  turnKey: string;
  /** 1-based position in the chat. */
  index: number;
  title: string;
  status: TurnBlock['status'];
  work: string;
  reasoning: TurnReasoning;
  thoughts: ReasoningThought[];
  /** Said instead of thoughts when a settled turn carried none and the seat is known to withhold it. */
  silentNote: string | null;
}

function thoughtsOf(items: readonly (TranscriptItem | ToolGroupItem)[]): ReasoningThought[] {
  const out: ReasoningThought[] = [];
  for (const item of items) {
    const members = item.kind === 'toolGroup' ? item.items : [item];
    for (const m of members) {
      if (m.kind !== 'thinking') continue;
      out.push({ key: m.key, text: m.text, redacted: m.redacted || m.text.trim().length === 0, durationMs: m.durationMs, estimatedTokens: m.estimatedTokens, kind: m.thinkingKind });
    }
  }
  return out;
}

export function buildReasoningTrail(turns: readonly TurnBlock[], engine: string | null | undefined): ReasoningTurnEntry[] {
  const policy = reasoningPolicyFor(engine);
  return turns.map((turn, i) => {
    const thoughts = thoughtsOf(turn.items);
    const settled = turn.status !== 'running';
    return {
      turnKey: turn.key,
      index: i + 1,
      title: turnTitle(turn),
      status: turn.status,
      work: turn.work,
      reasoning: turn.reasoning,
      thoughts,
      silentNote: settled && thoughts.length === 0 ? policy.silentTurnNote : null,
    };
  });
}

/** Totals for the pane header: blocks shown / withheld, and summed time. */
export function reasoningTotals(entries: readonly ReasoningTurnEntry[]): TurnReasoning {
  const out: TurnReasoning = { shown: 0, hidden: 0, durationMs: null, tokens: null };
  for (const e of entries) {
    out.shown += e.reasoning.shown;
    out.hidden += e.reasoning.hidden;
    if (e.reasoning.durationMs !== null) out.durationMs = (out.durationMs ?? 0) + e.reasoning.durationMs;
    if (e.reasoning.tokens !== null) out.tokens = (out.tokens ?? 0) + e.reasoning.tokens;
  }
  return out;
}
