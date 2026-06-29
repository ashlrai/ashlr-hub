/**
 * M230 — claude/codex auth passthrough invariant.
 *
 * Root cause of M230: `buildContainedEnv` stripped USER and LOGNAME from the
 * subprocess environment. On macOS, the Security framework uses USER/LOGNAME to
 * locate the login keychain (~/Library/Keychains/login.keychain-db). Without
 * them the `claude` CLI fails with "Not logged in · Please run /login" even
 * though HOME is set and ~/.claude exists.
 *
 * Fix: buildContainedEnv now passes USER + LOGNAME from process.env (identity
 * vars — the OS username, not a credential). This does NOT weaken the no-push /
 * no-exfil boundary: the git-push severing (GIT_TERMINAL_PROMPT, pre-push hook,
 * no SSH_AUTH_SOCK) is entirely orthogonal to the username.
 *
 * Tests (all hermetic — no real claude/codex spawn, no network):
 *   1. USER and LOGNAME are present in buildContainedEnv output when set in
 *      process.env.
 *   2. USER and LOGNAME are absent (not injected as blanks) when process.env
 *      lacks them — correct on platforms where they may be absent.
 *   3. The security boundary is intact: credential-shaped vars (FAKE_API_KEY,
 *      GH_TOKEN, MY_SECRET) are still stripped, SSH_AUTH_SOCK is still deleted,
 *      GIT_TERMINAL_PROMPT is still '0', and the pre-push blocker hooks-path is
 *      still wired.
 *   4. ADVERSARIAL: the contained env passes a username that is NOT a secret —
 *      specifically, it does NOT expose SSH_AUTH_SOCK (push credential) or any
 *      API key even when USER and LOGNAME are present.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { buildContainedEnv } from '../src/core/run/sandboxed-engine.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<AshlrConfig> = {}): AshlrConfig {
  return {
    version: 1,
    roots: ['/home/u/Desktop/github'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
    ...over,
  } as AshlrConfig;
}

const HOOKS_DIR = '/tmp/ashlr-m230-hooks-test';

/** Credential-shaped env var pattern that must NEVER survive into the contained env. */
const CRED_KEY_RE = /(_|^)(TOKEN|SECRET|KEY|PAT|PASSWORD|PASSWD|CREDENTIALS?|API[_-]?KEY|OAUTH[_-]?TOKEN|CREDS?)$/i;

// ---------------------------------------------------------------------------
// Saved process.env slots we mutate in tests
// ---------------------------------------------------------------------------

let savedUser: string | undefined;
let savedLogname: string | undefined;
let savedSshAuthSock: string | undefined;
let savedFakeApiKey: string | undefined;
let savedGhToken: string | undefined;
let savedMySecret: string | undefined;

beforeEach(() => {
  savedUser = process.env.USER;
  savedLogname = process.env.LOGNAME;
  savedSshAuthSock = process.env.SSH_AUTH_SOCK;
  savedFakeApiKey = process.env.FAKE_API_KEY;
  savedGhToken = process.env.GH_TOKEN;
  savedMySecret = process.env.MY_SECRET;
});

afterEach(() => {
  // Restore or delete each saved slot
  const restore = (key: string, saved: string | undefined) => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  };
  restore('USER', savedUser);
  restore('LOGNAME', savedLogname);
  restore('SSH_AUTH_SOCK', savedSshAuthSock);
  restore('FAKE_API_KEY', savedFakeApiKey);
  restore('GH_TOKEN', savedGhToken);
  restore('MY_SECRET', savedMySecret);
});

// ===========================================================================
// 1. USER + LOGNAME pass through when present in process.env
// ===========================================================================

describe('M230 buildContainedEnv — USER/LOGNAME auth passthrough', () => {
  it('passes USER through when process.env.USER is set', () => {
    process.env.USER = 'testuser_m230';
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    // M230 fix: USER must be present so macOS Keychain can locate login.keychain-db
    expect(env.USER).toBe('testuser_m230');
  });

  it('passes LOGNAME through when process.env.LOGNAME is set', () => {
    process.env.LOGNAME = 'testuser_logname_m230';
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    // LOGNAME mirrors USER on most POSIX systems; both are needed for portability
    expect(env.LOGNAME).toBe('testuser_logname_m230');
  });

  it('omits USER when process.env.USER is absent (no blank injection)', () => {
    delete process.env.USER;
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    // When not set, USER must be absent — not injected as '' or 'undefined'
    expect(env.USER).toBeUndefined();
  });

  it('omits LOGNAME when process.env.LOGNAME is absent (no blank injection)', () => {
    delete process.env.LOGNAME;
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    expect(env.LOGNAME).toBeUndefined();
  });

  it('passes both USER and LOGNAME when both are set in process.env', () => {
    process.env.USER = 'alice';
    process.env.LOGNAME = 'alice';
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    expect(env.USER).toBe('alice');
    expect(env.LOGNAME).toBe('alice');
  });
});

// ===========================================================================
// 2. Security boundary is fully intact when USER/LOGNAME are present
// ===========================================================================

describe('M230 security boundary — push-sever + cred-strip unchanged', () => {
  beforeEach(() => {
    // Inject credential-shaped vars that must never reach the child
    process.env.USER = 'sectest';
    process.env.LOGNAME = 'sectest';
    process.env.FAKE_API_KEY = 'should-be-stripped';
    process.env.GH_TOKEN = 'should-be-stripped';
    process.env.MY_SECRET = 'should-be-stripped';
    process.env.SSH_AUTH_SOCK = '/tmp/fake-ssh-agent.sock';
  });

  it('strips all credential-shaped vars even when USER+LOGNAME are passed', () => {
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    expect(env.FAKE_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.MY_SECRET).toBeUndefined();
    // Broad check: no CRED_KEY_RE match may survive (ENGINE_AUTH_ALLOW excepted
    // but those are only present when in process.env — not injected here)
    const leaked = Object.keys(env).filter(
      (k) =>
        CRED_KEY_RE.test(k) &&
        !['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'].includes(k),
    );
    expect(leaked).toEqual([]);
  });

  it('SSH_AUTH_SOCK is deleted (push credential channel severed)', () => {
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it('GIT_TERMINAL_PROMPT is "0" (interactive credential prompt blocked)', () => {
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('GIT_ASKPASS and SSH_ASKPASS are empty strings (no GUI credential prompts)', () => {
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    expect(env.GIT_ASKPASS).toBe('');
    expect(env.SSH_ASKPASS).toBe('');
  });

  it('core.hooksPath pre-push blocker is wired via GIT_CONFIG_* env', () => {
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    expect(env.GIT_CONFIG_VALUE_0).toBe(HOOKS_DIR);
  });

  it('USER value is the OS username — not a git credential or API key', () => {
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    // USER must pass through without being treated as a secret
    expect(env.USER).toBe('sectest');
    // And it must NOT match the credential-shaped key regex
    expect(CRED_KEY_RE.test('USER')).toBe(false);
  });
});

// ===========================================================================
// 3. HOME and PATH invariants are unchanged (regression guard)
// ===========================================================================

describe('M230 existing invariants unchanged — HOME, PATH, git channels', () => {
  it('preserves the real HOME', () => {
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it('preserves PATH', () => {
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    expect(env.PATH).toBe(process.env.PATH ?? process.env.Path ?? '');
  });

  it('GIT_CONFIG_NOSYSTEM is "1" (no system git config leaks in)', () => {
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  it('GIT_SSH_COMMAND disables interactive SSH auth', () => {
    const env = buildContainedEnv(makeConfig(), HOOKS_DIR);
    expect(env.GIT_SSH_COMMAND).toBe('ssh -oBatchMode=yes');
  });
});
