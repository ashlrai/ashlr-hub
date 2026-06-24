# Icon Placeholder

This directory must contain the following files before `cargo tauri build` will succeed.
All sizes must be **PNG** (lossless, square), except `.icns` (macOS) and `.ico` (Windows).

| File               | Size        | Used by                              |
|--------------------|-------------|--------------------------------------|
| `32x32.png`        | 32×32 px    | Linux taskbar, bundle manifest       |
| `128x128.png`      | 128×128 px  | Linux app launcher                   |
| `128x128@2x.png`   | 256×256 px  | macOS Retina launcher                |
| `icon.icns`        | multi-size  | macOS .app bundle                    |
| `icon.ico`         | multi-size  | Windows .exe / .msi installer        |
| `tray-icon.png`    | 22×22 px (or 44px @2x) | Menu-bar / system-tray icon (set `iconAsTemplate: true` for macOS dark-mode inversion) |

## Generating from a source SVG

```bash
# Install the Tauri icon generator (requires ImageMagick + librsvg)
cargo install tauri-cli          # if not already installed
cargo tauri icon path/to/icon.svg   # outputs all required sizes into src-tauri/icons/
```

Then hand-craft `tray-icon.png` separately — keep it monochrome so macOS can invert
it automatically for dark mode.

## Current state

No real icons are present yet.  The build will fail on missing icon files until
you place them here.  A quick workaround for dev is to copy any 32×32 PNG to each
required filename.
