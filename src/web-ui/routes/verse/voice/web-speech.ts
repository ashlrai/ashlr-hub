/**
 * routes/verse/voice/web-speech.ts — the browser fallback engine: the Web
 * Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) for Verse in a
 * plain browser (verse.ashlr.ai, localhost). The desktop app never uses it —
 * WKWebView has no recognizer, and native dictation is better anyway.
 *
 * One recognizer per dictation. Interim results stream as partials; final
 * segments accumulate and are delivered once, on stop, as one final — the
 * same shape the native engine produces.
 */

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
  length: number;
}
interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

/** The recognizer constructor, if this runtime ships one. */
export function getSpeechRecognition(): RecognitionCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface WebSpeechCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (code: 'mic-denied' | 'engine-failed' | 'no-speech', message: string) => void;
  /** The recognizer ended (after a final, an error, or on its own). */
  onEnd: () => void;
}

export interface WebSpeechSession {
  stop: () => void;
  cancel: () => void;
}

export function startWebSpeech(callbacks: WebSpeechCallbacks): WebSpeechSession | null {
  const Recognizer = getSpeechRecognition();
  if (!Recognizer) return null;
  let instance: RecognitionLike;
  try {
    instance = new Recognizer();
  } catch {
    callbacks.onError('engine-failed', 'Dictation could not start in this browser.');
    return null;
  }
  const finals: string[] = [];
  let interim = '';
  let done = false;
  let cancelled = false;
  const finish = () => {
    if (done) return;
    done = true;
    instance.onresult = null;
    instance.onerror = null;
    instance.onend = null;
    const text = [...finals, interim].map((s) => s.trim()).filter(Boolean).join(' ');
    if (!cancelled) {
      if (text) callbacks.onFinal(text);
      else callbacks.onError('no-speech', "Didn't catch anything — try again a little closer to the mic.");
    }
    callbacks.onEnd();
  };
  instance.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
  instance.continuous = true;
  instance.interimResults = true;
  instance.onresult = (event) => {
    interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (!result) continue;
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal) finals.push(transcript);
      else interim += transcript;
    }
    callbacks.onPartial([...finals, interim].map((s) => s.trim()).filter(Boolean).join(' '));
  };
  instance.onerror = (event) => {
    const code = event.error ?? 'unknown';
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      cancelled = true;
      callbacks.onError('mic-denied', "Microphone access was denied — allow it in the browser's site settings.");
    } else if (code !== 'aborted' && code !== 'no-speech') {
      cancelled = true;
      callbacks.onError('engine-failed', `Dictation stopped (${code}).`);
    }
    finish();
  };
  instance.onend = finish;
  try {
    instance.start();
  } catch {
    callbacks.onError('engine-failed', 'Dictation could not start in this browser.');
    return null;
  }
  return {
    stop: () => {
      try {
        instance.stop();
      } catch {
        finish();
      }
    },
    cancel: () => {
      cancelled = true;
      try {
        instance.abort();
      } catch {
        /* already stopped */
      }
      finish();
    },
  };
}
