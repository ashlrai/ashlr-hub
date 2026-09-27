/**
 * routes/verse/voice/voice-store.ts — the one dictation state machine behind
 * every mic button, the ⌃⌥V hotkey and the floating pill (VoiceHud).
 *
 * Two backends, one shape:
 * - `native` (the desktop app): capture + Parakeet run in Rust
 *   (desktop/src-tauri/src/voice/); this store sends ops and routes events.
 * - `web-speech` (a plain browser): the Web Speech API fallback.
 *
 * Surfaces register a TARGET (where text goes, how to post-process it). A
 * mic button starts a dictation for its own target; a hotkey dictation is
 * bound to the focused target, else the last-focused one, else the chat
 * composer. Finals are post-processed per mode — `prose` gets identifier
 * biasing (the lexicon already ran natively), `verbatim` (terminal) is
 * inserted exactly as heard, `command` becomes a command-palette query — and
 * inserted SOLID; partials only ever show dimmed in the pill.
 *
 * Module-level singleton, read through useSyncExternalStore. The meter level
 * (20 Hz) has its own channel so the waveform can paint without re-rendering
 * React.
 */
import { useSyncExternalStore } from 'react';
import {
  nativeVoice,
  subscribeNativeVoice,
  type FixAction,
  type LexiconStatus,
  type NativeVoiceEvent,
  type NativeVoiceState,
  type VoiceErrorCode,
  type VoiceMode,
} from './voice-bridge.js';
import { biasIdentifiers } from './identifier-bias.js';
import { getSpeechRecognition, startWebSpeech, type WebSpeechSession } from './web-speech.js';
import { handOffToPalette } from './palette-handoff.js';

export type VoiceSurface = 'composer' | 'leader' | 'palette' | 'terminal';

export interface VoiceTarget {
  id: string;
  surface: VoiceSurface;
  /** `verbatim` for the terminal: no cleanup, no backticks, no lexicon. */
  mode: 'prose' | 'verbatim';
  /** Focus inside this element makes it the hotkey's target. */
  element: () => HTMLElement | null;
  /** The chat's repo, so the lexicon's project terms apply. */
  cwd?: () => string | null;
  insert: (text: string) => void;
  /** Names the chat's files, for identifier biasing (prose only). */
  lookupIdentifiers?: (queries: string[]) => Promise<readonly string[]>;
  /** Told when a dictation for this target starts / ends. */
  onListening?: (listening: boolean) => void;
}

export type VoiceBackend = 'native' | 'web-speech' | 'none';

export interface VoiceSessionView {
  id: string;
  targetId: string | null;
  origin: 'button' | 'hotkey';
  mode: VoiceMode;
  phase: 'starting' | 'listening' | 'finalizing';
  partial: string;
  latched: boolean;
}

export interface VoiceErrorView {
  code: VoiceErrorCode;
  message: string;
  targetId: string | null;
}

export interface VoiceNotice {
  /** "Inserted" / "Sent to ⌘K" / the orphan text. */
  kind: 'inserted' | 'palette' | 'orphan';
  text: string;
  lexicon: LexiconStatus | null;
  latencyMs: number | null;
  mode: VoiceMode;
}

export interface VoiceSnapshot {
  backend: VoiceBackend;
  native: NativeVoiceState | null;
  session: VoiceSessionView | null;
  error: VoiceErrorView | null;
  notice: VoiceNotice | null;
  /** Ids of mounted targets (the HUD hides for a surface-less page). */
  targets: readonly string[];
}

/** Errors that need the operator (a fix button); the rest fade by themselves. */
const STICKY_ERRORS: ReadonlySet<VoiceErrorCode> = new Set([
  'mic-denied',
  'mic-restricted',
  'mic-undetermined',
  'no-usage-description',
  'no-input-device',
  'model-download-failed',
  'model-load-failed',
]);
const TRANSIENT_MS = 6_000;
const NOTICE_MS = 2_600;
const START_TIMEOUT_MS = 6_000;

// ── state ────────────────────────────────────────────────────────────────────

const targets = new Map<string, VoiceTarget>();
let lastFocused: string | null = null;
let snapshot: VoiceSnapshot = {
  backend: 'none',
  native: null,
  session: null,
  error: null,
  notice: null,
  targets: [],
};
const listeners = new Set<() => void>();
const levelListeners = new Set<(level: number) => void>();
let initialised = false;
let unsubscribeNative: (() => void) | null = null;
let webSession: WebSpeechSession | null = null;
let seq = 0;
let errorTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let startTimer: ReturnType<typeof setTimeout> | null = null;

function emit(next: Partial<VoiceSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of [...listeners]) listener();
}

function detectBackend(): VoiceBackend {
  if (nativeVoice()) return 'native';
  if (getSpeechRecognition()) return 'web-speech';
  return 'none';
}

function onFocusIn(event: FocusEvent): void {
  const node = event.target instanceof Node ? event.target : null;
  if (!node) return;
  for (const target of targets.values()) {
    if (target.element()?.contains(node)) {
      lastFocused = target.id;
      return;
    }
  }
}

function onKeyDown(event: KeyboardEvent): void {
  // Native registers Escape globally while dictating, so the page only sees
  // it when that failed — or in a browser.
  if (event.key === 'Escape' && snapshot.session) {
    event.preventDefault();
    cancelVoice();
  }
}

function ensureInit(): void {
  if (initialised) return;
  initialised = true;
  const backend = detectBackend();
  emit({ backend });
  try {
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKeyDown, true);
  } catch {
    /* no document (tests without jsdom) */
  }
  if (backend === 'native') {
    unsubscribeNative = subscribeNativeVoice(onNativeEvent);
    nativeVoice()?.send({ op: 'status' });
  }
}

// ── targets ──────────────────────────────────────────────────────────────────

export function registerVoiceTarget(target: VoiceTarget): () => void {
  ensureInit();
  targets.set(target.id, target);
  emit({ targets: [...targets.keys()] });
  return () => {
    if (targets.get(target.id) === target) targets.delete(target.id);
    if (lastFocused === target.id) lastFocused = null;
    emit({ targets: [...targets.keys()] });
  };
}

/** Focused target, else last-focused, else the chat composer, else any. */
export function pickHotkeyTarget(activeElement: Element | null = safeActiveElement()): VoiceTarget | null {
  const live = [...targets.values()].filter((t) => t.element()?.isConnected !== false);
  if (activeElement) {
    const focused = live.find((t) => t.element()?.contains(activeElement));
    if (focused) return focused;
  }
  const last = lastFocused ? live.find((t) => t.id === lastFocused) : undefined;
  if (last) return last;
  return live.find((t) => t.surface === 'composer') ?? live.find((t) => t.surface === 'leader') ?? live[0] ?? null;
}

function safeActiveElement(): Element | null {
  try {
    return document.activeElement;
  } catch {
    return null;
  }
}

// ── actions ──────────────────────────────────────────────────────────────────

function newSessionId(): string {
  seq += 1;
  return `v-${Date.now().toString(36)}-${seq}`;
}

function setError(code: VoiceErrorCode, message: string, targetId: string | null): void {
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = null;
  emit({ error: { code, message, targetId } });
  if (!STICKY_ERRORS.has(code)) {
    errorTimer = setTimeout(() => {
      errorTimer = null;
      emit({ error: null });
    }, TRANSIENT_MS);
  }
}

export function dismissVoiceError(): void {
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = null;
  emit({ error: null });
}

function setNotice(notice: VoiceNotice | null, sticky = false): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  emit({ notice });
  if (notice && !sticky) {
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      emit({ notice: null });
    }, NOTICE_MS);
  }
}

export function dismissVoiceNotice(): void {
  setNotice(null);
}

function endSession(): void {
  const current = snapshot.session;
  if (startTimer) clearTimeout(startTimer);
  startTimer = null;
  if (current?.targetId) targets.get(current.targetId)?.onListening?.(false);
  emit({ session: null });
  for (const listener of [...levelListeners]) listener(0);
}

function beginSession(session: VoiceSessionView): void {
  emit({ session, error: null });
  if (session.targetId) targets.get(session.targetId)?.onListening?.(true);
}

/** Start dictating into `targetId` (a mic button). */
export function startVoice(targetId: string): void {
  ensureInit();
  const target = targets.get(targetId);
  if (!target || snapshot.session) return;
  const mode: VoiceMode = target.mode;
  if (snapshot.backend === 'native') {
    const id = newSessionId();
    const cwd = target.cwd?.() ?? null;
    beginSession({ id, targetId, origin: 'button', mode, phase: 'starting', partial: '', latched: true });
    const sent = nativeVoice()?.send({ op: 'start', session: id, mode, ...(cwd ? { cwd } : {}) }) ?? false;
    if (!sent) {
      endSession();
      setError('unsupported', 'The desktop app did not accept the request — restart Ashlr.', targetId);
      return;
    }
    startTimer = setTimeout(() => {
      startTimer = null;
      if (snapshot.session?.id === id && snapshot.session.phase === 'starting') {
        endSession();
        setError('capture-failed', 'The microphone did not start — try again.', targetId);
      }
    }, START_TIMEOUT_MS);
    return;
  }
  if (snapshot.backend === 'web-speech') {
    const id = newSessionId();
    beginSession({ id, targetId, origin: 'button', mode, phase: 'listening', partial: '', latched: true });
    webSession = startWebSpeech({
      onPartial: (text) => {
        if (snapshot.session?.id === id) emit({ session: { ...snapshot.session, partial: text } });
      },
      onFinal: (text) => {
        void deliverFinal(targetId, text, mode, null, null);
      },
      onError: (code, message) => setError(code, message, targetId),
      onEnd: () => {
        webSession = null;
        if (snapshot.session?.id === id) endSession();
      },
    });
    if (!webSession) endSession();
    return;
  }
  setError('unsupported', 'Dictation is not available in this browser.', targetId);
}

/** Stop and transcribe. */
export function stopVoice(): void {
  const session = snapshot.session;
  if (!session) return;
  if (snapshot.backend === 'native') {
    emit({ session: { ...session, phase: 'finalizing' } });
    nativeVoice()?.send({ op: 'stop', session: session.id });
    return;
  }
  if (webSession) {
    emit({ session: { ...session, phase: 'finalizing' } });
    webSession.stop();
  }
}

/** Stop and throw the audio away. */
export function cancelVoice(): void {
  const session = snapshot.session;
  if (!session) return;
  if (snapshot.backend === 'native') nativeVoice()?.send({ op: 'cancel', session: session.id });
  webSession?.cancel();
  webSession = null;
  endSession();
}

export function toggleVoice(targetId: string): void {
  const session = snapshot.session;
  if (!session) startVoice(targetId);
  else if (session.phase === 'finalizing') return;
  else stopVoice();
}

export function fixVoice(action: FixAction): void {
  if (snapshot.backend !== 'native') return;
  nativeVoice()?.send({ op: 'fix', action });
  if (action !== 'cancel-download') dismissVoiceError();
}

// ── native events ────────────────────────────────────────────────────────────

function onNativeEvent(event: NativeVoiceEvent): void {
  switch (event.event) {
    case 'voice://state':
      return onNativeState(event.state);
    case 'voice://level':
      if (snapshot.session?.id === event.session) for (const listener of [...levelListeners]) listener(event.level);
      return;
    case 'voice://partial':
      if (snapshot.session?.id === event.session) emit({ session: { ...snapshot.session, partial: event.text } });
      return;
    case 'voice://final': {
      const mine = snapshot.session?.id === event.session;
      const targetId = mine ? (snapshot.session?.targetId ?? null) : null;
      // A final ends the dictation (native's session-cleared state follows).
      if (mine) endSession();
      void deliverFinal(targetId, event.text, event.mode, event.lexicon, event.latencyMs);
      return;
    }
    case 'voice://error': {
      // Always shown: a hotkey press that never became a session (mic denied,
      // model missing) reports under a session id the page never bound.
      const targetId = snapshot.session?.targetId ?? null;
      if (event.session !== null && event.session === snapshot.session?.id) endSession();
      setError(event.code, event.message, targetId);
      return;
    }
  }
}

function onNativeState(state: NativeVoiceState): void {
  emit({ native: state });
  const local = snapshot.session;
  const remote = state.session;
  if (!remote) {
    // A just-sent start has not reached native yet: an older snapshot says
    // "no session" — ignore it until native answers (or the start times out).
    if (local && local.phase !== 'starting') endSession();
    return;
  }
  if (local && local.id === remote.id) {
    if (startTimer && remote.phase === 'listening') {
      clearTimeout(startTimer);
      startTimer = null;
    }
    const phase = local.phase === 'finalizing' ? 'finalizing' : remote.phase;
    emit({ session: { ...local, phase, latched: remote.origin === 'button' ? true : remote.latched, mode: remote.mode } });
    return;
  }
  if (remote.origin === 'hotkey') {
    // A hotkey dictation: bind it to the focused Verse input and tell native
    // how to post-process for it (prose vs verbatim, the chat's repo).
    const target = pickHotkeyTarget();
    const mode: VoiceMode = remote.mode === 'command' ? 'command' : (target?.mode ?? 'prose');
    const cwd = mode === 'prose' ? (target?.cwd?.() ?? null) : null;
    if (local) endSession();
    beginSession({
      id: remote.id,
      targetId: mode === 'command' ? null : (target?.id ?? null),
      origin: 'hotkey',
      mode,
      phase: remote.phase,
      partial: '',
      latched: remote.latched,
    });
    nativeVoice()?.send({ op: 'context', session: remote.id, mode, ...(cwd ? { cwd } : {}) });
  }
}

async function deliverFinal(
  targetId: string | null,
  raw: string,
  mode: VoiceMode,
  lexicon: LexiconStatus | null,
  latencyMs: number | null,
): Promise<void> {
  const text = raw.trim();
  if (!text) return;
  if (mode === 'command') {
    handOffToPalette(text);
    setNotice({ kind: 'palette', text, lexicon, latencyMs, mode });
    return;
  }
  const target = targetId ? targets.get(targetId) : undefined;
  if (!target) {
    // Nowhere to put it (the input unmounted, or no dictation-enabled input
    // on screen): keep it visible with a Copy button rather than lose it.
    setNotice({ kind: 'orphan', text, lexicon, latencyMs, mode }, true);
    return;
  }
  let finalText = text;
  if (mode === 'prose' && target.lookupIdentifiers) {
    finalText = await biasIdentifiers(text, target.lookupIdentifiers);
  }
  target.insert(finalText);
  try {
    target.element()?.focus({ preventScroll: true });
  } catch {
    /* detached */
  }
  setNotice({ kind: 'inserted', text: finalText, lexicon, latencyMs, mode });
}

// ── reading it ───────────────────────────────────────────────────────────────

export function getVoiceSnapshot(): VoiceSnapshot {
  return snapshot;
}

export function subscribeVoice(listener: () => void): () => void {
  ensureInit();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The meter level (0..1) of the live dictation, ~20 Hz. */
export function subscribeVoiceLevel(listener: (level: number) => void): () => void {
  levelListeners.add(listener);
  return () => {
    levelListeners.delete(listener);
  };
}

export function useVoiceSnapshot(): VoiceSnapshot {
  return useSyncExternalStore(subscribeVoice, getVoiceSnapshot, getVoiceSnapshot);
}

/** Tests only: forget everything. */
export function resetVoiceStoreForTests(): void {
  unsubscribeNative?.();
  unsubscribeNative = null;
  try {
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('keydown', onKeyDown, true);
  } catch {
    /* ignore */
  }
  for (const t of [errorTimer, noticeTimer, startTimer]) if (t) clearTimeout(t);
  errorTimer = noticeTimer = startTimer = null;
  webSession = null;
  targets.clear();
  lastFocused = null;
  initialised = false;
  seq = 0;
  listeners.clear();
  levelListeners.clear();
  snapshot = { backend: 'none', native: null, session: null, error: null, notice: null, targets: [] };
}
