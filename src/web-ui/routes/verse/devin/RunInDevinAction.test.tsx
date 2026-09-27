/**
 * RunInDevinAction.test.tsx — "Run in Devin" (3.15): the palette offers it as
 * a chat command the composer answers, and the composer sheet reaches the
 * Devin module only through import() (never on the chat first-paint path).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCommand } from '../shell/command-catalog.js';
import { COMPOSER_COMMAND_IDS } from '../composer/composer-keys.js';

describe('Run in Devin', () => {
  it('is a ⌘K chat command beside "Run in cloud…", answered by the composer', () => {
    const c = findCommand('composer.devin')!;
    expect(c).toMatchObject({ title: 'Run in Devin…', scope: 'chat', group: 'actions', keys: [] });
    expect(c.keywords).toContain('devin');
    expect(COMPOSER_COMMAND_IDS).toContain('composer.devin');
  });

  it('reaches the Devin module only through import(), never a static import', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/composer/ControlsSheet.tsx'), 'utf8');
    expect(src).toContain(`import('../devin/RunInDevinAction.js')`);
    expect(src).not.toMatch(/^import\s+(?!type\s)[^;]*['"]\.\.\/devin\//m);
  });
});
