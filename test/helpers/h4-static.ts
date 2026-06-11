/**
 * test/helpers/h4-static.ts — H4 STATIC grep-guard helpers (test-only).
 *
 * Several HARD safety guarantees are negative-space invariants best asserted by
 * reading the REAL source file as TEXT and asserting a token is absent/present —
 * e.g. "daemon/loop.ts imports NO apply/push/createPr/deploy primitive" or
 * "reflect.ts makes no network call". These helpers resolve the real `src/`
 * file from the test process and expose its raw text, its import specifiers, and
 * a comment-stripped view so a call-token scan never trips on a mention in a
 * comment.
 *
 * PURE + TEST-ONLY: no production code, no runtime deps, no outward capability.
 * Reads are synchronous filesystem reads of the repo's own committed source.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Absolute path to the repo's `src/` directory, derived from THIS helper's
 * location (`test/helpers/h4-static.ts` → repo root → `src`). Stable regardless
 * of the cwd a test runner is launched from.
 */
export function srcDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // test/helpers
  const repoRoot = resolve(here, '..', '..'); // repo root
  return join(repoRoot, 'src');
}

/**
 * Read a source file under `src/` as raw UTF-8 text.
 * @param relFromSrc path RELATIVE to `src/`, e.g. `core/daemon/loop.ts`.
 */
export function readSource(relFromSrc: string): string {
  return readFileSync(join(srcDir(), relFromSrc), 'utf8');
}

/**
 * Extract the set of module specifiers imported by `src`. Matches both
 * `import ... from '<spec>'` and bare/side-effect `import '<spec>'` and dynamic
 * `import('<spec>')` forms. Returns the raw specifier strings (e.g.
 * `../inbox/store.js`). Use to assert a forbidden module is NOT imported.
 */
export function importLines(src: string): string[] {
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

/**
 * Strip `//` line comments and block comments from `src` so a call-token scan
 * (e.g. for `createPr(`) does not false-positive on a passing mention inside a
 * comment. Conservative: it does not parse strings, so a token that appears only
 * inside a string literal would still match — acceptable for the H4 guards,
 * which scan for CALL tokens that would never legitimately live in a string.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid `://` in URLs)
}

/**
 * True iff `src` (after comment-stripping) contains the given call/usage token.
 * `token` is matched literally. Use to assert ABSENCE of a forbidden primitive
 * (e.g. `expect(containsToken(src, 'createPr(')).toBe(false)`).
 */
export function containsToken(src: string, token: string): boolean {
  return stripComments(src).includes(token);
}
