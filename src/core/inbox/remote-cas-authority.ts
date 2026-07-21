import type { AshlrConfig } from '../types.js';

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_AUDIENCE_LENGTH = 256;

export type RemoteCasAuthorityConfig = NonNullable<NonNullable<AshlrConfig['fleet']>['remoteCasAuthority']>;

export type RemoteCasAuthorityConfigParseResult =
  | { state: 'off'; config: { mode: 'off' } }
  | { state: 'probe'; config: Extract<RemoteCasAuthorityConfig, { mode: 'probe' }> }
  | { state: 'invalid-config'; reason: string };

function invalid(reason: string): RemoteCasAuthorityConfigParseResult {
  return { state: 'invalid-config', reason };
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function boundedIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' ||
    host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return false;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224;
}

function validEndpoint(value: unknown): value is string {
  if (!boundedIdentifier(value, MAX_AUDIENCE_LENGTH)) return false;
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { return false; }
  return endpoint.protocol === 'https:' && endpoint.username === '' && endpoint.password === '' &&
    endpoint.port === '' && endpoint.pathname === '/' && endpoint.search === '' && endpoint.hash === '' &&
    !isPrivateOrLoopbackHost(endpoint.hostname);
}

/**
 * Parse configuration only. This module deliberately performs no endpoint
 * reachability check: a configured endpoint is neither authority nor an
 * activation path for the dormant projection recovery executor.
 */
export function parseRemoteCasAuthorityConfig(value: unknown): RemoteCasAuthorityConfigParseResult {
  if (value === undefined) return { state: 'off', config: { mode: 'off' } };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('shape-invalid');
  const record = value as Record<string, unknown>;
  if (record.mode === 'off') {
    return exactKeys(record, ['mode']) ? { state: 'off', config: { mode: 'off' } } : invalid('off-keys-invalid');
  }
  if (record.mode !== 'probe' || !exactKeys(record, ['audience', 'authorityId', 'endpoint', 'mode', 'provider'])) {
    return invalid('probe-shape-invalid');
  }
  if (!boundedIdentifier(record.provider, MAX_IDENTIFIER_LENGTH)) return invalid('provider-invalid');
  if (!boundedIdentifier(record.audience, MAX_AUDIENCE_LENGTH)) return invalid('audience-invalid');
  if (!boundedIdentifier(record.authorityId, MAX_IDENTIFIER_LENGTH)) return invalid('authority-id-invalid');
  if (!validEndpoint(record.endpoint)) return invalid('endpoint-invalid');
  return {
    state: 'probe',
    config: {
      mode: 'probe',
      provider: record.provider,
      endpoint: record.endpoint,
      audience: record.audience,
      authorityId: record.authorityId,
    },
  };
}
