/**
 * routes/verse/shell/viewport.test-support.ts — put a jsdom test at a real
 * width (unit C0; SPEC-310C §7 "At 375px: C0's viewport test-support mocks
 * matchMedia to the compact layout").
 *
 * jsdom has no layout and no matchMedia, so a component asking "am I on a
 * phone?" gets undefined. This installs a matchMedia that evaluates the
 * width-based queries the app actually uses — (min-width / max-width: Npx),
 * joined with `and` — against a width the test chooses, and can move that
 * width mid-test (firing `change` on every list whose answer flipped, plus a
 * window `resize`), so a component's response to rotating a phone is
 * testable too.
 *
 *   const vp = mockCompactViewport();   // 375
 *   render(<Composer />);
 *   vp.setWidth(1440);                  // now wide
 *   vp.restore();                       // or rely on your afterEach
 */

export const COMPACT_WIDTH = 375;
export const MEDIUM_WIDTH = 768;
export const WIDE_WIDTH = 1440;

export interface ViewportMockOptions {
  /** Answer for `(prefers-color-scheme: dark)`. Default false. */
  dark?: boolean;
  /** Answer for `(prefers-reduced-motion: reduce)`. Default false. */
  reducedMotion?: boolean;
}

export interface ViewportMock {
  width(): number;
  /** Move to a new width: flipped lists fire `change`, the window fires `resize`. */
  setWidth(width: number): void;
  /** Put back whatever matchMedia / innerWidth were before. */
  restore(): void;
}

type Listener = (event: MediaQueryListEvent) => void;

/** Evaluate one media query against `width`; unknown features answer false. */
export function evaluateMediaQuery(query: string, width: number, options: ViewportMockOptions = {}): boolean {
  const clauses = query.toLowerCase().split(/\s+and\s+/).map((c) => c.trim()).filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => {
    const feature = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+?))?\s*\)$/.exec(clause);
    if (!feature) return clause === 'screen' || clause === 'all';
    const [, name, raw = ''] = feature;
    const px = Number.parseFloat(raw);
    switch (name) {
      case 'min-width':
        return raw.endsWith('px') && width >= px;
      case 'max-width':
        return raw.endsWith('px') && width <= px;
      case 'prefers-color-scheme':
        return raw.trim() === (options.dark ? 'dark' : 'light');
      case 'prefers-reduced-motion':
        return raw.trim() === (options.reducedMotion ? 'reduce' : 'no-preference');
      case 'hover':
        return raw.trim() === 'hover';
      case 'pointer':
        return raw.trim() === 'fine';
      default:
        return false;
    }
  });
}

/** Install a width-aware matchMedia on `window` at `width`. */
export function mockViewport(width: number, options: ViewportMockOptions = {}): ViewportMock {
  const previousMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  const previousInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  let current = width;
  const lists: Array<{ query: string; matches: boolean; listeners: Set<Listener>; list: MediaQueryList }> = [];

  const matchMedia = (query: string): MediaQueryList => {
    const listeners = new Set<Listener>();
    const entry = { query, matches: evaluateMediaQuery(query, current, options), listeners, list: null as unknown as MediaQueryList };
    const list = {
      get matches() {
        return entry.matches;
      },
      media: query,
      onchange: null as ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
    entry.list = list;
    lists.push(entry);
    return list;
  };

  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: matchMedia });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: current });

  return {
    width: () => current,
    setWidth(next: number) {
      current = next;
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: next });
      for (const entry of lists) {
        const matches = evaluateMediaQuery(entry.query, next, options);
        if (matches === entry.matches) continue;
        entry.matches = matches;
        const event = { matches, media: entry.query } as MediaQueryListEvent;
        for (const listener of [...entry.listeners]) listener(event);
        const onchange = (entry.list as { onchange: ((ev: MediaQueryListEvent) => unknown) | null }).onchange;
        if (typeof onchange === 'function') onchange.call(entry.list, event);
      }
      window.dispatchEvent(new Event('resize'));
    },
    restore() {
      if (previousMatchMedia) Object.defineProperty(window, 'matchMedia', previousMatchMedia);
      else delete (window as { matchMedia?: unknown }).matchMedia;
      if (previousInnerWidth) Object.defineProperty(window, 'innerWidth', previousInnerWidth);
    },
  };
}

/** The 375 layout every unit's compact test renders at. */
export function mockCompactViewport(options?: ViewportMockOptions): ViewportMock {
  return mockViewport(COMPACT_WIDTH, options);
}

/** The 1440 layout of the reference screenshots. */
export function mockWideViewport(options?: ViewportMockOptions): ViewportMock {
  return mockViewport(WIDE_WIDTH, options);
}
