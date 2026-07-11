import { createHash } from 'node:crypto';

const SHA256_RE = /^[a-f0-9]{64}$/;

export function repairGenerationIdFromHandoffId(eventId: string): string | null {
  if (!SHA256_RE.test(eventId)) return null;
  return createHash('sha256')
    .update(JSON.stringify(['ashlr:repair-handoff-generation:v1', eventId]))
    .digest('hex');
}
