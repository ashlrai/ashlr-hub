/**
 * routes/verse/usage/accounts-model.ts — the "can I use this account right
 * now" decision, in one pure module.
 *
 * This view exists to answer ONE question at a glance, so this module turns
 * each account into a single verdict plus the evidence behind it. The rules
 * are not cosmetic; each one comes from a fact in docs/VERSE-TELEMETRY-V2.md
 * that a naive meter would get wrong:
 *
 *  1. THE BINDING WINDOW LEADS. An account is blocked by its *worst* window,
 *     not its average and not its first. Claude's weekly per-model window sat
 *     at 100% while all-models read 58% — showing 58% would be a lie of
 *     emphasis. The binding window is the headline; the others are secondary.
 *  2. CREDITS ARE NOT THE WINDOW. A Codex account at 100% of its weekly window
 *     with a spendable credit balance is USABLE. `verdict` therefore has a
 *     distinct `credits` state, and it never reads as blocked.
 *  3. SIGNED OUT IS AN ACTION, NOT A ZERO. A signed-out account has no
 *     measurement at all. It renders as an actionable state, never as a 0%
 *     meter and never as a bare "unknown".
 *  4. THE SENTINEL 100 IS A FLAG. `rateLimitReachedType` is written upstream
 *     as 100, which is not a measurement. It reads "limit reached", never
 *     "100% used".
 *  5. A VERSION-PINNED PROBE THAT FAILS CLOSED SAYS SO. Claude's probe is
 *     pinned; when it reports `usage-version-unsupported` the fix is a
 *     one-line constant bump, and a silent "unknown" would hide it.
 *
 * Nothing here converts an absent reading into 0, and nothing invents a
 * number the provider did not give.
 *
 * Pure: no React, no I/O, no currency/percent formatting (chartFormat owns
 * that).
 */
import type { ControlSnapshot, VerseBootstrap, VerseEngine } from '../../../data/api-types.js';
import type { FrontierUsage } from '../../../../core/usage/frontier-usage.js';
import type { Account, AccountWindow, LocalModelsSnapshot } from './usage-contract.js';
import { ENGINE_COLOR, resolveWindowSignal, WINDOW_SOURCE_LABEL, windowTone, type WindowTone } from './usage-model.js';

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export interface WindowView {
  id: string;
  label: string;
  /** 0–100, or null when there is no reading. NEVER a substituted 0. */
  usedPct: number | null;
  tone: WindowTone;
  /** Verbatim provider prose. Rendered as-is, never turned into a countdown. */
  resetText: string | null;
  /** True when the provider flagged the limit rather than measuring a percent. */
  limitReached: boolean;
}

/** Human names for the window ids the probes actually emit. */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: 'Session · rolling 5h',
  seven_day: 'Week · all models',
  seven_day_sonnet: 'Week · Sonnet',
  seven_day_opus: 'Week · Opus',
  seven_day_fable: 'Week · Fable',
  codex: 'Week · Codex',
  primary: 'Primary window',
  secondary: 'Secondary window',
};

export function windowLabel(w: AccountWindow): string {
  if (w.label) return w.label;
  const known = WINDOW_LABELS[w.id];
  if (known) return known;
  const perModel = /^seven_day_(.+)$/.exec(w.id);
  if (perModel) return `Week · ${perModel[1]}`;
  return w.id;
}

export function toWindowView(w: AccountWindow): WindowView {
  const reset = w.resetDescription ?? w.resetsAt;
  return {
    id: w.id,
    label: windowLabel(w),
    // A flagged limit is not a measurement, so it carries no percentage.
    usedPct: w.limitReached ? null : w.usedPercent,
    tone: w.limitReached ? 'danger' : w.usedPercent === null ? 'ok' : windowTone(w.usedPercent),
    resetText: reset,
    limitReached: w.limitReached,
  };
}

/**
 * The window that actually blocks work: the highest measured percent, with a
 * flagged limit outranking every measurement. The server computes this too;
 * we verify rather than trust, because a `binding` that is not one of
 * `windows` would silently desynchronize the headline from the detail.
 */
export function bindingWindow(account: Account): AccountWindow | null {
  const candidates = account.windows;
  const flagged = candidates.find((w) => w.limitReached);
  if (flagged) return flagged;

  const measured = candidates.filter((w) => w.usedPercent !== null);
  const computed =
    measured.length === 0
      ? null
      : measured.reduce((worst, w) => ((w.usedPercent ?? 0) > (worst.usedPercent ?? 0) ? w : worst));

  const served = account.binding;
  if (served) {
    // The server's `binding` is `{id, usedPercent, limitReached}` on the wire
    // (core `VerseAccountRecord['binding']`) — it carries NO label, no
    // `resetsAt` and no `nativeReport.resetDescription`. Returning it directly
    // dropped the reset line from the one meter the doc says must lead, and
    // for Claude that IS the entire reset signal: `resetsAt` is null by
    // construction and docs/VERSE-TELEMETRY-V2.md:133 requires the provider's
    // prose be rendered verbatim. AccountCard then filters the full window out
    // of `others` by id, so the prose appeared nowhere on the card. Resolve
    // the id back to this account's own full window; the server's CHOICE is
    // still honoured, only its stripped shape is not.
    const full = candidates.find((w) => w.id === served.id) ?? null;
    if (full) {
      if (served.limitReached || full.limitReached) return full;
      if (computed === null) return full;
      if ((served.usedPercent ?? -1) >= (computed.usedPercent ?? -1)) return full;
    }
  }
  return computed;
}

// ---------------------------------------------------------------------------
// Verdict — the two-second answer
// ---------------------------------------------------------------------------

export type AccountVerdictState =
  | 'available'
  | 'tight'
  | 'credits'
  | 'exhausted'
  | 'signed-out'
  | 'probe-unsupported'
  | 'unknown';

export interface AccountVerdict {
  state: AccountVerdictState;
  /** Short headline, e.g. "Usable now" — paired with a glyph, never color alone. */
  headline: string;
  /** One sentence of evidence. Always names WHY. Never a machine code. */
  detail: string;
  /**
   * The verbatim probe/collector code behind `detail`, on the states where
   * that code EXPLAINS an absent measurement (signed out, version-pinned, no
   * reading). It is shown as a secondary, clearly-machine line — never as the
   * sentence. Null on a state that HAS a reading, where the code would be
   * noise ("probe-observed") rather than evidence.
   */
  code: string | null;
}

/**
 * Plain-language copy for the machine-readable codes that actually reach this
 * surface.
 *
 * `reason` is a machine code BY CONTRACT on the producing side — core's
 * `VerseAccountRecord.reason` is documented "Machine-readable probe reason,
 * verbatim. Never rewritten into prose" — and this module used to render it as
 * the card's one sentence of evidence, so on a degraded collector every card
 * read headline "No reading", detail "connection-monitor-stopped". That tells
 * Mason nothing about what to do. The code is kept (it is the thing to search
 * for), but it is never the body text.
 *
 * Codes are matched exactly; anything unlisted falls through to the branch's
 * own prose rather than being printed raw.
 */
export const REASON_COPY: Record<string, string> = {
  'connection-monitor-stopped':
    'Native polling stopped after a metadata sample could not confirm its process cleanup, so these readings are frozen and no new ones are being taken. Restarting `ashlr verse` begins a new collection generation.',
  'collector-unavailable':
    'This server is not collecting native metadata, so nothing here is a live reading.',
  'collector-not-running':
    'No account collector is running in this server, so these cards fall back to whatever shared evidence exists.',
  'collector-owned':
    'Another collector (`ashlr resource-console`) owns the exclusive metadata lease, so Verse is reading its shared evidence rather than probing.',
  'collector-start-failed':
    'The metadata collectors could not be started in this server, so no probe has run.',
  'connection-polling-paused':
    'Native polling is paused because no client has asked for account data recently; it resumes on the next request.',
  'connection-not-checked':
    'No probe has run for this account yet in this server.',
  'connection-probe-unavailable':
    'The probe for this account did not return a usable result, so there is no measurement to show.',
  'accounts-pool-unavailable':
    'This accounts root has no readable pool or bindings, so there is nothing to probe.',
  'accounts-collection-not-configured':
    'Native account collection is not configured for this accounts root.',
  'usage-version-unsupported':
    'The usage probe is pinned to a specific provider build and failed closed on the installed one. That is a version pin, not an outage.',
  'usage-account-changed':
    'The account behind this profile changed between two reads, so the reading was discarded rather than attributed to the wrong account.',
  'probe-account-unavailable':
    'The pinned profile answered but carries no usable account identity — it is not authenticated.',
  'probe-account-unsupported':
    'The pinned profile is authenticated by a method this probe does not accept, so no reading was taken.',
  'probe-account-changed':
    'The account behind this pinned profile changed mid-probe, so the reading was discarded.',
  'probe-account-hint-mismatch':
    'The pinned profile is signed in as a different account than this seat expects.',
  'probe-native-unavailable':
    'The provider CLI for this pinned profile could not be run, so no reading was taken.',
  'probe-native-exit-failed':
    'The provider CLI for this pinned profile exited without a usable result.',
  'probe-provider-error':
    'The provider CLI returned an error instead of account metadata.',
  'probe-protocol-unsupported':
    'The installed provider CLI does not speak the metadata protocol this probe requires.',
  'probe-quota-invalid':
    'The provider returned a quota shape this probe does not recognise, so nothing was accepted as a reading.',
  'probe-timed-out':
    'The metadata probe for this account timed out before it returned anything.',
};

/** Prose for a code, or the branch's own sentence. NEVER the raw code. */
export function reasonSentence(reason: string | null, fallback: string): string {
  if (reason === null) return fallback;
  return REASON_COPY[reason] ?? fallback;
}

/** Ordering rank: what Mason can use comes first. */
const VERDICT_RANK: Record<AccountVerdictState, number> = {
  available: 0,
  credits: 1,
  tight: 2,
  exhausted: 3,
  'signed-out': 4,
  'probe-unsupported': 5,
  unknown: 6,
};

const TIGHT_AT = 80;
const FULL_AT = 100;

export function creditsSpendable(credits: Account['credits']): boolean {
  if (!credits) return false;
  if (credits.unlimited) return true;
  if (!credits.hasCredits) return false;
  return credits.balanceValue !== null && credits.balanceValue > 0;
}

function describeCredits(credits: NonNullable<Account['credits']>): string {
  if (credits.unlimited) return 'credits are unlimited on this plan';
  return `a credit balance of ${credits.balance ?? 'an unreported amount'} is still spendable`;
}

export function accountVerdict(account: Account, binding: AccountWindow | null): AccountVerdict {
  if (account.authentication === 'signed-out' || account.state === 'signed-out') {
    return {
      state: 'signed-out',
      headline: 'Signed out',
      detail: reasonSentence(
        account.reason,
        'The probe reached this account’s pinned profile but it is not authenticated, so there is nothing to measure.',
      ),
      code: account.reason,
    };
  }

  if (account.unsupported) {
    return {
      state: 'probe-unsupported',
      headline: 'Probe version-pinned',
      detail: `The usage probe failed closed with ${account.unsupported.code}${
        account.unsupported.pinnedVersion ? `; it is pinned to ${account.unsupported.pinnedVersion}` : ''
      }. This is a version pin, not an outage — no window can be read until the pin is bumped.`,
      code: account.unsupported.code,
    };
  }

  const spendable = creditsSpendable(account.credits);

  if (binding === null || (binding.usedPercent === null && !binding.limitReached)) {
    if (spendable && account.credits) {
      return {
        state: 'credits',
        headline: 'Usable on credits',
        detail: `No window reading reached this surface, but ${describeCredits(account.credits)}.`,
        code: account.reason,
      };
    }
    return {
      state: 'unknown',
      headline: 'No reading',
      detail: reasonSentence(
        account.reason,
        'No window percentage reached this surface for this account, so nothing here is a measurement.',
      ),
      code: account.reason,
    };
  }

  const pct = binding.usedPercent;
  const exhausted = binding.limitReached || (pct !== null && pct >= FULL_AT);
  const label = windowLabel(binding);

  if (exhausted) {
    if (spendable && account.credits) {
      return {
        state: 'credits',
        headline: 'Usable on credits',
        detail: `${label} is ${
          binding.limitReached ? 'reported as limit reached' : 'fully used'
        }, but ${describeCredits(account.credits)} — credits are independent of the window, so this account is not blocked.`,
        code: null,
      };
    }
    return {
      state: 'exhausted',
      headline: binding.limitReached ? 'Limit reached' : 'Window exhausted',
      detail: binding.limitReached
        ? `The provider flagged ${label} as rate-limited. That flag is a denial, not a measurement, so no percentage is shown.`
        : `${label} is at ${Math.round(pct as number)}% — it is the binding constraint on this account.`,
      code: null,
    };
  }

  if ((pct as number) >= TIGHT_AT) {
    return {
      state: 'tight',
      headline: 'Running tight',
      detail: `${label} is the binding constraint at ${Math.round(pct as number)}%.`,
      code: null,
    };
  }

  return {
    state: 'available',
    headline: 'Usable now',
    detail: `${label} is the binding constraint at ${Math.round(pct as number)}%.`,
    code: null,
  };
}

// ---------------------------------------------------------------------------
// Card model
// ---------------------------------------------------------------------------

export interface AccountCardModel {
  id: string;
  label: string;
  engine: VerseEngine;
  color: string;
  plan: string | null;
  verdict: AccountVerdict;
  /** The binding window, already viewified. Null when nothing was measured. */
  binding: WindowView | null;
  /** Every other window, in the order the provider reported them. */
  others: WindowView[];
  credits: Account['credits'];
  /** Safe-to-print command, or null. Never a launcher invocation. */
  reconnectCommand: string | null;
  observedAt: string | null;
  /** Sort rank; lower is more usable. */
  rank: number;
  /**
   * Where these windows came from, when that is not simply "this account's own
   * probe" — e.g. an engine-wide subscription-tracker reading shared by two
   * Codex accounts. Null when the reading is per-account by construction.
   */
  sourceNote: string | null;
}

export function buildAccountCard(account: Account, sourceNote: string | null = null): AccountCardModel {
  const binding = bindingWindow(account);
  const verdict = accountVerdict(account, binding);
  const engine: VerseEngine = account.provider;
  return {
    id: account.id,
    label: account.label,
    engine,
    color: ENGINE_COLOR[engine],
    plan: account.planType,
    verdict,
    binding: binding ? toWindowView(binding) : null,
    others: account.windows.filter((w) => w.id !== binding?.id).map(toWindowView),
    credits: account.credits,
    reconnectCommand: account.reconnectCommand,
    observedAt: account.observedAt,
    rank: VERDICT_RANK[verdict.state],
    sourceNote,
  };
}

/**
 * The server's plain-language caveats, deduplicated across accounts.
 *
 * These are per-account on the wire, but the same sentence is emitted for both
 * Codex accounts (and for every Claude window), so rendering them per card
 * would print the same fact three times. They belong to the panel, not the
 * card — they explain how to read every meter on it.
 */
export function collectAccountNotes(snapshot: { accounts: Account[] } | null): string[] {
  if (!snapshot) return [];
  const seen = new Set<string>();
  for (const account of snapshot.accounts) {
    for (const note of account.notes) seen.add(note);
  }
  return [...seen];
}

/** Most usable first; ties keep a stable alphabetical order so cards do not shuffle. */
export function buildAccountCards(snapshot: { accounts: Account[] } | null): AccountCardModel[] {
  if (!snapshot) return [];
  return snapshot.accounts
    .map((account) => buildAccountCard(account))
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Local availability as an account card
// ---------------------------------------------------------------------------

export interface LocalCardModel {
  /** Resident models, i.e. what can answer with no load delay. */
  residentCount: number;
  installedCount: number;
  residentBytes: number | null;
  memoryBudgetBytes: number | null;
  /** Resident bytes against the machine budget — the local analogue of a meter. */
  usedPct: number | null;
  tone: WindowTone;
  verdict: AccountVerdict;
  color: string;
  /** Same rank scale as an account card, so local sorts into the same grid. */
  rank: number;
}

export function buildLocalCard(snapshot: LocalModelsSnapshot | null): LocalCardModel | null {
  if (!snapshot) return null;
  const resident = snapshot.models.filter((m) => m.loaded);
  // Mirrors `buildLocalModelsView` in local-model.ts, deliberately: a resident
  // model with no reported size makes the TOTAL unknown. The old reduce
  // skipped those and still returned a sum, so with three resident models of
  // which one reported no size this meter drew a bar that under-read — and
  // understating a memory figure is exactly the quiet lie this surface
  // refuses. `usedPct` already degrades to null, which LocalCard renders as
  // the dashed unknown rule.
  //
  // An UNREACHABLE runtime is the other way to have no resident models, and it
  // is not the same fact as an idle one. The runtime never answered, so what
  // is resident is unknown — rendering that as `0` drew a real 0% meter and
  // the words "0 MB of 128 GB" under a card that had just said it could not
  // reach the runtime at all, which reads as a measurement. `null` sends it
  // through the same dashed unknown rule every other unreadable figure uses.
  const residentBytes = !snapshot.reachable
    ? null
    : resident.length === 0
      ? 0
      : resident.some((m) => m.sizeBytes === null)
        ? null
        : resident.reduce((acc, m) => acc + (m.sizeBytes ?? 0), 0);
  const budget = snapshot.memoryBudgetBytes;
  const usedPct =
    residentBytes !== null && budget !== null && budget > 0
      ? Math.max(0, Math.min(100, (residentBytes / budget) * 100))
      : null;

  // `snapshot.reason` is a MACHINE CODE by contract on the producing side
  // (`ollama-unreachable`, `lmstudio-probe-failed`) — never prose. Putting it
  // straight into `detail` made the card's only sentence the string
  // `ollama-unreachable`, which tells an operator nothing about what to do and
  // is the one thing on the card that looks like a diagnosis. It rides along
  // as `code` instead, exactly as a signed-out account's probe code does, and
  // the sentence says what happened in plain language.
  const verdict: AccountVerdict = !snapshot.reachable
    ? {
        state: 'unknown',
        headline: 'Runtime unreachable',
        detail:
          'No local runtime answered, so neither resident nor installed models can be listed. This is an unanswered probe, not a report that the machine is empty.',
        code: snapshot.reason,
      }
    : resident.length > 0
      ? {
          state: 'available',
          headline: 'Resident now',
          detail: `${resident.length} model${resident.length === 1 ? '' : 's'} already in memory — no load delay, no quota, no bill.`,
          code: null,
        }
      : snapshot.models.length > 0
        ? {
            state: 'tight',
            headline: 'Installed, not loaded',
            detail: `${snapshot.models.length} model${
              snapshot.models.length === 1 ? ' is' : 's are'
            } installed but nothing is resident, so the first turn pays a load.`,
            code: null,
          }
        : {
            state: 'unknown',
            headline: 'No models installed',
            detail: 'The runtime is reachable but reports no installed models.',
            code: null,
          };

  return {
    residentCount: resident.length,
    installedCount: snapshot.models.length,
    residentBytes,
    memoryBudgetBytes: budget,
    usedPct,
    tone: usedPct === null ? 'ok' : windowTone(usedPct),
    verdict,
    color: ENGINE_COLOR.local,
    rank: VERDICT_RANK[verdict.state],
  };
}

// ---------------------------------------------------------------------------
// Fallback: the same card model, built from the pre-V2 sources
// ---------------------------------------------------------------------------
//
// `/api/verse/accounts` is the real source and is per-account by construction.
// When it is absent (a server that predates it, or one that could not acquire
// the quota-refresh lease), this surface still has to answer the question, so
// it falls back to the seat roster plus the per-ENGINE snapshots — and it says
// so, because those are coarser: two Codex accounts share one engine row, and
// a reading that covers both is labelled engine-wide rather than pinned to one
// card. `resolveWindowSignal` carries the full provenance logic (see
// usage-model.ts); this adapter only reshapes its output so both paths render
// through one card component instead of two divergent ones.

export const FALLBACK_SOURCE_NOTE =
  'Per-account probes are unavailable on this server, so these cards are derived from the seat roster and the per-engine snapshots.';

function seatAccount(input: {
  seat: VerseBootstrap['seats'][number];
  control: ControlSnapshot | undefined;
  frontier: FrontierUsage | undefined;
  engineSeatCount: number;
}): { account: Account; sourceNote: string | null } | null {
  const { seat, control, frontier, engineSeatCount } = input;
  if (seat.engine === 'local') return null; // Local has its own panel and its own physics.

  const subscription = control?.subscriptionUsage?.find((e) => String(e.engine) === seat.engine);
  const engineUsage = frontier?.engines.find((e) => String(e.engine) === seat.engine);
  const signal = resolveWindowSignal({
    engine: seat.engine,
    seat,
    subscription,
    frontier: engineUsage,
    engineSeatCount,
  });

  const windows: AccountWindow[] =
    signal.kind === 'measured'
      ? signal.windows.map((w) => ({
          id: w.id,
          label: w.label,
          usedPercent: w.usedPct,
          resetsAt: w.resetsAt === null ? null : new Date(w.resetsAt * 1000).toISOString(),
          resetDescription: null,
          limitReached: false,
        }))
      : [];

  const account: Account = {
    id: seat.id,
    label: seat.label,
    provider: seat.engine,
    state: signal.kind === 'measured' ? 'observed' : 'unavailable',
    authentication: 'unknown',
    planType: subscription?.plan ?? null,
    observedAt: seat.health.observedAt,
    windows,
    binding: null,
    credits: null,
    reason: signal.kind === 'measured' ? null : signal.reason,
    unsupported: null,
    reconnectCommand: null,
    notes: [],
  };

  const sourceNote =
    signal.kind === 'measured'
      ? `${WINDOW_SOURCE_LABEL[signal.source]}${
          signal.scope === 'engine' ? ' · engine-wide, shared by every account on this engine' : ''
        }`
      : null;

  return { account, sourceNote };
}

export function buildFallbackAccountCards(input: {
  bootstrap: VerseBootstrap | undefined;
  control: ControlSnapshot | undefined;
  frontier: FrontierUsage | undefined;
}): AccountCardModel[] {
  const seats = input.bootstrap?.seats ?? [];
  const perEngineCount = new Map<string, number>();
  for (const seat of seats) perEngineCount.set(seat.engine, (perEngineCount.get(seat.engine) ?? 0) + 1);

  return seats
    .map((seat) =>
      seatAccount({
        seat,
        control: input.control,
        frontier: input.frontier,
        engineSeatCount: perEngineCount.get(seat.engine) ?? 1,
      }),
    )
    .filter((entry): entry is { account: Account; sourceNote: string | null } => entry !== null)
    .map((entry) => buildAccountCard(entry.account, entry.sourceNote))
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}
