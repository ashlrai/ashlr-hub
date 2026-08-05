import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('resident service release-truth documentation', () => {
  it.each(['README.md', 'docs/RELIABILITY.md', 'docs/WORKER.md', 'CHANGELOG.md'])(
    '%s states the temporary production restriction',
    (relativePath) => {
      const text = read(relativePath);

      expect(text).toMatch(/temporar(?:ily|y).*unavailable/is);
      expect(text).toMatch(/install.*reinstall.*repair.*restart/is);
      expect(text).toMatch(/status.*uninstall/is);
      expect(text).toMatch(/one-shot workflow/is);
    },
  );

  it('documents the installed-service update block and read-only check mode', () => {
    const reliability = read('docs/RELIABILITY.md');
    const changelog = read('CHANGELOG.md');

    expect(reliability).toContain('Both git and npm update channels');
    expect(reliability).toContain('no code was replaced');
    expect(reliability).toContain('ashlr update\n--check');
    expect(reliability).toContain('registration is proven `absent`');
    expect(reliability).toContain('Present, unknown, or running');
    expect(changelog).toContain('Both git and npm update channels block before code replacement');
  });

  it('keeps team onboarding and quickstart claims aligned with release authority', () => {
    const team = read('docs/TEAM.md');
    const quickstart = read('docs/QUICKSTART.md');

    expect(team).toContain('`ashlr setup`\nrefuses before reading or changing setup state');
    expect(team).toContain('`ashlr daemon start --once`');
    expect(team).not.toContain('installed during `ashlr setup`');
    expect(quickstart).toContain('Automatic merge is disabled by default');
    expect(quickstart).toContain('evidence, scope, provenance, and remote-PR gates');
    expect(quickstart).toContain('`ashlr setup` refuses before');
    expect(quickstart).not.toContain('Installs the daemon as an OS service');
    expect(quickstart).not.toContain('Proposals are never applied automatically');
  });
});
