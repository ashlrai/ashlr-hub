import { createHmac, timingSafeEqual } from 'node:crypto';

import { loadOrCreateKey } from '../foundry/provenance.js';

export const WEB_MUTATION_AUTHORITY_POLICY = 'ashlr.web-mutation-authority.v1' as const;

export type WebMutationRole = 'observer' | 'operator' | 'approver' | 'owner';

export type WebMutationCapability =
  | 'run:dispatch'
  | 'desktop:open'
  | 'fleet:pause'
  | 'fleet:resume'
  | 'proposal:approve'
  | 'proposal:reject'
  | 'daemon:repair-request';

export interface WebMutationPrincipal {
  /** Server-derived opaque session identity. Never a token or caller header. */
  actorId: string;
  actorType: 'agent' | 'system';
  role: WebMutationRole;
  authenticatedBy: 'scoped-local-session-token';
}

export interface WebMutationDecision {
  allowed: boolean;
  authenticated: boolean;
  capability: WebMutationCapability;
  code: 'authorized' | 'invalid-token' | 'role-denied';
  httpStatus: 200 | 401 | 403;
  principal: WebMutationPrincipal | null;
}

const ROLE_CAPABILITIES: Readonly<Record<WebMutationRole, ReadonlySet<WebMutationCapability>>> = {
  observer: new Set(),
  operator: new Set([
    'run:dispatch',
    'desktop:open',
    'fleet:pause',
    'fleet:resume',
  ]),
  approver: new Set([
    'proposal:approve',
    'proposal:reject',
  ]),
  owner: new Set([
    'run:dispatch',
    'desktop:open',
    'fleet:pause',
    'fleet:resume',
    'proposal:approve',
    'proposal:reject',
    'daemon:repair-request',
  ]),
};

function safeEqual(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/**
 * Bind all restarts for this local Ashlr installation to one opaque system
 * principal. The bearer token authenticates a server session but is never an
 * identity source, and the principal does not assert a human identity.
 */
export function buildLocalWebPrincipal(
  _token: string,
  role: WebMutationRole = 'owner',
): WebMutationPrincipal {
  const fingerprint = createHmac('sha256', loadOrCreateKey())
    .update(JSON.stringify(['ashlr:web-system-principal:v1', role]))
    .digest('hex')
    .slice(0, 24);
  return {
    actorId: `local-system:${fingerprint}`,
    actorType: 'system',
    role,
    authenticatedBy: 'scoped-local-session-token',
  };
}

/**
 * Authenticate the server-issued token and authorize one closed capability.
 * The principal is server-owned; request headers can never assert or elevate it.
 */
export function authorizeWebMutation(input: {
  expectedToken: string;
  presentedToken: string;
  principal: WebMutationPrincipal;
  capability: WebMutationCapability;
}): WebMutationDecision {
  if (!safeEqual(input.presentedToken, input.expectedToken)) {
    return {
      allowed: false,
      authenticated: false,
      capability: input.capability,
      code: 'invalid-token',
      httpStatus: 401,
      principal: null,
    };
  }

  if (!ROLE_CAPABILITIES[input.principal.role].has(input.capability)) {
    return {
      allowed: false,
      authenticated: true,
      capability: input.capability,
      code: 'role-denied',
      httpStatus: 403,
      principal: input.principal,
    };
  }

  return {
    allowed: true,
    authenticated: true,
    capability: input.capability,
    code: 'authorized',
    httpStatus: 200,
    principal: input.principal,
  };
}
