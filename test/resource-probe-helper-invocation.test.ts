/** Pure invocation-shape assertions: no process is spawned and no helper is imported. */
import { describe, expect, it } from 'vitest';
import {
  PROBE_HELPER_FLAGS,
  bundledIntoSingleFileBinary,
  probeHelperArgv,
  type ProbeHelperKind,
} from '../src/core/resources/probe-helper-invocation.js';

const KINDS: ProbeHelperKind[] = ['codex', 'grok'];

describe('account probe helper invocation', () => {
  it('names a closed set of operand-free internal flags', () => {
    expect(Object.keys(PROBE_HELPER_FLAGS).sort()).toEqual(['codex', 'grok']);
    expect(Object.isFrozen(PROBE_HELPER_FLAGS)).toBe(true);
    for (const kind of KINDS) {
      const flag = PROBE_HELPER_FLAGS[kind];
      // An operand-free flag cannot smuggle a path, module or command.
      expect(flag).toMatch(/^--_[a-z-]+$/);
      expect(flag).not.toContain('=');
    }
    expect(new Set(Object.values(PROBE_HELPER_FLAGS)).size).toBe(2);
  });

  it('detects a single-file bundle virtual root, and only that', () => {
    expect(bundledIntoSingleFileBinary('file:///$bunfs/root/_entry.js')).toBe(true);
    expect(bundledIntoSingleFileBinary('file:///$bunfs/root/ashlr')).toBe(true);
    expect(bundledIntoSingleFileBinary('file:///B:/~BUN/root/ashlr.exe')).toBe(true);
    expect(bundledIntoSingleFileBinary('file:///owned/dist/core/resources/codex-account-probe.js')).toBe(false);
    expect(bundledIntoSingleFileBinary('file:///owned/src/core/resources/codex-account-probe.ts')).toBe(false);
    // A real directory that merely looks similar is not the virtual root.
    expect(bundledIntoSingleFileBinary('file:///owned/bunfs/root/probe.js')).toBe(false);
    expect(bundledIntoSingleFileBinary('not a url')).toBe(false);
  });

  it('spawns the sibling helper file for an on-disk npm dist build', () => {
    for (const kind of KINDS) {
      expect(probeHelperArgv(kind, `file:///owned/dist/core/resources/${kind}-account-probe.js`)).toEqual([
        process.execPath, `/owned/dist/core/resources/${kind}-account-probe-process.js`,
      ]);
    }
  });

  it('re-enters this binary on the fixed flag when no sibling file exists', () => {
    for (const kind of KINDS) {
      // process.execPath is the real binary; import.meta.url is the virtual root.
      expect(probeHelperArgv(kind, 'file:///$bunfs/root/_entry.js')).toEqual([
        process.execPath, PROBE_HELPER_FLAGS[kind],
      ]);
    }
  });

  it('never derives an executable path from the bundled module URL', () => {
    for (const kind of KINDS) {
      const argv = probeHelperArgv(kind, 'file:///$bunfs/root/_entry.js');
      expect(argv).toHaveLength(2);
      expect(argv.some((arg) => arg.includes('$bunfs'))).toBe(false);
      expect(argv.some((arg) => arg.includes('--eval'))).toBe(false);
    }
  });

  it('registers tsx and imports the sibling source under the dev path', () => {
    for (const kind of KINDS) {
      const moduleUrl = new URL(`../src/core/resources/${kind}-account-probe.ts`, import.meta.url).href;
      const argv = probeHelperArgv(kind, moduleUrl);
      expect(argv[0]).toBe(process.execPath);
      expect(argv[1]).toBe('--input-type=module');
      expect(argv[2]).toBe('--eval');
      expect(argv[3]).toContain(`${kind}-account-probe-process.ts`);
      expect(argv[3]).toContain('register()');
      expect(argv[3]).not.toContain(PROBE_HELPER_FLAGS[kind]);
    }
  });

  it('keeps each kind bound to its own helper', () => {
    const bundled = 'file:///$bunfs/root/_entry.js';
    expect(probeHelperArgv('codex', bundled)[1]).not.toBe(probeHelperArgv('grok', bundled)[1]);
    expect(probeHelperArgv('codex', 'file:///owned/dist/x/codex-account-probe.js')[1])
      .toContain('codex-account-probe-process.js');
    expect(probeHelperArgv('grok', 'file:///owned/dist/x/grok-account-probe.js')[1])
      .toContain('grok-account-probe-process.js');
  });
});
