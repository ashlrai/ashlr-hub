import type { WorkItem } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SELF_HEAL_ITEM_MAX_AGE_MS = 14 * DAY_MS;

const NOISE_PATTERNS: RegExp[] = [
  /^\s*>\s*[\w@./-]+.*\s(?:check|test|build|lint|typecheck)\s*$/im,
  /^\s*(Downloaded|Downloading|Compiling|Finished)\s+[\w.-]+/im,
  /^\s*TAP version\b/im,
  /^\s*\d+\.\.\d+\s*$/im,
  /^\s*ok\s+\d+\b/im,
  /\brustup could not choose a version of cargo\b/i,
  /\bno default is configured\b/i,
  /\bCannot find module\b.*\bnode_modules\b.*\b(?:tsc|typescript|eslint|vitest|vite|bun)\b/i,
  /\b(?:ENOENT|command not found|failed to start|not recognized as an internal|not recognized as a command)\b/i,
  /\b(?:SIGTERM|SIGKILL|terminated|killed|polite quit)\b/i,
];

const STRONG_CODE_PATTERNS: RegExp[] = [
  /\b(?:error\s+TS\d{4}|TS\d{4}:)\b/i,
  /\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|rs|go|py|rb|java|kt|swift|c|cc|cpp|h|hpp|m|mm):\d+(?::\d+)?\b.*\b(?:error|fail|panic|expected)\b/i,
  /\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|rs|go|py|rb|java|kt|swift|c|cc|cpp|h|hpp|m|mm)\(\d+,\d+\):\s*error\b/i,
  /^(?:FAIL|ERROR|\(fail\)|not ok\b|[✗×])\b/im,
  /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|panic(?:ked)?|thread '.+' panicked)\b/i,
  /\b(?:expected|received|not assignable|does not exist on type|no overload matches|mismatched types|borrowed value)\b/i,
  /\b(?:TypeScript error|test failure|old test failure|old TypeScript error)\b/i,
];

function textFromItem(item: WorkItem): string {
  return `${item.title}\n${item.detail}`;
}

function ageOk(ts: string, nowMs: number, maxAgeMs: number): boolean {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return false;
  return parsed <= nowMs && nowMs - parsed <= maxAgeMs;
}

function isTrustedDiagnosticResliceItem(item: WorkItem): boolean {
  if (!/^[^:]+:proposal-repair-nodiff:[0-9a-f]{12}$/i.test(item.id)) return false;
  if (!item.tags.includes('proposal-repair')) return false;
  if (!item.tags.includes('diagnostic-reslice')) return false;
  if (!item.tags.includes('dispatch-no-diff-reslice')) return false;
  const text = textFromItem(item);
  return /\bDiagnostic reslice:/i.test(text) &&
    /\bOriginal work item:/i.test(text) &&
    /\bDispatch outcome:\s*empty-diff\b/i.test(text) &&
    /\bAction:\s*reslice\b/i.test(text);
}

export function isActionableSelfHealFailureText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (NOISE_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
  return STRONG_CODE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isActionableSelfHealItem(
  item: WorkItem,
  opts?: {
    nowMs?: number;
    maxAgeMs?: number;
  },
): boolean {
  if (!item.tags.includes('self-heal')) return false;
  const nowMs = opts?.nowMs ?? Date.now();
  const maxAgeMs = opts?.maxAgeMs ?? SELF_HEAL_ITEM_MAX_AGE_MS;
  if (!ageOk(item.ts, nowMs, maxAgeMs)) return false;
  if (isTrustedDiagnosticResliceItem(item)) return true;
  return isActionableSelfHealFailureText(textFromItem(item));
}
