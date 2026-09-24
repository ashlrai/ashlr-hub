/**
 * The composer's colours in BOTH themes (SPEC-310C §7 test method "Dark":
 * token-probe contrast checks; unit C3). Resolves composer.module.css through
 * tokens.css the way a browser would and measures the pairs an operator
 * actually reads: menu text and reasons, the bypass state, the held queue,
 * attachment errors, the seat monogram. Also pins the colour ROLES: the
 * rings are quantity (the fixed azure ramp), never the accent.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../../design/contrast.js';
import {
  darkScope,
  lightScope,
  moduleColor,
  moduleDeclaration,
  resolveToken,
  type TokenScope,
} from '../../../design/token-probe.test-support.js';

const CSS = 'routes/verse/composer/composer.module.css';
const THEMES: Array<[string, TokenScope]> = [['light', lightScope()], ['dark', darkScope()]];

function ratio(scope: TokenScope, fg: string, bg: string): number {
  const backdrop = resolveToken(scope, '--bg-surface')!;
  const value = contrastRatio(fg, bg, backdrop);
  expect(value, `${fg} on ${bg}`).not.toBeNull();
  return value!;
}

describe.each(THEMES)('composer colours — %s', (_name, scope) => {
  const raised = resolveToken(scope, '--bg-surface-raised')!;

  it('menu labels and reasons read on the raised surface', () => {
    const label = resolveToken(scope, '--text-primary')!;
    const reason = moduleColor(scope, CSS, '.menuDesc', 'color')!;
    expect(ratio(scope, label, raised)).toBeGreaterThanOrEqual(4.5);
    // Secondary text: the reason under a disabled option (≥ 3:1, large-ish UI text rule used by tokens-contrast).
    expect(ratio(scope, reason, raised)).toBeGreaterThanOrEqual(3);
  });

  it('bypass is legible in red on its own tint', () => {
    const fg = moduleColor(scope, CSS, '.controlDanger', 'color')!;
    const bg = moduleColor(scope, CSS, '.controlDanger', 'background')!;
    expect(ratio(scope, fg, bg)).toBeGreaterThanOrEqual(4.5);
    const item = moduleColor(scope, CSS, '.menuItemDanger .menuLabel', 'color')!;
    expect(ratio(scope, item, raised)).toBeGreaterThanOrEqual(4.5);
  });

  it('the held-queue sentence and an attachment error read on their surfaces', () => {
    const held = moduleColor(scope, CSS, '.queueHeld .queueHeading', 'color')!;
    expect(ratio(scope, held, raised)).toBeGreaterThanOrEqual(4.5);
    const chipBg = resolveToken(scope, '--bg-surface')!;
    const error = moduleColor(scope, CSS, ".chip[data-status='error'] .chipMeta", 'color')!;
    expect(ratio(scope, error, chipBg)).toBeGreaterThanOrEqual(4.5);
    const queued = moduleColor(scope, CSS, '.queueText', 'color')!;
    expect(ratio(scope, queued, raised)).toBeGreaterThanOrEqual(4.5);
  });

  it('the seat monogram and the queue primary button read', () => {
    const mono = moduleColor(scope, CSS, '.monogram', 'color')!;
    const monoBg = moduleColor(scope, CSS, '.monogram', 'background')!;
    expect(ratio(scope, mono, monoBg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('colour roles', () => {
  it('rings are quantity (the azure ramp) and status only past a threshold — never the accent', () => {
    for (const selector of ['.ringFill', '.contextFill']) {
      const stroke = moduleDeclaration(CSS, selector, 'stroke')!;
      expect(stroke).toContain('--data-seq-');
      expect(stroke).not.toContain('--accent');
    }
    expect(moduleDeclaration(CSS, ".ring[data-tone='limit'] .ringFill", 'stroke')).toContain('--status-danger');
    expect(moduleDeclaration(CSS, ".contextRing[data-tone='warn'] .contextFill", 'stroke')).toContain('--status-warning');
  });
});
