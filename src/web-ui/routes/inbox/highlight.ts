/**
 * routes/inbox/highlight.ts — minimal, dependency-free syntax highlighting
 * for the diff viewer. Per the operator-console brief: "do NOT pull in a
 * heavy dependency without checking what's already available — hand-rolled
 * highlighting for common languages is acceptable and preferable to a large
 * runtime dep." This is a single-pass tokenizer per *line* (the diff viewer
 * already renders line-by-line) — cross-line state like multi-line block
 * comments is intentionally not tracked, so an occasional line inside a
 * block comment may be mis-colored. That's a fine trade for zero
 * dependencies and O(n) rendering with no dependency on the file's context
 * outside the visible hunk.
 */

export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword';

export interface Token {
  kind: TokenKind;
  text: string;
}

export type LangFamily = 'c-like' | 'python' | 'shell' | 'css' | 'json' | 'yaml' | 'plain';

const EXT_TO_FAMILY: Record<string, LangFamily> = {
  ts: 'c-like', tsx: 'c-like', js: 'c-like', jsx: 'c-like', mjs: 'c-like', cjs: 'c-like', mts: 'c-like', cts: 'c-like',
  java: 'c-like', go: 'c-like', rs: 'c-like', c: 'c-like', h: 'c-like', cpp: 'c-like', hpp: 'c-like', cc: 'c-like',
  swift: 'c-like', kt: 'c-like', kts: 'c-like',
  py: 'python', pyi: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml',
};

export function languageForPath(path: string | null | undefined): LangFamily {
  if (!path) return 'plain';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_FAMILY[ext] ?? 'plain';
}

const KEYWORDS: Record<LangFamily, Set<string>> = {
  'c-like': new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
    'break', 'continue', 'class', 'extends', 'implements', 'interface', 'type', 'enum', 'export', 'import',
    'from', 'default', 'new', 'this', 'super', 'try', 'catch', 'finally', 'throw', 'async', 'await',
    'yield', 'static', 'public', 'private', 'protected', 'readonly', 'abstract', 'null', 'undefined',
    'true', 'false', 'void', 'typeof', 'instanceof', 'in', 'of', 'as', 'is', 'never', 'unknown', 'any',
    'package', 'struct', 'fn', 'impl', 'mod', 'pub', 'use', 'trait', 'match', 'func', 'defer', 'chan',
  ]),
  python: new Set([
    'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'import', 'from',
    'as', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'lambda', 'yield', 'async', 'await', 'None',
    'True', 'False', 'and', 'or', 'not', 'in', 'is', 'global', 'nonlocal', 'self',
  ]),
  shell: new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return',
    'export', 'local', 'echo', 'set', 'in', 'break', 'continue',
  ]),
  css: new Set(),
  json: new Set(),
  yaml: new Set(),
  plain: new Set(),
};

// One combined rule regex per family, using named groups so a single
// generic scan loop works for every family regardless of which groups it
// defines. First match wins scanning left-to-right; the gaps between
// matches become plain-text tokens verbatim.
const RULES: Partial<Record<LangFamily, RegExp>> = {
  'c-like':
    /(?<comment>\/\/.*$|\/\*.*?\*\/)|(?<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(?<number>\b\d+(?:\.\d+)?\b)|(?<word>[A-Za-z_$][A-Za-z0-9_$]*)/g,
  python:
    /(?<comment>#.*$)|(?<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<number>\b\d+(?:\.\d+)?\b)|(?<word>[A-Za-z_][A-Za-z0-9_]*)/g,
  shell: /(?<comment>#.*$)|(?<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<word>[A-Za-z_][A-Za-z0-9_]*)/g,
  css: /(?<comment>\/\*.*?\*\/)|(?<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<number>\b\d+(?:\.\d+)?\b)|(?<word>[A-Za-z_-][A-Za-z0-9_-]*)/g,
  json: /(?<string>"(?:[^"\\]|\\.)*")|(?<number>-?\b\d+(?:\.\d+)?\b)|(?<word>\btrue\b|\bfalse\b|\bnull\b)/g,
  yaml: /(?<comment>#.*$)|(?<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
};

export function tokenizeLine(text: string, family: LangFamily): Token[] {
  const rule = RULES[family];
  if (!rule) return [{ kind: 'plain', text }];
  const keywords = KEYWORDS[family];
  const tokens: Token[] = [];
  let last = 0;
  rule.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = rule.exec(text))) {
    if (match.index > last) tokens.push({ kind: 'plain', text: text.slice(last, match.index) });
    const g = match.groups ?? {};
    if (g.comment !== undefined) {
      tokens.push({ kind: 'comment', text: match[0] });
    } else if (g.string !== undefined) {
      tokens.push({ kind: 'string', text: match[0] });
    } else if (g.number !== undefined) {
      tokens.push({ kind: 'number', text: match[0] });
    } else if (g.word !== undefined) {
      const isKeyword = family === 'json' || keywords.has(g.word);
      tokens.push({ kind: isKeyword ? 'keyword' : 'plain', text: match[0] });
    } else {
      tokens.push({ kind: 'plain', text: match[0] });
    }
    last = match.index + match[0].length;
    if (match[0].length === 0) rule.lastIndex++; // guard against zero-width matches
  }
  if (last < text.length) tokens.push({ kind: 'plain', text: text.slice(last) });
  return tokens;
}
