/**
 * 3.15 — the grant editor's pure edit and diff (src/core/authority/grant-scope.ts).
 * An edit can only CHOOSE within the server's draft; every rung is narrowed to
 * match; an invalid result is refused, never repaired.
 */
import { describe, expect, it } from 'vitest';

import { applyGrantScopeEdit, editableEngines, grantScopeDiff, parseGrantScopeEdit } from '../src/core/authority/grant-scope.js';
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
    expect(lines.map((l) => l.field)).toEqual(['repos', 'engines', 'leader', 'spend-mode', 'metered', 'expiry']);
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
