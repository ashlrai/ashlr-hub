/**
 * Branch bar and Review pane colours, measured in BOTH themes (SPEC-310C §7
 * test method "Dark: token-probe contrast checks"; unit C5).
 *
 * Reads the declarations straight out of the CSS modules and resolves them
 * against each theme's tokens (design/token-probe.test-support.ts), so a
 * retuned mix or a swapped token fails here instead of shipping unreadable in
 * the theme nobody screenshotted.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../../design/contrast.js';
import { darkScope, lightScope, moduleColor, resolveToken, type TokenScope } from '../../../design/token-probe.test-support.js';

const PANE = 'routes/verse/git/DiffPane.module.css';
const BAR = 'routes/verse/git/BranchBar.module.css';
const CHIP = 'routes/verse/git/PrChip.module.css';

const THEMES: Array<[string, TokenScope]> = [
  ['light', lightScope()],
  ['dark', darkScope()],
];

function token(scope: TokenScope, name: string): string {
  const v = resolveToken(scope, name);
  expect(v, `${name} should resolve`).not.toBeNull();
  return v!;
}

function mod(scope: TokenScope, path: string, selector: string, prop: string): string {
  const v = moduleColor(scope, path, selector, prop);
  expect(v, `${path} ${selector} { ${prop} } should resolve`).not.toBeNull();
  return v!;
}

function ratio(fg: string, bg: string, backdrop: string): number {
  const r = contrastRatio(fg, bg, backdrop);
  expect(r).not.toBeNull();
  return r!;
}

describe.each(THEMES)('%s theme', (_name, scope) => {
  const code = () => token(scope, '--bg-code');
  const tints = ['--diff-add', '--diff-del', '--diff-add-em', '--diff-del-em'] as const;

  it.each(tints)('code text reads on %s (body floor)', (tint) => {
    const ground = mod(scope, PANE, '.pane', tint);
    expect(ratio(token(scope, '--text-primary'), ground, code())).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['--diff-add', '--diff-del'])('the +/− marker and line numbers read on %s', (tint) => {
    const ground = mod(scope, PANE, '.pane', tint);
    expect(ratio(mod(scope, PANE, '.marker', 'color'), ground, code())).toBeGreaterThanOrEqual(4.5);
    expect(ratio(mod(scope, PANE, '.no', 'color'), ground, code())).toBeGreaterThanOrEqual(4.5);
  });

  // Syntax colours are text too: they owe the body floor on every row tint.
  it.each(['.tok_comment', '.tok_string', '.tok_number', '.tok_keyword'])('%s reads on every row tint', (selector) => {
    const fg = mod(scope, PANE, selector, 'color');
    for (const tint of ['--diff-add', '--diff-del']) {
      expect(ratio(fg, mod(scope, PANE, '.pane', tint), code()), `${selector} on ${tint}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(fg, code(), code()), `${selector} on --bg-code`).toBeGreaterThanOrEqual(4.5);
  });

  it('line numbers read on the untinted code ground', () => {
    expect(ratio(mod(scope, PANE, '.no', 'color'), code(), code())).toBeGreaterThanOrEqual(4.5);
  });

  it('the ± counts read on the bar and on the pane', () => {
    for (const ground of ['--bg-surface', '--bg-canvas']) {
      const g = token(scope, ground);
      expect(ratio(mod(scope, BAR, '.add', 'color'), g, g), `bar + on ${ground}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(mod(scope, BAR, '.del', 'color'), g, g), `bar − on ${ground}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(mod(scope, PANE, '.add', 'color'), g, g), `pane + on ${ground}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(mod(scope, PANE, '.del', 'color'), g, g), `pane − on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the primary button label reads on the accent', () => {
    const bg = mod(scope, BAR, '.primary', 'background');
    expect(ratio(mod(scope, BAR, '.primary', 'color'), bg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('a disabled menu item’s reason is still readable', () => {
    const bg = mod(scope, BAR, '.menu', 'background');
    expect(ratio(mod(scope, BAR, '.menuReason', 'color'), bg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('PR chip words read on the chip', () => {
    const bg = mod(scope, CHIP, '.chip', 'background');
    expect(ratio(mod(scope, CHIP, '.chip', 'color'), bg, bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(mod(scope, CHIP, '.state', 'color'), bg, bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token(scope, '--status-success-fg'), bg, bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token(scope, '--status-danger-fg'), bg, bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token(scope, '--status-running-fg'), bg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('the truncation notice reads on its tint', () => {
    // The tint is translucent: it sits on the pane's canvas.
    const bg = mod(scope, PANE, '.truncated', 'background');
    expect(ratio(mod(scope, PANE, '.truncated', 'color'), bg, token(scope, '--bg-canvas'))).toBeGreaterThanOrEqual(4.5);
  });
});
