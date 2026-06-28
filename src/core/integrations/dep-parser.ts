/**
 * core/integrations/dep-parser.ts — Phase E (Pulse Map fleet bridge).
 *
 * Parse a LOCALLY-enrolled repo's dependency manifests + lockfiles into a
 * METADATA-ONLY edge list for the Pulse cloud graph (`graph_edge`):
 *
 *   repo  --depends_on-->  package
 *
 * encoded in the cloud's canonical `${kind}:${ref}` node addressing
 * (see ashlr-pulse/server/src/lib/graph-types.ts):
 *   repo    → `repo:<owner/name>`      (e.g. repo:AshlrAI/ashlr-hub)
 *   package → `package:<eco>:<name>`   (e.g. package:npm:react)
 *
 * PRIVACY FLOOR (non-negotiable — see ashlr-pulse architecture):
 *   This module ships a STRUCTURAL EDGE LIST ONLY. It NEVER returns, logs,
 *   ships, or embeds file contents, lockfile bytes, version-resolution trees,
 *   source code, prompts, or diffs. Only: dependency *name*, ecosystem, the
 *   declared *kind* (prod/dev/peer/optional), and a declared version *range*
 *   string (a manifest field, not code). Versions are optional metadata; a
 *   caller that wants the strictest floor can drop them.
 *
 *   The multi-ecosystem parsers below are deliberately NARROW: each one reads
 *   ONLY the dependency *tables* of its manifest (e.g. `[dependencies]` in
 *   Cargo.toml, `require (...)` in go.mod). They never extract descriptions,
 *   authors, scripts, URLs, build directives, or any other free-text field —
 *   so manifest prose can never reach the edge list.
 *
 * HOUSE STYLE (matches integrations/github.ts + integrations/vercel.ts):
 *   - Every exported function is READ-ONLY and NEVER throws. On any failure
 *     (missing file, malformed JSON, unreadable dir) it returns a safe empty
 *     shape. The fleet daemon must never crash because a manifest is weird.
 *   - No network, no spawn — pure local file reads, bounded by size.
 *
 * SCOPE: package.json (npm) + the JS lockfiles are parsed for npm edges, and
 * the following non-JS ecosystems are now parsed into the SAME edge shape:
 *   - Cargo  → Cargo.toml          (ecosystem 'cargo')
 *   - Python → pyproject.toml      (ecosystem 'pypi', PEP 621 + poetry)
 *   - Python → requirements.txt    (ecosystem 'pypi')
 *   - Go     → go.mod              (ecosystem 'go')
 * Lockfile awareness (npm/yarn/pnpm/bun) records WHICH package manager a repo
 * uses (presence only). Any manifest we still cannot parse is detected-and-noted
 * via `unsupportedManifests()` for the caller's followups list.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Dependency relationship kind as declared in the manifest. */
export type DepKind = 'prod' | 'dev' | 'peer' | 'optional';

/**
 * A single METADATA-ONLY dependency edge, ready to ship to the Pulse graph.
 *
 * `src` / `dst` use the cloud's canonical `${kind}:${ref}` node addressing so
 * the cloud can upsert `graph_edge` rows directly without re-deriving ids.
 */
export interface DepEdge {
  /** Source node id — always the repo: `repo:<owner/name>`. */
  src: string;
  /** Destination node id — the package: `package:<ecosystem>:<name>`. */
  dst: string;
  /** Always 'depends_on' (the only edge kind this parser emits). */
  kind: 'depends_on';
  /** Package ecosystem (e.g. 'npm', 'cargo', 'pypi', 'go'). Metadata. */
  ecosystem: string;
  /** Bare package name (e.g. 'react', '@scope/pkg', 'serde'). Metadata. */
  name: string;
  /** Declared dependency kind (prod/dev/peer/optional). Metadata. */
  depKind: DepKind;
  /**
   * Declared version *range* as written in the manifest (e.g. '^18.2.0').
   * This is a manifest field, NOT a resolved lockfile tree — metadata only.
   * Null when the source manifest did not declare one.
   */
  range: string | null;
}

/** Result of parsing one repo. METADATA ONLY. */
export interface DepParseResult {
  /** The repo node ref used as the edge source, `<owner/name>` (no `repo:` prefix). */
  repoRef: string;
  /** Manifests that were actually parsed (basenames only — never paths/contents). */
  manifests: string[];
  /** The resulting depends_on edge list (deduped). */
  edges: DepEdge[];
  /**
   * Ecosystems detected but NOT parsed (Gemfile/composer/maven/gradle/etc.).
   * Surface these as followups; they are intentionally unsupported here.
   */
  unsupported: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on a manifest file we will read into memory (defensive). */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024; // 4 MB — generous for a package.json

/** Hard cap on edges emitted per repo, so a pathological manifest can't blow up. */
const MAX_EDGES = 5_000;

/**
 * Non-JS manifests we DETECT but do not parse. Mapped to a stable ecosystem
 * label used only for the `unsupported` followup list. Ecosystems that ARE
 * parsed (cargo/pypi/go) are intentionally NOT in this list anymore.
 */
const UNSUPPORTED_MANIFESTS: ReadonlyArray<readonly [file: string, ecosystem: string]> = [
  ['Pipfile', 'pipenv'],
  ['Gemfile', 'rubygems'],
  ['composer.json', 'composer'],
  ['pom.xml', 'maven'],
  ['build.gradle', 'gradle'],
];

// ---------------------------------------------------------------------------
// Internal helpers (all no-throw)
// ---------------------------------------------------------------------------

/** Read a file as UTF-8, returning null on any failure or if it is too large. */
function readSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** JSON.parse that never throws. */
function jsonSafe(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Derive the repo node ref (`<owner/name>`) for an enrolled repo path.
 *
 * Prefers an explicit `repoFullName` (caller usually has it from githubStatus's
 * nameWithOwner). Falls back to the directory basename when unknown, which still
 * produces a stable—if owner-less—node ref. NEVER reads git config or network.
 */
export function repoRefFor(repoPath: string, repoFullName?: string | null): string {
  if (repoFullName && repoFullName.includes('/')) return repoFullName;
  if (repoFullName) return repoFullName;
  const base = basename(repoPath.replace(/[\\/]+$/, ''));
  return base || 'unknown-repo';
}

/** Canonical package node id for a given ecosystem. */
function packageNodeId(ecosystem: string, name: string): string {
  return `package:${ecosystem}:${name}`;
}

/** Canonical package node id for the npm ecosystem. */
function npmPackageNodeId(name: string): string {
  return packageNodeId('npm', name);
}

/**
 * Append edges from a name→range record into `out` for one ecosystem/kind,
 * de-duping by (ecosystem, depKind, name) via `seen`. Pure helper that keeps
 * the per-ecosystem parsers tiny and consistent. Only the dependency *name*
 * and declared *range* ever cross into an edge — never any other text.
 */
function pushEdges(
  out: DepEdge[],
  seen: Set<string>,
  repoNode: string,
  ecosystem: string,
  depKind: DepKind,
  entries: Iterable<readonly [name: string, range: string | null]>,
): void {
  for (const [rawName, range] of entries) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) continue;
    const dedup = `${ecosystem}:${depKind}:${name}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({
      src: repoNode,
      dst: packageNodeId(ecosystem, name),
      kind: 'depends_on',
      ecosystem,
      name,
      depKind,
      range: typeof range === 'string' && range.length > 0 ? range : null,
    });
    if (out.length >= MAX_EDGES) return;
  }
}

/**
 * Extract npm deps from a parsed package.json object into edges. Pure.
 * Reads ONLY the dependency *name* + declared *range* — never scripts, config,
 * author, or any other field that could carry free text.
 */
function edgesFromPackageJson(pkg: Record<string, unknown>, repoNode: string): DepEdge[] {
  const out: DepEdge[] = [];
  const seen = new Set<string>();

  const SECTIONS: ReadonlyArray<readonly [field: string, kind: DepKind]> = [
    ['dependencies', 'prod'],
    ['devDependencies', 'dev'],
    ['peerDependencies', 'peer'],
    ['optionalDependencies', 'optional'],
  ];

  for (const [field, depKind] of SECTIONS) {
    const section = pkg[field];
    if (section === null || typeof section !== 'object' || Array.isArray(section)) continue;
    for (const [name, range] of Object.entries(section as Record<string, unknown>)) {
      if (!name) continue;
      // De-dup by (name + kind) — a package can legitimately appear in two
      // sections; keep both kinds but never the same one twice.
      const dedup = `${depKind}:${name}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      out.push({
        src: repoNode,
        dst: npmPackageNodeId(name),
        kind: 'depends_on',
        ecosystem: 'npm',
        name,
        depKind,
        range: typeof range === 'string' && range.length > 0 ? range : null,
      });
      if (out.length >= MAX_EDGES) return out;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Minimal TOML table reader (privacy-narrow — dependency tables only)
// ---------------------------------------------------------------------------

/**
 * A tiny, dependency-free TOML scanner that yields the `key = value` pairs
 * belonging to a requested set of top-level tables (`[name]`) — and only those.
 *
 * This is intentionally NOT a general TOML parser. It walks the file line by
 * line, tracking the current `[table.path]` header, and only surfaces pairs
 * whose table path matches one of the dependency tables we care about. Any
 * other table's contents (description, authors, build config, package metadata)
 * is skipped entirely, so free text can never reach an edge.
 *
 * Returns a map of `tablePath -> { key -> rawValue }`. Inline-table dependency
 * specs (`serde = { version = "1", features = [...] }`) are returned with the
 * whole `{...}` as the raw value; the caller extracts the version separately.
 * Never throws.
 */
function readTomlTables(
  raw: string,
  wantedTables: ReadonlyArray<string>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const wanted = new Set(wantedTables);
  let current = '';

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const stripped = stripTomlComment(line).trim();
    if (!stripped) continue;

    // Table header: [a.b.c] or [[a.b.c]] (array-of-tables — ignored for deps).
    const header = stripped.match(/^\[\[?([^\]]+)\]?\]$/);
    if (header) {
      current = header[1].trim();
      continue;
    }

    if (!wanted.has(current)) continue;

    // key = value  (key may be bare or quoted: "my-dep" = "1.0")
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    let key = stripped.slice(0, eq).trim();
    const value = stripped.slice(eq + 1).trim();
    key = unquoteToml(key);
    if (!key) continue;

    (out[current] ??= {})[key] = value;
  }

  return out;
}

/**
 * Strip a `#` comment from a TOML line WITHOUT cutting inside a quoted string.
 * Defensive and simple — good enough for dependency tables.
 */
function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/** Remove surrounding single/double quotes from a TOML scalar. */
function unquoteToml(v: string): string {
  const t = v.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Extract a version *range* string from a TOML dependency value, which may be:
 *   - a bare string:        "1.2.3"  or  '^1'
 *   - an inline table:      { version = "1", features = [...] }
 *   - something with no version (git/path dep): returns null
 * Only ever returns the version string — never features, git urls, or paths.
 */
function tomlDepVersion(value: string): string | null {
  const t = value.trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    const m = t.match(/version\s*=\s*(['"])(.*?)\1/);
    return m ? m[2] : null;
  }
  const unq = unquoteToml(t);
  return unq.length > 0 ? unq : null;
}

// ---------------------------------------------------------------------------
// Cargo (Rust) — Cargo.toml
// ---------------------------------------------------------------------------

/**
 * Parse a Cargo.toml's dependency tables into edges (ecosystem 'cargo').
 * Reads ONLY: [dependencies], [dev-dependencies], [build-dependencies], and
 * their `target.'cfg(...)'` variants. Never reads [package], features, or any
 * descriptive table. Pure / no-throw.
 */
function edgesFromCargoToml(raw: string, repoNode: string): DepEdge[] {
  const out: DepEdge[] = [];
  const seen = new Set<string>();

  // Discover every table whose trailing segment is a dependency table, so we
  // also pick up platform-specific deps like
  // [target.'cfg(unix)'.dependencies]. We re-scan the headers cheaply.
  const depTables: Array<{ table: string; kind: DepKind }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const stripped = stripTomlComment(line).trim();
    const header = stripped.match(/^\[([^\]]+)\]$/);
    if (!header) continue;
    const table = header[1].trim();
    if (/(^|\.)dev-dependencies$/.test(table)) depTables.push({ table, kind: 'dev' });
    else if (/(^|\.)build-dependencies$/.test(table)) depTables.push({ table, kind: 'dev' });
    else if (/(^|\.)dependencies$/.test(table)) depTables.push({ table, kind: 'prod' });
  }
  if (depTables.length === 0) return out;

  const tables = readTomlTables(
    raw,
    depTables.map((d) => d.table),
  );

  for (const { table, kind } of depTables) {
    const entries = tables[table];
    if (!entries) continue;
    pushEdges(
      out,
      seen,
      repoNode,
      'cargo',
      kind,
      Object.entries(entries).map(([name, value]) => [name, tomlDepVersion(value)] as const),
    );
    if (out.length >= MAX_EDGES) break;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Python — pyproject.toml (PEP 621 + Poetry) and requirements.txt
// ---------------------------------------------------------------------------

/**
 * Parse a Python `pyproject.toml` into edges (ecosystem 'pypi'). Supports the
 * two common shapes:
 *   - PEP 621: `[project]` with `dependencies = [ "requests>=2", ... ]` and
 *     `optional-dependencies` groups.
 *   - Poetry: `[tool.poetry.dependencies]` / `[tool.poetry.group.*.dependencies]`.
 * Reads ONLY those dependency declarations — never name/description/authors/
 * urls/classifiers. Pure / no-throw.
 */
function edgesFromPyproject(raw: string, repoNode: string): DepEdge[] {
  const out: DepEdge[] = [];
  const seen = new Set<string>();

  // ── PEP 621: [project] dependencies = [...] (an array, not a table) ──────
  for (const [req, kind] of pep621Requirements(raw)) {
    const parsed = parsePyRequirement(req);
    if (parsed) pushEdges(out, seen, repoNode, 'pypi', kind, [[parsed.name, parsed.range]]);
    if (out.length >= MAX_EDGES) return out;
  }

  // ── Poetry: [tool.poetry.dependencies] tables (name = version) ───────────
  const poetryTables: Array<{ table: string; kind: DepKind }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const header = stripTomlComment(line).trim().match(/^\[([^\]]+)\]$/);
    if (!header) continue;
    const table = header[1].trim();
    if (table === 'tool.poetry.dependencies') poetryTables.push({ table, kind: 'prod' });
    else if (/^tool\.poetry\.group\..+\.dependencies$/.test(table)) {
      poetryTables.push({ table, kind: 'dev' });
    } else if (table === 'tool.poetry.dev-dependencies') {
      poetryTables.push({ table, kind: 'dev' });
    }
  }
  if (poetryTables.length > 0) {
    const tables = readTomlTables(
      raw,
      poetryTables.map((t) => t.table),
    );
    for (const { table, kind } of poetryTables) {
      const entries = tables[table];
      if (!entries) continue;
      pushEdges(
        out,
        seen,
        repoNode,
        'pypi',
        kind,
        Object.entries(entries)
          // Poetry pins the interpreter itself as `python = "^3.11"` — not a package.
          .filter(([name]) => name.toLowerCase() !== 'python')
          .map(([name, value]) => [name, tomlDepVersion(value)] as const),
      );
      if (out.length >= MAX_EDGES) break;
    }
  }

  return out;
}

/**
 * Given the text AFTER a TOML array's opening `[`, return the substring up to
 * the matching closing `]` that sits OUTSIDE any quoted string — or null if no
 * such terminator is present yet (array spans more lines). Quote-aware so a
 * bracket inside a requirement string (e.g. "rich[jupyter]") is not mistaken
 * for the array terminator.
 */
function sliceToArrayClose(buf: string): string | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ']' && !inSingle && !inDouble) return buf.slice(0, i);
  }
  return null;
}

/**
 * Pull PEP 621 requirement strings out of pyproject.toml's `[project]` table:
 *   dependencies = [ "requests>=2", "flask" ]
 *   [project.optional-dependencies] -> grouped arrays (treated as optional)
 * Yields `[requirementString, depKind]`. Scans only array literals attached to
 * the relevant keys — never other `[project]` fields. Never throws.
 */
function pep621Requirements(raw: string): Array<readonly [req: string, kind: DepKind]> {
  const out: Array<readonly [string, DepKind]> = [];
  const lines = raw.split(/\r?\n/);

  let current = '';
  let i = 0;
  while (i < lines.length) {
    const stripped = stripTomlComment(lines[i]).trim();
    const header = stripped.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1].trim();
      i++;
      continue;
    }

    const inProject = current === 'project';
    const inOptional = current === 'project.optional-dependencies';

    // `dependencies = [ ... ]` under [project] → prod.
    // any `<group> = [ ... ]` under [project.optional-dependencies] → optional.
    const eq = stripped.indexOf('=');
    const key = eq > 0 ? unquoteToml(stripped.slice(0, eq).trim()) : '';
    const isDepArray =
      (inProject && key === 'dependencies') || (inOptional && key.length > 0);

    if (isDepArray && stripped.slice(eq + 1).includes('[')) {
      const kind: DepKind = inOptional ? 'optional' : 'prod';
      // Collect the (possibly multi-line) array literal, then find the closing
      // ']' that is OUTSIDE any quoted string (a requirement like
      // "rich[jupyter]>=13" carries a bracket that must NOT end the array).
      let buf = stripped.slice(stripped.indexOf('[') + 1);
      let j = i;
      let body = sliceToArrayClose(buf);
      while (body === null && j + 1 < lines.length) {
        j++;
        buf += '\n' + stripTomlComment(lines[j]);
        body = sliceToArrayClose(buf);
      }
      const arrayBody = body ?? buf;
      for (const m of arrayBody.matchAll(/(['"])(.*?)\1/g)) {
        const req = m[2].trim();
        if (req) out.push([req, kind] as const);
      }
      i = j + 1;
      continue;
    }

    i++;
  }

  return out;
}

/**
 * Parse a Python `requirements.txt` body into edges (ecosystem 'pypi').
 * Handles `name==1.2`, `name>=1`, `name[extra]`, comments, blank lines, and
 * skips `-r other.txt` / `-e .` / VCS+URL lines (no package name to graph).
 * Reads only the package name + version specifier. Pure / no-throw.
 */
function edgesFromRequirementsTxt(raw: string, repoNode: string): DepEdge[] {
  const out: DepEdge[] = [];
  const seen = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+#.*$/, '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Pip directives / option flags carry no graphable package name.
    if (trimmed.startsWith('-')) continue;
    // VCS or direct-URL installs (git+https://, https://...). Skip — no clean name.
    if (/^[a-z+]+:\/\//i.test(trimmed) || trimmed.includes('://')) continue;

    const parsed = parsePyRequirement(trimmed);
    if (!parsed) continue;
    pushEdges(out, seen, repoNode, 'pypi', 'prod', [[parsed.name, parsed.range]]);
    if (out.length >= MAX_EDGES) break;
  }

  return out;
}

/**
 * Parse one PEP 508 / requirements-style requirement string into a
 * `{ name, range }`. Strips extras (`pkg[extra]`) and environment markers
 * (`; python_version < "3.9"`). Returns null when no usable name is present.
 * Range is the version-specifier portion (e.g. '>=2.0,<3') or null.
 */
function parsePyRequirement(req: string): { name: string; range: string | null } | null {
  let s = req.trim();
  if (!s) return null;
  // Drop environment markers after ';'.
  const semi = s.indexOf(';');
  if (semi >= 0) s = s.slice(0, semi).trim();
  // Name is the leading run of [A-Za-z0-9._-]; everything else is spec/extras.
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/);
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  const rest = (m[3] ?? '').trim();
  // `@` denotes a direct URL reference (name @ https://...) — drop the URL.
  const range = rest && !rest.startsWith('@') && rest.length > 0 ? rest : null;
  return { name, range };
}

// ---------------------------------------------------------------------------
// Go — go.mod
// ---------------------------------------------------------------------------

/**
 * Parse a `go.mod` into edges (ecosystem 'go'). Handles both single-line
 * `require module/path v1.2.3` and block `require ( ... )` forms, marks deps
 * flagged `// indirect` as dev (transitive), and ignores `module`, `go`,
 * `replace`, `exclude`, `retract`, and `toolchain` directives. The module path
 * is the package name and the `vX.Y.Z` token is the range. Pure / no-throw.
 */
function edgesFromGoMod(raw: string, repoNode: string): DepEdge[] {
  const out: DepEdge[] = [];
  const seen = new Set<string>();

  const lines = raw.split(/\r?\n/);
  let inRequireBlock = false;

  const consume = (modulePath: string, version: string | null, indirect: boolean): void => {
    if (!modulePath) return;
    pushEdges(out, seen, repoNode, 'go', indirect ? 'dev' : 'prod', [[modulePath, version]]);
  };

  for (let i = 0; i < lines.length; i++) {
    if (out.length >= MAX_EDGES) break;
    const rawLine = lines[i];
    // Strip line comments but remember whether `// indirect` was present.
    const indirect = /\/\/\s*indirect\b/.test(rawLine);
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;

    if (inRequireBlock) {
      if (line === ')') {
        inRequireBlock = false;
        continue;
      }
      const parts = line.split(/\s+/);
      consume(parts[0], parts[1] ?? null, indirect);
      continue;
    }

    if (line === 'require (' || line === 'require(') {
      inRequireBlock = true;
      continue;
    }

    // Single-line: `require module/path v1.2.3`
    const single = line.match(/^require\s+(\S+)\s+(\S+)/);
    if (single) {
      consume(single[1], single[2], indirect);
      continue;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Lockfile awareness (presence only — we do NOT parse resolved trees)
// ---------------------------------------------------------------------------

const JS_LOCKFILES: readonly string[] = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
];

/**
 * Which JS lockfiles are present in the repo root. Presence is structural
 * metadata (which package manager the repo uses); we deliberately do NOT read
 * lockfile *contents* — the declared package set in package.json is the edge
 * source of truth, and resolved version trees would leak a fuller dependency
 * graph than the project intends to publish.
 */
export function detectJsLockfiles(repoPath: string): string[] {
  const found: string[] = [];
  for (const lf of JS_LOCKFILES) {
    try {
      if (existsSync(join(repoPath, lf))) found.push(lf);
    } catch {
      /* ignore */
    }
  }
  return found;
}

/**
 * Detect non-JS manifests present in the repo root that this parser does not
 * yet support. Returns stable ecosystem labels for the caller's followups list.
 * NEVER reads their contents.
 */
export function unsupportedManifests(repoPath: string): string[] {
  const out = new Set<string>();
  for (const [file, eco] of UNSUPPORTED_MANIFESTS) {
    try {
      if (existsSync(join(repoPath, file))) out.add(eco);
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse the dependency manifests of a single enrolled repo into a
 * METADATA-ONLY `depends_on` edge list for the Pulse graph.
 *
 * Parses, in repo root: package.json (npm), Cargo.toml (cargo),
 * pyproject.toml + requirements.txt (pypi), and go.mod (go) — all into the
 * same canonical edge shape. JS lockfile presence is recorded too.
 *
 * READ-ONLY. NEVER throws. Degrades to an empty edge list on any failure
 * (no manifests, malformed JSON/TOML, unreadable dir).
 *
 * @param repoPath      Absolute path to an enrolled repo's working tree root.
 * @param repoFullName  Optional `<owner/name>` (e.g. from githubStatus's
 *                      nameWithOwner). Used as the edge source ref; falls back
 *                      to the directory basename when omitted.
 */
export function parseRepoDeps(
  repoPath: string,
  repoFullName?: string | null,
): DepParseResult {
  const repoRef = repoRefFor(repoPath, repoFullName);
  const repoNode = `repo:${repoRef}`;

  const result: DepParseResult = {
    repoRef,
    manifests: [],
    edges: [],
    unsupported: unsupportedManifests(repoPath),
  };

  const edges: DepEdge[] = [];
  const pushAll = (more: DepEdge[]): void => {
    for (const e of more) {
      if (edges.length >= MAX_EDGES) break;
      edges.push(e);
    }
  };

  // ── package.json (npm) ────────────────────────────────────────────────────
  const pkgRaw = readSafe(join(repoPath, 'package.json'));
  const pkgParsed = jsonSafe(pkgRaw);
  if (pkgParsed !== null && typeof pkgParsed === 'object' && !Array.isArray(pkgParsed)) {
    result.manifests.push('package.json');
    pushAll(edgesFromPackageJson(pkgParsed as Record<string, unknown>, repoNode));
  }

  // ── Cargo.toml (cargo) ────────────────────────────────────────────────────
  const cargoRaw = readSafe(join(repoPath, 'Cargo.toml'));
  if (cargoRaw !== null) {
    const cargoEdges = edgesFromCargoToml(cargoRaw, repoNode);
    // Record the manifest even if it declared zero deps (presence is signal).
    result.manifests.push('Cargo.toml');
    pushAll(cargoEdges);
  }

  // ── pyproject.toml (pypi) ─────────────────────────────────────────────────
  const pyprojRaw = readSafe(join(repoPath, 'pyproject.toml'));
  if (pyprojRaw !== null) {
    result.manifests.push('pyproject.toml');
    pushAll(edgesFromPyproject(pyprojRaw, repoNode));
  }

  // ── requirements.txt (pypi) ───────────────────────────────────────────────
  const reqRaw = readSafe(join(repoPath, 'requirements.txt'));
  if (reqRaw !== null) {
    result.manifests.push('requirements.txt');
    pushAll(edgesFromRequirementsTxt(reqRaw, repoNode));
  }

  // ── go.mod (go) ───────────────────────────────────────────────────────────
  const goRaw = readSafe(join(repoPath, 'go.mod'));
  if (goRaw !== null) {
    result.manifests.push('go.mod');
    pushAll(edgesFromGoMod(goRaw, repoNode));
  }

  result.edges = edges;

  // Lockfile presence is recorded as a parsed manifest (which package manager),
  // but contents are intentionally never read — see detectJsLockfiles().
  for (const lf of detectJsLockfiles(repoPath)) {
    result.manifests.push(lf);
  }

  return result;
}

/**
 * Convenience: dependency-risk count for a repo — the number of distinct
 * production-ecosystem packages it declares. Metadata only; feeds the cloud's
 * RepoHealth.depRisk channel (a count, never a list of names). NEVER throws.
 */
export function declaredDepCount(repoPath: string, repoFullName?: string | null): number {
  try {
    const edges = parseRepoDeps(repoPath, repoFullName).edges;
    const prodNames = new Set(
      edges.filter((e) => e.depKind === 'prod').map((e) => e.name),
    );
    return prodNames.size;
  } catch {
    return 0;
  }
}
