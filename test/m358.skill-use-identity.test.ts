import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildShadowSkillUseEvent } from '../src/core/fleet/skill-use-identity.js';
import { readSkillUseEvents, recordSkillUseEvent } from '../src/core/fleet/skill-records.js';

const selectedAt = '2026-07-10T12:00:00.000Z';
const base = {
  identity: { trajectoryId: 'attempt:abc-123', runId: 'run-123' },
  selectedAt,
  skill: {
    skillId: 'skill.proposal.prop-123',
    revision: 2,
    contentHash: 'a'.repeat(64),
    rank: 1,
    score: 0.75,
  },
  route: { backend: 'codex', tier: 'frontier', model: 'gpt-5.5' },
} as const;

let previousAshlrHome: string | undefined;
let home: string;

beforeEach(() => {
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m358-skill-use-identity-'));
  process.env.ASHLR_HOME = home;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('M358 strong skill-use identity', () => {
  it('builds a replay-stable shadow selection bound to the signed card snapshot', () => {
    vi.setSystemTime('2026-07-10T12:01:00.000Z');
    const first = buildShadowSkillUseEvent(base);
    const replay = buildShadowSkillUseEvent(base);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      eventId: expect.stringMatching(/^skill-use:[a-f0-9]{32}$/),
      trajectoryId: 'attempt:abc-123',
      runId: 'run-123',
      contentHash: 'a'.repeat(64),
      selectedAt,
      skillPolicyVersion: 'verified-skills-v1',
      mode: 'shadow',
      stage: 'selected',
      outcome: 'unknown',
      routeSnapshot: {
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
        selectedSkillIds: ['skill.proposal.prop-123'],
        skillPolicyVersion: 'verified-skills-v1',
        skillMode: 'shadow',
      },
    });
  });

  it('separates every authority-bearing identity tuple member', () => {
    vi.setSystemTime('2026-07-10T12:01:00.000Z');
    const id = buildShadowSkillUseEvent(base)?.eventId;
    const variants = [
      { ...base, identity: { trajectoryId: 'attempt:different' } },
      { ...base, skill: { ...base.skill, skillId: 'skill.proposal.other' } },
      { ...base, skill: { ...base.skill, revision: 3 } },
      { ...base, skill: { ...base.skill, contentHash: 'b'.repeat(64) } },
    ];
    expect(variants.map((variant) => buildShadowSkillUseEvent(variant)?.eventId))
      .not.toContain(id);
  });

  it('keeps Best-of-N candidates distinct under one outer trajectory', () => {
    vi.setSystemTime('2026-07-10T12:01:00.000Z');
    const outerTrajectory = 'run:attempt-11111111-1111-4111-8111-111111111111';
    const first = buildShadowSkillUseEvent({
      ...base,
      identity: { trajectoryId: outerTrajectory, runId: 'attempt-candidate-a' },
    });
    const second = buildShadowSkillUseEvent({
      ...base,
      identity: { trajectoryId: outerTrajectory, runId: 'attempt-candidate-b' },
    });

    expect(first?.eventId).not.toBe(second?.eventId);
    expect(first).toMatchObject({ trajectoryId: outerTrajectory, runId: 'attempt-candidate-a' });
    expect(second).toMatchObject({ trajectoryId: outerTrajectory, runId: 'attempt-candidate-b' });
  });

  it('keeps separate selected-at snapshots distinct and non-conflicting on readback', () => {
    vi.setSystemTime('2026-07-10T12:02:00.000Z');
    const first = buildShadowSkillUseEvent(base);
    const second = buildShadowSkillUseEvent({
      ...base,
      selectedAt: '2026-07-10T12:01:00.000Z',
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.eventId).not.toBe(second?.eventId);

    recordSkillUseEvent([first!, second!]);
    expect(readSkillUseEvents().map((event) => ({
      eventId: event.eventId,
      selectedAt: event.selectedAt,
    }))).toEqual([
      { eventId: second!.eventId, selectedAt: '2026-07-10T12:01:00.000Z' },
      { eventId: first!.eventId, selectedAt },
    ]);
  });

  it('rejects weak, path-like, malformed, future, and unsigned identities', () => {
    vi.setSystemTime('2026-07-10T12:01:00.000Z');
    expect(buildShadowSkillUseEvent({ ...base, identity: { trajectoryId: 'work:item-1' } })).toBeNull();
    expect(buildShadowSkillUseEvent({ ...base, identity: {} })).toBeNull();
    expect(buildShadowSkillUseEvent({ ...base, identity: { runId: '/tmp/private/run' } })).toBeNull();
    expect(buildShadowSkillUseEvent({ ...base, skill: { ...base.skill, contentHash: 'not-signed' } })).toBeNull();
    expect(buildShadowSkillUseEvent({ ...base, selectedAt: '2099-01-01T00:00:00.000Z' })).toBeNull();
  });

  it('never includes card text, repo paths, route reasons, prompts, or command data', () => {
    vi.setSystemTime('2026-07-10T12:01:00.000Z');
    const event = buildShadowSkillUseEvent({
      ...base,
      skill: {
        ...base.skill,
        name: 'RAW_PROMPT_CARD_NAME',
        summary: 'diff --git a/private b/private',
      } as never,
      route: {
        ...base.route,
        reason: 'stdout contained PRIVATE_OUTPUT',
        repo: '/private/repo',
      } as never,
    });
    const json = JSON.stringify(event);
    expect(json).not.toContain('RAW_PROMPT_CARD_NAME');
    expect(json).not.toContain('diff --git');
    expect(json).not.toContain('PRIVATE_OUTPUT');
    expect(json).not.toContain('/private/repo');
    expect(event).not.toHaveProperty('reason');
  });
});
