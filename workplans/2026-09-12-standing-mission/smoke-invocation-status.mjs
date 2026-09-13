/** Compiled CLI observation smoke. Creates/removes only its own temporary fixture; no execution or providers. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const load = file => import(pathToFileURL(join(repository, 'dist', file)).href);
const { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } = await load('core/fleet/local-store-lock.js');
const { beginEngineeringMissionInvocation } = await load('core/resources/engineering-mission-invocations.js');
const { readKillSwitch } = await load('core/sandbox/policy.js');
const kill = readKillSwitch();
const base = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-invocation-status-')));
const root = join(base, 'mission'); mkdirSync(root, { mode: 0o700 });
let lease;
const snapshot = path => {
  const stat = lstatSync(path, { bigint: true });
  return { identity: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
    content: stat.isDirectory() ? readdirSync(path).sort().map(name => [name, snapshot(join(path, name))]) :
      createHash('sha256').update(readFileSync(path)).digest('hex') };
};
try {
  const config = { schemaVersion: 1, id: 'compiled-smoke', root, maxScopes: 2, pollIntervalMs: 100,
    deadlineAt: '2020-01-01T00:00:00.000Z', initial: { expectedPlanDigest: 'a'.repeat(64), setup: {
      recipe: {}, policy: {}, output: join(base, 'missing-output'), resourceRuntime: join(base, 'missing-runtime'),
      workspace: join(base, 'missing-project'), projectsFile: join(base, 'missing-projects'),
    } } };
  const file = join(base, 'config.json'); writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  lease = acquireLocalStoreLock(join(root, '.mission.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
  assert.ok(lease);
  const invocation = beginEngineeringMissionInvocation(config, { isOwned: () => ownsLocalStoreLock(lease), isBound: () => true });
  invocation.observe(1, 'executing'); assert.equal(releaseLocalStoreLock(lease), true); lease = null;
  invocation.finish({ state: 'held', reason: 'shutdown-unresolved', scopesReserved: 1 });
  const before = snapshot(base);
  const result = JSON.parse(execFileSync(process.execPath, [join(repository, 'bin/ashlr'), 'resources', 'pool', 'engineering',
    'mission', 'status', '--config', file, '--json'], { cwd: repository, encoding: 'utf8', timeout: 60_000 }));
  assert.deepEqual(snapshot(base), before);
  assert.equal(result.recordedPhase, 'not-started'); assert.equal(result.remainingMs, 0);
  assert.equal(result.invocations.count, 1); assert.equal(result.invocations.unfinishedCount, 0);
  assert.equal(result.invocations.latest.outcome.reason, 'shutdown-unresolved');
  assert.equal(result.ownerState, 'not-observed'); assert.equal(result.deliveryState, 'not-revalidated');
  assert.equal(result.executionAuthorized, false); assert.equal(result.effectsExecuted, false); assert.equal(result.providerContacted, false);
  assert.deepEqual(readKillSwitch(), kill);
  console.log(JSON.stringify({ scope: 'compiled-observation-smoke', passed: true, unchangedFixture: true,
    state: result.invocations.latest.outcome.state, reason: result.invocations.latest.outcome.reason,
    globalStop: kill.state, executionAuthorized: false, providerContacted: false }));
} finally {
  if (lease) assert.equal(releaseLocalStoreLock(lease), true);
  rmSync(base, { recursive: true, force: true });
}
