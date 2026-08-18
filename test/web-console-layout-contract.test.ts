import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function css(name: string): string {
  return readFileSync(new URL(`../src/web-ui/components/layout/${name}.module.css`, import.meta.url), 'utf8');
}

describe('operator-console narrow and reduced-motion contracts', () => {
  it('reflows the fixed desktop shell at a breakpoint that includes 320px', () => {
    const shell = css('Shell');
    const sidebar = css('Sidebar');
    const topbar = css('Topbar');
    expect(shell).toMatch(/@media \(max-width: 720px\)[\s\S]*flex-direction:\s*column/);
    expect(sidebar).toMatch(/@media \(max-width: 720px\)[\s\S]*width:\s*100%[\s\S]*height:\s*auto/);
    expect(sidebar).toMatch(/\.link\s*\{[^}]*min-height:\s*44px/);
    expect(topbar).toMatch(/@media \(max-width: 480px\)[\s\S]*min-width:\s*0[\s\S]*min-height:\s*44px/);
  });

  it('removes navigation and command-trigger transitions for reduced motion', () => {
    expect(css('Sidebar')).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*transition:\s*none/);
    expect(css('Topbar')).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*transition:\s*none/);
  });
});
