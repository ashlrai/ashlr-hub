#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === '--') rawArgs.shift();
const selectorIndex = rawArgs.indexOf('-t');
const selector = selectorIndex >= 0 ? rawArgs[selectorIndex + 1] : undefined;
const files = selectorIndex >= 0 ? rawArgs.slice(0, selectorIndex) : [];
const isolatedFiles = [
  'test/m342.dispatch-production-ledger.test.ts',
  'test/m360.generated-repair-lifecycle.test.ts',
  'test/m362.repair-handoff-journal.test.ts',
];
const defaultHardTimeoutMs = 15 * 60_000;
const sharedFiles = files.filter((file) => !isolatedFiles.includes(file));

function readPositiveDuration(name, fallback) {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

if (!selector || sharedFiles.length === 0 || rawArgs.length !== selectorIndex + 2 ||
  files.some((file) => !file.endsWith('.test.ts')) ||
  isolatedFiles.some((file) => !files.includes(file)) ||
  new Set(files).size !== files.length) {
  console.error('invalid native path/lifecycle test manifest');
  process.exit(2);
}

const groups = [
  sharedFiles,
  ...isolatedFiles.map((file) => [file]),
];
const testCi = fileURLToPath(new URL('./test-ci.mjs', import.meta.url));
const hardTimeoutMs = readPositiveDuration(
  'ASHLR_TEST_CI_TIMEOUT_MS',
  defaultHardTimeoutMs,
);
const deadline = Date.now() + hardTimeoutMs;

for (const group of groups) {
  const remainingTimeoutMs = deadline - Date.now();
  if (remainingTimeoutMs <= 0) {
    console.error(`[native-path-lifecycle] aggregate hard-runtime-cap reached after ${hardTimeoutMs}ms`);
    process.exit(124);
  }
  const result = spawnSync(
    process.execPath,
    [testCi, '--reporter=dot', ...group, '-t', selector],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ASHLR_TEST_CI_TIMEOUT_MS: String(remainingTimeoutMs),
      },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
