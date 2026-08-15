# Desktop App

The `desktop/` directory contains a Tauri v2 desktop application that wraps
the Ashlr Mission Control web UI.

See `desktop/README.md` for full setup, build, and open-item details.

Published desktop installers are currently limited to macOS and Windows.
Fresh Linux Tauri source builds are quarantined and fail closed in
`desktop/src-tauri/build.rs` because the Tauri v2 / GTK3 dependency chain
resolves vulnerable `glib 0.18.5`
(`GHSA-wrw7-89jp-8q8g` / `RUSTSEC-2024-0429`). The root Linux CLI, Bun sidecar,
and web dashboard remain supported.

Linux desktop release may be re-enabled only after migration to Tauri v3/GTK4
or a supported dependency chain with `glib >=0.20`, followed by full native
macOS, Windows, and Linux build/install/launch/sidecar/signing/updater/release
acceptance and an independent security review.

The quarantine is enforced for fresh source builds, the default Tauri
configuration, and the official release workflow. A hostile `--config`
override combined with an already-built/staged executable is outside
source-build enforcement and must never be treated as admitted release output.
While the quarantine is active, the official desktop release workflow admits
only `desktop-v*` tag-push events. Manual dispatch is disabled so a historical
branch or commit cannot create or append desktop release artifacts.

Quick start (requires Rust + `cargo install tauri-cli`):

```bash
cd desktop
node scripts/prepare-sidecar.mjs   # after building the Bun SEA sidecar
cargo tauri dev
```

The quick start intentionally fails when its target OS is Linux while the
quarantine above is active.

**This directory is entirely self-contained.**  It does not modify `src/`,
`package.json`, or any other file in the repo root.
