#!/usr/bin/env node
/**
 * Guard: no NEW synchronous filesystem or child-process call in a Verse HTTP
 * route file (src/core/verse/**\/*-api.ts).
 *
 * WHY. The Verse sidecar serves every route from one thread. macOS guards
 * ~/Desktop, ~/Documents, ~/Downloads and removable/network volumes with a
 * privacy (TCC) prompt, and while that prompt is up any SYNCHRONOUS access
 * into the folder parks the calling thread until the operator answers it — on
 * the sidecar's main thread that froze every route, static /verse/ included,
 * for minutes (3.13.0 ship, 2026-09-26; see src/core/verse/folder-io.ts). A
 * route file is exactly where such a call does that damage, so this check
 * refuses two things there:
 *
 *   1. any `<name>Sync(` call — fs.*Sync, execFileSync, spawnSync, or a
 *      helper that advertises itself as synchronous;
 *   2. a call to a synchronous helper that touches operator folders and has
 *      an async twin meant for request paths (SYNC_HELPERS_WITH_ASYNC_TWIN).
 *
 * THE ALLOWLIST is a comment, on the offending line or the line directly
 * above it, that says why the call cannot touch an operator folder:
 *
 *     // sync-io-ok: lstat of ~/.ashlr/KILL, a private control file, never a project folder
 *
 * The reason must be at least 20 characters: "fine" is not a reason. Typical
 * valid ones are private state under ~/.ashlr, ~/.claude or ~/.codex, or code
 * that runs once at startup rather than per request.
 *
 * Best-effort, like the other lint guards: it reads text, not types. Run via
 * `npm run lint:verse-sync-io` (part of `npm run lint` and `npm run gate`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** The route files: every `*-api.ts` under this directory, at any depth. */
export const VERSE_ROUTE_DIR = 'src/core/verse';

/**
 * Synchronous helpers that reach into operator folders (git in a repo, a
 * realpath of a project path, a blocking Locus probe, a multi-MB config
 * parse) and have an async twin a route must use instead.
 */
export const SYNC_HELPERS_WITH_ASYNC_TWIN = Object.freeze({
  describeRoots: 'describeRootsAsync',
  rootGitIdentity: 'rootGitIdentityAsync',
  resolveWorkspaceRoots: 'resolveWorkspaceRootsAsync',
  checkWorkspaceRootPath: 'checkWorkspaceRootPathAsync',
  checkGuardedPath: 'checkGuardedPathAsync',
  isDirectoryPath: 'isDirectoryPathAsync',
  physicalPath: 'physicalPathAsync',
  discoverProjects: 'discoverProjectsAsync',
  buildHandoffPreview: 'buildHandoffPreviewAsync',
  defaultGitDiffStat: 'defaultGitDiffStatAsync',
  getGitStatus: 'getGitStatusAsync',
  isRepo: 'isRepoAsync',
  resolveGitHubOriginAuthority: 'resolveGitHubOriginAuthorityAsync',
  isEnrolled: 'isEnrolledAsync',
  canonicalEnrollmentPath: 'canonicalEnrollmentPathAsync',
  buildVerseMcpSnapshot: 'buildVerseMcpSnapshotAsync',
  buildVerseMcpMachineRegistry: 'buildVerseMcpMachineRegistryAsync',
  discoverMcpServers: 'discoverMcpServersAsync',
  readVerseMcpScope: 'readVerseMcpScopeAsync',
  readVerseMcpScopeGate: 'readVerseMcpScopeGateAsync',
  locusAgentReport: 'locusAgentReportAsync',
  locusAvailable: 'locusAvailableAsync',
  locusFleetGate: 'locusFleetGateAsync',
  assertLocusPreMutate: 'assertLocusPreMutateAsync',
  cachedPendingCount: 'cachedPendingCountAsync',
  buildRollup: 'getCachedRollup',
});

export const ALLOW_MARKER = 'sync-io-ok:';
const MIN_REASON_CHARS = 20;

const SYNC_CALL = /(?<!function\s+)\b([A-Za-z_$][\w$]*Sync)\s*\(/g;
const HELPER_CALL = new RegExp(
  `(?<![\\w$.])(?<!function\\s+)(${Object.keys(SYNC_HELPERS_WITH_ASYNC_TWIN).join('|')})\\s*\\(`,
  'g',
);

/**
 * Blank out comments and string/template literal contents, keeping line
 * structure, so a call named inside a comment or a message is not a hit.
 * Returns the code-only text plus, per line, the comment text it held.
 */
function splitCodeAndComments(source) {
  let code = '';
  const comments = [''];
  let line = 0;
  let i = 0;
  const n = source.length;
  const push = (ch, isComment) => {
    if (ch === '\n') {
      code += '\n';
      line += 1;
      comments[line] = '';
      return;
    }
    if (isComment) {
      comments[line] += ch;
      code += ' ';
    } else {
      code += ch;
    }
  };
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') push(source[i++], true);
      continue;
    }
    if (ch === '/' && next === '*') {
      push(source[i++], true);
      push(source[i++], true);
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) push(source[i++], true);
      if (i < n) { push(source[i++], true); push(source[i++], true); }
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      push(source[i++], false);
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          push(' ', false); i += 1;
          push(source[i] === '\n' ? '\n' : ' ', false); i += 1;
          continue;
        }
        // Template substitutions are code: keep `${ ... }` scanning simple by
        // treating their text as code (nested templates are rare here).
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          let depth = 0;
          while (i < n) {
            const c = source[i];
            if (c === '{') depth += 1;
            if (c === '}') { depth -= 1; if (depth === 0) { push(source[i++], false); break; } }
            push(source[i++], false);
          }
          continue;
        }
        push(source[i] === '\n' ? '\n' : ' ', false);
        i += 1;
      }
      if (i < n) push(source[i++], false);
      continue;
    }
    push(ch, false);
    i += 1;
  }
  return { codeLines: code.split('\n'), comments };
}

function allowed(comments, index) {
  for (const text of [comments[index] ?? '', comments[index - 1] ?? '']) {
    const at = text.indexOf(ALLOW_MARKER);
    if (at >= 0 && text.slice(at + ALLOW_MARKER.length).trim().length >= MIN_REASON_CHARS) return true;
  }
  return false;
}

/**
 * Violations in one file's text. Each: { line (1-based), call, kind, hint }.
 * Exported for the test that pins this guard's behaviour.
 */
export function findSyncIoInSource(source) {
  const { codeLines, comments } = splitCodeAndComments(source);
  const out = [];
  codeLines.forEach((text, index) => {
    const hits = [];
    for (const m of text.matchAll(SYNC_CALL)) hits.push({ call: m[1], kind: 'sync-call', hint: 'use the fs/promises or promisified child_process form' });
    for (const m of text.matchAll(HELPER_CALL)) {
      hits.push({ call: m[1], kind: 'sync-helper', hint: `use ${SYNC_HELPERS_WITH_ASYNC_TWIN[m[1]]}` });
    }
    if (hits.length > 0 && !allowed(comments, index)) {
      for (const hit of hits) out.push({ line: index + 1, ...hit });
    }
  });
  return out;
}

function routeFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.isFile() && entry.name.endsWith('-api.ts')) out.push(full);
  }
  return out.sort();
}

/** Every violation under `root` (default: this repository). */
export function findVerseSyncIo(root = repoRoot) {
  const violations = [];
  for (const file of routeFiles(join(root, VERSE_ROUTE_DIR))) {
    for (const v of findSyncIoInSource(readFileSync(file, 'utf8'))) {
      violations.push({ file: relative(root, file).replaceAll('\\', '/'), ...v });
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = findVerseSyncIo();
  if (violations.length === 0) {
    console.log('verse-sync-io: no synchronous fs/child-process calls in Verse route files');
    process.exit(0);
  }
  console.error(`verse-sync-io: ${violations.length} synchronous call(s) in Verse route files — a macOS privacy prompt on the folder freezes the whole sidecar:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.call}(…)  → ${v.hint}`);
  console.error(`If the call can never touch an operator folder, say why on it or on the line above: // ${ALLOW_MARKER} <reason>`);
  process.exit(1);
}
