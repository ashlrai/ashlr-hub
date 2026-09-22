/**
 * Fixed probe-helper entrypoints. Never an arbitrary entrypoint.
 *
 * The account probes run their NDJSON handshake in a child process, not a
 * Worker thread, so the helper has to be reachable as a real executable
 * invocation. Three shipping runtimes need three different invocations:
 *
 *   dev / tsx      → node --eval, tsx registered, importing the sibling .ts helper
 *   npm dist       → node <sibling .js helper, on disk next to the caller>
 *   Bun binary     → this same binary re-entered on a fixed, operand-free flag
 *
 * The Bun case exists because `bun build --compile` collapses every bundled
 * module's `import.meta.url` onto a virtual root (`file:///$bunfs/root/<binary>`)
 * that has no on-disk files. The sibling-path invocation the other two runtimes
 * use therefore resolves to `/$bunfs/root/<kind>-account-probe-process.js`, the
 * spawn fails, and the probe reports `probe-process-failed`. Worker threads
 * (read-projection, engineering) dodge this because Bun resolves `new Worker(url)`
 * inside the bundle; a child process cannot, so the helper is reached by
 * re-executing the binary instead of by path.
 *
 * Why this is not an arbitrary-entrypoint vector: the flags below are a closed,
 * compile-time set of two. They carry no operand — no path, no module specifier,
 * no command — and the CLI accepts one only as the entire argv, dispatching it
 * to one hard-coded import. Argv can therefore select which of two known,
 * package-owned helpers runs and nothing else. A helper reached that way with
 * no valid stdin payload validates nothing, spawns nothing and exits 1, so
 * influence over argv alone yields no execution, no file access and no output.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The complete set of helpers the binary will ever re-enter itself to run. */
export type ProbeHelperKind = 'codex' | 'grok';

/**
 * Internal re-entry flags. Operand-free and absent from command parsing, help
 * output and completions, so they are unreachable from normal CLI use.
 */
export const PROBE_HELPER_FLAGS: Readonly<Record<ProbeHelperKind, string>> = Object.freeze({
  codex: '--_codex-account-probe-helper',
  grok: '--_grok-account-probe-helper',
});

/**
 * True when `path` lies inside a single-file bundle's virtual root.
 *
 * Bun uses `/$bunfs/root` on POSIX and `B:\~BUN\root` on Windows. Nothing at
 * such a path exists on disk, so any code that resolves a sibling file or
 * compares against `process.execPath` gets a wrong answer inside a compiled
 * binary. Callers ask this instead of re-deriving the sentinel.
 */
export function insideSingleFileBinaryRoot(path: string): boolean {
  // Accepts both a URL pathname (always forward slashes, even on Windows) and a
  // raw `process.argv[1]` (native separators). Checking only `/~BUN/` missed the
  // backslash form that argv actually carries on Windows.
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith('/$bunfs/') || normalized.includes('/~BUN/');
}

/** True when `moduleUrl` names a module inside a single-file bundle's virtual root. */
export function bundledIntoSingleFileBinary(moduleUrl: string): boolean {
  let pathname: string;
  try { pathname = new URL(moduleUrl).pathname; } catch { return false; }
  return insideSingleFileBinaryRoot(pathname);
}

/**
 * Build the argv that runs `kind`'s probe helper for the current runtime.
 * `moduleUrl` is the calling probe module's own `import.meta.url`, which is what
 * distinguishes the tsx, on-disk and bundled cases.
 */
export function probeHelperArgv(kind: ProbeHelperKind, moduleUrl: string): string[] {
  if (moduleUrl.endsWith(`/${kind}-account-probe.ts`)) {
    const loader = pathToFileURL(createRequire(moduleUrl).resolve('tsx/esm/api')).href;
    const source = new URL(`./${kind}-account-probe-process.ts`, moduleUrl).href;
    return [process.execPath, '--input-type=module', '--eval',
      `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`];
  }
  // No sibling file exists inside the bundle. process.execPath is the real
  // on-disk binary; import.meta.url is not, which is the whole defect.
  if (bundledIntoSingleFileBinary(moduleUrl)) return [process.execPath, PROBE_HELPER_FLAGS[kind]];
  return [process.execPath, fileURLToPath(new URL(`./${kind}-account-probe-process.js`, moduleUrl))];
}
