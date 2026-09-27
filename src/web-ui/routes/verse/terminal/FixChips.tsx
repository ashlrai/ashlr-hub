/**
 * terminal/FixChips.tsx — error-fix chips for a command that exited non-zero
 * (3.15). The LOCAL model proposes at most three commands (server:
 * terminal-assist.ts, over the block's scrubbed text); each is a chip whose
 * [Paste] types it at a prompt and stops — nothing here ever runs a command.
 * Beside them, "Ask Claude Code / Codex / Devin…" hands the failed block to
 * that seat's chat.
 *
 * Opt-in per device ("Suggest fixes with the local model", default on — it is
 * free and the text never leaves this Mac). When the local model does not
 * answer, the suggestions are simply absent; the Ask chips stay.
 */
import { useEffect, useState } from 'react';
import type { VerseTerminalFixResponse, VerseTerminalFixSuggestion } from '../../../data/api-types.js';
import { IconX } from '../../../components/primitives/icons.js';
import styles from './TerminalExtras.module.css';

export interface AskTarget {
  seatId: string;
  label: string;
}

export interface FixChipsProps {
  /** Null = suggestions are off (the Ask chips still show). */
  load: (() => Promise<VerseTerminalFixResponse>) | null;
  onPaste: (command: string) => void;
  askTargets: readonly AskTarget[];
  onAsk: (seatId: string) => void;
  /** "Ask…": every seat (a menu anchored here). */
  onAskMore?: (anchor: HTMLElement) => void;
  variant: 'card' | 'bar';
  onDismiss?: () => void;
}

type LoadState = { kind: 'off' } | { kind: 'loading' } | { kind: 'done'; suggestions: VerseTerminalFixSuggestion[] } | { kind: 'failed' };

export function FixChips({ load, onPaste, askTargets, onAsk, onAskMore, variant, onDismiss }: FixChipsProps) {
  const [state, setState] = useState<LoadState>(load ? { kind: 'loading' } : { kind: 'off' });

  useEffect(() => {
    if (!load) {
      setState({ kind: 'off' });
      return undefined;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    load().then(
      (res) => { if (!cancelled) setState({ kind: 'done', suggestions: res.suggestions }); },
      () => { if (!cancelled) setState({ kind: 'failed' }); },
    );
    return () => { cancelled = true; };
  }, [load]);

  const suggestions = state.kind === 'done' ? state.suggestions : [];
  if (askTargets.length === 0 && !onAskMore && (state.kind === 'off' || state.kind === 'failed' || (state.kind === 'done' && suggestions.length === 0))) {
    return null;
  }

  const asks = (
    <>
      {askTargets.map((t) => (
        <button key={t.seatId} type="button" className={styles.chip} data-kind="ask" onClick={() => onAsk(t.seatId)}
          title={`Send this failed command and its output (secrets removed) to ${t.label}`}>
          Ask {t.label}
        </button>
      ))}
      {onAskMore ? (
        <button type="button" className={styles.chip} data-kind="ask" aria-haspopup="menu" onClick={(e) => onAskMore(e.currentTarget)}
          title="Ask another seat, or every ready seat side by side">
          Ask…
        </button>
      ) : null}
    </>
  );

  const chips = suggestions.map((s) => (
    <button key={s.command} type="button" className={styles.chip} onClick={() => onPaste(s.command)}
      title={`${s.why ? `${s.why} — ` : ''}Paste at the prompt (it does not run until you press Enter)`}
      aria-label={`Paste ${s.command}`}>
      <span className={styles.chipCode}>{s.command}</span>
      <span className={styles.chipVerb} aria-hidden="true">Paste</span>
    </button>
  ));

  if (variant === 'bar') {
    return (
      <div className={styles.bar} role="group" aria-label="Fix this error">
        <span className={styles.barLabel}>{state.kind === 'loading' ? 'Looking for a fix…' : suggestions.length > 0 ? 'Try:' : 'Fix it:'}</span>
        {chips}
        {asks}
        <span className={styles.barSpacer} />
        {onDismiss ? (
          <button type="button" className={styles.chip} aria-label="Dismiss fix suggestions" title="Dismiss" onClick={onDismiss}>
            <IconX size={10} />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.fixes} role="group" aria-label="Fix this error">
      {state.kind === 'loading' ? <span role="status">Looking for a fix with the local model…</span> : null}
      {suggestions.map((s, i) => (
        <div key={s.command} className={styles.fixRow}>
          {chips[i]}
          {s.why ? <span className={styles.fixWhy}>{s.why}</span> : null}
        </div>
      ))}
      {askTargets.length > 0 || onAskMore ? <div className={styles.fixRow}>{asks}</div> : null}
    </div>
  );
}
