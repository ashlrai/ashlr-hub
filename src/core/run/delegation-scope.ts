import { isAbsolute, relative } from 'node:path';
import type {
  DelegationAllowedFiles,
  DelegationBackendSnapshot,
  DelegationContextBudget,
  DelegationMemoryMode,
  DelegationOrigin,
  DelegationResultContract,
  DelegationResultKind,
  DelegationScope,
  DelegationScopeSummary,
  RunBudget,
  WorkItem,
} from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

const MAX_TEXT = 240;
const MAX_PATH = 220;
const MAX_FILE_HINTS = 32;
const MAX_FILE_SAMPLES = 6;
const MAX_BUDGET_VALUE = 10_000_000;

const MEMORY_MODES: readonly DelegationMemoryMode[] = ['inherit', 'none', 'bounded', 'repo-only', 'full'];
const RESULT_KINDS: readonly DelegationResultKind[] = [
  'text',
  'diff',
  'proposal',
  'verified-proposal',
  'analysis-only',
  'diagnostic',
];

function boundedText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = scrubSecrets(value).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function boundedInteger(value: unknown, max = MAX_BUDGET_VALUE): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), max);
}

function boundedRatio(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, Math.round(value * 1_000) / 1_000));
}

function normalizeMemoryMode(value: unknown): DelegationMemoryMode {
  return typeof value === 'string' && MEMORY_MODES.includes(value as DelegationMemoryMode)
    ? value as DelegationMemoryMode
    : 'inherit';
}

function normalizeResultKind(value: unknown): DelegationResultKind | undefined {
  return typeof value === 'string' && RESULT_KINDS.includes(value as DelegationResultKind)
    ? value as DelegationResultKind
    : undefined;
}

function normalizeRepoRelativePath(value: unknown, sourceRepo?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = scrubSecrets(value).replace(/\0/g, '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!text) return undefined;

  if (sourceRepo && isAbsolute(text)) {
    const rel = relative(sourceRepo, text).replace(/\\/g, '/');
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return undefined;
    text = rel;
  }

  text = text.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
  if (!text || text === '.' || text === '..' || text.startsWith('../') || text.includes('/../')) {
    return undefined;
  }
  return text.length > MAX_PATH ? `${text.slice(0, MAX_PATH - 3)}...` : text;
}

function normalizePathList(values: unknown, sourceRepo?: string): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const path = normalizeRepoRelativePath(value, sourceRepo);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= MAX_FILE_HINTS) break;
  }
  return out.length > 0 ? out : undefined;
}

function normalizeAllowedFiles(
  input: DelegationAllowedFiles | undefined,
  sourceRepo?: string,
): DelegationAllowedFiles | undefined {
  if (!input) return undefined;
  const include = normalizePathList(input.include, sourceRepo);
  const exclude = normalizePathList(input.exclude, sourceRepo);
  const enforceWrites = typeof input.enforceWrites === 'boolean' ? input.enforceWrites : undefined;
  if (!include && !exclude && enforceWrites === undefined) return undefined;
  return {
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
    ...(enforceWrites !== undefined ? { enforceWrites } : {}),
  };
}

function normalizeBudget(input: Partial<RunBudget> | undefined): Partial<RunBudget> | undefined {
  if (!input) return undefined;
  const maxTokens = boundedInteger(input.maxTokens);
  const maxSteps = boundedInteger(input.maxSteps);
  const allowCloud = typeof input.allowCloud === 'boolean' ? input.allowCloud : undefined;
  if (maxTokens === undefined && maxSteps === undefined && allowCloud === undefined) return undefined;
  return {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(allowCloud !== undefined ? { allowCloud } : {}),
  };
}

function normalizeContextBudget(
  input: DelegationContextBudget | undefined,
): DelegationContextBudget | undefined {
  if (!input) return undefined;
  const maxPromptChars = boundedInteger(input.maxPromptChars);
  const repoMapTokens = boundedInteger(input.repoMapTokens);
  const localizationTokens = boundedInteger(input.localizationTokens);
  const memoryChars = boundedInteger(input.memoryChars);
  const resultChars = boundedInteger(input.resultChars);
  if (
    maxPromptChars === undefined &&
    repoMapTokens === undefined &&
    localizationTokens === undefined &&
    memoryChars === undefined &&
    resultChars === undefined
  ) {
    return undefined;
  }
  return {
    ...(maxPromptChars !== undefined ? { maxPromptChars } : {}),
    ...(repoMapTokens !== undefined ? { repoMapTokens } : {}),
    ...(localizationTokens !== undefined ? { localizationTokens } : {}),
    ...(memoryChars !== undefined ? { memoryChars } : {}),
    ...(resultChars !== undefined ? { resultChars } : {}),
  };
}

function normalizeResultContract(
  input: DelegationResultContract | undefined,
): DelegationResultContract | undefined {
  if (!input) return undefined;
  const kind = normalizeResultKind(input.kind);
  if (!kind) return undefined;
  const maxChangedFiles = boundedInteger(input.maxChangedFiles);
  const maxChangedLines = boundedInteger(input.maxChangedLines);
  return {
    kind,
    ...(typeof input.requireDiff === 'boolean' ? { requireDiff: input.requireDiff } : {}),
    ...(typeof input.requireProposal === 'boolean' ? { requireProposal: input.requireProposal } : {}),
    ...(typeof input.requireVerification === 'boolean' ? { requireVerification: input.requireVerification } : {}),
    ...(maxChangedFiles !== undefined ? { maxChangedFiles } : {}),
    ...(maxChangedLines !== undefined ? { maxChangedLines } : {}),
  };
}

function normalizeBackend(input: DelegationBackendSnapshot | undefined): DelegationBackendSnapshot | undefined {
  if (!input) return undefined;
  const engine = boundedText(input.engine, 80) as DelegationBackendSnapshot['engine'] | undefined;
  const model = input.model === null ? null : boundedText(input.model, 160);
  const tier = input.tier === null ? null : boundedText(input.tier, 40);
  const assignedBy = boundedText(input.assignedBy, 80);
  const reason = boundedText(input.reason, 160);
  if (engine === undefined && model === undefined && tier === undefined && !assignedBy && !reason) {
    return undefined;
  }
  return {
    ...(engine !== undefined ? { engine } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(assignedBy ? { assignedBy } : {}),
    ...(reason ? { reason } : {}),
  };
}

function mergeScope(parent: Partial<DelegationScope>, patch: Partial<DelegationScope>): DelegationScope {
  return {
    ...parent,
    ...patch,
    allowedFiles: {
      ...(parent.allowedFiles ?? {}),
      ...(patch.allowedFiles ?? {}),
    },
    budget: {
      ...(parent.budget ?? {}),
      ...(patch.budget ?? {}),
    },
    contextBudget: {
      ...(parent.contextBudget ?? {}),
      ...(patch.contextBudget ?? {}),
    },
    resultContract: {
      ...(parent.resultContract ?? {}),
      ...(patch.resultContract ?? {}),
    } as DelegationResultContract,
    backend: {
      ...(parent.backend ?? {}),
      ...(patch.backend ?? {}),
    },
  };
}

export function normalizeDelegationScope(
  input: Partial<DelegationScope> | undefined,
  defaults: Partial<DelegationScope> = {},
): DelegationScope | undefined {
  if (!input && Object.keys(defaults).length === 0) return undefined;
  const merged = mergeScope(defaults, input ?? {});
  const sourceRepo = boundedText(merged.sourceRepo, MAX_PATH);
  const executionRoot = boundedText(merged.executionRoot, MAX_PATH);
  const allowedFiles = normalizeAllowedFiles(merged.allowedFiles, sourceRepo);
  const resultContract = normalizeResultContract(merged.resultContract);

  return {
    schemaVersion: 1,
    ...(boundedText(merged.origin, 80) ? { origin: boundedText(merged.origin, 80) as DelegationOrigin } : {}),
    ...(sourceRepo ? { sourceRepo } : {}),
    ...(executionRoot ? { executionRoot } : {}),
    ...(boundedText(merged.workItemId, 160) ? { workItemId: boundedText(merged.workItemId, 160) } : {}),
    ...(boundedText(merged.workSource, 80) ? { workSource: boundedText(merged.workSource, 80) as DelegationScope['workSource'] } : {}),
    ...(boundedText(merged.runId, 160) ? { runId: boundedText(merged.runId, 160) } : {}),
    ...(boundedText(merged.swarmId, 160) ? { swarmId: boundedText(merged.swarmId, 160) } : {}),
    ...(boundedText(merged.taskId, 160) ? { taskId: boundedText(merged.taskId, 160) } : {}),
    ...(boundedText(merged.objective) ? { objective: boundedText(merged.objective) } : {}),
    ...(allowedFiles ? { allowedFiles } : {}),
    ...(normalizeBudget(merged.budget) ? { budget: normalizeBudget(merged.budget) } : {}),
    ...(normalizeContextBudget(merged.contextBudget) ? { contextBudget: normalizeContextBudget(merged.contextBudget) } : {}),
    memoryMode: normalizeMemoryMode(merged.memoryMode),
    ...(resultContract ? { resultContract } : {}),
    ...(normalizeBackend(merged.backend) ? { backend: normalizeBackend(merged.backend) } : {}),
  };
}

export function summarizeDelegationScope(
  input: Partial<DelegationScope> | undefined,
): DelegationScopeSummary | undefined {
  const scope = normalizeDelegationScope(input);
  if (!scope) return undefined;
  const include = scope.allowedFiles?.include ?? [];
  const exclude = scope.allowedFiles?.exclude ?? [];
  const enforceWrites = scope.allowedFiles?.enforceWrites;
  const allowedFiles =
    include.length > 0 || exclude.length > 0 || enforceWrites !== undefined
      ? {
          includeCount: include.length,
          excludeCount: exclude.length,
          ...(include.length > 0 ? { includeSamples: include.slice(0, MAX_FILE_SAMPLES) } : {}),
          ...(exclude.length > 0 ? { excludeSamples: exclude.slice(0, MAX_FILE_SAMPLES) } : {}),
          ...(enforceWrites !== undefined ? { enforceWrites } : {}),
        }
      : undefined;
  return {
    schemaVersion: 1,
    ...(scope.origin ? { origin: scope.origin } : {}),
    ...(scope.sourceRepo ? { sourceRepo: scope.sourceRepo } : {}),
    ...(scope.executionRoot ? { executionRoot: scope.executionRoot } : {}),
    ...(scope.workItemId ? { workItemId: scope.workItemId } : {}),
    ...(scope.workSource ? { workSource: scope.workSource } : {}),
    ...(scope.runId ? { runId: scope.runId } : {}),
    ...(scope.swarmId ? { swarmId: scope.swarmId } : {}),
    ...(scope.taskId ? { taskId: scope.taskId } : {}),
    ...(scope.objective ? { objective: scope.objective } : {}),
    ...(allowedFiles ? { allowedFiles } : {}),
    ...(scope.budget ? { budget: scope.budget } : {}),
    ...(scope.contextBudget ? { contextBudget: scope.contextBudget } : {}),
    memoryMode: scope.memoryMode ?? 'inherit',
    ...(scope.resultContract ? { resultContract: scope.resultContract } : {}),
    ...(scope.backend ? { backend: scope.backend } : {}),
  };
}

export function mergeDelegationScope(
  parent: Partial<DelegationScope> | undefined,
  patch: Partial<DelegationScope> | undefined,
): DelegationScope | undefined {
  return normalizeDelegationScope(patch, parent ?? {});
}

export function scopeHintFiles(scope: Partial<DelegationScope> | undefined): string[] | undefined {
  const normalized = normalizeDelegationScope(scope);
  const include = normalized?.allowedFiles?.include;
  return include && include.length > 0 ? include.slice(0, MAX_FILE_HINTS) : undefined;
}

export function renderDelegationScopeForPrompt(scope: Partial<DelegationScope> | undefined): string {
  const normalized = normalizeDelegationScope(scope);
  if (!normalized) return '';
  const lines = [
    'Delegation scope:',
    `- Memory mode: ${normalized.memoryMode ?? 'inherit'}`,
  ];
  if (normalized.origin) lines.push(`- Origin: ${normalized.origin}`);
  if (normalized.resultContract) {
    const contract = normalized.resultContract;
    const flags = [
      contract.requireDiff ? 'require diff' : undefined,
      contract.requireProposal ? 'require proposal' : undefined,
      contract.requireVerification ? 'require verification' : undefined,
      contract.maxChangedFiles !== undefined ? `max ${contract.maxChangedFiles} files` : undefined,
      contract.maxChangedLines !== undefined ? `max ${contract.maxChangedLines} lines` : undefined,
    ].filter(Boolean);
    lines.push(`- Result contract: ${contract.kind}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`);
  }
  if (normalized.contextBudget?.maxPromptChars !== undefined) {
    lines.push(`- Prompt char budget: ${normalized.contextBudget.maxPromptChars}`);
  }
  if (normalized.allowedFiles?.include && normalized.allowedFiles.include.length > 0) {
    lines.push(`- Focus files: ${normalized.allowedFiles.include.join(', ')}`);
  }
  if (normalized.allowedFiles?.exclude && normalized.allowedFiles.exclude.length > 0) {
    lines.push(`- Avoid files: ${normalized.allowedFiles.exclude.join(', ')}`);
  }
  if (normalized.allowedFiles?.enforceWrites !== undefined) {
    lines.push(`- Write scope enforcement requested: ${normalized.allowedFiles.enforceWrites ? 'yes' : 'no'}`);
  }
  if (normalized.backend?.engine || normalized.backend?.model) {
    lines.push(`- Backend: ${[normalized.backend.engine, normalized.backend.model].filter(Boolean).join(' ')}`);
  }
  return `${lines.join('\n')}\n\n`;
}

export function scopeFromWorkItem(
  item: WorkItem,
  patch: Partial<DelegationScope> = {},
): DelegationScope | undefined {
  return normalizeDelegationScope(patch, {
    origin: 'daemon',
    sourceRepo: item.repo,
    workItemId: item.id,
    workSource: item.source,
    objective: item.title,
    resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
  });
}

export function clampContextRatio(value: unknown): number | undefined {
  return boundedRatio(value);
}
