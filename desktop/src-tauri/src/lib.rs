//! Native-only foundations that are deliberately not wired into the desktop UI.

pub mod native_launchd_broker;

// Deterministic signed-update policy is qualified by the required native library lane.
#[cfg(target_os = "macos")]
pub mod native_updates;

// The runtime uses this same constructor; its fresh-process test belongs to CI.
#[cfg(target_os = "macos")]
pub mod native_update_client;
