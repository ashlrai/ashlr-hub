import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { VoiceInput } from './VoiceInput.js';
import { VoiceHud } from './VoiceHud.js';
import { resetVoiceStoreForTests } from './voice-store.js';
import { takePaletteQuery } from './palette-handoff.js';
import type { NativeVoiceState } from './voice-bridge.js';

vi.mock('../verse-ui-store.js', () => ({ openVerseOverlay: vi.fn() }));

type Sent = Record<string, unknown>;

function installBridge(): Sent[] {
  const sent: Sent[] = [];
  (window as unknown as { __ASHLR_DESKTOP__: unknown }).__ASHLR_DESKTOP__ = {
    voice: { version: 1, send: (msg: Sent) => { sent.push(msg); return true; } },
  };
  return sent;
}

function nativeEvent(detail: unknown): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('ashlr:voice', { detail }));
  });
}

function state(overrides: Partial<NativeVoiceState> = {}): NativeVoiceState {
  return {
    version: 1,
    mic: 'granted',
    engine: { id: 'parakeet', label: 'local Parakeet', model: 'loaded', progress: null, totalBytes: 670_000_000, error: null },
    hotkey: { accelerator: '⌃⌥V', commandAccelerator: '⌃⌥⇧V', registered: true, error: null },
    lexicon: 'live',
    session: null,
    ...overrides,
  };
}

/** A textarea with a mic, the way the composers wire it. */
function Box({ surface = 'composer' as const, mode = 'prose' as const, cwd = '/Users/m/repo', label = 'Message' }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');
  return (
    <div>
      <textarea ref={ref} aria-label={label} value={value} onChange={(e) => setValue(e.target.value)} />
      <VoiceInput surface={surface} mode={mode} targetRef={ref} cwd={() => cwd}
        onInsert={(text) => setValue((v) => (v ? `${v} ${text}` : text))} />
    </div>
  );
}

beforeEach(() => {
  resetVoiceStoreForTests();
});

afterEach(() => {
  resetVoiceStoreForTests();
  delete (window as unknown as { __ASHLR_DESKTOP__?: unknown }).__ASHLR_DESKTOP__;
  delete (globalThis as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

describe('VoiceInput — desktop (native engine)', () => {
  it('asks native for its state, then starts a dictation for its own input with the chat repo', () => {
    const sent = installBridge();
    render(<Box />);
    expect(sent[0]).toEqual({ op: 'status' });
    fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }));
    const start = sent.find((m) => m.op === 'start')!;
    expect(start).toMatchObject({ op: 'start', mode: 'prose', cwd: '/Users/m/repo' });
    expect(String(start.session)).toMatch(/^v-/);
  });

  it('shows dimmed partials in the pill and inserts the final solid', () => {
    const sent = installBridge();
    render(<><Box /><VoiceHud /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }));
    const session = String(sent.find((m) => m.op === 'start')!.session);
    nativeEvent({ event: 'voice://state', state: state({ session: { id: session, origin: 'button', mode: 'prose', phase: 'listening', latched: true } }) });
    expect(screen.getByText('Listening · local Parakeet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop dictation and insert' })).toHaveAttribute('aria-pressed', 'true');

    nativeEvent({ event: 'voice://partial', session, text: 'open the browser' });
    const partial = screen.getByText('open the browser');
    expect(partial.className).toMatch(/hudPartial/);
    expect(partial).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByLabelText('Message')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(sent.at(-1)).toEqual({ op: 'stop', session });
    expect(screen.getByText('Transcribing…')).toBeInTheDocument();

    nativeEvent({ event: 'voice://final', session, text: 'Open the browser pane.', mode: 'prose', engine: 'parakeet', lexicon: 'live', latencyMs: 142, audioMs: 2100 });
    nativeEvent({ event: 'voice://state', state: state() });
    return vi.waitFor(() => {
      expect(screen.getByLabelText('Message')).toHaveValue('Open the browser pane.');
      expect(screen.getByText('Inserted · 142 ms')).toBeInTheDocument();
      expect(screen.queryByText('raw')).toBeNull();
    });
  });

  it('binds a ⌃⌥V dictation to the focused input and tells native how to post-process it', () => {
    const sent = installBridge();
    render(<><Box label="Chat" /><Box surface="terminal" mode="verbatim" label="Shell" /><VoiceHud /></>);
    screen.getByLabelText('Shell').focus();
    nativeEvent({ event: 'voice://state', state: state({ session: { id: 'hk-7', origin: 'hotkey', mode: 'prose', phase: 'listening', latched: false } }) });
    // The terminal is verbatim and gets no cwd (no lexicon there).
    expect(sent.at(-1)).toEqual({ op: 'context', session: 'hk-7', mode: 'verbatim' });
    expect(screen.getByText('Release ⌃⌥V to insert')).toBeInTheDocument();
    nativeEvent({ event: 'voice://final', session: 'hk-7', text: 'git status', mode: 'verbatim', engine: 'parakeet', lexicon: 'none', latencyMs: 90, audioMs: 800 });
    return vi.waitFor(() => {
      expect(screen.getByLabelText('Shell')).toHaveValue('git status');
      expect(screen.getByLabelText('Chat')).toHaveValue('');
      // Verbatim never shows the lexicon badge.
      expect(screen.queryByText('raw')).toBeNull();
    });
  });

  it('falls back to the last-focused input when focus left the page', () => {
    const sent = installBridge();
    render(<><Box label="Chat" /><Box surface="leader" label="Leader" /></>);
    screen.getByLabelText('Leader').focus();
    screen.getByLabelText('Leader').blur();
    nativeEvent({ event: 'voice://state', state: state({ session: { id: 'hk-8', origin: 'hotkey', mode: 'prose', phase: 'listening', latched: true } }) });
    expect(sent.at(-1)).toEqual({ op: 'context', session: 'hk-8', mode: 'prose', cwd: '/Users/m/repo' });
    nativeEvent({ event: 'voice://final', session: 'hk-8', text: 'Ship it.', mode: 'prose', engine: 'parakeet', lexicon: 'cached', latencyMs: 80, audioMs: 600 });
    return vi.waitFor(() => {
      expect(screen.getByLabelText('Leader')).toHaveValue('Ship it.');
    });
  });

  it('command mode (⌃⌥⇧V) hands the words to ⌘K instead of an input', async () => {
    installBridge();
    render(<><Box /><VoiceHud /></>);
    nativeEvent({ event: 'voice://state', state: state({ session: { id: 'hk-9', origin: 'hotkey', mode: 'command', phase: 'listening', latched: false } }) });
    nativeEvent({ event: 'voice://final', session: 'hk-9', text: 'New chat.', mode: 'command', engine: 'parakeet', lexicon: 'live', latencyMs: 60, audioMs: 500 });
    await vi.waitFor(() => expect(screen.getByText(/Sent to ⌘K/)).toBeInTheDocument());
    expect(takePaletteQuery()).toBe('New chat');
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });

  it('marks an offline lexicon with a quiet raw badge that retries', async () => {
    const sent = installBridge();
    render(<><Box /><VoiceHud /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }));
    const session = String(sent.find((m) => m.op === 'start')!.session);
    nativeEvent({ event: 'voice://final', session, text: 'Ashler hub.', mode: 'prose', engine: 'parakeet', lexicon: 'cached', latencyMs: 100, audioMs: 900 });
    const badge = await screen.findByRole('button', { name: 'raw' });
    fireEvent.click(badge);
    expect(sent.at(-1)).toEqual({ op: 'fix', action: 'retry-lexicon' });
  });

  it.each([
    ['mic-denied', 'Open Privacy ▸ Microphone', { op: 'fix', action: 'open-mic-settings' }],
    ['mic-undetermined', 'Allow microphone', { op: 'fix', action: 'request-mic' }],
    ['no-input-device', 'Open Sound settings', { op: 'fix', action: 'open-sound-settings' }],
    ['model-download-failed', 'Download again', { op: 'fix', action: 'download-model' }],
  ] as const)('%s offers one click that fixes it', (code, label, op) => {
    const sent = installBridge();
    render(<><Box /><VoiceHud /></>);
    nativeEvent({ event: 'voice://error', session: 'hk-1', code, message: `problem: ${code}` });
    expect(screen.getByRole('alert')).toHaveTextContent(`problem: ${code}`);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(sent.at(-1)).toEqual(op);
  });

  it('a build without the usage string offers the reinstall command', () => {
    installBridge();
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<><Box /><VoiceHud /></>);
    nativeEvent({ event: 'voice://error', session: null, code: 'no-usage-description', message: 'Reinstall.' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy reinstall command' }));
    expect(writeText).toHaveBeenCalledWith('npm run ship:local -- --native');
  });

  it('shows the one-time model download with progress and a cancel', () => {
    const sent = installBridge();
    render(<><Box /><VoiceHud /></>);
    nativeEvent({ event: 'voice://state', state: state({ engine: { id: 'parakeet', label: 'local Parakeet', model: 'downloading', progress: 0.34, totalBytes: 670_000_000, error: null } }) });
    expect(screen.getByText('Downloading Parakeet · 34% of 670 MB (once)')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Model download' })).toHaveAttribute('aria-valuenow', '34');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sent.at(-1)).toEqual({ op: 'fix', action: 'cancel-download' });
  });

  it('Escape cancels a live dictation from the page', () => {
    const sent = installBridge();
    render(<><Box /><VoiceHud /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }));
    const session = String(sent.find((m) => m.op === 'start')!.session);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(sent.at(-1)).toEqual({ op: 'cancel', session });
    expect(screen.queryByText(/Listening/)).toBeNull();
  });

  it('keeps a dictation with nowhere to go, with Copy', () => {
    installBridge();
    render(<VoiceHud />);
    nativeEvent({ event: 'voice://state', state: state({ session: { id: 'hk-2', origin: 'hotkey', mode: 'prose', phase: 'listening', latched: false } }) });
    nativeEvent({ event: 'voice://final', session: 'hk-2', text: 'Lost words.', mode: 'prose', engine: 'parakeet', lexicon: 'live', latencyMs: 50, audioMs: 400 });
    return vi.waitFor(() => {
      expect(screen.getByText('Lost words.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    });
  });
});

describe('VoiceInput — browser', () => {
  it('is disabled with a hint when there is no engine at all', () => {
    render(<Box />);
    const button = screen.getByRole('button', { name: /Dictation unavailable/ });
    expect(button).toBeDisabled();
  });

  it('uses the Web Speech API as the fallback engine', () => {
    const instances: Array<{ onresult: ((e: unknown) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void }> = [];
    class FakeRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      constructor() { instances.push(this); }
      start(): void {}
      stop(): void { this.onend?.(); }
      abort(): void {}
    }
    (globalThis as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition;
    render(<><Box /><VoiceHud /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }));
    expect(screen.getByText('Listening · browser speech')).toBeInTheDocument();
    act(() => {
      instances[0]!.onresult?.({ resultIndex: 0, results: [{ isFinal: true, length: 1, 0: { transcript: 'hello world' } }] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    return vi.waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('hello world'));
  });
});
