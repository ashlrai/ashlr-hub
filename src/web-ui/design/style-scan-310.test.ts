/**
 * design/style-scan-310.test.ts — NEW 3.10 UI files carry no raw hex colour
 * and no px font size (SPEC-310C §7 test method; unit C0). The scanner is
 * checked on synthetic sources first, so a pass on the real tree means
 * "clean", not "the matcher is broken".
 */
import { describe, expect, it } from 'vitest';
import { newUiFiles, scanNewUiFiles, scanStyleSource } from './style-scan.test-support.js';

describe('the style scanner', () => {
  it('flags hex colours in CSS and in TS/TSX — fallbacks included', () => {
    const css = scanStyleSource('a.module.css', '.x {\n  color: #fff;\n  background: var(--engine-codex, #10a37f);\n}\n');
    expect(css.map((v) => [v.line, v.kind, v.text])).toEqual([
      [2, 'hex-colour', '#fff'],
      [3, 'hex-colour', '#10a37f'],
    ]);
    const tsx = scanStyleSource('a.tsx', 'const c = "#0c6a92cc";\nexport const X = () => <rect fill="#abc" />;\n');
    expect(tsx.map((v) => v.text)).toEqual(['#0c6a92cc', '#abc']);
  });

  it('ignores comments, URL fragments, ids and non-colour hashes', () => {
    const tsx = scanStyleSource(
      'a.tsx',
      [
        '// the old #10a37f green',
        '/* measured #ffffff on #e5473a */',
        'const href = "#add-root";',
        'const anchor = `#section-${id}`;',
        'const issue = "fixes #1234567890";',
        'const url = "https://example.com/#fed1";',
      ].join('\n'),
    );
    expect(tsx).toEqual([]);
    expect(scanStyleSource('a.css', '/* #fff */ .x { color: var(--text-primary); }')).toEqual([]);
  });

  it('flags px font sizes — literal, in calc() and in the font shorthand — but not tokens', () => {
    const css = scanStyleSource(
      'a.css',
      [
        '.a { font-size: 10px; }',
        '.b { font-size: calc(11px * var(--ui-text-scale)); }',
        '.c { font: 600 12px/16px var(--font-ui); }',
        '.d { font-size: var(--text-2xs-size); line-height: 14px; }',
        '.e { font-weight: 600; width: 12px; }',
      ].join('\n'),
    );
    expect(css.map((v) => [v.line, v.kind])).toEqual([
      [1, 'px-font-size'],
      [2, 'px-font-size'],
      [3, 'px-font-size'],
    ]);
    const tsx = scanStyleSource(
      'a.tsx',
      [
        '<text fontSize={11}>a</text>',
        'const s = { fontSize: "12px" };',
        'const t = { fontSize: 13 };',
        '<text font-size="11">b</text>',
        'const ok = { fontSize: "var(--text-xs-size)" };',
      ].join('\n'),
    );
    expect(tsx.map((v) => v.line)).toEqual([1, 2, 3, 4]);
  });
});

describe('new 3.10 UI files', () => {
  it('finds the files it is responsible for (guards the path list itself)', () => {
    // C0's own shell contracts land with this test, so the list is never empty.
    expect(newUiFiles().some((f) => f.includes('/routes/verse/shell/'))).toBe(true);
  });

  it('carry no raw hex colour and no px font size — use design/tokens.css and chart-tokens.css', () => {
    expect(scanNewUiFiles()).toEqual([]);
  });
});
