/**
 * Workspace header title — where the optical pull-back is allowed to live.
 *
 * Regression, found by driving the real UI: the chat title rendered as
 * "New c…" at 1440px with 351px of empty header beside it. `.titleButton` is
 * inset by --space-2 so the hover chip reads as a target, and a matching
 * negative margin pulled the TEXT back to the header's padding edge. Putting
 * that margin on the button is what broke it — an h1 sizes to its child's
 * OUTER width, so the negative margin shrank the h1's max-content by --space-2,
 * and `.titleButton { max-width: 100% }` then re-clamped the button to that
 * smaller box. Every title lost exactly --space-2 of text to the ellipsis, at
 * every width. On the h1 the margin only shifts the item; the button keeps its
 * full content width and the text lands in the same place.
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
});
