/**
 * Protected paths (gate G1) and test tampering (gate G1b) — V3.10 Track B (owner: unit U3).
 *
 * G1 — a diff that touches a protected path goes to the OWNER LANE: the fleet
 * still opens the PR (so the work is not lost), labels it `ashlr:owner-lane`,
 * and never merges it. CODEOWNERS enforces the same rule on GitHub (the App is
 * not a code owner), so the lane holds even if this module were bypassed.
 *
 * G1b — test tampering (removing `it(` / `test(` / `expect(` calls, adding
 * `.skip` / `.only`, editing snapshots or test-runner config) makes a change
 * HIGH risk. High risk is above every grant's ceiling (STANDING_GRANT_CEILINGS
 * .maxRisk is `medium`), so G1b refusing directly is exactly "marks it high
 * risk and G2 refuses it" with a clearer reason in the gate funnel.
 *
 * WHY a compiled list, not an import graph computed at gate time: the list is
 * reviewed source (this file is itself protected), it is cheap and
 * deterministic on the gate's hot path, and a closure-snapshot test
 * (test/authority-tier1-closure-310b.test.ts) fails CI whenever the import
 * closure of these roots grows — so new code can only join the authority
 * surface through a change Mason reviews. Everything in that closure that is
 * not named here is still covered at deploy time: a deploy that changes the
 * authority surface pauses the grant until Mason re-approves (B-U1).
 *
 * Two scopes:
 *  - `all-repos`  — repo config any repo can weaponise (manifests, lockfiles,
 *    CI, CODEOWNERS, hooks, secrets, release tooling).
 *  - `self-repo`  — ashlr-hub's own Tier-1 authority code and its tests
 *    (SPEC-310B §2 "Tier-1 protected paths"). Applied only when the target is
 *    ashlr-hub, because other repos may legitimately own a `policy/` folder.
 *
 * Matching is case-INSENSITIVE on purpose: macOS checkouts are case-folding,
 * so `Package.json` and `package.json` are one file on disk. Over-matching
 * only sends work to Mason; under-matching would let the fleet merge it.
 *
 * PURE: no I/O. Callers supply file contents where a rule needs them
 * (test files that import Tier-1 code).
 */
import { isSafetyTestFile } from '../fleet/self.js';

export type ProtectedPathScope = 'all-repos' | 'self-repo';

export interface ProtectedPathRule {
  /** Stable machine id — the gate funnel and the ledger row group on it. */
  readonly id: string;
  readonly scope: ProtectedPathScope;
  /** Repo-relative globs: `**` any depth, `*` one segment, `?` one char, `{a,b}` literal alternatives. */
  readonly patterns: readonly string[];
  /** One sentence for Mason: why this path is not the fleet's to merge. */
  readonly why: string;
}

export interface ProtectedPathHit {
  /** The path as the diff named it (normalized). */
  path: string;
  ruleId: string;
  why: string;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * ashlr-hub Tier-1 authority SOURCE (SPEC-310B §2). Also the roots of the
 * closure-snapshot test. Additions beyond the spec's list, each strictly more
 * protective: this unit's own gate modules (merge-gates, standing-merge-pass,
 * fleet-merge-state), the Stop / Revoke / grant control plane
 * (verse/authority-api.ts, cli/authority.ts — weakening Stop would break I1),
 * and the reviewer-family enum's home (learning/agent-semantic-events.ts).
 *
 * Added at 3.10 integration (each a cross-unit request, each more protective):
 *   - run/engine-registry.ts and resources/native-profile.ts (U7): which engine
 *     a fleet id maps to and how grok-cli is launched inside the sandbox —
 *     changing either could route around the grant's engine list or out of
 *     confinement;
 *   - learn/experiments.ts and local-eval/tasks-heldout.ts (U9): the paired
 *     experiment math and the held-out checkers are the yardstick harness
 *     adoption rests on — a fleet that could edit them could grade itself.
 */
export const TIER1_SOURCE_PATTERNS: readonly string[] = Object.freeze([
  // Authority and daemon
  'src/core/authority/**',
  'src/core/daemon/activation-permit.ts',
  'src/core/daemon/tick-hooks.ts',
  'src/core/daemon/loop.ts',
  'src/core/daemon/post-merge-halt.ts',
  'src/core/daemon/liveness.ts',
  // Resident service (docs/RESIDENT-RUNTIME.md): the only launchd mutation
  // path (installResidentService claims authority/resident.ts's capability),
  // the legacy deny-only boundary, and the config → plist mapping (budget,
  // interval, parallel) — each decides what launchd runs unattended.
  'src/core/daemon/service.ts',
  'src/core/daemon/service-install-authority.ts',
  'src/core/daemon/service-config.ts',
  // Merge and fleet
  'src/core/inbox/merge.ts',
  'src/core/fleet/automerge-pass.ts',
  'src/core/fleet/host-merge.ts',
  'src/core/fleet/merge-gates.ts',
  'src/core/fleet/standing-merge-pass.ts',
  'src/core/fleet/fleet-merge-state.ts',
  // 3.13: posts the host-verified ashlr/verify check G7 and the rulesets trust
  'src/core/fleet/verify-check-run.ts',
  // 3.13: signs provenance for cloud PRs it ingests into the standing pass
  'src/core/fleet/cloud-intake.ts',
  'src/core/fleet/post-merge-watch.ts',
  'src/core/fleet/quarantine.ts',
  'src/core/fleet/regression-sentinel.ts',
  'src/core/fleet/dispatch-router.ts',
  'src/core/fleet/backpressure.ts',
  'src/core/fleet/mirrors.ts',
  'src/core/fleet/tick-hooks-live.ts',
  'src/core/fleet/manager.ts',
  'src/core/fleet/reviewer-independence.ts',
  // Spend / engine deciders (3.10 review d4): each decides which paid seat or
  // engine autonomy may use, so each is an authority-surface root too.
  'src/core/fleet/subscription-usage.ts',
  'src/core/fleet/router.ts',
  'src/core/run/best-of-n.ts',
  'src/core/run/best-of-n-policy.ts',
  'src/core/vision/leader.ts',
  'src/core/vision/leader-seat.ts',
  // Sandbox, policy and routing
  'src/core/sandbox/**',
  'src/core/policy/**',
  'src/core/routing/**',
  'src/core/foundry/provenance.ts',
  'src/core/run/sandboxed-engine.ts',
  'src/core/run/engine-registry.ts',
  'src/core/resources/native-profile.ts',
  // Leader and learning
  'src/core/vision/leader-apply.ts',
  'src/core/learn/harness-registry.ts',
  'src/core/learn/experiments.ts',
  'src/core/local-eval/tasks-heldout.ts',
  // Other gate code: the host-merge protocol and the family enum
  'src/core/autonomy/host-merge-revocation-protocol.ts',
  'src/core/learning/agent-semantic-events.ts',
  // The control plane that lowers authority (Stop / Revoke) and asks for grants
  'src/core/verse/authority-api.ts',
  'src/cli/authority.ts',
]);

/**
 * HTTP route modules are Tier-1 PATHS (the fleet may not edit them) but not
 * closure-snapshot ROOTS: their import closure is the Verse server, and they
 * reach authority only through functions that are themselves roots. Rooting
 * them would make every new Verse feature trip the snapshot test for nothing.
 */
export const TIER1_CLOSURE_ROOT_EXCLUDES: readonly string[] = Object.freeze(['**/*-api.ts']);

/**
 * Test-name tokens that mark a test as covering Tier-1 code ("tests for all of
 * the above"). Matched against the test file's basename split on `.`, `-` and
 * `_`; a multi-word stem must appear as consecutive tokens. Deliberately
 * generous — over-matching sends a test change to Mason, under-matching could
 * let the fleet weaken the guard on its own gates.
 */
export const TIER1_TEST_STEMS: readonly string[] = Object.freeze([
  'authority', 'activation', 'standing', 'grant', 'grants', 'custody', 'trust', 'kill', 'enroll', 'enrollment',
  'tick-hooks', 'loop', 'post-merge', 'liveness', 'daemon-gates',
  'merge', 'automerge', 'host-merge', 'merge-gate', 'merge-gates', 'gate', 'gates', 'protected-paths', 'closure',
  'quarantine', 'regression-sentinel', 'dispatch-router', 'backpressure', 'mirror', 'mirrors', 'manager',
  'reviewer-independence', 'judge-independence', 'independence',
  'sandbox', 'confine', 'confinement', 'mutation-fence', 'safe-git', 'policy', 'routing', 'router', 'budget',
  'provenance', 'sandboxed-engine', 'leader-apply', 'harness-registry', 'revocation', 'agent-semantic',
  'home-isolation', 'tier1',
  'engine-registry', 'native-profile', 'experiments', 'heldout', 'tasks-heldout',
  'best-of-n', 'subscription-usage', 'leader-seat', 'reserve-breach',
]);

const ALL_REPO_RULES: readonly ProtectedPathRule[] = [
  {
    id: 'ci-config',
    scope: 'all-repos',
    patterns: [
      '.github/**', '.gitlab-ci.yml', '.gitlab/**', '.circleci/**', '.buildkite/**', '.travis.yml',
      'azure-pipelines.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml', '.woodpecker.yml', '.woodpecker/**',
    ],
    why: 'CI configuration decides which checks guard the default branch; only Mason changes it',
  },
  {
    id: 'codeowners',
    scope: 'all-repos',
    patterns: ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'],
    why: 'CODEOWNERS is the server-side copy of the owner lane',
  },
  {
    id: 'manifest',
    scope: 'all-repos',
    patterns: [
      '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/pnpm-lock.yaml',
      '**/pnpm-workspace.yaml', '**/yarn.lock', '**/bun.lockb', '**/bun.lock', '**/.npmrc', '**/.yarnrc',
      '**/.yarnrc.yml', '**/.pnpmfile.cjs', '**/ashlr.verify.json',
      '**/Cargo.toml', '**/Cargo.lock', '**/go.mod', '**/go.sum', '**/go.work', '**/pyproject.toml',
      '**/poetry.lock', '**/uv.lock', '**/requirements*.txt', '**/Pipfile', '**/Pipfile.lock', '**/setup.py',
      '**/setup.cfg', '**/Gemfile', '**/Gemfile.lock', '**/*.gemspec', '**/Package.swift', '**/Package.resolved',
      '**/composer.json', '**/composer.lock', '**/deno.json', '**/deno.jsonc', '**/deno.lock',
    ],
    why: 'manifests and lockfiles run code at install time and choose which verify commands run',
  },
  {
    // WHY (3.10 integration gap G1, INT3): the verify detector
    // (src/core/run/repo-profile.ts) decides which commands test a landing
    // from these files — a tsconfig.json alone adds `tsc --noEmit`, mypy /
    // ruff configs add `mypy` / `ruff check`, pytest.ini / tox.ini add
    // `pytest` — and each file also decides what that command checks
    // (`include: []`, `exclude = .`, `addopts = --co`). The post-merge watch
    // detects commands in the PARENT tree, but a fleet diff could still weaken
    // the config those commands read. So they are owner-lane in every repo,
    // not just ashlr-hub (whose own tsconfigs the self-repo rule already held).
    // `tsconfig*.json`, not only `tsconfig.json`: the root config usually
    // `extends` a `tsconfig.base.json`, and editing the base weakens the check
    // just as well. pytest.ini / tox.ini were only G1b tamper-level before;
    // they stay in the tamper list too (belt and braces).
    id: 'verify-config',
    scope: 'all-repos',
    patterns: [
      '**/tsconfig*.json', '**/mypy.ini', '**/.mypy.ini', '**/ruff.toml', '**/.ruff.toml', '**/pytest.ini',
      '**/tox.ini',
    ],
    why: 'verify configuration decides what the post-merge checks actually check',
  },
  {
    id: 'build-and-hooks',
    scope: 'all-repos',
    patterns: [
      '**/Dockerfile', '**/Dockerfile.*', '**/*.dockerfile', '**/docker-compose*.yml', '**/docker-compose*.yaml',
      '**/compose.yml', '**/compose.yaml', '**/Makefile', '**/justfile', '.gitattributes', '.gitmodules',
      '**/.gitattributes', '.husky/**', '.githooks/**', '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml',
      '**/.envrc', '.devcontainer/**', '.vscode/**',
    ],
    why: 'build files, git attributes and hook managers execute code on Mason\'s machine',
  },
  {
    id: 'release-tooling',
    scope: 'all-repos',
    patterns: [
      'scripts/release*', 'scripts/**/release*', 'scripts/build*', 'scripts/*authority*', 'scripts/install-custody*',
      'tools/custody/**', '**/*.plist', '**/*.entitlements', '**/src-tauri/capabilities/**',
      '**/src-tauri/tauri.conf.json', '**/src-tauri/tauri.*.conf.json',
    ],
    why: 'release, build, custody and launchd tooling ship or run with Mason\'s authority',
  },
  {
    id: 'secrets',
    scope: 'all-repos',
    patterns: [
      '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.p8', '**/*.jks', '**/*.keystore', '**/*.kdbx',
      '**/*.gpg', '**/.env', '**/.env.*', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/secrets/**',
      '**/.secrets/**',
    ],
    why: 'secret material never moves through a fleet PR',
  },
  {
    id: 'authority-doc',
    scope: 'all-repos',
    patterns: ['docs/RUNTIME_ACTIVATION_AUTHORITY.md', 'docs/**/*AUTHORITY*', 'docs/**/*authority*'],
    why: 'the authority documentation is the human contract for what the fleet may do',
  },
];

const SELF_REPO_RULES: readonly ProtectedPathRule[] = [
  {
    id: 'tier1-authority-code',
    scope: 'self-repo',
    patterns: TIER1_SOURCE_PATTERNS,
    why: 'Tier-1 authority code: the fleet may never change the code that decides what the fleet may do',
  },
  {
    id: 'tier1-test-infra',
    scope: 'self-repo',
    patterns: [
      // `**/tsconfig*.json` moved to the all-repos `verify-config` rule (it
      // matches first), so it is not repeated here.
      'test/setup/**', 'test/config/**', 'test/fixtures/authority/**', 'vitest.config*', 'vitest.workspace*',
    ],
    why: 'test setup and build config decide which tests run and whether HOME is isolated',
  },
];

/** Every rule, first match wins (all-repo rules first: their reasons are the more specific ones). */
export const PROTECTED_PATH_RULES: readonly ProtectedPathRule[] = Object.freeze([...ALL_REPO_RULES, ...SELF_REPO_RULES]);

const TIER1_TEST_RULE_ID = 'tier1-test';
const TIER1_TEST_WHY = 'this test guards Tier-1 authority code; weakening it would weaken the gate it tests';
const UNSAFE_PATH_RULE_ID = 'unsafe-path';

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Compile one lowercase glob. `**\/` spans zero or more directories; a trailing `**` spans the rest. */
function compileGlob(pattern: string): RegExp {
  const p = pattern.toLowerCase();
  let out = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (c === '{') {
      const end = p.indexOf('}', i);
      if (end > i) {
        const alternatives = p.slice(i + 1, end).split(',').map(escapeRegExp);
        out += `(?:${alternatives.join('|')})`;
        i = end + 1;
        continue;
      }
    }
    out += escapeRegExp(c);
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

interface CompiledRule {
  rule: ProtectedPathRule;
  regexes: readonly RegExp[];
}

const COMPILED_RULES: readonly CompiledRule[] = PROTECTED_PATH_RULES.map((rule) => ({
  rule,
  regexes: rule.patterns.map(compileGlob),
}));

const TIER1_SOURCE_REGEXES: readonly RegExp[] = TIER1_SOURCE_PATTERNS.map(compileGlob);
const CLOSURE_EXCLUDE_REGEXES: readonly RegExp[] = TIER1_CLOSURE_ROOT_EXCLUDES.map(compileGlob);

/** True when `path` (normalized, repo-relative) matches `pattern` under this module's glob rules. */
export function globMatches(pattern: string, path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return normalized !== null && compileGlob(pattern).test(normalized.toLowerCase());
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Normalize a diff path to repo-relative POSIX form, or null when it cannot be
 * trusted (absolute, `..`, empty segments, control characters, inside `.git`).
 * Callers treat null as PROTECTED: a path we cannot reason about is not the
 * fleet's to merge.
 */
export function normalizeRepoPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  let p = raw.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/') || p.length === 0) return null;
  const segments = p.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (segments.some((segment) => segment.toLowerCase() === '.git')) return null;
  return p;
}

/** True for ashlr-hub Tier-1 source (the self-repo authority-code rule). */
export function isTier1SourcePath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return TIER1_SOURCE_REGEXES.some((re) => re.test(lower));
}

/** True for a Tier-1 source path that is also a closure-snapshot root (API modules excluded). */
export function isTier1ClosureRoot(path: string): boolean {
  if (!isTier1SourcePath(path)) return false;
  const lower = path.toLowerCase();
  return /\.(?:ts|tsx|mts)$/.test(lower) && !lower.endsWith('.d.ts') &&
    !CLOSURE_EXCLUDE_REGEXES.some((re) => re.test(lower));
}

/** Test files: test dirs, `*.test.*` / `*.spec.*`, and snapshot files. */
export function isTestPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (/(^|\/)(?:test|tests|__tests__|spec|e2e)\//.test(lower)) return true;
  if (/(^|\/)__snapshots__\//.test(lower) || lower.endsWith('.snap')) return true;
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(lower);
}

function basenameTokens(path: string): string[] {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return base.split(/[._-]+/).filter((token) => token.length > 0);
}

function containsTokenRun(tokens: readonly string[], stem: string): boolean {
  const run = stem.toLowerCase().split(/[._-]+/).filter((t) => t.length > 0);
  if (run.length === 0 || run.length > tokens.length) return false;
  for (let start = 0; start + run.length <= tokens.length; start++) {
    if (run.every((token, offset) => tokens[start + offset] === token)) return true;
  }
  return false;
}

/**
 * ashlr-hub tests that guard Tier-1 code: the invariant / safety suites
 * (fleet/self.ts's never-weaken list), tests named for a Tier-1 module, and
 * tests the caller found importing Tier-1 source (`importsTier1`).
 */
export function isTier1TestPath(path: string, importsTier1 = false): boolean {
  const normalized = normalizeRepoPath(path);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (!lower.startsWith('test/')) return false;
  if (importsTier1) return true;
  if (isSafetyTestFile(normalized)) return true;
  const tokens = basenameTokens(lower);
  return TIER1_TEST_STEMS.some((stem) => containsTokenRun(tokens, stem));
}

// ---------------------------------------------------------------------------
// Import scanning (the content half of "tests for all of the above")
// ---------------------------------------------------------------------------

const IMPORT_SPECIFIER_RE =
  /(?:\bimport\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?|\bexport\s+(?:type\s+)?[^'"`;]*?\s+from\s+|\bimport\s*\(\s*|\bvi\.(?:mock|doMock|importActual)\s*\(\s*|\brequire\s*\(\s*)(['"])([^'"\n]{1,512})\1/g;

/**
 * Module specifiers a TS/JS file mentions (static / dynamic imports, re-exports,
 * `vi.mock(...)`, `require(...)`). Type-only imports count on purpose: a test
 * that only type-checks against Tier-1 code is still a test OF it.
 */
export function importSpecifiersIn(content: string): string[] {
  const out = new Set<string>();
  for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[2];
    if (specifier) out.add(specifier);
  }
  return [...out];
}

/** Resolve a relative specifier from `fromPath` to a repo-relative source path (`.js` → `.ts`). */
export function resolveRelativeImport(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const from = normalizeRepoPath(fromPath);
  if (!from) return null;
  const parts = from.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (parts.length === 0) return null;
  const joined = parts.join('/');
  return joined.replace(/\.(?:js|mjs|cjs)$/, (ext) => (ext === '.mjs' ? '.mts' : ext === '.cjs' ? '.cts' : '.ts'));
}

/** True when any content version of a test file imports ashlr-hub Tier-1 source. */
export function testContentImportsTier1(testPath: string, contents: readonly (string | null)[]): boolean {
  for (const content of contents) {
    if (typeof content !== 'string') continue;
    for (const specifier of importSpecifiersIn(content)) {
      const resolved = resolveRelativeImport(testPath, specifier);
      if (!resolved) continue;
      if (isTier1SourcePath(resolved)) return true;
      // `../src/core/sandbox` (a directory import) resolves to its index.
      if (isTier1SourcePath(`${resolved}/index.ts`)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// G1: classify a diff's paths
// ---------------------------------------------------------------------------

export interface ProtectedPathOptions {
  /** The target repo is ashlr-hub itself (Tier-1 self-repo rules apply). */
  selfRepo: boolean;
  /** Test paths (normalized) whose base or new content imports Tier-1 source. */
  testsImportingTier1?: ReadonlySet<string>;
}

/** The first rule `path` hits, or null when the fleet may merge it (subject to every other gate). */
export function matchProtectedPath(rawPath: string, opts: ProtectedPathOptions): ProtectedPathHit | null {
  const path = normalizeRepoPath(rawPath);
  if (!path) {
    return {
      // eslint-disable-next-line no-control-regex
      path: String(rawPath).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 200),
      ruleId: UNSAFE_PATH_RULE_ID,
      why: 'the diff names a path that cannot be normalized safely (absolute, "..", control characters or inside .git)',
    };
  }
  const lower = path.toLowerCase();
  for (const { rule, regexes } of COMPILED_RULES) {
    if (rule.scope === 'self-repo' && !opts.selfRepo) continue;
    if (regexes.some((re) => re.test(lower))) return { path, ruleId: rule.id, why: rule.why };
  }
  if (opts.selfRepo && isTier1TestPath(path, opts.testsImportingTier1?.has(path) === true)) {
    return { path, ruleId: TIER1_TEST_RULE_ID, why: TIER1_TEST_WHY };
  }
  return null;
}

/** Every protected hit among `paths` (one per path, in input order). */
export function protectedPathHits(paths: readonly string[], opts: ProtectedPathOptions): ProtectedPathHit[] {
  const hits: ProtectedPathHit[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const hit = matchProtectedPath(raw, opts);
    if (!hit || seen.has(hit.path)) continue;
    seen.add(hit.path);
    hits.push(hit);
  }
  return hits;
}

/**
 * The ashlr-hub test files G1 sends to the owner lane under the `tier1-test`
 * rule — by name (TIER1_TEST_STEMS), as a safety suite, or because their
 * content imports Tier-1 source — computed with the SAME matchProtectedPath the
 * gate runs. PURE: the caller supplies each test file's content (null = not
 * scanned for imports). Sorted, unique, repo-relative.
 *
 * WHY an explicit list and not globs (3.10 review c14): the import half of
 * the rule has no glob form, and GitHub's CODEOWNERS syntax has no character
 * classes, so a name-stem glob either misses separators or over-matches
 * (`*gate*` owns `delegate.test.ts`). An exact list keeps GitHub and G1 in
 * agreement; the CODEOWNERS test walks test/ and fails when a new Tier-1 test
 * is missing, so the list cannot silently fall behind.
 */
export function tier1TestPathsIn(files: Iterable<{ path: string; content: string | null }>): string[] {
  const out = new Set<string>();
  for (const file of files) {
    const path = normalizeRepoPath(file.path);
    if (!path || !path.toLowerCase().startsWith('test/')) continue;
    const imports = testContentImportsTier1(path, [file.content]);
    const hit = matchProtectedPath(path, imports ? { selfRepo: true, testsImportingTier1: new Set([path]) } : { selfRepo: true });
    if (hit?.ruleId === TIER1_TEST_RULE_ID) out.add(path);
  }
  return [...out].sort();
}

/** Characters CODEOWNERS treats specially (or GitHub does not support): a path holding one cannot be listed literally. */
const CODEOWNERS_UNSAFE_PATH_RE = /[\s#![\]\\*?]/u;

export interface CodeownersRenderOptions {
  selfRepo: boolean;
  /**
   * ashlr-hub only: the `tier1-test` owner-lane files (tier1TestPathsIn over
   * the checkout's test/ tree). Rendered one per line so GitHub holds the
   * same Tier-1 tests G1 does. Omitted = none rendered (other repos).
   */
  tier1TestPaths?: readonly string[];
}

/**
 * The owner-lane rules rendered as CODEOWNERS lines, so B-U1's CODEOWNERS and
 * this list cannot drift (the App is never a code owner, so GitHub itself
 * holds every one of these paths for Mason's review). For ashlr-hub the
 * `tier1-test` rule — which lives in matchProtectedPath, not in
 * PROTECTED_PATH_RULES — is rendered from `tier1TestPaths` (3.10 review c14:
 * it used to be dropped, so GitHub owned none of the invariant suites).
 */
export function renderCodeownersBlock(owner: string, opts: CodeownersRenderOptions): string {
  if (!/^@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9._-]+)?$/.test(owner)) {
    throw new Error('CODEOWNERS owner must be @user or @org/team');
  }
  const lines = [
    '# Generated from src/core/authority/protected-paths.ts — the fleet\'s owner lane (SPEC-310B §2 G1).',
    '# The ashlr-fleet App is never a code owner, so every path below needs the owner\'s review on GitHub too.',
  ];
  for (const rule of PROTECTED_PATH_RULES) {
    if (rule.scope === 'self-repo' && !opts.selfRepo) continue;
    lines.push(`# ${rule.id}: ${rule.why}`);
    for (const pattern of rule.patterns) {
      // CODEOWNERS anchors a leading "/" at the repo root; a "**/" prefix matches anywhere.
      const rendered = pattern.startsWith('**/') ? pattern : `/${pattern}`;
      lines.push(`${rendered} ${owner}`);
    }
  }
  if (opts.selfRepo && opts.tier1TestPaths && opts.tier1TestPaths.length > 0) {
    const paths = [...new Set(opts.tier1TestPaths)].sort();
    lines.push(`# ${TIER1_TEST_RULE_ID}: ${TIER1_TEST_WHY}`);
    lines.push('# (every test G1 holds by name, safety suite or Tier-1 import; test/authority-codeowners-310b.test.ts regenerates this list)');
    for (const raw of paths) {
      const path = normalizeRepoPath(raw);
      if (!path || !path.toLowerCase().startsWith('test/') || CODEOWNERS_UNSAFE_PATH_RE.test(path)) {
        throw new Error(`cannot list ${JSON.stringify(raw)} in CODEOWNERS: not a plain test/ path`);
      }
      lines.push(`/${path} ${owner}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// G1b: test tampering
// ---------------------------------------------------------------------------

export type TamperKind =
  | 'test-file-deleted'
  | 'test-calls-removed'
  | 'test-focused-or-skipped'
  | 'snapshot-edited'
  | 'test-config-edited';

export interface TamperFinding {
  kind: TamperKind;
  path: string;
  detail: string;
}

export interface TamperScan {
  findings: TamperFinding[];
  /** Non-null when the diff could not be read — callers fail closed. */
  parseError: string | null;
}

/**
 * Test-runner configuration in any repo. Changing it can silently stop tests
 * from running (excludes, `passWithNoTests`, a new setup file that stubs
 * `expect`) — which is tampering even though no test file changed.
 */
const TEST_CONFIG_PATTERNS: readonly RegExp[] = [
  '**/vitest.config.*', '**/vitest.workspace.*', '**/vitest.setup.*', '**/jest.config.*', '**/jest.setup.*',
  '**/playwright.config.*', '**/cypress.config.*', '**/.mocharc*', '**/karma.conf.*', '**/pytest.ini',
  '**/conftest.py', '**/tox.ini', '**/.nycrc*', '**/ava.config.*',
].map(compileGlob);

const TEST_CALL_KINDS = [
  { name: 'it(', re: /\bit(?:\.[A-Za-z]+)*\s*\(/g },
  { name: 'test(', re: /\btest(?:\.[A-Za-z]+)*\s*\(/g },
  { name: 'expect(', re: /\bexpect(?:\.[A-Za-z]+)*\s*\(/g },
] as const;

const FOCUS_OR_SKIP_RE =
  /\b(?:describe|it|test|suite|context|bench)(?:\.[A-Za-z]+)*\.(?:skip|only|skipIf|runIf)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe|ftest)\s*\(/g;

const SNAPSHOT_ASSERTION_RE = /\bto(?:Match(?:Inline)?Snapshot|ThrowErrorMatching(?:Inline)?Snapshot)\s*\(/;

interface DiffSection {
  oldPath: string | null;
  newPath: string | null;
  deleted: boolean;
  created: boolean;
  added: string[];
  removed: string[];
}

function decodeCQuoted(token: string): string | null {
  // git quotes a path with C escapes when it holds special characters.
  if (!token.startsWith('"')) return token;
  if (!token.endsWith('"') || token.length < 2) return null;
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
    if (next in simple) {
      bytes.push(simple[next]!);
      i += 1;
      continue;
    }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    return null;
  }
  return Buffer.from(bytes).toString('utf8');
}

function headerPath(raw: string, prefix: 'a/' | 'b/'): string | null | undefined {
  // `--- a/path` / `+++ b/path`, optionally followed by a tab (git adds one
  // when the path has spaces); /dev/null means "no file on this side".
  const value = raw.split('\t')[0]!;
  if (value === '/dev/null') return null;
  const decoded = decodeCQuoted(value);
  if (decoded === null) return undefined;
  return decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded;
}

/** Split a unified git diff into per-file sections with their added / removed content lines. */
function splitDiff(diff: string): DiffSection[] | string {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let inHunk = false;
  for (const rawLine of diff.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('diff --git ')) {
      current = { oldPath: null, newPath: null, deleted: false, created: false, added: [], removed: [] };
      sections.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      if (line.startsWith('deleted file mode')) current.deleted = true;
      else if (line.startsWith('new file mode')) current.created = true;
      else if (line.startsWith('rename from ')) current.oldPath = decodeCQuoted(line.slice(12)) ?? current.oldPath;
      else if (line.startsWith('rename to ')) current.newPath = decodeCQuoted(line.slice(10)) ?? current.newPath;
      else if (line.startsWith('--- ')) {
        const path = headerPath(line.slice(4), 'a/');
        if (path === undefined) return `unreadable file header: ${line.slice(0, 120)}`;
        current.oldPath = path;
      } else if (line.startsWith('+++ ')) {
        const path = headerPath(line.slice(4), 'b/');
        if (path === undefined) return `unreadable file header: ${line.slice(0, 120)}`;
        current.newPath = path;
      } else if (line.startsWith('@@')) inHunk = true;
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        return 'binary patches cannot be checked for test tampering';
      }
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }
  if (diff.trim().length > 0 && sections.length === 0) return 'no file sections found in the diff';
  return sections;
}

/**
 * Lines each file section ADDS (new content only), keyed by the path the
 * section names (new path, else old). null when the diff cannot be split.
 * G1 uses it to see imports a diff adds to a test file.
 */
export function diffAddedLinesByPath(diff: string): Map<string, string[]> | null {
  const split = splitDiff(diff);
  if (typeof split === 'string') return null;
  const out = new Map<string, string[]>();
  for (const section of split) {
    const path = section.newPath ?? section.oldPath;
    if (!path) return null;
    out.set(path, [...(out.get(path) ?? []), ...section.added]);
  }
  return out;
}

function countMatches(lines: readonly string[], re: RegExp): number {
  const global = new RegExp(re.source, 'g');
  let n = 0;
  for (const line of lines) n += [...line.matchAll(global)].length;
  return n;
}

/**
 * G1b. Counting is NET per file and per call kind, so moving an `expect(` a
 * few lines (removed + re-added) is not tampering, while deleting one is.
 * New snapshot files (a new test writing its first snapshot) are allowed;
 * editing or deleting an existing one is not.
 */
export function detectTestTampering(diff: string): TamperScan {
  if (typeof diff !== 'string' || diff.trim().length === 0) {
    return { findings: [], parseError: 'empty diff' };
  }
  const split = splitDiff(diff);
  if (typeof split === 'string') return { findings: [], parseError: split };
  const findings: TamperFinding[] = [];
  for (const section of split) {
    const path = section.newPath ?? section.oldPath;
    if (!path) return { findings, parseError: 'a file section names no path' };
    const lower = path.toLowerCase();
    const oldLower = (section.oldPath ?? path).toLowerCase();

    if (TEST_CONFIG_PATTERNS.some((re) => re.test(lower) || re.test(oldLower))) {
      findings.push({ kind: 'test-config-edited', path, detail: `test-runner configuration ${path} changed` });
      continue;
    }

    const snapshotFile = /(^|\/)__snapshots__\//.test(lower) || lower.endsWith('.snap');
    if (snapshotFile) {
      if (!section.created) {
        findings.push({
          kind: 'snapshot-edited',
          path,
          detail: section.deleted ? `snapshot ${path} deleted` : `existing snapshot ${path} edited`,
        });
      }
      continue;
    }

    if (!isTestPath(path) && !(section.oldPath !== null && isTestPath(section.oldPath))) continue;

    if (section.deleted) {
      findings.push({ kind: 'test-file-deleted', path, detail: `test file ${path} deleted` });
      continue;
    }
    for (const kind of TEST_CALL_KINDS) {
      const removed = countMatches(section.removed, kind.re);
      const added = countMatches(section.added, kind.re);
      if (removed > added) {
        findings.push({
          kind: 'test-calls-removed',
          path,
          detail: `${path}: ${removed - added} net ${kind.name} call(s) removed`,
        });
      }
    }
    const focusAdded = countMatches(section.added, FOCUS_OR_SKIP_RE);
    const focusRemoved = countMatches(section.removed, FOCUS_OR_SKIP_RE);
    if (focusAdded > focusRemoved) {
      findings.push({
        kind: 'test-focused-or-skipped',
        path,
        detail: `${path}: adds ${focusAdded - focusRemoved} .skip/.only/skipIf/runIf (or x/f-prefixed) test declaration(s)`,
      });
    }
    if (section.removed.some((line) => SNAPSHOT_ASSERTION_RE.test(line))) {
      findings.push({ kind: 'snapshot-edited', path, detail: `${path}: changes a snapshot assertion` });
    }
  }
  return { findings, parseError: null };
}
