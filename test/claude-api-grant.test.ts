/** Synthetic private stores and proof readers only. No credentials, provider or real wallet. */
import { spawn } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import asyncFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../src/core/authority/canonical-json.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import {
  CLAUDE_API_GRANT_LEDGER_FILE, CLAUDE_API_GRANT_OBSERVATIONS_FILE, claudeApiGrantCutoff,
  createClaudeApiGrantAdmission, markClaudeApiGrantRequestSent, parseClaudeApiGrantObservation, parseClaudeApiGrantRecordedObservation,
  projectClaudeApiGrantView, readClaudeApiGrantObservations, readClaudeApiGrantViews,
  recordClaudeApiGrantObservation, releaseClaudeApiGrantBeforeContact, reserveClaudeApiGrantRequest,
  retainClaudeApiGrantUnknown, settleClaudeApiGrantRequest,
} from '../src/core/resources/claude-api-grant.js';
import { narrowClaudeApiGrantReadView, type ClaudeApiGrantBinding, type ClaudeApiGrantResult, type FreshClaudeApiGrantProof } from '../src/core/resources/claude-api-grant-types.js';
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const at = (offset = 0) => new Date(NOW + offset).toISOString();
const bind = (patch: Partial<ClaudeApiGrantBinding> = {}): ClaudeApiGrantBinding => ({ organizationDigest: 'a'.repeat(64), workspaceDigest: 'b'.repeat(64), credentialDigest: 'c'.repeat(64), generation: 'g1', ...patch });
function fresh(): FreshClaudeApiGrantProof {
  return {
    observation: { v: 1, kind: 'claude-api-promotion', observationId: 'obs-1', cycleId: 'cycle-1', binding: bind(), remainingUsdMicros: '200000000', totalUsdMicros: '200000000', capturedAt: at(), expiry: { precision: 'date', date: '2026-10-24', timezone: 'UTC', instant: null }, evidenceDigest: 'd'.repeat(64) },
    observedAt: at(), validUntil: at(60_000),
    funding: { source: 'verified-provider-billing', prepaid: true, invoiced: false, autoReload: 'off', purchasedUsdMicros: '0', otherPaidFunding: false },
    authority: { active: true, stop: false, localOnly: false, engineEnabled: true, repoAuthorized: true, roleAuthorized: true, meteredCeilingUsdMicros: '500000000', dailyRemainingUsdMicros: '500000000', identityDigest: 'e'.repeat(64) },
  };
}
function value<T>(result: ClaudeApiGrantResult<T>): T { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason); return result.value; }
let root: string;
let current: FreshClaudeApiGrantProof;
const reader = () => current;
const admission = () => value(createClaudeApiGrantAdmission({ expectedBinding: current.observation.binding, readFreshProof: reader, nowMs: NOW }));
const reserve = (id = 'call-1', amount = '100000000') => reserveClaudeApiGrantRequest({ root, admission: admission(), requestId: id, maxUsdMicros: amount, pricingDigest: 'f'.repeat(64), readFreshProof: reader, nowMs: NOW });
const ledgerPath = () => join(root, CLAUDE_API_GRANT_LEDGER_FILE);
const ledger = () => JSON.parse(readFileSync(ledgerPath(), 'utf8'));
const obsPath = () => join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE);
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-api-grant-'))); chmodSync(root, 0o700); current = fresh(); });
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); });

describe('Claude API promotional evidence', () => {
  it('uses an explicit conservative UTC-day cutoff and holds unknown or invalid dates', () => {
    expect(claudeApiGrantCutoff(current.observation.expiry)).toEqual({ at: '2026-10-24T00:00:00.000Z', policy: 'expiry-day-start/v1' });
    expect(claudeApiGrantCutoff({ ...current.observation.expiry, precision: 'instant', instant: '2026-10-24T18:00:00.000Z' })).toEqual({ at: '2026-10-24T18:00:00.000Z', policy: 'verified-instant/v1' });
    for (const expiry of [{ precision: 'unknown', date: null, timezone: null, instant: null }, { ...current.observation.expiry, date: '2026-02-30' }, { ...current.observation.expiry, timezone: 'PST' }]) expect(claudeApiGrantCutoff(expiry)).toBeNull();
  });
  it('keeps microUSD exact beyond Number precision and preserves unknown/expired historical facts', () => {
    const historical = { ...current.observation, remainingUsdMicros: '900719925474099312345', totalUsdMicros: null, expiry: { precision: 'unknown', date: null, timezone: null, instant: null } };
    expect(parseClaudeApiGrantObservation(historical, NOW)?.remainingUsdMicros).toBe('900719925474099312345');
    expect(projectClaudeApiGrantView(current.observation, Date.parse('2026-10-25T00:00:00.000Z'))).toMatchObject({ admissionCutoff: '2026-10-24T00:00:00.000Z', automaticAdmission: 'held' });
    expect(parseClaudeApiGrantObservation({ ...historical, remainingUsdMicros: null }, NOW)).not.toBeNull();
  });
  it.each(['future', 'decimal', 'negative', 'leading-zero', 'more-than-total', 'extra', 'getter', 'prototype'] as const)('rejects %s evidence without normalization or accessor execution', kind => {
    const row: Record<string, unknown> = { ...current.observation }; const getter = vi.fn();
    if (kind === 'future') row.capturedAt = at(1);
    if (kind === 'decimal') row.remainingUsdMicros = '1.5';
    if (kind === 'negative') row.remainingUsdMicros = '-1';
    if (kind === 'leading-zero') row.remainingUsdMicros = '01';
    if (kind === 'more-than-total') row.remainingUsdMicros = '200000001';
    if (kind === 'extra') row.authorized = true;
    if (kind === 'getter') Object.defineProperty(row, 'capturedAt', { get: getter });
    if (kind === 'prototype') Object.setPrototypeOf(row, { authorized: true });
    expect(parseClaudeApiGrantObservation(row, NOW)).toBeNull(); expect(getter).not.toHaveBeenCalled();
  });
  it('reads async history without minting admission, leaks no identity, and distinguishes absence/error', async () => {
    expect(await readClaudeApiGrantViews(root, NOW)).toEqual({ v: 1, state: process.platform === 'win32' ? 'unavailable' : 'missing', rows: [] });
    expect(recordClaudeApiGrantObservation(root, current.observation, NOW)).toEqual({ ok: true, value: undefined });
    expect(recordClaudeApiGrantObservation(root, current.observation, NOW).ok).toBe(true);
    const view = await readClaudeApiGrantViews(root, NOW);
    if (process.platform !== 'win32') {
      expect(view.state).toBe('healthy'); expect(view.rows).toHaveLength(1); expect(narrowClaudeApiGrantReadView(view)).toEqual(view);
      expect(value(await readClaudeApiGrantObservations(root, NOW))).toEqual([current.observation]);
    }
    expect(JSON.stringify(view)).not.toMatch(/organizationDigest|workspaceDigest|credentialDigest|generation|evidenceDigest/);
    expect(createClaudeApiGrantAdmission({ expectedBinding: bind(), nowMs: NOW })).toEqual({ ok: false, reason: 'proof-missing' });
    expect(ledger().rows).toEqual([]); expect(statSync(obsPath()).mode & 0o777).toBe(process.platform === 'win32' ? statSync(obsPath()).mode & 0o777 : 0o600);
    writeFileSync(obsPath(), '{'); expect(await readClaudeApiGrantViews(root, NOW)).toEqual({ v: 1, state: 'unavailable', rows: [] });
  });
  it('records actual unbound console history without invented identity or financial admission', async () => {
    const history = { ...current.observation, kind: 'claude-api-promotion-history', binding: null, cycleId: null };
    expect(parseClaudeApiGrantObservation(history, NOW)).toBeNull();
    expect(parseClaudeApiGrantRecordedObservation(history, NOW)).toEqual(history);
    value(recordClaudeApiGrantObservation(root, history, NOW));
    if (process.platform !== 'win32') {
      expect(value(await readClaudeApiGrantObservations(root, NOW))).toEqual([history]);
      expect(await readClaudeApiGrantViews(root, NOW)).toMatchObject({ state: 'healthy', rows: [{ remainingUsdMicros: '200000000', expiryDate: '2026-10-24', automaticAdmission: 'held' }] });
    }
    expect(ledger().rows).toEqual([]); expect(ledger().ceilings).toEqual([]);
    const recorded = JSON.parse(readFileSync(obsPath(), 'utf8')).observations[0];
    expect(recorded.binding).toBeNull(); expect(recorded.cycleId).toBeNull();
    const fake = { ...current, observation: history } as unknown as FreshClaudeApiGrantProof;
    expect(createClaudeApiGrantAdmission({ readFreshProof: () => fake, expectedBinding: bind(), nowMs: NOW })).toEqual({ ok: false, reason: 'proof-invalid' });
    for (const wrong of [{ ...history, binding: bind() }, { ...history, cycleId: 'fabricated' }, { ...history, remainingUsdMicros: '200000001' }, { ...history, authorized: true }]) expect(parseClaudeApiGrantRecordedObservation(wrong, NOW)).toBeNull();
  });
  it('refuses conflicting observation identities, partial stores and noncanonical bytes', async () => {
    value(recordClaudeApiGrantObservation(root, current.observation, NOW));
    expect(recordClaudeApiGrantObservation(root, { ...current.observation, remainingUsdMicros: '1' }, NOW)).toEqual({ ok: false, reason: 'proof-invalid' });
    for (const raw of [JSON.stringify({ v: 1, observations: [current.observation] }), canonicalJson({ v: 1, observations: [current.observation, current.observation] }), canonicalJson({ v: 1, observations: [current.observation, {}] })]) {
      writeFileSync(obsPath(), raw); expect((await readClaudeApiGrantViews(root, NOW)).state).toBe('unavailable');
    }
  });
  it('narrowing refuses forged admission, sparse/accessor/oversized display transport and bad cutoff', () => {
    const view = { v: 1, state: 'healthy', rows: [projectClaudeApiGrantView(current.observation, NOW)] };
    expect(narrowClaudeApiGrantReadView(view)).toEqual(view);
    for (const changed of [{ ...view, rows: [{ ...view.rows[0], automaticAdmission: 'ready' }] }, { ...view, state: 'missing' }, { ...view, rows: new Array(1) }, { ...view, rows: new Array(4097).fill(view.rows[0]) }, { ...view, rows: [{ ...view.rows[0], admissionCutoff: '2026-10-24T12:00:00.000Z' }] }]) expect(narrowClaudeApiGrantReadView(changed)).toBeNull();
    const coercion = vi.fn(() => 'healthy');
    expect(narrowClaudeApiGrantReadView({ ...view, state: { toString: coercion } })).toBeNull(); expect(coercion).not.toHaveBeenCalled();
    const policyCoercion = vi.fn(() => 'expiry-day-start/v1');
    expect(narrowClaudeApiGrantReadView({ ...view, rows: [{ ...view.rows[0], cutoffPolicy: { toString: policyCoercion } }] })).toBeNull(); expect(policyCoercion).not.toHaveBeenCalled();
    const iterator = vi.fn(); const inherited = [view.rows[0]]; Object.setPrototypeOf(inherited, { [Symbol.iterator]: iterator });
    expect(narrowClaudeApiGrantReadView({ ...view, rows: inherited })).toBeNull(); expect(iterator).not.toHaveBeenCalled();
    const getter = vi.fn(); Object.defineProperty(view.rows, '0', { get: getter }); expect(narrowClaudeApiGrantReadView(view)).toBeNull(); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['symlink', 'hardlink', 'public-mode', 'oversize'] as const)('holds unsafe %s evidence instead of displaying zero', async kind => {
    const target = join(root, 'target'); writeFileSync(target, canonicalJson({ v: 1, observations: [current.observation] }), { mode: 0o600 });
    if (kind === 'symlink') symlinkSync(target, obsPath());
    if (kind === 'hardlink') linkSync(target, obsPath());
    if (kind === 'public-mode' || kind === 'oversize') writeFileSync(obsPath(), kind === 'oversize' ? ' '.repeat(1024 * 1024 + 1) : readFileSync(target), { mode: 0o600 });
    if (kind === 'public-mode') chmodSync(obsPath(), 0o644);
    expect((await readClaudeApiGrantViews(root, NOW)).state).toBe('unavailable');
  });
  it('refuses mutation during asynchronous descriptor reads and invalid UTF8', async () => {
    value(recordClaudeApiGrantObservation(root, current.observation, NOW));
    const original = asyncFs.open;
    vi.spyOn(asyncFs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args); const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs); chmodSync(obsPath(), 0o644); return result;
      }) as typeof handle.read; return handle;
    });
    syncBuiltinESMExports();
    expect((await readClaudeApiGrantViews(root, NOW)).state).toBe('unavailable'); vi.restoreAllMocks(); syncBuiltinESMExports();
    chmodSync(obsPath(), 0o600); writeFileSync(obsPath(), Buffer.from([0xff])); expect((await readClaudeApiGrantViews(root, NOW)).state).toBe('unavailable');
  });
});

describe('source-owned fresh admission', () => {
  it.each(['missing', 'throw', 'stale', 'overlong', 'future', 'old-observation', 'unknown-balance', 'unknown-expiry', 'cutoff', 'binding', 'zero-authority', 'stopped', 'local-only', 'repo', 'role', 'disabled', 'invoiced', 'autoreload', 'purchased', 'paid-unknown', 'not-prepaid'] as const)('holds %s without minting capability', kind => {
    let read: (() => FreshClaudeApiGrantProof | null) | undefined = reader;
    if (kind === 'missing') read = undefined; if (kind === 'throw') read = () => { throw new Error('private descriptor'); };
    if (kind === 'stale') current.validUntil = at(); if (kind === 'overlong') current.validUntil = at(60_001);
    if (kind === 'future') current.observedAt = at(1); if (kind === 'old-observation') current.observation.capturedAt = at(-1);
    if (kind === 'unknown-balance') current.observation.remainingUsdMicros = null;
    if (kind === 'unknown-expiry') current.observation.expiry = { precision: 'unknown', date: null, timezone: null, instant: null };
    if (kind === 'cutoff') current.observation.expiry = { precision: 'date', date: '2026-10-09', timezone: 'UTC', instant: null };
    if (kind === 'binding') current.observation.binding.generation = 'new';
    if (kind === 'zero-authority') current.authority.meteredCeilingUsdMicros = '0'; if (kind === 'stopped') current.authority.stop = true;
    if (kind === 'local-only') current.authority.localOnly = true; if (kind === 'repo') current.authority.repoAuthorized = false;
    if (kind === 'role') current.authority.roleAuthorized = false; if (kind === 'disabled') current.authority.engineEnabled = false;
    if (kind === 'invoiced') current.funding.invoiced = true; if (kind === 'autoreload') current.funding.autoReload = 'on';
    if (kind === 'purchased') current.funding.purchasedUsdMicros = '1'; if (kind === 'paid-unknown') current.funding.otherPaidFunding = null;
    if (kind === 'not-prepaid') current.funding.prepaid = false;
    const held = createClaudeApiGrantAdmission({ readFreshProof: read, expectedBinding: bind(), nowMs: NOW });
    expect(held.ok).toBe(false); expect(JSON.stringify(held)).not.toContain('private descriptor');
  });
  it('rejects serialized admission and copied reservation objects', () => {
    const cap = admission(); expect(reserveClaudeApiGrantRequest({ root, admission: { ...cap }, requestId: 'forged', maxUsdMicros: '1', pricingDigest: 'f'.repeat(64), readFreshProof: reader, nowMs: NOW })).toEqual({ ok: false, reason: 'reservation-invalid' });
    const reservation = value(reserve()); expect(markClaudeApiGrantRequestSent({ ...reservation }, NOW)).toEqual({ ok: false, reason: 'reservation-invalid' });
  });
  it.each(['stop', 'funding', 'binding', 'cutoff', 'authority', 'balance'] as const)('rechecks %s immediately before possible contact', change => {
    const reserved = value(reserve());
    if (change === 'stop') current.authority.stop = true; if (change === 'funding') current.funding.purchasedUsdMicros = '1';
    if (change === 'binding') current.observation.binding.credentialDigest = '9'.repeat(64);
    if (change === 'cutoff') current.observation.expiry = { precision: 'date', date: '2026-10-25', timezone: 'UTC', instant: null };
    if (change === 'authority') current.authority.identityDigest = '0'.repeat(64); if (change === 'balance') current.observation.remainingUsdMicros = '1';
    expect(markClaudeApiGrantRequestSent(reserved, NOW).ok).toBe(false); expect(ledger().rows[0].state).toBe('reserved');
    value(releaseClaudeApiGrantBeforeContact(reserved)); expect(ledger().rows[0].heldUsdMicros).toBe('0');
  });
});

describe('durable shared-org microUSD reservations', () => {
  it('shares balance across keys/workspaces and keeps other organizations separate', () => {
    value(reserve('a', '150000000')); current.observation.binding = bind({ credentialDigest: '8'.repeat(64), workspaceDigest: '9'.repeat(64) });
    expect(reserve('b', '50000001')).toEqual({ ok: false, reason: 'balance-exhausted' }); value(reserve('b', '50000000'));
    current.observation.binding = bind({ organizationDigest: '0'.repeat(64) }); value(reserve('other-org', '200000000'));
    expect(ledger().rows).toHaveLength(3); expect(ledger().ceilings).toHaveLength(2);
  });
  it('settles only actual exact cost, once; request replay cannot reset the ceiling', () => {
    const cap = value(reserve('first', '150000000')); value(markClaudeApiGrantRequestSent(cap, NOW)); value(settleClaudeApiGrantRequest(cap, 'msg_013Zva2CMHLNnXjNJJKqJ2EF', '100000001'));
    value(settleClaudeApiGrantRequest(cap, 'msg_013Zva2CMHLNnXjNJJKqJ2EF', '100000001'));
    expect(settleClaudeApiGrantRequest(cap, 'msg_013Zva2CMHLNnXjNJJKqJ2EF', '0')).toEqual({ ok: false, reason: 'settlement-invalid' });
    expect(reserve('first', '1')).toEqual({ ok: false, reason: 'request-recorded' });
    expect(reserve('second', '100000000')).toEqual({ ok: false, reason: 'balance-exhausted' }); value(reserve('second', '99999999'));
    expect(ledger().rows[0]).toMatchObject({ state: 'settled', actualUsdMicros: '100000001', heldUsdMicros: '0' });
  });
  it('retains unknowns after contact across restarts/days/new cycles, with no paid fallback', () => {
    const cap = value(reserve('unknown', '150000000')); value(markClaudeApiGrantRequestSent(cap, NOW)); value(retainClaudeApiGrantUnknown(cap));
    expect(releaseClaudeApiGrantBeforeContact(cap)).toEqual({ ok: false, reason: 'request-not-reserved' });
    const later = NOW + 86_400_000; current.observedAt = new Date(later).toISOString(); current.validUntil = new Date(later + 60_000).toISOString(); current.observation.capturedAt = current.observedAt; current.observation.cycleId = 'cycle-2';
    const next = value(createClaudeApiGrantAdmission({ expectedBinding: bind(), readFreshProof: reader, nowMs: later }));
    expect(reserveClaudeApiGrantRequest({ root, admission: next, requestId: 'new-day', maxUsdMicros: '50000001', pricingDigest: 'f'.repeat(64), readFreshProof: reader, nowMs: later })).toEqual({ ok: false, reason: 'balance-exhausted' });
    expect(ledger().rows[0]).toMatchObject({ state: 'unknown', heldUsdMicros: '150000000' });
  });
  it('retains a verified overrun instead of freeing the max estimate or swallowing cost', () => {
    const cap = value(reserve('overrun', '100')); value(markClaudeApiGrantRequestSent(cap, NOW));
    expect(settleClaudeApiGrantRequest(cap, 'msg_overrun', '300000000')).toEqual({ ok: false, reason: 'cost-exceeds-reservation' });
    expect(ledger().rows[0]).toMatchObject({ state: 'unknown', heldUsdMicros: '300000000', actualUsdMicros: null });
    expect(reserve('later', '1')).toEqual({ ok: false, reason: 'balance-exhausted' });
    expect(settleClaudeApiGrantRequest(cap, 'msg_overrun', '0')).toEqual({ ok: false, reason: 'settlement-invalid' });
    expect(ledger().rows[0].heldUsdMicros).toBe('300000000');
  });
  it('refuses duplicated provider settlement across owned requests', () => {
    const a = value(reserve('a', '1')); const b = value(reserve('b', '1')); value(markClaudeApiGrantRequestSent(a, NOW)); value(markClaudeApiGrantRequestSent(b, NOW));
    value(settleClaudeApiGrantRequest(a, 'msg_shared', '1')); expect(settleClaudeApiGrantRequest(b, 'msg_shared', '0')).toEqual({ ok: false, reason: 'settlement-invalid' }); expect(ledger().rows[1].state).toBe('sent');
  });
  it('does not extend a recorded cycle cutoff through a new capability or reset its balance', () => {
    value(reserve('first', '1')); current.observation.expiry = { precision: 'date', date: '2026-10-25', timezone: 'UTC', instant: null };
    expect(reserve('extended', '1')).toEqual({ ok: false, reason: 'binding-changed' });
  });
  it('enforces the existing signed daily ceiling and preserves zero metered authority', () => {
    current.authority.meteredCeilingUsdMicros = '100'; value(reserve('a', '60')); expect(reserve('b', '41')).toEqual({ ok: false, reason: 'daily-limit' });
    current.authority.meteredCeilingUsdMicros = '0'; expect(createClaudeApiGrantAdmission({ readFreshProof: reader, expectedBinding: bind(), nowMs: NOW })).toEqual({ ok: false, reason: 'authority-held' });
  });
  it('refuses changed request/pricing identity in the private ledger', () => {
    const cap = value(reserve()); const raw = ledger(); raw.rows[0].pricingDigest = '0'.repeat(64); writeFileSync(ledgerPath(), canonicalJson(raw));
    expect(markClaudeApiGrantRequestSent(cap, NOW)).toEqual({ ok: false, reason: 'reservation-invalid' });
  });
  it.each(['malformed', 'duplicate', 'settled-overrun', 'public-mode', 'symlink', 'hardlink'] as const)('holds %s ledger rather than assuming zero exposure', kind => {
    value(reserve()); const raw = ledger();
    if (kind === 'malformed') writeFileSync(ledgerPath(), '{');
    if (kind === 'duplicate') { raw.rows.push(raw.rows[0]); writeFileSync(ledgerPath(), canonicalJson(raw)); }
    if (kind === 'settled-overrun') { Object.assign(raw.rows[0], { state: 'settled', actualUsdMicros: '200000000', providerRequestId: 'msg_013Zva2CMHLNnXjNJJKqJ2EF', heldUsdMicros: '0' }); writeFileSync(ledgerPath(), canonicalJson(raw)); }
    if (kind === 'public-mode') chmodSync(ledgerPath(), 0o644);
    if (kind === 'symlink' || kind === 'hardlink') { const target = join(root, 'ledger-copy'); writeFileSync(target, canonicalJson(raw), { mode: 0o600 }); rmSync(ledgerPath()); if (kind === 'symlink') symlinkSync(target, ledgerPath()); else linkSync(target, ledgerPath()); }
    expect(reserve('b', '1')).toEqual({ ok: false, reason: 'store-unavailable' });
  });
  it('fails closed during another process-owned lock without writing a request', () => {
    const lock = acquireLocalStoreLock(join(root, '.claude-api-grants.lock'), 0, { anchorPath: root, exactPrivateStorage: true }); expect(lock).not.toBeNull();
    try { expect(reserve()).toEqual({ ok: false, reason: 'store-busy' }); } finally { expect(releaseLocalStoreLock(lock!)).toBe(true); }
  });
  it('serializes actual competing processes against one shared org ceiling', async () => {
    const driverRoot = join(root, 'driver'); mkdirSync(driverRoot, { mode: 0o700 }); const store = join(root, 'store'); mkdirSync(store, { mode: 0o700 });
    const module = resolve('src/core/resources/claude-api-grant.ts'); const driver = join(driverRoot, 'race.mjs');
    writeFileSync(driver, `import {createClaudeApiGrantAdmission,reserveClaudeApiGrantRequest} from ${JSON.stringify(module)};\nconst p=${JSON.stringify(fresh())};const a=createClaudeApiGrantAdmission({expectedBinding:p.observation.binding,readFreshProof:()=>p,nowMs:${NOW}});const r=a.ok?reserveClaudeApiGrantRequest({root:process.argv[2],admission:a.value,requestId:process.argv[3],maxUsdMicros:'150000000',pricingDigest:'${'f'.repeat(64)}',readFreshProof:()=>p,nowMs:${NOW}}):a;process.stdout.write(JSON.stringify(r.ok?{ok:true}:r));`, { mode: 0o600 });
    const run = (id: string) => new Promise<string>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', driver, store, id], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = '';
      child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; }); child.on('error', reject); child.on('close', code => code === 0 ? done(out) : reject(new Error(err)));
    });
    const outcomes = (await Promise.all([run('a'), run('b')])).map(text => JSON.parse(text)); expect(outcomes.filter(row => row.ok)).toHaveLength(1);
    expect(['balance-exhausted', 'store-busy']).toContain(outcomes.find(row => !row.ok).reason);
    expect(JSON.parse(readFileSync(join(store, CLAUDE_API_GRANT_LEDGER_FILE), 'utf8')).rows).toHaveLength(1);
  }, 20_000);
});
