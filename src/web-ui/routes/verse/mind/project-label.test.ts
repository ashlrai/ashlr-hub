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

  it('tells the documented scratchpad case apart, and gives two spellings of one folder one label', () => {
    // The file header's own example: two agents' …/<uuid>/scratchpad/grokpad
    // (their parents are both "scratchpad"), plus one temp folder recorded as
    // /tmp/… and /private/tmp/… — which pathKey treats as one folder.
    const a = '/private/tmp/claude-501/-Users-me-hub/9d28bdb1-aaaa/scratchpad/grokpad';
    const b = '/private/tmp/claude-501/-Users-me-hub/1234abcd-bbbb/scratchpad/grokpad';
    const labels = projectLabels([a, b, '/tmp/e2e/proj', '/private/tmp/e2e/proj']);
    // Before: 'grokpad (scratchpad)' twice and 'proj (e2e)' twice.
    expect(labels.get(a)!.label).toBe('grokpad (9d28bdb1-aaaa)');
    expect(labels.get(b)!.label).toBe('grokpad (1234abcd-bbbb)');
    expect(labels.get('/tmp/e2e/proj')).toEqual({ label: 'proj', full: '/tmp/e2e/proj', scratch: true });
    expect(labels.get('/private/tmp/e2e/proj')).toEqual({ label: 'proj', full: '/private/tmp/e2e/proj', scratch: true });
    // Real uuids: the nearest differing ancestor, shortened.
    const u1 = LIVE_SCRATCH;
    const u2 = LIVE_SCRATCH.replace('9d28bdb1-4c1e-4f7a-9d1b-0c7f00000000', '51aa0c3e-77d2-4b0e-8f11-000000000000');
    const live = projectLabels([u1, u2]);
    expect([live.get(u1)!.label, live.get(u2)!.label]).toEqual(['grokpad (9d28bdb1-4c1e…)', 'grokpad (51aa0c3e-77d2…)']);
  });

  it('never gives two different folders the same label — by construction', () => {
    const labelsOf = (repos: string[], names?: ReturnType<typeof projectNames>) => {
      const out = projectLabels(repos, names);
      const byFolder = new Map(repos.map((r) => [pathKey(r), out.get(r)!.label]));
      return [...byFolder.values()];
    };
    const unique = (labels: string[]) => expect(new Set(labels).size, labels.join(' | ')).toBe(labels.length);
    // Two ancestors that shorten alike: the whole segment tells them apart.
    const long = labelsOf(['/tmp/run-2026-09-24-alpha/scratchpad', '/tmp/run-2026-09-24-bravo/scratchpad']);
    expect(long).toEqual(['scratchpad (run-2026-09-24-alpha)', 'scratchpad (run-2026-09-24-bravo)']);
    // No segment unique at one depth: the nearest informative one, still unique.
    const grid = labelsOf(['/a/1/p', '/a/2/p', '/b/1/p']);
    unique(grid);
    expect(grid).toEqual(['p (1)', 'p (2)', 'p (b)']);
    // A folder whose own name already reads like a distinguished label: an ordinal settles it.
    const clash = labelsOf(['/t/abc/grokpad', '/t/def/grokpad', '/t/grokpad (abc)']);
    unique(clash);
    expect(clash).toEqual(['grokpad (abc)', 'grokpad (def)', 'grokpad (abc) #2']);
    // Registered names that coincide still come apart.
    const names = projectNames(null, [{ name: 'Hub', path: '/Users/me/dev/hub' }, { name: 'Hub', path: '/Users/me/work/hub' }]);
    const registered = labelsOf(['/Users/me/dev/hub', '/Users/me/work/hub'], names);
    unique(registered);
    expect(registered).toEqual(['Hub (dev)', 'Hub (work)']);
    // Stable whatever order the insights arrived in.
    expect(labelsOf(['/b/1/p', '/a/2/p', '/a/1/p']).sort()).toEqual([...grid].sort());
  });
});
