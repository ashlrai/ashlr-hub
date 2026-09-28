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
import { displaySurfaceTarget, evaluateStandingAuthority } from '../authority/effective-config.js';
import { readClamp } from '../authority/clamp.js';
import type { EffectivePolicy } from '../authority/types.js';
import { killSwitchOn } from '../sandbox/policy.js';

const CACHE_MS = 10_000;

interface Entry {
  at: number;
  kill: boolean;
  switch: string;
  policy: EffectivePolicy | null;
  expiresAtMs: number | null;
}

let cached: Entry | null = null;

export function displayStandingPolicy(nowMs: number = Date.now()): EffectivePolicy | null {
  try {
    const kill = killSwitchOn();
    if (kill) return null;
    const sw = readClamp().clamp.switch;
    const stale = cached === null
      || nowMs - cached.at > CACHE_MS
      || nowMs < cached.at
      || cached.kill !== kill
      || cached.switch !== sw;
    if (stale) {
      const ev = evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget(), nowMs });
      const policy = ev.grantState === 'active' && ev.policy && ev.grant ? ev.policy : null;
      cached = { at: nowMs, kill, switch: sw, policy, expiresAtMs: ev.grant ? Date.parse(ev.grant.expiresAt) : null };
    }
    const entry = cached!;
    if (!entry.policy) return null;
    if (entry.expiresAtMs === null || !Number.isFinite(entry.expiresAtMs) || nowMs >= entry.expiresAtMs) return null;
    return entry.policy;
  } catch {
    return null;
  }
}

/** Test hook: drop the cached evaluation. */
export function resetDisplayStandingPolicyForTest(): void {
  cached = null;
}
