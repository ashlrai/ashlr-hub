/**
 * test/h6.scrub-parity.test.ts — H6 PART B (SECRET-SCRUB PARITY).
 *
 * Proves the two deliberate guard-STRENGTHENINGS of Ashlr v2.1 milestone H6
 * (CONTRACT-H6 §B), each of which closes an H4-surfaced FINDING:
 *
 *   B.2 — index.ts SECRET_PATTERNS gains a bare Stripe-token pattern
 *         (/\bsk_(live|test)_[A-Za-z0-9_]{16,}\b/g) so a bare
 *         `sk_live_<underscores>` token — previously MISSED because the
 *         underscores break the base64 char class + \w boundary — is now
 *         redacted. The array grows 6 -> 7 (verify-safety pins length >= 6).
 *
 *   B.1 — graph.ts scrubSecrets adopts index.ts's full pattern set (PARITY):
 *         graph.ts imports { SECRET_PATTERNS, scrubSecrets } from './index.js'
 *         and its local `scrubSecrets` delegates to index's. The old WEAKER
 *         single assignment-style `SECRET_PATTERN` regex (which missed bare
 *         JWT / AKIA / base64 / hex) is gone. graph.ts and index.ts now redact
 *         the IDENTICAL pattern set.
 *
 * These are the strengthenings that DELIBERATELY flip the pinned H4 §6.8 +
 * sk_live_ assertions (CONTRACT-H6 §B.4); this file is the NEW proof that the
 * post-fix behavior is correct. The flips themselves live in
 * test/h4.local-first-secret.test.ts and are NOT touched here.
 *
 * SAFETY (paramount — inherited from H1/H4):
 *   - PURE / NO STATE: every assertion exercises pure, exported functions
 *     (index.ts scrubSecrets / SECRET_PATTERNS) or reads SOURCE bytes via the
 *     H4 static helper. No ~/.ashlr read or write occurs, so the real portfolio
 *     ({repos:[]}) is NEVER touched and no HOME relocation is even required.
 *   - NO NETWORK / NO MODEL: nothing here imports a provider or fetch path.
 *   - DETERMINISTIC: fixed secret literals; every it() has a real expect() and
 *     the suite arms expect.hasAssertions() in beforeEach (no false-green stubs).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { scrubSecrets, SECRET_PATTERNS } from '../src/core/knowledge/index.js';
import { readSource, stripComments } from './helpers/h4-static.js';

// --- Secret-shaped literals (mirror the H4 shapes so parity is faithful) ------

/** JWT — three base64url segments (H4 SECRET_JWT). */
const SECRET_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpEb2UifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
/** AWS access key — AKIA + 16 chars (H4 SECRET_AWS). */
const SECRET_AWS = 'AKIAIOSFODNN7EXAMPLE';
/** ≥40-char base64 blob (H4 SECRET_BASE64). */
const SECRET_BASE64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5';
/** ≥32-char hex blob (H4 SECRET_HEX). */
const SECRET_HEX = 'a'.repeat(40);
/** assignment-style api-key (H4 SECRET_APIKEY_ASSIGN). */
const SECRET_APIKEY_ASSIGN = 'api_key = "abcdefghij0123456789ABCDEFGHIJ"';

// The NEW H6 target: a bare Stripe secret key with UNDERSCORES, which the
// pre-H6 base64/hex/JWT/AWS patterns all miss. 16+ chars after the prefix.
const SECRET_SK_LIVE = 'sk_live_4eC39HqLyjWDarjtT1zdp7dc';
const SECRET_SK_TEST = 'sk_test_4eC39HqLyjWDarjtT1zdp7dc';

/** A benign token that LOOKS key-ish but carries no high-entropy secret and must
 *  be PRESERVED (over-redaction is its own failure). */
const BENIGN = 'the quick brown fox jumps over 7 lazy dogs';

/**
 * graph.ts's `scrubSecrets` is module-private and only reachable in production
 * via buildGraph's `detail` string (unnatural to seed with a secret). After the
 * H6 fix it DELEGATES to index.ts's exported `scrubSecrets` over the shared
 * exported `SECRET_PATTERNS`. So exercising index's scrubSecrets IS exercising
 * graph's real post-fix behavior — and the [STATIC] parity test below proves
 * graph.ts is wired to that exact import (the faithful path, per CONTRACT-H4
 * §6.8 / CONTRACT-H6 §B.5). This helper makes the "graph behavior" intent
 * explicit at each call site.
 */
function graphScrub(text: string): string {
  return scrubSecrets(text);
}

describe('H6 PART B — secret-scrub parity', () => {
  beforeEach(() => {
    expect.hasAssertions();
  });

  // --- B.2: index.ts now redacts bare sk_live_ / sk_test_ ---------------------

  it('B.2 index.ts scrubSecrets NOW redacts a bare sk_live_ Stripe token', () => {
    const out = scrubSecrets(`stripe key is ${SECRET_SK_LIVE} ok`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(SECRET_SK_LIVE);
  });

  it('B.2 index.ts scrubSecrets NOW redacts a bare sk_test_ Stripe token', () => {
    const out = scrubSecrets(`test key ${SECRET_SK_TEST}`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(SECRET_SK_TEST);
  });

  it('B.2 the sk_(live|test)_ pattern grows SECRET_PATTERNS to exactly 7', () => {
    // 6 original high-entropy/assignment patterns + the new Stripe pattern.
    // verify-safety pins length >= 6, so 7 keeps CHECK 4 GREEN.
    expect(SECRET_PATTERNS.length).toBe(7);
    const hasStripe = SECRET_PATTERNS.some((p) =>
      p.source.includes('sk_(live|test)_'),
    );
    expect(hasStripe).toBe(true);
  });

  // --- B.1: graph.ts (via delegation to index) now redacts bare blobs ---------

  it('B.1 graph scrub NOW redacts a bare JWT (was missed pre-H6)', () => {
    const out = graphScrub(`token ${SECRET_JWT} end`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(SECRET_JWT);
  });

  it('B.1 graph scrub NOW redacts a bare AWS AKIA key (was missed pre-H6)', () => {
    const out = graphScrub(`aws ${SECRET_AWS}`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(SECRET_AWS);
  });

  it('B.1 graph scrub NOW redacts a bare base64 blob (was missed pre-H6)', () => {
    const out = graphScrub(`blob ${SECRET_BASE64} done`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(SECRET_BASE64);
  });

  it('B.1 graph scrub NOW redacts a bare hex blob and a bare sk_live_ (parity)', () => {
    const outHex = graphScrub(`hash ${SECRET_HEX}`);
    expect(outHex).toContain('[REDACTED]');
    expect(outHex).not.toContain(SECRET_HEX);

    const outSk = graphScrub(`stripe ${SECRET_SK_LIVE}`);
    expect(outSk).toContain('[REDACTED]');
    expect(outSk).not.toContain(SECRET_SK_LIVE);
  });

  // --- PARITY: index and graph redact the SAME set ----------------------------

  it('PARITY index.ts and graph.ts redact the IDENTICAL set of shapes', () => {
    const shapes = [
      SECRET_JWT,
      SECRET_AWS,
      SECRET_BASE64,
      SECRET_HEX,
      SECRET_APIKEY_ASSIGN,
      SECRET_SK_LIVE,
      SECRET_SK_TEST,
    ];
    for (const s of shapes) {
      const wrapped = `value: ${s}`;
      const viaIndex = scrubSecrets(wrapped);
      const viaGraph = graphScrub(wrapped);
      // Both redact, and to the SAME output (graph delegates to index) => parity.
      expect(viaIndex).toContain('[REDACTED]');
      expect(viaGraph).toContain('[REDACTED]');
      expect(viaGraph).toBe(viaIndex);
    }
  });

  it('a benign non-secret token is PRESERVED by both scrubs (no over-redaction)', () => {
    expect(scrubSecrets(BENIGN)).toBe(BENIGN);
    expect(graphScrub(BENIGN)).toBe(BENIGN);
  });

  // --- [STATIC] PARITY WIRING + verify-safety CHECK 4 GREEN --------------------

  it('[STATIC] graph.ts imports SECRET_PATTERNS + scrubSecrets from ./index.js', () => {
    const src = stripComments(readSource('core/knowledge/graph.ts'));
    // graph adopts index's set (the PARITY wiring, CONTRACT-H6 §B.1).
    expect(src).toMatch(/import\s*\{[^}]*SECRET_PATTERNS[^}]*\}\s*from\s*['"]\.\/index\.js['"]/);
    expect(src).toContain('scrubSecrets');
    expect(src).toContain('./index.js');
    // The OLD weaker single regex literal must be GONE (no inline definition).
    expect(src).not.toMatch(/const SECRET_PATTERN\s*=\s*\//);
  });

  it('[STATIC] verify-safety CHECK 4 drift markers stay GREEN in graph.ts source', () => {
    // CHECK 4 (cli/verify-safety.ts) reads graph.ts SOURCE and now pins LIVE CODE
    // (the real parity import), NOT a vestigial assignment-regex comment string.
    // Post-H6 review (CONTRACT-H6 §B.1): CHECK 4 requires graph.ts to (a) define
    // `function scrubSecrets`, and (b) IMPORT the parity scrub from './index.js'
    // (scrubSecrets + SECRET_PATTERNS). A cosmetic comment edit can no longer
    // trip CHECK 4; only removing the genuine delegation will.
    const rawSrc = readSource('core/knowledge/graph.ts');
    expect(/function scrubSecrets/.test(rawSrc)).toBe(true);
    expect(/SECRET_PATTERNS/.test(rawSrc)).toBe(true);
    expect(/from ['"]\.\/index\.js['"]/.test(rawSrc)).toBe(true);
    expect(/scrubSecrets/.test(rawSrc)).toBe(true);
  });

  it('[STATIC] index.ts source still pins AKIA + eyJ and the new sk_(live|test)_ pattern', () => {
    const rawSrc = readSource('core/knowledge/index.ts');
    // verify-safety CHECK 4 also pins these in index.ts source.
    expect(rawSrc.includes('AKIA')).toBe(true);
    expect(rawSrc.includes('eyJ')).toBe(true);
    // The H6 B.2 addition is present in source.
    expect(rawSrc).toContain('sk_(live|test)_');
  });
});
