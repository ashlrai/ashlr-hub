export type TrivialDiffCategory =
  | 'docs'
  | 'comments'
  | 'whitespace'
  | 'formatting'
  | 'code';

export interface DiffTrivialityClassification {
  changedLines: number;
  categories: TrivialDiffCategory[];
}

type ChangeKind = 'added' | 'removed';

interface ChangeLine {
  kind: ChangeKind;
  text: string;
}

const TRIVIAL_CATEGORIES = new Set<TrivialDiffCategory>([
  'docs',
  'comments',
  'whitespace',
  'formatting',
]);

export function classifyDiff(diff: string): DiffTrivialityClassification {
  const categories: TrivialDiffCategory[] = [];
  let changedLines = 0;
  let currentPath = '';
  let oldPath = '';
  let inHunk = false;
  let segment: ChangeLine[] = [];

  function addCategory(category: TrivialDiffCategory): void {
    if (!categories.includes(category)) categories.push(category);
  }

  function flushSegment(): void {
    if (segment.length === 0) return;
    changedLines += segment.length;
    classifySegment(currentPath, segment, addCategory);
    segment = [];
  }

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flushSegment();
      currentPath = parseDiffGitPath(raw);
      oldPath = currentPath;
      inHunk = false;
      continue;
    }

    if (!inHunk && raw.startsWith('--- ')) {
      oldPath = cleanDiffPath(raw.slice(4));
      continue;
    }

    if (!inHunk && raw.startsWith('+++ ')) {
      const newPath = cleanDiffPath(raw.slice(4));
      currentPath = newPath || oldPath;
      continue;
    }

    if (raw.startsWith('@@')) {
      flushSegment();
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      segment.push({ kind: 'added', text: raw.slice(1) });
      continue;
    }

    if (raw.startsWith('-') && !raw.startsWith('---')) {
      segment.push({ kind: 'removed', text: raw.slice(1) });
      continue;
    }

    flushSegment();
  }

  flushSegment();

  return { changedLines, categories };
}

export function isTrivialProposal(diff: string, threshold = 15): boolean {
  if (threshold <= 0) return false;
  const classification = classifyDiff(diff);
  return (
    classification.changedLines > 0 &&
    classification.changedLines < threshold &&
    classification.categories.length > 0 &&
    classification.categories.every((category) => TRIVIAL_CATEGORIES.has(category))
  );
}

function classifySegment(
  filePath: string,
  segment: readonly ChangeLine[],
  addCategory: (category: TrivialDiffCategory) => void,
): void {
  if (isDocsPath(filePath)) {
    addCategory('docs');
    return;
  }

  const lines = segment.map((line) => line.text);
  if (lines.every(isWhitespaceOnly)) {
    addCategory('whitespace');
    return;
  }

  const substantive = lines.filter((line) => !isWhitespaceOnly(line));
  if (substantive.length > 0 && substantive.every(isCommentOnlyLine)) {
    addCategory('comments');
    return;
  }

  if (!isWhitespaceSensitivePath(filePath) && isFormattingOnlySegment(segment)) {
    addCategory('formatting');
    return;
  }

  for (const line of lines) {
    if (isWhitespaceOnly(line)) addCategory('whitespace');
    else if (isCommentOnlyLine(line)) addCategory('comments');
    else addCategory('code');
  }
}

function isFormattingOnlySegment(segment: readonly ChangeLine[]): boolean {
  const removed = segment
    .filter((line) => line.kind === 'removed' && !isWhitespaceOnly(line.text))
    .map((line) => line.text);
  const added = segment
    .filter((line) => line.kind === 'added' && !isWhitespaceOnly(line.text))
    .map((line) => line.text);

  if (removed.length === 0 || added.length === 0) return false;
  if (removed.length !== added.length) return false;
  return removed.every((line, index) => line.trim() === added[index]?.trim());
}

function isDocsPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (!/\.(?:md|txt)$/.test(normalized)) return false;
  if (/(?:^|\/)(?:src|test|tests|fixtures|__fixtures__|snapshots|__snapshots__|prompts)(?:\/|$)/.test(normalized)) {
    return false;
  }
  const base = normalized.split('/').pop() ?? normalized;
  return (
    normalized.startsWith('docs/') ||
    !normalized.includes('/') ||
    /^(?:readme|changelog|license|contributing|security|code_of_conduct|architecture|roadmap|notes)(?:\..+)?\.(?:md|txt)$/.test(base)
  );
}

function isWhitespaceSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? normalized;
  return (
    /\.(?:py|pyi|ya?ml|sh|bash|zsh|fish|ps1|mk)$/i.test(base) ||
    /^(?:makefile|gnumakefile|dockerfile)$/i.test(base)
  );
}

function isWhitespaceOnly(line: string): boolean {
  return line.trim().length === 0;
}

function isCommentOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isSemanticCommentDirective(trimmed)) return false;
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*/') ||
    trimmed.startsWith('<!--') ||
    trimmed.startsWith('-->') ||
    /^#(?:\s|$)/.test(trimmed) ||
    /^--(?:\s|$)/.test(trimmed) ||
    /^;(?:\s|$)/.test(trimmed) ||
    /^"""|^'''/.test(trimmed)
  );
}

function isSemanticCommentDirective(trimmed: string): boolean {
  const body = trimmed
    .replace(/^\/\//, '')
    .replace(/^\/\*/, '')
    .replace(/^\*/, '')
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .replace(/^#/, '')
    .replace(/^--/, '')
    .replace(/^;/, '')
    .trim()
    .toLowerCase();

  return (
    body.startsWith('@ts-') ||
    body.startsWith('ts-') ||
    body.startsWith('go:build') ||
    body.startsWith('+build') ||
    body.startsWith('go:generate') ||
    body.startsWith('eslint-') ||
    body.startsWith('biome-') ||
    body.startsWith('oxlint-') ||
    body.startsWith('deno-lint-') ||
    body.startsWith('prettier-ignore') ||
    body.startsWith('type: ignore') ||
    body.startsWith('pyright:') ||
    body.startsWith('mypy:') ||
    body.startsWith('pylint:') ||
    body.startsWith('ruff:') ||
    body.startsWith('noqa') ||
    body.startsWith('shellcheck') ||
    body.startsWith('frozen_string_literal:') ||
    body.startsWith('encoding:') ||
    body.startsWith('coding:') ||
    body.startsWith('fmt:') ||
    body.startsWith('istanbul ignore') ||
    body.startsWith('c8 ignore') ||
    body.startsWith('v8 ignore') ||
    body.startsWith('@jsx') ||
    body.startsWith('@flow') ||
    body.startsWith('@format') ||
    body.startsWith('@generated') ||
    body.includes('@__pure__') ||
    body.includes('#__pure__') ||
    body.startsWith('[if ')
  );
}

function parseDiffGitPath(line: string): string {
  const match = line.match(/^diff --git\s+(?:"?a\/(.+?)"?|\S+)\s+(?:"?b\/(.+?)"?|\S+)$/);
  return cleanDiffPath(match?.[2] ?? match?.[1] ?? '');
}

function cleanDiffPath(raw: string): string {
  const trimmed = raw.trim().replace(/^"|"$/g, '');
  if (!trimmed || trimmed === '/dev/null') return '';
  return trimmed.replace(/^[ab]\//, '');
}
