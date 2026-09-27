/**
 * 3.15 — repo wiki units: citation verification/canonicalisation, the page
 * scrub (secrets out, cited paths intact), model-output parsing, steering
 * (Ashlr + Devin formats), module grouping and git-tree parsing.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { citationLink, collectCitations, parseCitationHref, verifyCitations, type CitationResolver } from '../src/core/knowledge/wiki/citations.js';
import { scrubWikiText } from '../src/core/knowledge/wiki/scrub.js';
import { parseModelMarkdown, numberedExcerpt } from '../src/core/knowledge/wiki/render.js';
import { readWikiSteering } from '../src/core/knowledge/wiki/steering.js';
import { groupModules, resolveSpecifier } from '../src/core/knowledge/wiki/facts.js';
import { isWikiReadable, parseGithubRemote, parseLsTree } from '../src/core/knowledge/wiki/scan.js';
import { answerable, pageSections, rankPassages, tokenizeQuery, type Passage } from '../src/core/knowledge/wiki/ask.js';

const LINES: Record<string, number> = {
  'src/server.ts': 40,
  'src/store/notes.ts': 12,
  'src/core/verse/adapters/claudeSessionAdapterRegistry.ts': 90,
  'docs/a b (draft).md': 5,
};
const resolver: CitationResolver = { files: Object.keys(LINES), lines: (rel) => LINES[rel] ?? null };

describe('verifyCitations', () => {
  it('keeps real file:line citations in every common shape and canonicalises them', async () => {
    const md = [
      'Bare src/server.ts:5 and a range src/server.ts:10-12.',
      'Inline code `src/store/notes.ts:3`, bracketed [src/server.ts:7], anchor src/server.ts#L8-L9.',
      'A model link [the store](src/store/notes.ts:4).',
    ].join('\n');
    const out = await verifyCitations(md, resolver);
    expect(out.dropped).toBe(0);
    expect(out.citations.map((c) => `${c.file}:${c.line}${c.endLine ? `-${c.endLine}` : ''}`)).toEqual([
      'src/store/notes.ts:4',
      'src/server.ts:5',
      'src/server.ts:10-12',
      'src/store/notes.ts:3',
      'src/server.ts:7',
      'src/server.ts:8-9',
    ]);
    expect(out.markdown).toContain('[src/server.ts:10-12](#cite:src/server.ts:10-12)');
    expect(out.markdown).not.toContain('[[');
  });

  it('drops the line from citations that do not verify, and counts them', async () => {
    const out = await verifyCitations('See src/server.ts:41, src/nope.ts:1 and src/store/notes.ts:0.', resolver);
    expect(out.citations).toEqual([]);
    expect(out.dropped).toBe(3);
    expect(out.markdown).toContain('`src/server.ts`');
    expect(out.markdown).not.toContain('#cite:');
  });

  it('resolves a unique basename and clamps an overlong range', async () => {
    const out = await verifyCitations('notes.ts:2-99', resolver);
    expect(out.citations).toEqual([{ file: 'src/store/notes.ts', line: 2, endLine: 12 }]);
  });

  it('leaves fenced code alone and is idempotent over its own output', async () => {
    const md = 'Prose src/server.ts:1\n\n```ts\nconst x = "src/server.ts:2";\n```\n';
    const once = await verifyCitations(md, resolver);
    const twice = await verifyCitations(once.markdown, resolver);
    expect(twice.markdown).toBe(once.markdown);
    expect(once.markdown).toContain('const x = "src/server.ts:2";');
    expect(once.citations).toHaveLength(1);
  });

  it('never matches URLs or hostnames with ports as citations', async () => {
    const out = await verifyCitations('Visit http://example.com:8080/x or localhost.test:3000.', resolver);
    expect(out.citations).toEqual([]);
    expect(out.markdown).toContain('http://example.com:8080/x');
  });

  it('round-trips hrefs with spaces and parentheses; refuses traversal', () => {
    const link = citationLink({ file: 'docs/a b (draft).md', line: 2 });
    const href = /\]\(([^)]+)\)$/.exec(link)![1]!;
    expect(parseCitationHref(href)).toEqual({ file: 'docs/a b (draft).md', line: 2 });
    expect(parseCitationHref('#cite:../etc/passwd:1')).toBeNull();
    expect(parseCitationHref('#cite:/etc/passwd:1')).toBeNull();
    expect(collectCitations(`x ${link} y`)).toHaveLength(1);
  });
});

// Assembled at runtime so no secret-shaped literal is committed (push protection).
const STRIPE = ['sk', 'live', '51HabcdefghijklmnopQRSTUV'].join('_');
const AWS = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

describe('scrubWikiText', () => {
  it('redacts secrets (shared + strict sets) but keeps verified citations and known paths', () => {
    const long = 'src/core/verse/adapters/claudeSessionAdapterRegistry.ts';
    const text = [
      `Key ${STRIPE} and ghp_${'a'.repeat(36)} and ${AWS}.`,
      citationLink({ file: long, line: 3 }),
      `\`${long}\``,
      '`src/core/verse/adapters/claudeSessionAdapterRegistry`',
    ].join('\n');
    const out = scrubWikiText(text, new Set([long, 'src/core/verse/adapters/claudeSessionAdapterRegistry']));
    expect(out).not.toContain(STRIPE.slice(0, 14));
    expect(out).not.toContain('ghp_aaaa');
    expect(out).not.toContain(AWS);
    expect(out).toContain(`(#cite:${long}:3)`);
    expect(out).toContain(`\`${long}\``);
    expect(out).toContain('`src/core/verse/adapters/claudeSessionAdapterRegistry`');
  });

  it('does not protect an unknown code span that is secret-shaped', () => {
    const blob = 'A'.repeat(20) + '/' + 'b'.repeat(30);
    expect(scrubWikiText(`\`${blob}\``)).not.toContain(blob);
  });
});

describe('parseModelMarkdown', () => {
  it('accepts JSON (the local transport), fenced JSON, and plain text; strips a leading title', () => {
    expect(parseModelMarkdown('{"markdown":"# T\\n\\nBody"}')).toBe('Body');
    expect(parseModelMarkdown('```json\n{"markdown":"Body"}\n```')).toBe('Body');
    expect(parseModelMarkdown('Sure! {"markdown":"Body"} hope that helps')).toBe('Body');
    expect(parseModelMarkdown('Plain **text**')).toBe('Plain **text**');
    expect(parseModelMarkdown('{"answer":"A","found":true}', 'answer')).toBe('A');
    expect(parseModelMarkdown('{"other":1}')).toBe('');
  });

  it('numbers excerpt lines so a model can cite them exactly', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    const ex = numberedExcerpt(text, [50], 10_000);
    expect(ex).toContain('  50| line 50');
    expect(ex).not.toContain('   1| line 1\n');
  });
});

describe('readWikiSteering', () => {
  it('merges .ashlr/wiki.json over .devin/wiki.json and bounds what it reads', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wiki-steer-'));
    try {
      mkdirSync(path.join(dir, '.ashlr'));
      mkdirSync(path.join(dir, '.devin'));
      writeFileSync(path.join(dir, '.ashlr', 'wiki.json'), JSON.stringify({ exclude: ['data'], focus: ['src/x'], ignorePaths: ['legacy/', '../escape', '/abs'], localOnly: true, maxPages: 999 }));
      writeFileSync(path.join(dir, '.devin', 'wiki.json'), JSON.stringify({ repo_notes: [{ content: 'note\u0000 one' }], pages: [{ title: 'Auth', purpose: 'p', page_notes: [{ content: 'pn' }] }] }));
      const s = await readWikiSteering(dir);
      expect(s.exclude).toEqual(['data']);
      expect(s.focus).toEqual(['src/x']);
      expect(s.ignorePaths).toEqual(['legacy/']);
      expect(s.localOnly).toBe(true);
      expect(s.maxPages).toBe(80);
      expect(s.notes).toEqual(['note one']);
      expect(s.pages).toEqual([{ title: 'Auth', purpose: 'p', notes: ['pn'] }]);
      // Ashlr steering present without include/pages: Devin pages still define the wiki.
      expect(s.devinDefinesPages).toBe(true);
      expect(s.sources).toEqual(['.ashlr/wiki.json', '.devin/wiki.json']);

      writeFileSync(path.join(dir, '.ashlr', 'wiki.json'), '{not json');
      const broken = await readWikiSteering(dir);
      expect(broken.localOnly).toBe(false);
      expect(broken.pages).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scan + facts helpers', () => {
  it('never lists secret files, lockfiles, binaries, vendored dirs or symlinks', () => {
    for (const bad of ['.env', '.env.production', 'config/.npmrc', 'id_rsa', 'certs/server.pem', 'package-lock.json', 'node_modules/x/index.js', 'logo.png', '../x.ts']) {
      expect(isWikiReadable(bad), bad).toBe(false);
    }
    expect(isWikiReadable('src/app.ts')).toBe(true);
    const raw = [
      '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa      12\tsrc/a.ts',
      '120000 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb      10\tsrc/link.ts',
      '160000 commit cccccccccccccccccccccccccccccccccccccccc       -\tvendor/sub',
      '100644 blob dddddddddddddddddddddddddddddddddddddddd      40\t.env',
      '100644 blob eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee       7\tlegacy/old.ts',
    ].join('\0') + '\0';
    expect(parseLsTree(raw, ['legacy/']).files.map((f) => f.rel)).toEqual(['src/a.ts']);
  });

  it('groups modules adaptively and resolves NodeNext .js specifiers to .ts', () => {
    const files = [
      'README.md',
      ...Array.from({ length: 40 }, (_, i) => `src/core/run/f${i}.ts`),
      ...Array.from({ length: 5 }, (_, i) => `src/core/util/u${i}.ts`),
      'src/cli/index.ts',
    ];
    const groups = groupModules(files);
    expect([...groups.keys()].sort()).toEqual(['(root)', 'src/cli', 'src/core/run', 'src/core/util']);
    const known = new Set(files);
    expect(resolveSpecifier('src/cli/index.ts', '../core/util/u1.js', known)).toBe('src/core/util/u1.ts');
    expect(resolveSpecifier('src/cli/index.ts', 'express', known)).toBeNull();
  });

  it('recognises GitHub remotes only', () => {
    expect(parseGithubRemote('git@github.com:ashlrai/ashlr-hub.git')).toBe('ashlrai/ashlr-hub');
    expect(parseGithubRemote('https://github.com/ashlrai/ashlr-hub')).toBe('ashlrai/ashlr-hub');
    expect(parseGithubRemote('https://gitlab.com/a/b.git')).toBeNull();
  });
});

describe('ask retrieval', () => {
  const mk = (via: Passage['via'], title: string, text: string): Passage => ({
    repo: '/r', repoName: 'r', repoKey: 'r-000000000000', via, title, text, cite: { file: 'src/a.ts', line: 1 }, tokens: tokenizeQuery(`${title} ${text}`),
  });

  it('splits camelCase, drops stopwords, and ranks the covering passage first', () => {
    expect(tokenizeQuery('Where does saveNote write?')).toEqual(['sav', 'not', 'writ']);
    expect(new Set(tokenizeQuery('notes saved'))).toEqual(new Set(tokenizeQuery('saveNote')));
    expect(tokenizeQuery('invoices created')).toEqual(['invoic', 'creat']);
    const ranked = rankPassages('how are notes saved to sqlite', [
      mk('index', 'src/a.ts:1-10', 'function render() {}'),
      mk('wiki', 'Data stores', 'Notes are saved to SQLite via better-sqlite3.'),
    ]);
    expect(ranked[0]!.passage.title).toBe('Data stores');
    expect(answerable(ranked[0], 4)).toBe(true);
  });

  it('refuses to answer when coverage is too thin', () => {
    const ranked = rankPassages('kubernetes helm chart deployment rollout', [mk('wiki', 'Overview', 'A notes service. Deployment is manual.')]);
    expect(answerable(ranked[0], 5)).toBe(false);
  });

  it('splits pages into heading sections', () => {
    expect(pageSections('# T\n\n> p\n\nIntro\n\n## Reference\n\nrows').map((s) => s.heading)).toEqual(['T', 'Reference']);
  });
});
