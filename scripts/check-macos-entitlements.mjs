#!/usr/bin/env node
/** Prove AMFI accepts the exact entitlements before ship:local touches the app. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entitlements = resolve(repoRoot, 'desktop/src-tauri/Entitlements.plist');

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} refused the entitlements: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim().slice(0, 500)}`);
  }
  return result.stdout;
}

if (process.platform !== 'darwin') {
  console.error('Entitlements signing preflight requires macOS');
  process.exitCode = 2;
} else {
  let probeDir;
  try {
    const decoded = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', entitlements]));
    if (Object.keys(decoded).length !== 1 || decoded['com.apple.security.device.audio-input'] !== true) {
      throw new Error('entitlements must grant only com.apple.security.device.audio-input=true');
    }
    probeDir = mkdtempSync(join(tmpdir(), 'ashlr-entitlements-'));
    const probe = join(probeDir, 'true');
    copyFileSync('/usr/bin/true', probe);
    // `plutil -lint` accepts some XML that codesign's AMFI parser rejects.
    // This disposable sign uses the same --entitlements input as ship:local.
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', entitlements, probe]);
    run('/usr/bin/codesign', ['--verify', '--strict', probe]);
    console.log('macOS entitlements preflight passed');
  } catch (error) {
    console.error(`macOS entitlements preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (probeDir) rmSync(probeDir, { recursive: true, force: true });
  }
}
