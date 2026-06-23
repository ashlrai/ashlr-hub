/**
 * Cross-platform test capability probes.
 *
 * Windows blocks symlink creation unless Developer Mode is enabled or the
 * process is elevated, surfacing as `EPERM: operation not permitted, symlink`.
 * Tests that exercise real symlink behaviour should skip gracefully there
 * (junctions are NOT a substitute — they don't report isSymbolicLink()=true).
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let _canSymlink: boolean | null = null;

/**
 * Probe (once) whether this process can create a symbolic link. Returns false
 * on Windows without symlink privilege (EPERM), true on macOS/Linux.
 */
export function canSymlink(): boolean {
  if (_canSymlink !== null) return _canSymlink;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'ashlr-symlink-probe-'));
    const target = join(dir, 'target');
    const link = join(dir, 'link');
    writeFileSync(target, 'probe');
    symlinkSync(target, link);
    _canSymlink = true;
  } catch {
    _canSymlink = false;
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  return _canSymlink;
}

/**
 * Run `fn` with `process.platform` temporarily overridden, then restore it.
 *
 * Lets a single test exercise win32 / darwin / linux code paths without
 * actually running on those OSes. The override is restored even if `fn`
 * throws. Supports both sync and async `fn` (the returned value is passed
 * through, so `await withPlatform('win32', async () => …)` works).
 */
export function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  let restored = false;
  const restore = () => {
    if (!restored) {
      Object.defineProperty(process, 'platform', orig);
      restored = true;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore) as unknown as T;
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}
