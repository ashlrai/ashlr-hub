/** Fixed tool executor. This process has no vendor state; the host must place it
 * inside the existing local OS jail before sending a request on stdin. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAUDE_TOOL_REQUEST_MAX_BYTES = 128 * 1024;
export const CLAUDE_TOOL_FILE_MAX_BYTES = 32 * 1024;
export interface ClaudeToolRequest {
  schemaVersion: 1;
  root: string;
  call: { name: 'read_file' | 'write_file'; path: string; text?: string };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/** Actual filesystem handler, shared with the fixed stdin entrypoint. */
export function executeClaudeToolRequest(value: unknown): string {
  if (!object(value) || !keys(value, ['schemaVersion', 'root', 'call']) || value.schemaVersion !== 1
    || typeof value.root !== 'string' || !isAbsolute(value.root) || resolve(value.root) !== value.root
    || !object(value.call)) throw new Error('Tool request refused');
  const call = value.call;
  const expected = call.name === 'read_file' ? ['name', 'path'] : ['name', 'path', 'text'];
  if (!keys(call, expected) || !['read_file', 'write_file'].includes(String(call.name))
    || typeof call.path !== 'string' || call.path.length === 0 || call.path.length > 4096
    || isAbsolute(call.path) || /[\\\0:]/.test(call.path)
    || call.path.split('/').some(part => part === '..' || /^\.git[ .]*$/i.test(part))
    || call.name === 'write_file' && (typeof call.text !== 'string' || Buffer.byteLength(call.text) > CLAUDE_TOOL_FILE_MAX_BYTES)) {
    throw new Error('Tool request refused');
  }
  const root = realpathSync(value.root);
  if (root !== value.root || !lstatSync(root).isDirectory() || dirname(root) === root) throw new Error('Tool request refused');
  const path = join(root, call.path);
  const parent = realpathSync(dirname(path));
  if (!inside(root, path) || parent !== root && !inside(root, parent) || parent !== dirname(path)) throw new Error('Tool request refused');
  if (call.name === 'read_file') {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > CLAUDE_TOOL_FILE_MAX_BYTES) throw new Error('Tool request refused');
      const bytes = Buffer.alloc(CLAUDE_TOOL_FILE_MAX_BYTES + 1);
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      if (count > CLAUDE_TOOL_FILE_MAX_BYTES) throw new Error('Tool request refused');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    } finally { closeSync(fd); }
  }
  try {
    const target = lstatSync(path);
    if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1) throw new Error('Tool request refused');
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(parent, `.ashlr-broker-${randomBytes(12).toString('hex')}`);
  try {
    writeFileSync(temporary, call.text as string, { flag: 'wx', mode: 0o600 });
    if (realpathSync(dirname(path)) !== parent) throw new Error('Tool request refused');
    renameSync(temporary, path);
    return 'Written';
  } finally { try { unlinkSync(temporary); } catch { /* Renamed or refused. */ } }
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
