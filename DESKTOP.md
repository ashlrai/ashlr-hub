# Desktop App

The `desktop/` directory contains a Tauri v2 desktop application that wraps
**Ashlr Verse** — the operator console served at `/verse/` — in a native
window with a tray icon.

See `desktop/README.md` for full setup, build, and open-item details, and
`docs/VERSE.md` for what Verse is and how to use it.

## The Verse window

- On launch the app spawns the bundled `ashlr` sidecar as
  `ashlr verse --port 7777 --no-open --json` (dispatch enabled, no browser tab).
- It reads the one-line JSON startup record from the sidecar's stdout, takes
  `readToken` and `token`, and never forwards or logs that line.
- It then creates the main window (title "Ashlr Verse", 1280×820, min
  960×640) at `http://127.0.0.1:7777/verse/` with a webview initialization
  script that sets `window.__ASHLR_TOKENS__ = { readToken, token }` on that
  origin only. The SessionGate consumes the global, so there is no token paste.
- Fallbacks: if the bundled CLI predates `verse`, the app retries once with
  `ashlr serve --port 7777 --allow-dispatch --json`; if no record arrives within
  30 s it opens the window without tokens and the SessionGate asks for one.
- Closing the window hides it to the tray; **Quit Ashlr** kills the sidecar.
- The webview only ever loads `http://127.0.0.1:7777`; the CSP and the
  init-script origin check both pin it there.

macOS build (from the repo root): `npm run build:binary` →
`node desktop/scripts/prepare-sidecar.mjs` → `cd desktop && npm run icons`
(once) → `npm run build:debug` or `npm run build`. The `.app` lands in
`desktop/src-tauri/target/{debug,release}/bundle/macos/Ashlr.app`.

No public desktop release or installer is currently available. The supported
installation path is the npm/CLI quickstart; the web dashboard remains
available through that runtime.
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
While the quarantine is active, repository workflow 301689703 must remain
externally `disabled_manually`. Its source trigger admits only `desktop-v*` tag
pushes and its configured output is draft-only, but neither property authorizes
execution. Ruleset 20660876 protects `refs/tags/desktop-v*` with a Mason-only
bypass; that protection is necessary but not sufficient because a tag can
select a historical commit whose workflow predates the quarantine.

Quick start (requires Rust + `cargo install tauri-cli`):

```bash
npm run build:binary               # Bun SEA sidecar → dist-bin/ashlr
node desktop/scripts/prepare-sidecar.mjs
cd desktop
npm run icons                      # once: icons from src-tauri/icons/icon.svg
cargo tauri dev                    # opens http://127.0.0.1:7777/verse/
```

The quick start intentionally fails when its target OS is Linux while the
quarantine above is active.

**This directory is entirely self-contained.**  It does not modify `src/`,
`package.json`, or any other file in the repo root.
