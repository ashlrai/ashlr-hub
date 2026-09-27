/**
 * wiki/facts.ts — deterministic repo facts, every one carrying a file:line.
 *
 * The wiki's backbone. Each page is (optional) model prose ON TOP OF these
 * facts, and each fact is cited from a line we actually read — so even with no
 * model at all ("facts-only"), the wiki is a correct, cited map of the repo:
 * module map + internal import graph, entrypoints, commands, data stores,
 * HTTP routes, environment variables and tests.
 *
 * Bounded: at most MAX_READ_FILES files / MAX_READ_TOTAL bytes are read per
 * repo, highest-value files first (manifests, README, shallow source).
 */

import path from 'node:path';

import type { WikiCitation, WikiFileIndex } from './types.js';
import { isSourceFile, isTestFile, languageOf, readRepoText, type RepoScan } from './scan.js';

const MAX_READ_FILES = 1600;
const MAX_READ_TOTAL = 16 * 1024 * 1024;
const READ_CONCURRENCY = 8;
const MAX_MODULES = 48;
const MODULE_SPLIT_AT = 36;
const MODULE_MAX_DEPTH = 4;
const MAX_EXPORTS_PER_MODULE = 14;
const MAX_HITS_PER_STORE = 4;
const MAX_ROUTES = 40;
const MAX_ENV = 40;

export interface CitedText {
  text: string;
  cite: WikiCitation;
}

export interface ModuleExport {
  name: string;
  kind: string;
  file: string;
  line: number;
}

export interface ModuleInfo {
  /** Directory key, e.g. `src/core/run` or `(root)`. */
  key: string;
  files: string[];
  sourceFiles: number;
  testFiles: number;
  /** Lines of the files that were read (partial on big repos). */
  lines: number;
  /** Bytes of every listed file (always complete — from the git tree). */
  bytes: number;
  /** Source files, most-imported (by other modules) first. */
  topFiles: string[];
  exports: ModuleExport[];
  /** module key -> number of import statements pointing there. */
  importsFrom: Record<string, number>;
  importedBy: Record<string, number>;
  /** External packages imported (bounded). */
  packages: string[];
  /** A likely entry file for the module (index.*, main.*, or the largest file). */
  entry: string | null;
}

export interface DataStoreHit {
  kind: string;
  label: string;
  cite: WikiCitation;
  snippet: string;
}

export interface RouteHit {
  method: string;
  route: string;
  cite: WikiCitation;
}

export interface RepoFacts {
  name: string;
  head: string | null;
  fileCount: number;
  truncated: boolean;
  description: CitedText | null;
  readme: { title: string; summary: string; cite: WikiCitation } | null;
  languages: Array<{ language: string; files: number }>;
  manifests: string[];
  scripts: Array<{ name: string; command: string; cite: WikiCitation }>;
  bins: Array<{ name: string; target: string; cite: WikiCitation }>;
  makeTargets: Array<{ name: string; cite: WikiCitation }>;
  entrypoints: Array<{ file: string; why: string; cite: WikiCitation }>;
  modules: ModuleInfo[];
  dataStores: DataStoreHit[];
  routes: RouteHit[];
  envVars: Array<{ name: string; cite: WikiCitation }>;
  tests: { files: number; dirs: string[]; runner: string | null };
  /** Line counts of every file read — the citation verifier's ground truth. */
  lineIndex: WikiFileIndex;
  /** Text of every file read (in-memory only; never persisted). */
  texts: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml',
  'build.gradle', 'Makefile', 'justfile', 'Justfile', 'Dockerfile', 'docker-compose.yml', 'compose.yaml',
  'tsconfig.json', 'deno.json', 'vite.config.ts', 'next.config.js', 'next.config.mjs', 'schema.prisma',
]);

function depthOf(rel: string): number {
  return rel.split('/').length - 1;
}

const PRIMARY_ROOTS = /^(src|lib|app|apps|packages|internal|pkg|cmd|server|client|api|crates|core)\//;
const TOOLING_FILE = /(^|\/)(eslint|prettier|vite|vitest|jest|webpack|rollup|babel|tsup|playwright|tailwind|postcss)[.\w-]*\.(c|m)?[jt]s$/;
const NON_PRODUCT = /^(examples?|fixtures?|benchmarks?|bench|docs?|scripts|tools|test|tests|e2e)\//;

function isPrimarySource(rel: string): boolean {
  return PRIMARY_ROOTS.test(rel) || (depthOf(rel) === 0 && isSourceFile(rel));
}

/** Order files by how much they tell us about the architecture. */
function readPriority(rel: string): number {
  const base = path.basename(rel);
  if (depthOf(rel) === 0 && /^readme(\.|$)/i.test(base)) return 0;
  if (MANIFEST_NAMES.has(base) && depthOf(rel) <= 2) return 1;
  if (base === 'schema.prisma' || /(^|\/)migrations?\//.test(rel)) return 2;
  // Product source (src/, lib/, app/, packages/ …) before tooling and examples.
  if (isSourceFile(rel) && !isTestFile(rel)) return (isPrimarySource(rel) ? 3 : 4.5) + Math.min(depthOf(rel), 6) / 10;
  if (isTestFile(rel)) return 6;
  if (/\.(md|mdx)$/i.test(rel)) return 7;
  return 8;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function readSelected(scan: RepoScan): Promise<Map<string, string>> {
  const ordered = [...scan.files]
    .filter((f) => f.size <= 256 * 1024)
    .sort((a, b) => readPriority(a.rel) - readPriority(b.rel) || a.rel.localeCompare(b.rel));
  const chosen: string[] = [];
  let total = 0;
  for (const f of ordered) {
    if (chosen.length >= MAX_READ_FILES) break;
    if (total + f.size > MAX_READ_TOTAL) continue;
    // Only text we can use: source, manifests, docs, config, sql.
    if (readPriority(f.rel) >= 8 && !/\.(json|ya?ml|toml|sql|prisma|graphql|proto)$/i.test(f.rel)) continue;
    chosen.push(f.rel);
    total += f.size;
  }
  const texts = new Map<string, string>();
  const read = await mapLimit(chosen, READ_CONCURRENCY, async (rel) => [rel, await readRepoText(scan.repo, rel)] as const);
  for (const [rel, text] of read) if (text !== null) texts.set(rel, text);
  return texts;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

/** First line (1-based) at or after `from` whose text contains `needle`. */
function findLine(lines: readonly string[], needle: string, from = 0): number | null {
  for (let i = from; i < lines.length; i++) if (lines[i]!.includes(needle)) return i + 1;
  return null;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// Modules (adaptive directory grouping)
// ---------------------------------------------------------------------------

function dirKey(rel: string, depth: number): string {
  const parts = rel.split('/').slice(0, -1);
  if (parts.length === 0) return '(root)';
  return parts.slice(0, Math.min(depth, parts.length)).join('/');
}

/**
 * Group files into modules: start at top-level directories and split any group
 * bigger than MODULE_SPLIT_AT into its subdirectories, down to depth 4 — so a
 * monorepo's `src/core` becomes `src/core/run`, `src/core/verse`, … while a
 * small repo stays one module per folder.
 */
export function groupModules(files: readonly string[]): Map<string, string[]> {
  const assign = new Map<string, number>();
  for (const f of files) assign.set(f, 1);
  for (let depth = 1; depth < MODULE_MAX_DEPTH; depth++) {
    const groups = new Map<string, string[]>();
    for (const f of files) {
      if (assign.get(f) !== depth) continue;
      const key = dirKey(f, depth);
      const list = groups.get(key) ?? [];
      list.push(f);
      groups.set(key, list);
    }
    for (const [key, list] of groups) {
      if (key === '(root)' || list.length <= MODULE_SPLIT_AT) continue;
      // Split only when there is somewhere deeper to go.
      if (!list.some((f) => depthOf(f) > depth)) continue;
      for (const f of list) assign.set(f, depth + 1);
    }
  }
  const out = new Map<string, string[]>();
  for (const f of files) {
    const key = dirKey(f, assign.get(f)!);
    const list = out.get(key) ?? [];
    list.push(f);
    out.set(key, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Imports + exports (regex; fast, bounded, language-light)
// ---------------------------------------------------------------------------

const JS_IMPORT_RES = [
  /\bimport\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:type\s+)?[^'"`;]*?\s+from\s+['"]([^'"\n]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

export function extractSpecifiers(source: string, rel: string): string[] {
  const out = new Set<string>();
  const ext = path.extname(rel).toLowerCase();
  if (/^\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(ext)) {
    for (const re of JS_IMPORT_RES) {
      re.lastIndex = 0;
      for (const m of source.matchAll(re)) if (m[1]) out.add(m[1]);
    }
  } else if (ext === '.py') {
    for (const m of source.matchAll(/^from\s+([\w.]+)\s+import\b/gm)) if (m[1]) out.add(m[1]);
    for (const m of source.matchAll(/^import\s+([\w.]+)/gm)) if (m[1]) out.add(m[1]);
  } else if (ext === '.go') {
    for (const m of source.matchAll(/^\s*(?:import\s+)?(?:\w+\s+)?"([\w./-]+)"\s*$/gm)) if (m[1]) out.add(m[1]);
  } else if (ext === '.rs') {
    for (const m of source.matchAll(/^\s*use\s+(crate|super)::([\w:]+)/gm)) if (m[2]) out.add(`${m[1]}::${m[2]}`);
  }
  return [...out];
}

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/** Resolve a relative JS/TS specifier to a listed file (handles NodeNext `.js` → `.ts`). */
export function resolveSpecifier(fromRel: string, spec: string, known: ReadonlySet<string>): string | null {
  let target: string;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    target = path.posix.normalize(`src/${spec.slice(2)}`);
  } else {
    return null;
  }
  if (target.startsWith('..')) return null;
  const stems = [target];
  const jsExt = /\.(m|c)?js$/.exec(target);
  if (jsExt) stems.push(target.slice(0, -jsExt[0].length));
  for (const stem of stems) {
    for (const ext of RESOLVE_EXTS) {
      if (known.has(stem + ext)) return stem + ext;
    }
  }
  return null;
}

function packageNameOf(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('@/') || spec.startsWith('~/')) return null;
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0] ?? null;
}

const EXPORT_RES: Array<{ ext: RegExp; re: RegExp; kindIdx: number; nameIdx: number }> = [
  { ext: /\.(ts|tsx|mts|js|jsx|mjs|cjs)$/, re: /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kindIdx: 1, nameIdx: 2 },
  { ext: /\.py$/, re: /^(def|class|async def)\s+([A-Za-z_]\w*)/, kindIdx: 1, nameIdx: 2 },
  { ext: /\.go$/, re: /^(func|type)\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/, kindIdx: 1, nameIdx: 2 },
  { ext: /\.rs$/, re: /^pub\s+(?:async\s+)?(fn|struct|enum|trait|mod)\s+(\w+)/, kindIdx: 1, nameIdx: 2 },
];

function extractExports(text: string, rel: string): ModuleExport[] {
  const rule = EXPORT_RES.find((r) => r.ext.test(rel));
  if (!rule) return [];
  const out: ModuleExport[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < 40; i++) {
    const m = rule.re.exec(lines[i]!);
    if (!m) continue;
    const name = m[rule.nameIdx]!;
    if (rule.ext.source.includes('py') && name.startsWith('_')) continue;
    out.push({ name, kind: m[rule.kindIdx]!.replace('function*', 'function'), file: rel, line: i + 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pattern scans: data stores, routes, env vars
// ---------------------------------------------------------------------------

const STORE_PATTERNS: Array<{ kind: string; label: string; re: RegExp }> = [
  { kind: 'sqlite', label: 'SQLite', re: /better-sqlite3|(?:from|require\()\s*['"]sqlite3['"]|bun:sqlite|node:sqlite|[\w-]\.sqlite3?['"]|\bsqlite3\.connect\(/ },
  { kind: 'postgres', label: 'Postgres', re: /['"]pg['"]|['"]postgres['"]|postgres(?:ql)?:\/\/|@neondatabase\/|drizzle-orm\/pg|psycopg|asyncpg/ },
  { kind: 'prisma', label: 'Prisma', re: /@prisma\/client|^\s*datasource\s+\w+\s*\{/ },
  { kind: 'mysql', label: 'MySQL', re: /['"]mysql2?['"]|mysql:\/\// },
  { kind: 'redis', label: 'Redis', re: /['"]ioredis['"]|['"]redis['"]|@upstash\/redis|redis:\/\// },
  { kind: 'mongo', label: 'MongoDB', re: /['"]mongodb['"]|['"]mongoose['"]|mongodb(?:\+srv)?:\/\// },
  { kind: 'supabase', label: 'Supabase', re: /@supabase\/supabase-js|createClient\([^)]*supabase/i },
  { kind: 'object-store', label: 'Object storage', re: /@aws-sdk\/client-s3|@vercel\/blob|@google-cloud\/storage/ },
  { kind: 'kv', label: 'KV store', re: /@vercel\/kv|Deno\.openKv|from\s+['"]lmdb['"]|from\s+['"]level['"]/ },
  { kind: 'home-state', label: 'Files under the home directory', re: /(homedir\(\)|os\.homedir\(\)|expanduser\(['"]~)[^\n]{0,80}['"][.\w/-]+['"]/ },
  { kind: 'jsonl', label: 'JSON / JSONL files', re: /['"`][\w./${}-]*\.jsonl['"`]/ },
  { kind: 'browser-storage', label: 'Browser storage', re: /\b(localStorage|sessionStorage|indexedDB)\b/ },
  { kind: 'migrations', label: 'SQL schema / migrations', re: /^\s*CREATE\s+TABLE\b/i },
];

const ROUTE_RES: RegExp[] = [
  /\b(?:app|router|server|fastify|hono|api|r)\.(get|post|put|patch|delete|all|use)\(\s*['"`](\/[^'"`\s]*)['"`]/g,
  /@(Get|Post|Put|Patch|Delete)\(\s*['"](\/?[^'"]*)['"]\s*\)/g,
  /@(?:app|router|bp)\.(get|post|put|patch|delete|route)\(\s*['"](\/[^'"]*)['"]/g,
];
const API_LITERAL_RE = /['"`](\/api\/[A-Za-z0-9_\-/:{}.]*)['"`]/g;

const ENV_RES: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]{1,63})\b/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]{1,63})['"]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]{1,63})\b/g,
  /os\.environ(?:\.get)?[[(]\s*['"]([A-Z][A-Z0-9_]{1,63})['"]/g,
  /os\.Getenv\(\s*"([A-Z][A-Z0-9_]{1,63})"/g,
  /Deno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]{1,63})['"]/g,
  /env::var\(\s*"([A-Z][A-Z0-9_]{1,63})"/g,
];

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

interface ManifestFacts {
  description: CitedText | null;
  scripts: RepoFacts['scripts'];
  bins: RepoFacts['bins'];
  entry: RepoFacts['entrypoints'];
  runner: string | null;
}

function packageJsonFacts(rel: string, text: string): ManifestFacts {
  const out: ManifestFacts = { description: null, scripts: [], bins: [], entry: [], runner: null };
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return out;
  }
  const lines = text.split('\n');
  if (typeof pkg['description'] === 'string' && pkg['description'].trim()) {
    const line = findLine(lines, '"description"') ?? 1;
    out.description = { text: clip(pkg['description'], 300), cite: { file: rel, line } };
  }
  const scripts = pkg['scripts'];
  if (scripts && typeof scripts === 'object') {
    const start = (findLine(lines, '"scripts"') ?? 1) - 1;
    for (const [name, cmd] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof cmd !== 'string') continue;
      const line = findLine(lines, `"${name}"`, start) ?? start + 1;
      out.scripts.push({ name, command: clip(cmd, 160), cite: { file: rel, line } });
      if (out.scripts.length >= 60) break;
    }
    const test = (scripts as Record<string, unknown>)['test'];
    if (typeof test === 'string') {
      out.runner = /vitest/.test(test) ? 'vitest' : /jest/.test(test) ? 'jest' : /mocha/.test(test) ? 'mocha' : /node --test/.test(test) ? 'node:test' : /pytest/.test(test) ? 'pytest' : null;
    }
  }
  const bin = pkg['bin'];
  if (typeof bin === 'string') {
    out.bins.push({ name: typeof pkg['name'] === 'string' ? pkg['name'] : 'bin', target: bin, cite: { file: rel, line: findLine(lines, '"bin"') ?? 1 } });
  } else if (bin && typeof bin === 'object') {
    const start = (findLine(lines, '"bin"') ?? 1) - 1;
    for (const [name, target] of Object.entries(bin as Record<string, unknown>)) {
      if (typeof target !== 'string') continue;
      out.bins.push({ name, target, cite: { file: rel, line: findLine(lines, `"${name}"`, start) ?? start + 1 } });
    }
  }
  for (const field of ['main', 'module']) {
    const v = pkg[field];
    if (typeof v === 'string') out.entry.push({ file: v.replace(/^\.\//, ''), why: `package.json "${field}"`, cite: { file: rel, line: findLine(lines, `"${field}"`) ?? 1 } });
  }
  return out;
}

function makefileTargets(rel: string, text: string): RepoFacts['makeTargets'] {
  const out: RepoFacts['makeTargets'] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < 40; i++) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(lines[i]!);
    if (m && m[1] !== '.PHONY') out.push({ name: m[1]!, cite: { file: rel, line: i + 1 } });
  }
  return out;
}

function pyprojectFacts(rel: string, text: string): Pick<ManifestFacts, 'description' | 'scripts'> {
  const lines = text.split('\n');
  const out: Pick<ManifestFacts, 'description' | 'scripts'> = { description: null, scripts: [] };
  const desc = lines.findIndex((l) => /^description\s*=\s*["']/.test(l));
  if (desc >= 0) out.description = { text: clip(lines[desc]!.replace(/^description\s*=\s*/, '').replace(/^["']|["']$/g, ''), 300), cite: { file: rel, line: desc + 1 } };
  const start = lines.findIndex((l) => /^\[project\.scripts\]|^\[tool\.poetry\.scripts\]/.test(l.trim()));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length && !lines[i]!.trim().startsWith('['); i++) {
      const m = /^([\w.-]+)\s*=\s*["']([^"']+)["']/.exec(lines[i]!.trim());
      if (m) out.scripts.push({ name: m[1]!, command: m[2]!, cite: { file: rel, line: i + 1 } });
    }
  }
  return out;
}

function readmeFacts(rel: string, text: string): RepoFacts['readme'] {
  const lines = text.split('\n');
  let title = '';
  let titleLine = 1;
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^#\s+(.+)/.exec(lines[i]!);
    if (m) {
      title = m[1]!.replace(/<[^>]+>/g, '').trim();
      titleLine = i + 1;
      i++;
      break;
    }
  }
  if (!title) i = 0;
  const para: string[] = [];
  let paraStart = 0;
  for (; i < lines.length && para.length < 8; i++) {
    const l = lines[i]!.trim();
    const isNoise = !l || l.startsWith('#') || l.startsWith('![') || l.startsWith('[![') || l.startsWith('<') || l.startsWith('```') || l.startsWith('|') || l.startsWith('---');
    if (isNoise) {
      if (para.length > 0) break;
      continue;
    }
    if (para.length === 0) paraStart = i + 1;
    para.push(l);
  }
  if (!title && para.length === 0) return null;
  return { title: title || path.basename(path.dirname(rel)), summary: clip(para.join(' '), 600), cite: { file: rel, line: para.length > 0 ? paraStart : titleLine } };
}

// ---------------------------------------------------------------------------
// extractFacts
// ---------------------------------------------------------------------------

export async function extractFacts(scan: RepoScan): Promise<RepoFacts> {
  const texts = await readSelected(scan);
  const all = scan.files.map((f) => f.rel);
  const known = new Set(all);
  const lineIndex: WikiFileIndex = {};
  for (const [rel, text] of texts) lineIndex[rel] = countLines(text);

  // Languages.
  const langCount = new Map<string, number>();
  for (const rel of all) {
    const lang = languageOf(rel);
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
  }
  const languages = [...langCount].map(([language, files]) => ({ language, files })).sort((a, b) => b.files - a.files).slice(0, 8);

  // Manifests + README.
  const manifests = all.filter((rel) => MANIFEST_NAMES.has(path.basename(rel)) && depthOf(rel) <= 2);
  let description: CitedText | null = null;
  let readme: RepoFacts['readme'] = null;
  const scripts: RepoFacts['scripts'] = [];
  const bins: RepoFacts['bins'] = [];
  const makeTargets: RepoFacts['makeTargets'] = [];
  const entrypoints: RepoFacts['entrypoints'] = [];
  let runner: string | null = null;

  const readmeRel = all.find((rel) => depthOf(rel) === 0 && /^readme(\.md|\.markdown|\.rst|\.txt)?$/i.test(rel));
  if (readmeRel && texts.has(readmeRel)) readme = readmeFacts(readmeRel, texts.get(readmeRel)!);

  for (const rel of manifests) {
    const text = texts.get(rel);
    if (text === undefined) continue;
    const base = path.basename(rel);
    if (base === 'package.json') {
      const f = packageJsonFacts(rel, text);
      // The root package.json describes the repo; nested ones only add commands.
      if (depthOf(rel) === 0) {
        description = description ?? f.description;
        runner = runner ?? f.runner;
        entrypoints.push(...f.entry.filter((e) => known.has(e.file) || known.has(e.file.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'))));
      }
      scripts.push(...f.scripts.filter(() => depthOf(rel) === 0 || scripts.length < 80));
      bins.push(...f.bins);
    } else if (base === 'Makefile' || base === 'justfile' || base === 'Justfile') {
      makeTargets.push(...makefileTargets(rel, text));
    } else if (base === 'pyproject.toml') {
      const f = pyprojectFacts(rel, text);
      description = description ?? f.description;
      scripts.push(...f.scripts);
    }
  }

  // Bins are entrypoints too. Map a built `dist/*.js` target back to its
  // source, and follow a launcher script (`bin/x` → `dist/cli/index.js`) one hop.
  const toSource = (target: string): string | null => {
    const t = target.replace(/^\.\//, '');
    return [t, t.replace(/^dist\//, 'src/').replace(/\.(m|c)?js$/, '.ts'), t.replace(/^dist\//, 'src/').replace(/\.(m|c)?js$/, '.tsx')].find((x) => known.has(x)) ?? null;
  };
  const addEntry = (file: string, why: string, c: WikiCitation): void => {
    if (!entrypoints.some((e) => e.file === file)) entrypoints.push({ file, why, cite: c });
  };
  for (const b of bins) {
    const src = toSource(b.target);
    if (!src) continue;
    addEntry(src, `bin "${b.name}"`, b.cite);
    if (/\.(ts|tsx)$/.test(src)) continue;
    // Launchers (no extension, .js, .sh) are usually outside the read budget.
    const launcher = texts.get(src) ?? (await readRepoText(scan.repo, src, 64 * 1024));
    if (launcher === null) continue;
    if (!texts.has(src)) {
      texts.set(src, launcher);
      lineIndex[src] = countLines(launcher);
    }
    const lines = launcher.split('\n');
    for (let i = 0; i < lines.length && i < 80; i++) {
      const m = /['"`]((?:\.\.\/|\.\/)*dist\/[\w./-]+\.(?:m|c)?js)['"`]/.exec(lines[i]!);
      const hop = m ? toSource(m[1]!.replace(/^(\.\.\/|\.\/)+/, '')) : null;
      if (hop) {
        addEntry(hop, `launched by ${src}`, { file: src, line: i + 1 });
        break;
      }
    }
  }
  // Conventional entry files at shallow depth.
  for (const rel of all) {
    if (depthOf(rel) > 2 || isTestFile(rel)) continue;
    if (
      /^(src\/)?(index|main|cli|server|app)\.[cm]?[jt]sx?$/.test(rel) ||
      /^src\/(cli|server|app|api|bin|cmd)\/(index|main)\.[cm]?[jt]sx?$/.test(rel) ||
      /^cmd\/[^/]+\/main\.go$/.test(rel) ||
      /^(src\/)?(main|__main__|app|manage)\.py$/.test(rel) ||
      /^src\/(main|lib)\.rs$/.test(rel)
    ) {
      addEntry(rel, 'conventional entry file', { file: rel, line: 1 });
    }
  }

  // Modules.
  const groups = groupModules(all);
  const moduleOf = new Map<string, string>();
  for (const [key, files] of groups) for (const f of files) moduleOf.set(f, key);
  const sizeOf = new Map(scan.files.map((f) => [f.rel, f.size]));
  // Resolve every read source file's imports once: module edges + per-file
  // inbound counts from OTHER modules (a file's centrality — what a newcomer
  // should read first is what the rest of the code leans on).
  const inbound = new Map<string, number>();
  const edges = new Map<string, Record<string, number>>();
  const pkgs = new Map<string, Set<string>>();
  for (const [rel, text] of texts) {
    if (!isSourceFile(rel)) continue;
    const from = moduleOf.get(rel);
    if (!from) continue;
    for (const spec of extractSpecifiers(text, rel)) {
      const target = resolveSpecifier(rel, spec, known);
      if (target) {
        const to = moduleOf.get(target);
        if (!to || to === from) continue;
        const e = edges.get(from) ?? {};
        e[to] = (e[to] ?? 0) + 1;
        edges.set(from, e);
        if (!isTestFile(rel)) inbound.set(target, (inbound.get(target) ?? 0) + 1);
      } else {
        const pkg = packageNameOf(spec);
        const set = pkgs.get(from) ?? new Set<string>();
        if (pkg && set.size < 30) set.add(pkg);
        pkgs.set(from, set);
      }
    }
  }
  const central = (a: string, b: string): number =>
    (inbound.get(b) ?? 0) - (inbound.get(a) ?? 0) || (sizeOf.get(b) ?? 0) - (sizeOf.get(a) ?? 0) || a.localeCompare(b);
  const modules: ModuleInfo[] = [];
  for (const [key, files] of groups) {
    const sourceFiles = files.filter((f) => isSourceFile(f) && !isTestFile(f));
    const testFiles = files.filter((f) => isTestFile(f));
    const topFiles = [...sourceFiles].sort(central);
    const exports: ModuleExport[] = [];
    for (const rel of topFiles) {
      const text = texts.get(rel);
      if (text === undefined) continue;
      // At most 3 per file, most-imported files first, so the surface shown
      // is the part other modules actually use.
      exports.push(...extractExports(text, rel).slice(0, 3));
      if (exports.length >= MAX_EXPORTS_PER_MODULE) break;
    }
    const entry = sourceFiles.find((f) => /\/(index|main|mod|lib|__init__)\.[a-z]+$/.test(`/${f}`)) ?? topFiles[0] ?? null;
    modules.push({
      key,
      files,
      sourceFiles: sourceFiles.length,
      testFiles: testFiles.length,
      lines: files.reduce((a, f) => a + (lineIndex[f] ?? 0), 0),
      bytes: files.reduce((a, f) => a + (sizeOf.get(f) ?? 0), 0),
      topFiles: topFiles.slice(0, 12),
      exports: exports.slice(0, MAX_EXPORTS_PER_MODULE),
      importsFrom: edges.get(key) ?? {},
      importedBy: {},
      packages: [...(pkgs.get(key) ?? [])].sort(),
      entry,
    });
  }
  const byKey = new Map(modules.map((m) => [m.key, m]));
  for (const m of modules) {
    for (const [target, n] of Object.entries(m.importsFrom)) {
      const t = byKey.get(target);
      if (t) t.importedBy[m.key] = (t.importedBy[m.key] ?? 0) + n;
    }
  }
  // Importance: code volume + how many modules lean on it. Tests-only / docs-only folders sink.
  const weight = (m: ModuleInfo): number =>
    (m.sourceFiles === 0 ? 0 : 1) * (Math.log2(1 + m.bytes / 40) + 3 * Object.keys(m.importedBy).length);
  modules.sort((a, b) => weight(b) - weight(a) || a.key.localeCompare(b.key));
  const keptModules = modules.slice(0, MAX_MODULES);

  // Data stores, routes, env vars — scan source text only (not tests, not docs).
  const dataStores: DataStoreHit[] = [];
  const perKind = new Map<string, number>();
  const routes: RouteHit[] = [];
  const routeSeen = new Set<string>();
  const envVars: RepoFacts['envVars'] = [];
  const envSeen = new Set<string>();
  // Product code only (no tests, tooling configs, examples or scripts), product roots first.
  const scanOrder = [...texts.keys()]
    .filter((rel) => !isTestFile(rel) && !TOOLING_FILE.test(rel) && !NON_PRODUCT.test(rel) && (isSourceFile(rel) || /\.(prisma|sql)$/.test(rel)))
    .sort((a, b) => Number(isPrimarySource(b)) - Number(isPrimarySource(a)) || depthOf(a) - depthOf(b) || a.localeCompare(b));
  for (const rel of scanOrder) {
    const text = texts.get(rel)!;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > 400) continue;
      // Comments talk about stores; code uses them.
      if (/^\s*(\/\/|\/\*|\*|#(?!!))/.test(line) && !/\.(sql|prisma)$/i.test(rel)) continue;
      for (const p of STORE_PATTERNS) {
        if ((perKind.get(p.kind) ?? 0) >= MAX_HITS_PER_STORE) continue;
        if (p.kind === 'migrations' && !/\.sql$/i.test(rel)) continue;
        if (p.re.test(line)) {
          perKind.set(p.kind, (perKind.get(p.kind) ?? 0) + 1);
          dataStores.push({ kind: p.kind, label: p.label, cite: { file: rel, line: i + 1 }, snippet: clip(line, 140) });
        }
      }
    }
    if (routes.length < MAX_ROUTES) {
      for (const re of ROUTE_RES) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          const method = m[1]!.toUpperCase();
          const route = m[2]!;
          const k = `${method} ${route}`;
          if (routeSeen.has(k) || routes.length >= MAX_ROUTES) continue;
          routeSeen.add(k);
          routes.push({ method, route, cite: { file: rel, line: lineOfIndex(text, m.index ?? 0) } });
        }
      }
      if (/(-api|routes?|handlers?|server|controller)s?\.[cm]?[jt]sx?$/.test(rel)) {
        API_LITERAL_RE.lastIndex = 0;
        for (const m of text.matchAll(API_LITERAL_RE)) {
          const route = m[1]!;
          const k = `* ${route}`;
          if (routeSeen.has(k) || [...routeSeen].some((s) => s.endsWith(` ${route}`)) || routes.length >= MAX_ROUTES) continue;
          routeSeen.add(k);
          routes.push({ method: '*', route, cite: { file: rel, line: lineOfIndex(text, m.index ?? 0) } });
        }
      }
    }
    if (envVars.length < MAX_ENV) {
      for (const re of ENV_RES) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          const name = m[1]!;
          if (envSeen.has(name) || envVars.length >= MAX_ENV) continue;
          envSeen.add(name);
          envVars.push({ name, cite: { file: rel, line: lineOfIndex(text, m.index ?? 0) } });
        }
      }
    }
  }
  // Next.js / file-based routes.
  for (const rel of all) {
    if (routes.length >= MAX_ROUTES) break;
    const next = /^(?:src\/)?app\/(.*)\/route\.[jt]sx?$/.exec(rel) ?? /^(?:src\/)?pages\/api\/(.*)\.[jt]sx?$/.exec(rel);
    if (next) {
      const route = `/${next[1]!.replace(/\/index$/, '')}`.replace(/^\/api\/?/, '/api/');
      const k = `* ${route}`;
      if (!routeSeen.has(k)) {
        routeSeen.add(k);
        routes.push({ method: '*', route: rel.includes('pages/api') ? `/api/${next[1]}` : route, cite: { file: rel, line: 1 } });
      }
    }
  }
  if (all.some((rel) => path.basename(rel) === 'schema.prisma') && !perKind.has('prisma')) {
    const rel = all.find((r) => path.basename(r) === 'schema.prisma')!;
    dataStores.push({ kind: 'prisma', label: 'Prisma', cite: { file: rel, line: 1 }, snippet: 'schema.prisma' });
  }

  // Tests.
  const testFiles = all.filter(isTestFile);
  const testDirs = [...new Set(testFiles.map((f) => f.split('/').slice(0, Math.min(2, f.split('/').length - 1)).join('/') || '(root)'))].slice(0, 8);

  return {
    name: scan.name,
    head: scan.head,
    fileCount: all.length,
    truncated: scan.truncated,
    description,
    readme,
    languages,
    manifests,
    // Root manifest first: nested packages (desktop/, examples/) come after.
    scripts: [...scripts].sort((a, b) => depthOf(a.cite.file) - depthOf(b.cite.file)).slice(0, 80),
    bins,
    makeTargets,
    entrypoints: entrypoints.slice(0, 20),
    modules: keptModules,
    dataStores,
    routes,
    envVars,
    tests: { files: testFiles.length, dirs: testDirs, runner },
    lineIndex,
    texts,
  };
}
