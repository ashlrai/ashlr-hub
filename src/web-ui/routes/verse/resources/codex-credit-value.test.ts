import { describe, expect, it } from 'vitest';
import { estimatedCreditValue, formatNativeCreditUnits } from './codex-credit-value.js';
describe('published personal-plan credit value estimate', () => {
  it.each(['free', 'go', 'plus', 'pro'])('uses the public equivalence for known personal %s plans', (plan) => {
    expect(estimatedCreditValue('2500', plan)).toBe('$100');
    expect(estimatedCreditValue('2048.4196250000', plan)).toBe('$82');
  });
  it('rounds only the displayed significant figures using exact decimal arithmetic', () => {
    expect(estimatedCreditValue('9007199254740993.125', 'pro')).toBe('$360,000,000,000,000');
    expect(estimatedCreditValue('0.125', 'pro')).toBe('$0.005');
    expect(estimatedCreditValue('0', 'pro')).toBe('$0');
  });
  it.each(['team', 'enterprise', null, 'prolite'])('does not guess a contract rate for %s', (plan) => {
    expect(estimatedCreditValue('2500', plan)).toBeNull();
  });
  it.each([null, '-1', '1e6', 'Infinity', '/private/secret', '1'.repeat(65)])('refuses malformed vendor balance %j', (balance) => {
    expect(estimatedCreditValue(balance, 'pro')).toBeNull();
  });
});

describe('readable native credit units', () => {
  it.each([
    ['412.8921985000', '410'], ['62497.7860000000', '62,000'],
    ['2500.0000', '2,500'], ['12.1000', '12'], ['0.0000', '0'],
    ['0.000001', '0.000001'], ['0.009999', '0.01'], ['0.0100', '0.01'],
    ['999.999', '1,000'], ['9007199254740993.125', '9,000,000,000,000,000'],
  ])('formats %s without floating-point evidence loss', (raw, display) => {
    expect(formatNativeCreditUnits(raw)).toBe(display);
  });
  it('rounds a maximum-length whole balance without floating-point overflow', () => {
    const raw = '9'.repeat(64);
    expect(formatNativeCreditUnits(raw)).toBe(('1' + '0'.repeat(64)).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  });
  it.each([null, undefined, 2500, '', '-1', '01', '1e6', 'Infinity', 'NaN', '1.', ' 1', '1'.repeat(65)])(
    'does not coerce a malformed balance %j into units', (raw) => {
      expect(formatNativeCreditUnits(raw)).toBeNull();
    });
  it('never invokes object conversions', () => {
    const conversion = () => { throw Error('Must not coerce native metadata'); };
    expect(formatNativeCreditUnits({ toString: conversion, valueOf: conversion })).toBeNull();
  });
});
