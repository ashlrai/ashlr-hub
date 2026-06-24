# Sidecar Binaries Placeholder

Tauri's `externalBin` bundler looks here for the triple-suffixed `ashlr` binary.

Expected filename format:  `ashlr-<rust-target-triple>[.exe]`

Examples:
- `ashlr-aarch64-apple-darwin`        (Apple Silicon Mac)
- `ashlr-x86_64-apple-darwin`         (Intel Mac)
- `ashlr-x86_64-pc-windows-msvc.exe`  (Windows x64)
- `ashlr-x86_64-unknown-linux-gnu`    (Linux x64)
- `ashlr-aarch64-unknown-linux-gnu`   (Linux ARM64)

## How to populate

Run the prepare-sidecar script from the `desktop/` directory:

```bash
node scripts/prepare-sidecar.mjs
# or, if @tauri-apps/cli is installed:
# npm run prepare-sidecar
```

The script requires that a Bun-compiled `ashlr-raw` binary exists at
`<repo-root>/binaries/ashlr-raw` (see desktop/README.md §Bundled Runtime).
