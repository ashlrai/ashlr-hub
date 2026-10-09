import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCompanions } from '../src/cli/companions.js';

const roots: string[] = [];
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phm-companions-cli-')));
  roots.push(root);
  return root;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function capture(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []; const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr.push(String(chunk)); return true; });
  return { stdout, stderr };
}

describe('phm companions first-run CLI', () => {
  it('prints help about MCP and credential boundaries without probing executables', async () => {
    const directory = fixture(); const marker = join(directory, 'executed');
    writeFileSync(join(directory, 'phantom'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'bad');`);
    chmodSync(join(directory, 'phantom'), 0o700);
    vi.stubEnv('PATH', directory);
    const output = capture();
    expect(await cmdCompanions(['--help'])).toBe(0);
    expect(output.stdout.join('')).toContain('No configuration, vault, provider, trust, MCP or service state');
    expect(output.stdout.join('')).toContain('Nothing is bundled');
    expect(existsSync(marker)).toBe(false);
  });

  it('returns a machine-readable missing inventory for a clean installation root', async () => {
    const root = fixture();
    const output = capture();
    expect(await cmdCompanions(['--root', root, '--json'])).toBe(0);
    const report = JSON.parse(output.stdout.join(''));
    expect(report.bundled).toBe(false);
    expect(report.companions.map((tool: { status: string }) => tool.status)).toEqual(['missing', 'missing', 'missing']);
    expect(output.stderr).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('supports installation paths with spaces and explicitly selected binary names', async () => {
    const root = fixture(); const directory = join(root, 'install with spaces', 'bin');
    mkdirSync(directory, { recursive: true });
    const binary = join(directory, 'selected-lexicon');
    writeFileSync(binary, `#!${process.execPath}\nconsole.log(process.argv[2]==='--version'?'0.5.4':'Usage: lexicon [OPTIONS] <COMMAND>');`);
    chmodSync(binary, 0o700);
    const output = capture();
    expect(await cmdCompanions(['--bin-dir', directory, '--lexicon-bin', binary, '--json'])).toBe(0);
    expect(JSON.parse(output.stdout.join('')).companions[2]).toMatchObject({ installed: true, path: binary, status: 'known-interface' });
  });

  it.each([['--unknown'], ['--root'], ['--root', 'relative'], ['--lexicon-bin', './lexicon'], ['install']])(
    'rejects invalid usage %j without discovery', async (...args: string[]) => {
      const output = capture();
      expect(await cmdCompanions(args)).toBe(2);
      expect(output.stdout).toEqual([]);
      expect(output.stderr.length).toBe(1);
    });

  it('describes separate installation and pinned release guidance in human output', async () => {
    const output = capture();
    expect(await cmdCompanions(['--bin-dir', fixture()])).toBe(0);
    const text = output.stdout.join('');
    expect(text).toContain('separately installed; bundled: no');
    expect(text).toContain('Phantom Secrets: missing');
    expect(text).toContain('/phantom-secrets/releases/tag/v0.7.9');
    expect(text).toContain('Locus: missing');
    expect(text).toContain('Lexicon: missing');
  });

  it('returns bad usage for an oversized discovery list before executing probes', async () => {
    const output = capture();
    const args = Array.from({ length: 257 }, () => ['--bin-dir', tmpdir()]).flat();
    expect(await cmdCompanions(args)).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr.join('')).toContain('256');
  });
});
