/**
 * data/theme-store.ts — the theme preference, extracted out of Topbar.tsx
 * so the command palette's "Toggle theme" action can read/write the same
 * source of truth Topbar's own button uses (same module-level state +
 * subscribe pattern as auth-store.ts — commands.ts's `run` closures have no
 * React context to call useState from, so this can't live in a component).
 */

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'ashlr.theme.v1';

function applyTheme(pref: ThemePreference): void {
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

let theme: ThemePreference = loadTheme();
applyTheme(theme);

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTheme(): ThemePreference {
  return theme;
}

export function setTheme(next: ThemePreference): void {
  theme = next;
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* best-effort persistence only */
  }
  emit();
}

export function cycleTheme(): void {
  setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');
}
