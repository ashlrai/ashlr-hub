/**
 * classify/engine-errors — the unified engine-error classification.
 *
 * Two things are under test and both matter:
 *   1. The DETERMINISTIC layer still answers exactly as the two prior
 *      implementations did, except where they disagreed — and there it now
 *      answers once, consistently.
 *   2. The CLASSIFIER layer is strictly optional. With no key, no network, or a
 *      transport that misbehaves, the deterministic answer comes back labelled
 *      with the path that produced it.
 *
 * The transport is stubbed throughout. This suite requires no API key and
 * performs no network I/O.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { classifyAgentDiagnosticError } from '../src/core/run/agent-diagnostics.js';
import { TYPESAFE_API_KEY_ENV, TYPESAFE_DISABLE_ENV } from '../src/core/classify/typesafe-client.js';
import {
  ENGINE_ERROR_CONFIDENCE_THRESHOLD,
  ENGINE_ERROR_KINDS,
  classifyEngineError,
  classifyEngineErrorHeuristic,
  describeEngineErrorClassification,
  isMcpDownstreamText,
  isModelFailureText,
  isRateLimitText,
  isRetryableKind,
  toAgentDiagnosticErrorClass,
  type EngineErrorKind,
} from '../src/core/classify/engine-errors.js';

const cfg = { phantom: { enabled: false } } as unknown as AshlrConfig;
const ENDPOINT = 'https://classifier.invalid/v1/systemone';
const FAKE_KEY = 'test-key-not-a-real-credential';

const savedKey = process.env[TYPESAFE_API_KEY_ENV];
const savedDisable = process.env[TYPESAFE_DISABLE_ENV];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete process.env[TYPESAFE_API_KEY_ENV];
  delete process.env[TYPESAFE_DISABLE_ENV];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env[TYPESAFE_API_KEY_ENV];
  else process.env[TYPESAFE_API_KEY_ENV] = savedKey;
  if (savedDisable === undefined) delete process.env[TYPESAFE_DISABLE_ENV];
  else process.env[TYPESAFE_DISABLE_ENV] = savedDisable;
});

function answer(kind: string, confidence: number, noul?: number): Response {
  const answers: Record<string, unknown> = {
    error_kind: { type: 'choice', choice: kind, confidence, probabilities: { [kind]: confidence } },
  };
  if (noul !== undefined) answers['retryable'] = { type: 'noul', noul };
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers }), { status: 200 });
}

// ---------------------------------------------------------------------------
// Deterministic layer
// ---------------------------------------------------------------------------

describe('classifyEngineErrorHeuristic — preserves the existing labels', () => {
  it('returns none for absent or blank input', () => {
    expect(classifyEngineErrorHeuristic(undefined)).toBe('none');
    expect(classifyEngineErrorHeuristic('')).toBe('none');
    expect(classifyEngineErrorHeuristic('   \n ')).toBe('none');
    expect(classifyEngineErrorHeuristic(42)).toBe('none');
  });

  it('agrees with classifyAgentDiagnosticError on every label it can produce', () => {
    const samples = [
      '429 too many requests',
      'Unauthorized token',
      'ENOENT codex',
      'error loading config',
      'spawn ETIMEDOUT',
      'killed by signal SIGTERM',
    ];
    for (const s of samples) {
      expect(classifyEngineErrorHeuristic(s)).toBe(classifyAgentDiagnosticError(s));
    }
  });

  it('keeps `spawn ETIMEDOUT` as timeout — the broad mcp predicate runs LAST', () => {
    // isMcpDownstreamText matches "spawn", so ordering is the only thing
    // stopping this from being relabelled and contradicting persisted history.
    expect(isMcpDownstreamText('spawn ETIMEDOUT')).toBe(true);
    expect(classifyEngineErrorHeuristic('spawn ETIMEDOUT')).toBe('timeout');
  });

  it('refines the catch-all with the two heal-only kinds', () => {
    expect(classifyAgentDiagnosticError('MCP downstream crashed: ECONNRESET')).toBe('execution');
    expect(classifyEngineErrorHeuristic('MCP downstream crashed: ECONNRESET')).toBe('mcp-downstream');

    expect(classifyAgentDiagnosticError('model error: out of memory')).toBe('execution');
    expect(classifyEngineErrorHeuristic('model error: out of memory')).toBe('model-failure');
  });

  it('leaves a genuinely unrecognised failure as execution', () => {
    expect(classifyEngineErrorHeuristic('fatal: non-retryable internal error')).toBe('execution');
  });
});

describe('the rate-limit disagreement is resolved by union', () => {
  it.each(['quota exceeded', 'upstream is overloaded', 'request was throttled'])(
    'now labels %j as rate-limit, where the diagnostics table said execution',
    (text) => {
      expect(classifyAgentDiagnosticError(text)).toBe('execution');
      expect(classifyEngineErrorHeuristic(text)).toBe('rate-limit');
    },
  );

  it.each(['rate limit exceeded', 'rate_limit_error', 'HTTP 429', 'Too Many Requests'])(
    'still labels %j as rate-limit',
    (text) => {
      expect(classifyEngineErrorHeuristic(text)).toBe('rate-limit');
    },
  );

  it('does not treat an unrelated number containing 429 as a rate limit', () => {
    expect(isRateLimitText('exited with code 4291')).toBe(false);
  });
});

describe('shared predicates are the single source of truth', () => {
  it('exempts our own MCP argv refusal from the restartable notion', () => {
    expect(isMcpDownstreamText('unsafe mcp argv refused: /bin/sh')).toBe(false);
  });

  it('recognises the local-model failure vocabulary', () => {
    expect(isModelFailureText('CUDA out of memory')).toBe(true);
    expect(isModelFailureText('context window exceeded')).toBe(true);
    expect(isModelFailureText('model not loaded')).toBe(true);
    expect(isModelFailureText('everything is fine')).toBe(false);
  });
});

describe('retryability and schema projection', () => {
  it('marks only genuinely transient kinds retryable', () => {
    expect(isRetryableKind('rate-limit')).toBe(true);
    expect(isRetryableKind('timeout')).toBe(true);
    expect(isRetryableKind('mcp-downstream')).toBe(true);
    expect(isRetryableKind('model-failure')).toBe(true);
    expect(isRetryableKind('authentication')).toBe(false);
    expect(isRetryableKind('command-missing')).toBe(false);
    expect(isRetryableKind('configuration')).toBe(false);
    expect(isRetryableKind('terminated')).toBe(false);
    expect(isRetryableKind('execution')).toBe(false);
    expect(isRetryableKind('none')).toBe(false);
  });

  it('projects the two new kinds back onto execution so no persisted row changes meaning', () => {
    expect(toAgentDiagnosticErrorClass('mcp-downstream')).toBe('execution');
    expect(toAgentDiagnosticErrorClass('model-failure')).toBe('execution');
    for (const kind of ENGINE_ERROR_KINDS) {
      if (kind === 'mcp-downstream' || kind === 'model-failure') continue;
      expect(toAgentDiagnosticErrorClass(kind)).toBe(kind);
    }
  });

  it('projects every unified kind into the persisted enum', () => {
    const persisted = new Set([
      'none',
      'authentication',
      'configuration',
      'command-missing',
      'rate-limit',
      'timeout',
      'terminated',
      'execution',
    ]);
    for (const kind of ENGINE_ERROR_KINDS) {
      expect(persisted.has(toAgentDiagnosticErrorClass(kind))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The offline guarantee
// ---------------------------------------------------------------------------

describe('classifyEngineError — local-first, offline by default', () => {
  it('returns the deterministic answer with zero I/O when unkeyed', async () => {
    const res = await classifyEngineError('429 too many requests', cfg, { endpoint: ENDPOINT });
    expect(res.kind).toBe('rate-limit');
    expect(res.retryable).toBe(true);
    expect(res.source).toBe('fallback');
    expect(res.unavailableReason).toBe('no-key');
    expect(res.classifierMs).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never calls the paid API for empty input', async () => {
    process.env[TYPESAFE_API_KEY_ENV] = FAKE_KEY;
    const res = await classifyEngineError('', cfg, { endpoint: ENDPOINT });
    expect(res.kind).toBe('none');
    expect(res.source).toBe('fallback');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back on every transport failure mode rather than throwing', async () => {
    process.env[TYPESAFE_API_KEY_ENV] = FAKE_KEY;
    const cases: Array<[string, () => void]> = [
      ['network', () => fetchMock.mockRejectedValue(new Error('ENOTFOUND'))],
      ['http-error', () => fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))],
      ['rate-limited', () => fetchMock.mockResolvedValue(new Response('', { status: 429 }))],
      ['malformed-response', () => fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }))],
    ];
    for (const [reason, arrange] of cases) {
      fetchMock.mockReset();
      arrange();
      const res = await classifyEngineError('Unauthorized token', cfg, { endpoint: ENDPOINT });
      expect(res.kind).toBe('authentication');
      expect(res.source).toBe('fallback');
      expect(res.unavailableReason).toBe(reason);
    }
  });

  it('falls back when the classifier invents a label outside the union', async () => {
    process.env[TYPESAFE_API_KEY_ENV] = FAKE_KEY;
    fetchMock.mockResolvedValue(answer('catastrophe', 1.0, 0.9));
    const res = await classifyEngineError('ENOENT codex', cfg, { endpoint: ENDPOINT });
    expect(res.kind).toBe('command-missing');
    expect(res.source).toBe('fallback');
    expect(res.unavailableReason).toBe('no-answer');
  });

  it('never proposes `none` to the classifier', async () => {
    process.env[TYPESAFE_API_KEY_ENV] = FAKE_KEY;
    fetchMock.mockResolvedValue(answer('execution', 1.0, 0.1));
    await classifyEngineError('something broke', cfg, { endpoint: ENDPOINT });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(Object.keys(body.questions.error_kind.criteria)).not.toContain('none');
  });
});

// ---------------------------------------------------------------------------
// The confidence gate
// ---------------------------------------------------------------------------

describe('classifyEngineError — confidence gate and provenance', () => {
  beforeEach(() => {
    process.env[TYPESAFE_API_KEY_ENV] = FAKE_KEY;
  });

  it('asks the kind and the retryability Noul in ONE request', async () => {
    fetchMock.mockResolvedValue(answer('rate-limit', 1.0, 0.86));
    await classifyEngineError('429 too many requests', cfg, { endpoint: ENDPOINT });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(Object.keys(body.questions).sort()).toEqual(['error_kind', 'retryable']);
    expect(body.questions.retryable.type).toBe('noul');
  });

  it('accepts the classifier at or above the threshold and records source=classifier', async () => {
    fetchMock.mockResolvedValue(answer('model-failure', ENGINE_ERROR_CONFIDENCE_THRESHOLD, 0.2));
    const res = await classifyEngineError('engine exited with code 1', cfg, { endpoint: ENDPOINT });
    expect(res.kind).toBe('model-failure');
    expect(res.source).toBe('classifier');
    expect(res.confidence).toBe(ENGINE_ERROR_CONFIDENCE_THRESHOLD);
    expect(res.model).toBe('jev-1.13.0');
    expect(res.unavailableReason).toBeUndefined();
  });

  it('lets the classifier overrule a regex that misfires — the reason it exists', async () => {
    // "not found" makes the regex table say command-missing; the real cause is
    // an unpulled model. This is a real, measured case from the live API.
    const stderr = 'Error: model "qwen2.5-coder:32b" not found, try pulling it first';
    expect(classifyEngineErrorHeuristic(stderr)).toBe('command-missing');
    fetchMock.mockResolvedValue(answer('model-failure', 0.81, 0.1));
    const res = await classifyEngineError(stderr, cfg, { endpoint: ENDPOINT });
    expect(res.kind).toBe('model-failure');
    expect(res.source).toBe('classifier');
  });

  it('rejects a below-threshold answer, keeps the heuristic, and records both', async () => {
    // 0.57 is the measured ambiguous case from the live API.
    fetchMock.mockResolvedValue(answer('execution', 0.57, 0.55));
    const res = await classifyEngineError('MCP downstream crashed: ECONNRESET', cfg, {
      endpoint: ENDPOINT,
    });
    expect(res.kind).toBe('mcp-downstream'); // the deterministic answer wins
    expect(res.source).toBe('heuristic');
    expect(res.unavailableReason).toBe('below-threshold');
    // Both sides retained so the threshold can be re-tuned from recorded data.
    expect(res.classifierKind).toBe('execution');
    expect(res.classifierConfidence).toBe(0.57);
    expect(res.retryProbability).toBe(0.55);
  });

  it('places the default threshold strictly inside the measured calibration gap', () => {
    expect(ENGINE_ERROR_CONFIDENCE_THRESHOLD).toBeGreaterThan(0.57);
    expect(ENGINE_ERROR_CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(1.0);
  });

  it('honours a caller-supplied threshold', async () => {
    fetchMock.mockResolvedValue(answer('execution', 0.6, 0.5));
    const strict = await classifyEngineError('MCP crashed', cfg, { endpoint: ENDPOINT, confidenceThreshold: 0.99 });
    expect(strict.source).toBe('heuristic');
    fetchMock.mockResolvedValue(answer('execution', 0.6, 0.5));
    const loose = await classifyEngineError('MCP crashed', cfg, { endpoint: ENDPOINT, confidenceThreshold: 0.5 });
    expect(loose.source).toBe('classifier');
  });

  it('uses the Noul as a probability with a 0.5 boundary', async () => {
    fetchMock.mockResolvedValue(answer('terminated', 1.0, 0.9));
    const retryable = await classifyEngineError('killed by signal', cfg, { endpoint: ENDPOINT });
    // The deterministic rule says terminated is not retryable; a confident
    // classifier saying otherwise is allowed to win once it passed the gate.
    expect(retryable.retryable).toBe(true);
    expect(retryable.retryProbability).toBe(0.9);

    fetchMock.mockResolvedValue(answer('timeout', 1.0, 0.1));
    const not = await classifyEngineError('operation timed out', cfg, { endpoint: ENDPOINT });
    expect(not.retryable).toBe(false);
  });

  it('falls back to deterministic retryability when the Noul is missing', async () => {
    fetchMock.mockResolvedValue(answer('rate-limit', 1.0));
    const res = await classifyEngineError('429 too many requests', cfg, { endpoint: ENDPOINT });
    expect(res.source).toBe('classifier');
    expect(res.retryProbability).toBeUndefined();
    expect(res.retryable).toBe(isRetryableKind('rate-limit'));
  });

  it('bounds how long a failure path can stall on the classifier', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const started = Date.now();
    const res = await classifyEngineError('429 too many requests', cfg, {
      endpoint: ENDPOINT,
      timeoutMs: 25,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.kind).toBe('rate-limit');
    expect(res.source).toBe('fallback');
    expect(res.unavailableReason).toBe('timeout');
  });

  it('is disabled process-wide by the kill env', async () => {
    process.env[TYPESAFE_DISABLE_ENV] = '1';
    const res = await classifyEngineError('429 too many requests', cfg, { endpoint: ENDPOINT });
    expect(res.source).toBe('fallback');
    expect(res.unavailableReason).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Audit line
// ---------------------------------------------------------------------------

describe('describeEngineErrorClassification', () => {
  it('records the path that produced the answer and never the classified text', async () => {
    const secretish = 'Bearer sk-live-do-not-log-me: 429 too many requests';
    const res = await classifyEngineError(secretish, cfg, { endpoint: ENDPOINT });
    const line = describeEngineErrorClassification(res);
    expect(line).toContain('kind=rate-limit');
    expect(line).toContain('source=fallback');
    expect(line).toContain('why=no-key');
    expect(line).not.toContain('sk-live-do-not-log-me');
  });

  it('surfaces the rejected classifier answer when the gate turned it down', async () => {
    process.env[TYPESAFE_API_KEY_ENV] = FAKE_KEY;
    fetchMock.mockResolvedValue(answer('execution', 0.57, 0.55));
    const res = await classifyEngineError('MCP downstream crashed', cfg, { endpoint: ENDPOINT });
    const line = describeEngineErrorClassification(res);
    expect(line).toContain('source=heuristic');
    expect(line).toContain('classifierKind=execution');
    expect(line).toContain('classifierConfidence=0.57');
  });

  it('covers every kind in the union', () => {
    const seen = new Set<EngineErrorKind>(ENGINE_ERROR_KINDS);
    expect(seen.size).toBe(10);
  });
});
