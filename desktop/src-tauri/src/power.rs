//! Process-owned idle-sleep request, reconciled from authenticated host activity.
//! Display sleep, screen locks, explicit sleep and global power settings are unchanged.
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const POLL_INTERVAL: Duration = Duration::from_secs(5);
const FRESH_FOR: Duration = Duration::from_secs(15);

pub trait Inhibitor: Send {
    fn acquire(&mut self) -> Result<(), &'static str>;
    fn release(&mut self);
    fn held(&self) -> bool;
}

#[derive(Default)]
struct Evidence {
    current: Option<usize>,
    known: Option<usize>,
    at: Option<Instant>,
}
impl Evidence {
    fn observe(&mut self, runs: Option<usize>, now: Instant) {
        self.current = runs;
        if runs.is_some() {
            self.known = runs;
            self.at = Some(now);
        }
    }
    fn reconcile(&mut self, now: Instant) {
        if !self
            .at
            .is_some_and(|at| now.saturating_duration_since(at) < FRESH_FOR)
        {
            self.current = None;
            self.known = None;
        }
    }
}

pub struct PowerManager<T: Inhibitor> {
    inhibitor: T,
    pub automatic: bool,
    pub local_runs: Option<usize>,
    pub checked_at: Option<u64>,
    pub error: Option<&'static str>,
    chats: Evidence,
    fleet: Evidence,
}

impl<T: Inhibitor> PowerManager<T> {
    pub fn new(inhibitor: T) -> Self {
        Self {
            inhibitor,
            automatic: true,
            local_runs: None,
            checked_at: None,
            error: None,
            chats: Evidence::default(),
            fleet: Evidence::default(),
        }
    }
    pub fn observe_sources(&mut self, chats: Option<usize>, fleet: Option<usize>, now: Instant) {
        // Each source owns its evidence: completion clears that source immediately;
        // a failed poll hides its count and cannot renew the prior evidence.
        self.chats.observe(chats, now);
        self.fleet.observe(fleet, now);
        if chats.is_some() || fleet.is_some() {
            self.checked_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|v| v.as_millis() as u64);
        }
        self.reconcile(now);
    }
    pub fn set_automatic(&mut self, enabled: bool, now: Instant) {
        self.automatic = enabled;
        self.reconcile(now);
    }
    pub fn reconcile(&mut self, now: Instant) {
        self.chats.reconcile(now);
        self.fleet.reconcile(now);
        let known = self
            .chats
            .current
            .unwrap_or(0)
            .saturating_add(self.fleet.current.unwrap_or(0));
        self.local_runs =
            if known > 0 || (self.chats.current.is_some() && self.fleet.current.is_some()) {
                Some(known)
            } else {
                None
            };
        let active =
            self.chats.known.is_some_and(|n| n > 0) || self.fleet.known.is_some_and(|n| n > 0);
        if self.automatic && active {
            if !self.inhibitor.held() {
                self.error = self.inhibitor.acquire().err();
            }
        } else {
            self.inhibitor.release();
            self.error = None;
        }
    }
    pub fn held(&self) -> bool {
        self.inhibitor.held()
    }
    pub fn stop(&mut self) {
        self.inhibitor.release();
        self.local_runs = None;
        self.chats = Evidence::default();
        self.fleet = Evidence::default();
    }
}
impl<T: Inhibitor> Drop for PowerManager<T> {
    fn drop(&mut self) {
        self.inhibitor.release();
    }
}

#[derive(Default)]
pub struct NativeInhibitor {
    handle: usize,
}
impl Inhibitor for NativeInhibitor {
    fn acquire(&mut self) -> Result<(), &'static str> {
        if self.handle != 0 {
            return Ok(());
        }
        self.handle = platform::acquire()?;
        Ok(())
    }
    fn release(&mut self) {
        if self.handle != 0 {
            platform::release(self.handle);
            self.handle = 0;
        }
    }
    fn held(&self) -> bool {
        self.handle != 0
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, c_void};
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            text: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            kind: *const c_void,
            level: u32,
            reason: *const c_void,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }
    pub fn acquire() -> Result<usize, &'static str> {
        unsafe {
            let kind = CFStringCreateWithCString(
                std::ptr::null(),
                b"PreventUserIdleSystemSleep\0".as_ptr().cast(),
                0x08000100,
            );
            let reason = CFStringCreateWithCString(
                std::ptr::null(),
                b"Phantom local agent work\0".as_ptr().cast(),
                0x08000100,
            );
            if kind.is_null() || reason.is_null() {
                if !kind.is_null() {
                    CFRelease(kind);
                }
                if !reason.is_null() {
                    CFRelease(reason);
                }
                return Err("The Mac could not create an idle-sleep request.");
            }
            let mut id = 0;
            let result = IOPMAssertionCreateWithName(kind, 255, reason, &mut id);
            CFRelease(kind);
            CFRelease(reason);
            if result != 0 {
                return Err("macOS refused the idle-sleep request.");
            }
            // IDs are uint32 including zero; encode +1 to keep zero as no handle.
            Ok(id as usize + 1)
        }
    }
    pub fn release(handle: usize) {
        unsafe {
            IOPMAssertionRelease((handle - 1) as u32);
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    #[repr(C)]
    struct DetailedReason {
        module: *mut c_void,
        id: u32,
        count: u32,
        strings: *mut *mut u16,
    }
    #[repr(C)]
    union ReasonContext {
        simple: *mut u16,
        detailed: std::mem::ManuallyDrop<DetailedReason>,
    }
    #[repr(C)]
    struct Reason {
        version: u32,
        flags: u32,
        context: ReasonContext,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn PowerCreateRequest(reason: *const Reason) -> *mut c_void;
        fn PowerSetRequest(handle: *mut c_void, kind: u32) -> i32;
        fn PowerClearRequest(handle: *mut c_void, kind: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    pub fn acquire() -> Result<usize, &'static str> {
        let mut text: Vec<u16> = "Phantom local agent work\0".encode_utf16().collect();
        let reason = Reason {
            version: 0,
            flags: 1,
            context: ReasonContext {
                simple: text.as_mut_ptr(),
            },
        };
        unsafe {
            let handle = PowerCreateRequest(&reason);
            if handle.is_null() || handle as isize == -1 {
                return Err("Windows could not create an idle-sleep request.");
            }
            if PowerSetRequest(handle, 1) == 0 {
                CloseHandle(handle);
                return Err("Windows refused the idle-sleep request.");
            }
            Ok(handle as usize)
        }
    }
    pub fn release(handle: usize) {
        unsafe {
            PowerClearRequest(handle as *mut c_void, 1);
            CloseHandle(handle as *mut c_void);
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    pub fn acquire() -> Result<usize, &'static str> {
        Err("Automatic awake is available in the macOS and Windows desktop apps.")
    }
    pub fn release(_: usize) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    #[derive(Default)]
    struct Counts {
        acquire: usize,
        release: usize,
    }
    struct Fake {
        counts: Arc<Mutex<Counts>>,
        held: bool,
        fails: bool,
    }
    impl Inhibitor for Fake {
        fn acquire(&mut self) -> Result<(), &'static str> {
            self.counts.lock().unwrap().acquire += 1;
            if self.fails {
                Err("denied")
            } else {
                self.held = true;
                Ok(())
            }
        }
        fn release(&mut self) {
            if self.held {
                self.counts.lock().unwrap().release += 1;
                self.held = false;
            }
        }
        fn held(&self) -> bool {
            self.held
        }
    }
    fn manager(fails: bool) -> (PowerManager<Fake>, Arc<Mutex<Counts>>) {
        let counts = Arc::new(Mutex::new(Counts::default()));
        (
            PowerManager::new(Fake {
                counts: counts.clone(),
                held: false,
                fails,
            }),
            counts,
        )
    }
    #[test]
    fn overlapping_runs_share_a_request_until_last_finishes() {
        let (mut m, c) = manager(false);
        let now = Instant::now();
        m.observe_sources(Some(1), Some(0), now);
        m.observe_sources(Some(3), Some(0), now);
        m.observe_sources(Some(1), Some(0), now);
        assert!(m.held());
        assert_eq!(c.lock().unwrap().acquire, 1);
        m.observe_sources(Some(0), Some(0), now);
        assert!(!m.held());
        assert_eq!(c.lock().unwrap().release, 1);
    }
    #[test]
    fn long_work_renews_without_a_task_deadline() {
        let (mut m, _) = manager(false);
        let now = Instant::now();
        for i in 0..10000 {
            m.observe_sources(Some(2), Some(0), now + Duration::from_secs(i * 10));
            assert!(m.held());
        }
    }
    #[test]
    fn manual_off_releases_and_on_reconciles_latest_work() {
        let (mut m, _) = manager(false);
        let now = Instant::now();
        m.observe_sources(Some(2), Some(0), now);
        m.set_automatic(false, now);
        assert!(!m.held());
        m.set_automatic(true, now);
        assert!(m.held());
        m.stop();
        assert!(!m.held());
    }
    #[test]
    fn unknown_and_stale_activity_never_claim_awake() {
        let (mut m, _) = manager(false);
        let now = Instant::now();
        m.observe_sources(Some(1), Some(0), now);
        m.reconcile(now + FRESH_FOR);
        assert_eq!(m.local_runs, None);
        assert!(!m.held());
        m.observe_sources(None, None, now);
        assert!(!m.held());
    }
    #[test]
    fn failed_poll_hides_current_count_but_preserves_only_fresh_request() {
        let (mut m, _) = manager(false);
        let now = Instant::now();
        m.observe_sources(Some(2), Some(0), now);
        let checked = m.checked_at;
        m.observe_sources(None, None, now + Duration::from_secs(5));
        assert!(m.held());
        assert_eq!(m.local_runs, None);
        assert_eq!(m.checked_at, checked);
        m.observe_sources(None, None, now + FRESH_FOR);
        assert!(!m.held());
        m.observe_sources(Some(1), Some(0), now + FRESH_FOR);
        m.observe_sources(Some(0), Some(0), now + FRESH_FOR);
        assert!(!m.held());
    }
    #[test]
    fn system_timer_readback_distinguishes_ac_and_battery() {
        let text =
            "Battery Power:\n sleep 1\n displaysleep 10\nAC Power:\n sleep 0\n displaysleep 30\n";
        assert_eq!(sleep_minutes(text, "Battery Power:"), Some(1));
        assert_eq!(sleep_minutes(text, "AC Power:"), Some(0));
        assert_eq!(
            sleep_minutes("AC Power:\n displaysleep 30", "AC Power:"),
            None
        );
    }
    #[test]
    fn completion_clears_its_source_while_other_source_is_unknown() {
        let (mut m, _) = manager(false);
        let now = Instant::now();
        m.observe_sources(Some(1), None, now);
        assert!(m.held());
        m.observe_sources(Some(0), None, now);
        assert!(!m.held());
        m.observe_sources(Some(1), Some(2), now);
        m.observe_sources(Some(0), None, now + Duration::from_secs(5));
        assert!(m.held()); // Only the recently observed Fleet evidence remains.
        m.observe_sources(Some(0), Some(0), now + Duration::from_secs(6));
        assert!(!m.held());
    }
    #[test]
    fn denied_request_is_visible_and_retried_on_fresh_work() {
        let (mut m, c) = manager(true);
        let now = Instant::now();
        m.observe_sources(Some(1), Some(0), now);
        assert!(!m.held());
        assert_eq!(m.error, Some("denied"));
        m.observe_sources(Some(1), Some(0), now);
        assert_eq!(c.lock().unwrap().acquire, 2);
    }
    #[test]
    fn owner_exit_releases_only_its_own_request() {
        let (mut m, c) = manager(false);
        m.observe_sources(Some(1), Some(0), Instant::now());
        drop(m);
        assert_eq!(c.lock().unwrap().release, 1);
    }
}

#[derive(Clone, Debug, Default)]
pub struct SleepSettings {
    pub source: Option<&'static str>,
    pub idle_sleep_seconds: Option<u64>,
    pub checked_at: Option<u64>,
}

/// Readback only; this never invokes pmset/powercfg setters or changes a power plan.
#[cfg(target_os = "macos")]
fn read_sleep_settings() -> SleepSettings {
    use std::process::{Command, Stdio};
    fn read(args: &[&str]) -> Option<String> {
        let mut child = Command::new("/usr/bin/pmset")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => {
                    return child
                        .wait_with_output()
                        .ok()
                        .and_then(|out| String::from_utf8(out.stdout).ok())
                }
                Ok(Some(_)) | Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
    }
    let Some(battery) = read(&["-g", "batt"]) else {
        return SleepSettings::default();
    };
    let source = if battery.starts_with("Now drawing from 'AC Power'") {
        Some("ac")
    } else if battery.starts_with("Now drawing from 'Battery Power'") {
        Some("battery")
    } else {
        None
    };
    let idle_sleep_seconds = source.and_then(|source| {
        read(&["-g", "custom"])
            .and_then(|raw| {
                sleep_minutes(
                    &raw,
                    if source == "ac" {
                        "AC Power:"
                    } else {
                        "Battery Power:"
                    },
                )
            })
            .and_then(|minutes| minutes.checked_mul(60))
    });
    SleepSettings {
        source,
        idle_sleep_seconds,
        checked_at: None,
    }
}

#[cfg(any(target_os = "macos", test))]
fn sleep_minutes(text: &str, heading: &str) -> Option<u64> {
    let mut current = false;
    for line in text.lines() {
        if line.ends_with(':') {
            current = line.trim() == heading;
        }
        if current {
            let mut words = line.split_whitespace();
            if words.next() == Some("sleep") {
                return words.next()?.parse().ok();
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn read_sleep_settings() -> SleepSettings {
    use std::ffi::c_void;
    #[repr(C)]
    struct Guid {
        a: u32,
        b: u16,
        c: u16,
        d: [u8; 8],
    }
    #[repr(C)]
    struct Status {
        ac: u8,
        flag: u8,
        percent: u8,
        saver: u8,
        life: u32,
        full: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemPowerStatus(status: *mut Status) -> i32;
        fn LocalFree(value: *mut c_void) -> *mut c_void;
    }
    #[link(name = "powrprof")]
    extern "system" {
        fn PowerGetActiveScheme(root: *mut c_void, scheme: *mut *mut Guid) -> u32;
        fn PowerReadACValueIndex(
            root: *mut c_void,
            scheme: *const Guid,
            subgroup: *const Guid,
            setting: *const Guid,
            value: *mut u32,
        ) -> u32;
        fn PowerReadDCValueIndex(
            root: *mut c_void,
            scheme: *const Guid,
            subgroup: *const Guid,
            setting: *const Guid,
            value: *mut u32,
        ) -> u32;
    }
    let subgroup = Guid {
        a: 0x238c9fa8,
        b: 0x0aad,
        c: 0x41ed,
        d: [0x83, 0xf4, 0x97, 0xbe, 0x24, 0x2c, 0x8f, 0x20],
    };
    let setting = Guid {
        a: 0x29f6c1db,
        b: 0x86da,
        c: 0x48c5,
        d: [0x9f, 0xdb, 0xf2, 0xb6, 0x7b, 0x1f, 0x44, 0xda],
    };
    let mut status = Status {
        ac: 255,
        flag: 0,
        percent: 255,
        saver: 0,
        life: 0,
        full: 0,
    };
    unsafe {
        if GetSystemPowerStatus(&mut status) == 0 {
            return SleepSettings::default();
        }
        let source = match status.ac {
            0 => Some("battery"),
            1 => Some("ac"),
            _ => None,
        };
        let mut scheme = std::ptr::null_mut();
        let mut seconds = 0;
        let idle_sleep_seconds = if source.is_some()
            && PowerGetActiveScheme(std::ptr::null_mut(), &mut scheme) == 0
            && !scheme.is_null()
        {
            let result = if source == Some("ac") {
                PowerReadACValueIndex(
                    std::ptr::null_mut(),
                    scheme,
                    &subgroup,
                    &setting,
                    &mut seconds,
                )
            } else {
                PowerReadDCValueIndex(
                    std::ptr::null_mut(),
                    scheme,
                    &subgroup,
                    &setting,
                    &mut seconds,
                )
            };
            LocalFree(scheme.cast());
            (result == 0).then_some(seconds as u64)
        } else {
            None
        };
        SleepSettings {
            source,
            idle_sleep_seconds,
            checked_at: None,
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn read_sleep_settings() -> SleepSettings {
    SleepSettings::default()
}

/// Timestamp belongs to power-plan readback, independently of local-run polling.
pub fn sleep_settings() -> SleepSettings {
    let mut settings = read_sleep_settings();
    settings.checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|v| v.as_millis() as u64);
    settings
}
