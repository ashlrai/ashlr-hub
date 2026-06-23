/**
 * Global test setup: make `homedir()` follow `process.env.HOME` on EVERY
 * platform, for BOTH `import { homedir } from 'node:os'` and `os.homedir()`.
 *
 * The whole suite isolates the real `~/.ashlr` by relocating `process.env.HOME`
 * to a fresh tmp dir, relying on `homedir()` to follow `$HOME` (as it does on
 * macOS/Linux). On Windows `os.homedir()` ignores `$HOME` and reads
 * `%USERPROFILE%`, and `process.env` cannot be given an accessor to mirror the
 * two — so without this shim every "isolated" test silently resolves to the
 * developer's REAL home directory (and the H1 fixture's relocation guard throws,
 * aborting the test).
 *
 * We mock `node:os` so `homedir` reads `process.env.HOME` at call time (falling
 * back to the real implementation). This reaches every import style and honors
 * mid-test HOME relocation.
 */
import { vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => process.env['HOME'] || actual.homedir();
  return {
    ...actual,
    homedir,
    default: { ...actual.default, homedir },
  };
});
