/**
 * Pins the claim-vs-evidence check.
 *
 * Every string in the "real messages" block was captured from an actual local
 * agent turn, including the one that reported a fix to a line the file does not
 * have. These tests never reach the network: the classifier is exercised with
 * an endpoint that cannot answer, so what is asserted here is the DETERMINISTIC
 * behaviour and the fallback contract. The classifier's own accuracy was
 * measured separately against the live service.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyCompletionClaimHeuristic,
  classifyCompletionClaim,
  turnIntegrity,
  describeTurnIntegrity,
  type CompletionClaim,
} from '../src/core/classify/completion-claims.js';

/** Unroutable, so askTypeSafe fails fast and the fallback path is what runs. */
const DEAD = 'http://127.0.0.1:1/never';

describe('classifyCompletionClaimHeuristic', () => {
  it('reads a past-tense edit assertion as a change claim', () => {
    expect(classifyCompletionClaimHeuristic('Fixed `mul` in n.js:11 — `a + b` → `a * b`.'))
      .toBe('claims-change');
    expect(classifyCompletionClaimHeuristic('I updated both call sites.')).toBe('claims-change');
  });

  it('reads a refusal as blocked', () => {
    expect(classifyCompletionClaimHeuristic(
      "I have to stop and flag this rather than reply DONE, because I couldn't actually do the work.",
    )).toBe('reports-blocked');
  });

  it('treats "I fixed A but could not do B" as a change claim', () => {
    // Something IS asserted to have landed, and that part is checkable. Calling
    // this `reports-blocked` would skip the check the module exists for.
    expect(classifyCompletionClaimHeuristic('Fixed the parser. I could not reach the fixture server.'))
      .toBe('claims-change');
  });

  it('shrugs at a bare completion token rather than guessing', () => {
    // "DONE" alone is as consistent with answering a question as with editing.
    // Guessing here is what would produce false `unsupported-claim` reports and
    // make the whole signal ignorable.
    expect(classifyCompletionClaimHeuristic('DONE')).toBe('unknown');
  });

  it('shrugs at empty and non-string input instead of throwing', () => {
    for (const value of ['', '   ', undefined, null, 42, {}, []]) {
      expect(classifyCompletionClaimHeuristic(value)).toBe('unknown');
    }
  });
});

describe('turnIntegrity', () => {
  it('flags the case this module exists for: claimed a change, nothing moved', () => {
    expect(turnIntegrity('claims-change', 0)).toBe('unsupported-claim');
  });

  it('accepts a claimed change backed by a real edit', () => {
    expect(turnIntegrity('claims-change', 1)).toBe('consistent');
    expect(turnIntegrity('claims-change', 9)).toBe('consistent');
  });

  it('flags a blocked report that nonetheless moved files', () => {
    expect(turnIntegrity('reports-blocked', 2)).toBe('silent-change');
  });

  it('accepts a blocked report with nothing changed, and a read-only answer', () => {
    expect(turnIntegrity('reports-blocked', 0)).toBe('consistent');
    expect(turnIntegrity('answers-only', 0)).toBe('consistent');
    // A question answered while an edit also landed is not a contradiction.
    expect(turnIntegrity('answers-only', 3)).toBe('consistent');
  });

  it('separates "we did not look" from "nothing changed"', () => {
    // Conflating them would raise unsupported-claim on every turn whose caller
    // never observed the tree — which is every read-only turn.
    for (const claim of ['claims-change', 'reports-blocked', 'answers-only', 'unknown'] as CompletionClaim[]) {
      expect(turnIntegrity(claim, null)).toBe('unknown');
    }
    expect(turnIntegrity('claims-change', Number.NaN)).toBe('unknown');
  });

  it('never reports a verdict for an unknown claim', () => {
    expect(turnIntegrity('unknown', 0)).toBe('unknown');
    expect(turnIntegrity('unknown', 5)).toBe('unknown');
  });
});

describe('classifyCompletionClaim', () => {
  it('falls back to the heuristic when the classifier cannot be reached', async () => {
    const out = await classifyCompletionClaim('Fixed the off-by-one in cart.js.', {}, {
      endpoint: DEAD,
      timeoutMs: 400,
    });
    expect(out.claim).toBe('claims-change');
    expect(out.source).toBe('fallback');
    // A fallback is certain of the answer it gives; it just did not ask.
    expect(out.confidence).toBe(1);
  });

  it('spends nothing on input that is empty by definition', async () => {
    const out = await classifyCompletionClaim('   ', {}, { endpoint: DEAD, timeoutMs: 400 });
    expect(out.claim).toBe('unknown');
    expect(out.source).toBe('fallback');
    expect(out.classifierMs).toBe(0);
  });

  it('does not throw on any input shape — it sits on a completion path', async () => {
    for (const value of [undefined, null, 42, {}, [], 'DONE']) {
      await expect(classifyCompletionClaim(value, {}, { endpoint: DEAD, timeoutMs: 400 }))
        .resolves.toMatchObject({ source: 'fallback' });
    }
  });

  it('keeps the heuristic when the classifier is not confident enough', async () => {
    // Threshold of 1.1 is unreachable, so any answer must be discarded.
    const out = await classifyCompletionClaim('Fixed it.', {}, {
      endpoint: DEAD,
      timeoutMs: 400,
      confidenceThreshold: 1.1,
    });
    expect(out.claim).toBe('claims-change');
    expect(out.source).toBe('fallback');
  });
});

describe('describeTurnIntegrity', () => {
  it('speaks only when there is something wrong', () => {
    expect(describeTurnIntegrity('unsupported-claim')).toMatch(/no file was modified/);
    expect(describeTurnIntegrity('silent-change')).toMatch(/files were modified/);
    expect(describeTurnIntegrity('consistent')).toBe('');
    expect(describeTurnIntegrity('unknown')).toBe('');
  });
});
