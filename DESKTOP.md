# Desktop App

The `desktop/` directory contains a Tauri v2 desktop application that wraps
the Ashlr Mission Control web UI.

See `desktop/README.md` for full setup, build, and open-item details.

Quick start (requires Rust + `cargo install tauri-cli`):

```bash
cd desktop
node scripts/prepare-sidecar.mjs   # after building the Bun SEA sidecar
cargo tauri dev
```

**This directory is entirely self-contained.**  It does not modify `src/`,
`package.json`, or any other file in the repo root.
