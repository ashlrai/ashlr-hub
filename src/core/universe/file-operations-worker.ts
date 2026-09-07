/** Fixed package-owned code. Model output is JSON data, never executable source. */
export const FILE_OPERATIONS_WORKER = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const fail = () => { throw new Error('invalid file operation state'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode;
const missing = (error) => error && error.code === 'ENOENT';
const safePath = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 &&
  value.normalize('NFC') === value && !/[\x00-\x1f\x7f\\:]/.test(value) &&
  value.split('/').length <= 32 && value.split('/').every((part) => part && part !== '.' && part !== '..' &&
    !/[. ]$/.test(part) && !['.git', '.ashlr'].includes(part.toLowerCase()) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const text = (data) => {
  if (data.length > 65536) fail();
  const value = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(data);
  if (value.includes('\0')) fail();
  return value;
};
let plan;
const root = () => {
  const stat = fs.lstatSync(plan.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(plan.root) !== plan.root ||
      stat.dev !== plan.rootIdentity.dev || stat.ino !== plan.rootIdentity.ino) fail();
};
// A missing ancestor means an absent mutable file, not permission to follow a link.
const parents = (relative, create = false) => {
  root();
  let current = plan.root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (!missing(error)) throw error;
      if (!create) return false;
      fs.mkdirSync(current, {mode: 0o700});
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) fail();
  }
  return true;
};
const state = (file) => {
  if (!parents(file.path)) return {contentDigest: null, stat: null};
  const absolute = path.join(plan.root, file.path);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) { if (missing(error)) return {contentDigest: null, stat: null}; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536 ||
      fs.realpathSync(absolute) !== absolute) fail();
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!same(stat, fs.fstatSync(fd))) fail();
    const data = fs.readFileSync(fd);
    text(data);
    if (data.length !== stat.size || !same(stat, fs.fstatSync(fd)) || !same(stat, fs.lstatSync(absolute))) fail();
    return {contentDigest: hash(data), stat};
  } finally { fs.closeSync(fd); }
};
const unchanged = (file) => {
  const current = state(file);
  if (current.contentDigest !== file.contentDigest ||
      (file.stat !== null && (!current.stat || !same(file.stat, current.stat)))) fail();
};
try {
  const input = process.argv[1];
  const stat = fs.lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1048576) fail();
  const fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    if (!same(stat, fs.fstatSync(fd))) fail();
    bytes = fs.readFileSync(fd);
    if (!same(stat, fs.fstatSync(fd)) || !same(stat, fs.lstatSync(input)) || hash(bytes) !== process.argv[2]) fail();
  } finally { fs.closeSync(fd); }
  plan = JSON.parse(bytes.toString('utf8'));
  if (!exact(plan, ['schemaVersion', 'mode', 'root', 'rootIdentity', 'runtime', 'files', 'contextFiles', 'operations']) ||
      plan.schemaVersion !== 1 || !['check', 'apply'].includes(plan.mode) || !path.isAbsolute(plan.root) ||
      !Array.isArray(plan.files) || plan.files.length < 1 || plan.files.length > 16 ||
      !Array.isArray(plan.contextFiles) || plan.contextFiles.length > 16 ||
      !Array.isArray(plan.operations) || plan.operations.length > plan.files.length) fail();
  if (fs.realpathSync(process.execPath) !== plan.runtime.path || !same(plan.runtime.stat, fs.statSync(process.execPath))) fail();
  const baseline = [...plan.files, ...plan.contextFiles];
  const keys = baseline.map((file) => {
    if (!exact(file, ['path', 'contentDigest', 'stat']) || !safePath(file.path) ||
        !(file.contentDigest === null && file.stat === null ||
          typeof file.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(file.contentDigest) && file.stat)) fail();
    return file.path.normalize('NFD').toLowerCase();
  });
  if (keys.some((key, index) => keys.some((other, next) => index !== next &&
      (key === other || key.startsWith(other + '/') || other.startsWith(key + '/'))))) fail();
  if (plan.contextFiles.some((file) => file.contentDigest === null)) fail();
  const seen = new Set();
  let total = 0;
  for (const operation of plan.operations) {
    const file = plan.files.find((entry) => entry.path === operation.path);
    if (!file || seen.has(operation.path) || !['create', 'replace', 'delete'].includes(operation.op) ||
        !exact(operation, operation.op === 'delete' ? ['op', 'path'] : ['op', 'path', 'content']) ||
        (operation.op === 'create') !== (file.contentDigest === null)) fail();
    seen.add(operation.path);
    if (operation.op !== 'delete') {
      if (typeof operation.content !== 'string' || Buffer.from(operation.content).toString('utf8') !== operation.content) fail();
      const data = Buffer.from(operation.content);
      text(data);
      total += data.length;
      if (total > 131072) fail();
    }
  }
  if (plan.mode === 'check' && plan.operations.length !== 0) fail();
  // All model-authored operations and all inputs pass before the first write.
  for (const file of baseline) unchanged(file);
  if (plan.mode === 'apply') {
    for (const operation of plan.operations) {
      const file = plan.files.find((entry) => entry.path === operation.path);
      unchanged(file);
      if (operation.op === 'replace' && hash(Buffer.from(operation.content)) === file.contentDigest) continue;
      if (!parents(operation.path, operation.op === 'create')) fail();
      const absolute = path.join(plan.root, operation.path);
      if (operation.op === 'delete') {
        // Kernel confinement, not this pathname check, excludes outside writes.
        unchanged(file);
        fs.unlinkSync(absolute);
      } else {
        const flags = operation.op === 'create'
          ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
          : fs.constants.O_RDWR | fs.constants.O_NOFOLLOW;
        const fd = fs.openSync(absolute, flags, 0o600);
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.nlink !== 1 ||
              (operation.op === 'replace' && !same(file.stat, opened))) fail();
          if (operation.op === 'replace') fs.ftruncateSync(fd, 0);
          const data = Buffer.from(operation.content);
          let offset = 0;
          while (offset < data.length) {
            const written = fs.writeSync(fd, data, offset, data.length - offset, offset);
            if (written < 1) fail();
            offset += written;
          }
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
      }
    }
  }
  for (const file of baseline) {
    const operation = plan.operations.find((entry) => entry.path === file.path);
    const expected = operation ? (operation.op === 'delete' ? null : hash(Buffer.from(operation.content))) : file.contentDigest;
    if (state(file).contentDigest !== expected) fail();
    if (!operation) unchanged(file);
  }
  process.stdout.write('{"ok":true}');
} catch {
  // Never echo task contents, filesystem errors, paths, or model output.
  process.stderr.write('File operation worker rejected candidate state');
  process.exitCode = 1;
}
`;
