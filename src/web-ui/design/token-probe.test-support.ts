/**
 * design/token-probe.test-support.ts — read tokens.css the way a browser
 * would, without a browser.
 *
 * jsdom does not implement custom-property resolution, var() fallbacks or
 * calc(), so `getComputedStyle(document.documentElement)` can never answer
 * "what color is --text-secondary in dark mode?" in a unit test. This probe
 * parses the stylesheet and resolves the subset of CSS the token file uses:
 * `var()` chains, nested `calc()` of like units, and `hsl()`/`rgb()`/hex
 * literals. That is enough to assert the palette's contrast in BOTH themes
 * (design doc §6) from a plain vitest run.
 *
 * It is test support, not runtime code: the color math it feeds lives in
 * ./contrast.ts, which the appearance panel also uses at runtime.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type TokenScope = Map<string, string>;

/** One parsed rule: its selector, the at-rule preludes wrapping it, and its declarations. */
interface Rule {
  selector: string;
  /** e.g. ['@media (prefers-color-scheme: dark)'] — empty at top level. */
  atRules: string[];
  decls: Array<[string, string]>;
}

/**
 * Vite rewrites `import.meta.url` to an http:// URL for modules it
 * transforms, so the file is located from the vitest working directory (the
 * repo root) instead.
 */
const TOKENS_CSS = resolve(process.cwd(), 'src/web-ui/design/tokens.css');

function declarationsOf(body: string, customPropsOnly = true): Array<[string, string]> {
  const decls: Array<[string, string]> = [];
  for (const raw of body.split(';')) {
    const idx = raw.indexOf(':');
    if (idx === -1) continue;
    const prop = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (customPropsOnly && !prop.startsWith('--')) continue;
    if (prop.length === 0 || value.length === 0) continue;
    decls.push([prop, value]);
  }
  return decls;
}

/**
 * Strip comments, then walk the braces keeping a stack of preludes, so a
 * rule nested in `@media (...)` knows which at-rule it lives under. (A
 * regex cannot: the innermost-block trick silently drops the wrapper, which
 * is exactly the distinction the two-dark-blocks drift check needs.)
 */
function parseRules(css: string, customPropsOnly = true): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const stack: string[] = [];
  let prelude = '';
  let body = '';
  for (const ch of src) {
    if (ch === '{') {
      stack.push(prelude.replace(/\s+/g, ' ').trim());
      prelude = '';
      body = '';
      continue;
    }
    if (ch === '}') {
      const selector = stack.pop();
      if (selector !== undefined && !selector.startsWith('@')) {
        const decls = declarationsOf(body, customPropsOnly);
        if (decls.length > 0) rules.push({ selector, atRules: [...stack], decls });
      }
      body = '';
      prelude = '';
      continue;
    }
    if (stack.length > 0) body += ch;
    prelude += ch;
  }
  return rules;
}

const isMediaDark = (rule: Rule): boolean => rule.atRules.some((at) => at.includes('prefers-color-scheme: dark'));
const isToggleDark = (rule: Rule): boolean => rule.atRules.length === 0 && rule.selector.includes('[data-theme="dark"]');

function rulesOf(css: string = readFileSync(TOKENS_CSS, 'utf8')): Rule[] {
  return parseRules(css);
}

/** Declarations on bare `:root` — the light palette every token must have. */
export function lightScope(css?: string): TokenScope {
  const scope: TokenScope = new Map();
  for (const rule of rulesOf(css)) {
    if (rule.selector !== ':root') continue;
    for (const [prop, value] of rule.decls) scope.set(prop, value);
  }
  return scope;
}

/** The light palette with the explicit `:root[data-theme="dark"]` block applied. */
export function darkScope(css?: string): TokenScope {
  const scope = lightScope(css);
  for (const [prop, value] of toggleDarkDecls(css)) scope.set(prop, value);
  return scope;
}

/**
 * The light palette with an arbitrary set of ROOT-LEVEL attribute blocks
 * applied — e.g. `scopeWith([':root[data-ui-scale="xlarge"]'])` for the
 * display-size layer, or that plus `:root[data-density="compact"]` to check
 * the two COMPOSE rather than collide.
 *
 * Blocks are applied in FILE order, which is what the cascade does for the
 * equal-specificity `:root[attr=...]` selectors this file is made of — so a
 * test that passes here is testing the order a browser would resolve. Blocks
 * inside an at-rule are skipped: ask for those explicitly if you ever need
 * them, rather than having a media query silently apply at every width.
 */
export function scopeWith(selectors: string[], css?: string): TokenScope {
  const scope = lightScope(css);
  for (const rule of rulesOf(css)) {
    if (rule.atRules.length > 0) continue;
    if (!selectors.includes(rule.selector)) continue;
    for (const [prop, value] of rule.decls) scope.set(prop, value);
  }
  return scope;
}

/** Declarations of ONE root-level block, for "what does this block change?". */
export function declsFor(selector: string, css?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rulesOf(css)) {
    if (rule.atRules.length > 0 || rule.selector !== selector) continue;
    for (const [prop, value] of rule.decls) out.set(prop, value);
  }
  return out;
}

/** The same, for a block nested in an at-rule matching `atRule`. */
export function declsForAt(atRule: string, selector: string, css?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rulesOf(css)) {
    if (rule.selector !== selector) continue;
    if (!rule.atRules.some((at) => at.includes(atRule))) continue;
    for (const [prop, value] of rule.decls) out.set(prop, value);
  }
  return out;
}

/** Declarations of the OS-preference dark block, for the drift check. */
export function mediaDarkDecls(css?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rulesOf(css)) {
    if (!isMediaDark(rule)) continue;
    for (const [prop, value] of rule.decls) out.set(prop, value);
  }
  return out;
}

/** Declarations of the explicit toggle block, for the drift check. */
export function toggleDarkDecls(css?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rulesOf(css)) {
    if (!isToggleDark(rule)) continue;
    for (const [prop, value] of rule.decls) out.set(prop, value);
  }
  return out;
}

/**
 * One declaration read straight out of a CSS MODULE, resolved through a theme
 * scope — e.g. `.charts { --chart-grid: ... }` in the Usage stylesheet, or
 * `.track { background: ... }`.
 *
 * tokens.css is not the whole palette an operator sees: a component may
 * override a token locally or paint a mark with a `color-mix`, and those
 * values are exactly where the contrast regressions hide (a gridline shipped
 * at 45% alpha under a comment claiming it cleared 3:1, because nothing could
 * measure the mix). `path` is relative to `src/web-ui`.
 *
 * Deliberately last-declaration-wins across the whole file and ignorant of
 * at-rules and specificity: a module that needs a media-query-specific value
 * guarded should be given a token in tokens.css instead.
 */
export function moduleDeclaration(path: string, selector: string, prop: string): string | null {
  const css = readFileSync(resolve(process.cwd(), 'src/web-ui', path), 'utf8');
  let found: string | null = null;
  for (const rule of parseRules(css, false)) {
    const selectors = rule.selector.split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const [name, value] of rule.decls) if (name === prop) found = value;
  }
  return found;
}

/**
 * The same, resolved to a literal color against a theme's token scope.
 * Returns null when the declaration is absent or references a token that does
 * not exist — both of which are findings, not "unknown".
 */
export function moduleColor(scope: TokenScope, path: string, selector: string, prop: string): string | null {
  const raw = moduleDeclaration(path, selector, prop);
  if (raw === null) return null;
  return resolveValue(scope, raw);
}

/** Every custom property declared anywhere in the file, with its selector. */
export function allDeclarations(css?: string): Array<{ selector: string; prop: string; value: string }> {
  const out: Array<{ selector: string; prop: string; value: string }> = [];
  for (const rule of rulesOf(css)) {
    const label = rule.atRules.length > 0 ? `${rule.atRules.join(' ')} { ${rule.selector}` : rule.selector;
    for (const [prop, value] of rule.decls) out.push({ selector: label, prop, value });
  }
  return out;
}

const NUMBER_UNIT_RE = /^(-?\d*\.?\d+)(%|px|em|rem|deg)?$/;

interface Term {
  n: number;
  unit: string;
}

/**
 * Evaluate the arithmetic tokens.css actually uses: `a + b` / `a - b` chains
 * of like units, and `a * b` / `a / b` where at most one side carries a unit.
 *
 * Multiplication matters because the DISPLAY-SIZE layer is a unitless
 * multiplier — every type, spacing and control token is
 * `calc(<base>px * var(--ui-scale))`. Without this the probe would hand
 * `14px * 1.125` back as an unresolved string and design/ui-scale.test.ts
 * could only make structural assertions, never "--control-h is 44px at
 * xlarge, which still fits the fixed 56px rail".
 *
 * Anything else is handed back untouched, exactly as before — this is a
 * probe for one stylesheet, not a CSS engine.
 */
function evalExpression(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!;

  const terms: Term[] = [];
  const ops: string[] = [];
  for (const part of parts) {
    if (part === '+' || part === '-' || part === '*' || part === '/') {
      ops.push(part);
      continue;
    }
    const m = NUMBER_UNIT_RE.exec(part);
    if (!m) return expr; // not arithmetic we understand — hand it back untouched
    terms.push({ n: Number.parseFloat(m[1]!), unit: m[2] ?? '' });
  }
  // A well-formed infix chain is value (op value)*. Anything else (a bare
  // `a b`, a trailing operator) is not arithmetic we should be guessing at.
  if (terms.length === 0 || terms.length !== ops.length + 1) return expr;

  // `*` and `/` bind tighter than `+`/`-`. CSS only permits a unitless
  // factor/divisor, so two united operands are a malformed expression.
  for (let i = 0; i < ops.length; ) {
    const op = ops[i]!;
    if (op !== '*' && op !== '/') {
      i += 1;
      continue;
    }
    const a = terms[i]!;
    const b = terms[i + 1]!;
    if (a.unit !== '' && b.unit !== '') return expr;
    const n = op === '*' ? a.n * b.n : b.n === 0 ? Number.NaN : a.n / b.n;
    if (!Number.isFinite(n)) return expr;
    terms.splice(i, 2, { n, unit: a.unit !== '' ? a.unit : b.unit });
    ops.splice(i, 1);
  }

  let acc = terms[0]!.n;
  let unit = terms[0]!.unit;
  for (let i = 0; i < ops.length; i += 1) {
    const b = terms[i + 1]!;
    if (b.unit !== '') unit = b.unit;
    acc = ops[i] === '+' ? acc + b.n : acc - b.n;
  }
  return `${Math.round(acc * 1000) / 1000}${unit}`;
}

function reduceCalc(value: string): string {
  let out = value;
  // Innermost calc() first, repeatedly, so nested calls collapse.
  for (let i = 0; i < 12 && out.includes('calc('); i += 1) {
    const next = out.replace(/calc\(([^()]*)\)/g, (_all, expr: string) => evalExpression(expr));
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Resolve a token to a literal CSS value: substitute var() chains, then
 * collapse calc(). Returns null if a referenced token does not exist in the
 * scope (which is itself a finding — see the "no token defined only in a
 * theme block" test).
 */
export function resolveToken(scope: TokenScope, token: string, depth = 0): string | null {
  if (depth > 16) return null;
  const raw = scope.get(token);
  if (raw === undefined) return null;
  return resolveValue(scope, raw, depth);
}

export function resolveValue(scope: TokenScope, value: string, depth = 0): string | null {
  if (depth > 16) return null;
  let out = value;
  for (let i = 0; i < 16 && out.includes('var('); i += 1) {
    let unresolved = false;
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_all, name: string, fallback?: string) => {
      const next = scope.get(name);
      if (next !== undefined) return next;
      if (fallback !== undefined) return fallback;
      unresolved = true;
      return '';
    });
    if (unresolved) return null;
  }
  return reduceCalc(out).trim();
}
