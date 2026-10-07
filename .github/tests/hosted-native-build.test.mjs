import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { ensureSeaBuild, parseHostedBuildArguments } from '../../scripts/build-sea.mjs';

// The native preparation seam is exercised with inert hooks. These tests do
// not invoke Bun, npm, GitHub, signing, installed applications, or providers.
const root = resolve('inert-native-source');
const bundle = resolve('inert-hosted-bundle');
const revision = 'a'.repeat(40);
const attestorSha = 'b'.repeat(40);
const flags = ['--hosted-bundle', '--run', '--attempt', '--attestor-sha', '--attestor-run', '--attestor-attempt'];
const values = [bundle, '101', '2', attestorSha, '201', '3'];
const args = () => flags.flatMap((flag, index) => [flag, values[index]]);
const policy = { runId: 101, runAttempt: 2, attestorSha, attestorRun: 201, attestorAttempt: 3 };
const cleanIdentity = { provenance: 'git', dirty: false, revision };

function hooks(current = cleanIdentity) {
  const calls = []; const receipt = Object.freeze({ source: { revision } });
  return { calls, receipt,
    build: () => calls.push('build'),
    identity: input => { calls.push(['identity', input]); return current; },
    verify: input => { calls.push(['verify', input]); return receipt; },
    validate: input => { calls.push(['validate', input]); assert.equal(input, receipt); },
  };
}

test('ordinary operand-free build invokes the existing local build exactly once', () => {
  const f = hooks();
  assert.equal(parseHostedBuildArguments([]), null);
  assert.deepEqual(ensureSeaBuild({ args: [], root, ...f }), { mode: 'local' });
  assert.deepEqual(f.calls, ['build']);
});

test('local build failure is propagated without verifier fallback', () => {
  const f = hooks(); const failure = new Error('local build failed');
  assert.throws(() => ensureSeaBuild({ args: [], root, ...f, build: () => { f.calls.push('build'); throw failure; } }), error => error === failure);
  assert.deepEqual(f.calls, ['build']);
});

test('explicit hosted mode binds both run identities and validates the fresh receipt in order', () => {
  const f = hooks();
  assert.deepEqual(parseHostedBuildArguments(args()), { bundle, ...policy });
  const result = ensureSeaBuild({ args: args(), root, ...f });
  assert.equal(result.mode, 'hosted'); assert.equal(result.receipt, f.receipt);
  assert.deepEqual(f.calls, [
    ['identity', { repoRoot: root }],
    ['verify', { root, revision, bundle, policy }],
    ['validate', f.receipt],
  ]);
});

test('hosted flags may be reordered but never duplicated', () => {
  const reordered = flags.toReversed().flatMap(flag => [flag, values[flags.indexOf(flag)]]);
  assert.deepEqual(parseHostedBuildArguments(reordered), { bundle, ...policy });
  const f = hooks();
  assert.throws(() => ensureSeaBuild({ args: [...args(), '--run', '101'], root, ...f }), /Invalid hosted build arguments/);
  assert.deepEqual(f.calls, []);
});

for (const flag of flags) {
  test(`missing ${flag} is refused before any build, identity or verification effect`, () => {
    const incomplete = args(); incomplete.splice(flags.indexOf(flag) * 2, 2);
    const f = hooks();
    assert.throws(() => ensureSeaBuild({ args: incomplete, root, ...f }), /Complete hosted build identity required/);
    assert.deepEqual(f.calls, []);
  });
}

for (const invalid of [['--no-build'], ['--skip-build', 'true'], [...args(), '--unknown', 'true'], [...args(), '--run'], ['--hosted-bundle', '']]) {
  test(`unchecked or malformed arguments cannot bypass preparation: ${JSON.stringify(invalid)}`, () => {
    const f = hooks();
    assert.throws(() => ensureSeaBuild({ args: invalid, root, ...f }), /Invalid hosted build arguments/);
    assert.deepEqual(f.calls, []);
  });
}

for (const [flag, invalidValues] of [
  ['--hosted-bundle', ['relative/bundle']],
  ['--attestor-sha', ['B'.repeat(40), 'b'.repeat(39), 'b'.repeat(41), 'g'.repeat(40)]],
  ...['--run', '--attempt', '--attestor-run', '--attestor-attempt'].map(flag => [flag, ['0', '-1', '1.5', '01', '1e3', ' 1', '9007199254740992']]),
]) {
  for (const value of invalidValues) {
    test(`invalid identity ${flag}=${value} is refused before effects`, () => {
      const invalid = args(); invalid[flags.indexOf(flag) * 2 + 1] = value;
      const f = hooks();
      assert.throws(() => ensureSeaBuild({ args: invalid, root, ...f }), /hosted.*identity/);
      assert.deepEqual(f.calls, []);
    });
  }
}

for (const current of [
  { ...cleanIdentity, dirty: true }, { ...cleanIdentity, dirty: undefined },
  { ...cleanIdentity, provenance: 'archive' }, { ...cleanIdentity, revision: null },
]) {
  test(`hosted reuse refuses non-clean Git identity ${JSON.stringify(current)}`, () => {
    const f = hooks(current);
    assert.throws(() => ensureSeaBuild({ args: args(), root, ...f }), /Clean source identity required/);
    assert.deepEqual(f.calls, [['identity', { repoRoot: root }]]);
  });
}

for (const stage of ['identity', 'verify', 'validate']) {
  test(`${stage} refusal stops hosted preparation without local fallback`, () => {
    const f = hooks(); const failure = new Error(`${stage} refused`); const original = f[stage];
    const failingHook = input => { original(input); throw failure; };
    assert.throws(() => ensureSeaBuild({ args: args(), root, ...f, [stage]: failingHook }), error => error === failure);
    assert.deepEqual(f.calls.map(call => call[0]), ['identity', 'verify', 'validate'].slice(0, ['identity', 'verify', 'validate'].indexOf(stage) + 1));
  });
}

test('actual adopted-byte validation refuses a serialized or fabricated verification receipt', () => {
  const f = hooks();
  const serialized = JSON.parse(JSON.stringify(f.receipt));
  assert.throws(() => ensureSeaBuild({ args: args(), root, build: f.build, identity: f.identity,
    verify: input => { f.calls.push(['verify', input]); return serialized; } }), /live verified capability/);
  assert.deepEqual(f.calls.map(call => call[0]), ['identity', 'verify']);
});
