/**
 * The Terminal pane's palette in BOTH themes (unit C4; SPEC-310C §7 "Dark:
 * token-probe contrast checks").
 *
 * The palette is custom properties on the pane, mapped onto design tokens
 * (TerminalPane.module.css) and resolved into xterm at runtime. This proves,
 * from the stylesheets alone, that:
 *   - every --term-* colour resolves to a real token colour in light AND dark;
 *   - the default text is readable (≥ 4.5:1) and every ANSI hue a program
 *     prints (red … bright cyan) clears 3:1 on the terminal background —
 *     xterm's minimumContrastRatio (3) would otherwise have to rescue it;
 *   - ANSI black stays dark and white stays light in both themes (the neutral
 *     ramp inverts, so dark mode re-points them);
 *   - the OS-preference dark block and the explicit-toggle dark block agree;
 *   - no colour resolves through the accent except the selection.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColor, relativeLuminance } from '../../../../design/contrast.js';
import { darkScope, lightScope, resolveToken, type TokenScope } from '../../../../design/token-probe.test-support.js';

const MODULE = resolve(process.cwd(), 'src/web-ui/routes/verse/dock/terminal/TerminalPane.module.css');
const css = readFileSync(MODULE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Custom properties declared in the first block whose selector matches exactly. */
function block(selector: string, within?: string): Map<string, string> {
  const src = within ? css.slice(css.indexOf(within)) : css;
  const start = src.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const body = src.slice(start + selector.length + 2, src.indexOf('}', start));
  const out = new Map<string, string>();
  for (const decl of body.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim();
    if (prop.startsWith('--term-')) out.set(prop, decl.slice(idx + 1).trim());
  }
  return out;
}

const base = block('.pane');
const toggleDark = block(":global(:root[data-theme='dark']) .pane");
const mediaDark = block(":global(:root:not([data-theme='light'])) .pane", '@media (prefers-color-scheme: dark)');

function themed(scope: TokenScope, overrides: Map<string, string>): TokenScope {
  const out = new Map(scope);
  for (const [k, v] of base) out.set(k, v);
  for (const [k, v] of overrides) out.set(k, v);
  return out;
}

const THEMES: Array<[string, TokenScope]> = [
  ['light', themed(lightScope(), new Map())],
  ['dark', themed(darkScope(), toggleDark)],
];

/*
 * The chromatic slots. Black and white are excluded ON PURPOSE: by
 * convention ANSI white is near the background in a light theme and black is
 * near it in a dark one (programs pair them with the opposite background);
 * their ordering is asserted instead.
 */
const ANSI_HUES = ['--term-red', '--term-green', '--term-yellow', '--term-blue', '--term-magenta', '--term-cyan', '--term-bright-red',
  '--term-bright-green', '--term-bright-yellow', '--term-bright-blue', '--term-bright-magenta', '--term-bright-cyan'];

describe('terminal palette', () => {
  it('declares a colour for every ANSI slot, cursor, selection and scrollbar', () => {
    for (const name of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
      expect(base.has(`--term-${name}`), name).toBe(true);
      expect(base.has(`--term-bright-${name}`), `bright ${name}`).toBe(true);
    }
    for (const prop of ['--term-bg', '--term-fg', '--term-cursor', '--term-selection', '--term-scrollbar']) expect(base.has(prop), prop).toBe(true);
  });

  it('the OS-preference and explicit-toggle dark blocks are identical', () => {
    expect([...mediaDark.entries()].sort()).toEqual([...toggleDark.entries()].sort());
  });

  it('only the selection uses the accent (the accent is interaction, never data)', () => {
    for (const [prop, value] of base) {
      if (prop === '--term-selection') continue;
      expect(value, prop).not.toContain('--accent');
    }
  });

  for (const [theme, scope] of THEMES) {
    describe(theme, () => {
      const bg = resolveToken(scope, '--term-bg')!;

      it('text is readable on the terminal background (≥ 4.5:1)', () => {
        expect(bg).not.toBeNull();
        expect(contrastRatio(resolveToken(scope, '--term-fg')!, bg)!).toBeGreaterThanOrEqual(4.5);
      });

      it('every ANSI hue clears 3:1 on the terminal background', () => {
        for (const prop of ANSI_HUES) {
          const value = resolveToken(scope, prop);
          expect(value, `${prop} resolves`).not.toBeNull();
          const ratio = contrastRatio(value!, bg)!;
          expect([prop, ratio >= 3 ? 'ok' : ratio.toFixed(2)]).toEqual([prop, 'ok']);
        }
      });

      it('ANSI black is darker than ANSI white', () => {
        const lum = (prop: string) => relativeLuminance(parseColor(resolveToken(scope, prop)!)!);
        expect(lum('--term-black')).toBeLessThan(lum('--term-white'));
        expect(lum('--term-bright-black')).toBeLessThan(lum('--term-bright-white'));
      });
    });
  }
});
