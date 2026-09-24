/**
 * V3.10 Track B unit U2 — custody client (src/core/authority/custody-client.ts).
 *
 * The helper itself is exercised by `swift test` (tools/custody) and by the
 * darwin e2e in custody-helper-contract-310b.test.ts. Here the helper is an
 * in-process fake behind the runner seam, so every assertion is about what the
 * CLIENT accepts: it must never trust a helper that is not root-owned, never
 * accept a grant other than the one requested or one that does not verify,
 * never accept a malformed token, and never echo a secret.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CUSTODY_DATA_DIR_RELATIVE,
  CUSTODY_HELPER_PATH,
  CustodyError,
  claudeToken,
  custodyDataDir,
  custodyHelperInstallProblem,
  custodyInit,
  custodyPublicKey,
  custodyStatus,
  githubToken,
  keyIdForPublicKeyPem,
  signGrant,
  storeClaudeToken,
  storeGithubApp,
  _setCustodyRunnerForTest,
  type CustodyRunRequest,
  type CustodyRunResult,
} from '../src/core/authority/custody-client.js';
import { canonicalJson } from '../src/core/authority/canonical-json.js';
import { STANDING_GRANT_SIGNING_DOMAIN, type StandingGrantV1 } from '../src/core/authority/types.js';

type Handler = (req: CustodyRunRequest) => Partial<CustodyRunResult> | Promise<Partial<CustodyRunResult>>;

function install(handler: Handler): CustodyRunRequest[] {
  const calls: CustodyRunRequest[] = [];
  _setCustodyRunnerForTest(async (req) => {
    calls.push(req);
    const r = await handler(req);
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...r };
  });
  return calls;
}

const ok = (value: unknown): Partial<CustodyRunResult> => ({ code: 0, stdout: `${JSON.stringify(value)}\n` });
const refuse = (code: string, message: string, exit = 3): Partial<CustodyRunResult> => ({
  code: exit,
  stderr: `some human text\n${JSON.stringify({ error: { code, message } })}\n`,
});

afterEach(() => _setCustodyRunnerForTest(null));

function p256(): { publicKey: KeyObject; privateKey: KeyObject; pem: string; keyId: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { publicKey, privateKey, pem, keyId: keyIdForPublicKeyPem(pem) };
}

function grant(keyId: string): StandingGrantV1 {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(
    '../tools/custody/Tests/CustodyCoreTests/Fixtures/standing-grant-fixture.json', import.meta.url)), 'utf8')) as { payload: StandingGrantV1 };
  return { ...fixture.payload, keyId };
}

describe('helper install trust (root-owned or nothing)', () => {
  it('names the canonical install path and the custody data dir', () => {
    expect(CUSTODY_HELPER_PATH).toBe('/usr/local/libexec/ashlr-custody');
    expect(custodyDataDir('/Users/x')).toBe(`/Users/x/${CUSTODY_DATA_DIR_RELATIVE}`);
    expect(CUSTODY_DATA_DIR_RELATIVE).toBe('Library/Application Support/ashlr-custody');
  });

  it('refuses a missing, user-owned or symlinked helper', () => {
    const dir = mkdtempSync(join(tmpdir(), 'custody-install-'));
    expect(custodyHelperInstallProblem(join(dir, 'absent'))).toMatch(/not installed/);
    const userOwned = join(dir, 'ashlr-custody');
    writeFileSync(userOwned, '#!/bin/sh\n', { mode: 0o755 });
    expect(custodyHelperInstallProblem(userOwned)).toMatch(/not owned by root/);
    const link = join(dir, 'link');
    symlinkSync('/usr/bin/true', link);
    expect(custodyHelperInstallProblem(link)).toMatch(/not a regular file/);
  });

  it('accepts a root-owned binary in root-owned directories (the OS provides one)', () => {
    // /usr/bin/true is root:wheel 0755 inside /usr/bin, /usr, / — the same shape Phase 0 installs.
    expect(custodyHelperInstallProblem('/usr/bin/true')).toBeNull();
  });

  it('never reads the helper path (or anything else) from the environment', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/core/authority/custody-client.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/operator-private-key/);
  });
});

describe('custodyStatus — a probe that never throws', () => {
  it('reports an uninstalled helper honestly (null = unknown)', async () => {
    install(() => refuse('not-installed', `ashlr-custody is not installed at ${CUSTODY_HELPER_PATH}`, 1));
    const status = await custodyStatus();
    expect(status).toMatchObject({ installed: false, version: null, keyInitialized: null, keyId: null, githubApp: null, claudeToken: null });
    expect(status.reasons[0]).toMatch(/not installed/);
  });

  it('maps the helper status and explains every missing piece', async () => {
    install(() => ok({ v: 1, version: '1.0.0', secureEnclave: true, keyInitialized: false, keyId: null, githubApp: false, claudeToken: true }));
    const status = await custodyStatus();
    expect(status).toMatchObject({ installed: true, version: '1.0.0', keyInitialized: false, githubApp: false, claudeToken: true });
    expect(status.reasons.join(' ')).toMatch(/ashlr-custody init/);
    expect(status.reasons.join(' ')).toMatch(/github-app/);
    expect(status.reasons.join(' ')).not.toMatch(/Claude token/);
  });

  it('treats malformed helper output as unknown, not as healthy', async () => {
    install(() => ok({ v: 1, version: '1.0.0', keyInitialized: true, extra: 1 }));
    const status = await custodyStatus();
    expect(status.installed).toBe(true);
    expect(status.keyInitialized).toBeNull();
    expect(status.reasons[0]).toMatch(/returned keys/);
  });

  it('caches for a few seconds (the Command surface polls it)', async () => {
    const calls = install(() => ok({ v: 1, version: '1.0.0', secureEnclave: true, keyInitialized: true, keyId: 'se-p256-0123456789abcdef', githubApp: true, claudeToken: true }));
    await custodyStatus();
    await custodyStatus();
    expect(calls).toHaveLength(1);
  });
});

describe('key info', () => {
  it('accepts a key only when its id is derived from its public key', async () => {
    const key = p256();
    install(() => ok({ keyId: key.keyId, publicKeyPem: key.pem }));
    await expect(custodyPublicKey()).resolves.toEqual({ keyId: key.keyId, publicKeyPem: key.pem });
    expect(key.keyId).toMatch(/^se-p256-[0-9a-f]{16}$/);
    install(() => ok({ keyId: 'se-p256-0000000000000000', publicKeyPem: key.pem }));
    await expect(custodyInit()).rejects.toMatchObject({ code: 'bad-output' });
  });

  it('refuses a non-P-256 key', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    install(() => ok({ keyId: 'se-p256-0000000000000000', publicKeyPem: pem }));
    await expect(custodyPublicKey()).rejects.toMatchObject({ code: 'bad-output' });
  });
});

describe('signGrant — only the requested grant, only a verifying signature', () => {
  function signingHelper(key: ReturnType<typeof p256>, mutate?: (payload: Record<string, unknown>) => void): CustodyRunRequest[] {
    return install((req) => {
      if (req.args[0] === 'pubkey') return ok({ keyId: key.keyId, publicKeyPem: key.pem });
      if (req.args[0] === 'sign-grant') {
        const payload = JSON.parse(req.input ?? 'null') as Record<string, unknown>;
        mutate?.(payload);
        const bytes = Buffer.from(`${STANDING_GRANT_SIGNING_DOMAIN}${canonicalJson(payload)}`, 'utf8');
        const signature = sign('sha256', bytes, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
        return ok({ payload, signature });
      }
      return refuse('usage', 'unexpected');
    });
  }

  it('sends the canonical payload on stdin (never argv) and returns a verified envelope', async () => {
    const key = p256();
    const calls = signingHelper(key);
    const g = grant(key.keyId);
    const signed = await signGrant(g);
    expect(signed.payload).toEqual(g);
    expect(signed.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    const signCall = calls.find((c) => c.args[0] === 'sign-grant')!;
    expect(signCall.args).toEqual(['sign-grant', '-']);
    expect(signCall.input).toBe(canonicalJson(g));
    expect(signCall.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('refuses a helper that signed a different payload', async () => {
    const key = p256();
    signingHelper(key, (payload) => { (payload['merge'] as Record<string, number>)['maxFiles'] = 3; });
    await expect(signGrant(grant(key.keyId))).rejects.toMatchObject({ code: 'signature-mismatch' });
  });

  it('refuses a signature that does not verify against the helper key', async () => {
    const key = p256();
    const other = p256();
    install((req) => {
      if (req.args[0] === 'pubkey') return ok({ keyId: key.keyId, publicKeyPem: key.pem });
      const payload = JSON.parse(req.input!) as Record<string, unknown>;
      const bytes = Buffer.from(`${STANDING_GRANT_SIGNING_DOMAIN}${canonicalJson(payload)}`, 'utf8');
      return ok({ payload, signature: sign('sha256', bytes, { key: other.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') });
    });
    await expect(signGrant(grant(key.keyId))).rejects.toMatchObject({ code: 'signature-mismatch' });
  });

  it('stops before any Touch ID when the grant names another key', async () => {
    const key = p256();
    const calls = signingHelper(key);
    await expect(signGrant(grant('se-p256-ffffffffffffffff'))).rejects.toMatchObject({ code: 'keyid-mismatch' });
    expect(calls.map((c) => c.args[0])).toEqual(['pubkey']);
  });

  it('surfaces helper refusals, cancellations and timeouts as typed errors', async () => {
    const key = p256();
    install((req) => (req.args[0] === 'pubkey'
      ? ok({ keyId: key.keyId, publicKeyPem: key.pem })
      : refuse('refused', 'not signed — merge.maxFiles: 11 is outside 1…10')));
    const refusal = await signGrant(grant(key.keyId)).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(CustodyError);
    expect(refusal).toMatchObject({ code: 'refused', message: expect.stringContaining('merge.maxFiles') });

    install((req) => (req.args[0] === 'pubkey' ? ok({ keyId: key.keyId, publicKeyPem: key.pem }) : refuse('auth-cancelled', 'Touch ID was cancelled', 5)));
    await expect(signGrant(grant(key.keyId))).rejects.toMatchObject({ code: 'auth-cancelled' });

    install((req) => (req.args[0] === 'pubkey' ? ok({ keyId: key.keyId, publicKeyPem: key.pem }) : { code: null, timedOut: true }));
    await expect(signGrant(grant(key.keyId))).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects multi-line or non-JSON helper output', async () => {
    const key = p256();
    install((req) => (req.args[0] === 'pubkey' ? { code: 0, stdout: 'hello\nworld\n' } : ok({})));
    await expect(signGrant(grant(key.keyId))).rejects.toMatchObject({ code: 'bad-output' });
  });
});

describe('tokens — shape-checked, cached in memory, never echoed', () => {
  const ghs = `ghs_${'A1b2C3d4'.repeat(5)}`;

  it('mints a one-repo GitHub token once per hour window and dedupes concurrent callers', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const calls = install(async (req) => {
      await new Promise((r) => setTimeout(r, 5));
      expect(req.args).toEqual(['gh-token', '--repo', 'ashlrai/fleet-canary']);
      return ok({ token: ghs, expiresAt });
    });
    const [a, b] = await Promise.all([githubToken('ashlrai/fleet-canary'), githubToken('ashlrai/fleet-canary')]);
    expect(a).toEqual({ token: ghs, expiresAt });
    expect(b).toEqual(a);
    await githubToken('ashlrai/fleet-canary');
    expect(calls).toHaveLength(1);
  });

  it('refuses bad repos, token shapes and expiries without leaking the value', async () => {
    await expect(githubToken('not a repo')).rejects.toMatchObject({ code: 'refused' });
    install(() => ok({ token: 'gho_personalTokenThatMustNeverBeUsed123456', expiresAt: new Date(Date.now() + 3_000_000).toISOString() }));
    const wrong = await githubToken('ashlrai/x').catch((e: unknown) => e as Error);
    expect(wrong).toMatchObject({ code: 'bad-output' });
    expect(String((wrong as Error).message)).not.toContain('gho_');
    install(() => ok({ token: ghs, expiresAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString() }));
    await expect(githubToken('ashlrai/y')).rejects.toMatchObject({ code: 'bad-output' });
    install(() => ok({ token: ghs, expiresAt: 'tomorrow' }));
    await expect(githubToken('ashlrai/z')).rejects.toMatchObject({ code: 'bad-output' });
  });

  it('scrubs helper error text before showing it', async () => {
    install(() => refuse('github', `GitHub token request failed with HTTP 422: token ${ghs} rejected`, 7));
    const error = await githubToken('ashlrai/fleet-canary').catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: 'github' });
    expect(error.message).not.toContain(ghs);
  });

  it('returns the Claude token only when it is one opaque line', async () => {
    install(() => ok({ token: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz', expiresAt: null }));
    await expect(claudeToken()).resolves.toEqual({ token: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz', expiresAt: null });
    install(() => ok({ token: 'two words here and more words', expiresAt: null }));
    await expect(claudeToken()).rejects.toMatchObject({ code: 'bad-output' });
  });
});

describe('storing credentials — stdin only, validated before the helper sees them', () => {
  it('stores an RSA App key as JSON on stdin', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const calls = install(() => ok({ ok: true, appId: '424242' }));
    await storeGithubApp({ appId: '424242', privateKeyPem: pem });
    expect(calls[0]!.args).toEqual(['store-github-app']);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ appId: '424242', privateKeyPem: pem });
    expect(calls[0]!.args.join(' ')).not.toContain('PRIVATE KEY');
  });

  it('refuses a non-RSA key, a non-numeric app id and a short token before calling the helper', async () => {
    const calls = install(() => ok({ ok: true }));
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await expect(storeGithubApp({ appId: '1', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }))
      .rejects.toMatchObject({ code: 'refused' });
    await expect(storeGithubApp({ appId: 'abc', privateKeyPem: 'x' })).rejects.toMatchObject({ code: 'refused' });
    await expect(storeClaudeToken('short')).rejects.toMatchObject({ code: 'refused' });
    expect(calls).toHaveLength(0);
  });

  it('sends the Claude token on stdin', async () => {
    const calls = install(() => ok({ ok: true }));
    await storeClaudeToken('  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz\n');
    expect(calls[0]!.args).toEqual(['store-claude-token']);
    expect(calls[0]!.input).toBe('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz\n');
  });
});

describe('the helper data dir is under HOME', () => {
  it('lives where the sandbox denials expect it', () => {
    const home = mkdtempSync(join(tmpdir(), 'custody-home-'));
    mkdirSync(custodyDataDir(home), { recursive: true });
    expect(custodyDataDir(home).startsWith(home)).toBe(true);
  });
});
