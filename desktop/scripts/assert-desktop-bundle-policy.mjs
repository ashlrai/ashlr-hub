#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rootVersion = readJson(resolve(desktopDir, '..', 'package.json')).version;
const desktopVersion = readJson(resolve(desktopDir, 'package.json')).version;
const tauriVersion = readJson(resolve(desktopDir, 'src-tauri', 'tauri.conf.json')).version;
const cargoToml = readFileSync(resolve(desktopDir, 'src-tauri', 'Cargo.toml'), 'utf8');
const cargoLock = readFileSync(resolve(desktopDir, 'src-tauri', 'Cargo.lock'), 'utf8');
const cargoPackage = cargoToml.match(/^\[package\]\n([\s\S]*?)^\[/m)?.[1];
const cargoVersion = cargoPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const lockPackage = cargoLock.match(/^\[\[package\]\]\nname = "ashlr-desktop"\n([\s\S]*?)^\[\[package\]\]/m)?.[1];
const lockVersion = lockPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

for (const [source, version] of [
  ['desktop/package.json', desktopVersion],
  ['desktop/src-tauri/tauri.conf.json', tauriVersion],
  ['desktop/src-tauri/Cargo.toml', cargoVersion],
  ['desktop/src-tauri/Cargo.lock', lockVersion],
]) {
  if (version !== rootVersion) {
    console.error(`ASHLR_DESKTOP_VERSION_MISMATCH: ${source} is ${version ?? 'missing'}; root package.json is ${rootVersion}. Sync desktop versions before bundling.`);
    process.exitCode = 1;
  }
}

if (process.platform === 'linux' || process.env.TAURI_ENV_PLATFORM === 'linux') {
  console.error(
    'ASHLR_LINUX_DESKTOP_BUNDLE_QUARANTINED: refusing Linux desktop bundling while Tauri v2 resolves vulnerable glib 0.18.5 (GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429)',
  );
  process.exitCode = 1;
}
