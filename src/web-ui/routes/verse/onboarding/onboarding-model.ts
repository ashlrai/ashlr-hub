/**
 * routes/verse/onboarding/onboarding-model.ts — the first-run tour's facts,
 * derived from the same reads the Usage section uses, with the same honesty
 * rules (docs/VERSE-TELEMETRY-V2.md).
 *
 * Pure: no React, no I/O. Everything the tour asserts about the machine is
 * computed here so it can be tested without a DOM, and so the one rule that
 * matters is enforced in one place:
 *
 *   AN ABSENT READ IS "UNKNOWN", NEVER "FINE" AND NEVER "BROKEN".
 *
 * A first-run screen is exactly where a confident lie does the most damage —
 * it is the operator's first and only calibration of how much this app's
 * claims can be trusted. So a route that 404s, a payload that does not
 * narrow, and a probe that could not reach a runtime each produce their own
 * sentence, and none of them produces a green check.
 *
 * The tour NEVER renders a reconnect command it invented. `Account.
 * reconnectCommand` is already sanitized by usage-contract.ts's
 * `sanitizeCommand` (which is itself a backstop on the server's stripping),
 * and a native-profile launcher argv is withheld on purpose — where that is
 * the case the server says so in `notes`, and the tour shows the note rather
 * than a command.
 */
import type { Account, AccountsSnapshot, LocalModelsSnapshot } from '../usage/usage-contract.js';

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type OnboardingStepId = 'welcome' | 'accounts' | 'local' | 'stops' | 'finish';

export interface OnboardingStepMeta {
  id: OnboardingStepId;
  /** Shown as the card's heading. */
  title: string;
  /** One line under the heading. */
  subtitle: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStepMeta[] = [
  {
    id: 'welcome',
    title: 'Welcome to Verse',
    subtitle: 'Five sections, one rail. Two minutes and you will know what each one does.',
  },
  {
    id: 'accounts',
    title: 'Your seats',
    subtitle: 'Which provider accounts this machine can actually dispatch to right now.',
  },
  {
    id: 'local',
    title: 'Local runtime',
    subtitle: 'Whether there is a model on this machine, and what that changes.',
  },
  {
    id: 'stops',
    title: 'Three ways to stop',
    subtitle: 'They do not have the same blast radius. This is the one screen that says so.',
  },
  {
    id: 'finish',
    title: 'Make it yours',
    subtitle: 'Theme, accent, density and font live in Settings. Then start a chat.',
  },
];

export function clampStep(step: number): number {
  if (!Number.isFinite(step)) return 0;
  return Math.min(ONBOARDING_STEPS.length - 1, Math.max(0, Math.trunc(step)));
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type FindingTone = 'ok' | 'attention' | 'unknown';

export interface AccountFinding {
  id: string;
  label: string;
  provider: Account['provider'];
  tone: FindingTone;
  /** Short state word shown next to the label. Never a colour on its own. */
  state: string;
  /** One plain sentence: what is true, and when it is not ok, what to do. */
  detail: string;
  /** A sanitized command the operator can run, when the server offered one. */
  fix: string | null;
}

export interface AccountsFindings {
  /** Null when the read has not resolved or the route is absent. */
  findings: AccountFinding[] | null;
  /** Headline sentence for the step. Always present. */
  summary: string;
  /** Set when the roster itself is not trustworthy. */
  caveat: string | null;
  signedOutCount: number;
}

const PROVIDER_RECONNECT: Record<Account['provider'], string> = {
  claude: 'Sign back in with the Claude CLI on this machine, then reopen Verse.',
  codex: 'Sign back in with the Codex CLI on this machine, then reopen Verse.',
  grok: 'Reconnect the Grok seat through `ashlr resources`.',
};

function accountFinding(account: Account): AccountFinding {
  const label = account.label || account.id;
  const base = { id: account.id, label, provider: account.provider };

  if (account.authentication === 'signed-out' || account.state === 'signed-out') {
    return {
      ...base,
      tone: 'attention',
      state: 'signed out',
      detail:
        account.reason ??
        account.notes[0] ??
        `Verse cannot dispatch to ${label} until this seat is signed in again.`,
      fix: account.reconnectCommand ?? PROVIDER_RECONNECT[account.provider],
    };
  }

  if (account.unsupported) {
    return {
      ...base,
      tone: 'attention',
      state: 'probe blocked',
      detail:
        `The usage probe for ${label} is pinned to a specific CLI build` +
        (account.unsupported.pinnedVersion ? ` (${account.unsupported.pinnedVersion})` : '') +
        ' and this machine is running a different one, so its quota is unreadable. The seat itself still works.',
      fix: null,
    };
  }

  if (account.state === 'unavailable') {
    return {
      ...base,
      tone: 'unknown',
      state: 'no reading',
      detail: account.reason ?? `No usage reading came back for ${label}. That is not the same as a limit.`,
      fix: null,
    };
  }

  if (account.state === 'checking') {
    return { ...base, tone: 'unknown', state: 'checking', detail: `Still probing ${label}.`, fix: null };
  }

  const binding = account.binding;
  const limited = binding?.limitReached === true;
  const spendable = account.credits?.hasCredits === true || account.credits?.unlimited === true;

  if (limited && !spendable) {
    return {
      ...base,
      tone: 'attention',
      state: 'limit reached',
      detail: `${label} reported its limit reached. Pick another seat, or wait for the window to reset.`,
      fix: null,
    };
  }

  if (limited && spendable) {
    // The trap this surface must not fall into: a used-up window on an
    // account that still has a spendable balance is NOT blocked.
    return {
      ...base,
      tone: 'ok',
      state: 'usable on credits',
      detail: `${label} has used up its included window but still has a spendable balance, so it can still dispatch.`,
      fix: null,
    };
  }

  const percent = binding?.measured === true && typeof binding.usedPercent === 'number' ? binding.usedPercent : null;
  return {
    ...base,
    tone: 'ok',
    state: 'connected',
    detail:
      percent === null
        ? `${label} is signed in. No local utilization signal for this provider — that is expected, not a fault.`
        : `${label} is signed in, ${Math.round(percent)}% through its binding window.`,
    fix: null,
  };
}

export interface AccountsInput {
  /** Narrowed snapshot, or null when the route was absent or did not narrow. */
  snapshot: AccountsSnapshot | null;
  /** True while the read has produced nothing at all yet. */
  loading: boolean;
  /** Why the read could not be used, when the server or the client said. */
  unavailableReason: string | null;
}

export function buildAccountsFindings(input: AccountsInput): AccountsFindings {
  if (input.loading) {
    return { findings: null, summary: 'Checking which accounts this machine can reach…', caveat: null, signedOutCount: 0 };
  }
  if (!input.snapshot) {
    return {
      findings: null,
      summary: 'This server did not report a per-account roster, so Verse cannot say which seats are connected.',
      caveat: input.unavailableReason,
      signedOutCount: 0,
    };
  }

  const findings = input.snapshot.accounts.map(accountFinding);
  if (findings.length === 0) {
    return {
      findings,
      summary: 'No provider accounts are connected on this machine yet. Verse will still run local models.',
      caveat: input.snapshot.collectorNote,
      signedOutCount: 0,
    };
  }

  const signedOut = findings.filter((f) => f.state === 'signed out');
  const usable = findings.filter((f) => f.tone === 'ok');
  const summary =
    signedOut.length === 0
      ? `${usable.length} of ${findings.length} ${findings.length === 1 ? 'seat is' : 'seats are'} ready to dispatch.`
      : `${signedOut.length} ${signedOut.length === 1 ? 'seat is' : 'seats are'} signed out. Each one below says how to get it back.`;

  return { findings, summary, caveat: input.snapshot.collectorNote, signedOutCount: signedOut.length };
}

// ---------------------------------------------------------------------------
// Local runtime
// ---------------------------------------------------------------------------

export interface LocalFinding {
  tone: FindingTone;
  state: string;
  summary: string;
  /** What having (or not having) a local runtime means for the operator. */
  meaning: string;
  /** Present only when there is something to do about it. */
  fix: string | null;
  modelCount: number;
  toolCapableCount: number;
  /** True when this reading was retained from an earlier probe. */
  stale: boolean;
}

export interface LocalInput {
  snapshot: LocalModelsSnapshot | null;
  loading: boolean;
  unavailableReason: string | null;
}

const LOCAL_MEANING_AVAILABLE =
  'Local seats cost nothing and consume no provider quota, so the autonomous loop can keep working after a cloud window is used up.';
const LOCAL_MEANING_ABSENT =
  'Without one, every turn and every autonomous tick spends a provider account, and a used-up window stops the work.';

export function buildLocalFinding(input: LocalInput): LocalFinding {
  if (input.loading) {
    return {
      tone: 'unknown',
      state: 'checking',
      summary: 'Probing the local runtimes on this machine…',
      meaning: LOCAL_MEANING_AVAILABLE,
      fix: null,
      modelCount: 0,
      toolCapableCount: 0,
      stale: false,
    };
  }

  if (!input.snapshot) {
    return {
      tone: 'unknown',
      state: 'not reported',
      summary: 'This server does not report local runtimes, so Verse cannot say whether one is available here.',
      meaning: LOCAL_MEANING_ABSENT,
      fix: input.unavailableReason,
      modelCount: 0,
      toolCapableCount: 0,
      stale: false,
    };
  }

  const models = input.snapshot.models;
  const toolCapable = models.filter((m) => m.supportsTools === true).length;
  const stale = input.snapshot.runtimes.some((r) => r.stale);

  if (!input.snapshot.reachable) {
    return {
      tone: 'attention',
      state: 'unreachable',
      // "Not reachable" and "not installed" are different facts and the probe
      // cannot tell them apart — so this does not claim either one.
      summary:
        'No local runtime answered. Verse cannot tell whether one is not running or not installed — the probe only knows it got no answer.',
      meaning: LOCAL_MEANING_ABSENT,
      fix: 'Start Ollama (or LM Studio) and press Refresh in Usage. If neither is installed, everything still works — it all runs on the cloud seats.',
      modelCount: 0,
      toolCapableCount: 0,
      stale,
    };
  }

  if (models.length === 0) {
    return {
      tone: 'attention',
      state: 'no models',
      summary: 'A local runtime answered, but it has no models installed.',
      meaning: LOCAL_MEANING_ABSENT,
      fix: 'Pull a model into the runtime, then press Refresh in Usage.',
      modelCount: 0,
      toolCapableCount: 0,
      stale,
    };
  }

  return {
    tone: 'ok',
    state: stale ? 'available (retained reading)' : 'available',
    summary:
      `${models.length} local ${models.length === 1 ? 'model' : 'models'} available` +
      (toolCapable > 0 ? `, ${toolCapable} of them tool-capable.` : ', none of them tool-capable.') +
      (stale ? ' This is a retained reading, not a fresh probe.' : ''),
    meaning: toolCapable > 0
      ? LOCAL_MEANING_AVAILABLE
      : `${LOCAL_MEANING_AVAILABLE} A model that cannot call tools can answer, but cannot run an agentic turn.`,
    fix: null,
    modelCount: models.length,
    toolCapableCount: toolCapable,
    stale,
  };
}

// ---------------------------------------------------------------------------
// The three stops
// ---------------------------------------------------------------------------

export interface StopControl {
  name: string;
  /** What it halts. */
  scope: string;
  /** What it does NOT halt — the half people get wrong. */
  limit: string;
  reversible: string;
  tone: FindingTone;
}

/**
 * Verbatim against docs/VERSE-CONTRACT-V2.md's two footguns and the V2.1
 * amendment. The kill switch is never called a pause, and "Stop loop" is
 * stated as engaging the same global sentinel as the emergency control,
 * because it does (`stopDaemon()` is `setKill(true)`).
 */
export const STOP_CONTROLS: readonly StopControl[] = [
  {
    name: 'Pause',
    scope: 'Halts autonomous dispatch only. A running loop parks instead of exiting.',
    limit: 'Your own chats and the agent’s write tools keep working.',
    reversible: 'Reversible in one click, with no restart and no confirmation.',
    tone: 'ok',
  },
  {
    name: 'Stop loop',
    scope: 'Stops the daemon — and engages the GLOBAL kill switch while doing it.',
    limit: 'That means it also refuses the agent’s own write tools, exactly like the emergency control.',
    reversible: 'Reversible, but confirm-guarded. For an ordinary halt, use Pause.',
    tone: 'attention',
  },
  {
    name: 'Emergency stop',
    scope: 'Engages the global kill switch (~/.ashlr/KILL) directly.',
    limit: 'Every mutating path refuses: the loop, dispatch, and the agent’s own write tools.',
    reversible: 'Reversible, confirm-guarded, and deliberately separated from the other two.',
    tone: 'attention',
  },
];
