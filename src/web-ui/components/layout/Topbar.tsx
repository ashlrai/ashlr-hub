/**
 * components/layout/Topbar.tsx — ⌘K trigger, theme toggle, and the
 * mutation-hold indicator (shows whether actions are unlocked right now,
 * and lets the operator lock early rather than waiting for idle timeout).
 */
import { useEffect, useState } from 'react';
import { useMutationHold } from '../../data/hooks.js';
import styles from './Topbar.module.css';

type ThemePreference = 'system' | 'light' | 'dark';
const THEME_STORAGE_KEY = 'ashlr.theme.v1';

function applyTheme(pref: ThemePreference) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

function loadTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'system';
}

export function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const [theme, setTheme] = useState<ThemePreference>(loadTheme);
  const mutation = useMutationHold();

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* best-effort */
    }
  }, [theme]);

  function cycleTheme() {
    setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'));
  }

  return (
    <header className={styles.topbar}>
      <button type="button" className={styles.paletteTrigger} onClick={onOpenPalette}>
        <span>Search or run a command</span>
        <kbd className={styles.kbd}>⌘K</kbd>
      </button>
      <div className={styles.actions}>
        {mutation.hasHold ? (
          <button type="button" className={styles.lockBtn} onClick={mutation.clear} title="Lock actions now">
            🔓 Unlocked
          </button>
        ) : (
          <span className={styles.lockedIndicator} title="Actions require the dispatch token">
            🔒 Locked
          </span>
        )}
        <button type="button" className={styles.themeBtn} onClick={cycleTheme} aria-label={`Theme: ${theme}`}>
          {theme === 'system' ? '🖥️' : theme === 'light' ? '☀️' : '🌙'}
        </button>
      </div>
    </header>
  );
}
