/**
 * UsageSection.test.tsx — renders the section against stubbed endpoints.
 *
 * The assertions that matter are about what does NOT appear: no meter where
 * there is no reading, no "0%" anywhere the truth is "no signal", no "blocked"
 * on a Codex account that still has credits, and no launcher command anywhere
 * at all.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsageSection } from './UsageSection.js';
import { evictAll } from '../../../data/cache.js';

// Verified shapes from docs/VERSE-TELEMETRY-V2.md: Claude's three windows with
// its per-model week binding at 100%, two Codex accounts (one of them at a
// fully used week with a spendable balance), and Grok signed out.
const ACCOUNTS = {
  sampledAt: '2026-09-20T10:00:00.000Z',
  refreshing: false,
  accounts: [
    {
      id: 'claude',
      label: 'Claude Max',
      provider: 'claude',
      state: 'observed',
      authentication: 'signed-in',
      planType: 'max',
      observedAt: '2026-09-20T10:00:00.000Z',
      windows: [
        { id: 'five_hour', usedPercent: 47, resetsAt: null, nativeReport: { source: 'claude-usage', resetDescription: 'resets Sep 20 at 2:30am (America/New_York)' } },
        { id: 'seven_day', usedPercent: 58, resetsAt: null, nativeReport: { source: 'claude-usage', resetDescription: 'resets Sep 25 at 7pm (America/New_York)' } },
        { id: 'seven_day_fable', usedPercent: 100, resetsAt: null, nativeReport: { source: 'claude-usage', resetDescription: 'resets Sep 25 at 7pm (America/New_York)' } },
      ],
    },
    {
      id: 'codex-a',
      label: 'Personal Codex',
      provider: 'codex',
      state: 'observed',
      authentication: 'signed-in',
      planType: 'pro',
      windows: [{ id: 'codex', usedPercent: 100, resetsAt: '2026-09-25T23:06:56.000Z' }],
      credits: { hasCredits: true, unlimited: false, balance: '2048.4196250000' },
    },
    {
      id: 'codex-b',
      label: 'Work Codex',
      provider: 'codex',
      state: 'observed',
      authentication: 'signed-in',
      planType: 'plus',
      windows: [{ id: 'codex', usedPercent: 31, resetsAt: '2026-09-25T23:06:56.000Z' }],
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    },
    {
      id: 'grok',
      label: 'Grok',
      provider: 'grok',
      state: 'signed-out',
      authentication: 'signed-out',
      planType: null,
      windows: [],
      // The verbatim probe code the monitor actually carries — `reason` is a
      // machine code by contract on the producing side, never prose.
      reason: 'probe-account-unavailable',
      reconnectCommand: 'node ~/.ashlr/native-profiles/grok-a/launcher.mjs auth login',
    },
  ],
};

const LOCAL_MODELS = {
  reachable: true,
  memoryBudgetBytes: 137_438_953_472,
  models: [
    {
      name: 'qwen3-coder',
      loaded: true,
      size: 68_719_476_736,
      size_vram: 60_129_542_144,
      expires_at: '2026-09-20T10:05:00.000Z',
      parameter_size: '79.7B',
      quantization_level: 'Q4_K_M',
      nativeContext: 262_144,
      configuredContext: 65_536,
      capabilities: ['completion', 'tools'],
    },
    {
      name: 'embed-small',
      loaded: false,
      size: 1_073_741_824,
      parameter_size: '0.3B',
      quantization_level: 'F16',
      capabilities: ['completion'],
    },
  ],
};

const SERIES_7D = {
  window: '7d',
  days: [
    { day: '2026-09-17', tokensIn: 1_200_000, tokensOut: 90_000, estCostUsd: 3.2, sessions: 8, cacheHitRate: 0.62 },
    { day: '2026-09-18', tokensIn: 2_400_000, tokensOut: 140_000, estCostUsd: 6.1, sessions: 14, cacheHitRate: 0.71 },
    { day: '2026-09-19', tokensIn: 900_000, tokensOut: 70_000, estCostUsd: 2.4, sessions: 6 },
  ],
};

const SERIES_30D = {
  window: '30d',
  days: [
    { day: '2026-08-21', tokensIn: 10, tokensOut: 5, estCostUsd: 0.1, sessions: 1 },
    { day: '2026-08-22', tokensIn: 20, tokensOut: 9, estCostUsd: 0.2, sessions: 2 },
  ],
};

const USAGE = {
  generatedAt: '2026-09-20T10:00:00.000Z',
  engines: [
    {
      engine: 'claude',
      callsToday: 35,
      tokensToday: 120_000,
      costToday: 2.5,
      subscriptionWindow: { state: 'active', usedPct: 35, windowLabel: '1d' },
      limit: 100,
      limitWindow: '1d',
      remainingEstimate: 65,
    },
  ],
};

const CONTROL = {
  ts: '2026-09-20T10:00:05.000Z',
  models: { activeProvider: 'ollama', providers: [] },
  daemon: { todaySpentUsd: 4.25 },
  daemonObservation: {
    observedAt: '2026-09-20T10:00:00.000Z',
    runtimeState: 'running',
    sourceQuality: { sourceState: 'healthy', complete: true, reason: 'healthy' },
    running: true,
    pid: 1,
    startedAt: null,
    lastTickAt: null,
    todayDate: null,
    todaySpentUsd: 4.25,
    itemsProcessed: null,
    ticks: [
      { ts: '2026-09-17T01:00:00.000Z', itemsConsidered: 1, proposalsCreated: 0, spentUsd: 1.5, reason: 'ok' },
      { ts: '2026-09-19T02:00:00.000Z', itemsConsidered: 1, proposalsCreated: 0, spentUsd: 3, reason: 'ok' },
    ],
  },
  usage: {
    window: '7d',
    totalTokens: 300_000,
    totalCostUsd: 12,
    localSavingsUsd: 41.5,
    byProvider: [
      { provider: 'ollama', tier: 'local', tokens: 200_000, costUsd: 0, sharePct: 66 },
      { provider: 'anthropic', tier: 'cloud', tokens: 100_000, costUsd: 12, sharePct: 34 },
    ],
  },
  limits: [{ backend: 'codex', window: '1d', max: 200, used: 50, standing: 'ok' }],
  subscriptionUsage: [{ engine: 'claude', windows: [], hasData: false }],
};

const VERSE_CONTROL = {
  caps: { dailyBudgetUsd: 25, subscriptionMaxPercent: 90, foundryLimits: [{ engine: 'grok', window: '1h', max: 10 }] },
  spend: { todayUsd: 4.25, todayDate: null },
};

const BOOTSTRAP = {
  dispatchEnabled: true,
  projects: [],
  sessions: [],
  localRuntime: { ollama: { reachable: true, baseUrl: 'http://127.0.0.1:11434', models: ['qwen3-coder'] } },
  seats: [
    { id: 'claude', engine: 'claude', label: 'Claude Max', accountId: 'claude', models: [], contextWindow: 200_000, health: { state: 'ready', summary: null, windows: [], observedAt: null } },
    { id: 'grok', engine: 'grok', label: 'Grok', accountId: 'grok', models: [], contextWindow: 256_000, health: { state: 'unknown', summary: null, windows: [], observedAt: null } },
  ],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function routes(over: Record<string, () => Response> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [prefix, make] of Object.entries(over)) {
      if (url.startsWith(prefix)) return make();
    }
    if (url.startsWith('/api/verse/accounts')) return json(ACCOUNTS);
    if (url.startsWith('/api/verse/local-models')) return json(LOCAL_MODELS);
    if (url.startsWith('/api/verse/usage-series?window=30d')) return json(SERIES_30D);
    if (url.startsWith('/api/verse/usage-series')) return json(SERIES_7D);
    if (url.startsWith('/api/verse/control')) return json(VERSE_CONTROL);
    if (url.startsWith('/api/verse/bootstrap')) return json(BOOTSTRAP);
    if (url.startsWith('/api/usage')) return json(USAGE);
    if (url.startsWith('/api/control')) return json(CONTROL);
    return new Response('not found', { status: 404 });
  });
}

function card(name: string): HTMLElement {
  return screen.getByLabelText(`${name} usage`);
}

describe('UsageSection — accounts', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', routes());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leads Claude with its per-model weekly window, not the friendlier one', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(card('Claude Max')).toBeInTheDocument());

    const claude = card('Claude Max');
    expect(within(claude).getByText('Binding constraint')).toBeInTheDocument();
    const binding = within(claude).getByRole('meter', { name: /Claude Max Week · Fable used/ });
    expect(binding).toHaveAttribute('aria-valuenow', '100');
    // The other two windows stay on the card as secondary detail.
    expect(within(claude).getByRole('meter', { name: /Session · rolling 5h used/ })).toHaveAttribute('aria-valuenow', '47');
    expect(within(claude).getByRole('meter', { name: /Week · all models used/ })).toHaveAttribute('aria-valuenow', '58');
  });

  it('renders Claude’s reset prose verbatim rather than a countdown', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(card('Claude Max')).toBeInTheDocument());
    expect(
      within(card('Claude Max')).getAllByText('resets Sep 25 at 7pm (America/New_York)').length,
    ).toBeGreaterThan(0);
  });

  it('does NOT read a fully used Codex week with credits as blocked', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(card('Personal Codex')).toBeInTheDocument());

    const codex = card('Personal Codex');
    expect(within(codex).getByText('Usable on credits')).toBeInTheDocument();
    expect(within(codex).queryByText('Window exhausted')).not.toBeInTheDocument();
    expect(within(codex).getByText('2,048.42')).toBeInTheDocument();
    expect(within(codex).getByText('pro plan')).toBeInTheDocument();
    expect(within(codex).getByText(/Credits are a separate pool/)).toBeInTheDocument();
  });

  it('renders Grok as an actionable signed-out state, not a zero meter', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(card('Grok')).toBeInTheDocument());

    const grok = card('Grok');
    expect(within(grok).getByText('Signed out')).toBeInTheDocument();
    expect(within(grok).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(grok).queryByText('0%')).not.toBeInTheDocument();
    // The card's sentence is plain language, and the machine code rides along
    // as a secondary line rather than BEING the sentence.
    expect(within(grok).getByText(/it is not authenticated/)).toBeInTheDocument();
    expect(within(grok).getByText('probe-account-unavailable')).toBeInTheDocument();
  });

  it('never prints a native-profile launcher command, even when the payload carries one', async () => {
    const { container } = render(<UsageSection />);
    await waitFor(() => expect(card('Grok')).toBeInTheDocument());
    expect(container.textContent).not.toContain('launcher.mjs');
    expect(container.textContent).not.toContain('native-profiles');
    expect(within(card('Grok')).getByText(/never allowed onto a surface/)).toBeInTheDocument();
  });

  it('orders the cards by what can actually be used right now', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(card('Work Codex')).toBeInTheDocument());
    const labels = screen
      .getAllByRole('article')
      .map((el) => el.getAttribute('aria-label'));
    // Local and Work Codex are both plainly usable; Personal Codex is usable
    // only on credits; Claude is exhausted; Grok is signed out.
    expect(labels).toEqual([
      'Local usage',
      'Work Codex usage',
      'Personal Codex usage',
      'Claude Max usage',
      'Grok usage',
    ]);
  });
});

describe('UsageSection — local availability', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', routes());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('meters resident bytes against the machine memory budget', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(card('Local')).toBeInTheDocument());
    const meter = within(card('Local')).getByRole('meter', {
      name: 'Local resident models against machine memory budget',
    });
    expect(meter).toHaveAttribute('aria-valuenow', '50');
  });

  it('shows residency, the GPU split, params, quant, context and tool support', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Local availability')).toBeInTheDocument());
    // The name now appears in the model table, in the resident-memory chart,
    // and in that chart's table twin. The MODEL TABLE is the row this test is
    // about, so it is selected by the caption rather than by being the only
    // occurrence of the name on the screen.
    const table = screen.getByRole('table', { name: /residency, tool support/i });
    const row = within(table).getByText('qwen3-coder').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('resident')).toBeInTheDocument();
    expect(within(row!).getByText(/88% GPU/)).toBeInTheDocument();
    expect(within(row!).getByText('79.7B')).toBeInTheDocument();
    expect(within(row!).getByText('Q4_K_M')).toBeInTheDocument();
    expect(within(row!).getByText('64k of 256k')).toBeInTheDocument();
    expect(within(row!).getByText('tools')).toBeInTheDocument();
  });

  it('says plainly that a model without tools cannot drive an agentic session', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Local availability')).toBeInTheDocument());
    const row = screen.getByText('embed-small').closest('tr');
    expect(within(row!).getByText('no tools')).toBeInTheDocument();
    expect(within(row!).getByText('installed')).toBeInTheDocument();
  });

  it('says the source is missing, not that the machine is empty, when the route is absent', async () => {
    vi.stubGlobal('fetch', routes({ '/api/verse/local-models': () => new Response('nope', { status: 404 }) }));
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Local availability')).toBeInTheDocument());
    expect(screen.getByText(/missing source, not an empty machine/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Local usage')).not.toBeInTheDocument();
  });
});

/**
 * `/api/verse/local-models` probes the runtimes live on every request with a
 * 2s per-probe timeout, and answers a timed-out probe as an ordinary HTTP 200
 * carrying `{reachable: false, reason: 'ollama-unreachable'}`. Mounting this
 * section — and every press of its Refresh button — fires seven reads at once,
 * several of which spawn probe processes server-side, and that burst starves
 * the 2s probe often enough to matter (measured: roughly one burst in ten
 * against a live Ollama holding twelve models).
 *
 * Nothing re-reads this route afterwards — it has no SSE invalidation key — so
 * one false negative is what the operator is left looking at, on a machine
 * where Ollama is running fine. These are the tests for that.
 */
describe('UsageSection — a transient local probe failure corrects itself', () => {
  const RUNTIME_MACHINE = { totalMemoryBytes: 137_438_953_472, freeMemoryBytes: 48_242_049_024 };

  /** Exactly what the route answers when its 2s Ollama probe times out. */
  const RUNTIME_UNREACHABLE = {
    ollama: { reachable: false, baseUrl: 'http://localhost:11434', models: [], reason: 'ollama-unreachable' },
    lmStudio: { reachable: false, baseUrl: 'http://localhost:1234', models: [], reason: 'lmstudio-unreachable' },
    machine: RUNTIME_MACHINE,
    notes: [],
  };

  /** The truth on that same machine: Ollama up, twelve models installed. */
  const RUNTIME_HEALTHY = {
    ollama: {
      reachable: true,
      baseUrl: 'http://localhost:11434',
      reason: null,
      models: Array.from({ length: 12 }, (_, i) => ({
        label: `local-model-${i}`,
        state: 'available',
        sizeBytes: 1_073_741_824,
        capabilities: ['completion', 'tools'],
        supportsTools: true,
      })),
    },
    lmStudio: { reachable: false, baseUrl: 'http://localhost:1234', models: [], reason: 'lmstudio-unreachable' },
    machine: RUNTIME_MACHINE,
    notes: [],
  };

  /** Answers `unreachable` for the first `failures` reads, the truth after. */
  function localModelsFailingFirst(failures: number): {
    fetch: ReturnType<typeof routes>;
    reads: () => number;
  } {
    let reads = 0;
    const fetchMock = routes({
      '/api/verse/local-models': () => {
        reads += 1;
        return json(reads <= failures ? RUNTIME_UNREACHABLE : RUNTIME_HEALTHY);
      },
    });
    return { fetch: fetchMock, reads: () => reads };
  }

  beforeEach(() => {
    evictAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the second, successful read — not the first, failed one', async () => {
    const { fetch: fetchMock, reads } = localModelsFailingFirst(1);
    vi.stubGlobal('fetch', fetchMock);

    render(<UsageSection />);
    await waitFor(() => expect(card('Local')).toBeInTheDocument(), { timeout: 5000 });

    const local = card('Local');
    expect(within(local).getByText('Installed, not loaded')).toBeInTheDocument();
    expect(within(local).getByText('0 resident · 12 installed')).toBeInTheDocument();
    // The verdict from the FIRST read must be nowhere on the card.
    expect(within(local).queryByText('Runtime unreachable')).not.toBeInTheDocument();
    expect(within(local).queryByText('ollama-unreachable')).not.toBeInTheDocument();
    expect(reads()).toBeGreaterThan(1);
  });

  it('does not re-read a route that answered 404 — that is not a probe failure', async () => {
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/verse/local-models': () => {
          reads += 1;
          return new Response('nope', { status: 404 });
        },
      }),
    );
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText(/missing source, not an empty machine/)).toBeInTheDocument());
    expect(reads).toBe(1);
  });

  it('still says unreachable — honestly — when every read reports it', async () => {
    const { fetch: fetchMock } = localModelsFailingFirst(Number.POSITIVE_INFINITY);
    vi.stubGlobal('fetch', fetchMock);

    render(<UsageSection />);
    await waitFor(() => expect(card('Local')).toBeInTheDocument(), { timeout: 8000 });

    const local = card('Local');
    expect(within(local).getByText('Runtime unreachable')).toBeInTheDocument();
    // The machine code is evidence beside the sentence, never the sentence.
    expect(within(local).getByText(/unanswered probe, not a report that the machine is empty/)).toBeInTheDocument();
    expect(within(local).getByText('ollama-unreachable')).toBeInTheDocument();
    // …and no 0% meter, because an unanswered probe is not a reading of zero.
    expect(within(local).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(local).queryByText('0%')).not.toBeInTheDocument();
  }, 10_000);

  it('corrects a stuck unreachable card when Refresh is pressed', async () => {
    const user = userEvent.setup();
    // Enough failures that the section's own retries are exhausted on mount,
    // so the card genuinely lands on "unreachable" — the state the operator
    // sees and then tries to clear with the Refresh button.
    const { fetch: fetchMock } = localModelsFailingFirst(3);
    vi.stubGlobal('fetch', fetchMock);

    render(<UsageSection />);
    await waitFor(() => expect(within(card('Local')).getByText('Runtime unreachable')).toBeInTheDocument(), {
      timeout: 8000,
    });

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(within(card('Local')).getByText('Installed, not loaded')).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(within(card('Local')).getByText('0 resident · 12 installed')).toBeInTheDocument();
    expect(within(card('Local')).queryByText('ollama-unreachable')).not.toBeInTheDocument();
  }, 15_000);
});

describe('UsageSection — token output and spend', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', routes());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('charts tokens in/out and estimated spend, labelling the estimate', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Token output and spend')).toBeInTheDocument());
    expect(screen.getByRole('img', { name: /Tokens in and out per day over last 7 days/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Estimated spend per day over last 7 days/i })).toBeInTheDocument();
    // Both the series panel and the cloud-spend tile carry the disclosure now:
    // the tile's figure is the same static price-table estimate.
    expect(screen.getAllByText(/ESTIMATED from a static price table/).length).toBeGreaterThan(0);
    expect(screen.getByText('Estimated spend · 7d')).toBeInTheDocument();
  });

  it('carries the Codex cache caveat next to every cache chart', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(screen.getAllByText('Cache hit rate').length).toBeGreaterThan(0));
    // Both cache charts — the hit RATE and the read/write TOKEN counts — carry
    // it: the Codex zeros distort each of them, and a caveat on only one would
    // leave the other reading as a complete picture.
    expect(screen.getAllByText(/hardcoded 0 upstream/).length).toBe(2);
  });

  it('labels localSavingsUsd as the flat heuristic it is', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Not spent (ran locally)')).toBeInTheDocument());
    expect(screen.getByText(/\$3 per 1M local tokens/)).toBeInTheDocument();
  });

  it('switches to the 30d window on demand', async () => {
    const user = userEvent.setup();
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Token output and spend')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '30d' }));
    await waitFor(() => expect(screen.getByText('Tokens in · 30d')).toBeInTheDocument());
  });

  it('refuses the cache chart when no day reported a rate', async () => {
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/verse/usage-series': () =>
          json({
            window: '7d',
            days: [
              { day: '2026-09-18', tokensIn: 5, tokensOut: 1, estCostUsd: 0.1, sessions: 1 },
              { day: '2026-09-19', tokensIn: 6, tokensOut: 2, estCostUsd: 0.2, sessions: 2 },
            ],
          }),
      }),
    );
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText(/absent signal, not a 0% hit rate/)).toBeInTheDocument());
    expect(screen.queryByRole('img', { name: /Cache hit rate per day/ })).not.toBeInTheDocument();
  });

  it('says the series route is missing rather than inventing a chart', async () => {
    vi.stubGlobal('fetch', routes({ '/api/verse/usage-series': () => new Response('nope', { status: 404 }) }));
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Token output and spend')).toBeInTheDocument());
    expect(screen.getByText(/does not expose \/api\/verse\/usage-series/)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Tokens in and out per day/ })).not.toBeInTheDocument();
  });
});

describe('UsageSection — degraded, empty, error and unauthorized states', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', routes());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the seat roster, and says so, when /api/verse/accounts is absent', async () => {
    vi.stubGlobal('fetch', routes({ '/api/verse/accounts': () => new Response('nope', { status: 404 }) }));
    render(<UsageSection />);
    await waitFor(() => expect(card('Claude Max')).toBeInTheDocument());
    expect(screen.getByText(/derived from the seat roster and the per-engine snapshots/)).toBeInTheDocument();
    // The ledger-derived 35% from /api/usage must never surface as a window.
    expect(within(card('Claude Max')).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(card('Claude Max')).queryByText('35%')).not.toBeInTheDocument();
  });

  it('shows a skeleton before anything resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { container } = render(<UsageSection />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('shows an error state with a retry when both aggregate sources fail', async () => {
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/usage': () => new Response('boom', { status: 500 }),
        '/api/control': () => new Response('boom', { status: 500 }),
      }),
    );
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Usage sources unreachable')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows the unauthorized state when the read session has expired', async () => {
    vi.stubGlobal('fetch', routes({ '/api/': () => new Response('nope', { status: 401 }) }));
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Read session expired')).toBeInTheDocument());
    expect(screen.queryByText('Dispatch limits')).not.toBeInTheDocument();
  });

  it('says plainly when no account and no local runtime were reported', async () => {
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/verse/accounts': () => json({ sampledAt: null, refreshing: false, accounts: [] }),
        '/api/verse/local-models': () => new Response('nope', { status: 404 }),
        '/api/verse/bootstrap': () => json({ ...BOOTSTRAP, seats: [] }),
      }),
    );
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText(/empty roster, not a set of accounts at zero/)).toBeInTheDocument());
  });

  it('still shows dispatch limits and the budget line from the older routes', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Dispatch limits')).toBeInTheDocument());
    expect(screen.getByText('50 / 200')).toBeInTheDocument();
    expect(screen.getByText('configured 10')).toBeInTheDocument();
    expect(screen.getByText('$4.25')).toBeInTheDocument();
  });

  it('does not draw the daemon tick ledger a second time when the real series is on screen', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Spend')).toBeInTheDocument());
    expect(screen.getByText(/daemon tick ledger is not\s+drawn again here/)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Autonomous loop spend per day' })).not.toBeInTheDocument();
  });
});

describe('UsageSection — the capacity strip', () => {
  it('answers "what can I run right now" in one line, over the whole roster', async () => {
    render(<UsageSection />);
    // Claude is blocked by its per-model week; Codex A is fully used but has a
    // spendable balance, so it is USABLE; Codex B is at 31%; Grok is signed
    // out; the local seat is resident. Three of five.
    await waitFor(() =>
      expect(screen.getByText(/3 of 5 seats are usable right now\./)).toBeInTheDocument(),
    );
  });

  it('gives every seat a state WORD, not just a tint', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(screen.getAllByText('usable').length).toBe(3));
    expect(screen.getAllByText('blocked').length).toBe(2);
  });

  /**
   * Codex publishes a real reset instant; Claude publishes a sentence. The
   * strip must use the first as a countdown and print the second verbatim —
   * and it must never claim "no reset" when a dated one exists.
   */
  it('keeps the dated reset and the prose reset in separate channels', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Nearest reset')).toBeInTheDocument());
    expect(screen.queryByText(/absent timestamp, not "never"/)).not.toBeInTheDocument();
    expect(screen.getByText('Resets reported as text')).toBeInTheDocument();
    expect(
      screen.getAllByText(/resets Sep 25 at 7pm \(America\/New_York\)/).length,
    ).toBeGreaterThan(0);
  });

  it('reports local headroom against the machine budget rather than as a bare count', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Local headroom')).toBeInTheDocument());
    // 128 GB budget, 64 GB resident.
    expect(screen.getByText(/free of 128 GB/)).toBeInTheDocument();
  });

  it('counts the models that can actually drive a session, apart from the rest', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(screen.getByText('Agentic locally')).toBeInTheDocument());
    expect(screen.getByText(/of 2 installed models can drive a session/)).toBeInTheDocument();
  });
});

describe('UsageSection — per-account depth on demand', () => {
  it('opens every window of an account from its card, not just the binding one', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(card('Claude Max')).toBeInTheDocument());
    await userEvent.click(within(card('Claude Max')).getByRole('button', { name: /Claude Max/ }));
    expect(await screen.findByText('All windows (3)')).toBeInTheDocument();
    expect(screen.getByText('Probe evidence')).toBeInTheDocument();
  });

  it('refuses to draw a history no source retains', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(card('Work Codex')).toBeInTheDocument());
    await userEvent.click(within(card('Work Codex')).getByRole('button', { name: /Work Codex/ }));
    expect(await screen.findByText(/No per-account history is retained/)).toBeInTheDocument();
  });

  /**
   * The detail view shows the credit balance as a fact INDEPENDENT of the
   * window: Codex A's week is fully used and it is still spendable.
   */
  it('shows credits beside a fully used window without calling the account blocked', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(card('Personal Codex')).toBeInTheDocument());
    await userEvent.click(within(card('Personal Codex')).getByRole('button', { name: /Personal Codex/ }));
    const detail = (await screen.findByText('Probe evidence')).closest('section');
    expect(detail).not.toBeNull();
    expect(within(detail!).getByText('2,048.42')).toBeInTheDocument();
  });

  it('closes the detail again', async () => {
    render(<UsageSection />);
    await waitFor(() => expect(card('Work Codex')).toBeInTheDocument());
    const trigger = within(card('Work Codex')).getByRole('button', { name: /Work Codex/ });
    await userEvent.click(trigger);
    expect(await screen.findByText('Probe evidence')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Probe evidence')).not.toBeInTheDocument());
  });
});
