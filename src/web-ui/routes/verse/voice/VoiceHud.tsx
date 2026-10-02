/**
 * routes/verse/voice/VoiceHud.tsx — the floating dictation pill, one for the
 * whole app (mounted lazily by VerseApp).
 *
 *   listening   waveform · "Listening · local Parakeet" · how to finish ·
 *               Stop / Cancel, and the partial transcript DIMMED underneath
 *   finalizing  "Transcribing…"
 *   done        "Inserted · 180 ms" (+ a quiet "raw" badge when the lexicon
 *               was offline), "Sent to ⌘K", or — nowhere to put it — the text
 *               with Copy
 *   model       download / verify / load progress, with Cancel
 *   error       what happened and ONE button that fixes it
 *
 * Renders nothing when idle.
 */
import { useCallback, useState } from 'react';
import {
  cancelVoice,
  dismissVoiceError,
  dismissVoiceNotice,
  fixVoice,
  stopVoice,
  useVoiceSnapshot,
  type VoiceErrorView,
  type VoiceSnapshot,
} from './voice-store.js';
import type { FixAction } from './voice-bridge.js';
import { usedPercentText } from '../percent-text.js';
import { MicIcon, readableVoiceAccelerator } from './VoiceInput.js';
import { Waveform } from './Waveform.js';
import styles from './VoiceInput.module.css';

export const REINSTALL_COMMAND = 'npm run ship:local -- --native';

interface Fix {
  label: string;
  action: FixAction | 'copy-reinstall' | 'dismiss';
}

/** The one-click fix for an error, or null when there is nothing to do. */
export function fixFor(error: VoiceErrorView): Fix | null {
  switch (error.code) {
    case 'mic-undetermined':
      return { label: 'Allow microphone', action: 'request-mic' };
    case 'mic-denied':
    case 'mic-restricted':
      return { label: 'Open Microphone privacy settings', action: 'open-mic-settings' };
    case 'no-usage-description':
      return { label: 'Copy reinstall command', action: 'copy-reinstall' };
    case 'no-input-device':
    case 'capture-failed':
      return { label: 'Open Sound settings', action: 'open-sound-settings' };
    case 'model-download-failed':
    case 'model-load-failed':
      return { label: 'Download again', action: 'download-model' };
    case 'engine-failed':
    case 'unsupported':
      return { label: 'Dismiss', action: 'dismiss' };
    default:
      return null;
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function modelLine(voice: VoiceSnapshot): { text: string; progress: number | null; cancellable: boolean } | null {
  const engine = voice.native?.engine;
  if (!engine) return null;
  const name = engine.id === 'whisper' ? 'Whisper' : 'Parakeet';
  switch (engine.model) {
    case 'downloading': {
      // One percent rule: a download at 99.6% is not done, so it must not read "100%".
      const pct = usedPercentText((engine.progress ?? 0) * 100);
      return { text: `Downloading ${name} · ${pct} of ${formatBytes(engine.totalBytes)} (once)`, progress: engine.progress ?? 0, cancellable: true };
    }
    case 'verifying':
      return { text: `Verifying ${name}…`, progress: engine.progress, cancellable: false };
    case 'loading':
      return { text: `Loading ${name}…`, progress: null, cancellable: false };
    default:
      return null;
  }
}

function tail(text: string, max = 140): string {
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

export function VoiceHud() {
  const voice = useVoiceSnapshot();
  const [copied, setCopied] = useState(false);
  const runFix = useCallback((fix: Fix) => {
    if (fix.action === 'dismiss') return dismissVoiceError();
    if (fix.action === 'copy-reinstall') {
      void copy(REINSTALL_COMMAND).then((ok) => setCopied(ok));
      return;
    }
    fixVoice(fix.action);
  }, []);

  const { session, error, notice } = voice;
  const model = modelLine(voice);
  const engineLabel = voice.backend === 'native' ? (voice.native?.engine.label ?? 'local Parakeet') : 'browser speech';

  if (session) {
    const listening = session.phase !== 'finalizing';
    const accel = readableVoiceAccelerator(voice.native?.hotkey.accelerator ?? 'Ctrl+Option+V');
    const how = session.origin === 'hotkey' && !session.latched
      ? `Release ${accel} to insert`
      : voice.backend === 'native'
        ? `${accel} or Stop inserts · Esc cancels`
        : 'Stop inserts · Esc cancels';
    const where = session.mode === 'command' ? ' · command' : session.mode === 'verbatim' ? ' · terminal, verbatim' : '';
    return (
      <div className={styles.hud} data-state={listening ? 'listening' : 'finalizing'} role="group" aria-label="Dictation">
        <div className={styles.hudRow}>
          <span className={styles.hudDot} aria-hidden="true"><MicIcon /></span>
          <Waveform active={listening} />
          <span className={styles.hudLabel} role="status">
            {listening ? (session.phase === 'starting' ? 'Starting…' : `Listening · ${engineLabel}`) : 'Transcribing…'}
            <span className={styles.hudWhere}>{where}</span>
          </span>
          {listening ? <span className={styles.hudHint}>{how}</span> : null}
          {listening ? (
            <button type="button" className={styles.hudButton} data-primary="true" onClick={stopVoice}>Stop</button>
          ) : null}
          <button type="button" className={styles.hudIcon} aria-label="Cancel dictation" onClick={cancelVoice}>×</button>
        </div>
        {model ? <ModelRow text={model.text} progress={model.progress} cancellable={model.cancellable} /> : null}
        {session.partial ? (
          // Partials change every ~400 ms: hidden from screen readers (the
          // final is announced instead).
          <p className={styles.hudPartial} aria-hidden="true">{tail(session.partial)}</p>
        ) : null}
      </div>
    );
  }

  // The first dictation on a new Mac starts the one-time model download:
  // that is progress, not a failure — no red.
  if (error?.code === 'model-missing' && model) {
    return (
      <div className={styles.hud} data-state="model" role="status">
        <div className={styles.hudRow}>
          <span className={styles.hudDot} aria-hidden="true"><MicIcon /></span>
          <span className={styles.hudMessage}>{error.message}</span>
          <button type="button" className={styles.hudIcon} aria-label="Dismiss" onClick={dismissVoiceError}>×</button>
        </div>
        <ModelRow text={model.text} progress={model.progress} cancellable={model.cancellable} />
      </div>
    );
  }

  if (error) {
    const fix = fixFor(error);
    return (
      <div className={styles.hud} data-state="error" role="alert">
        <div className={styles.hudRow}>
          <span className={styles.hudDot} data-tone="danger" aria-hidden="true"><MicIcon /></span>
          <span className={styles.hudMessage}>{error.message}</span>
          {fix && fix.action !== 'dismiss' ? (
            <button type="button" className={styles.hudButton} data-primary="true" onClick={() => runFix(fix)}>
              {fix.action === 'copy-reinstall' && copied ? 'Copied' : fix.label}
            </button>
          ) : null}
          <button type="button" className={styles.hudIcon} aria-label="Dismiss" onClick={dismissVoiceError}>×</button>
        </div>
        {model ? <ModelRow text={model.text} progress={model.progress} cancellable={model.cancellable} /> : null}
      </div>
    );
  }

  if (model) {
    return (
      <div className={styles.hud} data-state="model" role="status">
        <ModelRow text={model.text} progress={model.progress} cancellable={model.cancellable} />
      </div>
    );
  }

  if (notice) {
    const raw = notice.mode !== 'verbatim' && notice.lexicon !== null && notice.lexicon !== 'live';
    const timing = notice.latencyMs !== null ? ` · ${Math.round(notice.latencyMs)} ms` : '';
    if (notice.kind === 'orphan') {
      return (
        <div className={styles.hud} data-state="notice" role="status">
          <div className={styles.hudRow}>
            <span className={styles.hudMessage}>No input to put this in — click one, then paste:</span>
            <button type="button" className={styles.hudButton} data-primary="true"
              onClick={() => { void copy(notice.text).then((ok) => { if (ok) dismissVoiceNotice(); }); }}>Copy</button>
            <button type="button" className={styles.hudIcon} aria-label="Dismiss" onClick={dismissVoiceNotice}>×</button>
          </div>
          <p className={styles.hudPartial} data-solid="true">{tail(notice.text, 280)}</p>
        </div>
      );
    }
    return (
      <div className={styles.hud} data-state="notice" role="status">
        <div className={styles.hudRow}>
          <span className={styles.hudLabel}>{notice.kind === 'palette' ? 'Sent to ⌘K' : 'Inserted'}{timing}</span>
          {raw ? (
            <button type="button" className={styles.rawBadge}
              title={notice.lexicon === 'cached'
                ? 'lexicon serve was offline — spellings came from the cached term map. Click to retry.'
                : 'lexicon serve was offline and no term map is cached — words are as heard. Click to retry.'}
              onClick={() => fixVoice('retry-lexicon')}>raw</button>
          ) : null}
        </div>
      </div>
    );
  }
  return null;
}

function ModelRow({ text, progress, cancellable }: { text: string; progress: number | null; cancellable: boolean }) {
  return (
    <div className={styles.hudModel}>
      <span className={styles.hudModelText}>{text}</span>
      {progress !== null ? (
        <span className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Model download">
          <span className={styles.progressFill} style={{ transform: `scaleX(${progress})` }} />
        </span>
      ) : null}
      {cancellable ? <button type="button" className={styles.hudButton} onClick={() => fixVoice('cancel-download')}>Cancel</button> : null}
    </div>
  );
}

export default VoiceHud;
