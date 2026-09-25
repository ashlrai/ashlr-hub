/**
 * dock/pane-chrome.test.ts — one header row for every dock pane with
 * controls (Terminal, Preview, Review). The row's box — height, padding,
 * hairline, surface — is declared once, in pane-chrome.module.css; a pane's
 * own stylesheet may lay out its parts but must not re-declare the box, or
 * two panes stacked in a split stop lining up (and the CSS order of two
 * equal-specificity rules decides which one wins).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VERSE = resolve(process.cwd(), 'src/web-ui/routes/verse');

function css(relative: string): string {
  return readFileSync(resolve(VERSE, relative), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The declarations of a TOP-LEVEL rule for exactly `selector`, or null when there is none. */
function rule(source: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? null;
}

const BOX = /(?:^|[\s;])(min-height|height|padding|border-bottom|background)\s*:/;

describe('the shared dock pane header', () => {
  it('declares one height from the density tokens, a hairline and the surface', () => {
    const header = rule(css('dock/pane-chrome.module.css'), '.header');
    expect(header).not.toBeNull();
    expect(header).toMatch(/min-height:\s*calc\(var\(--control-h-sm\)/);
    expect(header).toMatch(/border-bottom:\s*1px solid var\(--border-subtle\)/);
    expect(header).toMatch(/background:\s*var\(--bg-surface\)/);
    expect(rule(css('dock/pane-chrome.module.css'), '.actions')).toMatch(/margin-left:\s*auto/);
  });

  it.each([
    ['dock/terminal/TerminalPane.module.css', '.header'],
    ['dock/preview/PreviewPane.module.css', '.toolbar'],
    ['git/DiffPane.module.css', '.head'],
  ])('%s does not re-declare the box of %s', (file, selector) => {
    const own = rule(css(file), selector);
    if (own === null) return;
    expect(own).not.toMatch(BOX);
  });
});
