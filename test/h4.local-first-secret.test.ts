/**
 * test/h4.local-first-secret.test.ts — H4 INVARIANTS 5 & 6 (consolidated).
 *
 * INVARIANT 5 — LOCAL-FIRST / NO-CLOUD-EGRESS (CONTRACT-H4.md §5, guards 5.1–5.7):
 *   getActiveClient cloud-gates: it THROWS for a cloud provider unless
 *   allowCloud AND the provider's API key are present, and EVEN THEN refuses
 *   ("does not yet implement cloud") rather than silently egressing. Every LLM
 *   caller (planner / goals-planner / playbooks / digest / ask / daemon) passes
 *   allowCloud=false by default. reflect.ts has NO network at all ([STATIC]).
 *   PRIORITY (previously UNTESTED): 5.5 (gate throws PER provider in
 *   CLOUD_PROVIDERS), 5.7 ([STATIC] reflect.ts has no fetch/getActiveClient/http).
 *
 * INVARIANT 6 — SECRET-SCRUB (CONTRACT-H4.md §6, guards 6.1–6.8):
 *   scrubSecrets runs before store/embed; secret-FILE skip-lists drop
 *   .env/secrets.json/credentials.json/.npmrc/…; specific secret shapes
 *   (JWT / AWS AKIA / long hex / long base64 / api-key=value / sk-…) are
 *   redacted to [REDACTED] BEFORE the chunk is stored. index.ts-vs-graph.ts
 *   scrub-pattern parity is checked statically — and the divergence is FLAGGED
 *   as a FINDING (graph.ts is weaker: it misses bare high-entropy blobs).
 *   PRIORITY (previously UNTESTED): 6.6 (specific patterns redacted in index.ts),
 *   6.8 ([STATIC] index vs graph parity FINDING).
 *
 * SAFETY (paramount — see CONTRACT-H4.md):
 *   - ISOLATED HOME: every state-touching test runs under the H1 fixture's fresh
 *     tmp HOME, so every ~/.ashlr read/write is isolated; the real portfolio
 *     ({repos:[]}) is NEVER enrolled or touched.
 *   - NO NETWORK / NO MODEL: INVARIANT 5 mocks `../src/core/providers.js`
 *     (getProviderRegistry) so getActiveClient resolves a provider id WITHOUT
 *     probing any endpoint — the cloud-gate throws BEFORE any fetch. INVARIANT 6
 *     mocks global `fetch` to reject, so the index path's only two network calls
 *     (embedding detect / embed) degrade to "unavailable" — chunks store as plain
 *     scrubbed text with ZERO outward call. DETERMINISTIC: no live model.
 *   - NO REAL SECRET: only synthetic, well-known-SHAPED tokens are used.
 *   - EXPLICIT ASSERTIONS: every it() has real expect(); beforeEach calls
 *     expect.hasAssertions() so a vacuous stub fails loudly (H2/H3 false-green guard).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// INVARIANT 5 setup — mock the provider registry so getActiveClient resolves an
// activeProvider WITHOUT probing any network endpoint. The cloud-gate then runs
// (and throws) deterministically, offline. Mock is hoisted above the import.
// ---------------------------------------------------------------------------

const mockGetProviderRegistry = vi.fn();
vi.mock('../src/core/providers.js', () => ({
  getProviderRegistry: (...args: unknown[]) => mockGetProviderRegistry(...args),
}));

// Lazy (post-mock) imports of the REAL surfaces under test.
import { getActiveClient } from '../src/core/run/provider-client.js';
import { buildKnowledge, loadChunks, scrubSecrets } from '../src/core/knowledge/index.js';
import { readSource, containsToken, importLines, stripComments } from './helpers/h4-static.js';
import { makeFixture, makeCfg } from './helpers/h1-fixture.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { H1Fixture, DisposableRepo } from './helpers/h1-fixture.js';

// The REAL cloud-provider set + their env vars (pinned from provider-client.ts).
// If provider-client.ts adds a provider, the [STATIC] parity assertion below
// catches the divergence so this list cannot silently drift.
const CLOUD_PROVIDERS = ['anthropic', 'openai', 'gemini', 'cohere', 'groq', 'mistral', 'azure'];
const CLOUD_PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  cohere: 'COHERE_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
};

/** A registry mock that reports `activeId` as the active provider (no probe). */
function registryWithActive(activeId: string | null) {
  return {
    providers: [],
    activeProvider: activeId,
    chain: activeId === null ? [] : [activeId],
  };
}

// =========================================================================
// INVARIANT 5 — LOCAL-FIRST / NO-CLOUD-EGRESS
// =========================================================================

describe('H4 · INV5 LOCAL-FIRST · getActiveClient cloud-gate', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    expect.hasAssertions();
    mockGetProviderRegistry.mockReset();
    // Clear EVERY cloud key for isolation so key-presence is fully controlled.
    savedEnv = {};
    for (const v of Object.values(CLOUD_PROVIDER_ENV)) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // 5.1 — cloud provider + !allowCloud => THROWS "Pass --allow-cloud".
  it('5.1 cloud provider + !allowCloud THROWS the --allow-cloud gate', async () => {
    mockGetProviderRegistry.mockResolvedValue(registryWithActive('anthropic'));
    const cfg = makeCfg();
    await expect(getActiveClient(cfg, { allowCloud: false })).rejects.toThrow(/Pass --allow-cloud/i);
  });

  // 5.2 — allowCloud true but API key absent => THROWS "<ENV> is not set".
  it('5.2 allowCloud + missing API key THROWS "<ENV> is not set"', async () => {
    mockGetProviderRegistry.mockResolvedValue(registryWithActive('anthropic'));
    const cfg = makeCfg();
    // ANTHROPIC_API_KEY is cleared in beforeEach.
    await expect(getActiveClient(cfg, { allowCloud: true, provider: 'anthropic' })).rejects.toThrow(
      /ANTHROPIC_API_KEY is not set/i,
    );
  });

  // 5.3 — cloud provider + key present => THROWS "does not yet implement cloud"
  // (the gate refuses rather than silently egressing).
  it('5.3 cloud provider + key present STILL THROWS (no silent egress)', async () => {
    mockGetProviderRegistry.mockResolvedValue(registryWithActive('anthropic'));
    const cfg = makeCfg();
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
    await expect(getActiveClient(cfg, { allowCloud: true, provider: 'anthropic' })).rejects.toThrow(
      /does not yet implement cloud/i,
    );
  });

  // 5.4 — no reachable provider => THROWS the local-first message (no cloud fallback).
  it('5.4 no reachable provider THROWS local-first (no cloud fallback)', async () => {
    mockGetProviderRegistry.mockResolvedValue(registryWithActive(null));
    const cfg = makeCfg();
    await expect(getActiveClient(cfg, { allowCloud: false })).rejects.toThrow(
      /local-first: no provider is reachable/i,
    );
  });

  // 5.5 [UNTESTED] — the cloud-gate throws for EVERY id in CLOUD_PROVIDERS, not
  // just the one the happy path happens to pick. Two sweeps: (a) !allowCloud =>
  // the --allow-cloud gate; (b) allowCloud + key absent => the key-missing gate.
  it('5.5 [UNTESTED] cloud-gate THROWS for EVERY provider in CLOUD_PROVIDERS', async () => {
    const cfg = makeCfg();
    expect(CLOUD_PROVIDERS.length).toBeGreaterThanOrEqual(7);

    for (const id of CLOUD_PROVIDERS) {
      // (a) !allowCloud — uniform --allow-cloud refusal.
      mockGetProviderRegistry.mockResolvedValue(registryWithActive(id));
      await expect(getActiveClient(cfg, { allowCloud: false, provider: id })).rejects.toThrow(
        /Pass --allow-cloud/i,
      );

      // (b) allowCloud but key absent — uniform key-missing refusal. The env var
      // for this id is cleared in beforeEach so the key is provably absent.
      await expect(getActiveClient(cfg, { allowCloud: true, provider: id })).rejects.toThrow(
        new RegExp(`${CLOUD_PROVIDER_ENV[id]} is not set`, 'i'),
      );
    }
  });

  // [STATIC] — the in-test CLOUD_PROVIDERS list mirrors the real source set, so
  // 5.5 cannot silently under-cover a newly-added provider.
  it('5.5 [STATIC] in-test CLOUD_PROVIDERS mirrors provider-client.ts source', () => {
    const src = readSource('core/run/provider-client.ts');
    for (const id of CLOUD_PROVIDERS) {
      expect(src).toContain(`'${id}'`);
    }
    // The source defines the gate + the key map this suite depends on.
    expect(src).toContain('CLOUD_PROVIDERS');
    expect(src).toContain('CLOUD_PROVIDER_ENV');
  });
});

describe('H4 · INV5 LOCAL-FIRST · callers default local', () => {
  beforeEach(() => {
    expect.hasAssertions();
  });

  // 5.6 — the daemon swarm budget defaults allowCloud:false. Asserted [STATIC]
  // against the real daemon source (the literal `allowCloud: false` in the
  // per-item runSwarm budget), so any future flip to true fails CI.
  it('5.6 [STATIC] daemon swarm budget defaults allowCloud:false', () => {
    const loop = stripComments(readSource('core/daemon/loop.ts'));
    expect(loop).toContain('allowCloud: false');
    // And it never hands the daemon swarm allowCloud:true.
    expect(loop).not.toContain('allowCloud: true');
  });

  // Default-local for EVERY LLM caller: each getActiveClient call site defaults
  // allowCloud to false (a literal `false` or `?? false`) — asserted [STATIC] so
  // a future caller that flips a default to cloud fails CI.
  it('5.6b [STATIC] every LLM caller defaults allowCloud=false at the call site', () => {
    // file → the getActiveClient invocation that must default local.
    const callers: Array<{ file: string; needle: RegExp }> = [
      // swarm/planner.ts hard-codes allowCloud: false
      { file: 'core/swarm/planner.ts', needle: /getActiveClient\(cfg,\s*\{\s*allowCloud:\s*false\s*\}\)/ },
      // goals/planner.ts threads opts?.allowCloud ?? false
      { file: 'core/goals/planner.ts', needle: /allowCloud:\s*opts\?\.allowCloud\s*\?\?\s*false/ },
      // playbooks.ts threads opts.allowCloud ?? false
      { file: 'core/learn/playbooks.ts', needle: /allowCloud:\s*opts\.allowCloud\s*\?\?\s*false/ },
      // digest/build.ts threads opts?.allowCloud ?? false
      { file: 'core/digest/build.ts', needle: /allowCloud:\s*opts\?\.allowCloud\s*\?\?\s*false/ },
    ];
    for (const { file, needle } of callers) {
      const src = stripComments(readSource(file));
      expect(src).toMatch(needle);
    }
    // ask.ts requires an explicit allowCloud (no implicit cloud default): its
    // signature takes `allowCloud: boolean` so a caller must opt in — assert the
    // required (non-optional, non-defaulted-true) param shape.
    const ask = stripComments(readSource('core/knowledge/ask.ts'));
    expect(ask).toMatch(/allowCloud:\s*boolean/);
    expect(ask).not.toMatch(/allowCloud\s*=\s*true/);
  });

  // 5.7 [STATIC][UNTESTED] — reflect.ts has NO network: no fetch(, no
  // getActiveClient, no http/https/undici import. Comment-stripped so the
  // doc-comment promise ("No getActiveClient, no fetch") does not false-fail.
  it('5.7 [STATIC][UNTESTED] reflect.ts has NO network (no fetch/getActiveClient/http)', () => {
    const raw = readSource('core/learn/reflect.ts');
    // The promise lives in the doc-comment; after stripping it must be absent.
    expect(containsToken(raw, 'fetch(')).toBe(false);
    expect(containsToken(raw, 'getActiveClient')).toBe(false);

    // No network module is imported (check IMPORT SPECIFIERS, not substrings).
    const imports = importLines(raw);
    for (const net of ['node:http', 'node:https', 'http', 'https', 'undici', 'node-fetch', 'axios']) {
      expect(imports).not.toContain(net);
    }
    // Sanity: the stripped doc-comment really did contain the promise tokens, so
    // this guard is meaningfully scrubbing (not a no-op on an empty file).
    expect(raw).toMatch(/No getActiveClient, no fetch/);
  });
});

// =========================================================================
// INVARIANT 6 — SECRET-SCRUB
// =========================================================================

// Synthetic, well-known-SHAPED secrets (NO real credentials). Each must be
// [REDACTED] before a chunk is stored by index.ts's scrub path.
const SECRET_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpEb2UifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const SECRET_AWS = 'AKIAIOSFODNN7EXAMPLE'; // AKIA + 16 chars (classic AWS test shape)
const SECRET_HEX = 'a'.repeat(40); // ≥32 hex chars
const SECRET_BASE64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5'; // ≥40 base64 chars
const SECRET_APIKEY_ASSIGN = 'api_key = "abcdefghij0123456789ABCDEFGHIJ"'; // assignment-style
const SECRET_PASSWORD_ASSIGN = 'password = "hunter2hunter2"'; // assignment-style
// sk-HYPHEN-prefixed token whose ≥40-char base64 BODY is caught by index.ts's
// base64 pattern (the secret material is redacted; the bare `sk-` prefix leaks).
const SECRET_SK_BODY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'; // 40 base64 chars
const SECRET_SK = `sk-${SECRET_SK_BODY}`;
// Stripe-style bare `sk_live_<underscores>` token. STRENGTHENED BY H6 (PART B.2):
// previously this shape was NOT redacted by index.ts (the underscores break the
// base64 char-class run and it is not hex/JWT/AWS), so the old H4 note documented
// the gap rather than asserting a guard that did not exist. H6 added the pattern
// /\bsk_(live|test)_[A-Za-z0-9_]{16,}\b/g to index.ts's SECRET_PATTERNS, so the
// bare token is now redacted; 6.6 below asserts it (the deliberate H6 flip).
const SECRET_SK_LIVE = 'sk_live_51AbCdEfGhIjKlMnOpQrStUvWx0123456789'; // bare Stripe-style

describe('H4 · INV6 SECRET-SCRUB · index.ts scrub + skip-lists', () => {
  let fx: H1Fixture;
  let repo: DisposableRepo;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    expect.hasAssertions();
    fx = makeFixture();
    // OFFLINE + DETERMINISTIC: reject every fetch so the index path's embedding
    // detect/embed (its ONLY two network calls) degrade to "unavailable" —
    // chunks store as plain SCRUBBED text with zero outward call.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline (test)'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fx.cleanup();
  });

  /** Index `repo` (mocked offline) and return all stored chunk texts joined. */
  async function indexAndLoad(r: DisposableRepo): Promise<string> {
    const cfg = makeCfg() as AshlrConfig;
    await buildKnowledge({ repos: [r.dir], allowCloud: false } as Parameters<typeof buildKnowledge>[0] & {
      allowCloud: boolean;
    });
    void cfg;
    return loadChunks(r.dir)
      .map((c) => c.text)
      .join('\n');
  }

  // 6.1 — index.ts scrubs chunk text BEFORE store. A non-secret file's content
  // survives, while an embedded secret is redacted (proves scrub runs on store).
  it('6.1 index.ts scrubs chunk text before store/embed', async () => {
    repo = fx.makeRepo({
      files: {
        'src/config.ts': `export const NOTE = "harmless";\nconst token = "${SECRET_HEX}";\n`,
      },
    });
    repo.enroll();
    const stored = await indexAndLoad(repo);

    // The non-secret content is retained...
    expect(stored).toContain('harmless');
    // ...but the secret-shaped value is NEVER stored raw.
    expect(stored).not.toContain(SECRET_HEX);
    expect(stored).toContain('[REDACTED]');
    // Determinism check: embeddings were never reached over the network.
    expect(fetchSpy).toHaveBeenCalled(); // detectEmbeddingModel tried + we rejected
  });

  // 6.2 — secret FILENAMES (.env*, *.pem, *.key, *.p12, *.pfx, *.crt, id_rsa, …)
  // are skipped entirely: their content is NEVER read or stored.
  it('6.2 index.ts skips secret FILENAMES (.env / *.pem / *.key / id_rsa / .tfvars)', async () => {
    repo = fx.makeRepo({
      files: {
        '.env': `SECRET_TOKEN=${SECRET_HEX}\n`,
        '.env.production': `PROD_TOKEN=${SECRET_AWS}\n`,
        'server.pem': `-----BEGIN KEY-----\n${SECRET_BASE64}\n-----END KEY-----\n`,
        'app.key': `${SECRET_HEX}\n`,
        'vault.tfvars': `password = "${SECRET_HEX}"\n`,
        'id_rsa': `${SECRET_BASE64}\n`,
        // a normal file so the index is non-empty
        'src/app.ts': `export const X = 1;\n`,
      },
    });
    repo.enroll();
    const stored = await indexAndLoad(repo);

    // The normal file IS indexed; the secret FILES are entirely absent (skipped,
    // never read) — so neither their raw secrets nor even a [REDACTED] from them
    // appears keyed off those filenames.
    expect(stored).toContain('export const X = 1;');
    for (const secret of [SECRET_HEX, SECRET_AWS, SECRET_BASE64]) {
      expect(stored).not.toContain(secret);
    }
    // The chunk citations never reference a skipped secret file.
    const cited = loadChunks(repo.dir).map((c) => c.file);
    for (const skipped of ['.env', '.env.production', 'server.pem', 'app.key', 'vault.tfvars', 'id_rsa']) {
      expect(cited).not.toContain(skipped);
    }
  });

  // 6.3 — secret BASENAMES (SECRET_FILES: secrets.json, credentials.json,
  // service-account.json, .npmrc, .netrc, …) are skipped outright.
  it('6.3 index.ts skips secret BASENAMES (secrets.json / credentials.json / .npmrc / .netrc)', async () => {
    repo = fx.makeRepo({
      files: {
        'secrets.json': `{"token":"${SECRET_HEX}"}\n`,
        'credentials.json': `{"aws":"${SECRET_AWS}"}\n`,
        'service-account.json': `{"private_key":"${SECRET_BASE64}"}\n`,
        '.npmrc': `//registry.npmjs.org/:_authToken=${SECRET_HEX}\n`,
        '.netrc': `password ${SECRET_HEX}\n`,
        'src/keep.ts': `export const KEEP = 2;\n`,
      },
    });
    repo.enroll();
    const stored = await indexAndLoad(repo);

    expect(stored).toContain('export const KEEP = 2;');
    for (const secret of [SECRET_HEX, SECRET_AWS, SECRET_BASE64]) {
      expect(stored).not.toContain(secret);
    }
    const cited = loadChunks(repo.dir).map((c) => c.file);
    for (const skipped of ['secrets.json', 'credentials.json', 'service-account.json', '.npmrc', '.netrc']) {
      expect(cited).not.toContain(skipped);
    }
  });

  // 6.6 [UNTESTED] — specific secret SHAPES embedded in an INDEXED (non-secret)
  // file are each redacted to [REDACTED]; the raw value never survives into the
  // stored chunk. JWT / AWS AKIA / long hex / long base64 / api-key=value /
  // password=value / sk-token.
  it('6.6 [UNTESTED] specific patterns redacted: JWT / AWS / hex / base64 / api-key / sk-', async () => {
    repo = fx.makeRepo({
      files: {
        // A regular source file (NOT a secret filename) so it IS indexed, with
        // each secret shape on its own line so chunking/scrub is unambiguous.
        'src/leaky.ts': [
          '// deliberately leaky source for the scrub regression',
          `const jwt = "${SECRET_JWT}";`,
          `const aws = "${SECRET_AWS}";`,
          `const hex = "${SECRET_HEX}";`,
          `const blob = "${SECRET_BASE64}";`,
          `const ${SECRET_APIKEY_ASSIGN};`,
          `const ${SECRET_PASSWORD_ASSIGN};`,
          `const sk = "${SECRET_SK}";`,
          `const skLive = "${SECRET_SK_LIVE}";`, // [strengthened by H6 §B.2]
          'export const SAFE = "keep-me";',
          '',
        ].join('\n'),
      },
    });
    repo.enroll();
    const stored = await indexAndLoad(repo);

    // Non-secret marker survives so we know the file WAS indexed.
    expect(stored).toContain('keep-me');

    // EACH raw secret value is gone.
    for (const raw of [
      SECRET_JWT,
      SECRET_AWS,
      SECRET_HEX,
      SECRET_BASE64,
      'abcdefghij0123456789ABCDEFGHIJ', // the api_key value
      'hunter2hunter2', // the password value
      SECRET_SK,
      SECRET_SK_LIVE, // bare Stripe sk_live_ token — now redacted [strengthened by H6 §B.2]
    ]) {
      expect(stored).not.toContain(raw);
    }
    // And the redaction marker is present (scrub fired).
    expect(stored).toContain('[REDACTED]');
  });
});

describe('H4 · INV6 SECRET-SCRUB · index ↔ graph parity + FINDING', () => {
  beforeEach(() => {
    expect.hasAssertions();
  });

  /**
   * Exercise graph.ts's REAL scrub. STRENGTHENED BY H6 (PART B.1): graph.ts no
   * longer carries a private `const SECRET_PATTERN = /…/` regex — its module-
   * private `scrubSecrets` now DELEGATES to index.ts's exported `scrubSecrets`
   * over the shared `SECRET_PATTERNS` array, so the two are at PARITY (the H4
   * §6.8 FINDING is now CLOSED). We faithfully reproduce graph's behavior by
   * invoking the same shared `scrubSecrets` graph delegates to, and statically
   * pin that graph.ts actually imports it from index.js so a future divergence
   * (e.g. graph re-introducing a weaker private regex) is caught.
   */
  function graphScrub(text: string): string {
    const src = readSource('core/knowledge/graph.ts');
    // graph.ts must import the shared scrub from index.js (parity guarantee).
    expect(src).toMatch(
      /import\s*\{[^}]*\bSECRET_PATTERNS\b[^}]*\bscrubSecrets\b[^}]*\}\s*from\s*['"]\.\/index\.js['"]/,
    );
    // graph's module-private scrubSecrets delegates to the shared parity scrub.
    return scrubSecrets(text);
  }

  // 6.4 — graph.ts scrubs detail via scrubSecrets before emit ([STATIC] presence
  // of the call at the crossRepo `detail` site).
  it('6.4 graph.ts scrubs detail via scrubSecrets before emit', () => {
    const src = stripComments(readSource('core/knowledge/graph.ts'));
    expect(src).toContain('detail: scrubSecrets(');
    expect(src).toContain('function scrubSecrets(');
  });

  // 6.5 — graph.ts skips secret files via shouldSkipFile / SECRET_FILES
  // ([STATIC] presence; the same basename set as index.ts).
  it('6.5 graph.ts skips secret files (shouldSkipFile / SECRET_FILES)', () => {
    const src = stripComments(readSource('core/knowledge/graph.ts'));
    expect(src).toContain('SECRET_FILES');
    expect(src).toMatch(/if\s*\(\s*SECRET_FILES\.has\(base\)\s*\)\s*return true/);
    // The skip-list covers the headline secret files.
    for (const f of ['.env', 'credentials.json', 'secrets.json', '.npmrc', '.netrc']) {
      expect(src).toContain(`'${f}'`);
    }
  });

  // 6.7 — assignment-style secrets (api_key / password / token) are redacted by
  // BOTH impls. index.ts asserted via its REAL stored-chunk path (above, 6.6);
  // here graph.ts's REAL regex is reconstructed from source and exercised over
  // the OVERLAP set.
  it('6.7 assignment-style secrets redacted by BOTH impls (overlap set)', () => {
    for (const assign of [
      'api_key = "abcdefghij0123456789ABCDEFGHIJ"',
      'password = "hunter2hunter2"',
      'auth_token: "abcdef0123456789abcdef0123456789"',
    ]) {
      const scrubbed = graphScrub(assign);
      expect(scrubbed).toContain('[REDACTED]');
      // The raw value never survives graph's scrub.
      expect(scrubbed).not.toMatch(/hunter2hunter2|abcdefghij0123456789ABCDEFGHIJ|abcdef0123456789abcdef0123456789/);
    }
  });

  // 6.8 [STATIC] — index.ts ↔ graph.ts scrub PARITY (FINDING now CLOSED).
  //
  // STRENGTHENED BY H6 (PART B.1): the prior H4 §6.8 FINDING was that graph.ts's
  // single assignment-style regex MISSED bare JWT / AKIA / base64 / hex blobs,
  // making it the WEAKER impl. H6 closed that gap — graph.ts now DELEGATES to
  // index.ts's exported `scrubSecrets` over the shared `SECRET_PATTERNS` array,
  // so the two redact the IDENTICAL shapes. This test was DELIBERATELY FLIPPED
  // (CONTRACT-H6 §B.4): the three behavioral assertions below previously pinned
  // `.toContain` (secret SURVIVES); they now assert `.not.toContain` (secret IS
  // redacted). This is the intended guard-STRENGTHENING, not a regression.
  it('6.8 [STATIC] index ↔ graph scrub PARITY (bare blobs redacted by BOTH) [strengthened by H6]', () => {
    const indexSrc = readSource('core/knowledge/index.ts');
    const graphSrc = readSource('core/knowledge/graph.ts');

    // PARITY — both files define a scrub function + the assignment-style coverage.
    expect(indexSrc).toContain('function scrubSecrets(');
    expect(graphSrc).toContain('function scrubSecrets(');

    // index.ts demonstrably carries the HIGH-ENTROPY patterns.
    expect(indexSrc).toMatch(/AKIA/); // AWS access key
    expect(indexSrc).toMatch(/eyJ/); // JWT prefix
    expect(indexSrc).toMatch(/\[0-9a-f\]\{32,\}/); // long hex
    expect(indexSrc).toMatch(/\{40,\}/); // long base64

    // PARITY (strengthened by H6) — graph.ts no longer keeps a private weaker
    // regex; it IMPORTS the shared SECRET_PATTERNS + scrubSecrets from index.js
    // and uses them at the `detail:` emit site. Assert the import + delegation so
    // a future re-introduction of a divergent private pattern fails this test.
    expect(graphSrc).toMatch(
      /import\s*\{[^}]*\bSECRET_PATTERNS\b[^}]*\bscrubSecrets\b[^}]*\}\s*from\s*['"]\.\/index\.js['"]/,
    );

    // BEHAVIORAL proof of PARITY: graph's REAL (now-shared) scrub REDACTS a bare
    // JWT / AKIA / base64 blob — the exact cases it formerly MISSED (this is the
    // deliberate H6 flip; previously these asserted `.toContain`).
    expect(graphScrub(SECRET_JWT)).not.toContain(SECRET_JWT); // graph now redacts bare JWT
    expect(graphScrub(SECRET_AWS)).not.toContain(SECRET_AWS); // graph now redacts bare AKIA
    expect(graphScrub(SECRET_BASE64)).not.toContain(SECRET_BASE64); // graph now redacts bare blob
    // …and the redaction marker is present (the shared scrub fired).
    expect(graphScrub(SECRET_JWT)).toContain('[REDACTED]');
  });
});
