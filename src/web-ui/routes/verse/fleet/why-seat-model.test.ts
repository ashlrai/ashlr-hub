import { describe, expect, it } from 'vitest';
import type { SeatDecision, SeatExclusion } from '../../../../core/routing/types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import {
  asSentence,
  decisionSummary,
  describeEligibleAgain,
  eligibleAgain,
  exclusionReasons,
  heldBackText,
  joinSentences,
  laneReasonText,
  legacySummary,
  parseLegacyReason,
} from './why-seat-model.js';

const NOW = Date.parse('2026-09-24T16:00:00.000Z');
const CMP_RESET = '2026-09-26T03:46:56.000Z';
const PERSONAL_RESET = '2026-09-25T18:25:44.000Z';
const CLAUDE_PROSE = 'Sep 25 at 6:59pm (America/New_York)';

/** What the live 3.10.0 app showed on 2026-09-24, verbatim (sentences only — no `details`). */
const LIVE_3100: SeatDecision = {
  seatId: 'grok',
  candidates: ['grok', 'local:qwen'],
  exclusions: [
    { seatId: 'claude', reasons: [`The weekly window is 97% used; 40% is kept for you, so autonomy stops at 60% (resets ${CLAUDE_PROSE}).`], nextEligibleAt: null },
    { seatId: 'codex-cmp', reasons: ['Autonomy is switched off for this seat.', `The weekly window is spent — limit reached (resets ${CMP_RESET}).`], nextEligibleAt: null },
    { seatId: 'codex-personal', reasons: ['Autonomy is switched off for this seat.', `The weekly window is spent — limit reached (resets ${PERSONAL_RESET}).`], nextEligibleAt: null },
  ],
  why: 'Routed autonomous medium-difficulty code work to Grok (grok) with 94% of its weekly window left for autonomy: balanced mode prefers Grok first for this work; '
    + `held back 3 seats (claude: the weekly window is 97% used; 40% is kept for you, so autonomy stops at 60% (resets ${CLAUDE_PROSE}); codex-cmp: autonomy is switched off for this seat; …).`,
  mode: 'balanced',
};

const byId = (d: SeatDecision, id: string): SeatExclusion => d.exclusions.find((x) => x.seatId === id)!;

describe('sentences', () => {
  it('joins reasons as prose — never ".;" and never ".."', () => {
    expect(joinSentences(['Autonomy is switched off for this seat.', 'The weekly window is spent — limit reached.'])).toBe(
      'Autonomy is switched off for this seat. The weekly window is spent — limit reached.');
    expect(joinSentences(['Weekly window exhausted;', 'Off for now', 'Done.'])).toBe('Weekly window exhausted. Off for now. Done.');
    const joined = heldBackText(byId(LIVE_3100, 'codex-cmp'));
    expect(joined).not.toMatch(/\.;|\.\./);
    expect(joined).toBe('Autonomy is switched off for this seat. The weekly window is spent — limit reached.');
  });

  it('closes a clause with one full stop, keeps its own terminal mark and never re-cases a seat id', () => {
    expect(asSentence('  Above the ceiling, ')).toBe('Above the ceiling.');
    expect(asSentence('grok-a has the most headroom')).toBe('grok-a has the most headroom.');
    expect(asSentence('Spent!')).toBe('Spent!');
    expect(asSentence('')).toBe('');
  });
});

describe('reasons as data', () => {
  it('splits a 3.10.0 sentence into text + reset: an instant, or Claude\'s own words', () => {
    expect(parseLegacyReason(`The weekly window is spent — limit reached (resets ${CMP_RESET}).`)).toEqual({
      kind: 'spent', text: 'The weekly window is spent — limit reached.', resetsAt: CMP_RESET, resetDescription: null,
    });
    // Nested parentheses in the provider's prose survive intact.
    expect(parseLegacyReason(`The weekly window is 97% used; 40% is kept for you, so autonomy stops at 60% (resets ${CLAUDE_PROSE}).`)).toEqual({
      kind: 'reserve', text: 'The weekly window is 97% used; 40% is kept for you, so autonomy stops at 60%.', resetsAt: null, resetDescription: CLAUDE_PROSE,
    });
    expect(parseLegacyReason('This route (grok-cli on a/b for todo work) is demoted until 2026-09-25T00:00:00.000Z: two reverts')).toMatchObject({
      kind: 'demoted', text: 'This route (grok-cli on a/b for todo work) is demoted: two reverts', resetsAt: '2026-09-25T00:00:00.000Z',
    });
    expect(parseLegacyReason('Autonomy is switched off for this seat.').kind).toBe('switched-off');
  });

  it('prefers the 3.10.1 structured details, and reads an unknown kind as other', () => {
    const x: SeatExclusion = {
      seatId: 'codex-cmp',
      reasons: ['ignored when details are present'],
      nextEligibleAt: null,
      details: [
        { kind: 'switched-off', text: 'Autonomy is switched off for this seat.' },
        { kind: 'brand-new' as never, text: 'Something newer.' },
      ],
    };
    expect(exclusionReasons(x).map((r) => r.kind)).toEqual(['switched-off', 'other']);
    expect(heldBackText(x)).toBe('Autonomy is switched off for this seat. Something newer.');
  });
});

describe('eligible again', () => {
  it('names the condition AND the reset for a switched-off seat whose window is also spent', () => {
    const e = eligibleAgain(byId(LIVE_3100, 'codex-cmp'));
    expect(e).toMatchObject({ conditions: ['you switch autonomy on for this seat'], at: CMP_RESET, timeUnknown: false });
    const text = describeEligibleAgain(e, NOW);
    expect(text).toBe(`when you switch autonomy on for this seat, not before ${describeResetAt(CMP_RESET, NOW)}`);
    expect(text).not.toContain('2026-09-26T');
  });

  it('is the reset, in the viewer\'s zone, for a seat that is only spent', () => {
    const x: SeatExclusion = { seatId: 'codex-personal', reasons: [], nextEligibleAt: PERSONAL_RESET,
      details: [{ kind: 'spent', text: 'The weekly window is spent — limit reached.', resetsAt: PERSONAL_RESET }] };
    expect(describeEligibleAgain(eligibleAgain(x), NOW)).toBe(describeResetAt(PERSONAL_RESET, NOW));
  });

  it('quotes Claude\'s reset verbatim — never turned into a time', () => {
    expect(describeEligibleAgain(eligibleAgain(byId(LIVE_3100, 'claude')), NOW)).toBe(CLAUDE_PROSE);
    const withPrefix: SeatExclusion = { seatId: 'claude', reasons: [], nextEligibleAt: null,
      details: [{ kind: 'reserve', text: 'x.', resetDescription: `resets ${CLAUDE_PROSE}` }] };
    expect(describeEligibleAgain(eligibleAgain(withPrefix), NOW)).toBe(CLAUDE_PROSE);
  });

  it('waits for the LAST of several resets — the seat is blocked until every window reopens', () => {
    const x: SeatExclusion = { seatId: 'codex', reasons: [], nextEligibleAt: null, details: [
      { kind: 'spent', text: 'The 5-hour window is spent — 100% used.', resetsAt: '2026-09-24T18:00:00.000Z' },
      { kind: 'spent', text: 'The weekly window is spent — 100% used.', resetsAt: PERSONAL_RESET },
    ] };
    expect(eligibleAgain(x).at).toBe(PERSONAL_RESET);
  });

  it('says what must happen when no time applies, and "unknown" only when nothing says', () => {
    const stale: SeatExclusion = { seatId: 'grok', reasons: ['The usage reading is 40 min old — too stale to spend against (limit 15 min).'], nextEligibleAt: null };
    expect(describeEligibleAgain(eligibleAgain(stale), NOW)).toBe('when a fresh usage reading arrives');
    const both: SeatExclusion = { seatId: 'x', reasons: ['Autonomy is switched off for this seat.', 'Signed out — reconnect this account before anything can run on it.'], nextEligibleAt: null };
    expect(describeEligibleAgain(eligibleAgain(both), NOW)).toBe('when you switch autonomy on for this seat and you reconnect this account');
    const fit: SeatExclusion = { seatId: 'local:q', reasons: ['Needs about 60k tokens of context; this seat\'s window is 64k (at most 80% is used for a task).'], nextEligibleAt: null };
    expect(describeEligibleAgain(eligibleAgain(fit), NOW)).toMatch(/^not for this task/);
    const opaque: SeatExclusion = { seatId: 'y', reasons: ['Something odd.'], nextEligibleAt: null };
    expect(describeEligibleAgain(eligibleAgain(opaque), NOW)).toBe('unknown');
  });

  it('falls back to the server\'s nextEligibleAt when the reasons carry no time', () => {
    const x: SeatExclusion = { seatId: 'codex-a', reasons: ['weekly window exhausted; resets Thu 09:00'], nextEligibleAt: '2026-09-26T09:00:00.000Z' };
    expect(describeEligibleAgain(eligibleAgain(x), NOW)).toBe(describeResetAt('2026-09-26T09:00:00.000Z', NOW));
  });

  it('reads every 3.10.0 lane-cap sentence as a lane — plural "lanes" and "slot(s)" included', () => {
    // The router's planLanes capReasons as 3.10.0 wrote them into exclusions (dispatch-router.ts).
    for (const sentence of [
      'Codex lanes stay off until the Leader enables them after the usage reset (a class-B action).',
      'The Leader set 0 grok-cli lanes.',
      'The local runtime serves 0 slot(s).',
      'A harness experiment is using 2 local slot(s).',
      'You are active (or presence is unknown), so the Claude producer slice is held for your own session.',
      'The codex lane has no slots this tick.',
    ]) {
      expect(parseLegacyReason(sentence).kind, sentence).toBe('lane');
      const x: SeatExclusion = { seatId: 'codex-cmp', reasons: [sentence], nextEligibleAt: null };
      expect(describeEligibleAgain(eligibleAgain(x), NOW), sentence).toBe('when its lane has a free slot');
    }
  });

  it('prints a held-back seat\'s lane cap as the server wrote it', () => {
    const legacy: SeatExclusion = { seatId: 'codex-cmp', reasons: ['Codex stays off until the Leader turns it on after the usage reset (you can veto it).'], nextEligibleAt: null };
    expect(heldBackText(legacy)).toBe('Codex stays off until the Leader turns it on after the usage reset (you can veto it).');
    const structured: SeatExclusion = {
      seatId: 'local:qwen',
      reasons: ['The local runtime serves 0 slots.'],
      details: [{ kind: 'lane', text: 'The local runtime serves 0 slots.', resetsAt: null, resetDescription: null }],
      nextEligibleAt: null,
    };
    expect(heldBackText(structured)).toBe('The local runtime serves 0 slots.');
  });
});

describe('lane cap reasons', () => {
  it('passes the server\'s plain sentences through unchanged, only trimmed', () => {
    // The server pluralises and names lanes at the source (dispatch-router.ts);
    // the UI must not re-translate them.
    for (const sentence of [
      'The local runtime serves 1 slot.',
      'A harness experiment is using 2 local slots.',
      'Codex stays off until the Leader turns it on after the usage reset (you can veto it).',
      'The Leader set 1 Grok lane.',
      'No Codex seat has the producer role in the grant.',
      'The grant gives codex-cmp no producer role.',
    ]) {
      expect(laneReasonText(sentence)).toBe(sentence);
    }
    expect(laneReasonText('  off until its window resets ')).toBe('off until its window resets');
  });
});

describe('headline', () => {
  it('turns the live 3.10.0 run-on into one short sentence plus the held-back count', () => {
    const text = decisionSummary(LIVE_3100);
    expect(text).toBe('Grok — 94% of its weekly window left; balanced mode prefers Grok for this work. 3 seats held back.');
    expect(text).not.toMatch(/…|\(resets|codex-cmp/);
  });

  it('uses the 3.10.1 summary when the router sent one', () => {
    expect(decisionSummary({ ...LIVE_3100, summary: 'Grok — 94% of its weekly window left; balanced mode prefers Grok for this work.', exclusions: [LIVE_3100.exclusions[0]!] }))
      .toBe('Grok — 94% of its weekly window left; balanced mode prefers Grok for this work. 1 seat held back.');
  });

  it('recovers the other 3.10.0 shapes and leaves anything unrecognised alone', () => {
    expect(legacySummary('Routed autonomous low-difficulty bulk work to Qwen 3 (local) (local:qwen) at no cost: balanced mode prefers local models first for this work.'))
      .toBe('Qwen 3 (local) — free, no usage window; balanced mode prefers local models for this work.');
    expect(legacySummary(`No seat can take autonomous high-difficulty leader work in balanced mode (claude: the 5-hour window is 82% used (resets 7pm (UTC)); grok: x); the earliest known reopening is ${CMP_RESET}.`))
      .toBe('No seat can take autonomous high-difficulty leader work in balanced mode.');
    expect(legacySummary('Routed medium-difficulty code work to Claude (claude): balanced mode prefers Claude first for this work.'))
      .toBe('Claude — balanced mode prefers Claude for this work.');
    expect(legacySummary('grok-a has the most headroom.')).toBe('grok-a has the most headroom.');
  });
});
