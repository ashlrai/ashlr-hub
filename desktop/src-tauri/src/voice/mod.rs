//! Dictation for Verse (shell contract item 8, `voice` v1).
//!
//! Audio is captured and transcribed HERE, in the app process: the launchd
//! sidecar has no UI and cannot hold a microphone grant, and the Verse page is
//! a remote origin in a WKWebView where the Web Speech API does not exist.
//!
//! ```text
//! page ── shell-voice (emit) ──▶ parse (protocol.rs) ──▶ control thread ─┐
//! ⌃⌥V / ⌃⌥⇧V / Esc ──▶ voice_hotkey::Tracker ─────────▶ control thread ─┤
//!                                                                        ▼
//!   start: mic permission → engine available? → capture.rs (cpal → 16 kHz)
//!          → session thread: every ~400 ms stream.rs re-decodes → voice://partial
//!          → on stop: final pass → lexicon.rs (serve, else cached map)
//!          → voice://final   (level meter: voice://level at ~20 Hz)
//! page ◀── window.__ASHLR_VOICE_EVENT__(json) ── emit()
//! ```
//!
//! Every request is handled on ONE control thread in arrival order, so a
//! push-to-talk release can never overtake the press that started it. Heavy
//! work (decoding, model download, engine load) runs on its own threads.
//!
//! Text only ever goes to the Verse page; the page decides which input gets
//! it (the focused, else last-focused, dictation-enabled input). Nothing is
//! typed into other apps, so no Accessibility permission is involved.

pub mod capture;
mod e2e;
pub mod engine;
pub mod lexicon;
pub mod model;
#[cfg(target_os = "macos")]
pub mod parakeet;
pub mod permission;
pub mod protocol;
pub mod stream;
pub mod whisper;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager};

use crate::voice_hotkey::{self, Action, Chord, Tracker};
use engine::SpeechEngine;
use protocol::{
    EngineView, ErrorCode, FixAction, HotkeyView, LexiconStatus, MicStatus, Mode, ModelPhase,
    Origin, Phase, SessionView, StateView, VoiceEvent, VoiceRequest,
};

pub use protocol::VOICE_EVENT;

/// Drop a loaded engine (≈700 MB resident for Parakeet) after this long idle.
const ENGINE_IDLE_UNLOAD: Duration = Duration::from_secs(15 * 60);
/// Level events are sent at most this often.
const LEVEL_INTERVAL: Duration = Duration::from_millis(50);
/// A dictation longer than this is finalised automatically (a latched mic
/// left on by accident must not grow without bound).
const MAX_SESSION: Duration = Duration::from_secs(10 * 60);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

enum Job {
    Request(VoiceRequest),
    Hotkey(Action),
    /// A session thread finished (final sent, cancelled, or failed).
    Ended(String),
}

enum Control {
    Finish,
    Abort,
}

struct Active {
    id: String,
    origin: Origin,
    mode: Mode,
    cwd: Option<String>,
    phase: Phase,
    control: mpsc::Sender<Control>,
}

struct Inner {
    model: ModelPhase,
    progress: Option<f64>,
    model_error: Option<String>,
    downloading: bool,
    hotkey_registered: bool,
    hotkey_error: Option<String>,
    escape_registered: bool,
    session: Option<Active>,
}

type SharedEngine = Arc<Mutex<Option<Box<dyn SpeechEngine>>>>;

pub struct VoiceHub {
    app_data: PathBuf,
    inner: Mutex<Inner>,
    engine: SharedEngine,
    /// `(id, label)` of the loaded engine, readable without waiting for a
    /// decode that holds `engine`.
    engine_info: Mutex<Option<(&'static str, &'static str)>>,
    engine_used: Mutex<Instant>,
    /// Held while an engine loads, so a download's warm-up and a first
    /// dictation never load the model twice.
    loading: Mutex<()>,
    lexicon: Arc<lexicon::Lexicon>,
    download_cancel: Arc<AtomicBool>,
    tracker: Mutex<Tracker>,
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
    seq: AtomicU64,
}

impl VoiceHub {
    pub fn new(app_data: PathBuf) -> Self {
        let installed =
            model::is_installed(&model::parakeet_dir(&app_data), &model::PARAKEET_FILES);
        let lexicon = lexicon::Lexicon::new(
            lexicon::default_serve_config_path(),
            app_data.join("voice").join("lexicon-cache.json"),
        );
        Self {
            app_data,
            inner: Mutex::new(Inner {
                model: if installed {
                    ModelPhase::Ready
                } else {
                    ModelPhase::Missing
                },
                progress: None,
                model_error: None,
                downloading: false,
                hotkey_registered: false,
                hotkey_error: None,
                escape_registered: false,
                session: None,
            }),
            engine: Arc::new(Mutex::new(None)),
            engine_info: Mutex::new(None),
            engine_used: Mutex::new(Instant::now()),
            loading: Mutex::new(()),
            lexicon: Arc::new(lexicon),
            download_cancel: Arc::new(AtomicBool::new(false)),
            tracker: Mutex::new(Tracker::default()),
            jobs: Mutex::new(None),
            seq: AtomicU64::new(1),
        }
    }

    fn parakeet_dir(&self) -> PathBuf {
        model::parakeet_dir(&self.app_data)
    }

    fn whisper_available(&self) -> bool {
        whisper::find_binary().is_some() && whisper::find_model(&self.app_data).is_some()
    }

    fn engine_view(&self, inner: &Inner) -> EngineView {
        let loaded = *lock(&self.engine_info);
        let parakeet_known = !matches!(inner.model, ModelPhase::Missing | ModelPhase::Failed);
        let (id, label) = match loaded {
            Some(pair) => pair,
            None if !parakeet_known && self.whisper_available() => ("whisper", "local Whisper"),
            None => ("parakeet", "local Parakeet"),
        };
        let model_phase = match (loaded, inner.model) {
            (Some(_), _) => ModelPhase::Loaded,
            (None, phase) => phase,
        };
        EngineView {
            id,
            label,
            model: model_phase,
            progress: inner.progress,
            total_bytes: model::total_bytes(&model::PARAKEET_FILES),
            error: inner.model_error.clone(),
        }
    }

    fn set_engine(&self, engine: Option<Box<dyn SpeechEngine>>) {
        let info = engine.as_ref().map(|e| (e.id(), e.label()));
        *lock(&self.engine) = engine;
        *lock(&self.engine_info) = info;
    }

    fn snapshot(&self) -> StateView {
        let latched = !lock(&self.tracker).is_idle();
        let inner = lock(&self.inner);
        StateView {
            version: 1,
            mic: permission::status(),
            engine: self.engine_view(&inner),
            hotkey: HotkeyView {
                accelerator: voice_hotkey::DICTATE_DISPLAY,
                command_accelerator: voice_hotkey::COMMAND_DISPLAY,
                registered: inner.hotkey_registered,
                error: inner.hotkey_error.clone(),
            },
            lexicon: self.lexicon.status(),
            session: inner.session.as_ref().map(|s| SessionView {
                id: s.id.clone(),
                origin: s.origin,
                mode: s.mode,
                phase: s.phase,
                latched: latched && s.origin == Origin::Hotkey,
            }),
        }
    }
}

// ── emitting to the page ─────────────────────────────────────────────────────

fn emit(app: &AppHandle, event: &VoiceEvent) {
    if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
        let _ = window.eval(protocol::event_script(event));
    }
}

fn emit_state(app: &AppHandle) {
    if let Some(hub) = app.try_state::<VoiceHub>() {
        let state = hub.snapshot();
        emit(app, &VoiceEvent::State { state });
    }
}

fn emit_error(app: &AppHandle, session: Option<&str>, code: ErrorCode, message: impl Into<String>) {
    emit(
        app,
        &VoiceEvent::Error {
            session: session.map(str::to_string),
            code,
            message: message.into(),
        },
    );
}

// ── entry points (main.rs) ───────────────────────────────────────────────────

/// Start the control thread and register the hotkeys. Call once from setup.
pub fn init(app: &AppHandle) {
    let Some(hub) = app.try_state::<VoiceHub>() else {
        return;
    };
    let (tx, rx) = mpsc::channel::<Job>();
    *lock(&hub.jobs) = Some(tx);
    let control_app = app.clone();
    let _ = thread::Builder::new()
        .name("ashlr-voice-control".into())
        .spawn(move || {
            for job in rx {
                run_job(&control_app, job);
            }
        });
    // Off the setup path: registration goes through the main thread.
    let reg_app = app.clone();
    thread::spawn(move || register_hotkeys(&reg_app));
    // Warm the lexicon cache so a first dictation with serve down still has
    // the term map from the last run (read from disk in `new`) or a fresh one.
    let lex = hub.lexicon.clone();
    thread::spawn(move || {
        lex.refresh(None, false);
    });
    // Unload an idle engine.
    let janitor = app.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(60));
        let Some(hub) = janitor.try_state::<VoiceHub>() else {
            return;
        };
        let idle = lock(&hub.engine_used).elapsed() > ENGINE_IDLE_UNLOAD;
        let busy = lock(&hub.inner).session.is_some();
        if idle && !busy && lock(&hub.engine_info).is_some() {
            hub.set_engine(None);
            eprintln!("[ashlr-desktop] voice: engine unloaded after 15 min idle");
        }
    });
}

fn enqueue(app: &AppHandle, job: Job) {
    if let Some(hub) = app.try_state::<VoiceHub>() {
        if let Some(tx) = lock(&hub.jobs).as_ref() {
            let _ = tx.send(job);
        }
    }
}

/// A `shell-voice` event from the page.
pub fn handle_event(app: &AppHandle, payload: &str) {
    match protocol::parse_request(payload) {
        Some(request) => enqueue(app, Job::Request(request)),
        None => eprintln!("[ashlr-desktop] ignoring a malformed shell-voice event"),
    }
}

/// A dictation chord from the global-shortcut handler. Runs inside the
/// plugin's handler (which holds the plugin's shortcut lock), so it only
/// updates the tracker and enqueues — never registers a key itself.
pub fn on_hotkey(
    app: &AppHandle,
    chord: Chord,
    state: tauri_plugin_global_shortcut::ShortcutState,
) {
    let Some(hub) = app.try_state::<VoiceHub>() else {
        return;
    };
    let action = lock(&hub.tracker).on_event(chord, state, Instant::now());
    if action != Action::None {
        enqueue(app, Job::Hotkey(action));
    }
}

fn register_hotkeys(app: &AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let manager = app.global_shortcut();
    let mut failures = Vec::new();
    for (shortcut, display) in [
        (
            voice_hotkey::dictate_shortcut(),
            voice_hotkey::DICTATE_DISPLAY,
        ),
        (
            voice_hotkey::command_shortcut(),
            voice_hotkey::COMMAND_DISPLAY,
        ),
    ] {
        if manager.is_registered(shortcut) {
            continue;
        }
        if let Err(e) = manager.register(shortcut) {
            eprintln!("[ashlr-desktop] voice: could not register {display}: {e}");
            failures.push(display);
        }
    }
    if let Some(hub) = app.try_state::<VoiceHub>() {
        let mut inner = lock(&hub.inner);
        inner.hotkey_registered = failures.is_empty();
        inner.hotkey_error = (!failures.is_empty()).then(|| {
            format!(
                "Another app is already using {}. The mic button still works; quit that app or change its shortcut, then relaunch Ashlr.",
                failures.join(" and ")
            )
        });
    }
    emit_state(app);
}

/// Escape cancels a live dictation from anywhere; held only while one runs.
fn set_escape(app: &AppHandle, on: bool) {
    let Some(hub) = app.try_state::<VoiceHub>() else {
        return;
    };
    {
        let mut inner = lock(&hub.inner);
        if inner.escape_registered == on {
            return;
        }
        inner.escape_registered = on;
    }
    // Never from the shortcut handler's thread (see `on_hotkey`): a fresh
    // thread that goes through the main thread's queue.
    let app = app.clone();
    thread::spawn(move || {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let manager = app.global_shortcut();
        let shortcut = voice_hotkey::cancel_shortcut();
        let result = if on {
            manager.register(shortcut)
        } else {
            manager.unregister(shortcut)
        };
        if let Err(e) = result {
            eprintln!(
                "[ashlr-desktop] voice: could not {} Escape: {e}",
                if on { "register" } else { "release" }
            );
        }
    });
}

fn bring_forward(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// ── the control thread ───────────────────────────────────────────────────────

fn run_job(app: &AppHandle, job: Job) {
    let Some(hub) = app.try_state::<VoiceHub>() else {
        return;
    };
    match job {
        Job::Request(VoiceRequest::Status) => emit_state(app),
        Job::Request(VoiceRequest::Start { session, mode, cwd }) => {
            start(app, &hub, session, Origin::Button, mode, cwd)
        }
        Job::Request(VoiceRequest::Context { session, mode, cwd }) => {
            let mut inner = lock(&hub.inner);
            if let Some(active) = inner.session.as_mut().filter(|a| a.id == session) {
                // Command sessions stay commands; the page picks prose vs
                // verbatim for a hotkey dictation from the focused input.
                if active.mode != Mode::Command {
                    active.mode = mode;
                }
                active.cwd = cwd;
            }
            drop(inner);
            if let Some(cwd) = lock(&hub.inner)
                .session
                .as_ref()
                .and_then(|a| a.cwd.clone())
            {
                let lex = hub.lexicon.clone();
                thread::spawn(move || {
                    lex.refresh(Some(&cwd), false);
                });
            }
        }
        Job::Request(VoiceRequest::Stop { session }) => {
            if finish(&hub, &session, Control::Finish) {
                emit_state(app);
            }
        }
        Job::Request(VoiceRequest::Cancel { session }) => {
            finish(&hub, &session, Control::Abort);
        }
        Job::Request(VoiceRequest::Fix { action }) => fix(app, &hub, action),
        Job::Hotkey(action) => match action {
            Action::Start { command } => {
                // ⌃⌥V while the mic button is dictating ends that dictation.
                if let Some(id) = active_id(&hub) {
                    lock(&hub.tracker).reset();
                    if finish(&hub, &id, Control::Finish) {
                        emit_state(app);
                    }
                    return;
                }
                bring_forward(app);
                let id = format!("hk-{}", hub.seq.fetch_add(1, Ordering::SeqCst));
                let mode = if command { Mode::Command } else { Mode::Prose };
                start(app, &hub, id, Origin::Hotkey, mode, None);
            }
            Action::Stop => {
                // "Transcribing…" shows the moment the key comes up.
                if active_id(&hub).is_some_and(|id| finish(&hub, &id, Control::Finish)) {
                    emit_state(app);
                }
            }
            Action::Cancel => {
                if let Some(id) = active_id(&hub) {
                    finish(&hub, &id, Control::Abort);
                }
            }
            Action::Latch => emit_state(app),
            Action::None => {}
        },
        Job::Ended(id) => {
            let ended = {
                let mut inner = lock(&hub.inner);
                if inner.session.as_ref().is_some_and(|a| a.id == id) {
                    inner.session = None;
                    true
                } else {
                    false
                }
            };
            if ended {
                lock(&hub.tracker).reset();
                set_escape(app, false);
                emit_state(app);
            }
        }
    }
}

fn active_id(hub: &VoiceHub) -> Option<String> {
    lock(&hub.inner).session.as_ref().map(|a| a.id.clone())
}

/// Ask the session thread to finalise (or abort). True when it was asked.
fn finish(hub: &VoiceHub, id: &str, control: Control) -> bool {
    let mut inner = lock(&hub.inner);
    if let Some(active) = inner.session.as_mut().filter(|a| a.id == id) {
        if active.phase == Phase::Listening || matches!(control, Control::Abort) {
            active.phase = Phase::Finalizing;
            let _ = active.control.send(control);
            return true;
        }
    }
    false
}

/// Reset the hotkey gesture after a start that did not happen, so the
/// release of that press does not look like the end of a latch.
fn abandon(app: &AppHandle, hub: &VoiceHub) {
    lock(&hub.tracker).reset();
    emit_state(app);
}

fn start(
    app: &AppHandle,
    hub: &VoiceHub,
    id: String,
    origin: Origin,
    mode: Mode,
    cwd: Option<String>,
) {
    if lock(&hub.inner).session.is_some() {
        emit_error(
            app,
            Some(&id),
            ErrorCode::Busy,
            "Already listening — finish that dictation first.",
        );
        return;
    }

    // 1. Microphone permission. Never prompt implicitly mid-gesture: the
    //    prompt is modal and a push-to-talk release would race it.
    match permission::status() {
        MicStatus::Granted => {}
        MicStatus::Undetermined => {
            let asked = app.clone();
            permission::request(Box::new(move |granted| {
                if !granted {
                    emit_error(
                        &asked,
                        None,
                        ErrorCode::MicDenied,
                        "Microphone access was declined. Allow Ashlr in System Settings ▸ Privacy & Security ▸ Microphone.",
                    );
                }
                emit_state(&asked);
            }));
            emit_error(
                app,
                Some(&id),
                ErrorCode::MicUndetermined,
                "Allow microphone access in the macOS prompt, then dictate again.",
            );
            return abandon(app, hub);
        }
        MicStatus::Denied => {
            emit_error(
                app,
                Some(&id),
                ErrorCode::MicDenied,
                "Ashlr is not allowed to use the microphone. Turn it on in System Settings ▸ Privacy & Security ▸ Microphone.",
            );
            return abandon(app, hub);
        }
        MicStatus::Restricted => {
            emit_error(
                app,
                Some(&id),
                ErrorCode::MicRestricted,
                "Microphone access is restricted on this Mac (Screen Time or a device profile).",
            );
            return abandon(app, hub);
        }
        MicStatus::NoUsageDescription => {
            emit_error(
                app,
                Some(&id),
                ErrorCode::NoUsageDescription,
                "This Ashlr build cannot ask for the microphone yet. Reinstall it with `npm run ship:local -- --native`.",
            );
            return abandon(app, hub);
        }
        MicStatus::Unsupported => {
            emit_error(
                app,
                Some(&id),
                ErrorCode::Unsupported,
                "Dictation needs macOS.",
            );
            return abandon(app, hub);
        }
    }

    // 2. An engine: loaded, or Parakeet on disk, or whisper as a fallback.
    //    Otherwise start the one-time model download.
    let engine_loaded = lock(&hub.engine_info).is_some();
    let parakeet_ready = model::is_installed(&hub.parakeet_dir(), &model::PARAKEET_FILES);
    if !engine_loaded && !parakeet_ready && !hub.whisper_available() {
        start_download(app, hub);
        emit_error(
            app,
            Some(&id),
            ErrorCode::ModelMissing,
            "Downloading the Parakeet speech model (≈670 MB, once). Dictation is ready when it finishes.",
        );
        return abandon(app, hub);
    }

    // 3. The microphone.
    let sink = capture::Sink::new();
    let err_app = app.clone();
    let err_id = id.clone();
    let capture = match capture::start(sink.clone(), move |e| {
        eprintln!("[ashlr-desktop] voice: capture stream error: {e:?}");
        if let capture::CaptureError::Failed(detail) = e {
            if detail.contains("disconnected") || detail.contains("not available") {
                emit_error(
                    &err_app,
                    Some(&err_id),
                    ErrorCode::NoInputDevice,
                    "The microphone went away. Pick an input in System Settings ▸ Sound.",
                );
            }
        }
    }) {
        Ok(capture) => capture,
        Err(capture::CaptureError::NoDevice) => {
            emit_error(
                app,
                Some(&id),
                ErrorCode::NoInputDevice,
                "No microphone found. Connect one or pick an input in System Settings ▸ Sound.",
            );
            return abandon(app, hub);
        }
        Err(capture::CaptureError::Failed(detail)) => {
            eprintln!("[ashlr-desktop] voice: could not start capture: {detail}");
            emit_error(
                app,
                Some(&id),
                ErrorCode::CaptureFailed,
                "The microphone would not start. Check System Settings ▸ Sound ▸ Input and try again.",
            );
            return abandon(app, hub);
        }
    };

    let (control_tx, control_rx) = mpsc::channel();
    lock(&hub.inner).session = Some(Active {
        id: id.clone(),
        origin,
        mode,
        cwd: cwd.clone(),
        phase: Phase::Listening,
        control: control_tx,
    });
    set_escape(app, true);
    emit_state(app);
    if let Some(cwd) = cwd {
        let lex = hub.lexicon.clone();
        thread::spawn(move || {
            lex.refresh(Some(&cwd), false);
        });
    }

    let session_app = app.clone();
    let _ = thread::Builder::new()
        .name("ashlr-voice-session".into())
        .spawn(move || {
            run_session(&session_app, &id, sink, capture, control_rx);
            enqueue(&session_app, Job::Ended(id));
        });
}

/// Load the best available engine into the shared slot (if empty).
fn ensure_engine(
    app: &AppHandle,
    hub: &VoiceHub,
    cwd: Option<&str>,
) -> Result<(), (ErrorCode, String)> {
    if lock(&hub.engine_info).is_some() {
        return Ok(());
    }
    let _loading = lock(&hub.loading);
    if lock(&hub.engine_info).is_some() {
        return Ok(()); // loaded by whoever held the lock
    }
    let dir = hub.parakeet_dir();
    if model::is_installed(&dir, &model::PARAKEET_FILES) {
        lock(&hub.inner).model = ModelPhase::Loading;
        emit_state(app);
        let loaded = load_parakeet(&dir);
        match loaded {
            Ok(engine) => {
                hub.set_engine(Some(engine));
                lock(&hub.inner).model = ModelPhase::Ready;
                emit_state(app);
                return Ok(());
            }
            Err(e) => {
                eprintln!("[ashlr-desktop] voice: {e}");
                let mut inner = lock(&hub.inner);
                inner.model = ModelPhase::Failed;
                inner.model_error = Some(
                    "The Parakeet model would not load. Download it again to repair it.".into(),
                );
                drop(inner);
                emit_state(app);
                // fall through to whisper
            }
        }
    }
    if let (Some(bin), Some(model_path)) =
        (whisper::find_binary(), whisper::find_model(&hub.app_data))
    {
        let prompt = hub.lexicon.whisper_prompt(cwd);
        hub.set_engine(Some(Box::new(whisper::WhisperCliEngine::new(
            bin,
            model_path,
            prompt,
            std::env::temp_dir().join(format!("ashlr-voice-{}", std::process::id())),
        ))));
        emit_state(app);
        return Ok(());
    }
    Err((
        ErrorCode::ModelLoadFailed,
        "No speech model could be loaded. Download the Parakeet model again.".into(),
    ))
}

#[cfg(target_os = "macos")]
fn load_parakeet(dir: &std::path::Path) -> Result<Box<dyn SpeechEngine>, String> {
    let started = Instant::now();
    let engine = parakeet::ParakeetEngine::load(dir)?;
    eprintln!(
        "[ashlr-desktop] voice: Parakeet loaded in {} ms",
        started.elapsed().as_millis()
    );
    Ok(Box::new(engine))
}

#[cfg(not(target_os = "macos"))]
fn load_parakeet(_dir: &std::path::Path) -> Result<Box<dyn SpeechEngine>, String> {
    Err("Parakeet is only wired up on macOS".into())
}

fn session_context(hub: &VoiceHub, id: &str) -> (Mode, Option<String>) {
    lock(&hub.inner)
        .session
        .as_ref()
        .filter(|a| a.id == id)
        .map(|a| (a.mode, a.cwd.clone()))
        .unwrap_or((Mode::Prose, None))
}

fn run_session(
    app: &AppHandle,
    id: &str,
    sink: capture::Sink,
    capture: capture::Capture,
    control: mpsc::Receiver<Control>,
) {
    let Some(hub) = app.try_state::<VoiceHub>() else {
        return;
    };
    let started = Instant::now();

    // Meter: its own thread so a slow decode never freezes the waveform.
    let meter_stop = Arc::new(AtomicBool::new(false));
    {
        let stop = meter_stop.clone();
        let sink = sink.clone();
        let app = app.clone();
        let id = id.to_string();
        thread::spawn(move || {
            let mut last = -1.0f32;
            while !stop.load(Ordering::SeqCst) {
                thread::sleep(LEVEL_INTERVAL);
                let level = (sink.level() * 100.0).round() / 100.0;
                if (level - last).abs() >= 0.01 {
                    last = level;
                    emit(
                        &app,
                        &VoiceEvent::Level {
                            session: id.clone(),
                            level,
                        },
                    );
                }
            }
        });
    }

    let (_, cwd) = session_context(&hub, id);
    let engine_ok = ensure_engine(app, &hub, cwd.as_deref());
    if let Err((code, message)) = &engine_ok {
        // Nothing can transcribe: stop the mic now rather than listen to
        // audio that will be thrown away.
        emit_error(app, Some(id), *code, message.clone());
        meter_stop.store(true, Ordering::SeqCst);
        capture.stop();
        return;
    }
    let interval = lock(&hub.engine)
        .as_ref()
        .map(|e| e.partial_interval_ms())
        .unwrap_or(400);
    let mut stream = stream::Stream::new(stream::StreamConfig::default());
    let mut capture = Some(capture);

    loop {
        let timed_out = started.elapsed() > MAX_SESSION;
        let next = if timed_out {
            Ok(Control::Finish)
        } else {
            control.recv_timeout(Duration::from_millis(interval))
        };
        match next {
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if engine_ok.is_err() {
                    continue;
                }
                let audio = sink.snapshot();
                let mode = session_context(&hub, id).0;
                let result = {
                    let mut slot = lock(&hub.engine);
                    match slot.as_mut() {
                        Some(engine) => stream.partial(&audio, engine.as_mut()),
                        None => Ok(None),
                    }
                };
                match result {
                    Ok(Some(text)) => {
                        let text = if mode == Mode::Verbatim {
                            text
                        } else {
                            hub.lexicon.apply_cached(&text)
                        };
                        emit(
                            app,
                            &VoiceEvent::Partial {
                                session: id.to_string(),
                                text,
                            },
                        );
                    }
                    Ok(None) => {}
                    Err(e) => eprintln!("[ashlr-desktop] voice: partial decode failed: {e}"),
                }
            }
            Ok(Control::Finish) => {
                let released = Instant::now();
                if let Some(capture) = capture.take() {
                    capture.stop();
                }
                meter_stop.store(true, Ordering::SeqCst);
                let audio = sink.snapshot();
                let audio_ms = (audio.len() as u64 * 1000) / engine::SAMPLE_RATE as u64;
                if engine_ok.is_err() {
                    break;
                }
                let (mode, cwd) = session_context(&hub, id);
                let (engine_id, result) = {
                    let mut slot = lock(&hub.engine);
                    match slot.as_mut() {
                        Some(engine) => (engine.id(), stream.finish(&audio, engine.as_mut())),
                        None => ("none", Err("no engine".to_string())),
                    }
                };
                *lock(&hub.engine_used) = Instant::now();
                match result {
                    Ok(raw) if raw.is_empty() => emit_error(
                        app,
                        Some(id),
                        ErrorCode::NoSpeech,
                        "Didn't catch anything — try again a little closer to the mic.",
                    ),
                    Ok(raw) => {
                        let (text, lexicon) = match mode {
                            Mode::Verbatim => (raw, LexiconStatus::None),
                            Mode::Prose | Mode::Command => {
                                hub.lexicon.normalize(&raw, cwd.as_deref())
                            }
                        };
                        let latency_ms = released.elapsed().as_millis() as u64;
                        eprintln!(
                            "[ashlr-desktop] voice: {engine_id} final in {latency_ms} ms for {audio_ms} ms of audio (lexicon {lexicon:?})"
                        );
                        emit(
                            app,
                            &VoiceEvent::Final {
                                session: id.to_string(),
                                text,
                                mode,
                                engine: engine_id,
                                lexicon,
                                latency_ms,
                                audio_ms,
                            },
                        );
                    }
                    Err(e) => {
                        eprintln!("[ashlr-desktop] voice: final decode failed: {e}");
                        emit_error(
                            app,
                            Some(id),
                            ErrorCode::EngineFailed,
                            "Transcription failed. Try again; if it keeps failing, re-download the model.",
                        );
                    }
                }
                break;
            }
            Ok(Control::Abort) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if let Some(capture) = capture.take() {
        capture.stop();
    }
    meter_stop.store(true, Ordering::SeqCst);
    *lock(&hub.engine_used) = Instant::now();
}

// ── fixes ────────────────────────────────────────────────────────────────────

fn fix(app: &AppHandle, hub: &VoiceHub, action: FixAction) {
    match action {
        FixAction::RequestMic => {
            if permission::status() == MicStatus::Undetermined {
                let asked = app.clone();
                permission::request(Box::new(move |_| emit_state(&asked)));
            } else {
                emit_state(app);
            }
        }
        FixAction::OpenMicSettings => permission::open_settings(permission::PRIVACY_MICROPHONE_URL),
        FixAction::OpenSoundSettings => permission::open_settings(permission::SOUND_INPUT_URL),
        FixAction::DownloadModel => {
            // A failed load means a damaged install: start from scratch.
            if lock(&hub.inner).model == ModelPhase::Failed {
                let _ = std::fs::remove_file(hub.parakeet_dir().join("verified.json"));
                hub.set_engine(None);
            }
            start_download(app, hub);
        }
        FixAction::CancelDownload => hub.download_cancel.store(true, Ordering::SeqCst),
        FixAction::RetryLexicon => {
            let lex = hub.lexicon.clone();
            let cwd = lock(&hub.inner)
                .session
                .as_ref()
                .and_then(|a| a.cwd.clone());
            let app = app.clone();
            thread::spawn(move || {
                lex.refresh(cwd.as_deref(), true);
                emit_state(&app);
            });
        }
    }
}

fn start_download(app: &AppHandle, hub: &VoiceHub) {
    {
        let mut inner = lock(&hub.inner);
        if inner.downloading {
            return;
        }
        inner.downloading = true;
        inner.model = ModelPhase::Downloading;
        inner.progress = Some(0.0);
        inner.model_error = None;
    }
    hub.download_cancel.store(false, Ordering::SeqCst);
    emit_state(app);
    let app = app.clone();
    let dir = hub.parakeet_dir();
    let cancel = hub.download_cancel.clone();
    thread::spawn(move || {
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let result = model::download(
            &dir,
            &model::PARAKEET_FILES,
            &model::CurlFetcher,
            &cancel,
            &mut |p: model::Progress| {
                if let Some(hub) = app.try_state::<VoiceHub>() {
                    let mut inner = lock(&hub.inner);
                    inner.progress = Some(p.done as f64 / p.total.max(1) as f64);
                    inner.model = if p.verifying {
                        ModelPhase::Verifying
                    } else {
                        ModelPhase::Downloading
                    };
                }
                if last_emit.elapsed() >= Duration::from_millis(500) {
                    last_emit = Instant::now();
                    emit_state(&app);
                }
            },
        );
        let Some(hub) = app.try_state::<VoiceHub>() else {
            return;
        };
        {
            let mut inner = lock(&hub.inner);
            inner.downloading = false;
            inner.progress = None;
            match &result {
                Ok(()) => {
                    inner.model = ModelPhase::Ready;
                    inner.model_error = None;
                }
                Err(e) if e == "cancelled" => {
                    inner.model = ModelPhase::Missing;
                }
                Err(e) => {
                    inner.model = ModelPhase::Failed;
                    inner.model_error = Some(e.clone());
                }
            }
        }
        match result {
            Ok(()) => {
                eprintln!("[ashlr-desktop] voice: Parakeet model installed");
                emit_state(&app);
                // Warm it now so the first dictation is instant.
                let _ = ensure_engine(&app, &hub, None);
                *lock(&hub.engine_used) = Instant::now();
            }
            Err(e) => {
                eprintln!("[ashlr-desktop] voice: model download: {e}");
                if e != "cancelled" {
                    emit_error(&app, None, ErrorCode::ModelDownloadFailed, e);
                }
                emit_state(&app);
            }
        }
    });
}
