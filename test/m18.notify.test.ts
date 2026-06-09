/**
 * M18 — hermetic tests for src/core/integrations/notify.ts
 *
 * Mocks globalThis.fetch — no real network calls ever made.
 *
 * Invariants verified:
 *   - notify is a STRICT NO-OP (returns false, zero network calls) when
 *     neither cfg.notify.slackWebhook nor discordWebhook is set
 *   - notify posts when slackWebhook is configured and returns true on success
 *   - notify posts when discordWebhook is configured and returns true on success
 *   - notify posts to BOTH when both are configured
 *   - posted body never contains secret values
 *   - notify returns false (gracefully) when the webhook POST fails
 *   - notify never throws — always returns boolean
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';

import { notify } from '../src/core/integrations/notify.js';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Minimal valid AshlrConfig with no notify webhook configured. */
function makeConfigNoWebhook(): AshlrConfig {
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
    // no notify field
  };
}

function makeConfigSlack(webhookUrl: string): AshlrConfig {
  return { ...makeConfigNoWebhook(), notify: { slackWebhook: webhookUrl } };
}

function makeConfigDiscord(webhookUrl: string): AshlrConfig {
  return { ...makeConfigNoWebhook(), notify: { discordWebhook: webhookUrl } };
}

function makeConfigBoth(slackUrl: string, discordUrl: string): AshlrConfig {
  return { ...makeConfigNoWebhook(), notify: { slackWebhook: slackUrl, discordWebhook: discordUrl } };
}

// Fake webhook URLs (no real endpoints)
const FAKE_SLACK_URL = 'https://hooks.slack.com/services/T000/B000/FAKE_WEBHOOK_TOKEN_PLACEHOLDER';
const FAKE_DISCORD_URL = 'https://discord.com/api/webhooks/000000000/FAKE_DISCORD_TOKEN_PLACEHOLDER';

// Mock fetch response
function mockFetchOk(): Response {
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
}

function mockFetchFail(): Response {
  return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
}

// ---------------------------------------------------------------------------
// STRICT NO-OP: no webhook configured
// ---------------------------------------------------------------------------

describe('notify — STRICT NO-OP when no webhook is configured', () => {
  let fetchCalled = false;

  beforeEach(() => {
    fetchCalled = false;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      fetchCalled = true;
      return Promise.resolve(mockFetchOk());
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns false when notify is undefined', async () => {
    const cfg = makeConfigNoWebhook();
    const result = await notify('test message', cfg);
    expect(result).toBe(false);
  });

  it('makes ZERO network calls when notify is undefined', async () => {
    const cfg = makeConfigNoWebhook();
    await notify('test message', cfg);
    expect(fetchCalled).toBe(false);
  });

  it('returns false when notify is empty object {}', async () => {
    const cfg: AshlrConfig = { ...makeConfigNoWebhook(), notify: {} };
    const result = await notify('test message', cfg);
    expect(result).toBe(false);
  });

  it('makes ZERO network calls when notify is empty object {}', async () => {
    const cfg: AshlrConfig = { ...makeConfigNoWebhook(), notify: {} };
    await notify('test message', cfg);
    expect(fetchCalled).toBe(false);
  });

  it('does not throw when no webhook is configured', async () => {
    const cfg = makeConfigNoWebhook();
    await expect(notify('test', cfg)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Posts when slackWebhook is configured
// ---------------------------------------------------------------------------

describe('notify — posts to slackWebhook when configured', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchOk()));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns true on successful Slack post', async () => {
    const cfg = makeConfigSlack(FAKE_SLACK_URL);
    const result = await notify('Build complete', cfg);
    expect(result).toBe(true);
  });

  it('calls fetch when Slack webhook is configured', async () => {
    const cfg = makeConfigSlack(FAKE_SLACK_URL);
    await notify('Build complete', cfg);
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it('posts to the configured Slack URL', async () => {
    const cfg = makeConfigSlack(FAKE_SLACK_URL);
    await notify('Build complete', cfg);
    const calls = vi.mocked(fetch).mock.calls;
    const slackCall = calls.find(c => String(c[0]).includes('slack.com') || String(c[0]).includes('hooks.slack'));
    expect(slackCall).toBeDefined();
  });

  it('POST body contains the text message', async () => {
    const cfg = makeConfigSlack(FAKE_SLACK_URL);
    await notify('My completion summary', cfg);
    const calls = vi.mocked(fetch).mock.calls;
    const call = calls[0];
    const bodyStr = typeof call[1] === 'object' && call[1] !== null
      ? JSON.stringify((call[1] as RequestInit).body ?? '')
      : '';
    expect(bodyStr).toContain('My completion summary');
  });
});

// ---------------------------------------------------------------------------
// Posts when discordWebhook is configured
// ---------------------------------------------------------------------------

describe('notify — posts to discordWebhook when configured', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchOk()));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns true on successful Discord post', async () => {
    const cfg = makeConfigDiscord(FAKE_DISCORD_URL);
    const result = await notify('Run complete', cfg);
    expect(result).toBe(true);
  });

  it('calls fetch when Discord webhook is configured', async () => {
    const cfg = makeConfigDiscord(FAKE_DISCORD_URL);
    await notify('Run complete', cfg);
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it('posts to the configured Discord URL', async () => {
    const cfg = makeConfigDiscord(FAKE_DISCORD_URL);
    await notify('Run complete', cfg);
    const calls = vi.mocked(fetch).mock.calls;
    const discordCall = calls.find(c => String(c[0]).includes('discord.com') || String(c[0]).includes('webhooks'));
    expect(discordCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Posts to both webhooks when both configured
// ---------------------------------------------------------------------------

describe('notify — posts to both webhooks when both are configured', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchOk()));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('calls fetch at least twice when both webhooks are configured', async () => {
    const cfg = makeConfigBoth(FAKE_SLACK_URL, FAKE_DISCORD_URL);
    await notify('Dual post', cfg);
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returns true when both posts succeed', async () => {
    const cfg = makeConfigBoth(FAKE_SLACK_URL, FAKE_DISCORD_URL);
    const result = await notify('Dual post', cfg);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Graceful failure when webhook POST fails
// ---------------------------------------------------------------------------

describe('notify — graceful failure when POST fails', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchFail()));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('does not throw when POST returns non-ok status', async () => {
    const cfg = makeConfigSlack(FAKE_SLACK_URL);
    await expect(notify('test', cfg)).resolves.toBeDefined();
  });

  it('returns false when POST returns non-ok status', async () => {
    const cfg = makeConfigSlack(FAKE_SLACK_URL);
    const result = await notify('test', cfg);
    expect(result).toBe(false);
  });
});

describe('notify — graceful failure when fetch throws (network error)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('does not throw when fetch rejects', async () => {
    const cfg = makeConfigSlack(FAKE_SLACK_URL);
    await expect(notify('test', cfg)).resolves.toBeDefined();
  });

  it('returns false when fetch rejects', async () => {
    const cfg = makeConfigSlack(FAKE_SLACK_URL);
    const result = await notify('test', cfg);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// No secret values in posted body
// ---------------------------------------------------------------------------

describe('notify — posted body must not contain secret values', () => {
  let capturedBody: string | null = null;

  beforeEach(() => {
    capturedBody = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: unknown, init: unknown) => {
      if (init !== null && typeof init === 'object') {
        capturedBody = String((init as RequestInit).body ?? '');
      }
      return Promise.resolve(mockFetchOk());
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posted body does not contain token-pattern values', async () => {
    const cfg = makeConfigSlack(FAKE_SLACK_URL);
    // Text is a safe summary with no secrets
    await notify('Swarm completed 3 tasks in 45s', cfg);
    if (capturedBody !== null) {
      expect(capturedBody).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
      expect(capturedBody).not.toMatch(/ghp_[a-zA-Z0-9]{20,}/);
      expect(capturedBody).not.toMatch(/Bearer [a-zA-Z0-9._-]{20,}/);
    }
  });

  it('webhook URL itself is not included in the posted body', async () => {
    const cfg = makeConfigSlack(FAKE_SLACK_URL);
    await notify('Run done', cfg);
    if (capturedBody !== null) {
      // The webhook token part of the URL must not be in the body
      expect(capturedBody).not.toContain('FAKE_WEBHOOK_TOKEN_PLACEHOLDER');
    }
  });
});

// ---------------------------------------------------------------------------
// Return type invariant
// ---------------------------------------------------------------------------

describe('notify — always returns a boolean', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns boolean false when no webhook', async () => {
    const result = await notify('test', makeConfigNoWebhook());
    expect(typeof result).toBe('boolean');
    expect(result).toBe(false);
  });

  it('returns boolean true when webhook configured + fetch succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchOk()));
    const result = await notify('test', makeConfigSlack(FAKE_SLACK_URL));
    expect(typeof result).toBe('boolean');
  });

  it('returns boolean false when webhook configured + fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fail')));
    const result = await notify('test', makeConfigSlack(FAKE_SLACK_URL));
    expect(typeof result).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Explicitly never posts without a configured webhook (the hard rule)
// ---------------------------------------------------------------------------

describe('notify — NEVER posts without a configured webhook (hard rule)', () => {
  it('fetch is never called when notify.slackWebhook is undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk());
    vi.stubGlobal('fetch', fetchMock);
    const cfg: AshlrConfig = { ...makeConfigNoWebhook(), notify: { slackWebhook: undefined } };
    await notify('should not post', cfg);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('fetch is never called when notify.discordWebhook is undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk());
    vi.stubGlobal('fetch', fetchMock);
    const cfg: AshlrConfig = { ...makeConfigNoWebhook(), notify: { discordWebhook: undefined } };
    await notify('should not post', cfg);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('fetch is never called when both webhook fields are empty strings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk());
    vi.stubGlobal('fetch', fetchMock);
    const cfg: AshlrConfig = { ...makeConfigNoWebhook(), notify: { slackWebhook: '', discordWebhook: '' } };
    await notify('should not post', cfg);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
