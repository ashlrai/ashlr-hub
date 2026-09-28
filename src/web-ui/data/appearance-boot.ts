/** Apply stored appearance before React paints; full Settings logic loads later. */
const KEY = 'ashlr.verse.appearance.v1';
const choice = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  values.includes(value as T) ? value as T : fallback;
const channel = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

export function bootAppearance(): void {
  if (typeof document === 'undefined') return;
  let raw: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) raw = value as Record<string, unknown>;
  } catch { /* corrupt or unavailable storage uses defaults */ }
  const root = document.documentElement;
  const hue = typeof raw.accentH === 'number' && Number.isFinite(raw.accentH) ? Math.round(raw.accentH) : 245;
  root.style.setProperty('--accent-h', String(((hue % 360) + 360) % 360));
  root.style.setProperty('--accent-s', `${channel(raw.accentS, 72, 0, 100)}%`);
  root.style.setProperty('--accent-l', `${channel(raw.accentL, 58, 30, 78)}%`);
  const font = choice(raw.displayFont, ['grotesk', 'ui', 'mono'], 'grotesk');
  if (font === 'grotesk') root.style.removeProperty('--font-display');
  else root.style.setProperty('--font-display', font === 'mono' ? 'var(--font-mono)' : 'var(--font-ui)');
  root.setAttribute('data-density', choice(raw.density, ['comfortable', 'compact'], 'comfortable'));
  root.setAttribute('data-ui-scale', choice(raw.uiScale, ['default', 'large', 'xlarge'], 'default'));
  root.setAttribute('data-radius', choice(raw.radius, ['sharp', 'default', 'soft'], 'default'));
  const motion = choice(raw.motion, ['system', 'reduce', 'full'], 'system');
  if (motion === 'system') root.removeAttribute('data-motion');
  else root.setAttribute('data-motion', motion);
}

bootAppearance();
