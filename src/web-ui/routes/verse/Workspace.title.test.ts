/**
 * Workspace header — the layout contract the stylesheet has to keep.
 *
 * Read from the CSS rather than from a rendered page on purpose: jsdom has no
 * layout engine, so "the title truncates instead of pushing the buttons off
 * the strip" is not observable from the DOM. The DOM half of the same
 * contract — what the header says and what its controls are called — is in
 * Workspace.header.test.tsx.
 *
 * Regression #1, found by driving the real UI: the chat title rendered as
 * "New c…" at 1440px with 351px of empty header beside it. `.titleButton` is
 * inset by --space-2 so the hover chip reads as a target, and a matching
 * negative margin pulled the TEXT back to the header's padding edge. Putting
 * that margin on the button is what broke it — an h1 sizes to its child's
 * OUTER width, so the negative margin shrank the h1's max-content by --space-2,
 * and `.titleButton { max-width: 100% }` then re-clamped the button to that
 * smaller box. Every title lost exactly --space-2 of text to the ellipsis, at
 * every width. On the h1 the margin only shifts the item; the button keeps its
 * full content width and the text lands in the same place.
 *
 * Regression #2, the reason the strip was rebuilt: it was a --strip-height
 * band with one icon floated right. The lockup that now anchors its left end
 * is also the only item allowed to give up width, which is what keeps a long
 * title from displacing the actions.
 */
import { describe, expect, it } from 'vitest';
import { moduleDeclaration } from '../../design/token-probe.test-support.js';

const CSS = 'routes/verse/Workspace.module.css';
const PULL_BACK = 'calc(-1 * var(--space-2))';

describe('Workspace chat title', () => {
  it('carries the pull-back on the h1, not on the clamped button', () => {
    expect(moduleDeclaration(CSS, '.title', 'margin-left')).toBe(PULL_BACK);
    expect(moduleDeclaration(CSS, '.titleButton', 'margin-left')).toBeNull();
  });

  it('still clamps the button to its h1, which is what made the bug invisible', () => {
    // max-width:100% is correct — it is the reason the title truncates at all
    // when the header really is tight. It just must not be fighting a margin
    // that shrank the box it measures against.
    expect(moduleDeclaration(CSS, '.titleButton', 'max-width')).toBe('100%');
    expect(moduleDeclaration(CSS, '.titleButton', 'text-overflow')).toBe('ellipsis');
    expect(moduleDeclaration(CSS, '.title', 'min-width')).toBe('0');
  });

  it('gives the static title variant no pull-back to undo', () => {
    // .titleStatic is plain text — the loading skeleton and the no-chat state.
    // It is not inset by a button's padding, so a negative margin there would
    // simply hang it --space-2 into the gutter (and, in the desktop window,
    // under the traffic lights).
    expect(moduleDeclaration(CSS, '.titleStatic', 'margin-left')).toBeNull();
    expect(moduleDeclaration(CSS, '.titleStatic', 'text-overflow')).toBe('ellipsis');
  });
});

describe('Workspace header layout', () => {
  it('is one row that never wraps', () => {
    // The strip is exactly --strip-height, and the desktop shell's title-bar
    // maths is written against that. A wrapped second row breaks both.
    expect(moduleDeclaration(CSS, '.header', 'flex-wrap')).toBe('nowrap');
    expect(moduleDeclaration(CSS, '.header', 'height')).toBe('var(--strip-height)');
  });

  it('lets only the identity lockup give up width', () => {
    // This IS the truncation behaviour: the lockup shrinks and both its lines
    // ellipsise, so a long chat title or a deep project path can never push
    // the action cluster past the strip's right edge.
    expect(moduleDeclaration(CSS, '.identity', 'flex')).toBe('0 1 auto');
    expect(moduleDeclaration(CSS, '.identity', 'min-width')).toBe('0');
    expect(moduleDeclaration(CSS, '.identity', 'overflow')).toBe('hidden');
    expect(moduleDeclaration(CSS, '.eyebrow', 'text-overflow')).toBe('ellipsis');
    expect(moduleDeclaration(CSS, '.eyebrow', 'white-space')).toBe('nowrap');
  });

  it('never shrinks the action cluster', () => {
    expect(moduleDeclaration(CSS, '.actions', 'flex')).toBe('0 0 auto');
    expect(moduleDeclaration(CSS, '.toggles', 'flex-shrink')).toBe('0');
  });

  it('lets the seat pill degrade rather than overflow', () => {
    // Shrinkable too, but it has its own ellipsis on .seatText — so when the
    // lockup has given up what it can, the pill narrows instead of forcing
    // the strip wider than the pane.
    expect(moduleDeclaration(CSS, '.seatPill', 'flex')).toBe('0 1 auto');
    expect(moduleDeclaration(CSS, '.seatPill', 'min-width')).toBe('0');
    expect(moduleDeclaration(CSS, '.seatText', 'text-overflow')).toBe('ellipsis');
  });

  it('paints the strip from tokens only, so live accent + both themes follow', () => {
    // Hardcoded colour here is the one thing that would survive a theme
    // change and a custom accent looking wrong.
    for (const [selector, prop] of [
      ['.header', 'border-bottom'],
      ['.eyebrow', 'color'],
      ['.actionDivider', 'background'],
      ['.titleStatic', 'color'],
    ] as const) {
      const value = moduleDeclaration(CSS, selector, prop);
      expect(value, `${selector} { ${prop} }`).not.toBeNull();
      expect(value, `${selector} { ${prop} } must come from a token`).toMatch(/var\(--/);
    }
  });
});

describe('Workspace header — desktop shell clearance', () => {
  it('keeps the traffic-light inset, and pays back the title pull-back inside it', () => {
    // desktop/README.md "Desktop shell contract" §1: the macOS traffic lights
    // float over the top-LEFT 92px of the WINDOW. The strip starts at the rail's
    // right edge, so it owes the overlap only — and it owes --space-2 MORE than
    // it used to, because .title/.titleInput now sit that far left of the
    // padding edge to line up with the eyebrow above them. Without it the
    // rename button's hit area is under the lights again.
    const padding = moduleDeclaration(CSS, '.header', 'padding-left');
    expect(padding).not.toBeNull();
    expect(padding).toContain('--app-traffic-light-inset');
    expect(padding).toContain('--rail-width');
    expect(padding).toContain('+ var(--space-2)');
    // Both custom properties are absent in a browser, so the calc floors to a
    // negative number and max() has to be the thing that rescues it.
    expect(padding).toMatch(/^max\(/);
    expect(padding).toContain('var(--space-3)');
  });
});
