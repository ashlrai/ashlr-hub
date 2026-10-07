/* global process, Buffer */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const checkerBytes = readFileSync(fileURLToPath(new URL('../../scripts/check-first-paint-budget.mjs', import.meta.url)));

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-first-paint-built-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, bytes) => {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, bytes);
  };
  // Exercise the real CLI bytes with its own repository root. If it tries to
  // rebuild, the fake Vite entry records that attempt and fails immediately.
  write('scripts/check-first-paint-budget.mjs', checkerBytes);
  write('node_modules/vite/bin/vite.js', "require('node:fs').writeFileSync('build-attempted', 'unexpected'); process.exit(97);\n");
  mkdirSync(join(root, 'home'));
  const out = join(root, 'out');
  const manifest = {
    'index.html': { file: 'assets/index.js', imports: ['shared'], dynamicImports: ['off-path'] },
    'app/VerseConsoleApp.tsx': { file: 'assets/console.js', imports: ['shared'] },
    'routes/verse/sections/ChatSection.tsx': { file: 'assets/chat.js', imports: ['shared'] },
    'app/VerseMobileApp.tsx': { file: 'assets/mobile.js', imports: ['shared'] },
    'routes/verse/mobile/screens/HomeScreen.tsx': { file: 'assets/home.js', imports: ['shared'] },
    shared: { file: 'assets/shared.js' },
    'off-path': { file: 'assets/off-path.js' },
  };
  for (const [file, size] of Object.entries({ index: 64, console: 64, chat: 128, mobile: 32, home: 32, shared: 256, 'off-path': 4096 })) {
    write(`out/assets/${file}.js`, Buffer.alloc(size, 'x'));
  }
  write('out/.vite/manifest.json', JSON.stringify(manifest));
  const snapshot = () => {
    const rows = {};
    const visit = (directory) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const info = statSync(path, { bigint: true });
        if (info.isDirectory()) visit(path);
        else rows[path] = { bytes: readFileSync(path).toString('base64'), mode: String(info.mode), modified: String(info.mtimeNs) };
      }
    };
    visit(root);
    return rows;
  };
  const run = (...overrides) => spawnSync(process.execPath, [join(root, 'scripts/check-first-paint-budget.mjs'),
    '--no-build', '--out-dir', out, '--budget-kb', '1', '--mobile-budget-kb', '1', '--json', ...overrides], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), PATH: process.env.PATH },
  });
  return { root, out, run, snapshot };
}

test('prebuilt CLI measures both static closures once without rebuilding or changing any file', (t) => {
  const f = fixture(t); const before = f.snapshot();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const reading = JSON.parse(result.stdout);
  assert.equal(reading.ok, true);
  assert.equal(reading.totalBytes, 512);
  assert.equal(reading.mobile.totalBytes, 384);
  assert.deepEqual(reading.files.map((row) => row.file).sort(), ['assets/chat.js', 'assets/console.js', 'assets/index.js', 'assets/shared.js']);
  assert.deepEqual(f.snapshot(), before);
});

for (const [label, args, desktopOk, mobileOk] of [
  ['desktop', ['--budget-kb', '0.4'], false, true],
  ['phone', ['--mobile-budget-kb', '0.25'], true, false],
]) {
  test(`prebuilt CLI rejects an over-budget ${label} while preserving the build`, (t) => {
    const f = fixture(t); const before = f.snapshot();
    const result = f.run(...args);
    assert.equal(result.status, 1, result.stderr);
    const reading = JSON.parse(result.stdout);
    assert.equal(reading.ok, false);
    assert.equal(reading.desktopOk, desktopOk);
    assert.equal(reading.mobile.ok, mobileOk);
    assert.deepEqual(f.snapshot(), before);
  });
}

test('missing prebuilt manifest fails without rebuilding or creating replacement output', (t) => {
  const f = fixture(t);
  rmSync(join(f.out, '.vite/manifest.json'));
  const before = f.snapshot();
  const result = f.run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no manifest/);
  assert.deepEqual(f.snapshot(), before);
});
