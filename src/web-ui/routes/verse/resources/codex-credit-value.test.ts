import { describe, expect, it } from 'vitest';
import { estimatedCreditValue } from './codex-credit-value.js';
describe('published personal-plan credit value estimate', () => {
  it.each(['free', 'go', 'plus', 'pro'])('uses the public equivalence for known personal %s plans', (plan) => {
    expect(estimatedCreditValue('2500', plan)).toBe('$100.00');
    expect(estimatedCreditValue('2048.4196250000', plan)).toBe('$81.94');
  });
  it('rounds only the displayed currency cent using exact decimal arithmetic', () => {
    expect(estimatedCreditValue('9007199254740993.125', 'pro')).toBe('$360,287,970,189,639.73');
    expect(estimatedCreditValue('0.125', 'pro')).toBe('$0.01');
    expect(estimatedCreditValue('0', 'pro')).toBe('$0.00');
  });
  it.each(['team', 'enterprise', null, 'prolite'])('does not guess a contract rate for %s', (plan) => {
    expect(estimatedCreditValue('2500', plan)).toBeNull();
  });
  it.each([null, '-1', '1e6', 'Infinity', '/private/secret', '1'.repeat(65)])('refuses malformed vendor balance %j', (balance) => {
    expect(estimatedCreditValue(balance, 'pro')).toBeNull();
  });
});
