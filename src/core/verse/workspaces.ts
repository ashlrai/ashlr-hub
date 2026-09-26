/**
 * core/verse/workspaces.ts — the workspace registry.
 *
 *   <root>/workspaces.json   0600, atomic temp + rename
 *
 * WHAT THIS FILE IS NOT: it is not `~/.ashlr/enrollment.json`, it never writes
 * that file, and nothing here can put a path into it. That separation is the
 * whole security design.
 *
 *   enrollment.json  — WHAT THE AUTONOMOUS LANE MAY MUTATE. `assertMayMutate`
 *                      reads it, exact-match per repo, and refuses anything
 *                      absent. Untouched by this feature.
 *   workspaces.json  — WHAT AN INTERACTIVE SESSION MAY REACH, plus ordering
 *                      and grouping hints for the autonomous lane.
 *
 * So a workspace can hand a chat five folders without any of them becoming
 * autonomously writable, and a "section" can rank repos the fleet already had
 * without adding one. `buildAutonomyScopeView` enforces that in code: it
 * INTERSECTS section membership with the enrollment registry and can only
 * ever return a subset of it.
 *
 * Every root is validated through `path-guard.ts` — the same forbidden roots
 * enrollment uses (`/`, `$HOME`, `~/.ashlr`, `~/.codex/artifacts`), checked
 * both lexically and physically so a symlink cannot smuggle one in.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  getGitStatus,
  getGitStatusAsync,
  isRepo,
  isRepoAsync,
  resolveGitHubOriginAuthority,
  resolveGitHubOriginAuthorityAsync,
} from '../git.js';
import { isEnrolled, isEnrolledAsync, readEnrollmentRegistry } from '../sandbox/policy.js';
import { mapLimited, withFolderIo } from './folder-io.js';
import { checkWorkspaceRootPath, checkWorkspaceRootPathAsync, isDirectoryPath, isDirectoryPathAsync } from './path-guard.js';
import {
  VERSE_DEFAULT_ROOT_PRIORITY,
  VERSE_MAX_WORKSPACE_ROOTS,
  VERSE_ROOT_PRIORITY_RANK,
  VERSE_ROOT_PRIORITIES,
  type VerseAutonomyScopeEntry,
  type VerseAutonomyScopeView,
  type VerseRootGit,
  type VerseRootPriority,
  type VerseRootStatus,
  type VerseWorkspace,
  type VerseWorkspaceRoot,
} from './types.js';

const WORKSPACES_FILE = 'workspaces.json';
const MAX_WORKSPACES = 64;
const MAX_NAME_CHARS = 120;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class VerseWorkspaceError extends Error {
  readonly code = 'VERSE_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'VerseWorkspaceError';
  }
}

// ---------------------------------------------------------------------------
// On-disk shape
// ---------------------------------------------------------------------------

interface WorkspaceRegistry {
  version: 1;
  workspaces: VerseWorkspace[];
  /** Per-repo rank keyed by canonical path. A missing key means `normal`. */
  priorities: Record<string, VerseRootPriority>;
  /** The section the autonomous lane is focused on; null means "all of them". */
  focusSectionId: string | null;
}

function emptyRegistry(): WorkspaceRegistry {
  return { version: 1, workspaces: [], priorities: {}, focusSectionId: null };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPriority(value: unknown): value is VerseRootPriority {
  return typeof value === 'string' && (VERSE_ROOT_PRIORITIES as readonly string[]).includes(value);
}

function parseRoot(value: unknown): VerseWorkspaceRoot | null {
  if (!isObject(value)) return null;
  const path = value['path'];
  if (typeof path !== 'string' || path.length === 0) return null;
  const name = typeof value['name'] === 'string' && value['name'].length > 0
    ? value['name']
    : basename(path) || path;
  return { path, name, primary: value['primary'] === true };
}

/**
 * Parse one stored workspace, repairing what can be repaired rather than
 * dropping the operator's record: a set that somehow lost its primary (hand
 * edit, an older writer) gets the first root promoted, because a workspace
 * with no cwd cannot start a session and silently vanishing is worse.
 */
function parseWorkspace(value: unknown): VerseWorkspace | null {
  if (!isObject(value)) return null;
  const id = value['id'];
  const name = value['name'];
  if (typeof id !== 'string' || !WORKSPACE_ID_RE.test(id)) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  const rawRoots = Array.isArray(value['roots']) ? value['roots'] : [];
  const roots: VerseWorkspaceRoot[] = [];
  for (const raw of rawRoots) {
    const root = parseRoot(raw);
    if (root && !roots.some((r) => r.path === root.path)) roots.push(root);
  }
  if (roots.length === 0) return null;
  const primaries = roots.filter((r) => r.primary);
  if (primaries.length !== 1) {
    for (const root of roots) root.primary = false;
    roots[0]!.primary = true;
  }
  // Primary first, so `roots[0]` is always the session's cwd.
  roots.sort((a, b) => Number(b.primary) - Number(a.primary));
  const at = typeof value['createdAt'] === 'string' ? value['createdAt'] : new Date(0).toISOString();
  return {
    id,
    name,
    roots: roots.slice(0, VERSE_MAX_WORKSPACE_ROOTS),
    section: value['section'] === true,
    createdAt: at,
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : at,
  };
}

function parseRegistry(raw: unknown): WorkspaceRegistry {
  if (!isObject(raw)) return emptyRegistry();
  const workspaces: VerseWorkspace[] = [];
  const rawWorkspaces = Array.isArray(raw['workspaces']) ? raw['workspaces'] : [];
  for (const entry of rawWorkspaces) {
    const parsed = parseWorkspace(entry);
    if (parsed && !workspaces.some((w) => w.id === parsed.id)) workspaces.push(parsed);
    if (workspaces.length >= MAX_WORKSPACES) break;
  }
  const priorities: Record<string, VerseRootPriority> = {};
  if (isObject(raw['priorities'])) {
    for (const [path, priority] of Object.entries(raw['priorities'])) {
      if (typeof path === 'string' && path.length > 0 && isPriority(priority)) {
        priorities[path] = priority;
      }
    }
  }
  const focus = raw['focusSectionId'];
  const focusSectionId = typeof focus === 'string' && workspaces.some((w) => w.id === focus && w.section)
    ? focus
    : null;
  return { version: 1, workspaces, priorities, focusSectionId };
}

// ---------------------------------------------------------------------------
// Private, atomic write (same recipe as session-store.ts)
// ---------------------------------------------------------------------------

function writeAtomically(target: string, content: string): void {
  const temp = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  let published = false;
  try {
    const bytes = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw new Error('workspace registry write made no progress');
      offset += written;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    renameSync(temp, target);
    published = true;
  } finally {
    closeSync(fd);
    if (!published) {
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

export interface ResolvedRoots {
  /** The session cwd, and the value `projectPath` carries. */
  primary: string;
  /** Everything else, deduped, in order, never containing the primary. */
  extra: string[];
}

/**
 * Validate and canonicalise a root list.
 *
 * The first entry is the primary. Every entry goes through the same deny-root
 * guard enrollment uses, is realpath'd, and is deduplicated AFTER resolution —
 * so two spellings of one directory (a symlink and its target) collapse to one
 * root rather than being granted twice.
 */
export function resolveWorkspaceRoots(
  roots: readonly string[],
  opts: { artifactsRoot?: string } = {},
): ResolvedRoots {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new VerseWorkspaceError('a workspace needs at least one root');
  }
  if (roots.length > VERSE_MAX_WORKSPACE_ROOTS) {
    throw new VerseWorkspaceError(`a workspace may have at most ${VERSE_MAX_WORKSPACE_ROOTS} roots`);
  }
  const resolved: string[] = [];
  for (const raw of roots) {
    const check = checkWorkspaceRootPath(raw, opts.artifactsRoot);
    if (!check.ok) throw new VerseWorkspaceError(check.error);
    if (!resolved.includes(check.path)) resolved.push(check.path);
  }
  const [primary, ...extra] = resolved;
  return { primary: primary!, extra };
}

/**
 * {@link resolveWorkspaceRoots} with the per-root filesystem checks off the
 * event loop (roots are operator folders; see folder-io.ts). Same validation,
 * same order, same first error, same answer.
 */
export async function resolveWorkspaceRootsAsync(
  roots: readonly string[],
  opts: { artifactsRoot?: string } = {},
): Promise<ResolvedRoots> {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new VerseWorkspaceError('a workspace needs at least one root');
  }
  if (roots.length > VERSE_MAX_WORKSPACE_ROOTS) {
    throw new VerseWorkspaceError(`a workspace may have at most ${VERSE_MAX_WORKSPACE_ROOTS} roots`);
  }
  const resolved: string[] = [];
  for (const raw of roots) {
    const check = await withFolderIo(() => checkWorkspaceRootPathAsync(raw, opts.artifactsRoot));
    if (!check.ok) throw new VerseWorkspaceError(check.error);
    if (!resolved.includes(check.path)) resolved.push(check.path);
  }
  const [primary, ...extra] = resolved;
  return { primary: primary!, extra };
}

// ---------------------------------------------------------------------------
// Per-root live facts
// ---------------------------------------------------------------------------

/**
 * Branch, dirty state and remote for one root.
 *
 * `remote` is the canonical `owner/repo` for a GitHub origin, NOT the raw
 * remote URL: an https remote can carry credentials in its userinfo, and this
 * value reaches an API response.
 */
export function rootGitIdentity(path: string): VerseRootGit | null {
  if (!isRepo(path)) return null;
  const status = getGitStatus(path);
  if (!status) return null;
  return {
    branch: status.branch,
    dirty: status.dirty,
    ahead: status.ahead,
    behind: status.behind,
    remote: resolveGitHubOriginAuthority(path),
  };
}

/**
 * Which engines can actually be granted a root beyond their cwd.
 *
 * VERIFIED against each CLI's own `--help` on the installed versions, not
 * from memory (see `adapters/claude.ts` and `adapters/codex.ts` for the exact
 * flags and how they were checked):
 *
 *   claude / local  `--add-dir <directories...>`  — yes
 *   codex           `--add-dir <DIR>` on `exec`, `sandbox_workspace_write.
 *                   writable_roots` on `exec resume` — yes
 *   grok            NOTHING. `grok --help` and `grok agent --help` expose
 *                   `--cwd` and a `--sandbox <PROFILE>` NAME, and no flag
 *                   that adds a directory. So a Grok seat gets the primary
 *                   root and nothing else, and we say so instead of inventing
 *                   a flag that would fail the turn before inference.
 */
export function engineSupportsExtraRoots(engine: string): boolean {
  return engine === 'claude' || engine === 'local' || engine === 'codex';
}

export interface RootStatusOptions {
  /** Engine the roots will be handed to; decides `reachable`. */
  engine?: string;
}

/** Project one root list into the status rows a client renders. */
export function describeRoots(
  roots: readonly string[],
  opts: RootStatusOptions = {},
): VerseRootStatus[] {
  const multiRoot = opts.engine === undefined || engineSupportsExtraRoots(opts.engine);
  return roots.map((path, index) => {
    const primary = index === 0;
    return {
      path,
      name: basename(path) || path,
      primary,
      exists: isDirectoryPath(path),
      // READ, never written by anything in this module.
      enrolled: safeIsEnrolled(path),
      git: rootGitIdentity(path),
      reachable: primary || multiRoot,
    };
  });
}

function safeIsEnrolled(path: string): boolean {
  try {
    return isEnrolled(path);
  } catch {
    // A degraded registry is not evidence of enrollment. Fail closed.
    return false;
  }
}

/** {@link rootGitIdentity} without blocking the event loop (git.ts `*Async`). Never rejects. */
export async function rootGitIdentityAsync(path: string): Promise<VerseRootGit | null> {
  if (!(await withFolderIo(() => isRepoAsync(path)))) return null;
  // Independent reads: the status chain and the origin chain run together.
  const [status, remote] = await Promise.all([getGitStatusAsync(path), resolveGitHubOriginAuthorityAsync(path)]);
  if (!status) return null;
  return {
    branch: status.branch,
    dirty: status.dirty,
    ahead: status.ahead,
    behind: status.behind,
    remote,
  };
}

/** Roots whose facts are gathered at once; each runs up to three git processes. */
export const DESCRIBE_ROOTS_CONCURRENCY = 4;

/** Test seams for {@link describeRootsAsync}; production passes none. */
export interface DescribeRootsDeps {
  isDirectory?: (path: string) => Promise<boolean>;
  isEnrolled?: (path: string) => Promise<boolean>;
  gitIdentity?: (path: string) => Promise<VerseRootGit | null>;
}

/**
 * {@link describeRoots} for the HTTP routes (GET /api/verse/workspaces,
 * GET /api/verse/sessions/:id/roots): the same rows in the same order, but
 * every stat, realpath and git call runs off the event loop, so a root behind
 * a pending macOS privacy prompt holds this response rather than the server.
 *
 * Roots are described {@link DESCRIBE_ROOTS_CONCURRENCY} at a time, and a
 * path listed more than once (in `roots`, or across calls sharing `memo`) is
 * examined once. Never rejects.
 */
export async function describeRootsAsync(
  roots: readonly string[],
  opts: RootStatusOptions & { memo?: Map<string, Promise<RootFacts>> } = {},
  deps: DescribeRootsDeps = {},
): Promise<VerseRootStatus[]> {
  const multiRoot = opts.engine === undefined || engineSupportsExtraRoots(opts.engine);
  const memo = opts.memo ?? new Map<string, Promise<RootFacts>>();
  const facts = await mapLimited(roots, DESCRIBE_ROOTS_CONCURRENCY, (path) => {
    let pending = memo.get(path);
    if (!pending) {
      pending = rootFacts(path, deps);
      memo.set(path, pending);
    }
    return pending;
  });
  return roots.map((path, index) => {
    const primary = index === 0;
    const fact = facts[index]!;
    return {
      path,
      name: basename(path) || path,
      primary,
      exists: fact.exists,
      enrolled: fact.enrolled,
      git: fact.git,
      reachable: primary || multiRoot,
    };
  });
}

/** The engine-independent facts of one root. */
export interface RootFacts {
  exists: boolean;
  enrolled: boolean;
  git: VerseRootGit | null;
}

async function rootFacts(path: string, deps: DescribeRootsDeps): Promise<RootFacts> {
  const isDirectory = deps.isDirectory ?? ((p: string) => withFolderIo(() => isDirectoryPathAsync(p)));
  const enrolled = deps.isEnrolled ?? ((p: string) => withFolderIo(() => isEnrolledAsync(p)));
  const gitIdentity = deps.gitIdentity ?? rootGitIdentityAsync;
  const [exists, isEnrolledRoot, git] = await Promise.all([
    isDirectory(path).catch(() => false),
    // A degraded registry is not evidence of enrollment. Fail closed.
    enrolled(path).catch(() => false),
    gitIdentity(path).catch(() => null),
  ]);
  return { exists, enrolled: isEnrolledRoot, git };
}

/**
 * The plain-language facts a client must show rather than imply: roots the
 * engine cannot reach, and roots the autonomous lane will refuse.
 */
export function rootNotes(statuses: readonly VerseRootStatus[], engine?: string): string[] {
  const notes: string[] = [];
  const unreachable = statuses.filter((r) => !r.reachable);
  if (unreachable.length > 0) {
    notes.push(
      `${engine === 'grok' ? 'The Grok CLI' : 'This engine'} takes no additional-directory flag, so ` +
      `${unreachable.map((r) => r.name).join(', ')} ${unreachable.length === 1 ? 'is' : 'are'} ` +
      'not reachable from this chat — only the primary root is.',
    );
  }
  const unenrolled = statuses.filter((r) => !r.enrolled);
  if (unenrolled.length > 0) {
    notes.push(
      `Not enrolled: ${unenrolled.map((r) => r.name).join(', ')}. ` +
      'This chat can still edit them; the autonomous lane refuses them until each is enrolled on its own.',
    );
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface VerseWorkspaceStore {
  readonly path: string;
  list(): VerseWorkspace[];
  get(id: string): VerseWorkspace | null;
  create(name: string, roots: readonly string[], section?: boolean): VerseWorkspace;
  update(id: string, patch: { name?: string; roots?: readonly string[]; section?: boolean }): VerseWorkspace;
  /**
   * `create`/`update`/`setPriority` for the HTTP routes: the roots (operator
   * folders) are validated off the event loop FIRST, then the registry is
   * read, changed and written in one synchronous step as before (it lives
   * under ~/.ashlr, never in a guarded folder), so concurrent requests cannot
   * interleave a read and a write. Same results and errors.
   */
  createAsync(name: string, roots: readonly string[], section?: boolean): Promise<VerseWorkspace>;
  updateAsync(id: string, patch: { name?: string; roots?: readonly string[]; section?: boolean }): Promise<VerseWorkspace>;
  setPriorityAsync(path: string, priority: VerseRootPriority): Promise<Record<string, VerseRootPriority>>;
  remove(id: string): boolean;
  priorities(): Record<string, VerseRootPriority>;
  setPriority(path: string, priority: VerseRootPriority): Record<string, VerseRootPriority>;
  focusSectionId(): string | null;
  setFocusSection(id: string | null): string | null;
}

type GuardedCheck = ReturnType<typeof checkWorkspaceRootPath>;

export interface VerseWorkspaceStoreOptions {
  /** Store root. Default `~/.ashlr/verse`. */
  root?: string;
  now?: () => Date;
  /** Override the codex artifacts deny-root (tests). */
  artifactsRoot?: string;
}

export function createVerseWorkspaceStore(opts: VerseWorkspaceStoreOptions = {}): VerseWorkspaceStore {
  const root = opts.root ?? join(homedir(), '.ashlr', 'verse');
  const now = opts.now ?? (() => new Date());
  const file = join(root, WORKSPACES_FILE);
  const rootOpts = opts.artifactsRoot === undefined ? {} : { artifactsRoot: opts.artifactsRoot };

  function read(): WorkspaceRegistry {
    try {
      if (!existsSync(file)) return emptyRegistry();
      const raw = readFileSync(file, 'utf8');
      if (raw.length > MAX_REGISTRY_BYTES) return emptyRegistry();
      return parseRegistry(JSON.parse(raw) as unknown);
    } catch {
      // A corrupt registry reads as "no workspaces", never as an error that
      // would take the whole Verse surface down with it.
      return emptyRegistry();
    }
  }

  function write(registry: WorkspaceRegistry): void {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeAtomically(file, `${JSON.stringify(registry, null, 2)}\n`);
  }

  function checkName(raw: unknown): string {
    if (typeof raw !== 'string') throw new VerseWorkspaceError('name is required');
    const name = raw.replace(/\s+/g, ' ').trim();
    if (name.length === 0) throw new VerseWorkspaceError('name is required');
    if (name.length > MAX_NAME_CHARS) {
      throw new VerseWorkspaceError(`name must be at most ${MAX_NAME_CHARS} characters`);
    }
    return name;
  }

  function toRoots(paths: ResolvedRoots): VerseWorkspaceRoot[] {
    return [paths.primary, ...paths.extra].map((path, index) => ({
      path,
      name: basename(path) || path,
      primary: index === 0,
    }));
  }

  // `roots` is a thunk so the sync and async entry points share one body: the
  // sync one resolves inline (after the count and name checks, as it always
  // did); the async one hands in roots it already resolved off the loop.
  function createWith(name: string, roots: () => ResolvedRoots, section: boolean): VerseWorkspace {
    const registry = read();
    if (registry.workspaces.length >= MAX_WORKSPACES) {
      throw new VerseWorkspaceError(`at most ${MAX_WORKSPACES} workspaces`);
    }
    const at = now().toISOString();
    const workspace: VerseWorkspace = {
      id: randomUUID(),
      name: checkName(name),
      roots: toRoots(roots()),
      section: section === true,
      createdAt: at,
      updatedAt: at,
    };
    registry.workspaces.push(workspace);
    write(registry);
    return workspace;
  }

  function updateWith(
    id: string,
    patch: { name?: string; roots?: readonly string[]; section?: boolean },
    roots: (() => ResolvedRoots) | undefined,
  ): VerseWorkspace {
    const registry = read();
    const index = registry.workspaces.findIndex((w) => w.id === id);
    if (index < 0) throw new VerseWorkspaceError(`workspace not found: ${String(id)}`);
    const current = registry.workspaces[index]!;
    const next: VerseWorkspace = {
      ...current,
      ...(patch.name === undefined ? {} : { name: checkName(patch.name) }),
      ...(roots === undefined ? {} : { roots: toRoots(roots()) }),
      ...(patch.section === undefined ? {} : { section: patch.section === true }),
      updatedAt: now().toISOString(),
    };
    registry.workspaces[index] = next;
    // A section that stops being one cannot stay the focus.
    if (!next.section && registry.focusSectionId === next.id) registry.focusSectionId = null;
    write(registry);
    return next;
  }

  function setPriorityWith(check: GuardedCheck, priority: VerseRootPriority): Record<string, VerseRootPriority> {
    if (!check.ok) throw new VerseWorkspaceError(check.error);
    const registry = read();
    if (priority === VERSE_DEFAULT_ROOT_PRIORITY) delete registry.priorities[check.path];
    else registry.priorities[check.path] = priority;
    write(registry);
    return registry.priorities;
  }

  function assertPriority(priority: VerseRootPriority): void {
    if (!isPriority(priority)) {
      throw new VerseWorkspaceError(`priority must be one of ${VERSE_ROOT_PRIORITIES.join(', ')}`);
    }
  }

  return {
    path: file,

    list(): VerseWorkspace[] {
      return read().workspaces;
    },

    get(id: string): VerseWorkspace | null {
      if (typeof id !== 'string') return null;
      return read().workspaces.find((w) => w.id === id) ?? null;
    },

    create(name: string, roots: readonly string[], section = false): VerseWorkspace {
      return createWith(name, () => resolveWorkspaceRoots(roots, rootOpts), section);
    },

    async createAsync(name: string, roots: readonly string[], section = false): Promise<VerseWorkspace> {
      // The cheap refusals first, in the order `create` reports them, so a
      // request that would fail on them never touches a folder at all.
      if (read().workspaces.length >= MAX_WORKSPACES) {
        throw new VerseWorkspaceError(`at most ${MAX_WORKSPACES} workspaces`);
      }
      checkName(name);
      const resolved = await resolveWorkspaceRootsAsync(roots, rootOpts);
      return createWith(name, () => resolved, section);
    },

    update(id, patch): VerseWorkspace {
      return updateWith(
        id,
        patch,
        patch.roots === undefined ? undefined : () => resolveWorkspaceRoots(patch.roots!, rootOpts),
      );
    },

    async updateAsync(id, patch): Promise<VerseWorkspace> {
      if (patch.roots === undefined) return updateWith(id, patch, undefined);
      // `update` reports an unknown id (then a bad name) before a bad root.
      if (!read().workspaces.some((w) => w.id === id)) {
        throw new VerseWorkspaceError(`workspace not found: ${String(id)}`);
      }
      if (patch.name !== undefined) checkName(patch.name);
      const resolved = await resolveWorkspaceRootsAsync(patch.roots, rootOpts);
      return updateWith(id, patch, () => resolved);
    },

    remove(id: string): boolean {
      const registry = read();
      const before = registry.workspaces.length;
      registry.workspaces = registry.workspaces.filter((w) => w.id !== id);
      if (registry.workspaces.length === before) return false;
      if (registry.focusSectionId === id) registry.focusSectionId = null;
      write(registry);
      return true;
    },

    priorities(): Record<string, VerseRootPriority> {
      return read().priorities;
    },

    setPriority(path: string, priority: VerseRootPriority): Record<string, VerseRootPriority> {
      assertPriority(priority);
      // A priority is an ordering hint over a path, so the path only has to be
      // a legal, canonical path — NOT enrolled, and NOT existing. Ranking a
      // repo does not reach it, and enrolling it later must find the rank
      // already there rather than silently dropped.
      return setPriorityWith(checkWorkspaceRootPath(path, opts.artifactsRoot), priority);
    },

    async setPriorityAsync(path: string, priority: VerseRootPriority): Promise<Record<string, VerseRootPriority>> {
      assertPriority(priority);
      const check = await withFolderIo(() => checkWorkspaceRootPathAsync(path, opts.artifactsRoot));
      return setPriorityWith(check, priority);
    },

    focusSectionId(): string | null {
      return read().focusSectionId;
    },

    setFocusSection(id: string | null): string | null {
      const registry = read();
      if (id === null) {
        registry.focusSectionId = null;
      } else {
        const target = registry.workspaces.find((w) => w.id === id);
        if (!target) throw new VerseWorkspaceError(`workspace not found: ${String(id)}`);
        if (!target.section) {
          throw new VerseWorkspaceError(`workspace ${target.name} is not a section`);
        }
        registry.focusSectionId = id;
      }
      write(registry);
      return registry.focusSectionId;
    },
  };
}

// ---------------------------------------------------------------------------
// Autonomy scope view — ordering over what enrollment already permits
// ---------------------------------------------------------------------------

export interface AutonomyScopeInputs {
  workspaces: readonly VerseWorkspace[];
  priorities: Readonly<Record<string, VerseRootPriority>>;
  focusSectionId: string | null;
  /** Enrolled repos. Injected so this function is pure and testable. */
  enrolledRepos: readonly string[];
}

/**
 * Rank the autonomous lane's scope.
 *
 * THE INVARIANT, AND THE REASON THIS FUNCTION EXISTS RATHER THAN A FIELD ON
 * THE WORKSPACE: `entries` is derived from `enrolledRepos` and nothing else
 * can add to it. Sections and priorities are read to ORDER and GROUP that
 * list; a repo a section names but enrollment does not carry appears only in
 * `unenrolledSectionRoots`, which is a disclosure, not a grant.
 *
 * Order: focused section first (when a focus is set), then priority, then
 * name — so the ordering is total and stable rather than dependent on the
 * registry's insertion order.
 */
export function rankAutonomyScope(input: AutonomyScopeInputs): VerseAutonomyScopeView {
  const sections = input.workspaces.filter((w) => w.section);
  const focus = input.focusSectionId === null
    ? null
    : sections.find((w) => w.id === input.focusSectionId) ?? null;

  const enrolled = new Set(input.enrolledRepos);
  const membership = new Map<string, Array<{ id: string; name: string }>>();
  const unenrolledSectionRoots: string[] = [];
  for (const section of sections) {
    for (const root of section.roots) {
      if (!enrolled.has(root.path)) {
        if (!unenrolledSectionRoots.includes(root.path)) unenrolledSectionRoots.push(root.path);
        continue;
      }
      const list = membership.get(root.path) ?? [];
      list.push({ id: section.id, name: section.name });
      membership.set(root.path, list);
    }
  }

  const focusMembers = new Set(
    focus === null ? [] : focus.roots.map((r) => r.path).filter((p) => enrolled.has(p)),
  );

  const entries: VerseAutonomyScopeEntry[] = input.enrolledRepos.map((path) => ({
    path,
    name: basename(path) || path,
    priority: input.priorities[path] ?? VERSE_DEFAULT_ROOT_PRIORITY,
    sections: membership.get(path) ?? [],
    outsideFocus: focus !== null && !focusMembers.has(path),
  }));

  entries.sort((a, b) => {
    if (a.outsideFocus !== b.outsideFocus) return a.outsideFocus ? 1 : -1;
    const rank = VERSE_ROOT_PRIORITY_RANK[a.priority] - VERSE_ROOT_PRIORITY_RANK[b.priority];
    if (rank !== 0) return rank;
    return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
  });

  return {
    focusSectionId: focus?.id ?? null,
    focusSectionName: focus?.name ?? null,
    entries,
    unenrolledSectionRoots,
  };
}

/** `rankAutonomyScope` against the live enrollment registry. Never throws. */
export function buildAutonomyScopeView(store: VerseWorkspaceStore): VerseAutonomyScopeView {
  let enrolledRepos: string[] = [];
  try {
    const snapshot = readEnrollmentRegistry();
    // A degraded read carries NO repos by construction, which is the honest
    // answer: we do not know what is enrolled, so we claim nothing is.
    if (snapshot.state === 'ready') enrolledRepos = snapshot.repos;
  } catch {
    enrolledRepos = [];
  }
  return rankAutonomyScope({
    workspaces: store.list(),
    priorities: store.priorities(),
    focusSectionId: store.focusSectionId(),
    enrolledRepos,
  });
}
