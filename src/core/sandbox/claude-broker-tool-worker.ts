/** Fixed tool executor. This process has no vendor state; the host must place it
 * inside the existing local OS jail before sending a request on stdin. */
import { constants, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAUDE_TOOL_REQUEST_MAX_BYTES = 128 * 1024;
export const CLAUDE_TOOL_FILE_MAX_BYTES = 32 * 1024;
/** Optional windows and new tools have structured results; legacy calls keep
 * their original text results. Files/scan work are bounded independently of
 * a model's task budget. Larger/partial results are explicit, never chopped JSON. */
export const CLAUDE_TOOL_SOURCE_MAX_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 5000;
const MAX_SEARCH_FILES = 2000;
const MAX_SEARCH_ENTRIES = 5000;
const MAX_SEARCH_BYTES = 16 * 1024 * 1024;
const MAX_WALK_DEPTH = 32;
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.codex', '.grok', '.devin', '.ashlr', '.ssh', '.aws',
  'keychains', '.claude.json', '.mcp.json', '.netrc', '.npmrc', '.git-credentials', '.ashlr.json',
  'dist', 'build', '.next', '.turbo', 'coverage', '__pycache__', '.cache', 'vendor', 'target', 'out', '.output', '.vercel', '.serverless', '.yarn']);
const SECRET_FILE = /(^\.env(?:\.|$))|\.(?:pem|key|p12|pfx)$|^id_(?:rsa|ed25519)(?:\.|$)|^(?:\.?credentials|secrets|auth)\.json$/i;
export type ClaudeToolCall =
  | { name: 'read_file'; path: string; offset?: number; limit?: number }
  | { name: 'write_file'; path: string; text: string }
  | { name: 'list_files'; path: string; offset?: number; limit?: number; expectedSnapshot?: string }
  | { name: 'search'; path: string; query: string; offset?: number; limit?: number; expectedSnapshot?: string }
  | { name: 'edit_file'; path: string; expectedSha256: string; oldText: string; newText: string }
  | { name: 'create_directory'; path: string };
export interface ClaudeToolRequest { schemaVersion: 1; root: string; call: ClaudeToolCall }
const refused = (): never => { throw new Error('Tool request refused'); };
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function allowedPath(path: unknown, directory = false): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !isAbsolute(path)
    && !/[\\\0:]/.test(path) && (directory && path === '.' || path.split('/').every(part =>
      part !== '' && part !== '.' && part !== '..' && !/^\.git[ .]*$/i.test(part)
      && !SKIP_DIRS.has(part.toLowerCase()) && !SECRET_FILE.test(part)));
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
/** Shared schema validation is inert: broker and worker reject the same shapes. */
export function validateClaudeToolCall(value: unknown, checkPath = true): ClaudeToolCall {
  if (!object(value) || typeof value.path !== 'string' || value.path.length > 4096
    || checkPath && !allowedPath(value.path, ['list_files', 'search'].includes(String(value.name)))) return refused();
  switch (value.name) {
    case 'read_file':
    case 'list_files': {
      if (!keys(value, ['name', 'path'], value.name === 'list_files' ? ['offset', 'limit', 'expectedSnapshot'] : ['offset', 'limit'])
        || value.offset !== undefined && !integer(value.offset, 0, value.name === 'list_files' ? MAX_DIRECTORY_ENTRIES : CLAUDE_TOOL_SOURCE_MAX_BYTES)
        || value.limit !== undefined && !integer(value.limit, 1, value.name === 'list_files' ? 200 : 2000)
        || value.expectedSnapshot !== undefined && (typeof value.expectedSnapshot !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedSnapshot))) return refused();
      break;
    }
    case 'write_file':
      if (!keys(value, ['name', 'path', 'text']) || typeof value.text !== 'string' || Buffer.byteLength(value.text) > CLAUDE_TOOL_FILE_MAX_BYTES) return refused();
      break;
    case 'search':
      if (!keys(value, ['name', 'path', 'query'], ['offset', 'limit', 'expectedSnapshot'])
        || value.offset !== undefined && !integer(value.offset, 0, 16 * 1024 * 1024)
        || value.limit !== undefined && !integer(value.limit, 1, 200)
        || value.expectedSnapshot !== undefined && (typeof value.expectedSnapshot !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedSnapshot))
        || typeof value.offset === 'number' && value.offset > 0 && value.expectedSnapshot === undefined || typeof value.query !== 'string' || !value.query.length
        || Buffer.byteLength(value.query) > 1024 || /[\0\r\n]/.test(value.query)) return refused();
      break;
    case 'edit_file':
      if (!keys(value, ['name', 'path', 'expectedSha256', 'oldText', 'newText'])
        || typeof value.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedSha256)
        || typeof value.oldText !== 'string' || value.oldText.length === 0 || typeof value.newText !== 'string'
        || Buffer.byteLength(value.oldText) + Buffer.byteLength(value.newText) > CLAUDE_TOOL_FILE_MAX_BYTES) return refused();
      break;
    case 'create_directory': if (!keys(value, ['name', 'path'])) return refused(); break;
    default: return refused();
  }
  return value as unknown as ClaudeToolCall;
}
function canonicalParent(root: string, path: string): string {
  const parent = realpathSync(dirname(path));
  if (!inside(root, path) || parent !== root && !inside(root, parent) || parent !== dirname(path)) return refused();
  return parent;
}
function directory(root: string, path: string): void {
  if (path !== root) canonicalParent(root, path);
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) refused();
}
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
function fileBytes(root: string, path: string, max = CLAUDE_TOOL_SOURCE_MAX_BYTES): Buffer {
  canonicalParent(root, path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) return refused();
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (read === 0) break;
      count += read;
    }
    const fresh = fstatSync(fd); const current = lstatSync(path);
    if (count !== stat.size || fresh.size !== stat.size || fresh.mtimeMs !== stat.mtimeMs
      || fresh.ctimeMs !== stat.ctimeMs || current.ino !== stat.ino || current.dev !== stat.dev
      || current.nlink !== 1 || current.isSymbolicLink()) return refused();
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}
const decode = (bytes: Buffer): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function json(value: object): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > CLAUDE_TOOL_FILE_MAX_BYTES) return refused();
  return text;
}
function atomicWrite(root: string, path: string, text: string, expected?: string): void {
  const parent = canonicalParent(root, path);
  let target: ReturnType<typeof lstatSync> | null = null;
  try {
    target = lstatSync(path);
    if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1) refused();
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT' || expected !== undefined) throw error;
  }
  const temporary = join(parent, `.ashlr-broker-${randomBytes(12).toString('hex')}`);
  try {
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    if (target !== null) chmodSync(temporary, target.mode & 0o777);
    let current: ReturnType<typeof lstatSync> | null = null;
    try { current = lstatSync(path); } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (target === null ? current !== null : current === null || !current.isFile() || current.nlink !== 1
      || current.ino !== target.ino || current.dev !== target.dev || current.ctimeMs !== target.ctimeMs) refused();
    if (canonicalParent(root, path) !== parent || expected !== undefined && sha(fileBytes(root, path)) !== expected) refused();
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch { /* Renamed or refused. */ } }
}
interface Entry { name: string; kind: 'file' | 'directory' }
function entries(root: string, path: string, budget = MAX_DIRECTORY_ENTRIES): { rows: Entry[]; skipped: number; visited: number } {
  directory(root, path);
  const rows: Entry[] = []; let visited = 0; let skipped = 0;
  const dir = opendirSync(path);
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      if (++visited > budget) return refused();
      if (SKIP_DIRS.has(entry.name.toLowerCase()) || /^\.git[ .]*$/i.test(entry.name) || SECRET_FILE.test(entry.name)
        || entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) { skipped++; continue; }
      rows.push({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' });
    }
  } finally { dir.closeSync(); }
  directory(root, path);
  rows.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { rows, skipped, visited };
}
/** Actual filesystem handler, shared with the fixed stdin entrypoint. */
export function executeClaudeToolRequest(value: unknown): string {
  if (!object(value) || !keys(value, ['schemaVersion', 'root', 'call']) || value.schemaVersion !== 1
    || typeof value.root !== 'string' || !isAbsolute(value.root) || resolve(value.root) !== value.root) return refused();
  const call = validateClaudeToolCall(value.call);
  const root = realpathSync(value.root);
  if (root !== value.root || !lstatSync(root).isDirectory() || dirname(root) === root) return refused();
  const path = join(root, call.path);
  switch (call.name) {
    case 'read_file': {
      const bytes = fileBytes(root, path, call.offset === undefined && call.limit === undefined ? CLAUDE_TOOL_FILE_MAX_BYTES : CLAUDE_TOOL_SOURCE_MAX_BYTES);
      const text = decode(bytes);
      if (call.offset === undefined && call.limit === undefined) return text;
      const lines = text.split('\n'); const offset = call.offset ?? 0; const limit = call.limit ?? 200;
      const result = { path: call.path, sha256: sha(bytes), offset, returnedLines: 0, totalLines: lines.length,
        nextOffset: null as number | null, truncated: false, content: '' };
      for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
        const candidate = { ...result, content: result.content + `${i + 1}\t${lines[i]}\n`, returnedLines: result.returnedLines + 1 };
        if (Buffer.byteLength(JSON.stringify(candidate)) > CLAUDE_TOOL_FILE_MAX_BYTES - 256) { result.truncated = true; break; }
        result.content = candidate.content; result.returnedLines = candidate.returnedLines;
      }
      result.nextOffset = offset + result.returnedLines < lines.length ? offset + result.returnedLines : null;
      result.truncated ||= result.nextOffset !== null;
      // A single enormous line cannot silently return a non-advancing page.
      if (result.returnedLines === 0 && offset < lines.length) return json({ ...result, nextOffset: null, reason: 'Line exceeds result byte limit' });
      return json(result);
    }
    case 'write_file': atomicWrite(root, path, call.text); return 'Written';
    case 'edit_file': {
      // Exact edits retain a leading UTF-8 BOM and all untouched line endings.
      const bytes = fileBytes(root, path); const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (sha(bytes) !== call.expectedSha256) return refused();
      const index = text.indexOf(call.oldText);
      if (index < 0 || text.indexOf(call.oldText, index + 1) >= 0) return refused();
      const updated = text.slice(0, index) + call.newText + text.slice(index + call.oldText.length);
      if (Buffer.byteLength(updated) > CLAUDE_TOOL_SOURCE_MAX_BYTES) return refused();
      atomicWrite(root, path, updated, call.expectedSha256);
      return json({ edited: true, path: call.path, sha256: sha(updated), replacements: 1 });
    }
    case 'create_directory': {
      let current = root; let directoriesCreated = 0;
      for (const component of call.path.split('/')) {
        const next = join(current, component); canonicalParent(root, next);
        try { mkdirSync(next, { mode: 0o700 }); directoriesCreated++; }
        catch (error) { if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        directory(root, next); current = next;
      }
      return json({ created: directoriesCreated > 0, directoriesCreated, path: call.path });
    }
    case 'list_files': {
      const { rows, skipped } = entries(root, path); const snapshot = sha(JSON.stringify(rows));
      if (call.expectedSnapshot !== undefined && call.expectedSnapshot !== snapshot) return refused();
      const offset = call.offset ?? 0; const limit = call.limit ?? 50;
      const result = { path: call.path, snapshot, offset, files: [] as Entry[], totalEntries: rows.length, skipped,
        nextOffset: null as number | null, truncated: false };
      for (const row of rows.slice(offset, offset + limit)) {
        if (Buffer.byteLength(JSON.stringify({ ...result, files: [...result.files, row] })) > CLAUDE_TOOL_FILE_MAX_BYTES - 256) break;
        result.files.push(row);
      }
      result.nextOffset = offset + result.files.length < rows.length ? offset + result.files.length : null;
      result.truncated = result.nextOffset !== null;
      return json(result);
    }
    case 'search': {
      const offset = call.offset ?? 0; const limit = call.limit ?? 50;
      const result = { path: call.path, query: call.query, snapshot: '', offset,
        matches: [] as Array<{ path: string; line: number; text: string }>, totalMatches: 0,
        filesAttempted: 0, filesScanned: 0, bytesScanned: 0, readBudgetReserved: 0, entriesVisited: 0, skipped: 0,
        nextOffset: null as number | null, truncated: false, scanTruncated: false, coverageComplete: true };
      // Re-scan a bounded, sorted corpus on each page. Its content-bound digest
      // prevents a continuation from silently skipping matches after edits.
      const digest = createHash('sha256').update(JSON.stringify([call.path, call.query]));
      let outputFull = false;
      const scan = (file: string): void => {
        if (result.filesAttempted >= MAX_SEARCH_FILES) { result.scanTruncated = true; return; }
        result.filesAttempted++;
        let bytes: Buffer; let text: string;
        try {
          const stat = lstatSync(file);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > CLAUDE_TOOL_SOURCE_MAX_BYTES) throw new Error('skipped');
          // Reserve the read plus its growth-detection byte before allocating or
          // reading. Failed UTF-8/racing files cannot evade the I/O work bound.
          const reserved = stat.size + 1;
          if (result.readBudgetReserved + reserved > MAX_SEARCH_BYTES) { result.scanTruncated = true; return; }
          result.readBudgetReserved += reserved;
          bytes = fileBytes(root, file, stat.size);
          result.filesScanned++; result.bytesScanned += bytes.length;
          digest.update(JSON.stringify([relative(root, file), sha(bytes)]));
          text = decode(bytes);
        } catch { result.skipped++; digest.update(JSON.stringify(['skipped', relative(root, file)])); return; }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) if (lines[i].includes(call.query)) {
          const index = result.totalMatches++;
          if (index < offset || result.matches.length >= limit || outputFull) continue;
          const match = { path: relative(root, file).split(sep).join('/'), line: i + 1, text: lines[i] };
          if (Buffer.byteLength(JSON.stringify({ ...result, matches: [...result.matches, match] })) > CLAUDE_TOOL_FILE_MAX_BYTES - 512) { outputFull = true; continue; }
          result.matches.push(match);
        }
      };
      const walk = (dir: string, depth: number): void => {
        if (depth > MAX_WALK_DEPTH) { result.skipped++; digest.update(JSON.stringify(['depth', relative(root, dir)])); return; }
        let found: ReturnType<typeof entries>;
        try { found = entries(root, dir, MAX_SEARCH_ENTRIES - result.entriesVisited); }
        catch { result.scanTruncated = true; return; }
        result.entriesVisited += found.visited; result.skipped += found.skipped;
        digest.update(JSON.stringify([relative(root, dir), found.rows, found.skipped]));
        for (const entry of found.rows) {
          if (result.scanTruncated) return;
          const full = join(dir, entry.name);
          if (entry.kind === 'directory') walk(full, depth + 1); else scan(full);
        }
      };
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path, 0); else scan(path);
      result.snapshot = digest.digest('hex');
      if (call.expectedSnapshot !== undefined && result.snapshot !== call.expectedSnapshot) return refused();
      result.nextOffset = offset + result.matches.length < result.totalMatches ? offset + result.matches.length : null;
      result.truncated = result.scanTruncated || result.nextOffset !== null;
      result.coverageComplete = !result.scanTruncated && result.skipped === 0;
      if (result.matches.length === 0 && offset < result.totalMatches) return json({ ...result, nextOffset: null, reason: 'Match exceeds result byte limit; use ranged read' });
      return json(result);
    }
  }
}
/** No paths, credentials, prompt or exception text in diagnostics. */
export async function runClaudeBrokerToolWorker(): Promise<void> {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > CLAUDE_TOOL_REQUEST_MAX_BYTES) throw new Error('Tool request refused');
      chunks.push(bytes);
    }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    process.stdout.write(executeClaudeToolRequest(JSON.parse(raw)));
  } catch { process.stderr.write('Tool request refused'); process.exitCode = 1; }
}
// The compiled binary dispatches its own operand-free flag explicitly. It must
// never mistake Bun's virtual module URL for a real standalone worker path.
const virtual = import.meta.url.includes('/$bunfs/') || import.meta.url.replace(/\\/g, '/').includes('/~BUN/');
if (!virtual && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 2) await runClaudeBrokerToolWorker();
  else { process.stderr.write('Tool request refused'); process.exitCode = 1; }
}
