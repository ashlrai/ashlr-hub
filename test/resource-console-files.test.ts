import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listResourceConsoleFiles, MAX_RESOURCE_FILE_PREVIEW_BYTES, readResourceConsoleFile } from '../src/core/resources/console-files.js';
import * as projects from '../src/core/resources/console-projects.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-files-'))); roots.push(base);
  const root = join(base, 'workspace'); mkdirSync(root, { mode: 0o700 });
  return { base, root, binding: projects.pinResourceConsoleProject({ id: 'default', label: 'Workspace', workspace: root }) };
}
describe.skipIf(process.platform === 'win32')('bounded registered project file reads', () => {
  it('lists only one level, directories first, and returns detached relative metadata without writing', () => {
    const f = fixture(); mkdirSync(join(f.root, 'src')); writeFileSync(join(f.root, 'src', 'nested.ts'), 'nested');
    writeFileSync(join(f.root, 'z.txt'), 'hello'); writeFileSync(join(f.root, 'a.txt'), 'a');
    const before = readdirSync(f.base);
    expect(listResourceConsoleFiles(f.binding, '')).toEqual({ projectId: 'default', path: '', entries: [
      { name: 'src', path: 'src', kind: 'directory', sizeBytes: null },
      { name: 'a.txt', path: 'a.txt', kind: 'file', sizeBytes: 1 },
      { name: 'z.txt', path: 'z.txt', kind: 'file', sizeBytes: 5 },
    ] });
    expect(listResourceConsoleFiles(f.binding, 'src').entries[0]?.path).toBe('src/nested.ts');
    expect(readdirSync(f.base)).toEqual(before);
  });
  it('preserves BOM, CRLF and markup as text and hashes exactly returned bytes', () => {
    const f = fixture(); const text = '\ufeff<script>inert</script>\r\n'; writeFileSync(join(f.root, 'source.html'), text);
    expect(readResourceConsoleFile(f.binding, 'source.html')).toEqual({ projectId: 'default', path: 'source.html', text,
      sizeBytes: Buffer.byteLength(text), byteLength: Buffer.byteLength(text), truncated: false,
      digest: createHash('sha256').update(text).digest('hex') });
  });
  it.each(['../outside', '/absolute', 'src//file', 'src/./file', 'src/../file', 'src\\file', 'a\u0000b', '.env',
    '.git/config', '.npmrc', '.aws/config', 'node_modules/a.js', 'secrets.json', 'secret.key'])('refuses disallowed path %j', (path) => {
    const f = fixture(); expect(() => readResourceConsoleFile(f.binding, path)).toThrow();
  });
  it('permits explicit repository metadata exceptions but skips hidden credentials and dependency trees', () => {
    const f = fixture(); mkdirSync(join(f.root, '.github')); mkdirSync(join(f.root, 'node_modules'));
    for (const name of ['.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.env', 'credentials.json']) writeFileSync(join(f.root, name), 'text');
    writeFileSync(join(f.root, '.github', 'workflow.yml'), 'name: inert');
    expect(listResourceConsoleFiles(f.binding, '').entries.map((entry) => entry.name)).toEqual([
      '.github', '.editorconfig', '.gitattributes', '.gitignore',
    ]);
    expect(readResourceConsoleFile(f.binding, '.github/workflow.yml').text).toBe('name: inert');
  });
  it('rejects symlinked leaf and intermediate directories plus multiply-linked files', () => {
    const f = fixture(); const outside = join(f.base, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'text.txt'), 'outside');
    symlinkSync(outside, join(f.root, 'alias')); symlinkSync(join(outside, 'text.txt'), join(f.root, 'link.txt'));
    linkSync(join(outside, 'text.txt'), join(f.root, 'hard.txt'));
    for (const path of ['alias/text.txt', 'link.txt', 'hard.txt']) expect(() => readResourceConsoleFile(f.binding, path)).toThrow();
    expect(listResourceConsoleFiles(f.binding, '').entries).toEqual([]);
  });
  it('refuses group-writable components without repairing their permissions', () => {
    const f = fixture(); mkdirSync(join(f.root, 'shared')); chmodSync(join(f.root, 'shared'), 0o770);
    writeFileSync(join(f.root, 'shared', 'text.txt'), 'text');
    expect(() => readResourceConsoleFile(f.binding, 'shared/text.txt')).toThrow();
    expect(listResourceConsoleFiles(f.binding, '').entries).toEqual([]);
  });
  it.each([Buffer.from([0xff]), Buffer.from([0xe2, 0x82]), Buffer.from('nul\0text'), Buffer.from('escape\x1btext')])('rejects invalid or binary text %#', (bytes) => {
    const f = fixture(); writeFileSync(join(f.root, 'invalid.txt'), bytes);
    expect(() => readResourceConsoleFile(f.binding, 'invalid.txt')).toThrow();
  });
  it('returns only a complete UTF8 prefix and truthfully marks oversized previews', () => {
    const f = fixture(); const prefix = 'a'.repeat(MAX_RESOURCE_FILE_PREVIEW_BYTES - 1);
    writeFileSync(join(f.root, 'large.txt'), prefix + '💡tail');
    const preview = readResourceConsoleFile(f.binding, 'large.txt');
    expect(preview).toMatchObject({ text: prefix, byteLength: Buffer.byteLength(prefix),
      sizeBytes: Buffer.byteLength(prefix + '💡tail'), truncated: true,
      digest: createHash('sha256').update(prefix).digest('hex') });
  });
  it('does not hide a malformed final byte as an incomplete UTF8 boundary', () => {
    const f = fixture(); writeFileSync(join(f.root, 'large.txt'), Buffer.concat([
      Buffer.alloc(MAX_RESOURCE_FILE_PREVIEW_BYTES - 1, 97), Buffer.from([0xff, 97]),
    ])); expect(() => readResourceConsoleFile(f.binding, 'large.txt')).toThrow();
  });
  it('accepts exactly the preview limit without marking truncation and handles empty files', () => {
    const f = fixture(); writeFileSync(join(f.root, 'full.txt'), 'a'.repeat(MAX_RESOURCE_FILE_PREVIEW_BYTES));
    writeFileSync(join(f.root, 'empty.txt'), '');
    expect(readResourceConsoleFile(f.binding, 'full.txt')).toMatchObject({ byteLength: MAX_RESOURCE_FILE_PREVIEW_BYTES, truncated: false });
    expect(readResourceConsoleFile(f.binding, 'empty.txt')).toMatchObject({ text: '', sizeBytes: 0, byteLength: 0, truncated: false });
  });
  it('fails directory overflow rather than returning a misleading partial page', () => {
    const f = fixture(); for (let i = 0; i < 257; i++) writeFileSync(join(f.root, `file-${i}.txt`), '');
    expect(() => listResourceConsoleFiles(f.binding, '')).toThrow('256-entry');
  });
  it('rejects a pinned directory replacement and a change observed during the read', () => {
    const f = fixture(); writeFileSync(join(f.root, 'text.txt'), 'before');
    const original = projects.matchesResourceConsoleProject; let checks = 0;
    vi.spyOn(projects, 'matchesResourceConsoleProject').mockImplementation((binding) => {
      if (++checks === 2) { renameSync(f.root, join(f.base, 'old')); mkdirSync(f.root); writeFileSync(join(f.root, 'text.txt'), 'after'); }
      return original(binding);
    });
    expect(() => readResourceConsoleFile(f.binding, 'text.txt')).toThrow();
    expect(() => listResourceConsoleFiles(f.binding, '')).toThrow();
  });
});
