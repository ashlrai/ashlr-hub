/** Discoverable native tool inputs; runtime parsers independently validate every field. */
import { PROACTIVE_PROVIDERS } from './types.js';
const identifier = { type: 'string', minLength: 1, maxLength: 256 };
const nullableIdentifier = { anyOf: [identifier, { type: 'null' }] };
const fields = {
  displayName: { type: 'string', minLength: 1, maxLength: 120 },
  avatar: { type: 'object', properties: { color: { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' }, variant: { type: 'string', enum: ['classic', 'round', 'pixel'] } }, required: ['color', 'variant'], additionalProperties: false },
  responsibility: { type: 'string', maxLength: 4000 },
  computer: { type: 'object', properties: { kind: { type: 'string', enum: ['hosted', 'connected-local', 'unknown'] }, label: { type: 'string', maxLength: 120 }, providerComputerId: nullableIdentifier }, required: ['kind', 'label', 'providerComputerId'], additionalProperties: false },
  services: { type: 'array', maxItems: 100, items: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, label: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['id', 'label'], additionalProperties: false } },
  fundingReference: { anyOf: [{ type: 'null' }, { type: 'object', properties: { kind: { type: 'string', enum: ['subscription', 'promotional-api', 'unknown'] }, accountId: identifier, poolId: nullableIdentifier }, required: ['kind', 'accountId', 'poolId'], additionalProperties: false }], description: 'Same-account metadata reference, never proof of balance, expiry or spending eligibility.' },
  enabled: { type: 'boolean', description: 'Save an intended planning preference for supported future invocation. Current planners do not consume profiles; this does not enable transport or spending.' },
};
export const PROACTIVE_PROFILE_INPUT_SCHEMA = {
  type: 'object', properties: { identity: { type: 'object', properties: { provider: { type: 'string', enum: [...PROACTIVE_PROVIDERS] }, accountId: identifier, agentId: identifier }, required: ['provider', 'accountId', 'agentId'], additionalProperties: false }, ...fields },
  required: ['identity', 'displayName'], additionalProperties: false,
};
export const PROACTIVE_PROFILE_PATCH_SCHEMA = {
  type: 'object', properties: { expectedVersion: { type: 'integer', minimum: 1 }, ...fields }, required: ['expectedVersion'], additionalProperties: false,
};
