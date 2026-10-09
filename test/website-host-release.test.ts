import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import { makeGrant } from './helpers/authority-310b.js';
import { canonicalJson } from '../src/core/authority/canonical-json.js';
import { parseStandingGrantPayload, standingGrantSigningBytes, describeGrantScope, buildReapprovalGrantPayload } from '../src/core/authority/standing-grant.js';
import { WEBSITE_PROFILE, drainWebsitePublication, inventoryWebsiteOutput, readWebsiteCommission, requestWebsitePublication, saveWebsiteCommission, setWebsiteMode, websiteDigest, websiteScope, websiteStatus, type WebsiteCommission, type WebsiteHostAdapter, type WebsiteSource } from '../src/core/website/host-release.js';
const live = vi.hoisted(() => ({ policy: null as EffectivePolicy | null, kill: false }));
vi.mock('../src/core/authority/effective-config.js', () => ({ evaluateStandingAuthority: () => ({ policy: live.policy }), currentStandingPolicy: () => live.policy }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => live.kill }));
let home: string; let oldHome: string | undefined; let commission: WebsiteCommission; let output: string;
const source: WebsiteSource = { merge: 'a'.repeat(40), head: 'b'.repeat(40), base: 'c'.repeat(40), tree: 'd'.repeat(40), pr: 138, rulesDigest: 'e'.repeat(64) };
function adapter(): WebsiteHostAdapter & { stage: ReturnType<typeof vi.fn>; promote: ReturnType<typeof vi.fn> } {
  return { currentMerge: async () => source.merge, qualifySource: async () => ({ ...source }), build: async () => inventoryWebsiteOutput(output).digest,
    identities: async () => {}, aliases: async () => ({ 'phm.dev': 'dpl_previous' }), output: () => output,
    stage: vi.fn(async (_op, authorize) => { await authorize(); return { id: 'dpl_new', url: 'https://new.vercel.app' }; }),
    validateStage: async () => {}, promote: vi.fn(async (_op, authorize) => { await authorize(); }), published: async () => true };
}
beforeEach(() => {
  oldHome = process.env['HOME']; home = mkdtempSync(join(tmpdir(), 'phantom-web-publish-')); process.env['HOME'] = home;
  const payload = { v: 1 as const, profile: WEBSITE_PROFILE, actorId: 'user_owner', teamId: 'team_owner', domains: ['phm.dev'], projectSettings: {}, publicBuildEnv: {},
    toolchain: { node: '/held/node', nodeSha256: '0'.repeat(64), cli: '/held/cli', treeSha256: '1'.repeat(64), image: `sha256:${'2'.repeat(64)}`, docker: '/held/docker', dockerSha256: '3'.repeat(64) },
    builderQualification: { source, outputDigest: 'f'.repeat(64), image: `sha256:${'2'.repeat(64)}` } };
  commission = { ...payload, profileDigest: websiteDigest(payload) }; saveWebsiteCommission(commission);
  live.policy = { switch: 'autonomous', expiresAt: new Date(Date.now()+60_000).toISOString(), repos: [{ nameWithOwner: WEBSITE_PROFILE.repo }], websitePublication: websiteScope(commission) } as EffectivePolicy;
  live.kill = false; setWebsiteMode('auto'); output = join(home, 'output'); mkdirSync(output); writeFileSync(join(output, 'config.json'), '{"version":3}'); writeFileSync(join(output, 'page.html'), 'Phantom');
});
afterEach(() => { process.env['HOME'] = oldHome; if (oldHome === undefined) delete process.env['HOME']; rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });
describe('website signed scope', () => {
  it('keeps absent payload bytes unchanged and accepts only the closed optional scope', () => {
    const grant = makeGrant(); const oldBytes = standingGrantSigningBytes(grant);
    const absent = parseStandingGrantPayload(grant); expect(absent.ok).toBe(true);
    if (absent.ok) { expect(standingGrantSigningBytes(absent.value)).toEqual(oldBytes); expect('websitePublication' in absent.value).toBe(false); }
    const withScope = { ...grant, websitePublication: websiteScope(commission) }; const parsed = parseStandingGrantPayload(withScope);
    expect(parsed.ok).toBe(true); if (parsed.ok) expect(canonicalJson(parsed.value)).toBe(canonicalJson(withScope));
    expect(describeGrantScope(withScope).join('\n')).toContain('automatic publication of Phantom website / phm.dev');
    for (const web of [null, { ...websiteScope(commission), extra: true }, { ...websiteScope(commission), profile: 'other' }, { ...websiteScope(commission), mode: 'preview' }, { ...websiteScope(commission), profileDigest: 'bad' }]) expect(parseStandingGrantPayload({ ...grant, websitePublication: web }).ok).toBe(false);
  });
  it('continues the same publication scope without resetting the owner preference', () => {
    setWebsiteMode('paused'); const grant = { ...makeGrant(), websitePublication: websiteScope(commission) };
    const next = buildReapprovalGrantPayload(grant, 0, { grantId: 'f'.repeat(32), grantSeq: grant.grantSeq+1, keyId: grant.keyId, hostBinding: grant.hostBinding, authoritySurfaceDigest: grant.authoritySurfaceDigest, nowMs: Date.parse(grant.issuedAt)+1000 });
    expect(next.websitePublication).toEqual(grant.websitePublication); expect(websiteStatus().mode).toBe('paused');
  });
});
describe('real private website state and output', () => {
  it('deduplicates identical requests and refuses additional input authority', () => {
    expect(requestWebsitePublication({ profile: WEBSITE_PROFILE.name, expectedMerge: source.merge }).status).toBe('queued');
    expect(requestWebsitePublication({ profile: WEBSITE_PROFILE.name, expectedMerge: source.merge }).status).toBe('already-recorded');
    expect(() => requestWebsitePublication({ profile: WEBSITE_PROFILE.name, expectedMerge: source.merge, command: 'deploy' })).toThrow();
  });
  it('Auto/Pause/Off are reversible with the same valid scope and never clear Stop', () => {
    setWebsiteMode('off'); expect(websiteStatus().mode).toBe('off'); setWebsiteMode('auto'); expect(websiteStatus().mode).toBe('auto');
    live.kill = true; expect(requestWebsitePublication({ profile: WEBSITE_PROFILE.name, expectedMerge: source.merge }).status).toBe('held'); expect(live.kill).toBe(true);
    live.policy = null; expect(() => setWebsiteMode('auto')).toThrow(); setWebsiteMode('paused'); expect(websiteStatus().mode).toBe('paused');
  });
  it('rejects edited commissioning metadata and public-readable operation state', () => {
    const file = join(home, '.ashlr','authority','website-commission.json'); const text = JSON.parse(readFileSync(file,'utf8')); text.actorId='user_other'; writeFileSync(file, JSON.stringify(text)); expect(() => readWebsiteCommission()).toThrow();
    saveWebsiteCommission(commission); const state = join(home,'.ashlr','authority','website-publication.json'); chmodSync(state, 0o644); expect(websiteStatus().phase).toBe('held');
  });
  it('pins every output file and refuses symlink escapes and missing config', () => {
    const first = inventoryWebsiteOutput(output); writeFileSync(join(output,'page.html'),'changed'); expect(inventoryWebsiteOutput(output).digest).not.toBe(first.digest);
    symlinkSync('/etc/passwd',join(output,'escape')); expect(() => inventoryWebsiteOutput(output)).toThrow(); rmSync(join(output,'escape')); rmSync(join(output,'config.json')); expect(() => inventoryWebsiteOutput(output)).toThrow();
  });
});
// These cases exercise real durable writes and native private-path/lock inspection, not in-memory mocks.
describe('deterministic publication and uncertainty', { timeout: 30_000 }, () => {
  it('stages and promotes the same deployment once; replay never contacts again', async () => {
    const host = adapter(); await drainWebsitePublication(host); expect(host.stage).toHaveBeenCalledTimes(1); expect(host.promote).toHaveBeenCalledTimes(1);
    expect(host.promote.mock.calls[0]?.[0].deploymentId).toBe('dpl_new'); expect(websiteStatus().phase).toBe('published');
    await drainWebsitePublication(host); expect(host.stage).toHaveBeenCalledTimes(1); expect(host.promote).toHaveBeenCalledTimes(1);
  });
  it('late Stop before upload blocks all contact', async () => {
    const host=adapter(); host.aliases=async () => { live.kill=true; return { 'phm.dev':'dpl_previous' }; }; await drainWebsitePublication(host);
    expect(host.stage).not.toHaveBeenCalled(); expect(host.promote).not.toHaveBeenCalled();
  });
  it('pause then resume during the operation changes the epoch and prevents contact', async () => {
    const host=adapter(); host.build=async () => { setWebsiteMode('paused'); setWebsiteMode('auto'); return inventoryWebsiteOutput(output).digest; };
    await drainWebsitePublication(host); expect(host.stage).not.toHaveBeenCalled();
  });
  it('source or aliases changing before promotion hold the exact revision', async () => {
    const host=adapter(); let count=0; host.qualifySource=async () => (++count > 1 ? { ...source, rulesDigest:'f'.repeat(64) } : { ...source });
    await drainWebsitePublication(host); expect(host.stage).not.toHaveBeenCalled();
    // A held revision is not blindly retried on every poll.
    await drainWebsitePublication(host); expect(host.stage).not.toHaveBeenCalled();
  });
  it('ambiguous upload is never retried without a known deployment to reconcile', async () => {
    const host=adapter(); host.stage.mockImplementation(async () => { throw new Error('timeout'); }); await drainWebsitePublication(host);
    expect(websiteStatus().phase).toBe('upload-unknown'); await drainWebsitePublication(host); expect(host.stage).toHaveBeenCalledTimes(1); expect(host.promote).not.toHaveBeenCalled();
  });
  it('ambiguous promotion is reconciled read-only without another promotion', async () => {
    const host=adapter(); host.promote.mockImplementation(async () => { throw new Error('timeout'); }); host.published=async () => false;
    await drainWebsitePublication(host); expect(websiteStatus().phase).toBe('promotion-unknown'); host.published=async () => true;
    await drainWebsitePublication(host); expect(host.promote).toHaveBeenCalledTimes(1); expect(websiteStatus().phase).toBe('published');
  });
  it('a route failure stays promoted-unverified instead of pretending production succeeded', async () => {
    const host=adapter(); host.published=async () => false; await drainWebsitePublication(host); expect(websiteStatus().phase).toBe('promoted-unverified');
  });
});
