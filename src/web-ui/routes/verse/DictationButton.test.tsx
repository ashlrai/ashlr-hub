import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DICTATION_FALLBACK_HINT, DictationButton, getSpeechRecognition } from './DictationButton.js';

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((event: { resultIndex: number; results: Array<{ isFinal: boolean; 0: { transcript: string }; length: number }> }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  started = false;
  stopped = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.stopped = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecognition.instances = [];
});

describe('DictationButton', () => {
  it('falls back to a disabled button with the Wispr Flow / Superwhisper hint when no recognizer exists', () => {
    expect(getSpeechRecognition()).toBeNull();
    render(<DictationButton onInterim={() => {}} onFinal={() => {}} />);
    const button = screen.getByRole('button', { name: /dictation unavailable/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', DICTATION_FALLBACK_HINT);
    expect(screen.getByRole('tooltip')).toHaveTextContent(DICTATION_FALLBACK_HINT);
    expect(button).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
  });

  it('toggles listening, streams interim results, commits finals, and stops on Escape', async () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    const user = userEvent.setup();
    render(<DictationButton onInterim={onInterim} onFinal={onFinal} />);

    await user.click(screen.getByRole('button', { name: /start dictation/i }));
    const rec = FakeRecognition.instances[0]!;
    expect(rec.started).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.continuous).toBe(true);
    expect(screen.getByRole('button', { name: /stop dictation/i })).toHaveAttribute('aria-pressed', 'true');

    rec.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'hel' }, length: 1 }] });
    expect(onInterim).toHaveBeenLastCalledWith('hel');
    rec.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hello world ' }, length: 1 }] });
    expect(onFinal).toHaveBeenCalledWith('hello world');
    expect(onInterim).toHaveBeenLastCalledWith('');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(rec.stopped).toBe(true);
    expect(screen.getByRole('button', { name: /start dictation/i })).toHaveAttribute('aria-pressed', 'false');
  });
});
