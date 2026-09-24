import { describe, expect, it } from 'vitest';
import { isScratchPath, pathKey, projectLabel, projectLabels, projectNames } from './project-label.js';

const LIVE_SCRATCH = '/private/tmp/claude-501/-Users-masonwyatt-Desktop/9d28bdb1-4c1e-4f7a-9d1b-0c7f00000000/scratchpad/grokpad';

describe('project labels for reasoning insights', () => {
  it('names a raw workspace path by its folder, keeps the full path, and tags a temp folder as scratch', () => {
    expect(projectLabel(LIVE_SCRATCH)).toEqual({ label: 'grokpad', full: LIVE_SCRATCH, scratch: true });
    expect(projectLabel('/Users/me/dev/binshield/')).toEqual({ label: 'binshield', full: '/Users/me/dev/binshield/', scratch: false });
    // A slug stays readable.
    expect(projectLabel('ashlr-hub')).toMatchObject({ label: 'ashlr-hub', scratch: false });
  });

  it('prefers the registered name — saved project first, then a known project — for the root or anything under it', () => {
    const names = projectNames(
      [{ name: 'Hub (saved)', roots: [{ path: '~/dev/ashlr-hub' }, { path: '/Users/me/dev/shared-lib' }] }],
      [{ name: 'ashlr-hub', path: '/Users/me/dev/ashlr-hub' }, { name: 'Binshield', path: '/Users/me/dev/binshield' }],
    );
    expect(projectLabel('/Users/me/dev/ashlr-hub', names).label).toBe('Hub (saved)');
    expect(projectLabel('/Users/me/dev/shared-lib/', names).label).toBe('Hub (saved)');
    expect(projectLabel('/Users/me/dev/binshield/packages/cli', names).label).toBe('Binshield');
    expect(projectLabel('/Users/me/dev/binshield-old', names).label).toBe('binshield-old');
  });

  it('knows the OS temp locations, with or without the macOS /private alias', () => {
    for (const p of [
      '/tmp/x',
      '/private/tmp/x',
      '/var/tmp/run-1',
      '/private/var/folders/zz/abc123/T/fixture',
      '/var/folders/zz/abc123/T',
      'C:\\Users\\me\\AppData\\Local\\Temp\\proj',
      'C:\\Windows\\Temp\\proj',
    ]) {
      expect(isScratchPath(p), p).toBe(true);
    }
    for (const p of ['/Users/me/tmp/proj', '/opt/tmpfiles', '/var/folders-backup/x', 'ashlr-hub']) expect(isScratchPath(p), p).toBe(false);
    expect(pathKey('/private/tmp/a/')).toBe('/tmp/a');
    expect(pathKey('/Users/me/dev/hub')).toBe('~/dev/hub');
  });

  it('disambiguates two different folders that would read the same', () => {
    const a = '/private/tmp/claude-501/sess-aaaa/scratchpad';
    const b = '/private/tmp/claude-501/sess-bbbb/scratchpad';
    const labels = projectLabels([a, b, '/Users/me/dev/binshield']);
    expect(labels.get(a)!.label).toBe('scratchpad (sess-aaaa)');
    expect(labels.get(b)!.label).toBe('scratchpad (sess-bbbb)');
    expect(labels.get('/Users/me/dev/binshield')!.label).toBe('binshield');
    // Two folders under one registered project read as that project plus their own name.
    const names = projectNames(null, [{ name: 'Hub', path: '/Users/me/dev/hub' }]);
    const nested = projectLabels(['/Users/me/dev/hub/a', '/Users/me/dev/hub/b'], names);
    expect([...nested.values()].map((l) => l.label)).toEqual(['Hub (a)', 'Hub (b)']);
  });
});
