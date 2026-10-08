//! Native-only signed staging and the exact installed host handoff. Never calls Update::install.
#[cfg(target_os = "macos")]
mod platform {
    use ashlr_desktop::{
        native_update_client::{allowed_url, client},
        native_updates as policy,
    };
    use futures_util::StreamExt;
    use policy::{Envelope, Phase, UpdateState};
    use serde_json::Value;
    use std::{
        fs,
        io::Read,
        os::unix::{fs::MetadataExt, io::AsRawFd},
        path::PathBuf,
        process::{Command, Stdio},
        sync::{Arc, Mutex},
        thread,
        time::{Duration, Instant},
    };
    use tauri::{AppHandle, Emitter, Listener, Manager};

    const LATEST_LIMIT: u64 = 256 * 1024;
    const ACK_LIMIT: usize = 64 * 1024;
    const EXPECTED_CURRENT: &str = ".local/share/ashlr/current";
    #[derive(Clone)]
    struct Stage {
        id: String,
        version: String,
        path_env: String,
    }
    struct Inner {
        state: UpdateState,
        epoch: u64,
        checking: bool,
        stage: Option<Stage>,
        handoff: bool,
        abort: Option<futures_util::future::AbortHandle>,
    }
    #[derive(Clone)]
    pub struct Updates(Arc<Mutex<Inner>>);
    fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        m.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn publish(app: &AppHandle, inner: &Inner) {
        let _ = app.emit(policy::STATE_EVENT, &inner.state);
        if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
            let _ = window.eval(policy::state_script(&inner.state));
        }
    }
    fn change(
        app: &AppHandle,
        updates: &Updates,
        epoch: u64,
        phase: Phase,
        reason: Option<&str>,
    ) -> bool {
        let mut i = lock(&updates.0);
        if i.epoch != epoch || !i.state.enabled {
            return false;
        }
        i.state.phase = phase;
        i.state.reason = reason.map(str::to_owned);
        publish(app, &i);
        true
    }
    fn trusted_config() -> Result<(String, String, String), &'static str> {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .map_err(|_| "uncommissioned-key")?;
        let key = config["plugins"]["updater"]["pubkey"]
            .as_str()
            .ok_or("uncommissioned-key")?;
        // Validate a real key shape without treating a placeholder as enabled trust.
        policy::validate_public_key(key).map_err(|_| "uncommissioned-key")?;
        let endpoints = config["plugins"]["updater"]["endpoints"]
            .as_array()
            .ok_or("uncommissioned-key")?;
        if endpoints.len() != 1 {
            return Err("uncommissioned-key");
        }
        let endpoint = endpoints[0].as_str().ok_or("uncommissioned-key")?;
        let repository = ["ashlrai/ashlr-hub", "ashlrai/phantom"]
            .into_iter()
            .find(|r| {
                endpoint == format!("https://github.com/{r}/releases/latest/download/latest.json")
            })
            .ok_or("uncommissioned-key")?;
        Ok((key.to_owned(), endpoint.to_owned(), repository.to_owned()))
    }
    async fn fetch(
        client: &reqwest::Client,
        url: &str,
        limit: u64,
        app: &AppHandle,
        updates: &Updates,
        epoch: u64,
        progress: bool,
    ) -> Result<Vec<u8>, &'static str> {
        let request_url = reqwest::Url::parse(url).map_err(|_| "download-unavailable")?;
        if !allowed_url(&request_url) {
            return Err("download-unavailable");
        }
        let response = client
            .get(request_url)
            .timeout(Duration::from_secs(if progress { 600 } else { 60 }))
            .send()
            .await
            .map_err(|_| "download-unavailable")?;
        if !response.status().is_success() || !allowed_url(response.url()) {
            return Err("download-unavailable");
        }
        if response.content_length().is_some_and(|n| n > limit) {
            return Err("download-size");
        }
        let mut bytes = Vec::new();
        let mut chunks = response.bytes_stream();
        let mut last_report = Instant::now();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(|_| "download-unavailable")?;
            policy::extend_download(&mut bytes, &chunk, limit).map_err(|_| "download-size")?;
            let mut i = lock(&updates.0);
            if i.epoch != epoch || !i.state.enabled {
                return Err("disabled");
            }
            if progress {
                i.state.bytes_received = bytes.len() as u64;
                if last_report.elapsed() >= Duration::from_millis(200) {
                    publish(app, &i);
                    last_report = Instant::now();
                }
            }
        }
        if progress {
            publish(app, &lock(&updates.0));
        }
        Ok(bytes)
    }
    fn current_cli(home: &std::path::Path) -> Result<PathBuf, &'static str> {
        let pointer = home.join(EXPECTED_CURRENT);
        let named = fs::symlink_metadata(&pointer).map_err(|_| "host-unavailable")?;
        if !named.file_type().is_symlink() || named.uid() != unsafe { libc::geteuid() } {
            return Err("host-unavailable");
        }
        let target = fs::read_link(&pointer).map_err(|_| "host-unavailable")?;
        let releases = home.join(".local/share/ashlr/releases");
        if target.parent() != Some(releases.as_path())
            || !target
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| {
                    s.len() == 40
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
        {
            return Err("host-unavailable");
        }
        if fs::canonicalize(&target).ok().as_ref() != Some(&target) {
            return Err("host-unavailable");
        }
        let mut at = home.to_path_buf();
        for component in [
            ".local",
            "share",
            "ashlr",
            "releases",
            target.file_name().unwrap().to_str().unwrap(),
            "bin",
        ] {
            at.push(component);
            let d = fs::symlink_metadata(&at).map_err(|_| "host-unavailable")?;
            if !d.is_dir()
                || d.file_type().is_symlink()
                || d.uid() != unsafe { libc::geteuid() }
                || d.mode() & 0o022 != 0
            {
                return Err("host-unavailable");
            }
        }
        let bin = target.join("bin/ashlr");
        let m = fs::symlink_metadata(&bin).map_err(|_| "host-unavailable")?;
        if !m.is_file()
            || m.file_type().is_symlink()
            || fs::canonicalize(&bin).ok().as_ref() != Some(&bin)
            || m.nlink() != 1
            || m.uid() != unsafe { libc::geteuid() }
            || m.mode() & 0o022 != 0
            || m.mode() & 0o111 == 0
        {
            return Err("host-unavailable");
        }
        let now = fs::symlink_metadata(&pointer).map_err(|_| "host-unavailable")?;
        if named.dev() != now.dev()
            || named.ino() != now.ino()
            || fs::read_link(&pointer).ok().as_ref() != Some(&target)
        {
            return Err("host-unavailable");
        }
        Ok(bin)
    }
    fn launch(
        stage: &Stage,
        apply: bool,
    ) -> Result<(std::process::Child, std::process::ChildStdout), &'static str> {
        if !policy::stage_id(&stage.id) {
            return Err("host-unavailable");
        }
        let home = crate::fleet_ops::home_dir().ok_or("host-unavailable")?;
        launch_at(&home, stage, apply)
    }
    fn launch_at(
        home: &std::path::Path,
        stage: &Stage,
        apply: bool,
    ) -> Result<(std::process::Child, std::process::ChildStdout), &'static str> {
        if !policy::stage_id(&stage.id) {
            return Err("host-unavailable");
        }
        let bin = current_cli(home)?;
        let mut cmd = Command::new(&bin);
        cmd.args([
            "desktop-update",
            if apply { "apply" } else { "inspect" },
            "--stage",
            &stage.id,
            "--json",
        ]);
        cmd.env_clear()
            .envs(crate::fleet_ops::base_env(&home, &stage.path_env));
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|_| "host-unavailable")?;
        let stdout = child.stdout.take().ok_or("host-unavailable")?;
        let fd = stdout.as_raw_fd();
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                return Err("host-unavailable");
            }
        }
        Ok((child, stdout))
    }
    // No worker kill: an apply child may own a transaction. Its host protocol has its own finite deadline.
    fn first_result(
        mut child: std::process::Child,
        mut pipe: std::process::ChildStdout,
        stage: &Stage,
        budget: Duration,
    ) -> Result<policy::HostResult, &'static str> {
        if budget.is_zero() {
            return Err("host-status-unavailable");
        }
        let deadline = Instant::now() + budget;
        let mut bytes = Vec::new();
        let mut block = [0u8; 4096];
        loop {
            if Instant::now() >= deadline {
                return Err("host-status-unavailable");
            }
            match pipe.read(&mut block) {
                Ok(0) => return Err("host-status-unavailable"),
                Ok(n) => {
                    if bytes.len() + n > ACK_LIMIT {
                        return Err("host-status-unavailable");
                    }
                    bytes.extend_from_slice(&block[..n]);
                    if let Some(end) = bytes.iter().position(|b| *b == b'\n') {
                        let raw = std::str::from_utf8(&bytes[..end])
                            .map_err(|_| "host-status-unavailable")?;
                        let result = policy::host_result(raw, &stage.version)
                            .map_err(|_| "host-status-unavailable")?;
                        // Keep output drained while alive; stdout disappearing must not be mistaken for installation.
                        thread::spawn(move || {
                            let end = Instant::now() + Duration::from_secs(180);
                            loop {
                                match pipe.read(&mut block) {
                                    Ok(0) => break,
                                    Ok(_) => {}
                                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                                    Err(_) => break,
                                }
                                if child.try_wait().ok().flatten().is_some()
                                    || Instant::now() >= end
                                {
                                    break;
                                }
                                thread::sleep(Duration::from_millis(25));
                            }
                        });
                        return Ok(result);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return Err("host-status-unavailable"),
            }
            if Instant::now() >= deadline {
                return Err("host-status-unavailable");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn inspected_phase(result: &policy::HostResult) -> Phase {
        if result.state == "applied" {
            Phase::Installed
        } else if policy::ready_to_handoff(result) {
            Phase::WaitingForAppQuit
        } else if matches!(
            result.reason.as_deref(),
            Some("stop-required" | "work-active-or-unknown")
        ) {
            Phase::WaitingForIdle
        } else {
            Phase::AdoptionHeld
        }
    }
    fn inspect(stage: &Stage) -> Result<policy::HostResult, &'static str> {
        let (child, pipe) = launch(stage, false)?;
        first_result(child, pipe, stage, Duration::from_secs(10))
    }
    async fn check(app: AppHandle, updates: Updates, epoch: u64) {
        let result = async {
            let (key, endpoint, _repository) = trusted_config()?;
            if std::env::consts::ARCH != "aarch64" {
                return Err("unsupported-platform");
            }
            let home = crate::fleet_ops::home_dir().ok_or("unsafe-stage")?;
            let probe_home = home.clone();
            let path_env = tauri::async_runtime::spawn_blocking(move || {
                crate::fleet_ops::resolve_cli(&probe_home)
            })
            .await
            .map_err(|_| "host-unavailable")?
            .map(|cli| cli.path_env)
            .map_err(|_| "host-unavailable")?;
            let current =
                policy::stable_version(env!("CARGO_PKG_VERSION")).ok_or("invalid-manifest")?;
            let mut remembered = None;
            if let Some(id) = policy::remembered_stage(&home).map_err(|_| "unsafe-stage")? {
                let m = policy::reload_compatible_stage(&home, &id, &key)
                    .map_err(|_| "unsafe-stage")?;
                let version = policy::stable_version(m.version()).ok_or("invalid-manifest")?;
                if version >= current {
                    let stage = Stage {
                        id,
                        version: m.version().to_owned(),
                        path_env: path_env.clone(),
                    };
                    let st = stage.clone();
                    let checked = tauri::async_runtime::spawn_blocking(move || inspect(&st))
                        .await
                        .map_err(|_| "host-status-unavailable")??;
                    if version == current && checked.state == "applied" {
                        {
                            let mut i = lock(&updates.0);
                            if i.epoch != epoch || !i.state.enabled {
                                return Err("disabled");
                            }
                            i.state.version = Some(stage.version);
                            i.state.bytes_total = Some(m.app_bytes());
                            i.state.bytes_received = m.app_bytes();
                        }
                        change(
                            &app,
                            &updates,
                            epoch,
                            Phase::Installed,
                            checked.reason.as_deref(),
                        );
                    } else if version > current {
                        remembered = Some((stage, m));
                    }
                }
                // Old/equal unattempted stages are history, never a downgrade or a discovery fence.
            }
            let client = client()?;
            let raw = fetch(
                &client,
                &endpoint,
                LATEST_LIMIT,
                &app,
                &updates,
                epoch,
                false,
            )
            .await?;
            let latest: Value = serde_json::from_slice(&raw).map_err(|_| "invalid-manifest")?;
            let envelope: Envelope = serde_json::from_value(latest["phantom"].clone())
                .map_err(|_| "invalid-manifest")?;
            let manifest = policy::verify_compatible_manifest(envelope, &key)
                .map_err(|_| "invalid-manifest")?;
            if !policy::discovery_matches(&latest, &manifest) {
                return Err("invalid-manifest");
            }
            let next = policy::stable_version(manifest.version()).ok_or("invalid-manifest")?;
            if next <= current && remembered.is_some() {
                return Err("signed-release-regression");
            }
            if next <= current {
                let prior = lock(&updates.0).state.phase.clone();
                change(
                    &app,
                    &updates,
                    epoch,
                    if prior == Phase::Installed {
                        Phase::Current
                    } else {
                        Phase::Idle
                    },
                    Some("no-update"),
                );
                return Ok(());
            }
            if let Some((stage, prior)) = remembered {
                let prior_version =
                    policy::stable_version(&stage.version).ok_or("invalid-manifest")?;
                if next < prior_version {
                    return Err("signed-release-regression");
                }
                if next == prior_version {
                    if manifest.digest != prior.digest {
                        return Err("signed-release-conflict");
                    }
                    let st = stage.clone();
                    let checked = tauri::async_runtime::spawn_blocking(move || inspect(&st))
                        .await
                        .map_err(|_| "host-status-unavailable")??;
                    {
                        let mut i = lock(&updates.0);
                        if i.epoch != epoch || !i.state.enabled {
                            return Err("disabled");
                        }
                        i.state.version = Some(stage.version.clone());
                        i.state.bytes_total = Some(prior.app_bytes());
                        i.state.bytes_received = prior.app_bytes();
                        i.stage = Some(stage);
                    }
                    let phase = inspected_phase(&checked);
                    change(&app, &updates, epoch, phase, checked.reason.as_deref());
                    return Ok(());
                }
            }
            {
                let mut i = lock(&updates.0);
                if i.epoch != epoch || !i.state.enabled {
                    return Err("disabled");
                }
                i.state.version = Some(manifest.version().to_owned());
                i.state.bytes_total = Some(manifest.app_bytes());
                i.state.bytes_received = 0;
            }
            if !change(&app, &updates, epoch, Phase::Downloading, None) {
                return Err("disabled");
            }
            let bytes = fetch(
                &client,
                manifest.app_url(),
                manifest.app_bytes(),
                &app,
                &updates,
                epoch,
                true,
            )
            .await?;
            let home = crate::fleet_ops::home_dir().ok_or("unsafe-stage")?;
            {
                let i = lock(&updates.0);
                if i.epoch != epoch || !i.state.enabled {
                    return Err("disabled");
                }
            }
            let id = policy::persist_stage(&home, &manifest, &bytes, &key)
                .map_err(|_| "unsafe-stage")?;
            policy::remember_stage(&home, &id).map_err(|_| "unsafe-stage")?;
            let stage = Stage {
                id,
                version: manifest.version().to_owned(),
                path_env,
            };
            {
                let mut i = lock(&updates.0);
                if i.epoch != epoch || !i.state.enabled {
                    return Err("disabled");
                }
                i.stage = Some(stage.clone());
            }
            change(&app, &updates, epoch, Phase::Staged, None);
            let checked = tauri::async_runtime::spawn_blocking(move || inspect(&stage))
                .await
                .map_err(|_| "host-status-unavailable")??;
            let phase = inspected_phase(&checked);
            change(&app, &updates, epoch, phase, checked.reason.as_deref());
            Ok(())
        }
        .await;
        let mut i = lock(&updates.0);
        if i.epoch == epoch {
            i.checking = false;
            i.abort = None;
        }
        if i.epoch == epoch && i.state.enabled {
            if let Err(reason) = result {
                i.state.phase = if reason == "uncommissioned-key" {
                    Phase::Uncommissioned
                } else {
                    Phase::Failed
                };
                i.state.reason = Some(reason.to_owned());
            }
            publish(&app, &i);
        }
    }
    pub fn start(app: &AppHandle, enabled: bool) {
        let mut state = UpdateState::default();
        state.enabled = enabled;
        if !enabled {
            state.phase = Phase::Disabled;
            state.reason = None;
        }
        let updates = Updates(Arc::new(Mutex::new(Inner {
            state,
            epoch: 0,
            checking: false,
            stage: None,
            handoff: false,
            abort: None,
        })));
        app.manage(updates.clone());
        let h = app.clone();
        app.listen(policy::REQUEST_EVENT, move |e| {
            if policy::status_request(e.payload()) {
                refresh(&h)
            }
        });
        refresh(app);
    }
    fn preference_transition(i: &mut Inner, enabled: bool) {
        if i.state.enabled != enabled {
            i.epoch += 1;
            if let Some(abort) = i.abort.take() {
                abort.abort();
            }
            i.checking = false;
            i.state.enabled = enabled;
            i.state.phase = if enabled {
                if i.stage.is_some() {
                    Phase::Staged
                } else {
                    Phase::Checking
                }
            } else {
                Phase::Disabled
            };
            i.state.reason = None;
        }
    }
    pub fn preference(app: &AppHandle, enabled: bool, saved: bool) {
        let Some(updates) = app.try_state::<Updates>() else {
            return;
        };
        let mut i = lock(&updates.0);
        preference_transition(&mut i, enabled);
        if !saved {
            i.state.phase = Phase::AdoptionHeld;
            i.state.reason = Some("preference-save-failed".into());
        }
        publish(app, &i);
        drop(i);
        if enabled && saved {
            refresh(app)
        }
    }
    pub fn refresh(app: &AppHandle) {
        let Some(updates) = app.try_state::<Updates>() else {
            return;
        };
        let mut i = lock(&updates.0);
        publish(app, &i);
        if !i.state.enabled || i.checking {
            return;
        }
        i.checking = true;
        i.state.phase = Phase::Checking;
        i.state.reason = None;
        let epoch = i.epoch;
        let (abort, registration) = futures_util::future::AbortHandle::new_pair();
        i.abort = Some(abort);
        publish(app, &i);
        drop(i);
        let h = app.clone();
        let u = updates.inner().clone();
        tauri::async_runtime::spawn(async move {
            let _ = futures_util::future::Abortable::new(check(h, u, epoch), registration).await;
        });
    }
    fn quit_sequence(
        mut call: impl FnMut(bool, Duration) -> Result<policy::HostResult, &'static str>,
        budget: Duration,
    ) -> Result<policy::HostResult, &'static str> {
        if budget.is_zero() {
            return Err("host-status-unavailable");
        }
        let deadline = Instant::now() + budget;
        let checked = call(false, deadline.saturating_duration_since(Instant::now()))?;
        if !policy::ready_to_handoff(&checked) {
            return Ok(checked);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("host-status-unavailable");
        }
        call(true, remaining)
    }
    /// One fresh idle admission and parent ACK share ≤10 seconds; normal Quit always proceeds.
    pub fn normal_quit(app: &AppHandle) {
        let Some(updates) = app.try_state::<Updates>() else {
            return;
        };
        let stage = {
            let mut i = lock(&updates.0);
            if !i.state.enabled
                || i.handoff
                || !matches!(
                    i.state.phase,
                    Phase::WaitingForAppQuit | Phase::WaitingForIdle | Phase::AdoptionHeld
                )
                || i.state.reason.as_deref() == Some("preference-save-failed")
            {
                return;
            }
            i.handoff = true;
            i.stage.clone()
        };
        let Some(stage) = stage else { return };
        let result = quit_sequence(
            |apply, budget| {
                let started = Instant::now();
                let (child, pipe) = launch(&stage, apply)?;
                first_result(
                    child,
                    pipe,
                    &stage,
                    budget.saturating_sub(started.elapsed()),
                )
            },
            Duration::from_secs(10),
        );
        let mut i = lock(&updates.0);
        match result {
            Ok(r) if r.state == "waiting-native-exit" => {
                i.state.phase = Phase::Installing;
                i.state.reason = Some("native-exit-acknowledged".into());
            }
            Ok(r) => {
                i.state.phase = inspected_phase(&r);
                i.state.reason = r.reason;
            }
            Err(reason) => {
                i.state.phase = Phase::AdoptionHeld;
                i.state.reason = Some(reason.to_owned());
            }
        }
        publish(app, &i);
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fn scratch() -> PathBuf {
            let home = std::env::temp_dir().join(format!(
                "phantom-runtime-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::DirBuilder::new().mode(0o700).create(&home).unwrap();
            fs::canonicalize(home).unwrap()
        }
        #[test]
        fn preference_cancels_old_future_and_cannot_fabricate_a_stage() {
            let (abort, registration) = futures_util::future::AbortHandle::new_pair();
            let mut i = Inner {
                state: UpdateState {
                    phase: Phase::Downloading,
                    ..Default::default()
                },
                epoch: 0,
                checking: true,
                stage: None,
                handoff: false,
                abort: Some(abort),
            };
            preference_transition(&mut i, false);
            assert_eq!(i.state.phase, Phase::Disabled);
            assert_eq!(i.epoch, 1);
            assert!(!i.checking);
            assert!(futures_util::future::Abortable::new(
                std::future::pending::<()>(),
                registration
            )
            .is_aborted());
            preference_transition(&mut i, true);
            assert_eq!(i.state.phase, Phase::Checking);
            assert_eq!(i.epoch, 2);
            i.stage = Some(Stage {
                id: "a".repeat(32),
                version: "3.25.2".into(),
                path_env: "/usr/bin:/bin".into(),
            });
            preference_transition(&mut i, false);
            preference_transition(&mut i, true);
            assert_eq!(i.state.phase, Phase::Staged);
        }
        #[test]
        fn idle_and_authority_holds_are_distinct() {
            let mut r = policy::HostResult {
                schema: "phantom-desktop-update-result/v1".into(),
                state: "blocked".into(),
                version: Some("3.25.2".into()),
                reason: Some("stop-required".into()),
                requires_reapproval: false,
            };
            assert_eq!(inspected_phase(&r), Phase::WaitingForIdle);
            r.reason = Some("work-active-or-unknown".into());
            assert_eq!(inspected_phase(&r), Phase::WaitingForIdle);
            r.reason = Some("authority-reapproval-required".into());
            assert_eq!(inspected_phase(&r), Phase::AdoptionHeld);
        }
        fn result(state: &str, reason: Option<&str>) -> policy::HostResult {
            policy::HostResult {
                schema: "phantom-desktop-update-result/v1".into(),
                state: state.into(),
                version: Some("3.25.3".into()),
                reason: reason.map(str::to_owned),
                requires_reapproval: reason == Some("grant-unavailable"),
            }
        }
        #[test]
        fn quit_rechecks_idle_once_and_only_then_requests_parent_ack() {
            let mut calls = Vec::new();
            let r = quit_sequence(
                |apply, budget| {
                    calls.push((apply, budget));
                    Ok(if apply {
                        result("waiting-native-exit", None)
                    } else {
                        result("ready", None)
                    })
                },
                Duration::from_millis(100),
            )
            .unwrap();
            assert_eq!(r.state, "waiting-native-exit");
            assert_eq!(calls.len(), 2);
            assert!(!calls[0].0);
            assert!(calls[1].0);
            assert!(calls[1].1 <= calls[0].1);
        }
        #[test]
        fn quit_does_not_apply_expired_unknown_or_busy_admission() {
            for reason in [
                "grant-unavailable",
                "work-active-or-unknown",
                "authority-reapproval-required",
            ] {
                let mut calls = 0;
                let r = quit_sequence(
                    |apply, _| {
                        assert!(!apply);
                        calls += 1;
                        Ok(result("blocked", Some(reason)))
                    },
                    Duration::from_millis(100),
                )
                .unwrap();
                assert_eq!(calls, 1);
                assert_eq!(r.state, "blocked");
                assert_ne!(inspected_phase(&r), Phase::WaitingForAppQuit);
            }
        }
        #[test]
        fn delayed_preflight_cannot_gain_a_second_ack_budget() {
            let mut calls = 0;
            let r = quit_sequence(
                |apply, _| {
                    assert!(!apply);
                    calls += 1;
                    thread::sleep(Duration::from_millis(5));
                    Ok(result("ready", None))
                },
                Duration::from_millis(1),
            );
            assert!(r.is_err());
            assert_eq!(calls, 1);
        }
        #[test]
        fn exact_owned_current_launcher_is_required() {
            let home = scratch();
            let base = home.join(".local/share/ashlr");
            let release = base.join("releases").join("a".repeat(40));
            fs::create_dir_all(release.join("bin")).unwrap();
            let bin = release.join("bin/ashlr");
            fs::write(&bin, b"test-only never executed").unwrap();
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
            std::os::unix::fs::symlink(&release, base.join("current")).unwrap();
            assert_eq!(current_cli(&home).unwrap(), bin);
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o722)).unwrap();
            assert!(current_cli(&home).is_err());
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
            fs::remove_file(&bin).unwrap();
            std::os::unix::fs::symlink("/usr/bin/true", &bin).unwrap();
            assert!(current_cli(&home).is_err());
            fs::remove_dir_all(home).unwrap();
        }
        #[test]
        fn unrelated_or_non_symlink_pointer_is_refused() {
            let home = scratch();
            let base = home.join(".local/share/ashlr");
            fs::create_dir_all(&base).unwrap();
            std::os::unix::fs::symlink("/tmp/unrelated", base.join("current")).unwrap();
            assert!(current_cli(&home).is_err());
            fs::remove_file(base.join("current")).unwrap();
            fs::create_dir(base.join("current")).unwrap();
            assert!(current_cli(&home).is_err());
            fs::remove_dir_all(home).unwrap();
        }
        #[test]
        fn exact_owned_env_node_launcher_uses_only_resolved_path() {
            let home = scratch();
            let path = std::env::var("PATH").unwrap();
            let node = Command::new("node")
                .env_clear()
                .env("PATH", &path)
                .env("HOME", &home)
                .args(["--print", "process.execPath"])
                .output()
                .unwrap();
            assert!(node.status.success());
            let node = PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
            assert!(node.is_absolute());
            let base = home.join(".local/share/ashlr");
            let release = base.join("releases").join("a".repeat(40));
            fs::create_dir_all(release.join("bin")).unwrap();
            let bin = release.join("bin/ashlr");
            fs::write(&bin,b"#!/usr/bin/env node\nif (!process.argv[1].includes('/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bin/ashlr') || process.argv[2] !== 'desktop-update' || process.argv[3] !== 'inspect') process.exit(47); process.stdout.write(JSON.stringify({schema:'phantom-desktop-update-result/v1',state:'ready',version:'3.25.2',reason:null,requiresReapproval:false})+'\\n');\n").unwrap();
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
            std::os::unix::fs::symlink(&release, base.join("current")).unwrap();
            let stage = Stage {
                id: "a".repeat(32),
                version: "3.25.2".into(),
                path_env: format!("{}:/usr/bin:/bin", node.parent().unwrap().display()),
            };
            let (child, pipe) = launch_at(&home, &stage, false).unwrap();
            assert!(policy::ready_to_handoff(
                &first_result(child, pipe, &stage, Duration::from_secs(2)).unwrap()
            ));
            fs::remove_dir_all(home).unwrap();
        }
        #[test]
        fn real_pipe_ack_is_typed_and_not_installation() {
            let stage = Stage {
                id: "a".repeat(32),
                version: "3.25.2".into(),
                path_env: "/usr/bin:/bin".into(),
            };
            let raw = r#"{"schema":"phantom-desktop-update-result/v1","state":"waiting-native-exit","version":"3.25.2","reason":null,"requiresReapproval":false}"#;
            let mut child = Command::new("/usr/bin/printf")
                .args(["%s\n", raw])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let pipe = child.stdout.take().unwrap();
            let r = first_result(child, pipe, &stage, Duration::from_secs(1)).unwrap();
            assert_eq!(r.state, "waiting-native-exit");
            assert!(!policy::ready_to_handoff(&r));
        }
    }
}
#[cfg(target_os = "macos")]
pub use platform::{normal_quit, preference, start};
#[cfg(not(target_os = "macos"))]
pub fn start(_: &tauri::AppHandle, _: bool) {}
#[cfg(not(target_os = "macos"))]
pub fn preference(_: &tauri::AppHandle, _: bool, _: bool) {}
#[cfg(not(target_os = "macos"))]
pub fn normal_quit(_: &tauri::AppHandle) {}
