/** Private local files only; invalid-source cases must stop before any demo execution. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUniverseShowcase } from '../scripts/generate-universe-showcase.mjs';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(realpathSync(tmpdir()), 'universe-showcase-cli-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('showcase export custody', () => {
  it('refuses existing output before reading or executing the source', async () => {
    const output = join(directory, 'output.json'); writeFileSync(output, 'retained', { mode: 0o600 });
    const root = join(directory, 'new-root');
    await expect(generateUniverseShowcase(['--root', root, '--output', output])).rejects.toThrow('existing target');
    expect(readFileSync(output, 'utf8')).toBe('retained'); expect(existsSync(root)).toBe(false);
  });
  it('refuses an existing private store without changing its contents', async () => {
    const root = join(directory, 'existing'); mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, 'marker'), 'retained'); const output = join(directory, 'output.json');
    await expect(generateUniverseShowcase(['--root', root, '--output', output])).rejects.toThrow('existing target');
    expect(readFileSync(join(root, 'marker'), 'utf8')).toBe('retained'); expect(existsSync(output)).toBe(false);
  });
  it('refuses symlinked output instead of overwriting its target', async () => {
    const target = join(directory, 'target'); writeFileSync(target, 'retained');
    const output = join(directory, 'output.json'); symlinkSync(target, output);
    await expect(generateUniverseShowcase(['--input', join(directory, 'missing'), '--output', output])).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('retained');
  });
  it('rejects group-writable output custody', async () => {
    const parent = join(directory, 'shared'); mkdirSync(parent, { mode: 0o700 }); chmodSync(parent, 0o770);
    await expect(generateUniverseShowcase(['--root', join(directory, 'new'), '--output', join(parent, 'output')])).rejects.toThrow('physical private');
    expect(existsSync(join(directory, 'new'))).toBe(false);
  });
  it('never writes public output from invalid private evidence', async () => {
    const input = join(directory, 'private.json'); writeFileSync(input, JSON.stringify({ token: 'PRIVATE_VALUE' }));
    const output = join(directory, 'public.json');
    await expect(generateUniverseShowcase(['--input', input, '--output', output])).rejects.toThrow('invalid or incomplete');
    expect(existsSync(output)).toBe(false); expect(readFileSync(input, 'utf8')).toContain('PRIVATE_VALUE');
  });
});
