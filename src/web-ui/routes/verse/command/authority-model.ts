/**
 * routes/verse/command/authority-model.ts — the pure decisions behind the
 * Command top bar (unit C7; SPEC-310B §0 I1 + §6, SPEC-310C §5).
 *
 * I1 is the whole design: ONLY a grant signed under Touch ID raises
 * authority; LOWERING is instant and needs no auth. So every click on the
 * switch is classified before anything is sent:
 *
 *   lower            → POST at once (Off is always one click away);
 *   raise            → POST at once, but only up to `maxSwitchWithoutGrant`
 *                      — the installed grant already allows it;
 *   raise-needs-grant→ nothing is sent; the Touch ID sheet opens with the
 *                      draft grant's full scope and expiry. The server is
 *                      still the authority (409 `grant-required` on a stale
 *                      page) — this only keeps the page from asking for
 *                      something it knows will be refused.
 *
 * Framework-free; tested directly.
 */
import type { AuthorityGrantDraft, AuthorityStatusV1, AutonomySwitch, GrantState } from '../../../../core/authority/types.js';
import { darkSinceLabel } from '../fleet/dark-since.js';

export const SWITCH_RANK: Readonly<Record<AutonomySwitch, number>> = { off: 0, propose: 1, autonomous: 2 };

export const SWITCH_LABEL: Readonly<Record<AutonomySwitch, string>> = {
  off: 'Off',
  propose: 'Propose',
  autonomous: 'Autonomous',
};

/** Short labels for the 375 px bar (same order, same meaning). */
export const SWITCH_SHORT: Readonly<Record<AutonomySwitch, string>> = {
  off: 'Off',
  propose: 'Propose',
  autonomous: 'Auto',
};

export const SWITCH_ORDER: readonly AutonomySwitch[] = ['off', 'propose', 'autonomous'];

export type SwitchChange = 'same' | 'lower' | 'raise' | 'raise-needs-grant';

/** What a click on `to` means, given the status the page last read. */
export function classifySwitch(status: Pick<AuthorityStatusV1, 'switch' | 'maxSwitchWithoutGrant'>, to: AutonomySwitch): SwitchChange {
  const from = SWITCH_RANK[status.switch];
  const target = SWITCH_RANK[to];
  if (target === from) return 'same';
  if (target < from) return 'lower';
  return target <= SWITCH_RANK[status.maxSwitchWithoutGrant] ? 'raise' : 'raise-needs-grant';
}

export interface SwitchOption {
  value: AutonomySwitch;
  label: string;
  short: string;
  /** Selecting it opens the Touch ID sheet instead of switching. */
  needsGrant: boolean;
  /** Spoken name, carrying the grant requirement in words. */
  ariaLabel: string;
}

export function switchOptions(status: Pick<AuthorityStatusV1, 'switch' | 'maxSwitchWithoutGrant'>): SwitchOption[] {
  return SWITCH_ORDER.map((value) => {
    const needsGrant = SWITCH_RANK[value] > Math.max(SWITCH_RANK[status.switch], SWITCH_RANK[status.maxSwitchWithoutGrant]);
    return {
      value,
      label: SWITCH_LABEL[value],
      short: SWITCH_SHORT[value],
      needsGrant,
      ariaLabel: needsGrant ? `${SWITCH_LABEL[value]} (needs a new grant — Touch ID)` : SWITCH_LABEL[value],
    };
  });
}

// ---------------------------------------------------------------------------
// Grant chip
// ---------------------------------------------------------------------------

export type ChipTone = 'neutral' | 'success' | 'warning' | 'danger' | 'unknown';

export interface GrantChip {
  label: string;
  tone: ChipTone;
  /** Longer sentence for the tooltip / accessible description. */
  detail: string;
  /** Clicking the chip opens the Touch ID sheet for this action; null = informational. */
  action: 'grant' | 're-approve' | null;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** "23d", "2d 4h", "5h", "40m" — time left, coarse on purpose (it is a chip). */
export function timeLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  if (ms >= 3 * DAY) return `${Math.floor(ms / DAY)}d`;
  if (ms >= DAY) {
    const d = Math.floor(ms / DAY);
    const h = Math.floor((ms - d * DAY) / HOUR);
    return h ? `${d}d ${h}h` : `${d}d`;
  }
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

const STATE_WORDS: Record<GrantState, string> = {
  none: 'No grant',
  active: 'Active',
  paused: 'Paused, re-approve',
  expired: 'Expired, renew',
  revoked: 'Revoked, new grant',
  invalid: 'Grant invalid',
};

export function grantChip(status: AuthorityStatusV1 | null, now: number): GrantChip {
  if (!status) return { label: 'Grant unknown', tone: 'unknown', detail: 'The authority service did not answer, so the grant state is unknown.', action: null };
  const g = status.grant;
  switch (g.state) {
    case 'active': {
      const expires = g.expiresAt ? Date.parse(g.expiresAt) : NaN;
      if (!Number.isFinite(expires)) return { label: 'Active', tone: 'success', detail: 'A grant is active; its expiry could not be read.', action: null };
      const left = expires - now;
      const tone: ChipTone = left < DAY ? 'danger' : left < 3 * DAY ? 'warning' : 'success';
      return {
        label: timeLeft(left),
        tone,
        detail: `Grant active until ${new Date(expires).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${left < 3 * DAY ? ' — renew soon' : ''}.`,
        action: left < 3 * DAY ? 'grant' : null,
      };
    }
    case 'paused':
      return { label: STATE_WORDS.paused, tone: 'warning', detail: g.reason ?? 'The grant is paused until you re-approve it.', action: 're-approve' };
    case 'expired':
      return { label: STATE_WORDS.expired, tone: 'danger', detail: g.reason ?? 'The grant expired; autonomy is dark until a new one is signed.', action: 'grant' };
    case 'revoked':
      return { label: STATE_WORDS.revoked, tone: 'danger', detail: g.reason ?? 'The grant was revoked; a new one needs Touch ID.', action: 'grant' };
    case 'invalid':
      return { label: STATE_WORDS.invalid, tone: 'danger', detail: g.reason ?? 'The installed grant failed verification.', action: 'grant' };
    case 'none':
    default:
      return { label: STATE_WORDS.none, tone: 'neutral', detail: 'No standing grant is installed; autonomy can only propose.', action: 'grant' };
  }
}

// ---------------------------------------------------------------------------
// Verdict line
// ---------------------------------------------------------------------------

export interface VerdictInputs {
  authority: AuthorityStatusV1 | null;
  /** FleetLiveSummary fields, null = unknown. */
  building: number | null;
  mergedToday: number | null;
  revertsToday: number | null;
  /** "Claude" and the percent reserved for Mason on that seat; null = unknown / no such seat. */
  reserve: { label: string; percent: number } | null;
  /**
   * THE dark-since instant — `fleetDarkSince(live)` (fleet/dark-since.ts),
   * null unless the fleet is dark. Never fleet history's "quiet since": an
   * idle fleet that has not produced lately is not dark.
   */
  darkSince: string | null;
}

export interface VerdictPart {
  key: string;
  text: string;
  tone?: ChipTone;
}

/** The mode word first: what autonomy is doing right now, in one word. */
export function modeWord(authority: AuthorityStatusV1 | null): VerdictPart {
  if (!authority) return { key: 'mode', text: 'Autonomy unknown', tone: 'unknown' };
  if (authority.kill) return { key: 'mode', text: 'Stopped', tone: 'danger' };
  if (authority.grant.state === 'paused') return { key: 'mode', text: 'Paused, re-approve', tone: 'warning' };
  return { key: 'mode', text: SWITCH_LABEL[authority.effectiveSwitch], tone: authority.effectiveSwitch === 'autonomous' ? 'success' : 'neutral' };
}

/**
 * "Autonomous · 5 building · 7 merged today · 0 reverts · Claude 46%
 * reserved for you". A number that is unknown is LEFT OUT rather than shown
 * as 0 (the line would otherwise claim "0 reverts" it never counted); when
 * the whole fleet read is missing the line says so instead.
 */
export function verdictParts(v: VerdictInputs): VerdictPart[] {
  const parts: VerdictPart[] = [modeWord(v.authority)];
  const anyFleet = v.building !== null || v.mergedToday !== null || v.revertsToday !== null;
  if (v.darkSince && !(v.building && v.building > 0)) {
    // The same local-day label the Fleet surface's dark charts use.
    parts.push({ key: 'dark', text: `fleet dark since ${darkSinceLabel(v.darkSince)}`, tone: 'neutral' });
  } else if (!anyFleet) {
    parts.push({ key: 'fleet', text: 'fleet status unknown', tone: 'unknown' });
  } else {
    if (v.building !== null) parts.push({ key: 'building', text: `${v.building} building` });
    if (v.mergedToday !== null) parts.push({ key: 'merged', text: `${v.mergedToday} merged today` });
    if (v.revertsToday !== null) parts.push({ key: 'reverts', text: `${v.revertsToday} revert${v.revertsToday === 1 ? '' : 's'}`, tone: v.revertsToday > 0 ? 'warning' : undefined });
  }
  if (v.reserve) parts.push({ key: 'reserve', text: `${v.reserve.label} ${Math.round(v.reserve.percent)}% reserved for you` });
  return parts;
}

/**
 * Which POST signs a draft: the DRAFT's own `kind` decides (B-U1: GET
 * /api/verse/authority/draft answers with `kind`, and POST refuses a digest
 * whose kind does not match the action). The clicked intent is only the
 * fallback for a server that sends no kind — a grant that is no longer
 * continuable is drafted as a NEW one, and signing it must say so.
 */
export function actionForDraft(draft: AuthorityGrantDraft, fallback: 'grant' | 're-approve'): 'grant' | 're-approve' {
  const kind = (draft as AuthorityGrantDraft & { kind?: unknown }).kind;
  if (kind === 'new') return 'grant';
  if (kind === 'reapprove') return 're-approve';
  return fallback;
}

/**
 * What Stop actually did, in one sentence (B-U6 → C: the Stop UI shows the
 * drain result). The POST answers with the status plus `result.stop`
 * (authority/clamp.ts StopResult). Stop from Verse never waits, so agents
 * admitted before it may still be finishing; that is said with the count,
 * never as "stopped" alone. Unknown leases are counted as live upstream
 * (fail closed). Null when the response carries no stop result.
 */
export function stopOutcomeSentence(response: unknown): string | null {
  if (response === null || typeof response !== 'object') return null;
  const stop = (response as { result?: { stop?: unknown } }).result?.stop;
  if (stop === null || typeof stop !== 'object') return null;
  const r = stop as { quiesced?: unknown; liveExecutionLeases?: unknown; mergesRevoked?: unknown; mergeRevokeFailures?: unknown };
  const live = typeof r.liveExecutionLeases === 'number' && Number.isFinite(r.liveExecutionLeases) ? Math.max(0, Math.round(r.liveExecutionLeases)) : null;
  const parts: string[] = [];
  if (r.quiesced === true || live === 0) parts.push('Stopped. No agent is still running.');
  else if (live !== null) parts.push(`Stopped. ${live} agent${live === 1 ? '' : 's'} started before Stop ${live === 1 ? 'is' : 'are'} still finishing; no new work starts.`);
  else parts.push('Stopped. Agents started before Stop may still be finishing; no new work starts.');
  if (typeof r.mergesRevoked === 'number' && r.mergesRevoked > 0) {
    parts.push(`${r.mergesRevoked} armed merge${r.mergesRevoked === 1 ? ' was' : 's were'} revoked.`);
  }
  const failed = Array.isArray(r.mergeRevokeFailures) ? r.mergeRevokeFailures.length : 0;
  if (failed > 0) parts.push(`${failed} armed merge${failed === 1 ? '' : 's'} could not be revoked; Stop still blocks ${failed === 1 ? 'it' : 'them'}.`);
  return parts.join(' ');
}
