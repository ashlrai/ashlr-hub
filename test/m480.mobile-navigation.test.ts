import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const styles = readFileSync(join(root, 'src/core/web/public/styles.css'), 'utf8');
const app = readFileSync(join(root, 'src/core/web/public/app.js'), 'utf8');

describe('M480 mobile navigation', () => {
  it('keeps the live shell in one stable row with a horizontally scrollable view rail', () => {
    expect(styles).toMatch(/\.topnav\s*\{[\s\S]*?display:\s*flex;[\s\S]*?height:\s*var\(--header-height\);/);
    expect(styles).toMatch(/\.nav-links\s*\{[\s\S]*?display:\s*flex;[\s\S]*?min-width:\s*0;[\s\S]*?overflow-x:\s*auto;[\s\S]*?overflow-y:\s*hidden;/);
    expect(styles).toMatch(/\.nav-link\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?white-space:\s*nowrap;/);
  });

  it('keeps brand and token authority controls outside the scrolling rail', () => {
    expect(app).toMatch(/el\('nav', \{ cls: 'topnav' \},[\s\S]*?cls: 'nav-brand'[\s\S]*?cls: 'nav-links'[\s\S]*?cls: 'nav-status'/);
    expect(styles).toMatch(/\.nav-brand,\s*\.nav-status\s*\{[\s\S]*?flex:\s*0 0 auto;/);
    expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.token-btn\s*\{[\s\S]*?min-width:\s*34px;/);
  });

  it('keeps the active destination visible and keyboard focus explicit', () => {
    expect(app).toContain("activeLink?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });");
    expect(styles).toMatch(/\.nav-link\.active\s*\{[\s\S]*?border-bottom-color:\s*var\(--accent\);/);
    expect(styles).toMatch(/\*:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--accent\);/);
  });

  it('gives the rendered main region the remaining viewport without sidebar offset', () => {
    expect(styles).toMatch(/body > \.main\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;[\s\S]*?margin-left:\s*0;[\s\S]*?overflow:\s*auto;/);
  });
});
