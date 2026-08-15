fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        panic!(
            "Linux desktop builds are quarantined by RUSTSEC-2024-0429 / \
             GHSA-wrw7-89jp-8q8g while Tauri v2 resolves glib 0.18.5; \
             re-enable only after Tauri v3/GTK4 or a supported glib >=0.20 \
             chain passes full macOS, Windows, and Linux acceptance"
        );
    }

    tauri_build::build()
}
