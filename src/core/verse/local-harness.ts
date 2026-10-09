/** Resolve the local Claude tool harness in the same host context as Apps. */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { buildToolPath } from '../run/tool-path.js';
import { resolveLoginPath } from './login-path.js';

export interface LocalHarness {
  executable: string | null;
  path: string;
}

export const LOCAL_HARNESS_UNAVAILABLE = 'Claude Code is required to run local tool sessions. Install it or refresh Apps & Accounts after updating your PATH.';

// PATH only: never retain or import a login shell's credentials/environment.
let discoveredPath: string | null = null;

export function localHarnessForPath(path: string, separator = delimiter): LocalHarness {
  for (const directory of path.split(separator)) {
    if (!isAbsolute(directory)) continue;
    try {
      const executable = realpathSync(join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude'));
      if (!statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
      return { executable, path };
    } catch { /* Try the next operator-owned PATH entry. */ }
  }
  return { executable: null, path };
}

/** Discovery shares the existing single-flight, bounded login PATH probe. */
export async function discoverLocalHarness(): Promise<LocalHarness> {
  const login = await resolveLoginPath();
  // The workbench's POSIX login probe serializes with ':'. Windows uses its
  // actual inherited PATH instead; never split drive letters as POSIX paths.
  discoveredPath = process.platform === 'win32'
    ? buildToolPath({ basePath: process.env.PATH ?? process.env.Path ?? '' })
    : login.entries.join(delimiter);
  return localHarnessForPath(discoveredPath);
}

/** Recheck the actual file before every launch, including historical chats. */
export function localHarnessInvocation(): LocalHarness {
  return localHarnessForPath(discoveredPath ?? buildToolPath({ basePath: process.env.PATH ?? process.env.Path ?? '' }));
}
