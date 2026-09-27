/**
 * core/verse/folder-io.ts — touching an operator's project folders from a
 * server request without letting a macOS privacy prompt freeze the server.
 *
 * THE HAZARD. macOS guards ~/Desktop, ~/Documents, ~/Downloads, iCloud Drive
 * and removable/network volumes with TCC consent prompts. While a prompt is
 * up — every time the app's ad-hoc code identity changes, e.g. right after
 * `ship:local` swaps the binary — any access into the folder PARKS THE
 * CALLING THREAD until the operator answers. The Verse sidecar serves every
 * route from one thread, so a synchronous stat, readFile, realpath, execFileSync
 * or spawnSync there froze the whole app, static `/verse/` included (3.13.0
 * ship, 2026-09-26: ~3 minutes; see #518).
 *
 * THE RULES (enforced for the *-api.ts route files by
 * scripts/check-verse-sync-io.mjs, run in `npm run lint` and `npm run gate`):
 *
 *   1. Filesystem reads of project paths go through fs/promises. The wait
 *      lands on a libuv pool thread instead of the event loop.
 *   2. Those pool threads are few (UV_THREADPOOL_SIZE, default 4) and a stat
 *      behind a pending prompt holds one for as long as the prompt is up. So
 *      folder reads that fan out run through {@link withFolderIo}, which caps
 *      them at {@link FOLDER_IO_CONCURRENCY}: however many roots a response
 *      covers, a pending prompt can park at most that many pool threads, and
 *      DNS, other fs/promises work and zlib keep the rest.
 *   3. Subprocesses must not START in a project folder while its prompt may be
 *      pending: the spawn's chdir runs inside the parent's posix_spawn (or
 *      fork/exec handshake) call, i.e. ON THE EVENT LOOP. Prefer naming the
 *      folder as an argument (`git -C <dir>`) with a neutral cwd; where the
 *      child really must start there (a PTY shell, an agent CLI), await
 *      {@link probeFolderAccess} first so the prompt is answered off the loop.
 */
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';

/**
 * Most concurrent project-folder fs operations this process runs. Two leaves
 * half the default libuv pool free while a prompt is pending.
 */
export const FOLDER_IO_CONCURRENCY = 2;

let active = 0;
const waiting: Array<() => void> = [];

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}

/**
 * Run `work` (fs/promises calls into operator folders) under the process-wide
 * {@link FOLDER_IO_CONCURRENCY} cap. FIFO. The slot is released however
 * `work` settles; its result or rejection is passed through unchanged.
 */
export async function withFolderIo<T>(work: () => Promise<T>): Promise<T> {
  if (active < FOLDER_IO_CONCURRENCY) {
    active += 1;
  } else {
    // The releasing caller hands its slot straight to us (active unchanged).
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  try {
    return await work();
  } finally {
    release();
  }
}

/** Test seam: how many operations hold a slot / wait for one. */
export function folderIoLoad(): { active: number; waiting: number } {
  return { active, waiting: waiting.length };
}

/**
 * `work` over `items` with at most `limit` in flight, results in input order.
 * Rejections propagate (the first one rejects the whole map), as with
 * Promise.all; callers that must never throw pass a `work` that never rejects.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await work(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return out;
}

/** `ok` enterable; `missing` gone; `denied` refused (TCC "Don't Allow", EACCES…); `pending` no answer in time. */
export type FolderAccess = 'ok' | 'missing' | 'denied' | 'pending';

/** How long {@link probeFolderAccess} waits by default before answering `pending`. */
export const FOLDER_ACCESS_PROBE_MS = 2_000;

/**
 * Can this process enter `dir` right now? Answered OFF the event loop
 * (`fs.promises.access`, through {@link withFolderIo}), within `timeoutMs`.
 *
 * Call it before spawning a child whose cwd is an operator folder: `ok` means
 * any prompt for it has been answered, so the spawn's chdir will not stall
 * the loop; `pending` means a prompt (or a hung volume) is still holding the
 * check, and the caller should refuse rather than spawn. The underlying
 * access() keeps its pool slot until the OS answers; the caller is released
 * at the deadline. Never rejects.
 */
export async function probeFolderAccess(dir: string, timeoutMs = FOLDER_ACCESS_PROBE_MS): Promise<FolderAccess> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<FolderAccess>((resolve) => {
    timer = setTimeout(() => resolve('pending'), Math.max(0, timeoutMs));
    timer.unref?.();
  });
  const check = withFolderIo(() => access(dir, fsConstants.R_OK | fsConstants.X_OK)).then(
    (): FolderAccess => 'ok',
    (err: NodeJS.ErrnoException): FolderAccess => (err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'missing' : 'denied'),
  );
  try {
    return await Promise.race([check, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The one-line refusal a route gives when {@link probeFolderAccess} answers `pending`. */
export function folderAccessPendingMessage(dir: string): string {
  return `macOS has not granted access to ${dir} yet — answer the privacy prompt (or check System Settings › Privacy & Security › Files and Folders), then retry`;
}

/**
 * The first of `dirs` whose access is still `pending` after
 * {@link probeFolderAccess} (all probed at once), or null when every one has
 * been answered — entered, missing or refused. A route calls this before
 * handing folders to code that touches them synchronously or spawns a child
 * in one; `null` means that code can no longer be parked behind a prompt.
 */
export async function firstPendingFolder(dirs: readonly string[], timeoutMs = FOLDER_ACCESS_PROBE_MS): Promise<string | null> {
  const unique = [...new Set(dirs)];
  const answers = await Promise.all(unique.map((dir) => probeFolderAccess(dir, timeoutMs)));
  const index = answers.indexOf('pending');
  return index < 0 ? null : unique[index]!;
}

/** Every one of `dirs` whose access is still `pending` (all probed at once). */
export async function pendingFolders(dirs: readonly string[], timeoutMs = FOLDER_ACCESS_PROBE_MS): Promise<Set<string>> {
  const unique = [...new Set(dirs)];
  const answers = await Promise.all(unique.map((dir) => probeFolderAccess(dir, timeoutMs)));
  return new Set(unique.filter((_, index) => answers[index] === 'pending'));
}
