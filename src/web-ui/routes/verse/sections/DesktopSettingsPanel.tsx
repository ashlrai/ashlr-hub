/**
 * routes/verse/sections/DesktopSettingsPanel.tsx — Settings ▸ Desktop (unit
 * C1; SPEC-310C §1 "Native", C8 cross-unit request 3).
 *
 *   System-wide shortcut   ⌃⌥Space shows Verse and focuses the composer from
 *                          any app. OFF until turned on: a global hotkey takes
 *                          a chord away from every other app on the Mac.
 *   Notifications          "Finished", "Failed", "Needs you: N new" — only
 *                          while the window is not focused (C8 enforces that).
 *
 * THE DESKTOP APP IS THE SOURCE OF TRUTH. It stores both preferences
 * (desktop_prefs.rs, ~/.ashlr/desktop/prefs.json) and answers every change
 * with the state that actually took effect. So every switch renders from
 * `useDesktopState()` — never from what was asked for: a chord another app
 * already holds comes back `{ enabled: true, registered: false, error }`, and
 * the row says so instead of showing a shortcut that does nothing. While a
 * request is in flight the switch is busy, not optimistically flipped.
 *
 * In a browser there is no desktop app: the panel says so and offers no
 * switch (a disabled control would suggest a setting that exists here).
 */
import { useEffect, useRef, useState } from 'react';
import { Switch } from '../../../components/primitives/index.js';
import {
  isDesktopShell,
  setDesktopPreference,
  useDesktopState,
  type DesktopPreference,
  type DesktopState,
} from '../../../app/desktop-shell.js';
import { Panel, SettingRow } from './SettingRow.js';
import styles from './SettingsSection.module.css';

/** How long to wait for native's answer before saying it did not come. */
export const DESKTOP_ANSWER_TIMEOUT_MS = 4_000;

function hotkeyNote(state: DesktopState): string {
  const { enabled, registered, accelerator, error } = state.hotkey;
  if (!enabled) return `Off. Turning it on takes ${accelerator} away from every other app on this Mac.`;
  if (!registered) {
    // Native's own copy when it has one (it names the conflict); ours otherwise.
    const why = error ?? 'another app already uses it';
    return `${accelerator} is not active: ${why}. Free the shortcut in that app, or turn this off.`;
  }
  return `Press ${accelerator} in any app to bring Verse forward with the composer focused.`;
}

function notificationsNote(state: DesktopState): string {
  const base = state.notifications.enabled
    ? 'Finished and failed chats, and new items that need you — only while Verse is in the background.'
    : 'Off. The tray and the Dock badge still show what needs you.';
  // Unsigned local builds deliver through osascript (notify.rs): say so, or
  // the operator goes looking for "Ashlr" in Notification settings.
  if (state.notifications.delivery === 'script') {
    return `${base} On this unsigned build banners appear as Script Editor, and clicking one opens Script Editor rather than Verse.`;
  }
  return base;
}

export function DesktopSettingsPanel() {
  const state = useDesktopState();
  const [pending, setPending] = useState<DesktopPreference | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  // Any new state from native is the answer: stop waiting, and drop a stale
  // "did not answer" (the switches are current again).
  useEffect(() => {
    setPending(null);
    setFailure(null);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, [state]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  if (state === null) {
    return (
      <Panel title="Desktop">
        <p className={styles.panelNote} aria-busy={isDesktopShell() || undefined}>
          {isDesktopShell()
            ? 'Reading the desktop app’s settings…'
            : 'The system-wide shortcut and notifications are available in the Verse desktop app.'}
        </p>
      </Panel>
    );
  }

  function change(name: DesktopPreference, value: boolean) {
    setFailure(null);
    if (!setDesktopPreference(name, value)) {
      setFailure('The desktop app did not take the change. Nothing was changed.');
      return;
    }
    setPending(name);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setPending(null);
      setFailure('The desktop app did not answer. The switches show what it last reported.');
    }, DESKTOP_ANSWER_TIMEOUT_MS);
  }

  const hotkeyBroken = state.hotkey.enabled && !state.hotkey.registered;

  return (
    <Panel title="Desktop">
      <SettingRow
        label={`System-wide shortcut (${state.hotkey.accelerator})`}
        description={<span data-tone={hotkeyBroken ? 'warning' : undefined} role={hotkeyBroken ? 'status' : undefined}>{hotkeyNote(state)}</span>}
      >
        <Switch
          aria-label="System-wide shortcut"
          checked={state.hotkey.enabled}
          disabled={pending !== null}
          onChange={(next) => change('globalHotkey', next)}
        />
      </SettingRow>
      <SettingRow label="Notifications" description={notificationsNote(state)}>
        <Switch
          aria-label="Notifications"
          checked={state.notifications.enabled}
          disabled={pending !== null}
          onChange={(next) => change('notifications', next)}
        />
      </SettingRow>
      {pending ? <p className={styles.panelNote} role="status">Waiting for the desktop app…</p> : null}
      {failure ? <p className={styles.panelNote} role="alert">{failure}</p> : null}
    </Panel>
  );
}
