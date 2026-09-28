import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MicButton } from './MicButton.js';

class FakeRecognition {
  static current: FakeRecognition | undefined;
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string }; length: number }> }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() { FakeRecognition.current = this; }
}

beforeEach(() => { FakeRecognition.current = undefined; });
afterEach(() => {
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
});

describe('mobile microphone', () => {
  it('keeps the last recognized phrase until stop finishes, then inserts it once', () => {
    (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition;
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    render(<MicButton onInterim={onInterim} onFinal={onFinal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review browser dictation' }));
    expect(screen.getByRole('status')).toHaveTextContent('may send audio');
    expect(FakeRecognition.current).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
    expect(screen.getByRole('status')).toHaveTextContent('Listening');
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }));
    expect(onFinal).not.toHaveBeenCalled();
    act(() => {
      FakeRecognition.current?.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'Ship the patch' }, length: 1 }] });
      FakeRecognition.current?.onend?.();
    });
    expect(onFinal).toHaveBeenCalledExactlyOnceWith('Ship the patch');
    expect(onInterim).toHaveBeenLastCalledWith('');
    expect(screen.queryByText(/Listening/)).not.toBeInTheDocument();
  });

  it('shows the keyboard fallback when recognition is unavailable', () => {
    render(<MicButton onInterim={vi.fn()} onFinal={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Dictation unavailable in this browser' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('keyboard');
  });
});
