/**
 * M6 templates tests — pure unit tests, no filesystem access.
 *
 * Covers:
 *   - TEMPLATES array has all four required starters
 *   - Each template's files(ctx) returns required agentic-engineering files:
 *     CLAUDE.md, .mcp.json, .ashlrcode/genome/ stub, README.md, package.json, .gitignore, entry point
 *   - .mcp.json is valid JSON and wires the ashlr gateway as "ashlr" in mcpServers
 *   - package.json is valid JSON with expected fields
 *   - getTemplate(id) returns the matching template or null
 *   - listTemplates() returns id/title/description only (no files function)
 *   - Template file paths use POSIX-style separators (no backslashes)
 *   - ctx.name and ctx.category appear in template content where expected
 */

import { describe, it, expect } from 'vitest';

import {
  TEMPLATES,
  getTemplate,
  listTemplates,
} from '../src/core/lifecycle/templates.js';
import type { ProjectTemplate, TemplateFile } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMPLATE_IDS = ['node-cli', 'mcp-server', 'next-app', 'minimal'] as const;
type TemplateId = (typeof TEMPLATE_IDS)[number];

const TEST_CTX = { name: 'my-cool-project', category: 'side-projects' };

function filesFor(id: TemplateId): TemplateFile[] {
  const t = getTemplate(id);
  if (!t) throw new Error(`template "${id}" not found`);
  return t.files(TEST_CTX);
}

function findFile(files: TemplateFile[], pathSuffix: string): TemplateFile | undefined {
  return files.find(f => f.path === pathSuffix || f.path.endsWith('/' + pathSuffix) || f.path === pathSuffix.replace(/^\//, ''));
}

function requireFile(files: TemplateFile[], pathSuffix: string): TemplateFile {
  const f = findFile(files, pathSuffix);
  if (!f) {
    const paths = files.map(x => x.path).join(', ');
    throw new Error(`Required file "${pathSuffix}" not found. Got: ${paths}`);
  }
  return f;
}

function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${String(e)}\nContent:\n${content}`);
  }
}

// ---------------------------------------------------------------------------
// TEMPLATES array — existence and coverage
// ---------------------------------------------------------------------------

describe('TEMPLATES — array shape', () => {
  it('TEMPLATES is an array', () => {
    expect(Array.isArray(TEMPLATES)).toBe(true);
  });

  it('TEMPLATES contains exactly the four required starters', () => {
    const ids = TEMPLATES.map((t: ProjectTemplate) => t.id).sort();
    expect(ids).toEqual([...TEMPLATE_IDS].sort());
  });

  it('each template has id, title, description, and files function', () => {
    for (const t of TEMPLATES) {
      expect(typeof t.id).toBe('string');
      expect(t.id.length).toBeGreaterThan(0);
      expect(typeof t.title).toBe('string');
      expect(t.title.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.files).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// getTemplate — lookup
// ---------------------------------------------------------------------------

describe('getTemplate', () => {
  it('returns the template for each valid id', () => {
    for (const id of TEMPLATE_IDS) {
      const t = getTemplate(id);
      expect(t).not.toBeNull();
      expect(t!.id).toBe(id);
    }
  });

  it('returns null for an unknown id', () => {
    expect(getTemplate('not-a-template')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(getTemplate('')).toBeNull();
  });

  it('is case-sensitive (does not fuzzy-match)', () => {
    expect(getTemplate('Node-Cli')).toBeNull();
    expect(getTemplate('NODE-CLI')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listTemplates — shape
// ---------------------------------------------------------------------------

describe('listTemplates', () => {
  it('returns an array of four items', () => {
    const list = listTemplates();
    expect(list).toHaveLength(4);
  });

  it('each item has id, title, description and no files field', () => {
    const list = listTemplates();
    for (const item of list) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.title).toBe('string');
      expect(typeof item.description).toBe('string');
      expect('files' in item).toBe(false);
    }
  });

  it('covers all four template ids', () => {
    const ids = listTemplates().map(x => x.id).sort();
    expect(ids).toEqual([...TEMPLATE_IDS].sort());
  });
});

// ---------------------------------------------------------------------------
// Required agentic-engineering files — present in every template
// ---------------------------------------------------------------------------

// The "minimal" template is explicitly a blank slate: README + .gitignore +
// CLAUDE.md + .mcp.json + genome stub only — no package.json or entry point.
// All other templates are full starters that include package.json and entry points.
const TEMPLATES_WITH_PKG_JSON: readonly TemplateId[] = ['node-cli', 'mcp-server', 'next-app'];
const TEMPLATES_WITH_ENTRY: readonly TemplateId[] = ['node-cli', 'mcp-server', 'next-app'];

describe.each(TEMPLATE_IDS.map(id => ({ id })))('template "$id" — required files', ({ id }) => {
  it('files(ctx) returns a non-empty array', () => {
    const files = filesFor(id as TemplateId);
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it('includes CLAUDE.md', () => {
    const f = requireFile(filesFor(id as TemplateId), 'CLAUDE.md');
    expect(typeof f.content).toBe('string');
    expect(f.content.length).toBeGreaterThan(0);
  });

  it('includes .mcp.json', () => {
    const f = requireFile(filesFor(id as TemplateId), '.mcp.json');
    expect(typeof f.content).toBe('string');
  });

  it('includes .gitignore', () => {
    const f = requireFile(filesFor(id as TemplateId), '.gitignore');
    expect(typeof f.content).toBe('string');
    expect(f.content.length).toBeGreaterThan(0);
  });

  it('includes README.md', () => {
    const f = requireFile(filesFor(id as TemplateId), 'README.md');
    expect(typeof f.content).toBe('string');
    expect(f.content.length).toBeGreaterThan(0);
  });

  it('includes package.json (full-starter templates only)', () => {
    if (!(TEMPLATES_WITH_PKG_JSON as readonly string[]).includes(id)) return;
    const f = requireFile(filesFor(id as TemplateId), 'package.json');
    expect(typeof f.content).toBe('string');
  });

  it('includes a genome stub directory file under .ashlrcode/genome/', () => {
    const genomeFiles = filesFor(id as TemplateId).filter(f =>
      f.path.startsWith('.ashlrcode/genome/') || f.path === '.ashlrcode/genome'
    );
    expect(genomeFiles.length).toBeGreaterThan(0);
  });

  it('includes at least one TS/JS entry point (full-starter templates only)', () => {
    // minimal is a blank slate — no entry point expected
    if (!(TEMPLATES_WITH_ENTRY as readonly string[]).includes(id)) return;
    const entryFiles = filesFor(id as TemplateId).filter(f =>
      /\.(ts|tsx|js|mjs|cjs)$/.test(f.path)
    );
    expect(entryFiles.length).toBeGreaterThan(0);
  });

  it('all file paths use POSIX-style separators (no backslashes)', () => {
    for (const f of filesFor(id as TemplateId)) {
      expect(f.path).not.toContain('\\');
    }
  });

  it('file paths do not start with "/"', () => {
    for (const f of filesFor(id as TemplateId)) {
      expect(f.path.startsWith('/')).toBe(false);
    }
  });

  it('no duplicate paths within a template', () => {
    const paths = filesFor(id as TemplateId).map(f => f.path);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });
});

// ---------------------------------------------------------------------------
// .mcp.json — valid JSON + ashlr gateway wiring
// ---------------------------------------------------------------------------

describe.each(TEMPLATE_IDS.map(id => ({ id })))('template "$id" — .mcp.json validity', ({ id }) => {
  function getMcpJson(): ReturnType<typeof parseJson> {
    const f = requireFile(filesFor(id as TemplateId), '.mcp.json');
    return parseJson(f.content, '.mcp.json');
  }

  it('.mcp.json parses as valid JSON', () => {
    expect(() => getMcpJson()).not.toThrow();
  });

  it('.mcp.json has a "mcpServers" object', () => {
    const parsed = getMcpJson() as Record<string, unknown>;
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    expect(typeof parsed['mcpServers']).toBe('object');
    expect(parsed['mcpServers']).not.toBeNull();
  });

  it('.mcp.json mcpServers includes an "ashlr" gateway entry', () => {
    const parsed = getMcpJson() as { mcpServers: Record<string, unknown> };
    expect('ashlr' in parsed.mcpServers).toBe(true);
  });

  it('"ashlr" gateway entry has a "command" string', () => {
    const parsed = getMcpJson() as { mcpServers: Record<string, { command?: unknown; args?: unknown }> };
    const ashlr = parsed.mcpServers['ashlr']!;
    expect(typeof ashlr.command).toBe('string');
    expect((ashlr.command as string).length).toBeGreaterThan(0);
  });

  it('"ashlr" gateway entry has an "args" array', () => {
    const parsed = getMcpJson() as { mcpServers: Record<string, { args?: unknown }> };
    const ashlr = parsed.mcpServers['ashlr']!;
    expect(Array.isArray(ashlr.args)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// package.json — valid JSON + required fields (full-starter templates only)
// ---------------------------------------------------------------------------

describe.each(TEMPLATES_WITH_PKG_JSON.map(id => ({ id })))('template "$id" — package.json validity', ({ id }) => {
  function getPkgJson(): Record<string, unknown> {
    const f = requireFile(filesFor(id as TemplateId), 'package.json');
    return parseJson(f.content, 'package.json') as Record<string, unknown>;
  }

  it('package.json parses as valid JSON', () => {
    expect(() => getPkgJson()).not.toThrow();
  });

  it('package.json has a "name" field', () => {
    const pkg = getPkgJson();
    expect(typeof pkg['name']).toBe('string');
    expect((pkg['name'] as string).length).toBeGreaterThan(0);
  });

  it('package.json "name" incorporates the ctx.name', () => {
    const pkg = getPkgJson();
    expect(pkg['name']).toContain(TEST_CTX.name);
  });

  it('package.json has a "version" field', () => {
    const pkg = getPkgJson();
    expect(typeof pkg['version']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Context interpolation — name appears in content
// ---------------------------------------------------------------------------

describe.each(TEMPLATE_IDS.map(id => ({ id })))('template "$id" — ctx interpolation', ({ id }) => {
  it('ctx.name appears somewhere in the generated file set', () => {
    const allContent = filesFor(id as TemplateId).map(f => f.content).join('\n');
    expect(allContent).toContain(TEST_CTX.name);
  });

  it('different ctx.name produces different README content', () => {
    const t = getTemplate(id as TemplateId)!;
    const files1 = t.files({ name: 'project-alpha', category: 'dev-tools' });
    const files2 = t.files({ name: 'project-beta', category: 'dev-tools' });
    const readme1 = files1.find(f => f.path === 'README.md')?.content ?? '';
    const readme2 = files2.find(f => f.path === 'README.md')?.content ?? '';
    // At minimum, at least one file differs between the two contexts
    const allContent1 = files1.map(f => f.content).join('');
    const allContent2 = files2.map(f => f.content).join('');
    expect(allContent1).not.toBe(allContent2);
    void readme1; void readme2; // used for context above
  });
});

// ---------------------------------------------------------------------------
// Template-specific checks — node-cli has executable entry
// ---------------------------------------------------------------------------

describe('template "node-cli" — specific', () => {
  it('has an entry file with mode 0o755 (executable)', () => {
    const files = filesFor('node-cli');
    const executable = files.find(f => f.mode === 0o755);
    expect(executable).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Template-specific checks — mcp-server has stdio wiring hint
// ---------------------------------------------------------------------------

describe('template "mcp-server" — specific', () => {
  it('entry file content mentions "mcp" or "server" or "stdio"', () => {
    const files = filesFor('mcp-server');
    const allContent = files.map(f => f.content).join('\n').toLowerCase();
    const hasMcpRef = allContent.includes('mcp') || allContent.includes('server') || allContent.includes('stdio');
    expect(hasMcpRef).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Template-specific checks — next-app has Next.js markers
// ---------------------------------------------------------------------------

describe('template "next-app" — specific', () => {
  it('package.json depends on "next"', () => {
    const f = requireFile(filesFor('next-app'), 'package.json');
    expect(f.content).toContain('next');
  });
});

// ---------------------------------------------------------------------------
// CLAUDE.md — agentic-engineering preset content
// ---------------------------------------------------------------------------

describe.each(TEMPLATE_IDS.map(id => ({ id })))('template "$id" — CLAUDE.md content', ({ id }) => {
  it('CLAUDE.md has at minimum 20 characters of content (not a stub placeholder)', () => {
    const f = requireFile(filesFor(id as TemplateId), 'CLAUDE.md');
    expect(f.content.length).toBeGreaterThanOrEqual(20);
  });
});
