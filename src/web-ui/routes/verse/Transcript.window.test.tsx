/**
 * Transcript.window.test.tsx — V3.15 transcript windowing (chat/turn-window.ts):
 * a long chat mounts only the newest turns and the ones near the viewport;
 * every turn keeps its anchor; a jump into a windowed-out turn renders it
 * first; a short chat, or an engine without IntersectionObserver, is not
 * windowed at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { VerseEvent } from '../../data/api-types.js';
import { requestTranscriptJump } from './chat/transcript-jump.js';
import { toolAnchorId } from './chat/tool-semantics.js';
import { anchorTurnKey, WINDOW_MIN_TURNS, WINDOW_TAIL } from './chat/turn-window.js';
import { buildTurns, turnAnchorId } from './chat/turn-model.js';
import { ev } from './fixtures.test-support.js';
import { Transcript } from './Transcript.js';
import { buildTranscript, groupTranscriptItems } from './verse-transcript.js';

class FakeIO {
  static last: FakeIO | null = null;
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) { FakeIO.last = this; }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  takeRecords() { return []; }
  /** Report every observed turn; `near` decides which intersect. */
  fire(near: (key: string) => boolean, height = 500) {
    const entries = [...this.targets].map((target) => ({
      target,
      isIntersecting: near(target.getAttribute('data-turn-key') ?? ''),
      boundingClientRect: { height } as DOMRectReadOnly,
    })) as unknown as IntersectionObserverEntry[];
    act(() => { this.callback(entries, this as unknown as IntersectionObserver); });
  }
}

function chat(turns: number): VerseEvent[] {
  const out: VerseEvent[] = [];
  let seq = 1;
  for (let i = 0; i < turns; i += 1) {
    const turnId = `t${i}`;
    out.push(ev(seq++, 'user-message', { turnId, text: `ask ${i}` }));
    out.push(ev(seq++, 'tool-use', { turnId, toolUseId: `tool-${i}`, name: 'Bash', input: { command: `echo ${i}` } }));
    out.push(ev(seq++, 'tool-result', { turnId, toolUseId: `tool-${i}`, output: String(i), isError: false }));
    out.push(ev(seq++, 'assistant-message', { turnId, text: `answer ${i}` }));
    out.push(ev(seq++, 'turn-done', { turnId, ok: true, nativeSessionId: null, durationMs: 100 }));
  }
  return out;
}

const full = () => document.querySelectorAll('li[data-turn-key]:not([data-turn-placeholder])');
const placeholders = () => document.querySelectorAll('li[data-turn-placeholder]');

beforeEach(() => {
  FakeIO.last = null;
  vi.stubGlobal('IntersectionObserver', FakeIO);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe('Transcript windowing', () => {
  it('mounts only the newest turns of a long chat; every turn keeps its anchor', () => {
    const n = WINDOW_MIN_TURNS + 20;
    render(<Transcript transcript={buildTranscript(chat(n))} loaded loadError={null} />);
    expect(full()).toHaveLength(WINDOW_TAIL);
    expect(placeholders()).toHaveLength(n - WINDOW_TAIL);
    for (let i = 0; i < n; i += 1) expect(document.getElementById(turnAnchorId(`u-${i * 5 + 1}`))).not.toBeNull();
    expect(document.body).toHaveTextContent(`answer ${n - 1}`);
    expect(document.body).not.toHaveTextContent('answer 3 ');
  });

  it('renders a turn in full as it nears the viewport, and returns it at its measured height', () => {
    render(<Transcript transcript={buildTranscript(chat(WINDOW_MIN_TURNS + 5))} loaded loadError={null} />);
    const key = 'u-11'; // turn 2
    FakeIO.last!.fire((k) => k === key);
    expect(document.getElementById(turnAnchorId(key))).not.toHaveAttribute('data-turn-placeholder');
    expect(document.body).toHaveTextContent('answer 2');
    FakeIO.last!.fire(() => false, 612);
    const back = document.getElementById(turnAnchorId(key))!;
    expect(back).toHaveAttribute('data-turn-placeholder');
    expect(back.style.height).toBe('612px');
  });

  it('a jump into a windowed-out turn renders it first, then lands on the call', async () => {
    render(<Transcript transcript={buildTranscript(chat(WINDOW_MIN_TURNS + 5))} loaded loadError={null} />);
    expect(document.getElementById(toolAnchorId('tool-3'))).toBeNull();
    act(() => { requestTranscriptJump(toolAnchorId('tool-3')); });
    await waitFor(() => expect(document.getElementById(toolAnchorId('tool-3'))).not.toBeNull());
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it('does not window a short chat, or without IntersectionObserver', () => {
    const { unmount } = render(<Transcript transcript={buildTranscript(chat(WINDOW_MIN_TURNS - 1))} loaded loadError={null} />);
    expect(placeholders()).toHaveLength(0);
    unmount();
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<Transcript transcript={buildTranscript(chat(WINDOW_MIN_TURNS + 5))} loaded loadError={null} />);
    expect(placeholders()).toHaveLength(0);
  });

  it('anchorTurnKey finds the turn behind a turn, call or note anchor', () => {
    const turns = buildTurns(groupTranscriptItems(buildTranscript(chat(3)).items)).turns;
    expect(anchorTurnKey(turns, toolAnchorId('tool-1'))).toBe(turns[1]!.key);
    expect(anchorTurnKey(turns, turnAnchorId(turns[2]!.key))).toBe(turns[2]!.key);
    expect(anchorTurnKey(turns, 'verse-tool-nope')).toBeNull();
  });
});
