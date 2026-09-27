/**
 * No horizontal scroll at 375 px, and 44 pt touch targets — checked on the
 * stylesheets, because jsdom has no layout (the rendered 375 check lives in
 * MobileShell.test.tsx; the real-browser pass is in the PR notes).
 *
 * Every *.module.css under routes/verse/mobile/:
 *   - declares no width / min-width / flex-basis wider than 343 px (375 minus
 *     the 16 px gutters) in px, and no vw width over 100;
 *   - never opens a horizontal scroll container (overflow-x: auto | scroll);
 *   - `white-space: nowrap` only where the same rule clips (overflow: hidden +
 *     text-overflow) or the box is a fixed-size badge;
 *   - `pre` / code text wraps (white-space: pre-wrap) — never `pre`.
 * And the controls a thumb hits (.btn, .row, .tab, .chip, .input, .textarea,
 * .select, .composerInput) declare a 2.75rem (44 pt) minimum height.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd(), 'src/web-ui/routes/verse/mobile');

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...cssFiles(abs));
    else if (name.endsWith('.module.css')) out.push(abs);
  }
  return out;
}

interface Rule {
  file: string;
  selector: string;
  body: string;
}

function rules(file: string): Rule[] {
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  // Innermost blocks only: `selector { declarations }` with no nested brace.
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ file: relative(ROOT, file), selector: m[1]!.trim(), body: m[2]! });
  return out;
}

const ALL = cssFiles(ROOT).flatMap(rules);

describe('mobile stylesheets', () => {
  it('are found (guards the walk itself)', () => {
    expect(ALL.some((r) => r.file === 'ui.module.css')).toBe(true);
    expect(ALL.some((r) => r.file === 'MobileShell.module.css')).toBe(true);
  });

  it('size nothing wider than a 375 px screen', () => {
    const offenders: string[] = [];
    for (const r of ALL) {
      for (const m of r.body.matchAll(/(?:^|;|\s)(width|min-width|flex-basis)\s*:\s*([^;]+)/g)) {
        const value = m[2]!;
        for (const px of value.matchAll(/(\d+(?:\.\d+)?)px/g)) if (Number(px[1]) > 343) offenders.push(`${r.file} ${r.selector} ${m[1]}: ${value}`);
        for (const vw of value.matchAll(/(\d+(?:\.\d+)?)vw/g)) if (Number(vw[1]) > 100) offenders.push(`${r.file} ${r.selector} ${m[1]}: ${value}`);
        for (const rem of value.matchAll(/(\d+(?:\.\d+)?)(?:r?em)\b/g)) if (m[1] !== 'flex-basis' && Number(rem[1]) > 21.4) offenders.push(`${r.file} ${r.selector} ${m[1]}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never open a horizontal scroll container', () => {
    const offenders = ALL.filter((r) => /overflow(-x)?\s*:\s*(auto|scroll)\b/.test(r.body) && !/overflow-y/.test(r.body.match(/overflow[^;]*/)?.[0] ?? '')).map((r) => `${r.file} ${r.selector}`);
    expect(offenders).toEqual([]);
  });

  it('clip wherever text refuses to wrap', () => {
    const offenders = ALL.filter((r) => /white-space\s*:\s*nowrap/.test(r.body))
      .filter((r) => !(/overflow\s*:\s*hidden/.test(r.body) && /text-overflow/.test(r.body)))
      .filter((r) => !/\.(badge|tabBadge)\b/.test(r.selector))
      .map((r) => `${r.file} ${r.selector}`);
    expect(offenders).toEqual([]);
  });

  it('wrap preformatted text instead of scrolling it', () => {
    const offenders = ALL.filter((r) => /white-space\s*:\s*pre\s*;/.test(`${r.body};`)).map((r) => `${r.file} ${r.selector}`);
    expect(offenders).toEqual([]);
  });

  it('give every thumb target a 44 pt minimum', () => {
    const targets = ['.btn', '.row', '.tab', '.chip', '.input', '.composerInput'];
    for (const target of targets) {
      const decl = ALL.filter((r) => r.selector.split(',').some((s) => s.trim() === target || s.trim().startsWith(`${target}\n`)))
        .map((r) => r.body)
        .join(';');
      const min = /min-height\s*:\s*([\d.]+)rem/.exec(decl);
      expect(min, `${target} declares a min-height in rem`).not.toBeNull();
      expect(Number(min![1]), `${target} min-height`).toBeGreaterThanOrEqual(2.75);
    }
  });
});
