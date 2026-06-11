/**
 * CLI handler for `ashlr verify-safety` — H4 READ-ONLY safety self-check.
 *
 * The runtime analogue of the H4 regression suite. It runs the STRUCTURAL safety
 * guards against the INSTALLED build and prints a pass/fail report, so a human or
 * CI can confirm — on any machine — that the hard safety invariants still hold.
 *
 * Usage:
 *   ashlr verify-safety            # human-readable PASS/FAIL report
 *   ashlr verify-safety --json     # machine-readable { ok, checks: [...] }
 *
 * HARD CONTRACT (docs/contracts/CONTRACT-H4.md §Verify-Safety) — this command:
 *  - MUTATES NOTHING. It writes no file, creates no sandbox, enrolls nothing,
 *    toggles no kill switch, and creates no proposal. It performs only reads
 *    (source reads) and pure in-memory checks.
 *  - MAKES NO OUTWARD CALL. No network, no `git push`, no PR, no deploy, no model
 *    spawn. Local-only and side-effect-free by construction.
 *  - Runs these READ-ONLY structural checks (each → one PASS/FAIL line):
 *      1. ENROLLMENT default-empty: an absent/malformed registry parses to
 *         { repos: [] } (checked against synthesized in-memory input).
 *      2. KILL-SWITCH precedence: assertMayMutate enforces the kill check BEFORE
 *         the enrollment/allowAnyRepo check (source check — never touches
 *         ~/.ashlr/KILL).
 *      3. DAEMON exports no outward primitive: daemon/loop.ts imports/call-tokens
 *         contain no apply/push/createPr/deploy.
 *      4. SCRUB patterns match: index.ts/graph.ts scrubSecrets redact a
 *         synthesized secret string (in-memory; no file written).
 *      5. PROVIDER cloud-gate present: provider-client.ts defines the cloud gate
 *         and the !allowCloud throw path.
 *
 * Exit codes: 0 all checks pass, 1 one or more FAIL (so CI can gate), 2 bad usage.
 *
 * NOTE (integration — owned by the Build/Integrate phase, NOT this scaffold):
 *   src/cli/index.ts must add a
 *     `loadVerifySafetyCmd = lazyCmd(() => import('./verify-safety.js'),
 *        (m) => m.cmdVerifySafety as Cmd, 'verify-safety requires src/cli/verify-safety.ts (H4)')`,
 *   a `case 'verify-safety':` arm in the dispatch switch, and a cmdHelp entry.
 *
 * No new runtime deps; node builtins only; never throws out of cmdVerifySafety.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// The REAL secret-scrub guard — imported (not copied) so CHECK 4 exercises the
// actual redaction logic. This is a pure, local-only function (no network, no
// I/O); importing it keeps verify-safety side-effect-free and outward-call-free.
import { scrubSecrets, SECRET_PATTERNS } from '../core/knowledge/index.js';

// ---------------------------------------------------------------------------
// Source reader (resolves the build's OWN sibling source for STATIC checks)
// ---------------------------------------------------------------------------

/**
 * A reader for a `core/` module's text. Injectable so the H4 suite can feed a
 * deliberately-broken synthesized source to prove a check actually FAILs
 * (CONTRACT-H4 §Verify-Safety). The production default reads this build's own
 * sibling source.
 *
 * @param relFromCore path RELATIVE to `core/` WITHOUT extension, e.g.
 *   `daemon/loop`.
 */
export type CoreSourceReader = (relFromCore: string) => string;

/**
 * Read a module under `core/` of THIS build as raw UTF-8 text. Resolved RELATIVE
 * to this running module (`<root>/cli/verify-safety.<ext>` → `<root>/core/<rel>`),
 * so it works for both the compiled build (`dist/core/...js`) and the dev/test
 * tree (`src/core/...ts`). Tries this file's own extension first, then the
 * sibling extension, so a `.ts` test run still resolves the `.ts` source.
 *
 * READ-ONLY: a plain `readFileSync`. Makes no outward call and writes nothing.
 */
function defaultReadCore(relFromCore: string): string {
  const here = dirname(fileURLToPath(import.meta.url)); // <root>/cli
  const coreDir = resolve(here, '..', 'core'); // <root>/core
  const selfExt = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const otherExt = selfExt === '.ts' ? '.js' : '.ts';
  const base = join(coreDir, relFromCore);
  try {
    return readFileSync(base + selfExt, 'utf8');
  } catch {
    return readFileSync(base + otherExt, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Static-scan helpers (comment-strip + import specifiers + token scan)
// ---------------------------------------------------------------------------

/**
 * Strip `//` line comments and block comments so a forbidden-call-token scan
 * never trips on a passing mention inside a comment. Conservative — does not
 * parse strings (acceptable: the scanned tokens never legitimately live in a
 * string literal in these modules).
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Extract the set of module specifiers imported by `src`. */
function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bimport\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, bareRe, dynRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (m[1] !== undefined) specs.push(m[1]);
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Check model
// ---------------------------------------------------------------------------

/** One structural-guard result line in the report. */
export interface SafetyCheck {
  /** Stable short id, e.g. 'enrollment-default-empty'. */
  readonly id: string;
  /** Human-readable description of the invariant being checked. */
  readonly label: string;
  /** True when the guard holds. */
  readonly pass: boolean;
  /** Short detail / failure reason (empty when trivially passing). */
  readonly detail: string;
}

/** The full report emitted by `verify-safety --json`. */
export interface SafetyReport {
  /** True iff EVERY check passed. */
  readonly ok: boolean;
  /** One entry per structural check, in run order. */
  readonly checks: SafetyCheck[];
}

/** Options for {@link runSafetyChecks} — an injectable source reader (test seam). */
export interface RunSafetyOptions {
  /**
   * Override the `core/` source reader. Defaults to reading THIS build's own
   * sibling source. The H4 suite injects a reader that returns a broken source
   * for one module to prove the corresponding check FAILs (i.e. the command
   * actually gates and is not always-green). MUST stay read-only.
   */
  readSource?: CoreSourceReader;
}

// ---------------------------------------------------------------------------
// Structural checks (READ-ONLY) — each is a pure read + in-memory assertion.
// ---------------------------------------------------------------------------

/**
 * The complete set of structural-check ids the report MUST contain. A runtime
 * coverage guard in {@link runSafetyChecks} emits a synthetic FAIL for any id
 * here that did not run, so dropping a runner fails CI rather than silently
 * shrinking coverage to a smaller all-passing set.
 */
const EXPECTED_CHECK_IDS = [
  'enrollment-default-empty',
  'kill-switch-precedence',
  'daemon-no-primitive',
  'scrub-patterns-match',
  'provider-cloud-gate',
] as const;

/** Construct a SafetyCheck, normalizing the detail string. */
function mk(id: string, label: string, pass: boolean, detail = ''): SafetyCheck {
  return { id, label, pass, detail };
}

/** Normalize an unknown thrown value to a message string. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Replicates policy.ts's `readRegistry` parse semantics on a SYNTHESIZED
 * in-memory string — never reading or writing the real registry — so we can
 * assert the DEFAULT-EMPTY guarantee at runtime. Mirrors the real parser:
 * absent/malformed/non-`{repos:[]}` input yields `{ repos: [] }`; a valid
 * `{ repos: [...] }` keeps only the string entries.
 */
function parseRegistryLike(raw: string | null): { repos: string[] } {
  if (raw === null) return { repos: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>)['repos'])
    ) {
      const repos = ((parsed as Record<string, unknown>)['repos'] as unknown[]).filter(
        (r): r is string => typeof r === 'string',
      );
      return { repos };
    }
  } catch {
    // malformed — treat as empty
  }
  return { repos: [] };
}

/**
 * CHECK 1 — ENROLLMENT default-empty semantics. Asserts the registry parser
 * yields `{ repos: [] }` for absent (null), malformed (`{`), and wrong-shape
 * (`[]`, `{"repos":"x"}`) inputs, and keeps only string entries otherwise. Runs
 * entirely in-memory against synthesized inputs — the real registry is never
 * touched.
 */
function checkEnrollmentDefaultEmpty(): SafetyCheck {
  const id = 'enrollment-default-empty';
  const label = 'ENROLLMENT: absent/malformed registry parses to { repos: [] }';
  const emptyCases: (string | null)[] = [null, '', '{', 'null', '[]', '{}', '{"repos":"nope"}'];
  for (const raw of emptyCases) {
    const got = parseRegistryLike(raw);
    if (got.repos.length !== 0) {
      return mk(id, label, false, `input ${JSON.stringify(raw)} did not yield empty repos`);
    }
  }
  // A valid registry keeps only string entries (drops non-strings).
  const mixed = parseRegistryLike('{"repos":["/a",5,"/b",null]}');
  if (mixed.repos.length !== 2 || mixed.repos[0] !== '/a' || mixed.repos[1] !== '/b') {
    return mk(id, label, false, 'valid registry did not normalize to its string entries');
  }
  return mk(id, label, true);
}

/**
 * CHECK 2 — KILL-SWITCH precedes the enrollment / allowAnyRepo gate. Asserts (by
 * reading the real `assertMayMutate` source) that the kill-switch check appears
 * BEFORE the enrollment check, so `allowAnyRepo` can never reach a mutation while
 * kill is on. Pure source read — never touches `~/.ashlr/KILL`.
 */
function checkKillSwitchPrecedence(read: CoreSourceReader): SafetyCheck {
  const id = 'kill-switch-precedence';
  const label = 'KILL-SWITCH: kill check precedes the enrollment/allowAnyRepo check';
  let src: string;
  try {
    src = stripComments(read('sandbox/policy'));
  } catch (err) {
    return mk(id, label, false, `could not read policy source: ${errMsg(err)}`);
  }
  const fnIdx = src.indexOf('function assertMayMutate');
  if (fnIdx === -1) return mk(id, label, false, 'assertMayMutate not found in policy source');
  // Scan the function BODY (after the parameter list) so the `allowAnyRepo`
  // TYPE annotation in the signature never reorders the comparison — we compare
  // the kill GUARD against the enrollment GUARD, which is unambiguous.
  const bodyIdx = src.indexOf('{', fnIdx);
  const body = bodyIdx === -1 ? src.slice(fnIdx) : src.slice(bodyIdx);
  const killIdx = body.indexOf('killSwitchOn(');
  const enrollIdx = body.indexOf('isEnrolled(');
  if (killIdx === -1) return mk(id, label, false, 'assertMayMutate has no killSwitchOn() check');
  if (enrollIdx === -1) return mk(id, label, false, 'assertMayMutate has no isEnrolled() check');
  // The kill-switch check MUST appear before the enrollment/allowAnyRepo gate so
  // allowAnyRepo can never reach a mutation while kill is on.
  if (killIdx > enrollIdx) {
    return mk(id, label, false, 'kill-switch check does NOT precede the enrollment/allowAnyRepo check');
  }
  return mk(id, label, true);
}

/**
 * CHECK 3 — DAEMON exports no outward primitive (the [STATIC] grep-guard). Reads
 * `daemon/loop` and asserts its import specifiers + comment-stripped call tokens
 * contain none of apply/push/createPr/deploy. The only inbox import allowed is
 * the read-only `inbox/store` (pendingCount).
 */
function checkDaemonNoPrimitive(read: CoreSourceReader): SafetyCheck {
  const id = 'daemon-no-primitive';
  const label = 'PROPOSAL-ONLY: daemon/loop imports no apply/push/createPr/deploy primitive';
  let src: string;
  try {
    src = read('daemon/loop');
  } catch (err) {
    return mk(id, label, false, `could not read daemon/loop source: ${errMsg(err)}`);
  }
  // Forbidden import specifiers (substring match on each specifier). Includes
  // the modules that EXPORT outward primitives (apply/createPr/ship/deploy) so a
  // bare named import of one is caught at its specifier even if the call token
  // is later renamed.
  const forbiddenImports = ['inbox/apply', 'integrations/github', 'ship/', 'deploy'];
  for (const spec of importSpecifiers(src)) {
    for (const bad of forbiddenImports) {
      if (spec.includes(bad)) {
        return mk(id, label, false, `forbidden import specifier: ${spec}`);
      }
    }
  }
  // Forbidden CALL tokens (comment-stripped, so a doc-comment mention is fine).
  // Kept in lockstep with the H4 regression suite's set
  // (test/h4.proposal-only.test.ts guard 1.9) so the runtime self-check and CI
  // assert the SAME token surface — including the gitPush( helper form.
  const stripped = stripComments(src);
  const forbiddenTokens = ['applyProposal(', 'createPr(', 'git push', 'gitPush(', 'deploy('];
  for (const tok of forbiddenTokens) {
    if (stripped.includes(tok)) {
      return mk(id, label, false, `forbidden outward call token: ${tok}`);
    }
  }
  return mk(id, label, true);
}

/**
 * CHECK 4 — SCRUB patterns redact a synthesized secret. Reads the index.ts and
 * graph.ts scrub sources for the drift markers, then invokes the REAL (imported,
 * not copied) `scrubSecrets` over a synthesized JWT / AWS key / assignment-style
 * secret and asserts every raw value is gone. Because it runs the actual
 * redaction logic, a weakening of the real function body or pattern set FAILs
 * this check. Run entirely in-memory on a synthesized string — no file is read
 * into the index and nothing is written.
 */
function checkScrubPatterns(read: CoreSourceReader): SafetyCheck {
  const id = 'scrub-patterns-match';
  const label = 'SECRET-SCRUB: index.ts/graph.ts scrubSecrets redact a synthesized secret';
  let indexSrc: string;
  let graphSrc: string;
  try {
    indexSrc = read('knowledge/index');
    graphSrc = read('knowledge/graph');
  } catch (err) {
    return mk(id, label, false, `could not read scrub sources: ${errMsg(err)}`);
  }
  // Both impls must define a scrubSecrets + a SECRET pattern source.
  if (!/function scrubSecrets/.test(indexSrc) || !/SECRET_PATTERNS/.test(indexSrc)) {
    return mk(id, label, false, 'index.ts is missing scrubSecrets / SECRET_PATTERNS');
  }
  if (!/function scrubSecrets/.test(graphSrc) || !/SECRET_PATTERNS/.test(graphSrc)) {
    return mk(id, label, false, 'graph.ts is missing scrubSecrets / SECRET_PATTERNS');
  }
  // The index high-entropy markers must still be present (drift-guard against
  // an INJECTED/broken source where the real import can't be swapped). This is
  // what the H4 broken-reader negative test trips: a source missing these
  // markers fails here even though the real import below still redacts.
  if (!indexSrc.includes('AKIA') || !indexSrc.includes('eyJ')) {
    return mk(id, label, false, 'index.ts no longer pins the AWS/JWT secret patterns');
  }
  // STRENGTH: run the REAL scrubSecrets (imported, not copied) over a synthesized
  // secret carrying a JWT, an AWS key, and an assignment-style api_key. If a
  // future change weakens the actual function body OR any pattern in the real
  // SECRET_PATTERNS array, the raw values survive and this check FAILs — so the
  // self-check tracks the real redaction logic, not a drifting private copy.
  const synthSecret = [
    'api_key = "abcdefghij0123456789ABCDEFGHIJ"',
    'aws=AKIAIOSFODNN7EXAMPLE',
    'jwt=eyJhbGci.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36',
  ].join(' ');
  const scrubbed = scrubSecrets(synthSecret);
  for (const raw of [
    'abcdefghij0123456789ABCDEFGHIJ',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGci.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36',
  ]) {
    if (scrubbed.includes(raw)) {
      return mk(id, label, false, `real scrubSecrets left a secret unredacted: ${raw}`);
    }
  }
  if (!scrubbed.includes('[REDACTED]')) {
    return mk(id, label, false, 'real scrubSecrets produced no [REDACTED] marker');
  }
  // The real pattern array must still carry the high-entropy shapes (a complete
  // wipe of the array would leave the synthSecret above only assignment-covered;
  // pin the count so silent shrinkage of the pattern set is visible).
  if (SECRET_PATTERNS.length < 6) {
    return mk(id, label, false, `index SECRET_PATTERNS shrank to ${SECRET_PATTERNS.length} (<6)`);
  }
  // graph.ts must DELEGATE to index.ts's real scrub via the parity import
  // (live code, not a vestigial assignment-regex comment): pin the
  // `from './index.js'` import pulling scrubSecrets + SECRET_PATTERNS, which is
  // the genuine H6 §B.1 strengthening. A cosmetic comment edit can no longer
  // trip this; only removing the real delegation will.
  if (!/from ['"]\.\/index\.js['"]/.test(graphSrc) ||
      !/scrubSecrets/.test(graphSrc) || !/SECRET_PATTERNS/.test(graphSrc)) {
    return mk(id, label, false, 'graph.ts no longer imports the index.ts parity scrub');
  }
  return mk(id, label, true);
}

/**
 * CHECK 5 — PROVIDER cloud-gate present. Reads `run/provider-client` and asserts
 * it defines the `CLOUD_PROVIDERS` gate and the `!opts.allowCloud` (local-first)
 * throw path, so cloud egress can never happen silently.
 */
function checkProviderCloudGate(read: CoreSourceReader): SafetyCheck {
  const id = 'provider-cloud-gate';
  const label = 'LOCAL-FIRST: provider-client defines the cloud gate + !allowCloud throw';
  let src: string;
  try {
    src = read('run/provider-client');
  } catch (err) {
    return mk(id, label, false, `could not read provider-client source: ${errMsg(err)}`);
  }
  if (!/CLOUD_PROVIDERS\s*=\s*new Set/.test(src)) {
    return mk(id, label, false, 'CLOUD_PROVIDERS gate set not found');
  }
  if (!/isCloudProvider\(/.test(src)) {
    return mk(id, label, false, 'isCloudProvider() gate not found');
  }
  const stripped = stripComments(src);
  if (!/!\s*opts\.allowCloud/.test(stripped)) {
    return mk(id, label, false, '!allowCloud throw path not found');
  }
  if (!/Pass --allow-cloud/.test(stripped)) {
    return mk(id, label, false, 'local-first cloud-gate error message not found');
  }
  // ORDERING (mirrors CHECK 2's kill/enroll precedence technique): a present-but-
  // bypassed gate (throw moved below the local-client build, or an early `return`
  // added before the gate) must NOT pass. Scope the scan to the getActiveClient
  // function BODY so an earlier buildOllamaClient/buildLmStudioClient DEFINITION
  // never confuses the call-site ordering; then assert the cloud-gate refusal
  // appears BEFORE the first LOCAL provider client is BUILT (called).
  const fnIdx = stripped.search(/function getActiveClient\b/);
  const body = fnIdx === -1 ? stripped : stripped.slice(fnIdx);
  const gateIdx = body.search(/if\s*\(\s*isCloudProvider\(/);
  // The cloud-gate refusal is uniquely marked by its 'Pass --allow-cloud' message;
  // use that marker's position as the throw site (robust to error-text edits).
  const throwIdx = body.indexOf('Pass --allow-cloud');
  const allowIdx = body.indexOf('!opts.allowCloud');
  // Call sites within the function body. The body slice starts AT
  // `function getActiveClient`, so the earlier `function buildOllamaClient` /
  // `function buildLmStudioClient` DEFINITIONS are already excluded — any
  // `buildOllamaClient(` / `buildLmStudioClient(` token here is a CALL.
  const localBuildIdx = (() => {
    const o = body.indexOf('buildOllamaClient(');
    const l = body.indexOf('buildLmStudioClient(');
    if (o === -1) return l;
    if (l === -1) return o;
    return Math.min(o, l);
  })();
  if (gateIdx === -1) {
    return mk(id, label, false, 'isCloudProvider() gate block not found in body');
  }
  if (allowIdx === -1 || allowIdx < gateIdx) {
    return mk(id, label, false, '!opts.allowCloud check is not inside the cloud-gate block');
  }
  if (localBuildIdx !== -1 && throwIdx !== -1 && throwIdx > localBuildIdx) {
    return mk(id, label, false, 'cloud-gate throw does NOT precede the local client build (bypassable)');
  }
  if (localBuildIdx !== -1 && gateIdx > localBuildIdx) {
    return mk(id, label, false, 'cloud-gate block does NOT precede the local client build');
  }
  return mk(id, label, true);
}

/**
 * Run all READ-ONLY structural safety checks and return the report.
 *
 * MUTATES NOTHING and makes NO outward call: each check is a pure read (source
 * text + in-memory assertions). Never throws — an unexpected error inside a
 * check is captured as that check FAILing (a thrown check would otherwise be
 * indistinguishable from a missing guard).
 *
 * @param opts optional injectable source reader (test seam, default = this
 *   build's own sibling source).
 */
export function runSafetyChecks(opts?: RunSafetyOptions): SafetyReport {
  const read = opts?.readSource ?? defaultReadCore;
  const runners: (() => SafetyCheck)[] = [
    () => checkEnrollmentDefaultEmpty(),
    () => checkKillSwitchPrecedence(read),
    () => checkDaemonNoPrimitive(read),
    () => checkScrubPatterns(read),
    () => checkProviderCloudGate(read),
  ];
  const checks: SafetyCheck[] = [];
  for (const run of runners) {
    try {
      checks.push(run());
    } catch (err) {
      // A check should never throw, but if one does, record it as a FAIL rather
      // than letting it escape cmdVerifySafety.
      checks.push(mk('check-error', 'a structural check threw', false, errMsg(err)));
    }
  }
  // COVERAGE GUARD: a future edit that drops a runner from the array must FAIL CI
  // rather than silently shrink the report to a smaller all-passing set. Emit a
  // synthetic FAIL for any EXPECTED id that is missing from the produced checks.
  const producedIds = new Set(checks.map((c) => c.id));
  for (const expected of EXPECTED_CHECK_IDS) {
    if (!producedIds.has(expected)) {
      checks.push(
        mk('missing-check', `expected check '${expected}' did not run`, false, `coverage regression: '${expected}' is missing from the safety report`),
      );
    }
  }
  const ok = checks.length > 0 && checks.every((c) => c.pass);
  return { ok, checks };
}

// ---------------------------------------------------------------------------
// Parsed args
// ---------------------------------------------------------------------------

interface ParsedArgs {
  json: boolean;
  help: boolean;
  error: string | null;
}

/** Parse the verify-safety argv. Recognizes only --json/--help; rejects others. */
function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, help: false, error: null };
  for (const a of args) {
    if (a === '--json') parsed.json = true;
    else if (a === '--help' || a === '-h') parsed.help = true;
    else {
      parsed.error = `unknown argument: ${a}`;
      break;
    }
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(
    [
      'ashlr verify-safety — READ-ONLY safety self-check (mutates nothing).',
      '',
      'Usage:',
      '  ashlr verify-safety           Human-readable PASS/FAIL report',
      '  ashlr verify-safety --json    Machine-readable { ok, checks: [...] }',
      '',
      'Exit codes: 0 all pass · 1 a check failed · 2 bad usage',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Render the human-readable PASS/FAIL report to stdout. */
function renderReport(report: SafetyReport): void {
  for (const c of report.checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    const detail = c.detail ? ` — ${c.detail}` : '';
    process.stdout.write(`[${tag}] ${c.label}${detail}\n`);
  }
  if (report.checks.length === 0) {
    process.stdout.write('verify-safety: no checks ran (unexpected).\n');
  }
  process.stdout.write(
    `\n${report.ok ? 'OK' : 'FAILED'}: ${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks passed\n`,
  );
}

// ---------------------------------------------------------------------------
// cmdVerifySafety — the CLI entry point (Cmd shape: src/cli/index.ts:59)
// ---------------------------------------------------------------------------

/**
 * `ashlr verify-safety` entry point. READ-ONLY: runs the structural safety
 * checks and prints the report. Returns 0 when every check passes, 1 when any
 * check fails, 2 on bad usage. Never throws.
 */
export async function cmdVerifySafety(args: string[]): Promise<number> {
  // Async only to satisfy the repo's `Cmd = (args) => Promise<number>` shape;
  // the checks themselves are synchronous, read-only, and outward-call-free.
  await Promise.resolve();

  const parsed = parseArgs(args);

  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`error: ${parsed.error}\n`);
    process.stderr.write('Run `ashlr verify-safety --help` for usage.\n');
    return 2;
  }

  const report = runSafetyChecks();

  if (parsed.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    renderReport(report);
  }

  return report.ok ? 0 : 1;
}
