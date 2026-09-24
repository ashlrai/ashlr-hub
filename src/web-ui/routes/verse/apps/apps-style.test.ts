/**
 * apps-style.test.ts — Apps & Accounts in the dark (SPEC-310C §7 test method:
 * token-probe contrast plus the static scan). Every state word the page
 * prints must read at ≥ 4.5:1 on the card surface in BOTH themes, the engine
 * tile letter must stay ink (its contrast never depends on the hue), and no
 * file under apps/ may carry a raw hex colour or a px font size.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../../design/contrast.js';
import { scanStyleSource } from '../../../design/style-scan.test-support.js';
import { darkScope, lightScope, moduleColor, resolveToken } from '../../../design/token-probe.test-support.js';

const CSS = 'routes/verse/apps/Apps.module.css';
const THEMES = [['light', lightScope()], ['dark', darkScope()]] as const;

describe('Apps & Accounts colours', () => {
  it('keeps every text role readable on the card surface in both themes', () => {
    for (const [theme, scope] of THEMES) {
      const surface = resolveToken(scope, '--bg-surface')!;
      for (const selector of [
        '.rowName',
        '.rowDesc',
        '.health',
        ".health[data-tone='warning']",
        ".health[data-tone='danger']",
        ".health[data-tone='neutral']",
        '.caveat',
        '.error',
        '.tile',
      ]) {
        const fg = moduleColor(scope, CSS, selector, 'color');
        expect(fg, `${theme} ${selector}`).not.toBeNull();
        const ratio = contrastRatio(fg!, surface, surface)!;
        expect(ratio, `${theme} ${selector} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('the copy pill’s mono text reads on the code background', () => {
    for (const [theme, scope] of THEMES) {
      const code = resolveToken(scope, '--bg-code')!;
      const surface = resolveToken(scope, '--bg-surface')!;
      const fg = moduleColor(scope, CSS, '.pill', 'color')!;
      expect(contrastRatio(fg, code, surface)!, theme).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('never encodes data or state with the accent (it is the operator’s chosen hue)', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web-ui', CSS), 'utf8');
    const withoutRadio = source.replace(/\.radio input \{[^}]*\}/, '');
    expect(withoutRadio).not.toMatch(/--accent/);
  });

  it('no raw hex colour or px font size anywhere under apps/ or in the section', () => {
    const root = resolve(process.cwd(), 'src/web-ui/routes/verse/apps');
    const files = readdirSync(root).filter((f) => /\.(css|tsx?)$/.test(f) && !/\.test(-support)?\./.test(f));
    const violations = files.flatMap((f) => scanStyleSource(`routes/verse/apps/${f}`, readFileSync(join(root, f), 'utf8')));
    const section = 'routes/verse/sections/AppsSection.tsx';
    violations.push(...scanStyleSource(section, readFileSync(resolve(process.cwd(), 'src/web-ui', section), 'utf8')));
    expect(violations).toEqual([]);
  });
});
