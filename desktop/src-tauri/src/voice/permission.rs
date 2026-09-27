//! Microphone permission (TCC) for the app process.
//!
//! - [`status`] — `AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio`.
//! - [`request`] — `requestAccessForMediaType:completionHandler:` (the macOS
//!   prompt, whose body is `NSMicrophoneUsageDescription` from Info.plist).
//! - [`usage_description_present`] — macOS KILLS a process that touches the
//!   microphone without `NSMicrophoneUsageDescription` in its Info.plist
//!   (a bare `cargo run` binary, or an Ashlr.app bundle older than this
//!   change). Native checks first and reports `no-usage-description` instead
//!   of crashing.
//!
//! The grant is keyed to the app's code signature. An ad-hoc signature changes
//! on every rebuild, so macOS forgets the grant each time; `ship:local` signs
//! with a stable local identity ("Ashlr Local") for exactly this reason.

use super::protocol::MicStatus;

pub const USAGE_KEY: &str = "NSMicrophoneUsageDescription";
/// System Settings ▸ Privacy & Security ▸ Microphone.
pub const PRIVACY_MICROPHONE_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
/// System Settings ▸ Sound ▸ Input.
pub const SOUND_INPUT_URL: &str = "x-apple.systempreferences:com.apple.preference.sound?input";

/// `AVAuthorizationStatus` → wire status.
pub fn map_status(raw: isize) -> MicStatus {
    match raw {
        0 => MicStatus::Undetermined,
        1 => MicStatus::Restricted,
        2 => MicStatus::Denied,
        3 => MicStatus::Granted,
        _ => MicStatus::Denied,
    }
}

/// Open one of the two fixed System Settings panes. Only these constants are
/// ever passed to `open` — never a string from the page.
pub fn open_settings(url: &'static str) {
    debug_assert!(url == PRIVACY_MICROPHONE_URL || url == SOUND_INPUT_URL);
    let _ = std::process::Command::new("/usr/bin/open").arg(url).spawn();
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::{msg_send, runtime::AnyClass, runtime::Bool};
    use objc2_foundation::{NSBundle, NSString};

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }

    fn capture_device_class() -> Option<&'static AnyClass> {
        AnyClass::get(c"AVCaptureDevice")
    }

    pub fn usage_description_present() -> bool {
        let bundle = NSBundle::mainBundle();
        let key = NSString::from_str(super::USAGE_KEY);
        match bundle.objectForInfoDictionaryKey(&key) {
            Some(value) => match value.downcast_ref::<NSString>() {
                Some(text) => !text.to_string().trim().is_empty(),
                None => false,
            },
            None => false,
        }
    }

    pub fn raw_status() -> Option<isize> {
        let class = capture_device_class()?;
        // SAFETY: a documented class method taking an AVMediaType (NSString)
        // and returning AVAuthorizationStatus (NSInteger).
        let status: isize =
            unsafe { msg_send![class, authorizationStatusForMediaType: AVMediaTypeAudio] };
        Some(status)
    }

    pub fn request(done: Box<dyn FnOnce(bool) + Send>) {
        let Some(class) = capture_device_class() else {
            done(false);
            return;
        };
        let slot = Mutex::new(Some(done));
        // Called once, on an arbitrary queue.
        let block = RcBlock::new(move |granted: Bool| {
            let taken = match slot.lock() {
                Ok(mut guard) => guard.take(),
                Err(poisoned) => poisoned.into_inner().take(),
            };
            if let Some(done) = taken {
                done(granted.as_bool());
            }
        });
        // SAFETY: documented class method; WebKit/AVFoundation copy the block.
        unsafe {
            let _: () = msg_send![
                class,
                requestAccessForMediaType: AVMediaTypeAudio,
                completionHandler: &*block
            ];
        }
    }
}

#[cfg(target_os = "macos")]
pub fn usage_description_present() -> bool {
    mac::usage_description_present()
}

#[cfg(not(target_os = "macos"))]
pub fn usage_description_present() -> bool {
    false
}

/// The current microphone status. Never prompts.
pub fn status() -> MicStatus {
    #[cfg(target_os = "macos")]
    {
        if !usage_description_present() {
            return MicStatus::NoUsageDescription;
        }
        match mac::raw_status() {
            Some(raw) => map_status(raw),
            None => MicStatus::Unsupported,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        MicStatus::Unsupported
    }
}

/// Show the macOS prompt (only meaningful while `undetermined`). `done` runs
/// on an arbitrary thread with the answer.
pub fn request(done: Box<dyn FnOnce(bool) + Send>) {
    #[cfg(target_os = "macos")]
    {
        if !usage_description_present() {
            done(false);
            return;
        }
        mac::request(done);
    }
    #[cfg(not(target_os = "macos"))]
    {
        done(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorization_statuses_map_and_unknowns_fail_closed() {
        assert_eq!(map_status(0), MicStatus::Undetermined);
        assert_eq!(map_status(1), MicStatus::Restricted);
        assert_eq!(map_status(2), MicStatus::Denied);
        assert_eq!(map_status(3), MicStatus::Granted);
        assert_eq!(map_status(99), MicStatus::Denied);
    }

    #[test]
    fn the_fix_urls_are_the_documented_panes() {
        assert_eq!(
            PRIVACY_MICROPHONE_URL,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        );
        assert!(SOUND_INPUT_URL.starts_with("x-apple.systempreferences:"));
    }

    #[test]
    fn status_agrees_with_the_usage_description_guard() {
        // Tauri embeds Info.plist into the binary's __info_plist section on
        // macOS, so even a test binary may carry the key. Either way the
        // guard and the status agree, and `status()` never prompts.
        let present = usage_description_present();
        let s = status();
        if cfg!(target_os = "macos") {
            assert_eq!(s == MicStatus::NoUsageDescription, !present, "{s:?}");
        } else {
            assert_eq!(s, MicStatus::Unsupported);
        }
    }

    #[test]
    fn the_info_plist_carries_the_usage_string() {
        let plist = include_str!("../../Info.plist");
        assert!(plist.contains("<key>NSMicrophoneUsageDescription</key>"));
        assert!(plist.contains(
            "<string>Verse transcribes your voice on this Mac when you hold the dictation key.</string>"
        ));
        let entitlements = include_str!("../../Entitlements.plist");
        assert!(entitlements.contains("<key>com.apple.security.device.audio-input</key>"));
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["bundle"]["macOS"]["entitlements"],
            "Entitlements.plist"
        );
    }
}
