/**
 * routes/verse/voice/voice-bridge.ts — the web half of the desktop dictation
 * channel (shell contract v1 `voice`; native: desktop/src-tauri/src/voice/).
 *
 * Page → native: `window.__ASHLR_DESKTOP__.voice.send(msg)` (shell_contract.js
 * emits `shell-voice`; native parses it strictly, voice/protocol.rs).
 * Native → page: the `ashlr:voice` window event, carrying one of
 * `voice://state | level | partial | final | error`. Every detail crossed from
 * another runtime, so it is validated here before anything reads it.
 *
 * Inert in a browser: no bridge, no events. `nativeVoice()` returning null is
 * the feature test (an older desktop shell has no `voice` key either).
 */

export const NATIVE_VOICE_EVENT = 'ashlr:voice';

export type VoiceMode = 'prose' | 'verbatim' | 'command';
export type MicStatus = 'granted' | 'denied' | 'restricted' | 'undetermined' | 'no-usage-description' | 'unsupported';
export type ModelPhase = 'missing' | 'downloading' | 'verifying' | 'ready' | 'loading' | 'loaded' | 'failed';
export type LexiconStatus = 'live' | 'cached' | 'none';
export type VoiceErrorCode =
  | 'mic-denied'
  | 'mic-restricted'
  | 'mic-undetermined'
  | 'no-usage-description'
  | 'no-input-device'
  | 'capture-failed'
  | 'model-missing'
  | 'model-download-failed'
  | 'model-load-failed'
  | 'engine-failed'
  | 'no-speech'
  | 'busy'
  | 'unsupported';
export type FixAction =
  | 'request-mic'
  | 'open-mic-settings'
  | 'open-sound-settings'
  | 'download-model'
  | 'cancel-download'
  | 'retry-lexicon';

export interface NativeVoiceState {
  version: number;
  mic: MicStatus;
  engine: {
    id: 'parakeet' | 'whisper' | 'none';
    label: string;
    model: ModelPhase;
    progress: number | null;
    totalBytes: number;
    error: string | null;
  };
  hotkey: { accelerator: string; commandAccelerator: string; registered: boolean; error: string | null };
  lexicon: LexiconStatus;
  session: {
    id: string;
    origin: 'button' | 'hotkey';
    mode: VoiceMode;
    phase: 'listening' | 'finalizing';
    latched: boolean;
  } | null;
}

export type NativeVoiceEvent =
  | { event: 'voice://state'; state: NativeVoiceState }
  | { event: 'voice://level'; session: string; level: number }
  | { event: 'voice://partial'; session: string; text: string }
  | {
      event: 'voice://final';
      session: string;
      text: string;
      mode: VoiceMode;
      engine: string;
      lexicon: LexiconStatus;
      latencyMs: number;
      audioMs: number;
    }
  | { event: 'voice://error'; session: string | null; code: VoiceErrorCode; message: string };

export type VoiceRequest =
  | { op: 'status' }
  | { op: 'start'; session: string; mode: VoiceMode; cwd?: string }
  | { op: 'context'; session: string; mode: VoiceMode; cwd?: string }
  | { op: 'stop'; session: string }
  | { op: 'cancel'; session: string }
  | { op: 'fix'; action: FixAction };

const MODES: readonly string[] = ['prose', 'verbatim', 'command'];
const MICS: readonly string[] = ['granted', 'denied', 'restricted', 'undetermined', 'no-usage-description', 'unsupported'];
const PHASES: readonly string[] = ['missing', 'downloading', 'verifying', 'ready', 'loading', 'loaded', 'failed'];
const LEXICON: readonly string[] = ['live', 'cached', 'none'];
const ERRORS: readonly string[] = [
  'mic-denied', 'mic-restricted', 'mic-undetermined', 'no-usage-description', 'no-input-device', 'capture-failed',
  'model-missing', 'model-download-failed', 'model-load-failed', 'engine-failed', 'no-speech', 'busy', 'unsupported',
];
/** Transcripts are bounded (10 min of speech is far below this). */
const TEXT_MAX = 64 * 1024;
const MESSAGE_MAX = 400;
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}
function isSession(value: unknown): value is string {
  return typeof value === 'string' && SESSION_RE.test(value);
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function oneOf<T extends string>(value: unknown, allowed: readonly string[]): value is T {
  return typeof value === 'string' && allowed.includes(value);
}

function parseState(raw: unknown): NativeVoiceState | null {
  if (!isRecord(raw) || !isRecord(raw['engine']) || !isRecord(raw['hotkey'])) return null;
  const e = raw['engine'];
  const h = raw['hotkey'];
  const s = raw['session'];
  if (!isFiniteNumber(raw['version']) || !oneOf<MicStatus>(raw['mic'], MICS) || !oneOf<LexiconStatus>(raw['lexicon'], LEXICON)) return null;
  if (!oneOf<'parakeet' | 'whisper' | 'none'>(e['id'], ['parakeet', 'whisper', 'none'])) return null;
  if (!isString(e['label'], 60) || !oneOf<ModelPhase>(e['model'], PHASES)) return null;
  if (!(e['progress'] === null || (isFiniteNumber(e['progress']) && e['progress'] >= 0 && e['progress'] <= 1))) return null;
  if (!isFiniteNumber(e['totalBytes']) || !(e['error'] === null || isString(e['error'], MESSAGE_MAX))) return null;
  if (!isString(h['accelerator'], 16) || !isString(h['commandAccelerator'], 16) || typeof h['registered'] !== 'boolean') return null;
  if (!(h['error'] === null || isString(h['error'], MESSAGE_MAX))) return null;
  let session: NativeVoiceState['session'] = null;
  if (s !== null) {
    if (!isRecord(s) || !isSession(s['id']) || !oneOf(s['origin'], ['button', 'hotkey']) || !oneOf<VoiceMode>(s['mode'], MODES)) return null;
    if (!oneOf(s['phase'], ['listening', 'finalizing']) || typeof s['latched'] !== 'boolean') return null;
    session = {
      id: s['id'],
      origin: s['origin'] as 'button' | 'hotkey',
      mode: s['mode'],
      phase: s['phase'] as 'listening' | 'finalizing',
      latched: s['latched'],
    };
  }
  return {
    version: raw['version'],
    mic: raw['mic'],
    engine: {
      id: e['id'],
      label: e['label'],
      model: e['model'],
      progress: e['progress'] as number | null,
      totalBytes: e['totalBytes'],
      error: e['error'] as string | null,
    },
    hotkey: {
      accelerator: h['accelerator'],
      commandAccelerator: h['commandAccelerator'],
      registered: h['registered'],
      error: h['error'] as string | null,
    },
    lexicon: raw['lexicon'],
    session,
  };
}

/** Boundary check for one `ashlr:voice` detail. Null for anything malformed. */
export function parseNativeVoiceEvent(detail: unknown): NativeVoiceEvent | null {
  if (!isRecord(detail)) return null;
  switch (detail['event']) {
    case 'voice://state': {
      const state = parseState(detail['state']);
      return state ? { event: 'voice://state', state } : null;
    }
    case 'voice://level': {
      const level = detail['level'];
      if (!isSession(detail['session']) || !isFiniteNumber(level)) return null;
      return { event: 'voice://level', session: detail['session'], level: Math.min(1, Math.max(0, level)) };
    }
    case 'voice://partial':
      if (!isSession(detail['session']) || !isString(detail['text'], TEXT_MAX)) return null;
      return { event: 'voice://partial', session: detail['session'], text: detail['text'] };
    case 'voice://final': {
      const d = detail;
      if (!isSession(d['session']) || !isString(d['text'], TEXT_MAX) || !oneOf<VoiceMode>(d['mode'], MODES)) return null;
      if (!isString(d['engine'], 32) || !oneOf<LexiconStatus>(d['lexicon'], LEXICON)) return null;
      if (!isFiniteNumber(d['latencyMs']) || !isFiniteNumber(d['audioMs'])) return null;
      return {
        event: 'voice://final',
        session: d['session'],
        text: d['text'],
        mode: d['mode'],
        engine: d['engine'],
        lexicon: d['lexicon'],
        latencyMs: d['latencyMs'],
        audioMs: d['audioMs'],
      };
    }
    case 'voice://error': {
      const session = detail['session'];
      if (!(session === null || isSession(session))) return null;
      if (!oneOf<VoiceErrorCode>(detail['code'], ERRORS) || !isString(detail['message'], MESSAGE_MAX)) return null;
      return { event: 'voice://error', session, code: detail['code'], message: detail['message'] };
    }
    default:
      return null;
  }
}

interface VoiceBridge {
  version?: unknown;
  send?: (msg: unknown) => boolean;
}

/** The desktop dictation bridge, or null (browser, or an older desktop shell). */
export function nativeVoice(): { send: (msg: VoiceRequest) => boolean } | null {
  try {
    const bridge = (window as unknown as { __ASHLR_DESKTOP__?: { voice?: VoiceBridge } }).__ASHLR_DESKTOP__?.voice;
    if (!bridge || bridge.version !== 1 || typeof bridge.send !== 'function') return null;
    const send = bridge.send;
    return {
      send: (msg) => {
        try {
          return send(msg) === true;
        } catch {
          return false;
        }
      },
    };
  } catch {
    return null;
  }
}

/** Listen for validated native voice events. Returns an unsubscribe function. */
export function subscribeNativeVoice(handler: (event: NativeVoiceEvent) => void): () => void {
  function onEvent(event: Event): void {
    const parsed = parseNativeVoiceEvent((event as CustomEvent<unknown>).detail);
    if (parsed) handler(parsed);
  }
  window.addEventListener(NATIVE_VOICE_EVENT, onEvent);
  return () => window.removeEventListener(NATIVE_VOICE_EVENT, onEvent);
}
