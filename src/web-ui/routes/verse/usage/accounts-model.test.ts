/**
 * accounts-model.test.ts — these pin the five facts from
 * docs/VERSE-TELEMETRY-V2.md that a naive meter gets wrong. Each one is a
 * case where the obvious rendering would tell Mason something false about
 * whether he can work right now.
 */
import { describe, expect, it } from 'vitest';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import type { Account, AccountWindow, LocalModelsSnapshot } from './usage-contract.js';
import { sanitizeCommand } from './usage-contract.js';
import {
  accountVerdict,
  bindingWindow,
  buildAccountCard,
  buildAccountCards,
  buildLocalCard,
  creditsSpendable,
  toWindowView,
  windowLabel,
} from './accounts-model.js';

function win(over: Partial<AccountWindow> & { id: string }): AccountWindow {
  return {
    label: null,
    usedPercent: null,
    resetsAt: null,
    resetDescription: null,
    limitReached: false,
    measured: true,
    ...over,
  };
}

function account(over: Partial<Account> & { id: string; provider: Account['provider'] }): Account {
  return {
    label: over.id,
    state: 'observed',
    authentication: 'signed-in',
    health: null,
    planType: null,
    observedAt: null,
    windows: [],
    binding: null,
    credits: null,
    reason: null,
    unsupported: null,
    reconnectCommand: null,
    notes: [],
    ...over,
  };
}

const CLAUDE_WINDOWS = [
  win({ id: 'five_hour', usedPercent: 47, resetDescription: 'resets Sep 20 at 2:30am (America/New_York)' }),
  win({ id: 'seven_day', usedPercent: 58, resetDescription: 'resets Sep 25 at 7pm (America/New_York)' }),
  win({ id: 'seven_day_fable', usedPercent: 100, resetDescription: 'resets Sep 25 at 7pm (America/New_York)' }),
];

describe('bindingWindow — the constraint that actually blocks work', () => {
  it('picks the per-model weekly window over the friendlier all-models one', () => {
    const claude = account({ id: 'claude', provider: 'claude', windows: CLAUDE_WINDOWS });
    expect(bindingWindow(claude)?.id).toBe('seven_day_fable');
  });

  it('never adopts a served binding that is less binding than the windows say', () => {
    const claude = account({
      id: 'claude',
      provider: 'claude',
      windows: CLAUDE_WINDOWS,
      // A server that computed the wrong one must not desynchronize the
      // headline from the detail below it.
      binding: CLAUDE_WINDOWS[1],
    });
    expect(bindingWindow(claude)?.id).toBe('seven_day_fable');
  });

  it('ignores a served binding that is not one of the account’s own windows', () => {
    const claude = account({
      id: 'claude',
      provider: 'claude',
      windows: CLAUDE_WINDOWS,
      binding: win({ id: 'invented', usedPercent: 3 }),
    });
    expect(bindingWindow(claude)?.id).toBe('seven_day_fable');
  });

  /**
   * The server's `binding` arrives STRIPPED: core's
   * `VerseAccountRecord['binding']` is `{id, usedPercent, limitReached}` with
   * no label, no `resetsAt` and no `nativeReport`, and `projectWindow` fills
   * the rest with nulls. Returning that object directly dropped the reset line
   * from the prominent meter — and for Claude that IS the entire reset signal,
   * because `resetsAt` is null by construction and only the provider's prose
   * carries it. AccountCard then filters the full window out of `others` by
   * id, so the prose appeared nowhere on the card at all.
   */
  it('resolves a stripped served binding back to the account’s own full window', () => {
    const claude = account({
      id: 'claude',
      provider: 'claude',
      windows: CLAUDE_WINDOWS,
      binding: { id: 'seven_day_fable', label: null, usedPercent: 100, resetsAt: null,
        resetDescription: null, limitReached: false, measured: true },
    });
    const binding = bindingWindow(claude);
    expect(binding?.id).toBe('seven_day_fable');
    expect(toWindowView(binding!).resetText).toBe('resets Sep 25 at 7pm (America/New_York)');
  });

  it('is null when nothing was measured — never a substituted zero', () => {
    const grok = account({ id: 'grok', provider: 'grok', windows: [win({ id: 'grok_unified' })] });
    expect(bindingWindow(grok)).toBeNull();
  });

  it('lets a flagged limit outrank every measurement', () => {
    const codex = account({
      id: 'codex-a',
      provider: 'codex',
      windows: [win({ id: 'primary', usedPercent: 12 }), win({ id: 'secondary', limitReached: true })],
    });
    expect(bindingWindow(codex)?.id).toBe('secondary');
  });
});

describe('toWindowView — the sentinel 100 is a flag, not a measurement', () => {
  it('strips the percentage off a flagged window so no "100% used" is printed', () => {
    const view = toWindowView(win({ id: 'primary', usedPercent: 100, limitReached: true }));
    expect(view.usedPct).toBeNull();
    expect(view.limitReached).toBe(true);
    expect(view.tone).toBe('danger');
  });

  it('prefers the provider’s own reset prose over a timestamp', () => {
    const view = toWindowView(
      win({ id: 'seven_day', usedPercent: 58, resetsAt: '2026-09-25T23:00:00.000Z', resetDescription: 'resets Sep 25 at 7pm' }),
    );
    expect(view.resetText).toBe('resets Sep 25 at 7pm');
  });

  it('prints an instant-only reset as local time, never the raw ISO string', () => {
    const at = new Date(2026, 8, 25, 23, 46); // local, so the words hold in any zone
    const now = new Date(2026, 8, 24, 9, 0).getTime();
    const view = toWindowView(win({ id: 'codex', usedPercent: 31, resetsAt: at.toISOString() }), now);
    // The shared reset wording, in whatever the default locale is ("Fri 11:46 PM" under en-US).
    expect(view.resetText).toBe(`resets ${describeResetAt(at.toISOString(), now)}`);
    if (new Intl.DateTimeFormat().resolvedOptions().locale === 'en-US') expect(view.resetText).toBe('resets Fri 11:46 PM');
    expect(view.resetsAt).toBe(at.toISOString());
    // An instant that does not parse says nothing rather than printing itself.
    expect(toWindowView(win({ id: 'codex', usedPercent: 31, resetsAt: 'soon' })).resetText).toBeNull();
  });

  it('names the per-model weekly windows in a way a human reads', () => {
    expect(windowLabel(win({ id: 'seven_day_fable' }))).toBe('Week · Fable');
    expect(windowLabel(win({ id: 'five_hour' }))).toBe('Session · rolling 5h');
  });
});

describe('accountVerdict — credits are independent of the window', () => {
  const exhaustedCodex = account({
    id: 'codex-a',
    provider: 'codex',
    planType: 'pro',
    windows: [win({ id: 'codex', usedPercent: 100 })],
  });

  it('does NOT read as blocked when a 100%-used week still has a spendable balance', () => {
    const withCredits: Account = {
      ...exhaustedCodex,
      credits: { hasCredits: true, unlimited: false, balance: '2048.4196250000', balanceValue: 2048.419625 },
    };
    const verdict = accountVerdict(withCredits, bindingWindow(withCredits));
    expect(verdict.state).toBe('credits');
    expect(verdict.headline).toBe('Usable on credits');
    expect(verdict.detail).toMatch(/credits are independent of the window/);
  });

  it('reads as exhausted when the window is full and there is nothing to spend', () => {
    const verdict = accountVerdict(exhaustedCodex, bindingWindow(exhaustedCodex));
    expect(verdict.state).toBe('exhausted');
  });

  it('treats a zero balance as not spendable, and an unlimited plan as spendable', () => {
    expect(creditsSpendable({ hasCredits: true, unlimited: false, balance: '0', balanceValue: 0 })).toBe(false);
    expect(creditsSpendable({ hasCredits: false, unlimited: true, balance: null, balanceValue: null })).toBe(true);
    expect(creditsSpendable(null)).toBe(false);
  });

  it('says "limit reached", never "100% used", for the provider sentinel', () => {
    const flagged = account({
      id: 'codex-b',
      provider: 'codex',
      windows: [win({ id: 'codex', usedPercent: 100, limitReached: true })],
    });
    const verdict = accountVerdict(flagged, bindingWindow(flagged));
    expect(verdict.headline).toBe('Limit reached');
    expect(verdict.detail).toMatch(/a denial, not a measurement/);
  });

  it('states the binding share by the one percent rule — never a rounded "100%" short of spent, never "0%" for a reading', () => {
    const at = (usedPercent: number) => {
      const a = account({ id: 'codex-c', provider: 'codex', windows: [win({ id: 'codex', usedPercent })] });
      return accountVerdict(a, bindingWindow(a));
    };
    expect(at(99.6)).toMatchObject({ state: 'tight', detail: expect.stringMatching(/ at 99%\.$/) });
    expect(at(0.4)).toMatchObject({ state: 'available', detail: expect.stringMatching(/ at <1%\.$/) });
  });
});

describe('accountVerdict — signed out is an action, not a zero', () => {
  it('renders Grok’s signed-out state as its own verdict', () => {
    const grok = account({
      id: 'grok',
      provider: 'grok',
      state: 'signed-out',
      authentication: 'signed-out',
      reason: 'The pinned profile reports "You are not authenticated".',
    });
    const card = buildAccountCard(grok);
    expect(card.verdict.state).toBe('signed-out');
    expect(card.binding).toBeNull();
    expect(card.others).toEqual([]);
    expect(card.verdict.detail).toMatch(/not authenticated/);
  });
});

describe('accountVerdict — a version-pinned probe says so', () => {
  it('names the code and the pin instead of a silent unknown', () => {
    const claude = account({
      id: 'claude',
      provider: 'claude',
      unsupported: { code: 'usage-version-unsupported', pinnedVersion: '2.1.257' },
    });
    const verdict = accountVerdict(claude, null);
    expect(verdict.state).toBe('probe-unsupported');
    expect(verdict.detail).toContain('usage-version-unsupported');
    expect(verdict.detail).toContain('2.1.257');
  });
});

describe('buildAccountCards — ordered by what can be used right now', () => {
  it('puts usable accounts first and keeps ties alphabetical', () => {
    const cards = buildAccountCards({
      accounts: [
        account({ id: 'grok', provider: 'grok', label: 'Grok', state: 'signed-out', authentication: 'signed-out' }),
        account({ id: 'claude', provider: 'claude', label: 'Claude Max', windows: CLAUDE_WINDOWS }),
        account({
          id: 'codex-a',
          provider: 'codex',
          label: 'Personal Codex',
          windows: [win({ id: 'codex', usedPercent: 22 })],
        }),
        account({
          id: 'codex-b',
          provider: 'codex',
          label: 'Work Codex',
          windows: [win({ id: 'codex', usedPercent: 85 })],
        }),
      ],
    });
    expect(cards.map((c) => c.label)).toEqual(['Personal Codex', 'Work Codex', 'Claude Max', 'Grok']);
    expect(cards[0]?.verdict.state).toBe('available');
    expect(cards[1]?.verdict.state).toBe('tight');
    expect(cards[2]?.verdict.state).toBe('exhausted');
  });

  it('keeps the non-binding windows as secondary detail rather than dropping them', () => {
    const cards = buildAccountCards({
      accounts: [account({ id: 'claude', provider: 'claude', label: 'Claude Max', windows: CLAUDE_WINDOWS })],
    });
    expect(cards[0]?.binding?.label).toBe('Week · Fable');
    expect(cards[0]?.others.map((w) => w.label)).toEqual(['Session · rolling 5h', 'Week · all models']);
  });
});

describe('sanitizeCommand — a launcher invocation never reaches a surface', () => {
  it('drops anything naming a native profile, the account store or a token', () => {
    expect(sanitizeCommand('node ~/.ashlr/native-profiles/grok-a/launcher.mjs')).toBeNull();
    expect(sanitizeCommand('cat ~/.ashlr/account-connections/console-startup.json')).toBeNull();
    expect(sanitizeCommand('curl -H "Authorization: Bearer abc" https://x')).toBeNull();
    expect(sanitizeCommand('ashlr resources --token sk-1')).toBeNull();
  });

  it('refuses a second smuggled command on a new line', () => {
    expect(sanitizeCommand('ashlr resources\nrm -rf /')).toBeNull();
  });

  it('allows a plain, safe command', () => {
    expect(sanitizeCommand('  ashlr resources  ')).toBe('ashlr resources');
  });
});

describe('buildLocalCard — the local analogue of a quota meter', () => {
  const snapshot = (over: Partial<LocalModelsSnapshot> = {}): LocalModelsSnapshot => ({
    reachable: true,
    models: [],
    memoryBudgetBytes: 128 * 1024 ** 3,
    freeMemoryBytes: null,
    reason: null,
    runtimes: [],
    notes: [],
    sampledAt: null,
    ...over,
  });

  it('measures resident bytes against the machine budget', () => {
    const card = buildLocalCard(
      snapshot({
        models: [
          {
            name: 'qwen3-coder',
            runtime: 'ollama',
            supportsTools: true,
            loaded: true,
            sizeBytes: 64 * 1024 ** 3,
            sizeVramBytes: 60 * 1024 ** 3,
            placement: 'unknown',
            gpuPercent: null,
            memoryPercent: null,
            family: null,
            arch: null,
            expiresAt: null,
            parameterSize: '79.7B',
            quantization: 'Q4_K_M',
            nativeContext: 262_144,
            configuredContext: 65_536,
            capabilities: ['completion', 'tools'],
          },
        ],
      }),
    );
    expect(card?.usedPct).toBe(50);
    expect(card?.verdict.state).toBe('available');
    expect(card?.residentCount).toBe(1);
  });

  it('draws no meter at all when the machine budget was not reported', () => {
    const card = buildLocalCard(snapshot({ memoryBudgetBytes: null }));
    expect(card?.usedPct).toBeNull();
  });

  /**
   * Same rule local-model.ts enforces for the table's total: a resident model
   * with no reported size makes the TOTAL unknown. Summing the rest returns a
   * number that is quietly too small, and the meter drawn from it under-reads
   * memory pressure — the one figure on this card nobody should have to
   * second-guess. Two views of one number, one honest and one not, on the same
   * screen was the actual defect.
   */
  it('refuses to sum resident bytes when one resident model reports no size', () => {
    const model = (name: string, sizeBytes: number | null): LocalModelsSnapshot['models'][number] => ({
      name,
      runtime: 'ollama',
      supportsTools: true,
      loaded: true,
      sizeBytes,
      sizeVramBytes: null,
      placement: 'unknown',
      gpuPercent: null,
      memoryPercent: null,
      family: null,
      arch: null,
      expiresAt: null,
      parameterSize: null,
      quantization: null,
      nativeContext: null,
      configuredContext: null,
      capabilities: null,
    });
    const card = buildLocalCard(
      snapshot({ models: [model('a', 32 * 1024 ** 3), model('b', 16 * 1024 ** 3), model('c', null)] }),
    );
    expect(card?.residentCount).toBe(3);
    expect(card?.residentBytes).toBeNull();
    expect(card?.usedPct).toBeNull();
  });

  it('distinguishes "installed but not loaded" from "nothing installed"', () => {
    const installed = buildLocalCard(
      snapshot({
        models: [
          {
            name: 'a',
            runtime: 'ollama',
            supportsTools: null,
            loaded: false,
            sizeBytes: null,
            sizeVramBytes: null,
            placement: 'unknown',
            gpuPercent: null,
            memoryPercent: null,
            family: null,
            arch: null,
            expiresAt: null,
            parameterSize: null,
            quantization: null,
            nativeContext: null,
            configuredContext: null,
            capabilities: null,
          },
        ],
      }),
    );
    expect(installed?.verdict.headline).toBe('Installed, not loaded');
    expect(buildLocalCard(snapshot())?.verdict.headline).toBe('No models installed');
  });

  it('is an unreachable runtime, not an empty machine, when the source failed', () => {
    const card = buildLocalCard(snapshot({ reachable: false, reason: 'ollama-unreachable' }));
    expect(card?.verdict.state).toBe('unknown');
    // The machine code rides along as evidence; it is never the sentence.
    expect(card?.verdict.detail).toMatch(/unanswered probe/);
    expect(card?.verdict.detail).not.toBe('ollama-unreachable');
    expect(card?.verdict.code).toBe('ollama-unreachable');
  });

  it('withholds the memory meter entirely when the runtime never answered', () => {
    // Nothing resident and an unreachable runtime are different facts: the
    // second one has no reading at all, so it must not draw a real 0% bar.
    const card = buildLocalCard(snapshot({ reachable: false, reason: 'ollama-unreachable' }));
    expect(card?.residentBytes).toBeNull();
    expect(card?.usedPct).toBeNull();
    // An idle but reachable runtime genuinely has zero bytes resident.
    expect(buildLocalCard(snapshot({ reachable: true }))?.residentBytes).toBe(0);
  });

  it('is null — not a zero card — when no local source answered at all', () => {
    expect(buildLocalCard(null)).toBeNull();
  });
});
