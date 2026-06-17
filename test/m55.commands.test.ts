/**
 * M55 — Claude Code slash-command files for the conductor.
 *
 * Asserts .claude/commands/{goal,loop}.md exist with well-formed frontmatter and
 * reference the real CLI commands, so `/goal` and `/loop` work from inside Claude
 * Code.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cmdFile = (n: string) => resolve(HERE, `../.claude/commands/${n}`);

describe('M55 — slash-command files', () => {
  for (const [file, cli] of [
    ['goal.md', 'ashlr goal'],
    ['loop.md', 'ashlr loop'],
  ] as const) {
    it(`${file} exists with frontmatter and references \`${cli}\``, () => {
      const path = cmdFile(file);
      expect(existsSync(path), `${path} missing`).toBe(true);
      const src = readFileSync(path, 'utf8');
      expect(src.startsWith('---'), 'has YAML frontmatter').toBe(true);
      expect(src).toMatch(/description:/);
      expect(src).toMatch(/argument-hint:/);
      expect(src).toContain(cli);
      expect(src).toContain('$ARGUMENTS');
    });
  }
});
