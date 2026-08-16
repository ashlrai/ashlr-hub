import { describe, expect, it } from 'vitest';
import { statusToTone } from './StatusBadge.js';

/**
 * Locks in the status-color semantics chosen to resolve the old
 * running/done inversion (app.js had running=green/done=blue; styles.css
 * had running=blue/done=emerald). See DESIGN.md. Regression coverage so a
 * future edit can't silently flip these back without a test failing.
 */
describe('statusToTone', () => {
  it('maps running/active/in-progress to the "running" (amber, in-motion) tone', () => {
    expect(statusToTone('running')).toBe('running');
    expect(statusToTone('active')).toBe('running');
    expect(statusToTone('in_progress')).toBe('running');
  });

  it('maps done/success/applied to the "success" (green, resolved) tone — never "running"', () => {
    expect(statusToTone('done')).toBe('success');
    expect(statusToTone('success')).toBe('success');
    expect(statusToTone('applied')).toBe('success');
    expect(statusToTone('done')).not.toBe('running');
  });

  it('maps failure states to "danger"', () => {
    expect(statusToTone('failed')).toBe('danger');
    expect(statusToTone('rejected')).toBe('danger');
  });

  it('is case-insensitive and falls back to "neutral" for unrecognized strings', () => {
    expect(statusToTone('RUNNING')).toBe('running');
    expect(statusToTone('some-future-status')).toBe('neutral');
  });

  it('falls back to "unknown" for null/undefined status', () => {
    expect(statusToTone(undefined)).toBe('unknown');
    expect(statusToTone(null)).toBe('unknown');
  });
});
