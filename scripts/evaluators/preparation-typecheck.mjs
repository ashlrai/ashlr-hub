/** Fixed compiler process. Candidate text is compiler input, never imported or
 * executed. The parent owns timeout, memory ceiling and process settlement. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPreparationTypes } from '../../src/core/universe/preparation-typecheck.ts';
import { MAX_PREPARATION_TYPECHECK_CANDIDATE_BYTES, MAX_PREPARATION_TYPECHECK_INPUT_BYTES } from '../../src/core/universe/preparation-typecheck-project.ts';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = MAX_PREPARATION_TYPECHECK_CANDIDATE_BYTES;
const MAX_PROJECT_BYTES = MAX_PREPARATION_TYPECHECK_INPUT_BYTES;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('PREPARATION_TYPECHECK_UNAVAILABLE'); };
const same = (a, b) => ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs', 'nlink'].every(key => a[key] === b[key]);
function readProject(path) {
  const before = fs.lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size < 1n || before.size > BigInt(MAX_PROJECT_BYTES) ||
      (before.mode & 0o022n) !== 0n || fs.realpathSync(path) !== path) fail();
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) fail();
    const storage = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < storage.length) {
      const bytes = fs.readSync(fd, storage, length, storage.length - length, length);
      if (!bytes) break;
      length += bytes;
    }
    if (length !== Number(before.size) || !same(before, fs.fstatSync(fd, { bigint: true })) ||
        !same(before, fs.lstatSync(path, { bigint: true }))) fail();
    return storage.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function input() {
  const storage = Buffer.alloc(MAX_INPUT_BYTES + 1); let length = 0;
  while (length < storage.length) {
    const bytes = fs.readSync(0, storage, length, storage.length - length, null);
    if (!bytes) break;
    length += bytes;
  }
  if (!length || length > MAX_INPUT_BYTES) fail();
  const value = JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(storage.subarray(0, length)));
  const keys = ['schemaVersion', 'source', 'sourceSha256', 'projectSha256'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key)) || value.schemaVersion !== 1 || typeof value.source !== 'string' ||
      Buffer.byteLength(value.source) > MAX_SOURCE_BYTES || !/^[a-f0-9]{64}$/.test(value.sourceSha256) ||
      !/^[a-f0-9]{64}$/.test(value.projectSha256) || hash(value.source) !== value.sourceSha256) fail();
  return value;
}

export function runPreparationTypecheck() {
  let sourceSha256 = null, projectSha256 = null;
  const result = (passed, diagnosticCodes) => ({ schemaVersion: 1, kind: 'preparation-typecheck-result',
    passed, sourceSha256, projectSha256, diagnosticCodes });
  try {
    const expected = join(dirname(fileURLToPath(import.meta.url)), 'preparation-typecheck-project.json');
    if (process.argv.length !== 3 || process.argv[2] !== expected) fail();
    const request = input();
    sourceSha256 = request.sourceSha256; projectSha256 = request.projectSha256;
    const bytes = readProject(expected);
    if (hash(bytes) !== projectSha256) fail();
    const project = JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const checked = verifyPreparationTypes(project, request.source);
    if (!checked || typeof checked.passed !== 'boolean' || !Array.isArray(checked.diagnosticCodes) ||
        checked.diagnosticCodes.length > 32 || checked.diagnosticCodes.some(code => !Number.isSafeInteger(code) || code < 0) ||
        checked.passed && checked.diagnosticCodes.length) fail();
    if (hash(readProject(expected)) !== projectSha256) fail();
    return result(checked.passed, checked.diagnosticCodes);
  } catch { return result(false, [99999]); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(JSON.stringify(runPreparationTypecheck()) + '\n');
}
