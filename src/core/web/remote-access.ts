/** Cloudflare Access identity check for the unstarted phone gateway. */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { isIP } from 'node:net';

export interface RemoteAccessConfig {
  /** Exact public HTTPS origin; also the future WebAuthn origin. */
  publicOrigin: string;
  /** Cloudflare One team issuer, e.g. https://team.cloudflareaccess.com. */
  teamDomain: string;
  /** Access self-hosted application's AUD tag. */
  audience: string;
  /** Explicit human identity IDs; an Access policy alone does not pair a device. */
  allowedSubjects: readonly string[];
}

export interface RemoteAccessIdentity {
  subject: string;
  email: string;
  expiresAt: number;
}

const TEAM_DOMAIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE = /^[a-f0-9]{64}$/i;

/** No defaults: incomplete provisioned config cannot make a gateway usable. */
export function parseRemoteAccessConfig(value: unknown): RemoteAccessConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const { publicOrigin, teamDomain, audience, allowedSubjects } = input;
  if (typeof publicOrigin !== 'string' || typeof teamDomain !== 'string' || typeof audience !== 'string') return null;
  if (!TEAM_DOMAIN.test(teamDomain) || !AUDIENCE.test(audience)) return null;
  if (!Array.isArray(allowedSubjects) || allowedSubjects.length === 0
    || allowedSubjects.some((subject: unknown) => typeof subject !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(subject))) return null;
  try {
    const origin = new URL(publicOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || !origin.hostname.includes('.')
      || isIP(origin.hostname) !== 0
      || origin.hostname === 'localhost' || origin.hostname.endsWith('.localhost')) return null;
  } catch { return null; }
  return { publicOrigin, teamDomain, audience, allowedSubjects: [...new Set(allowedSubjects as string[])] };
}

/**
 * Production uses only the configured team's JWKS URL. Tests inject a local
 * verifier key set; neither a JWT's iss nor kid may choose a network location.
 */
export function createRemoteAccessVerifier(configInput: unknown, testKeys?: JWTVerifyGetKey) {
  const config = parseRemoteAccessConfig(configInput);
  if (!config) throw new Error('Remote Access configuration is incomplete or invalid');
  const keys = testKeys ?? createRemoteJWKSet(new URL(`${config.teamDomain}/cdn-cgi/access/certs`));
  return async (assertion: string | undefined): Promise<RemoteAccessIdentity | null> => {
    if (!assertion || assertion.length > 16_384 || assertion.split('.').length !== 3) return null;
    try {
      const { payload } = await jwtVerify(assertion, keys, {
        issuer: config.teamDomain,
        audience: config.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'nbf', 'sub'],
      });
      // Service tokens also say type=app, but have an empty sub and no email.
      if (payload.type !== 'app' || typeof payload.sub !== 'string'
        || !config.allowedSubjects.includes(payload.sub)
        || typeof payload.email !== 'string' || !payload.email.trim()
        || typeof payload.exp !== 'number' || payload.common_name !== undefined
        || payload.service_token_id !== undefined) return null;
      return { subject: payload.sub, email: payload.email, expiresAt: payload.exp * 1_000 };
    } catch { return null; }
  };
}

/** Use only Access's signed assertion header; its browser cookie is not proof. */
export async function verifyRemoteAccessHeader(
  headers: Record<string, string | string[] | undefined>,
  verify: ReturnType<typeof createRemoteAccessVerifier>,
): Promise<RemoteAccessIdentity | null> {
  const assertion = headers['cf-access-jwt-assertion'];
  return verify(typeof assertion === 'string' ? assertion : undefined);
}
