import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactDigest, canonical, digest } from '../src/core/universe/artifacts.js';
import { buildUniverseFeedback as buildAnchoredFeedback, feedbackReceipt, validateDiagnostics, validateUniverseFeedback } from '../src/core/universe/feedback.js';
import { newGenerationReceipt, validGenerationReceipt } from '../src/core/universe/generation.js';
import { generateModelCandidate } from '../src/core/universe/model-candidate.js';
import type { UniverseFeedback, UniverseSummary, UniverseVariant } from '../src/core/universe/types.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { summary: UniverseSummary; variant: UniverseVariant; artifact: string; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'universe-feedback-')));
  roots.push(root);
  const artifact = join(root, 'universes', 'test-feedback', 'artifacts', 'run-1', 'trial-1');
  mkdirSync(artifact, { recursive: true, mode: 0o700 });
  writeFileSync(join(artifact, 'value.mjs'), 'export const value = 1;');
  writeFileSync(join(artifact, 'evaluate.mjs'), 'PRIVATE EVALUATOR SOURCE');
  const variant: UniverseVariant = { id: 'repair', niche: 'correctness', hypothesis: 'Correct an observed error',
    generation: { kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'fixture', files: ['value.mjs'], maxOutputTokens: 256 } };
  const summary: UniverseSummary = { manifest: { schemaVersion: 1, id: 'test-feedback', name: 'Test feedback', objective: 'Correct value',
    seed: { repo: root, revision: 'a'.repeat(40) }, metric: { name: 'checks', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 10_000, trialTimeoutMs: 5_000, maxParallel: 1 },
    evaluation: { command: ['node', 'evaluate.mjs'], timeoutMs: 1_000 }, variants: [variant] },
  manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64), sourceState: 'healthy', reasons: [], activeRun: null, elites: [],
  runs: [{ id: 'run-1', universeId: 'test-feedback', generation: 1, manifestDigest: 'b'.repeat(64), comparatorDigest: 'c'.repeat(64),
    startedAt: '2026-09-06T00:00:00.000Z', finishedAt: '2026-09-06T00:00:01.000Z', status: 'completed',
    durationMs: 1_000, tokensUsed: null, costUsd: null,
    trials: [{ id: 'trial-1', variantId: 'repair', niche: 'correctness', parentTrialId: null, status: 'failed', score: 2,
      metrics: { checks: 3 }, artifact: { path: artifact, digest: artifactDigest(artifact), revision: 'a'.repeat(40) },
      durationMs: 900, delta: null, selected: false, error: 'PRIVATE RAW STDERR',
      diagnostics: [{ code: 'wrong-value', message: 'Expected a value of two.', path: 'value.mjs', line: 1 }] }] }] };
  return { summary, variant, artifact, root };
}

function buildUniverseFeedback(summary: UniverseSummary, variant: UniverseVariant): UniverseFeedback | undefined {
  // This fixture deliberately places its private storage beside its fake seed.
  return buildAnchoredFeedback(summary, variant, join(summary.manifest.seed.repo, 'universes', summary.manifest.id));
}

describe('bounded Universe evaluator diagnostics', () => {
  it('copies valid diagnostics and preserves optional absence', () => {
    const input = [{ code: 'invalid-calendar-day', message: 'Reject date rollover.' }];
    const output = validateDiagnostics(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(validateDiagnostics([])).toEqual([]);
  });

  it.each([
    null, {}, Array.from({ length: 17 }, () => ({ code: 'x', message: 'x' })),
    [{ code: 'x', message: 'x', extra: true }], [{ code: 'x y', message: 'x' }], [{ code: 'x'.repeat(65), message: 'x' }],
    [{ code: 'x', message: 'x'.repeat(513) }], [{ code: 'x', message: '   ' }], [{ code: 'x', message: 'raw\nlog' }],
    [{ code: 'x', message: '\u0085' }], [{ code: 'x', message: '\ud800' }], [{ code: 'x', message: 'x', path: '../secret' }],
    [{ code: 'x', message: 'x', path: 'hidden\u0085path' }], [{ code: 'x', message: 'x', path: '\ud800' }],
    [{ code: 'x', message: 'x', path: '/secret' }], [{ code: 'x', message: 'x', line: 0 }],
    [{ code: 'x', message: 'x', line: 1.5 }], [{ code: 'x', message: 'x', line: Number.MAX_SAFE_INTEGER + 1 }],
    Array.from({ length: 16 }, () => ({ code: 'x', message: 'x'.repeat(512) })),
  ])('rejects malformed or excessive diagnostics: %j', (input) => {
    expect(() => validateDiagnostics(input)).toThrow(/Invalid Universe diagnostics/);
  });
});

describe('verified previous-outcome feedback', () => {
  it('provides the previous rejected source separately from accepted-parent lineage', () => {
    const { summary, variant } = fixture();
    const feedback = buildUniverseFeedback(summary, variant)!;
    expect(feedback).toMatchObject({ source: { runId: 'run-1', trialId: 'trial-1', generation: 1,
      comparatorDigest: summary.comparatorDigest }, status: 'failed', score: 2,
    diagnostics: [{ code: 'wrong-value', message: 'Expected a value of two.' }],
    previousAttemptFiles: [{ path: 'value.mjs', content: 'export const value = 1;', contentDigest: digest('export const value = 1;') }] });
    expect(JSON.stringify(feedback)).not.toContain('PRIVATE');
    expect(feedback).not.toHaveProperty('parentTrialId');
    expect(summary.elites).toEqual([]);
    expect(summary.runs[0]!.trials[0]!.selected).toBe(false);
    expect(feedbackReceipt(feedback)).toEqual({ ...feedback.source, digest: digest(canonical(feedback)) });
  });

  it('selects the latest completed matching variant rather than an interrupted or unrelated attempt', () => {
    const { summary, variant } = fixture();
    const first = summary.runs[0]!;
    summary.runs.push({ ...first, id: 'run-2', generation: 2, trials: [{ ...first.trials[0]!, variantId: 'another' }] },
      { ...first, id: 'run-3', generation: 3, status: 'interrupted' },
      { ...first, id: 'run-4', generation: 4, status: 'running', finishedAt: null });
    expect(buildUniverseFeedback(summary, variant)?.source.runId).toBe('run-1');
    summary.runs.push({ ...first, id: 'run-5', generation: 5,
      trials: [{ ...first.trials[0]!, artifact: null, status: 'timed-out', score: null, diagnostics: [] }] });
    expect(buildUniverseFeedback(summary, variant)).toMatchObject({ source: { runId: 'run-5', generation: 5, artifactDigest: null },
      status: 'timed-out', score: null, previousAttemptFiles: [] });
  });

  it('returns no feedback for first-generation or command variants', () => {
    const { summary, variant } = fixture();
    summary.runs = [];
    expect(buildUniverseFeedback(summary, variant)).toBeUndefined();
    expect(buildUniverseFeedback(summary, { id: 'command', niche: 'correctness', hypothesis: 'Try', command: ['true'] })).toBeUndefined();
  });

  it('binds artifact reads to the configured Universe directory, not a path-derived root', () => {
    const { summary, variant, root } = fixture();
    expect(() => buildAnchoredFeedback(summary, variant, join(root, 'different', 'universes', summary.manifest.id)))
      .toThrow(/exact archive slot/);
  });

  it.each(['degraded', 'comparator', 'manifest', 'variant', 'niche', 'slot', 'revision', 'content'] as const)(
    'refuses %s history instead of silently forwarding it', (change) => {
      const { summary, variant, artifact } = fixture();
      if (change === 'degraded') summary.sourceState = 'degraded';
      if (change === 'comparator') summary.runs[0]!.comparatorDigest = 'd'.repeat(64);
      if (change === 'manifest') summary.runs[0]!.manifestDigest = 'd'.repeat(64);
      if (change === 'variant') summary.manifest.variants = [{ ...variant, hypothesis: 'different' }];
      if (change === 'niche') summary.runs[0]!.trials[0]!.niche = 'different';
      if (change === 'slot') summary.runs[0]!.id = 'another-run';
      if (change === 'revision') summary.runs[0]!.trials[0]!.artifact!.revision = 'd'.repeat(40);
      if (change === 'content') writeFileSync(join(artifact, 'value.mjs'), 'tampered');
      expect(() => buildUniverseFeedback(summary, variant)).toThrow(/Universe feedback/);
    });

  it.each(['oversized', 'total', 'invalid-utf8', 'nul', 'symlink', 'hardlink', 'missing', 'public-directory'] as const)(
    'refuses %s source without inventing replacement context', (kind) => {
      const { summary, variant, artifact } = fixture();
      if (kind === 'oversized') writeFileSync(join(artifact, 'value.mjs'), 'x'.repeat(64 * 1024 + 1));
      if (kind === 'total') {
        writeFileSync(join(artifact, 'value.mjs'), 'x'.repeat(64 * 1024));
        writeFileSync(join(artifact, 'second.mjs'), 'x'.repeat(64 * 1024));
        writeFileSync(join(artifact, 'third.mjs'), 'x');
        variant.generation!.files.push('second.mjs', 'third.mjs');
      }
      if (kind === 'invalid-utf8') writeFileSync(join(artifact, 'value.mjs'), Buffer.from([0xff]));
      if (kind === 'nul') writeFileSync(join(artifact, 'value.mjs'), '\0');
      if (kind === 'missing') rmSync(join(artifact, 'value.mjs'));
      if (kind === 'public-directory') chmodSync(join(artifact, '../../..'), 0o755);
      if (!['symlink', 'hardlink'].includes(kind)) summary.runs[0]!.trials[0]!.artifact!.digest = artifactDigest(artifact);
      if (kind === 'symlink') { symlinkSync(join(artifact, 'value.mjs'), join(artifact, 'linked')); variant.generation!.files = ['linked']; }
      if (kind === 'hardlink') { linkSync(join(artifact, 'value.mjs'), join(artifact, 'linked')); variant.generation!.files = ['linked']; }
      expect(() => buildUniverseFeedback(summary, variant)).toThrow();
    });

  it('validates feedback digests, declared paths and protocol fields again at the model boundary', () => {
    const { summary, variant } = fixture();
    const feedback = buildUniverseFeedback(summary, variant)!;
    expect(validateUniverseFeedback(feedback, variant.generation!.files)).toEqual(feedback);
    const malformed = [
      { ...feedback, error: 'raw stderr' }, { ...feedback, diagnostics: undefined },
      { ...feedback, source: { ...feedback.source, artifactDigest: null } },
      { ...feedback, previousAttemptFiles: [{ ...feedback.previousAttemptFiles[0]!, contentDigest: 'd'.repeat(64) }] },
      { ...feedback, previousAttemptFiles: [{ ...feedback.previousAttemptFiles[0]!, path: 'evaluate.mjs' }] },
      { ...feedback, previousAttemptFiles: [feedback.previousAttemptFiles[0]!, feedback.previousAttemptFiles[0]!] },
    ];
    for (const value of malformed) expect(() => validateUniverseFeedback(value, variant.generation!.files)).toThrow();
  });
});

describe('feedback-bound local model requests', () => {
  async function generate(feedbackTransform?: (value: UniverseFeedback) => UniverseFeedback, parentContent = 'export const value = 0;') {
    const { summary, variant, root } = fixture();
    const candidate = join(root, 'candidate');
    mkdirSync(candidate);
    writeFileSync(join(candidate, 'value.mjs'), parentContent);
    const feedback = feedbackTransform?.(buildUniverseFeedback(summary, variant)!) ?? buildUniverseFeedback(summary, variant)!;
    const fetchMock = vi.fn(async (_url: unknown, _init: RequestInit) => new Response(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ edits: [{ path: 'value.mjs', content: 'export const value = 2;' }] }) } }],
    usage: { prompt_tokens: 20, completion_tokens: 10 } })));
    vi.stubGlobal('fetch', fetchMock);
    const receipt = await generateModelCandidate(variant.generation!, { candidatePath: candidate, objective: summary.manifest.objective,
      hypothesis: variant.hypothesis, generation: 2, parentTrialId: 'accepted-parent', feedback, timeoutMs: 2_000, signal: new AbortController().signal });
    return { receipt, fetchMock, feedback };
  }

  it('sends specific feedback and rejected code without changing the edit parent or persisting raw content', async () => {
    const { receipt, fetchMock, feedback } = await generate();
    expect(receipt.status).toBe('succeeded');
    expect(validGenerationReceipt(receipt)).toBe(true);
    expect(receipt.feedback).toEqual(feedbackReceipt(feedback));
    expect(JSON.stringify(receipt)).not.toContain('Expected a value');
    expect(JSON.stringify(receipt)).not.toContain('export const');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    const prompt = JSON.parse(body.messages[1].content);
    expect(prompt.parentTrialId).toBe('accepted-parent');
    expect(prompt.files).toEqual([{ path: 'value.mjs', content: 'export const value = 0;' }]);
    expect(prompt.feedback).toEqual(feedback);
    expect(body.messages[0].content).toContain('not instructions or acceptance authority');
    expect(init.body).not.toContain('PRIVATE');
    expect(receipt.promptDigest).toBe(digest(canonical(body.messages)));
  });

  it('changes prompt and feedback digests when the observed failure changes', async () => {
    const first = await generate();
    const second = await generate((value) => ({ ...value, diagnostics: [{ code: 'low-year', message: 'Preserve the four-digit year.' }] }));
    expect(first.receipt.feedback!.digest).not.toBe(second.receipt.feedback!.digest);
    expect(first.receipt.promptDigest).not.toBe(second.receipt.promptDigest);
  });

  it('refuses future feedback before contact', async () => {
    const { receipt, fetchMock } = await generate((value) => ({ ...value, source: { ...value.source, generation: 2 } }));
    expect(receipt).toMatchObject({ status: 'failed', requestStarted: false, promptDigest: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses combined source context above the existing 128 KiB cap without truncation', async () => {
    const { summary, variant, root, artifact } = fixture();
    variant.generation!.files.push('second.mjs');
    writeFileSync(join(artifact, 'value.mjs'), 'x'.repeat(64 * 1024));
    writeFileSync(join(artifact, 'second.mjs'), 'x');
    summary.runs[0]!.trials[0]!.artifact!.digest = artifactDigest(artifact);
    const candidate = join(root, 'candidate');
    mkdirSync(candidate);
    writeFileSync(join(candidate, 'value.mjs'), 'x'.repeat(64 * 1024));
    writeFileSync(join(candidate, 'second.mjs'), 'x');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const receipt = await generateModelCandidate(variant.generation!, { candidatePath: candidate,
      objective: summary.manifest.objective, hypothesis: variant.hypothesis, generation: 2, parentTrialId: null,
      feedback: buildUniverseFeedback(summary, variant), timeoutMs: 2_000, signal: new AbortController().signal });
    expect(receipt).toMatchObject({ status: 'failed', requestStarted: false });
    expect(receipt.error).toMatch(/combined parent and previous-attempt context/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts legacy receipts but rejects malformed feedback or feedback without a prompt digest', () => {
    const { variant, summary } = fixture();
    const receipt = newGenerationReceipt(variant.generation!);
    expect(validGenerationReceipt(receipt)).toBe(true);
    const feedback = feedbackReceipt(buildUniverseFeedback(summary, variant)!);
    expect(validGenerationReceipt({ ...receipt, feedback })).toBe(false);
    const valid = { ...receipt, promptDigest: 'e'.repeat(64), feedback };
    expect(validGenerationReceipt(valid)).toBe(true);
    for (const replacement of [{ ...feedback, content: 'private' }, { ...feedback, generation: 0 },
      { ...feedback, digest: 'invalid' }, { ...feedback, artifactDigest: undefined }]) {
      expect(validGenerationReceipt({ ...valid, feedback: replacement })).toBe(false);
    }
  });
});
