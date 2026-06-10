/**
 * core/seams/identity.ts — IdentityProvider seam (M30).
 *
 * SEAM over core/integrations/identity.ts (getIdentity).
 *
 * LOCAL = phantom-derived identity (the current behavior): names/status only,
 * values-free, never throws. A cloud/team identity provider WOULD authenticate
 * against a backbone — gated.
 *
 *   (a) IdentityProvider        — the interface.
 *   (b) LocalIdentityProvider   — DEFAULT. Behavior-preserving adapter over
 *                                 getIdentity() (phantom probe). ZERO change.
 *   (c) CloudIdentityProvider   — GATED stub; throws before any I/O.
 *   (d) selectIdentityProvider  — local by default; gated stub ONLY when an
 *                                 endpoint is explicitly configured (refuses).
 *
 * HARD SAFETY: local-first + self-hostable + cloud-gated. No new deps.
 */

import { getIdentity } from '../integrations/identity.js';
import type { AshlrConfig, Identity } from '../types.js';
import { seamEndpoint } from './registry.js';
import { cloudGatedError } from './types.js';

export const IDENTITY_SEAM = {
  id: 'identity' as const,
  name: 'IdentityProvider',
  delegatesTo: 'core/integrations/identity.ts',
  summary: 'Who is the caller (LOCAL = phantom probe, values-free; cloud = team auth, gated).',
};

/** Read-only identity snapshot provider. */
export interface IdentityProvider {
  /** Return the caller's identity snapshot (names/status only). */
  get(): Identity;
}

/** DEFAULT local impl — pass-through adapter over getIdentity() (phantom). */
export class LocalIdentityProvider implements IdentityProvider {
  get(): Identity {
    return getIdentity();
  }
}

/** GATED cloud stub — a team identity/auth provider WOULD live here. Throws first. */
export class CloudIdentityProvider implements IdentityProvider {
  get(): Identity {
    throw cloudGatedError(IDENTITY_SEAM.name, 'get');
  }
}

/** Local by default; gated stub only when an endpoint is configured (refuses). */
export function selectIdentityProvider(cfg: AshlrConfig): IdentityProvider {
  return seamEndpoint(cfg, 'identity') ? new CloudIdentityProvider() : new LocalIdentityProvider();
}
