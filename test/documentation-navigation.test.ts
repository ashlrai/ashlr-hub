import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { checkDocumentation, inspectMarkdown, OPERATOR_DOCUMENTATION } from '../scripts/check-documentation.mjs';

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-docs-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('operator documentation navigation', () => {
  it('checks reference links, nested links, duplicate heading anchors and explicit anchors', () => {
    const root = fixture({
      'README.md': '[Install][guide]\n\n[guide]: docs/guide.md#hello-world-1\n\n- [Named](docs/guide.md#named)\n\n![Image](docs/icon.svg)',
      'docs/guide.md': '# Hello **world**\n\n## Hello `world`\n\n<a id="named"></a>\n',
      'docs/icon.svg': '<svg/>',
    });
    expect(checkDocumentation({ root, entrypoints: ['README.md'] })).toMatchObject({
      ok: true, localLinks: 3, errors: [], externalRequests: 0,
    });
  });

  it('excludes fenced examples and decodes encoded paths and fragments', () => {
    const root = fixture({ 'README.md': '```md\n[not real](missing.md)\n```\n\n[Guide](docs/A%20B.md#caf%C3%A9--tea)',
      'docs/A B.md': '# Café &amp; tea' });
    expect(checkDocumentation({ root, entrypoints: ['README.md'] }).ok).toBe(true);
    expect(inspectMarkdown('# Hello\n\n# Hello-1\n\n# Hello').anchors)
      .toEqual(new Set(['hello', 'hello-1', 'hello-2']));
  });

  it('reports missing files and missing heading fragments independently', () => {
    const root = fixture({ 'README.md': '[Missing](gone.md) [Anchor](guide.md#missing)', 'guide.md': '# Present' });
    const result = checkDocumentation({ root, entrypoints: ['README.md'] });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[1]).toMatchObject({ href: 'guide.md#missing', reason: expect.stringContaining('#missing') });
  });

  it('checks explicit GitHub source links locally only in source mode and never fetches URLs', () => {
    const root = fixture({ 'README.md': '[Source](https://github.com/ashlrai/ashlr-hub/blob/master/docs/source.md#overview) [Web](https://example.invalid/path)' });
    expect(checkDocumentation({ root, entrypoints: ['README.md'] }).ok).toBe(false);
    expect(checkDocumentation({ root, mode: 'package', entrypoints: ['README.md'] })).toMatchObject({
      ok: true, sourceLinks: 1, externalLinks: 1, externalRequests: 0,
    });
  });

  it('still rejects missing relative targets in package mode', () => {
    const root = fixture({ 'README.md': '[Unbundled](docs/source.md)' });
    expect(checkDocumentation({ root, mode: 'package', entrypoints: ['README.md'] }).ok).toBe(false);
  });

  it.each(['<a href=missing.md>Broken</a>', '<A HREF="missing.md">Broken</A>',
    '<img src="missing.png">', '<a title="quoted > text" href=missing.md>Broken</a>'])(
    'does not silently omit raw HTML file navigation: %s', (html) => {
      const root = fixture({ 'README.md': html });
      const result = checkDocumentation({ root, mode: 'package', entrypoints: ['README.md'] });
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.localLinks).toBe(1);
    },
  );

  it('accepts exact HTML anchors and quoted/unquoted attributes without treating data attributes or comments as anchors', () => {
    const root = fixture({
      'README.md': '[One](guide.md#explicit) [Two](guide.md#legacy) [Three](guide.md#numeric)',
      'guide.md': '<DIV ID=explicit></DIV>\n\n<A NAME="legacy"></A>\n\n<a id="num&#101;ric"></a>\n\n<!-- <a id="comment" href="missing.md"> -->\n\n<div data-id="data" title=\'id="title"\'></div>',
    });
    expect(checkDocumentation({ root, entrypoints: ['README.md', 'guide.md'] }).ok).toBe(true);
    const inspected = inspectMarkdown(readFileSync(join(root, 'guide.md'), 'utf8'));
    expect(inspected.anchors).toEqual(new Set(['explicit', 'legacy', 'numeric']));
    expect(inspected.links).toEqual([]);
    expect(inspected.errors).toEqual([]);
  });

  it('keeps comments inside quoted attributes as literal values', () => {
    expect(inspectMarkdown('<a href="<!--missing.md-->">Broken</a>').links).toEqual(['<!--missing.md-->']);
  });

  it.each(['<a id="first" id="second"></a>', '<a href="guide&copy;.md">Unsupported entity</a>'])(
    'refuses ambiguous unsupported HTML rather than claiming a valid check: %s', (html) => {
      const root = fixture({ 'README.md': html });
      const result = checkDocumentation({ root, entrypoints: ['README.md'] });
      expect(result.ok).toBe(false);
      expect(result.errors[0].href).toBeNull();
      expect(result.errors[0].reason).toMatch(/duplicate|unsupported/);
    },
  );

  it('refuses links outside the requested root, including symlink targets', () => {
    const root = fixture({ 'README.md': '[Traversal](../private.md) [Symlink](linked/private.md)' });
    const outside = fixture({ 'private.md': '# Private' });
    // A directory junction also exercises the boundary on Windows without symlink privileges.
    symlinkSync(outside, join(root, 'linked'), 'junction');
    const result = checkDocumentation({ root, entrypoints: ['README.md'] });
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].reason).toContain('escapes');
    expect(result.errors[1].reason).toContain('outside');
  });

  it('requires every operator entrypoint in the curated npm file list', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { files: string[] };
    for (const path of OPERATOR_DOCUMENTATION as string[]) {
      if (path !== 'README.md') expect(manifest.files).toContain(path);
    }
    expect(manifest.files).not.toContain('docs');
    expect(manifest.files).not.toContain('src');
    expect(OPERATOR_DOCUMENTATION).toHaveLength(9);
  });

  it('keeps checked source entrypoints and their heading targets navigable', () => {
    const result = checkDocumentation({ root: process.cwd() });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.externalRequests).toBe(0);
  });
});
