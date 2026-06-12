/**
 * M32: new-proposal notification fan-out — desktop (macOS, opt-in) + the
 * existing webhook notify() (opt-in), fired when an UNATTENDED path (daemon
 * tick, background swarm) creates a PENDING proposal.
 *
 * Deliberately OUTSIDE inbox/store.ts (whose contract is pure persistence).
 * METADATA ONLY: title/kind/id — never the diff, never repo contents.
 * Best-effort and never throws; failures are silent (notification is a
 * convenience, not a control path).
 */

import type { AshlrConfig, Proposal } from '../types.js';
import { desktopNotify } from '../integrations/desktop-notify.js';
import { notify } from '../integrations/notify.js';

/** Fire desktop + webhook notifications for a newly created proposal. */
export async function notifyNewProposal(proposal: Proposal, cfg: AshlrConfig): Promise<void> {
  const line = `[${proposal.kind}] ${proposal.title} — review: ashlr inbox show ${proposal.id}`;
  await Promise.all([
    desktopNotify('ashlr: new proposal', line, cfg).catch(() => false),
    notify(`ashlr: new pending proposal ${line}`, cfg).catch(() => false),
  ]);
}
