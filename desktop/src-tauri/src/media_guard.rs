//! Who may use the microphone and camera inside a WebKit view.
//!
//! wry 0.55 installs a `WKUIDelegate` on every webview whose
//! `webView:requestMediaCapturePermissionForOrigin:…:decisionHandler:` answers
//! `WKPermissionDecision::Grant` unconditionally
//! (`wry/src/wkwebview/class/wry_web_view_ui_delegate.rs`). That is harmless
//! while the app has no microphone permission — macOS refuses the device
//! anyway — but Verse now asks for the microphone (dictation), and from the
//! moment the operator says yes, ANY site opened in the integrated browser
//! pane (`browser_pane.rs`, arbitrary http/https pages in `browser-*`
//! windows) could call `getUserMedia` and silently get a live microphone.
//!
//! The fix, in two independent layers:
//!
//! 1. **Native (this file).** Every `browser-*` window gets a `WKUIDelegate`
//!    proxy whose media-capture method always answers `Deny`. Every other
//!    `WKUIDelegate` selector (file-upload panel, `window.open`, alerts, …)
//!    is forwarded to wry's own delegate unchanged via
//!    `forwardingTargetForSelector:`, so the pane behaves exactly as before
//!    in every other respect. This covers iframes too (WebKit asks the
//!    delegate for every frame).
//! 2. **Page (`browser_tap.js`).** `navigator.mediaDevices.getUserMedia` /
//!    `getDisplayMedia` (and the legacy callbacks) are replaced, before the
//!    page runs, with functions that reject with `NotAllowedError`. Main frame
//!    only — which is why layer 1 is the one that matters.
//!
//! Verse's own window (`main`) keeps wry's delegate: it only ever loads the
//! sidecar origin (the CSP pins it), and dictation captures audio in Rust
//! (`voice/capture.rs`), not through WebKit, so the page never needs
//! `getUserMedia` in the desktop app at all.

/// What a webview's media-capture requests should get.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaPolicy {
    /// Leave wry's delegate in place (Verse's own window, sidecar origin only).
    KeepDefault,
    /// Install the deny proxy: microphone, camera and screen capture are
    /// refused without a prompt.
    Deny,
}

/// The policy for a window label. Fails closed: only the Verse window keeps
/// the default; every browser tab — and any label this file does not know —
/// is denied.
pub fn policy_for_label(label: &str) -> MediaPolicy {
    if label == crate::MAIN_WINDOW_LABEL {
        MediaPolicy::KeepDefault
    } else {
        MediaPolicy::Deny
    }
}

/// Apply [`policy_for_label`] to a freshly built window. For `Deny` this swaps
/// the WKWebView's UI delegate for the deny proxy (macOS; a no-op elsewhere —
/// wry's other backends prompt or deny on their own).
pub fn apply<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    match policy_for_label(window.label()) {
        MediaPolicy::KeepDefault => Ok(()),
        MediaPolicy::Deny => install_deny(window),
    }
}

#[cfg(target_os = "macos")]
fn install_deny<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    window
        .with_webview(|platform| {
            let pointer = platform.inner() as *const objc2_web_kit::WKWebView;
            // SAFETY: on macOS `PlatformWebview::inner()` is the live WKWebView
            // wry created for this window, and `with_webview` runs this closure
            // on the main thread while the window exists.
            if let Some(webview) = unsafe { pointer.as_ref() } {
                if let Err(e) = unsafe { mac::install(webview) } {
                    eprintln!("[ashlr-desktop] could not install the media-capture guard: {e}");
                }
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn install_deny<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) mod mac {
    use std::ptr::null_mut;

    use block2::Block;
    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, NSObject, ProtocolObject, Sel},
        DefinedClass, MainThreadMarker, MainThreadOnly,
    };
    use objc2_foundation::NSObjectProtocol;
    use objc2_web_kit::{WKMediaCaptureType, WKPermissionDecision, WKUIDelegate, WKWebView};

    /// Key for the associated object that keeps the proxy alive: WKWebView
    /// holds its `UIDelegate` weakly, so the webview itself must own it.
    static ASSOCIATION_KEY: u8 = 0;

    pub struct Ivars {
        /// wry's delegate (or whatever was installed before us); every
        /// selector except media capture is forwarded to it.
        inner: Option<Retained<AnyObject>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "AshlrMediaDenyUIDelegate"]
        #[ivars = Ivars]
        pub struct MediaDenyDelegate;

        impl MediaDenyDelegate {
            // WebKit caches `respondsToSelector:` answers when the delegate is
            // set, so the proxy must claim every selector the inner delegate
            // implements, or wry's file panel / window.open handling would
            // silently disappear.
            #[unsafe(method(respondsToSelector:))]
            fn ashlr_responds_to_selector(&self, selector: Sel) -> bool {
                let own: bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
                own || self
                    .ivars()
                    .inner
                    .as_ref()
                    .is_some_and(|inner| inner_responds(inner, selector))
            }

            #[unsafe(method(forwardingTargetForSelector:))]
            fn ashlr_forwarding_target(&self, selector: Sel) -> *mut AnyObject {
                match &self.ivars().inner {
                    Some(inner) if inner_responds(inner, selector) => {
                        Retained::as_ptr(inner) as *mut AnyObject
                    }
                    _ => null_mut(),
                }
            }
        }

        unsafe impl NSObjectProtocol for MediaDenyDelegate {}

        unsafe impl WKUIDelegate for MediaDenyDelegate {
            // The webview/origin/frame arguments are unused and typed as
            // optional objects so the decision can be unit-tested without a
            // live WKWebView (the ObjC encoding is `@` either way).
            #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
            fn request_media_capture_permission(
                &self,
                _webview: Option<&AnyObject>,
                _origin: Option<&AnyObject>,
                _frame: Option<&AnyObject>,
                _capture_type: WKMediaCaptureType,
                decision_handler: &Block<dyn Fn(WKPermissionDecision)>,
            ) {
                decision_handler.call((WKPermissionDecision::Deny,));
            }
        }
    );

    fn inner_responds(inner: &AnyObject, selector: Sel) -> bool {
        // SAFETY: every ObjC object answers respondsToSelector: (NSObject).
        unsafe { msg_send![inner, respondsToSelector: selector] }
    }

    impl MediaDenyDelegate {
        pub fn new(mtm: MainThreadMarker, inner: Option<Retained<AnyObject>>) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars { inner });
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Wrap `webview`'s current UI delegate in the deny proxy.
    ///
    /// # Safety
    /// Main thread only; `webview` must be a live WKWebView.
    pub unsafe fn install(webview: &WKWebView) -> Result<(), &'static str> {
        let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
        // SAFETY: a protocol object is an ObjC object; only `id` messaging
        // (respondsToSelector:, forwarding) is done through this pointer.
        let inner: Option<Retained<AnyObject>> = webview
            .UIDelegate()
            .map(|delegate| Retained::cast_unchecked::<AnyObject>(delegate));
        let proxy = MediaDenyDelegate::new(mtm, inner);
        webview.setUIDelegate(Some(ProtocolObject::from_ref(&*proxy)));
        objc2::ffi::objc_setAssociatedObject(
            webview as *const WKWebView as *mut AnyObject,
            &ASSOCIATION_KEY as *const u8 as *const std::ffi::c_void,
            Retained::as_ptr(&proxy) as *mut AnyObject,
            objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_verse_window_keeps_webkit_media_capture() {
        assert_eq!(policy_for_label("main"), MediaPolicy::KeepDefault);
        for label in ["browser-1", "browser-tab_a", "launch", "", "Main", "main "] {
            assert_eq!(policy_for_label(label), MediaPolicy::Deny, "{label:?}");
        }
        assert_eq!(
            policy_for_label(&crate::browser_pane::label_for("x")),
            MediaPolicy::Deny
        );
    }

    #[test]
    fn browser_tabs_install_the_guard_when_built() {
        // The pane must call `media_guard::apply` on every tab it builds.
        let pane = include_str!("browser_pane.rs");
        assert!(
            pane.contains("crate::media_guard::apply(&window)"),
            "browser_pane.rs no longer installs the media-capture guard"
        );
    }

    #[test]
    fn the_tap_refuses_media_capture_before_the_page_runs() {
        let tap = crate::browser_pane::TAP_JS;
        for needle in [
            "'NotAllowedError'",
            "lock(targets[i], 'getUserMedia', denied)",
            "lock(targets[i], 'getDisplayMedia', denied)",
            "lock(targets[i], 'enumerateDevices', noDevices)",
            "'webkitGetUserMedia'",
            "configurable: false",
        ] {
            assert!(tap.contains(needle), "browser_tap.js lost `{needle}`");
        }
        // Before the idempotency guard, so it applies even if the tap's own
        // globals were somehow pre-seeded by the page.
        let neuter = tap.find("'getUserMedia'").unwrap();
        let guard = tap.find("hasOwnProperty.call(window, '__ashlrTap')").unwrap();
        assert!(neuter < guard);
    }

    #[cfg(target_os = "macos")]
    mod objc {
        use std::sync::{Arc, Mutex};

        use block2::RcBlock;
        use objc2::{
            define_class, msg_send,
            rc::Retained,
            runtime::{AnyObject, NSObject, NSObjectProtocol, Sel},
            sel, MainThreadMarker, MainThreadOnly,
        };
        use objc2_web_kit::{WKMediaCaptureType, WKPermissionDecision};

        use super::super::mac::MediaDenyDelegate;

        // Stand-in for wry's delegate: grants media capture (as wry does) and
        // implements one other selector the proxy must forward.
        define_class!(
            #[unsafe(super(NSObject))]
            #[thread_kind = MainThreadOnly]
            #[name = "AshlrTestGrantingUIDelegate"]
            struct Granting;

            unsafe impl NSObjectProtocol for Granting {}

            impl Granting {
                #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
                fn grant(
                    &self,
                    _w: Option<&AnyObject>,
                    _o: Option<&AnyObject>,
                    _f: Option<&AnyObject>,
                    _t: WKMediaCaptureType,
                    handler: &block2::Block<dyn Fn(WKPermissionDecision)>,
                ) {
                    handler.call((WKPermissionDecision::Grant,));
                }

                #[unsafe(method(ashlrForwardProbe))]
                fn probe(&self) -> isize {
                    42
                }
            }
        );

        fn mtm() -> MainThreadMarker {
            // SAFETY: these tests only message plain NSObject subclasses
            // defined here — no AppKit or WebKit object is created — and the
            // ObjC runtime itself is thread-safe.
            unsafe { MainThreadMarker::new_unchecked() }
        }

        fn ask(delegate: &AnyObject, kind: WKMediaCaptureType) -> Option<WKPermissionDecision> {
            let seen = Arc::new(Mutex::new(None));
            let sink = seen.clone();
            let handler = RcBlock::new(move |decision: WKPermissionDecision| {
                *sink.lock().unwrap() = Some(decision);
            });
            let none: Option<&AnyObject> = None;
            unsafe {
                let _: () = msg_send![
                    delegate,
                    webView: none,
                    requestMediaCapturePermissionForOrigin: none,
                    initiatedByFrame: none,
                    type: kind,
                    decisionHandler: &*handler
                ];
            }
            let decision = *seen.lock().unwrap();
            decision
        }

        fn granting() -> Retained<AnyObject> {
            let inner: Retained<Granting> = unsafe { msg_send![Granting::alloc(mtm()), init] };
            Retained::into_super(inner).into()
        }

        #[test]
        fn the_proxy_denies_every_capture_type_even_over_a_granting_delegate() {
            let inner = granting();
            // Sanity: the stand-in really grants, like wry does.
            assert_eq!(
                ask(&inner, WKMediaCaptureType::Microphone),
                Some(WKPermissionDecision::Grant)
            );
            let proxy = MediaDenyDelegate::new(mtm(), Some(inner));
            for kind in [
                WKMediaCaptureType::Camera,
                WKMediaCaptureType::Microphone,
                WKMediaCaptureType::CameraAndMicrophone,
            ] {
                assert_eq!(ask(&proxy, kind), Some(WKPermissionDecision::Deny));
            }
        }

        #[test]
        fn the_proxy_denies_without_an_inner_delegate() {
            let proxy = MediaDenyDelegate::new(mtm(), None);
            assert_eq!(
                ask(&proxy, WKMediaCaptureType::Microphone),
                Some(WKPermissionDecision::Deny)
            );
        }

        #[test]
        fn every_other_selector_is_forwarded_to_the_inner_delegate() {
            let proxy = MediaDenyDelegate::new(mtm(), Some(granting()));
            let probe: Sel = sel!(ashlrForwardProbe);
            let responds: bool = unsafe { msg_send![&*proxy, respondsToSelector: probe] };
            assert!(responds, "WebKit would stop calling wry's methods");
            let value: isize = unsafe { msg_send![&*proxy, ashlrForwardProbe] };
            assert_eq!(value, 42);
            // A selector nobody implements is not claimed.
            let nobody: bool =
                unsafe { msg_send![&*proxy, respondsToSelector: sel!(ashlrNobodyHasThis)] };
            assert!(!nobody);
            // Without an inner delegate only the proxy's own methods exist.
            let bare = MediaDenyDelegate::new(mtm(), None);
            let bare_probe: bool = unsafe { msg_send![&*bare, respondsToSelector: probe] };
            assert!(!bare_probe);
        }
    }
}
