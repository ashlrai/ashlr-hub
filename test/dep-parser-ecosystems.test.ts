/**
 * test/dep-parser-ecosystems.test.ts — Pulse Map fleet bridge, multi-ecosystem.
 *
 * Extends the Phase-E dep-parser coverage beyond npm. For each newly-supported
 * ecosystem — Cargo (Cargo.toml), Python (pyproject.toml + requirements.txt),
 * and Go (go.mod) — we:
 *
 *   1. Write a SAMPLE manifest into an isolated temp dir (os.tmpdir()) that
 *      ALSO carries free-text fields (descriptions, authors, URLs, build
 *      directives, features) which must NEVER leak into the edge list.
 *   2. Assert parseRepoDeps() emits the canonical METADATA-ONLY
 *      `depends_on` edge shape (repo → package:<eco>:<name>) for that
 *      ecosystem with the right depKinds and ranges.
 *   3. (PRIVACY FLOOR) Assert NO raw manifest free-text appears anywhere in
 *      the returned shape, and that every edge carries only the allowed fields.
 *
 * Hermetic: pure local temp-file reads, NO network. Never asserts on real
 * files outside tmp. Preserves the existing npm behavior (untouched here).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseRepoDeps, type DepEdge } from '../src/core/integrations/dep-parser.js';

const REPO = 'AshlrAI/poly-repo';
const REPO_NODE = `repo:${REPO}`;

/** Allowed edge fields — anything else risks leaking manifest content. */
const ALLOWED_EDGE_FIELDS = new Set([
  'src',
  'dst',
  'kind',
  'ecosystem',
  'name',
  'depKind',
  'range',
]);

/** Assert universal edge invariants + privacy-floor field hygiene. */
function assertCanonical(edges: DepEdge[], ecosystem: string): void {
  for (const e of edges) {
    if (e.ecosystem !== ecosystem) continue;
    expect(e.kind).toBe('depends_on');
    expect(e.src).toBe(REPO_NODE);
    expect(e.dst).toBe(`package:${ecosystem}:${e.name}`);
    for (const k of Object.keys(e)) {
      expect(ALLOWED_EDGE_FIELDS.has(k), `unexpected edge field "${k}"`).toBe(true);
    }
  }
}

/** Assert none of the secret substrings leak into the serialized result. */
function assertNoLeak(blob: string, secrets: string[]): void {
  for (const s of secrets) {
    expect(blob, `leaked secret substring: ${s}`).not.toContain(s);
  }
}

// ===========================================================================
// Cargo — Cargo.toml
// ===========================================================================

describe('dep-parser: Cargo.toml (cargo ecosystem)', () => {
  let dir = '';

  const SECRET_DESC = 'CARGO-SECRET-this-crate-description-must-not-leak';
  const SECRET_AUTHOR = 'rustacean@example.com';
  const SECRET_FEATURE = 'SECRET-internal-feature-flag';

  const CARGO_TOML = `
[package]
name = "my-crate"
version = "0.3.1"
description = "${SECRET_DESC}"
authors = ["${SECRET_AUTHOR}"]
edition = "2021"

[features]
default = ["${SECRET_FEATURE}"]
${SECRET_FEATURE} = []

[dependencies]
serde = "1.0.197"
tokio = { version = "1.36", features = ["full"] }   # inline table
anyhow = '1'
local-crate = { path = "../local" }                 # no version

[dev-dependencies]
criterion = "0.5"

[build-dependencies]
cc = "1.0"

[target.'cfg(unix)'.dependencies]
nix = "0.27"
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eco-cargo-'));
    writeFileSync(join(dir, 'Cargo.toml'), CARGO_TOML, 'utf8');
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('emits canonical cargo edges with kinds + ranges', () => {
    const result = parseRepoDeps(dir, REPO);
    expect(result.manifests).toContain('Cargo.toml');
    // cargo ecosystem should NOT be reported as unsupported anymore.
    expect(result.unsupported).not.toContain('cargo');

    assertCanonical(result.edges, 'cargo');
    const byName = new Map(
      result.edges.filter((e) => e.ecosystem === 'cargo').map((e) => [e.name, e]),
    );

    expect(byName.get('serde')?.depKind).toBe('prod');
    expect(byName.get('serde')?.range).toBe('1.0.197');
    // Inline-table dep: version extracted, features ignored.
    expect(byName.get('tokio')?.range).toBe('1.36');
    expect(byName.get('anyhow')?.range).toBe('1');
    // path-only dep: graphed by name, range null.
    expect(byName.get('local-crate')?.range).toBeNull();
    // dev + build deps both classified dev.
    expect(byName.get('criterion')?.depKind).toBe('dev');
    expect(byName.get('cc')?.depKind).toBe('dev');
    // platform-specific table.
    expect(byName.get('nix')?.depKind).toBe('prod');
  });

  it('NEVER leaks crate description / author / feature text', () => {
    const result = parseRepoDeps(dir, REPO);
    assertNoLeak(JSON.stringify(result), [SECRET_DESC, SECRET_AUTHOR, SECRET_FEATURE]);
  });
});

// ===========================================================================
// Python — pyproject.toml (PEP 621 + Poetry)
// ===========================================================================

describe('dep-parser: pyproject.toml (pypi ecosystem)', () => {
  let dir = '';
  const SECRET_DESC = 'PYPROJECT-SECRET-project-description-must-not-leak';
  const SECRET_URL = 'https://secret.internal.example.com/repo';

  const PYPROJECT = `
[project]
name = "my-pkg"
version = "2.1.0"
description = "${SECRET_DESC}"
authors = [{ name = "Dev", email = "dev@example.com" }]
urls = { Homepage = "${SECRET_URL}" }
dependencies = [
  "requests>=2.28,<3",
  "flask",
  "rich[jupyter]>=13",
]

[project.optional-dependencies]
test = ["pytest>=8", "coverage"]
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eco-pyproj-'));
    writeFileSync(join(dir, 'pyproject.toml'), PYPROJECT, 'utf8');
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('parses PEP 621 dependencies + optional groups', () => {
    const result = parseRepoDeps(dir, REPO);
    expect(result.manifests).toContain('pyproject.toml');
    expect(result.unsupported).not.toContain('pypi');

    assertCanonical(result.edges, 'pypi');
    const byName = new Map(
      result.edges.filter((e) => e.ecosystem === 'pypi').map((e) => [e.name, e]),
    );

    expect(byName.get('requests')?.depKind).toBe('prod');
    expect(byName.get('requests')?.range).toBe('>=2.28,<3');
    expect(byName.get('flask')?.depKind).toBe('prod');
    expect(byName.get('flask')?.range).toBeNull();
    // Extras are stripped from the name.
    expect(byName.get('rich')?.range).toBe('>=13');
    // Optional-dependency group → optional.
    expect(byName.get('pytest')?.depKind).toBe('optional');
    expect(byName.get('coverage')?.depKind).toBe('optional');
  });

  it('NEVER leaks description / author email / homepage URL', () => {
    const result = parseRepoDeps(dir, REPO);
    assertNoLeak(JSON.stringify(result), [SECRET_DESC, SECRET_URL, 'dev@example.com']);
  });
});

describe('dep-parser: pyproject.toml (Poetry shape)', () => {
  let dir = '';
  const SECRET_DESC = 'POETRY-SECRET-description-must-not-leak';

  const POETRY = `
[tool.poetry]
name = "poetry-pkg"
description = "${SECRET_DESC}"

[tool.poetry.dependencies]
python = "^3.11"
httpx = "^0.27"
pydantic = { version = "^2.6", extras = ["email"] }

[tool.poetry.group.dev.dependencies]
mypy = "^1.9"
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eco-poetry-'));
    writeFileSync(join(dir, 'pyproject.toml'), POETRY, 'utf8');
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('parses poetry dependency tables and skips the python interpreter pin', () => {
    const result = parseRepoDeps(dir, REPO);
    assertCanonical(result.edges, 'pypi');
    const byName = new Map(
      result.edges.filter((e) => e.ecosystem === 'pypi').map((e) => [e.name, e]),
    );

    // `python = "^3.11"` is the interpreter, not a package — must be excluded.
    expect(byName.has('python')).toBe(false);
    expect(byName.get('httpx')?.depKind).toBe('prod');
    expect(byName.get('httpx')?.range).toBe('^0.27');
    expect(byName.get('pydantic')?.range).toBe('^2.6');
    // dev group.
    expect(byName.get('mypy')?.depKind).toBe('dev');

    assertNoLeak(JSON.stringify(result), [SECRET_DESC]);
  });
});

// ===========================================================================
// Python — requirements.txt
// ===========================================================================

describe('dep-parser: requirements.txt (pypi ecosystem)', () => {
  let dir = '';
  const SECRET_COMMENT = 'REQUIREMENTS-SECRET-internal-note';
  const SECRET_VCS = 'git+https://secret-token@github.com/acme/private.git';

  const REQS = `
# ${SECRET_COMMENT}
requests==2.31.0
Flask>=2.0  # web framework
numpy
rich[jupyter]>=13.0
package-with-marker>=1.0 ; python_version < "3.9"
-r other-requirements.txt
-e .
${SECRET_VCS}#egg=private
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eco-reqs-'));
    writeFileSync(join(dir, 'requirements.txt'), REQS, 'utf8');
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('parses pinned + unpinned reqs and skips directives / VCS / URL lines', () => {
    const result = parseRepoDeps(dir, REPO);
    expect(result.manifests).toContain('requirements.txt');

    assertCanonical(result.edges, 'pypi');
    const byName = new Map(
      result.edges.filter((e) => e.ecosystem === 'pypi').map((e) => [e.name, e]),
    );

    expect(byName.get('requests')?.range).toBe('==2.31.0');
    expect(byName.get('Flask')?.range).toBe('>=2.0');
    expect(byName.get('numpy')?.range).toBeNull();
    // Extras stripped.
    expect(byName.get('rich')?.range).toBe('>=13.0');
    // Env marker dropped, name + spec kept.
    expect(byName.get('package-with-marker')?.range).toBe('>=1.0');

    // -r / -e directives and the VCS install produce NO package edge.
    const names = new Set([...byName.keys()]);
    expect(names.has('other-requirements.txt')).toBe(false);
    expect([...names].some((n) => n.includes('git+'))).toBe(false);
    expect([...names].some((n) => n.includes('private'))).toBe(false);
  });

  it('NEVER leaks the comment note or the VCS token URL', () => {
    const result = parseRepoDeps(dir, REPO);
    assertNoLeak(JSON.stringify(result), [SECRET_COMMENT, SECRET_VCS, 'secret-token']);
  });
});

// ===========================================================================
// Go — go.mod
// ===========================================================================

describe('dep-parser: go.mod (go ecosystem)', () => {
  let dir = '';
  // go.mod has little free text, but the module path of the repo itself and
  // a replace directive's local filesystem path must not become spurious deps.
  const SELF_MODULE = 'github.com/acme/SECRET-private-service';
  const REPLACE_PATH = '../SECRET-local-fork';

  const GO_MOD = `
module ${SELF_MODULE}

go 1.22

require (
\tgithub.com/gin-gonic/gin v1.9.1
\tgithub.com/stretchr/testify v1.9.0 // indirect
\tgolang.org/x/sync v0.7.0
)

require github.com/spf13/cobra v1.8.0

replace github.com/gin-gonic/gin => ${REPLACE_PATH}

exclude github.com/old/dep v0.1.0
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eco-go-'));
    writeFileSync(join(dir, 'go.mod'), GO_MOD, 'utf8');
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('parses require block + single-line require, honoring // indirect', () => {
    const result = parseRepoDeps(dir, REPO);
    expect(result.manifests).toContain('go.mod');
    expect(result.unsupported).not.toContain('go');

    assertCanonical(result.edges, 'go');
    const byName = new Map(
      result.edges.filter((e) => e.ecosystem === 'go').map((e) => [e.name, e]),
    );

    expect(byName.get('github.com/gin-gonic/gin')?.depKind).toBe('prod');
    expect(byName.get('github.com/gin-gonic/gin')?.range).toBe('v1.9.1');
    // indirect → dev.
    expect(byName.get('github.com/stretchr/testify')?.depKind).toBe('dev');
    expect(byName.get('golang.org/x/sync')?.range).toBe('v0.7.0');
    // single-line require.
    expect(byName.get('github.com/spf13/cobra')?.range).toBe('v1.8.0');

    // The repo's OWN module, replace target path, and exclude must NOT appear.
    expect(byName.has(SELF_MODULE)).toBe(false);
    expect(byName.has('github.com/old/dep')).toBe(false);
    const names = [...byName.keys()];
    expect(names.some((n) => n.includes('SECRET'))).toBe(false);
  });

  it('NEVER leaks the self-module name or replace path', () => {
    const result = parseRepoDeps(dir, REPO);
    assertNoLeak(JSON.stringify(result), [SELF_MODULE, REPLACE_PATH]);
  });
});

// ===========================================================================
// Mixed polyglot repo — all ecosystems coexist, npm preserved
// ===========================================================================

describe('dep-parser: polyglot repo (all ecosystems coexist)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eco-poly-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18.2.0' } }),
      'utf8',
    );
    writeFileSync(join(dir, 'Cargo.toml'), '[dependencies]\nserde = "1"\n', 'utf8');
    writeFileSync(join(dir, 'requirements.txt'), 'requests==2.31.0\n', 'utf8');
    writeFileSync(join(dir, 'go.mod'), 'module x\n\ngo 1.22\n\nrequire foo/bar v1.0.0\n', 'utf8');
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('emits edges from every ecosystem into one unified list', () => {
    const result = parseRepoDeps(dir, REPO);
    const ecos = new Set(result.edges.map((e) => e.ecosystem));
    expect(ecos).toEqual(new Set(['npm', 'cargo', 'pypi', 'go']));

    // npm behavior preserved exactly.
    const react = result.edges.find((e) => e.name === 'react');
    expect(react?.ecosystem).toBe('npm');
    expect(react?.dst).toBe('package:npm:react');
    expect(react?.range).toBe('^18.2.0');

    expect(result.manifests).toEqual(
      expect.arrayContaining(['package.json', 'Cargo.toml', 'requirements.txt', 'go.mod']),
    );
  });

  it('degrades to empty (no throw) when no manifests exist', () => {
    const empty = mkdtempSync(join(tmpdir(), 'eco-empty-'));
    try {
      const result = parseRepoDeps(empty, REPO);
      expect(result.edges).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
