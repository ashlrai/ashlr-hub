/**
 * The standing policy as a DISPLAY sees it — never an authorization.
 *
 * `currentStandingPolicy()` verifies the authority code of the process that
 * calls it (surface `running`). That is right for anything that acts. It is
 * wrong for Verse's read-only cards: the desktop sidecar is a Bun single-file
 * binary, which cannot vouch for its own authority code, so the evaluation
 * comes back `surface-unverified` → policy null in the app every time. The
 * Command card then said "Fleet is dark · No standing grant is in force" while
 * the header chip — which evaluates against the installed daemon release
 * (`displaySurfaceTarget()`, authority-api.ts buildAuthorityStatus) — said
 * "GRANT 29d" (live, Verse 3.14.0, 2026-09-27).
 *
 * This evaluates exactly what the header chip evaluates, so every display
 * surface agrees. In a compiled release `displaySurfaceTarget()` is `running`,
 * i.e. the same verdict currentStandingPolicy() gives. Stop and the switch are
 * re-read on every call (lowering shows at once); the rest is cached 10 s.
 *
 * Callers MUST NOT gate an action on this (launches, applies, merges): they
 * keep currentStandingPolicy(). Never throws; null on any failure.
 */
import { displaySurfaceTarget, evaluateStandingAuthority, type StandingPolicyReadiness } from '../authority/effective-config.js';
import { readClamp } from '../authority/clamp.js';
import type { EffectivePolicy } from '../authority/types.js';
import { killSwitchOn } from '../sandbox/policy.js';

const CACHE_MS = 10_000;

interface Entry {
  at: number;
  kill: boolean;
  switch: string;
  policy: EffectivePolicy | null;
  grantState: StandingPolicyReadiness['grantState'];
  reason: string | null;
  expiresAtMs: number | null;
}

let cached: Entry | null = null;

export function displayStandingPolicy(nowMs: number = Date.now()): EffectivePolicy | null {
  return displayStandingPolicyReadiness(nowMs).policy;
}

/** The same display-only evaluation, retaining the reason when it is held. */
export function displayStandingPolicyReadiness(nowMs: number = Date.now()): StandingPolicyReadiness {
  try {
    const kill = killSwitchOn();
    if (kill) return { policy: null, grantState: null, reason: 'Stop is on.' };
    const sw = readClamp().clamp.switch;
    const stale = cached === null
      || nowMs - cached.at > CACHE_MS
      || nowMs < cached.at
      || cached.kill !== kill
      || cached.switch !== sw;
    if (stale) {
      const ev = evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget(), nowMs });
      const policy = ev.grantState === 'active' && ev.policy && ev.grant ? ev.policy : null;
      cached = { at: nowMs, kill, switch: sw, policy, grantState: ev.grantState,
        reason: policy ? null : ev.inactiveReason ?? ev.grantReason,
        expiresAtMs: ev.grant ? Date.parse(ev.grant.expiresAt) : null };
    }
    const entry = cached!;
    if (!entry.policy) return { policy: null, grantState: entry.grantState, reason: entry.reason };
    if (entry.expiresAtMs === null || !Number.isFinite(entry.expiresAtMs)) return { policy: null, grantState: entry.grantState, reason: null };
    if (nowMs >= entry.expiresAtMs) return { policy: null, grantState: 'expired', reason: 'The standing grant has expired.' };
    return { policy: entry.policy, grantState: entry.grantState, reason: null };
  } catch {
    return { policy: null, grantState: null, reason: null };
  }
}

/** Test hook: drop the cached evaluation. */
export function resetDisplayStandingPolicyForTest(): void {
  cached = null;
}
