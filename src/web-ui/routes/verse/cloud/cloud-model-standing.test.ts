import { describe, expect, it } from 'vitest';
import { approxCredits, CLOUD_NOT_SET_UP_WORD, notSetUpLine } from './cloud-model.js';

describe('cloud-model standing — a lane that cannot launch', () => {
  it('approximates credits in whole dollars, never negative or NaN', () => {
    expect(approxCredits(250)).toBe('~$250 credits');
    expect(approxCredits(212.6)).toBe('~$213 credits');
    expect(approxCredits(-4)).toBe('~$0 credits');
    expect(approxCredits(Number.NaN)).toBe('~$0 credits');
  });

  it('reads the setup blocker first, the estimate second', () => {
    expect(CLOUD_NOT_SET_UP_WORD).toBe('Not set up');
    expect(notSetUpLine(250)).toBe('Cloud: not set up · ~$250 credits');
  });
});
