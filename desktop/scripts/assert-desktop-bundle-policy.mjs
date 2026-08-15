#!/usr/bin/env node

if (process.platform === 'linux' || process.env.TAURI_ENV_PLATFORM === 'linux') {
  console.error(
    'ASHLR_LINUX_DESKTOP_BUNDLE_QUARANTINED: refusing Linux desktop bundling while Tauri v2 resolves vulnerable glib 0.18.5 (GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429)',
  );
  process.exitCode = 1;
}
