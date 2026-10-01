/**
 * 3.15 — the grant editor's pure edit and diff (src/core/authority/grant-scope.ts).
 * An edit can only CHOOSE within the server's draft; every rung is narrowed to
 * match; an invalid result is refused, never repaired.
 */
import { describe, expect, it } from 'vitest';

import { applyGrantScopeEdit, editableEngines, editableSeatPolicies, grantScopeDiff, parseGrantScopeEdit } from '../src/core/authority/grant-scope.js';
import { canonicalJson } from '../src/core/authority/canonical-json.js';
import { editGrant, makeGrant } from './helpers/authority-310b.js';

describe('parseGrantScopeEdit', () => {
  it('accepts the known keys and refuses anything else', () => {
    expect(parseGrantScopeEdit(undefined)).toEqual({ ok: true, edit: {} });
    expect(parseGrantScopeEdit({ repos: ['a/b', 'a/b'], days: 7, maxMode: 'reserve' })).toEqual({ ok: true, edit: { repos: ['a/b'], days: 7, maxMode: 'reserve' } });
    expect(parseGrantScopeEdit({ nope: 1 })).toMatchObject({ ok: false, reason: 'unknown scope key: nope' });
    expect(parseGrantScopeEdit({ leaderClasses: ['C'] })).toMatchObject({ ok: false });
    expect(parseGrantScopeEdit({ days: 31 })).toMatchObject({ ok: false });
    expect(parseGrantScopeEdit({ meteredUsdPerDay: 1.5 })).toMatchObject({ ok: false });
    expect(parseGrantScopeEdit({ conductorGoals: 'yes' })).toMatchObject({ ok: false });
    expect(parseGrantScopeEdit([])).toMatchObject({ ok: false });
  });
});

describe('applyGrantScopeEdit', () => {
  const draft = makeGrant();

  it('narrows the repos and every rung, dropping rungs left empty', () => {
    const result = applyGrantScopeEdit(draft, { repos: ['ashlrai/measurably'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.repos.map((r) => r.nameWithOwner)).toEqual(['ashlrai/measurably']);
    // shadow and 2a named only the canary and ashlrcode: gone. `full` keeps measurably.
    expect(result.payload.rollout.stages.map((s) => s.id)).toEqual(['full']);
    expect(result.payload.rollout.stages[0]!.repos).toEqual([{ nameWithOwner: 'ashlrai/measurably', stage: 'merge' }]);
  });

  it('refuses a repo the draft does not name, and an empty selection', () => {
    expect(applyGrantScopeEdit(draft, { repos: ['evil/repo'] })).toMatchObject({ ok: false });
    expect(applyGrantScopeEdit(draft, { repos: [] })).toMatchObject({ ok: false, reason: 'a grant needs at least one repo' });
  });

  it('narrows engines on every rung and refuses a rung left without one', () => {
    const ok = applyGrantScopeEdit(draft, { engines: ['local', 'grok-cli'] });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.payload.engines).toEqual(['local', 'grok-cli']);
      for (const stage of ok.payload.rollout.stages) expect(stage.engines.every((e) => ['local', 'grok-cli'].includes(e))).toBe(true);
    }
    // shadow's engines are local/grok-cli/claude-cli: codex alone empties it.
    expect(applyGrantScopeEdit(draft, { engines: ['codex'] })).toMatchObject({ ok: false });
    // devin is choosable only when the draft already named it.
    expect(applyGrantScopeEdit(draft, { engines: ['local', 'devin'] })).toMatchObject({ ok: false });
    const cliLane = parseGrantScopeEdit({ engines: ['local', 'devin-cli'] });
    expect(cliLane.ok).toBe(true);
    if (cliLane.ok) expect(applyGrantScopeEdit(draft, cliLane.edit)).toMatchObject({ ok: false });
    expect(editableEngines(draft)).not.toContain('devin');
  });

  it('narrows the Leader classes on every rung, sets spend, days and the conductor', () => {
    const result = applyGrantScopeEdit(draft, { leaderClasses: ['A'], maxMode: 'reserve', meteredUsdPerDay: 5, days: 7, conductorGoals: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.leader.classes).toEqual(['A']);
    for (const stage of result.payload.rollout.stages) expect(stage.leaderClasses).not.toContain('B');
    expect(result.payload.spend).toMatchObject({ maxMode: 'reserve', meteredUsdPerDay: 5 });
    expect(result.payload.conductorGoals).toBe(false);
    expect(Date.parse(result.payload.expiresAt) - Date.parse(result.payload.issuedAt)).toBe(7 * 86_400_000);
    // The draft itself is never mutated.
    expect(draft.leader.classes).toEqual(['A', 'B']);
  });
});

describe('grantScopeDiff', () => {
  it('without a grant in force every scope line is new', () => {
    const lines = grantScopeDiff(null, makeGrant());
    expect(lines.filter((l) => !l.field.startsWith('seat-')).map((l) => l.field)).toEqual(['repos', 'engines', 'leader', 'spend-mode', 'metered', 'merge-caps', 'volume-policy', 'expiry']);
    expect(lines.filter((l) => l.direction === 'wider').length).toBeGreaterThanOrEqual(4);
  });

  it('names what widens and what narrows', () => {
    const current = makeGrant();
    const next = editGrant(current, (g) => {
      g.repos = g.repos.filter((r) => r.nameWithOwner !== 'ashlrai/measurably');
      g.engines = ['local', 'grok-cli', 'claude-cli'];
      g.spend.maxMode = 'all-in';
      g.spend.meteredUsdPerDay = 10;
      g.leader.classes = ['A'];
      g.expiresAt = new Date(Date.parse(g.expiresAt) + 86_400_000).toISOString();
    });
    const lines = grantScopeDiff(current, next);
    const by = (label: string) => lines.find((l) => l.label === label);
    expect(by('Repositories removed')).toMatchObject({ direction: 'narrower', before: 'ashlrai/measurably' });
    expect(by('Engines removed')).toMatchObject({ direction: 'narrower', before: 'codex' });
    expect(by('Budget up to')).toMatchObject({ direction: 'wider', before: 'balanced', after: 'all-in' });
    expect(by('Metered APIs')).toMatchObject({ direction: 'wider' });
    expect(by('Leader classes')).toMatchObject({ direction: 'narrower' });
    expect(by('Expires')).toMatchObject({ direction: 'changed' });
  });

  it('an identical scope differs only by nothing', () => {
    const g = makeGrant();
    expect(grantScopeDiff(g, structuredClone(g))).toEqual([]);
  });
});


describe('explicit signed volume choices', () => {
  it('preserves legacy bytes and volume policy on unrelated edits', () => {
    const g = makeGrant();
    const unchanged = applyGrantScopeEdit(g, {});
    expect(unchanged).toEqual({ ok: true, payload: g });
    const renewed = applyGrantScopeEdit(g, { days: 7, maxMode: 'reserve' });
    expect(renewed.ok).toBe(true);
    if (renewed.ok) {
      expect(renewed.payload.merge).toEqual(g.merge);
      expect(renewed.payload.rollout.stages).toEqual(g.rollout.stages);
      expect(renewed.payload.merge).not.toHaveProperty('volumePolicy');
    }
  });
  it('requires explicit choice, reviews every changed rung, and retains other authority', () => {
    const g = makeGrant();
    const n = Number.MAX_SAFE_INTEGER;
    const changed = applyGrantScopeEdit(g, { maxFiles: n, maxLines: n, repoMaxMergesPerDay: { 'ashlrai/measurably': n } });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.payload.merge).toMatchObject({ volumePolicy: 'operator-signed', maxFiles: n, maxLines: n });
    expect(changed.payload.repos.find((r) => r.nameWithOwner === 'ashlrai/measurably')).toMatchObject({ maxMergesPerDay: n, maxRisk: 'low', enforcement: 'local' });
    expect(changed.payload.spend).toEqual(g.spend);
    expect(changed.payload.leader).toEqual(g.leader);
    expect(changed.payload.engines).toEqual(g.engines);
    expect(changed.payload.rollout.stages.every((r) => r.maxFiles === n && r.maxLines === n)).toBe(true);
    const diff = grantScopeDiff(g, changed.payload);
    expect(diff.filter((r) => r.field === 'stage-volume')).toHaveLength(g.rollout.stages.length);
    expect(diff.find((r) => r.field === 'volume-policy')).toMatchObject({ direction: 'wider' });
    expect(diff.find((r) => r.field === 'merge-frequency')?.after).toBe('No volume cap');
  });
  it('rejects malformed/unsafe choices and unknown or unselected repo rates', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'none', null]) {
      expect(parseGrantScopeEdit({ maxFiles: bad }).ok).toBe(false);
      expect(parseGrantScopeEdit({ maxLines: bad }).ok).toBe(false);
    }
    for (const bad of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 'none', null]) expect(parseGrantScopeEdit({ repoMaxMergesPerDay: { 'a/b': bad } }).ok).toBe(false);
    expect(parseGrantScopeEdit({ repoMaxMergesPerDay: { 'A/B': 1, 'a/b': 2 } }).ok).toBe(false);
    expect(applyGrantScopeEdit(makeGrant(), { repoMaxMergesPerDay: { 'a/b': 0 } }).ok).toBe(false);
    expect(applyGrantScopeEdit(makeGrant(), { repos: ['ashlrai/measurably'], repoMaxMergesPerDay: { 'ashlrai/ashlrcode': 5 } }).ok).toBe(false);
  });
});


describe('explicit account policy edits', () => {
  it('preserves exact seats and volume semantics for absent and unrelated edits', () => {
    const draft = makeGrant();
    for (const edit of [{}, { maxMode: 'all-in' as const }, { days: 7 }, { seatPolicies: {} }]) {
      const result = applyGrantScopeEdit(draft, edit);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(canonicalJson(result.payload.spend.seats)).toBe(canonicalJson(draft.spend.seats));
        expect(result.payload.merge).toEqual(draft.merge);
      }
    }
  });
  it('applies only explicit fields including zero reserve and null ceiling removal', () => {
    const draft = makeGrant();
    const result = applyGrantScopeEdit(draft, { seatPolicies: { claude: { reserveFloorPercent: 0, maxSessionWindowPercent: null, roles: ['producer', 'judge', 'leader'] }, local: { enabled: false } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.spend.seats['claude']).toEqual({ enabled: true, reserveFloorPercent: 0, roles: ['producer', 'judge', 'leader'] });
    expect(result.payload.spend.seats['local']).toEqual({ ...draft.spend.seats['local'], enabled: false });
    expect(result.payload.spend.seats['grok']).toEqual(draft.spend.seats['grok']);
    expect(draft.spend.seats['claude']!.maxSessionWindowPercent).toBe(70);
    expect(result.payload.merge).toEqual(draft.merge);
  });
  it('refuses unknown identities, prototype names and invalid nested values', () => {
    const draft = makeGrant();
    expect(applyGrantScopeEdit(draft, { seatPolicies: { 'claude:new': { enabled: true } } }).ok).toBe(false);
    for (const seat of [{ reserveFloorPercent: -1 }, { reserveFloorPercent: 100.1 }, { maxSessionWindowPercent: 0 }, { maxSessionWindowPercent: 101 }, { roles: [] }, { roles: ['judge', 'judge'] }, { roles: ['root'] }, { enabled: 1 }, { unknown: 1 }]) expect(parseGrantScopeEdit({ seatPolicies: { claude: seat } }).ok).toBe(false);
    expect(applyGrantScopeEdit(draft, JSON.parse('{"seatPolicies":{"__proto__":{"enabled":true}}}')).ok).toBe(false);
  });
  it('retains strict Devin producer-only restrictions and selected-engine identity boundary', () => {
    const draft = editGrant(makeGrant(), (g) => { g.engines.push('devin'); g.spend.seats['devin'] = { enabled: true, reserveFloorPercent: 40, roles: ['producer'] }; });
    expect(editableSeatPolicies(draft)['devin']).toEqual({ roles: ['producer'] });
    expect(applyGrantScopeEdit(draft, { seatPolicies: { devin: { roles: ['judge'] } } }).ok).toBe(false);
    expect(applyGrantScopeEdit(draft, { engines: ['local', 'grok-cli', 'claude-cli', 'codex'], seatPolicies: { devin: { enabled: true } } }).ok).toBe(false);
  });
  it('shows every permission, role, reserve and session change before signing', () => {
    const current = makeGrant();
    const result = applyGrantScopeEdit(current, { seatPolicies: { claude: { enabled: false, roles: ['producer'], reserveFloorPercent: 0, maxSessionWindowPercent: null } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(grantScopeDiff(current, result.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'seat-enabled', before: 'Enabled', after: 'Disabled', direction: 'narrower' }),
      expect.objectContaining({ field: 'seat-roles', before: 'judge, leader', after: 'producer', direction: 'wider' }),
      expect.objectContaining({ field: 'seat-reserve', before: '40%', after: '0%', direction: 'wider' }),
      expect.objectContaining({ field: 'seat-session', before: '70%', after: 'No session ceiling', direction: 'wider' }),
    ]));
    const narrower = applyGrantScopeEdit(result.payload, { seatPolicies: { claude: { enabled: true, reserveFloorPercent: 100, maxSessionWindowPercent: 1 } } });
    if (!narrower.ok) throw new Error(narrower.reason);
    expect(grantScopeDiff(result.payload, narrower.payload)).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'seat-reserve', direction: 'narrower' }), expect.objectContaining({ field: 'seat-session', direction: 'narrower' })]));
    expect(grantScopeDiff(null, current).filter((line) => line.field.startsWith('seat-'))).toHaveLength(Object.keys(current.spend.seats).length * 4);
  });
});
