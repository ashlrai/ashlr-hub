import { describe, expect, it } from 'vitest';
import { assertWebsiteDeployment, parseWebsiteStageOutput } from '../src/core/website/host-adapter.js';
import { WEBSITE_PROFILE, type WebsiteOperation } from '../src/core/website/host-release.js';

// Pure stdout JSON captured from the pinned CLI63.1.0 non-interactive deployment.
// Terminal diagnostics were stderr; productionUrl deliberately differs from url.
const capturedStdout = `{
  "status": "ok",
  "deployment": {
    "id": "dpl_3GxzJxFrGvYLtcEBKs1RnQoUa3bk",
    "url": "https://web-hhxhav98s-evero.vercel.app",
    "productionUrl": "https://web-evero.vercel.app",
    "inspectorUrl": "https://vercel.com/evero/web/3GxzJxFrGvYLtcEBKs1RnQoUa3bk",
    "readyState": "READY",
    "target": "production",
    "deploymentApiUrl": "https://api.vercel.com/v13/deployments/dpl_3GxzJxFrGvYLtcEBKs1RnQoUa3bk",
    "buildMachine": {
      "cores": 4,
      "memory": 8192,
      "machine": "standard",
      "selectionType": "fixed",
      "selectionSource": "plan-default"
    },
    "deploymentProtection": [
      "vercel_authentication"
    ]
  },
  "message": "Deployment web-hhxhav98s-evero.vercel.app ready. Production URL: https://web-evero.vercel.app",
  "next": [
    {
      "command": "vercel git connect --scope evero",
      "when": "Automatically deploy changes on every push"
    },
    {
      "command": "vercel curl https://web-evero.vercel.app",
      "when": "Verify deployment, including when Deployment Protection is enabled"
    },
    {
      "command": "vercel inspect web-hhxhav98s-evero.vercel.app --scope evero",
      "when": "Inspect deployment"
    },
    {
      "command": "vercel deploy --prod --scope evero",
      "when": "Promote to production"
    }
  ]
}`;
const captured = JSON.parse(capturedStdout);
const merge = 'a'.repeat(40);
const teamId = 'team_fixture';
function operation(): WebsiteOperation {
  return { v: 1, id: '1'.repeat(64), revision: merge, profileDigest: '2'.repeat(64),
    phase: 'staged', at: new Date(0).toISOString(), reason: null,
    source: { merge, head: 'b'.repeat(40), base: 'c'.repeat(40), tree: 'd'.repeat(40), pr: 1, rulesDigest: 'e'.repeat(64) },
    deploymentId: captured.deployment.id, deploymentUrl: captured.deployment.url };
}
function observed(): Record<string, unknown> {
  return { id: captured.deployment.id, url: new URL(captured.deployment.url).hostname,
    projectId: WEBSITE_PROFILE.projectId, ownerId: teamId, team: { id: teamId },
    target: 'production', readyState: 'READY', meta: { phantomSourceSha: merge } };
}
function output(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...captured, deployment: { ...captured.deployment, ...patch } });
}

describe('pinned non-interactive website stage output', () => {
  it('selects the exact stage ID and URL from the real CLI63.1.0 JSON envelope', () => {
    expect(parseWebsiteStageOutput(capturedStdout)).toEqual({ id: captured.deployment.id, url: captured.deployment.url });
    expect(captured.deployment.productionUrl).not.toBe(captured.deployment.url);
    expect(() => assertWebsiteDeployment(operation(), teamId, observed())).not.toThrow();
  });
  it('ignores arbitrary productionUrl and guidance instead of selecting their URLs', () => {
    const response = { ...captured, deployment: { ...captured.deployment, productionUrl: 'https://evil.example' },
      message: 'https://evil.example', next: [{ command: 'evil' }] };
    expect(parseWebsiteStageOutput(JSON.stringify(response)).url).toBe(captured.deployment.url);
    delete response.deployment.url;
    expect(() => parseWebsiteStageOutput(JSON.stringify(response))).toThrow();
  });
  it.each(['https://evil.example', 'http://stage.vercel.app', 'https://stage.vercel.app.evil.example',
    'https://user@stage.vercel.app', 'https://stage.vercel.app:443', 'https://stage.vercel.app/path',
    'https://stage.vercel.app?x=1', 'https://stage.vercel.app#hash', 'https://.vercel.app',
    'https://-stage.vercel.app', 'https://STAGE.vercel.app', 'https://stage.vercel.app\n'])('rejects malformed or foreign selected URL %j', (url) => {
    expect(() => parseWebsiteStageOutput(output({ url }))).toThrow();
  });
  it.each(['deployment', 'dpl_', 'dpl_fixture/foreign', 'dpl_fixture?query', '', null])('rejects invalid stage ID %j', (id) => {
    expect(() => parseWebsiteStageOutput(output({ id }))).toThrow();
  });
  it('rejects errors, partial/stale state, preview targets, non-JSON and mixed logs', () => {
    for (const status of ['error', 'action_required', undefined]) expect(() => parseWebsiteStageOutput(JSON.stringify({ ...captured, status }))).toThrow();
    for (const readyState of ['BUILDING', 'QUEUED', 'ERROR', undefined]) expect(() => parseWebsiteStageOutput(output({ readyState }))).toThrow();
    for (const target of ['preview', null, undefined]) expect(() => parseWebsiteStageOutput(output({ target }))).toThrow();
    for (const text of ['https://stage.vercel.app', '[]', '{}', 'null', `log\n${capturedStdout}`, `${capturedStdout}\n{}`]) expect(() => parseWebsiteStageOutput(text)).toThrow();
    expect(() => parseWebsiteStageOutput(JSON.stringify({ ...captured, message: 'x'.repeat(64 * 1024) }))).toThrow('too large');
  });
});

describe('fresh provider deployment binding', () => {
  it.each([
    ['id', 'dpl_other'], ['projectId', 'prj_other'], ['ownerId', 'team_other'], ['team', { id: 'team_other' }],
    ['team', undefined], ['target', 'preview'], ['readyState', 'BUILDING'], ['meta', { phantomSourceSha: 'f'.repeat(40) }],
    ['meta', {}], ['meta', undefined], ['url', 'other.vercel.app'], ['url', 'evil.example'],
  ])('rejects mismatched or stale %s', (key, value) => {
    expect(() => assertWebsiteDeployment(operation(), teamId, { ...observed(), [key]: value })).toThrow();
  });
  it('rejects a provider returning the production alias instead of the selected stage URL', () => {
    expect(() => assertWebsiteDeployment(operation(), teamId, { ...observed(), url: new URL(captured.deployment.productionUrl).hostname })).toThrow('URL changed');
  });
  it('requires persisted qualification and cannot bind to an arbitrary operation revision', () => {
    const op = operation(); delete op.source;
    expect(() => assertWebsiteDeployment(op, teamId, observed())).toThrow();
    op.source = operation().source; op.revision = 'f'.repeat(40);
    expect(() => assertWebsiteDeployment(op, teamId, observed())).toThrow('does not match operation revision');
  });
});
