/**
 * routes/verse/autonomy/autonomy-off-model.ts — the ONE "autonomy is off"
 * decision every fleet surface (Command, Fleet, Growth, Mind) renders.
 *
 * Before this, a dormant fleet showed up as a wall of identical empty cards
 * ("No fleet runs or proposals since Aug 18." six times on Growth, five dashes
 * on Command). Each surface now asks this model once and, when it answers,
 * shows a single state that says what is off, why it matters, and the one
 * thing that turns it back on.
 *
 * Precedence (first match wins):
 *   stopped — Stop is in force (authority `kill`, or the live view says so);
 *   setup   — no grant, and none can be drafted yet (the grant draft
 *             answers `no-trust-roots` / `custody-key-unknown`): the one-time
 *             `ashlr authority setup`;
 *   grant   — no grant, or it is paused, expired, revoked or invalid, and a
 *             new one can be drafted: approve it (Touch ID, on Command);
 *   off     — a grant is in force but the switch holds autonomy at Off;
 *   dark    — the live view is dark for another reason (daemon not running);
 *   paused  — the daemon is parked;
 *   quiet   — autonomy is on but nothing was produced lately (fleet
 *             history's "quiet since"); never worded "dark".
 * null — autonomy is on and producing (or nothing has answered yet).
 *
 * Only the live snapshot's `darkSince` may be worded "Fleet dark since …"
 * (fleet/dark-since.ts); history's date is "Nothing produced since …".
 *
 * Framework-free; tested directly.
 */
import type { AuthorityStatusV1 } from '../../../../core/authority/types.js';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { WorkbenchSectionId } from '../../../../core/verse/workbench-types.js';
import { darkSinceLabel, fleetDarkSince } from '../fleet/dark-since.js';

/** The single command that walks Mason through every setup step, resuming where it stopped. */
export const SETUP_COMMAND = 'ashlr authority setup';

export type AutonomyOffKind = 'stopped' | 'setup' | 'grant' | 'off' | 'dark' | 'paused' | 'quiet';

/** One setup step the server can see (custody probe + grant). `null` = unknown. */
export interface SetupCheck {
  id: 'custody' | 'key' | 'github-app' | 'claude-token' | 'grant';
  label: string;
  done: boolean | null;
}

export interface AutonomyOffState {
  kind: AutonomyOffKind;
  /** The dot: neutral for a fleet that was never switched on, warning for a lapse, danger for Stop. */
  tone: 'neutral' | 'warning' | 'danger';
  /** "Autonomy is off" — what is off, in three or four words. */
  title: string;
  /** Why it matters, one line. */
  why: string;
  /** "Fleet dark since Sep 1" / "Nothing produced since Aug 18"; null when no date is known. */
  since: string | null;
  /** The primary action when it is a command to run (copied, never executed). */
  command: string | null;
  /** The primary action when it is a place in the app. */
  go: { section: WorkbenchSectionId; anchor: string | null; label: string } | null;
  /** Command's own action: open the Touch ID sheet with this intent (it holds the sheet). */
  grant: { intent: 'grant' | 're-approve'; label: string } | null;
  /** Setup progress the server can see; [] when none of it is known. */
  checks: SetupCheck[];
}

export interface AutonomyOffInputs {
  /** The authority read's value; null = the service did not answer. */
  authority: AuthorityStatusV1 | null;
  /** The live fleet read's value; null = the view did not answer. */
  live: FleetLiveSnapshotV1 | null;
  /** Fleet history's `darkSince` ("quiet since"); null = produced within 48 h, or unknown. */
  quietSince?: string | null;
  /** Whether a new grant can be drafted (`draftReadiness`); only consulted when there is no grant. */
  draft?: DraftReadiness;
}

/**
 * What GET /api/verse/authority/draft says about setup: `ready` — a grant can
 * be drafted, so approving it is the next step; `setup` — the build has no
 * trust root for this Mac's custody key yet, which only the one-time setup
 * fixes; `unknown` — any other answer (the Touch ID sheet shows its reason).
 */
export type DraftReadiness = 'ready' | 'setup' | 'unknown';

const SETUP_CODES: ReadonlySet<string> = new Set(['no-trust-roots', 'custody-key-unknown']);

export function draftReadiness(read: { value: unknown; code?: string | null } | undefined): DraftReadiness | undefined {
  if (!read) return undefined;
  if (read.value) return 'ready';
  return read.code && SETUP_CODES.has(read.code) ? 'setup' : 'unknown';
}

const GO_COMMAND = { section: 'command', anchor: null, label: 'Open Command' } as const;
const GO_FLEET = { section: 'fleet', anchor: null, label: 'Open Fleet' } as const;

/** The five setup facts the authority read carries. The CLI's own list is longer; this is what Verse can check. */
export function setupChecks(authority: AuthorityStatusV1): SetupCheck[] {
  const c = authority.custody;
  const checks: SetupCheck[] = [
    { id: 'custody', label: 'Custody helper', done: c.installed },
    { id: 'key', label: 'Signing key', done: c.keyInitialized },
    { id: 'github-app', label: 'GitHub App', done: c.githubApp },
    { id: 'claude-token', label: 'Claude token', done: c.claudeToken },
    { id: 'grant', label: 'Standing grant', done: authority.grant.state === 'active' },
  ];
  // Custody unreadable: four unknowns and a ✗ say nothing the title does not.
  return checks.slice(0, 4).every((s) => s.done === null) ? [] : checks;
}

function sentence(text: string | null | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

const GRANT_TITLE = { paused: 'Grant paused', expired: 'Grant expired', revoked: 'Grant revoked', invalid: 'Grant invalid' } as const;

export function autonomyOffState({ authority, live, quietSince = null, draft = 'unknown' }: AutonomyOffInputs): AutonomyOffState | null {
  if (!authority && !live) return null;
  const dark = fleetDarkSince(live);
  const since = dark
    ? `Fleet dark since ${darkSinceLabel(dark)}`
    : quietSince
      ? `Nothing produced since ${darkSinceLabel(quietSince)}`
      : null;
  const base = { since, tone: 'neutral' as const, command: null, go: null, grant: null, checks: [] as SetupCheck[] };

  if (authority?.kill || live?.state === 'stopped') {
    return { ...base, kind: 'stopped', tone: 'danger', title: 'Fleet stopped', why: 'Nothing new starts until you resume it.', go: GO_COMMAND };
  }

  if (authority) {
    const grant = authority.grant.state;
    if (grant === 'none' && draft === 'setup') {
      return {
        ...base,
        kind: 'setup',
        title: 'Autonomy is off',
        why: 'Nothing runs or merges on its own until the one-time setup is done.',
        command: SETUP_COMMAND,
        checks: setupChecks(authority),
      };
    }
    if (grant === 'none') {
      return {
        ...base,
        kind: 'grant',
        title: 'Autonomy is off',
        why: 'Approve a standing grant to let the fleet work.',
        go: { ...GO_COMMAND, label: 'Approve in Command' },
        grant: { intent: 'grant', label: 'Approve grant' },
        checks: setupChecks(authority),
      };
    }
    if (grant !== 'active') {
      const paused = grant === 'paused';
      return {
        ...base,
        kind: 'grant',
        tone: 'warning',
        title: GRANT_TITLE[grant],
        why: paused ? 'Autonomy is off until you re-approve it.' : 'Autonomy is off until you approve a new grant.',
        go: { ...GO_COMMAND, label: paused ? 'Re-approve in Command' : 'Approve in Command' },
        grant: paused ? { intent: 're-approve', label: 'Re-approve grant' } : { intent: 'grant', label: 'Approve grant' },
      };
    }
    if (authority.effectiveSwitch === 'off') {
      return {
        ...base,
        kind: 'off',
        title: 'Autonomy is off',
        why: authority.switch === 'off' ? 'Switch it to Propose or Autonomous to start the fleet.' : (sentence(authority.effectiveReason) ?? 'Something holds the switch at Off.'),
        go: GO_COMMAND,
      };
    }
  }

  if (live?.state === 'dark') {
    return { ...base, kind: 'dark', title: 'Fleet is dark', why: sentence(live.stateReason) ?? 'The daemon runs nothing on its own.', go: GO_FLEET };
  }
  if (live?.state === 'paused') {
    return { ...base, kind: 'paused', tone: 'warning', title: 'Fleet paused', why: sentence(live.stateReason) ?? 'The daemon is parked; your own tools still work.', go: GO_FLEET };
  }
  if (quietSince && live?.state !== 'running') {
    return { ...base, kind: 'quiet', title: 'Fleet is quiet', why: 'Autonomy is on, but no runs or proposals were filed.', go: GO_FLEET };
  }
  return null;
}
