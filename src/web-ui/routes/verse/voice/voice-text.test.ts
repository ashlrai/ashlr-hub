import { describe, expect, it, vi } from 'vitest';
import { applyBias, biasIdentifiers, compact, findCandidates, lookupQueries, resolveCandidate } from './identifier-bias.js';
import { insertDictation } from './insert-text.js';
import { parseNativeVoiceEvent } from './voice-bridge.js';

const FILES = [
  'desktop/src-tauri/src/browser_pane.rs',
  'desktop/src-tauri/src/browser_tap.js',
  'src/web-ui/routes/verse/voice/VoiceInput.tsx',
  'src/web-ui/routes/verse/voice/useVoice.ts',
  'src/web-ui/routes/verse/Composer.tsx',
  'src/core/verse/file-index.ts',
  'src/a/index.ts',
  'src/b/index.ts',
];

describe('insertDictation', () => {
  it('appends with exactly one space', () => {
    expect(insertDictation('', 'Hello there.')).toEqual({ value: 'Hello there.', caret: 12 });
    expect(insertDictation('Fix this', 'and that')).toEqual({ value: 'Fix this and that', caret: 17 });
    expect(insertDictation('Fix this ', ' and that ')).toEqual({ value: 'Fix this and that', caret: 17 });
    expect(insertDictation('Line one\n', 'two')).toEqual({ value: 'Line one\ntwo', caret: 12 });
  });

  it('inserts at the caret, replacing a selection, padding both sides', () => {
    expect(insertDictation('ab cd', 'X', 2, 2)).toEqual({ value: 'ab X cd', caret: 4 });
    expect(insertDictation('say WORD now', 'hello', 4, 8)).toEqual({ value: 'say hello now', caret: 9 });
    expect(insertDictation('end', ', really', 3, 3)).toEqual({ value: 'end, really', caret: 11 });
    expect(insertDictation('x.', 'y', 1, 1).value).toBe('x y.');
  });

  it('never inserts an empty chunk and clamps wild selections', () => {
    expect(insertDictation('keep', '   ', 2, 2)).toEqual({ value: 'keep', caret: 2 });
    expect(insertDictation('keep', 'it', 99, -4).value).toBe('keep it');
  });
});

describe('identifier biasing', () => {
  it('turns a spoken extension into the real file name', async () => {
    const text = 'Open the browser pane dot rs file and check it.';
    const out = await biasIdentifiers(text, async () => FILES);
    expect(out).toBe('Open the `browser_pane.rs` file and check it.');
  });

  it('handles an extension the engine glued onto the last word', () => {
    const text = 'Look at browser pane.rs please';
    expect(applyBias(text, findCandidates(text), FILES)).toBe('Look at `browser_pane.rs` please');
  });

  it('uses a cue word only for multi-word names', () => {
    const text = 'Update the voice input component and the composer file.';
    expect(applyBias(text, findCandidates(text), FILES)).toBe('Update the `VoiceInput.tsx` component and the composer file.');
  });

  it('backticks identifier-shaped tokens that name a known file', () => {
    const text = 'Then useVoice should re-render, not browser_tap.';
    expect(applyBias(text, findCandidates(text), FILES)).toBe('Then `useVoice.ts` should re-render, not `browser_tap.js`.');
  });

  it('leaves ambiguous, unknown, plain-English and already-quoted words alone', () => {
    for (const text of [
      'The composer is nice.',
      'Run the index file.',
      'Open the rocket ship dot rs file.',
      'Keep `browser pane dot rs` as typed.',
      'We should talk about browser tabs.',
    ]) {
      expect(applyBias(text, findCandidates(text), FILES)).toBe(text);
    }
  });

  it('resolves only unique matches and dedupes lookups', () => {
    const [candidate] = findCandidates('file index dot ts').filter((c) => c.words === 2);
    expect(candidate).toBeDefined();
    expect(resolveCandidate(candidate!, FILES)).toBe('file-index.ts');
    expect(compact('Browser_Pane')).toBe('browserpane');
    const queries = lookupQueries(findCandidates('browser pane dot rs and browser pane dot rs'));
    expect(new Set(queries).size).toBe(queries.length);
    expect(queries.length).toBeLessThanOrEqual(6);
  });

  it('never throws and falls back to the spoken words when lookup fails or stalls', async () => {
    expect(await biasIdentifiers('browser pane dot rs', async () => { throw new Error('x'); })).toBe('browser pane dot rs');
    vi.useFakeTimers();
    const pending = biasIdentifiers('browser pane dot rs', () => new Promise(() => {}), 50);
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toBe('browser pane dot rs');
    vi.useRealTimers();
  });
});

describe('native voice events are validated at the boundary', () => {
  const state = {
    version: 1,
    mic: 'granted',
    engine: { id: 'parakeet', label: 'local Parakeet', model: 'loaded', progress: null, totalBytes: 670_000_000, error: null },
    hotkey: { accelerator: '⌃⌥V', commandAccelerator: '⌃⌥⇧V', registered: true, error: null },
    lexicon: 'live',
    session: { id: 'hk-1', origin: 'hotkey', mode: 'prose', phase: 'listening', latched: false },
  };

  it('accepts every well-formed event', () => {
    expect(parseNativeVoiceEvent({ event: 'voice://state', state })?.event).toBe('voice://state');
    expect(parseNativeVoiceEvent({ event: 'voice://level', session: 'v-1', level: 2 })).toEqual({ event: 'voice://level', session: 'v-1', level: 1 });
    expect(parseNativeVoiceEvent({ event: 'voice://partial', session: 'v-1', text: 'hi' })?.event).toBe('voice://partial');
    expect(parseNativeVoiceEvent({
      event: 'voice://final', session: 'v-1', text: 'Hi.', mode: 'prose', engine: 'parakeet', lexicon: 'cached', latencyMs: 120, audioMs: 900,
    })?.event).toBe('voice://final');
    expect(parseNativeVoiceEvent({ event: 'voice://error', session: null, code: 'mic-denied', message: 'no' })?.event).toBe('voice://error');
  });

  it('rejects anything malformed', () => {
    for (const bad of [
      null,
      'voice://state',
      { event: 'voice://nope' },
      { event: 'voice://state', state: { ...state, mic: 'maybe' } },
      { event: 'voice://state', state: { ...state, session: { ...state.session, id: 'has space' } } },
      { event: 'voice://state', state: { ...state, engine: { ...state.engine, progress: 3 } } },
      { event: 'voice://partial', session: 'v-1', text: 'x'.repeat(70_000) },
      { event: 'voice://final', session: 'v-1', text: 'x', mode: 'shout', engine: 'p', lexicon: 'live', latencyMs: 1, audioMs: 1 },
      { event: 'voice://error', session: 'v-1', code: 'rm -rf', message: 'x' },
      { event: 'voice://level', session: 'v-1', level: Number.NaN },
    ]) {
      expect(parseNativeVoiceEvent(bad)).toBeNull();
    }
  });
});
