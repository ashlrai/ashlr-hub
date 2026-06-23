/**
 * M17 sign tests — hermetic; real node:crypto; tmp HOME.
 *
 * Covers:
 *   - ensureLocalKey: creates the key file 0600 on first call
 *   - ensureLocalKey: reuses the same key on second call (idempotent)
 *   - ensureLocalKey: key file mode is 0600 (never world-readable)
 *   - ensureLocalKey: key contents are never logged/printed (not console.log'd)
 *   - signOutput / verifyOutput: round-trip succeeds on identical content
 *   - verifyOutput: returns false (never throws) on tampered content
 *   - verifyOutput: returns false on empty content vs signed non-empty
 *   - OutputSignature: contains only hex hashes — never the raw key
 *   - signOutput: alg is 'hmac-sha256' (phantom absent)
 *   - signOutput: signer is 'local' (phantom absent)
 *   - signOutput: ts is a valid ISO string
 *   - signOutput: hash is the sha256 hex of the content
 *   - verifyOutput: returns false on malformed/missing signature fields
 *   - verifyOutput: returns false when sig.sig is corrupted
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Hermetic HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env['HOME'];
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m17-sign-'));
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (origHome === undefined) {
    delete process.env['HOME'];
  } else {
    process.env['HOME'] = origHome;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Lazy import helpers (HOME must be set before import resolves homedir())
// ---------------------------------------------------------------------------

type SignModule = {
  ensureLocalKey: () => string;
  signOutput: (content: string, cfg: AshlrConfigMin) => OutputSignatureMin;
  verifyOutput: (content: string, sig: OutputSignatureMin, cfg: AshlrConfigMin) => boolean;
};

type AshlrConfigMin = Record<string, unknown>;

interface OutputSignatureMin {
  alg: string;
  hash: string;
  sig: string;
  signer: string;
  ts: string;
}

let _mod: SignModule | null = null;

async function getSignModule(): Promise<SignModule> {
  if (!_mod) {
    // Dynamic import: vitest resolves from project root
    _mod = (await import('../src/core/swarm/sign.js')) as SignModule;
  }
  return _mod;
}

function makeConfig(): AshlrConfigMin {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  };
}

// ---------------------------------------------------------------------------
// ensureLocalKey
// ---------------------------------------------------------------------------

describe('ensureLocalKey — creates + reuses local key', () => {
  it('returns a string path ending in swarm.key', async () => {
    const { ensureLocalKey } = await getSignModule();
    const p = ensureLocalKey();
    expect(typeof p).toBe('string');
    expect(p.endsWith('swarm.key')).toBe(true);
  });

  it('creates the key file under <HOME>/.ashlr/keys/', async () => {
    const { ensureLocalKey } = await getSignModule();
    const p = ensureLocalKey();
    expect(fs.existsSync(p)).toBe(true);
    expect(p).toContain(path.join('.ashlr', 'keys'));
  });

  it('key file has mode 0600 (not world/group readable)', async () => {
    const { ensureLocalKey } = await getSignModule();
    const p = ensureLocalKey();
    const st = fs.statSync(p);
    // Windows has no POSIX permission bits — st.mode reflects 0o666 there, so
    // skip the mode assertion on win32 and only enforce 0o600 on POSIX.
    if (process.platform === 'win32') {
      expect(fs.existsSync(p)).toBe(true);
      return;
    }
    // On POSIX: mode & 0o777 should be 0o600
    const mode = st.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('key file is non-empty (has content)', async () => {
    const { ensureLocalKey } = await getSignModule();
    const p = ensureLocalKey();
    const content = fs.readFileSync(p, 'utf8');
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it('is idempotent — returns same path + same key on second call', async () => {
    const { ensureLocalKey } = await getSignModule();
    const p1 = ensureLocalKey();
    const key1 = fs.readFileSync(p1, 'utf8');
    const p2 = ensureLocalKey();
    const key2 = fs.readFileSync(p2, 'utf8');
    expect(p1).toBe(p2);
    expect(key1).toBe(key2);
  });

  it('does NOT log the key to console', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spyErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ensureLocalKey } = await getSignModule();
    const p = ensureLocalKey();
    const keyContent = fs.readFileSync(p, 'utf8').trim();
    // None of the console.* calls should include the raw key value
    for (const call of [...spy.mock.calls, ...spyErr.mock.calls, ...spyWarn.mock.calls]) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(keyContent);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// signOutput / verifyOutput round-trip
// ---------------------------------------------------------------------------

describe('signOutput + verifyOutput — round-trip', () => {
  it('verifyOutput returns true for just-signed content', async () => {
    const { signOutput, verifyOutput } = await getSignModule();
    const cfg = makeConfig();
    const content = 'hello world result';
    const sig = signOutput(content, cfg);
    expect(verifyOutput(content, sig, cfg)).toBe(true);
  });

  it('verifyOutput returns false on tampered content (one char changed)', async () => {
    const { signOutput, verifyOutput } = await getSignModule();
    const cfg = makeConfig();
    const content = 'original task result';
    const sig = signOutput(content, cfg);
    const tampered = content.replace('original', 'modified');
    expect(verifyOutput(tampered, sig, cfg)).toBe(false);
  });

  it('verifyOutput returns false when content is empty but was signed non-empty', async () => {
    const { signOutput, verifyOutput } = await getSignModule();
    const cfg = makeConfig();
    const sig = signOutput('non-empty content', cfg);
    expect(verifyOutput('', sig, cfg)).toBe(false);
  });

  it('verifyOutput returns false when content has appended chars', async () => {
    const { signOutput, verifyOutput } = await getSignModule();
    const cfg = makeConfig();
    const content = 'task result here';
    const sig = signOutput(content, cfg);
    expect(verifyOutput(content + ' extra', sig, cfg)).toBe(false);
  });

  it('verifyOutput returns false when sig.sig is zeroed/corrupted', async () => {
    const { signOutput, verifyOutput } = await getSignModule();
    const cfg = makeConfig();
    const content = 'some result';
    const sig = signOutput(content, cfg);
    const corrupted = { ...sig, sig: 'a'.repeat(sig.sig.length) };
    expect(verifyOutput(content, corrupted, cfg)).toBe(false);
  });

  it('verifyOutput returns false when sig.hash is corrupted', async () => {
    const { signOutput, verifyOutput } = await getSignModule();
    const cfg = makeConfig();
    const content = 'another result';
    const sig = signOutput(content, cfg);
    const corrupted = { ...sig, hash: 'b'.repeat(sig.hash.length) };
    expect(verifyOutput(content, corrupted, cfg)).toBe(false);
  });

  it('verifyOutput returns false on malformed sig (empty strings)', async () => {
    const { verifyOutput } = await getSignModule();
    const cfg = makeConfig();
    const badSig: OutputSignatureMin = { alg: 'hmac-sha256', hash: '', sig: '', signer: 'local', ts: new Date().toISOString() };
    expect(verifyOutput('anything', badSig, cfg)).toBe(false);
  });

  it('verifyOutput never throws — returns false on completely invalid sig object', async () => {
    const { verifyOutput } = await getSignModule();
    const cfg = makeConfig();
    // Pass a sig object with wrong fields
    const badSig = { alg: 'hmac-sha256', hash: 'notvalidhex!!!', sig: 'notatallvalid', signer: 'local', ts: 'bad' } as OutputSignatureMin;
    expect(() => verifyOutput('content', badSig, cfg)).not.toThrow();
    expect(verifyOutput('content', badSig, cfg)).toBe(false);
  });

  it('verifyOutput is consistent: same content+sig always returns same result', async () => {
    const { signOutput, verifyOutput } = await getSignModule();
    const cfg = makeConfig();
    const content = 'deterministic check';
    const sig = signOutput(content, cfg);
    expect(verifyOutput(content, sig, cfg)).toBe(true);
    expect(verifyOutput(content, sig, cfg)).toBe(true);
    expect(verifyOutput(content, sig, cfg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OutputSignature shape — no secrets, only hashes
// ---------------------------------------------------------------------------

describe('OutputSignature — structure and no-secrets invariants', () => {
  it('alg is "hmac-sha256" when phantom is absent', async () => {
    const { signOutput } = await getSignModule();
    const sig = signOutput('content', makeConfig());
    expect(sig.alg).toBe('hmac-sha256');
  });

  it('signer is "local" when phantom is absent', async () => {
    const { signOutput } = await getSignModule();
    const sig = signOutput('content', makeConfig());
    expect(sig.signer).toBe('local');
  });

  it('ts is a valid ISO string', async () => {
    const { signOutput } = await getSignModule();
    const sig = signOutput('content', makeConfig());
    const d = new Date(sig.ts);
    expect(d.toISOString()).toBe(sig.ts);
  });

  it('hash matches sha256 hex of the content', async () => {
    const { signOutput } = await getSignModule();
    const content = 'check hash field';
    const sig = signOutput(content, makeConfig());
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    expect(sig.hash).toBe(expected);
  });

  it('hash and sig are hex strings (no binary/base64)', async () => {
    const { signOutput } = await getSignModule();
    const sig = signOutput('hex check content', makeConfig());
    expect(sig.hash).toMatch(/^[0-9a-f]+$/i);
    expect(sig.sig).toMatch(/^[0-9a-f]+$/i);
  });

  it('signature does not contain the raw key value', async () => {
    const { signOutput, ensureLocalKey } = await getSignModule();
    const keyPath = ensureLocalKey();
    const rawKey = fs.readFileSync(keyPath, 'utf8').trim();
    const sig = signOutput('content to sign', makeConfig());
    // No field in the signature should equal or contain the raw key
    for (const val of [sig.hash, sig.sig, sig.signer, sig.ts, sig.alg]) {
      expect(val).not.toContain(rawKey);
    }
  });

  it('two different contents produce different hash values', async () => {
    const { signOutput } = await getSignModule();
    const cfg = makeConfig();
    const s1 = signOutput('content A', cfg);
    const s2 = signOutput('content B', cfg);
    expect(s1.hash).not.toBe(s2.hash);
  });

  it('two different contents produce different sig values', async () => {
    const { signOutput } = await getSignModule();
    const cfg = makeConfig();
    const s1 = signOutput('content A', cfg);
    const s2 = signOutput('content B', cfg);
    expect(s1.sig).not.toBe(s2.sig);
  });
});
